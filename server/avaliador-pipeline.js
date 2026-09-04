// Pipeline multi-nó do avaliador (AvaliAllos) — o MOTOR, compartilhado por dois
// chamadores:
//
//   · PRODUÇÃO (desde 2026-09): o v29 e o modo progressão dele avaliam
//     Treinamento, Competitivo, Visitante, Processo Seletivo e a correção
//     manual do supervisor. Quem os aciona é server/avaliacao-oficial.js.
//   · A ABA "AVALIAR SESSÃO" (supervisor): a mesma régua, num log colado, com
//     seletor de modelo/effort e a conta de custo da run.
//
// Duas versões, que são o mesmo desenho com entradas diferentes: `v29` e
// `v29-progressao` (ver PIPELINE_VERSIONS). O nome "v25" que sobrou nas envs
// (AVALIACAO_V25_*) e no store JSON é histórico — trocá-los apagaria a
// configuração de quem já tem essas envs setadas no painel do Railway.
//
// Roda em GPT-5.x (OpenAI) ou GLM (z.ai). Na produção o modelo vem da categoria
// em Administração → Modelos de IA; na aba do supervisor, do seletor da tela. Os
// avaliadores que ficaram FORA do pipeline (Duelo comparativo, Neuro e Trilha)
// não passam aqui.
//
// Pipeline completo:
//   1) Um nó por critério, em paralelo (15). Cada nó vê só o seu critério + o
//      Bloco 1 + o log, responde as quatro travas da régua e a realização da
//      faixa que abriu, e escreve a ANÁLISE — nunca a nota.
//   2) Agregador determinístico (código): deriva faixa e nota de cada critério
//      das travas, aplica pesos (iguais por enquanto) e normaliza a média(1–10)
//      para 0–100. Fica de fora só o nó cuja saída não deu para ler.
//   3) Sintetizador (1 chamada): recebe só o log + as análises em prosa (sem
//      números, sem Bloco 1) e devolve o corpo do feedback do aluno.
//   4) Montagem final (código): cola a nota (no laboratório) e a saudação fixa.
//
// No modo progressão entra um nó a mais, o da MISSÃO, que decide se a
// sidequest/desafio do dia foi cumprida — e não pontua critério nenhum.
//
// RACIOCÍNIO (`capturaReasoning`): a OpenAI não entrega a cadeia bruta
// de raciocínio em lugar nenhum — só um RESUMO, e só pela Responses API. Por
// isso, quando a versão pede captura, os nós GPT saem do chat.completions e vão
// para a Responses (mesmas mensagens: o prefixo cacheável vira `instructions`,
// o critério vira `input`, então o caching continua valendo). O GLM é mais
// simples: devolve `reasoning_content` no próprio chat.completions, de graça.
//
// Custo: os tokens de reasoning JÁ são cobrados hoje, como saída, pedindo ou não
// o resumo — o modelo os gera de todo jeito. Pedir o resumo não cria raciocínio
// novo; ele é uma janela para tokens que você já comprou. Se o sumarizador em si
// entrar no `usage`, aparece na instrumentação da run (a linha de custo sobe), que
// é exatamente o que este laboratório mede. Modo BATCH não tem resumo: a Batch
// API roda em /v1/chat/completions, que não devolve esse texto — limitação do
// provedor, não escolha nossa.
//
// Prompt caching: a OpenAI cacheia o maior prefixo comum automaticamente
// (>~1024 tokens, sem marcação manual). Por isso o bloco estático + o caso vão
// na mensagem `developer` (o prefixo), e só o critério/as análises na `user` (o
// que varia). Os nós seguintes leem A+B do cache. Roda 1 nó primeiro pra semear
// o cache, depois os outros em paralelo (igual à versão anterior).
//
// Os prompts (nó + sintetizador) e os critérios vêm dos .md no PROMPTS_DIR —
// fonte única da verdade; editar o .md muda o comportamento. Instrumentação de
// tokens/custo embutida para o teste de pricing.

const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR } = require('./paths');

// Saudação colada por código no topo do feedback do aluno (o modelo não a gera
// nem a varia). Era uma por versão, quando as versões traziam saudações
// diferentes; hoje é uma só.
//
// É só o enquadramento do feedback: a nota aparece como selo na tela (produção)
// ou no cabeçalho do relatório (laboratório), e o segundo parágrafo que as
// versões antigas traziam — o pedido para descrever o raciocínio na caixa de
// estrela — saiu do texto quando a régua mudou.
const SAUDACAO = `Trate este feedback como pré-correção, um ponto de partida para a conversa com seu supervisor e colegas, não um veredito.`;

// As DUAS versões que existem, e são o MESMO desenho: quinze nós (uma chamada
// por critério), travas respondidas uma a uma, faixa e nota derivadas por
// código, e um sintetizador que escreve o feedback do aluno sem nunca ver o
// Bloco 1. A diferença está na ENTRADA:
//
//   v29            → um atendimento (Bloco 1 + log). É o avaliador oficial de
//                    Treinamento, Competitivo, Visitante, Seletivo e da
//                    correção manual do supervisor.
//   v29-progressao → o aluno reatende um caso: chegam os dois atendimentos, a
//                    avaliação que ele leu do primeiro e, às vezes, a missão
//                    ativa. Tem um nó a mais, o da missão, que decide se a
//                    sidequest/desafio do dia foi cumprida.
//
// Aqui moravam também v25, v28, v31 e v32, cada uma com o que o código precisava
// para rodá-la: variantes do nó (com-feedback / só-nota), nó partido em duas
// fases, três formatos de saída e a regra de confiança do v25. Saíram todas em
// 2026-09, junto dos avaliadores de prompt único (v16-2, v18.25) — o app roda
// uma régua só. As runs antigas continuam legíveis no histórico da Avaliação
// Independente porque o que ficou guardado é RESULTADO, não prompt.
const PIPELINE_VERSIONS = {
  v29: {
    id: 'v29',
    dir: 'v29',
    montado: 'prompt-no-v29-montado.md',
    criterios: 'criterios-no-v29.md',
    sintetizador: 'sintetizador-v29.md',
    nCriterios: 15,
    capturaReasoning: true,
  },
  // Mesma grade do v29: os critérios são LIDOS DA PASTA DELE (`criteriosDe`) —
  // é o mesmo arquivo, e duplicá-lo faria as duas cópias divergirem na primeira
  // edição pelo painel. O que esta versão tem de próprio são os cinco slots do
  // caso, três slots extras no sintetizador e o prompt do nó da missão.
  'v29-progressao': {
    id: 'v29-progressao',
    dir: 'v29-progressao',
    montado: 'prompt-no-v29-progressao-montado.md',
    criterios: 'criterios-no-v29.md',
    criteriosDe: 'v29',
    sintetizador: 'sintetizador-v29-progressao.md',
    slotsSintetizador: ['{{ATENDIMENTO_1}}', '{{MISSAO}}', '{{MISSAO_VEREDITO}}'],
    missao: 'missao-v29-progressao.md',
    slotsCaso: ['{{BLOCO_1}}', '{{ATENDIMENTO_1}}', '{{AVALIACAO_1}}', '{{MISSAO}}', '{{LOG}}'],
    nCriterios: 15,
    capturaReasoning: true,
  },
};

// Slots do bloco do caso (bloco B do prompt do nó) de uma versão. O padrão são
// os dois de sempre; o modo progressão declara os seus em `slotsCaso`.
const SLOTS_CASO_PADRAO = ['{{BLOCO_1}}', '{{LOG}}'];
function slotsCasoDe(cfg) {
  return (cfg && Array.isArray(cfg.slotsCaso) && cfg.slotsCaso.length) ? cfg.slotsCaso : SLOTS_CASO_PADRAO;
}

// Slots ADICIONAIS que o sintetizador de uma versão pode usar, além do
// {{LOG}} e do {{ANALISES}} que todos têm. O modo progressão precisa do
// atendimento anterior e da missão (com o veredito já decidido) para escrever a
// comparação e falar da missão sem contradizer o nó que a julgou.
function slotsSintetizadorDe(cfg) {
  return (cfg && Array.isArray(cfg.slotsSintetizador)) ? cfg.slotsSintetizador : [];
}
const PIPELINE_VERSIONS_IDS = Object.keys(PIPELINE_VERSIONS);
const DEFAULT_VERSION = 'v29';

function versionConfig(version) {
  const cfg = PIPELINE_VERSIONS[version];
  if (!cfg) throw new Error(`Versão do pipeline inválida: ${version} (${PIPELINE_VERSIONS_IDS.join(' | ')}).`);
  return cfg;
}

// Pasta da versão dentro do PROMPTS_DIR. Era uma LISTA de nomes possíveis
// enquanto o v25 se chamava "nova avaliacao" no volume de produção e "v25" na
// cópia do repo; com aquela versão fora, cada versão tem um nome só.
function versionDir(cfg) {
  return path.join(PROMPTS_DIR, 'avaliacao', cfg.dir);
}

// Modelo dos nós e do sintetizador (GPT-5.x). Var própria do v25 — independente
// do OPENAI_EVAL_MODEL dos outros modos, que continuam intocados.
const V25_MODEL = process.env.AVALIACAO_V25_MODEL || 'gpt-5.5-2026-04-23';
// reasoning_effort: none|minimal|low|medium|high.
const V25_EFFORT = process.env.AVALIACAO_V25_EFFORT || 'medium';
// max_completion_tokens é TETO (reasoning oculto + saída visível) — só paga o
// gerado. Folga generosa: se curto, o GPT gasta tudo pensando e devolve vazio.
const V25_MAX_TOKENS = Number(process.env.AVALIACAO_V25_MAX_TOKENS || 16000);
const V25_SYNTH_MAX_TOKENS = Number(process.env.AVALIACAO_V25_SYNTH_MAX_TOKENS || 16000);
// Teto do nó da MISSÃO (modo progressão). A saída são duas linhas; o teto existe
// pelo raciocínio, que sai do mesmo bolso. Menor que o de um nó de critério: a
// pergunta é uma só, e ela vem escrita.
const V25_MISSAO_MAX_TOKENS = Number(process.env.AVALIACAO_V25_MISSAO_MAX_TOKENS || 8000);

// Preços em USD por 1 milhão de tokens, para o custo EXATO da run (ver
// buildInstrumentacao). Chaves = prefixo do modelo, batidas do prefixo mais
// específico para o mais genérico (gpt-5.5-mini antes de gpt-5.5). Só entram
// modelos com preço confirmado; modelo fora da tabela → custo null (mostra só
// tokens, nunca um dólar errado). GPT-5.5 confirmado em jul/2026: $5 input /
// $0,50 cached / $30 output por MTok (tier padrão; acima de 272K tokens/req
// sobe pra $10/$45, mas cada chamada aqui fica muito abaixo desse limite).
// O dono cicla modelos — se trocar, ou adicione o prefixo aqui, ou sobreponha
// por env (AVALIACAO_V25_PRICE_INPUT/_CACHED/_OUTPUT, em USD por MTok).
// Preços (docs OpenAI, jul/2026). resolvePrices casa pelo prefixo mais LONGO,
// então 'gpt-5.4-mini' vence 'gpt-5.4' para os ids do mini.
//
// CAVEAT de precisão (vale pra TODOS os modelos OpenAI daqui, não só o 5.6):
// a OpenAI cobra ESCRITA de cache a 1,25× o input, mas o usage da API não separa
// os tokens de escrita — eles vêm dentro do bucket de input, que contamos a 1×.
// Ou seja: o custo OpenAI calculado aqui é um PISO, subestimado em até 25% sobre
// a parcela de prefixo novo (só a 1ª chamada de cada prefixo; da 2ª em diante é
// leitura de cache, que é medida certo). O erro é o mesmo em todos os modelos
// OpenAI, então a COMPARAÇÃO entre eles continua justa — que é pra isso que o
// laboratório existe. Fonte: developers.openai.com/api/docs/pricing (ago/2026).
const V25_PRICES = {
  // GPT-5.6 Sol — flagship da família 5.6 (lançada 09/07/2026). Mesmo preço do
  // 5.5 ($5/$0,50/$30), então aqui a comparação é de QUALIDADE por dólar: se ele
  // entregar mais que o 5.5 pelo mesmo preço, a troca é de graça. Aceita dois
  // degraus de reasoning acima do 5.5 (xhigh e max) — que custam mais só por
  // gerarem mais tokens de raciocínio, não por preço de tabela diferente.
  // Fonte: developers.openai.com/api/docs/models/gpt-5.6-sol (conferido ago/2026).
  'gpt-5.6-sol': { input: 5, cached: 0.5, output: 30 },
  // Os dois tiers abaixo do Sol, mesma família. Terra fica ~20% ABAIXO do 5.4
  // ($2 vs $2,50 input; $12 vs $15 output) e Luna é o mais barato de toda a
  // tabela — 3,75× abaixo do 5.4-mini. Fonte: developers.openai.com/api/docs/
  // pricing (conferido ago/2026; um blog agregador publicou $2,50/$15 e $1/$6
  // para estes dois, que NÃO bate com a doc oficial — valem os números daqui).
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  // GLM-5.2 (z.ai) — docs.z.ai, jul/2026. Reasoning cobrado como output (sem
  // surcharge). Só na Avaliação Independente (teste de pricing).
  'glm-5.2': { input: 1.4, cached: 0.26, output: 4.4 },
};

// Monta o corpo /chat/completions de acordo com o PROVEDOR. GPT (OpenAI) usa
// `reasoning_effort` (low/medium/high) + `max_completion_tokens`. GLM (z.ai) usa
// `thinking:{type:enabled|disabled}` (+ `reasoning_effort` high/max quando ligado)
// e `max_tokens`. Os prompts/mensagens são os MESMOS — só os campos de controle
// mudam. Assim o caching por prefixo continua valendo nos dois.
function buildChatBody({ provider, model, messages, maxTokens, effort }) {
  const body = { model, messages };
  if (provider === 'glm') {
    body.max_tokens = maxTokens;
    if (effort === 'disabled') {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = effort; // 'high' | 'max'
    }
  } else {
    body.max_completion_tokens = maxTokens;
    body.reasoning_effort = effort; // 'low' | 'medium' | 'high'
  }
  return body;
}

// Resolve os preços para o modelo em uso. Env override vence a tabela (os três
// têm de estar setados). Senão, casa por prefixo mais longo. `null` = sem preço
// conhecido → a UI mostra tokens, mas não custo.
function resolvePrices(model) {
  const envIn = Number(process.env.AVALIACAO_V25_PRICE_INPUT);
  const envCached = Number(process.env.AVALIACAO_V25_PRICE_CACHED);
  const envOut = Number(process.env.AVALIACAO_V25_PRICE_OUTPUT);
  if (Number.isFinite(envIn) && Number.isFinite(envCached) && Number.isFinite(envOut)) {
    return { input: envIn, cached: envCached, output: envOut, fonte: 'env' };
  }
  const m = String(model || '').toLowerCase();
  const prefixos = Object.keys(V25_PRICES).sort((a, b) => b.length - a.length);
  for (const prefix of prefixos) {
    if (m.startsWith(prefix)) return { ...V25_PRICES[prefix], fonte: 'tabela' };
  }
  return null;
}

// Fatia o prompt do nó nos três blocos (A estático, B do caso, C do nó), pelos
// comentários de CACHE BREAKPOINT. PURO (recebe o texto, não lê disco) para o
// editor de prompts poder validar um rascunho com exatamente o mesmo parser que
// a produção usa.
//
// Havia aqui um passo a mais: as versões até o v28 traziam DUAS variantes do nó
// no mesmo .md (com-feedback e só-nota), em blocos `<!-- @variante:X -->`, e
// este parser escolhia uma. Do v29 em diante o arquivo inteiro é o prompt.
function parseMontado(raw, arquivo = 'O prompt do nó montado', slotsCaso = SLOTS_CASO_PADRAO) {
  const montado = String(raw);

  const start = montado.indexOf('## [METACOMANDO]');
  const bpA = montado.indexOf('<!-- ===== CACHE BREAKPOINT A');
  const bpB = montado.indexOf('<!-- ===== CACHE BREAKPOINT B');
  if (start === -1 || bpA === -1 || bpB === -1) {
    throw new Error(`${arquivo} sem os marcadores esperados (METACOMANDO / BREAKPOINT A / BREAKPOINT B).`);
  }
  const bpAEnd = montado.indexOf('-->', bpA) + 3;
  const bpBEnd = montado.indexOf('-->', bpB) + 3;

  const blockA = montado.slice(start, bpA).trim();          // estático
  const blockB = montado.slice(bpAEnd, bpB).trim();          // {{BLOCO_1}} + {{LOG}}
  const blockC = montado.slice(bpBEnd).trim();               // {{CRITÉRIO}}

  const exigidos = [
    ...(slotsCaso || SLOTS_CASO_PADRAO).map((slot) => ['B', blockB, slot]),
    ['C', blockC, '{{CRITÉRIO}}'],
  ];
  for (const [name, blk, slot] of exigidos) {
    if (!blk.includes(slot)) throw new Error(`Bloco ${name} do ${arquivo} não contém o slot ${slot}.`);
  }
  return { blockA, blockB, blockC };
}

// Sintetizador: bloco estático (do METACOMANDO até o breakpoint) vira o
// `developer` cacheável; o resto ({{LOG}} + {{ANALISES}} + tarefa) vira `user`.
// Puro, pelo mesmo motivo do parseMontado.
function parseSintetizador(sint, arquivo = 'O sintetizador', slotsExtra = []) {
  const sStart = sint.indexOf('## [METACOMANDO]');
  const sBp = sint.indexOf('<!-- CACHE BREAKPOINT');
  if (sStart === -1 || sBp === -1) {
    throw new Error(`${arquivo} sem os marcadores esperados (METACOMANDO / CACHE BREAKPOINT).`);
  }
  const sBpEnd = sint.indexOf('-->', sBp) + 3;
  const synthStatic = sint.slice(sStart, sBp).trim();
  const synthVariable = sint.slice(sBpEnd).trim();
  for (const slot of ['{{LOG}}', '{{ANALISES}}']) {
    if (!synthVariable.includes(slot)) throw new Error(`${arquivo} não contém o slot ${slot}.`);
  }
  // Slot que o .md usa mas a versão não conhece seria enviado ao modelo como
  // texto cru `{{ASSIM}}`. Barra aqui, na gravação do prompt, e não em produção.
  const conhecidos = ['{{LOG}}', '{{ANALISES}}', ...(slotsExtra || [])];
  for (const usado of synthVariable.match(/\{\{[A-Z\u00c0-\u00da_0-9]+\}\}/g) || []) {
    if (!conhecidos.includes(usado)) throw new Error(`${arquivo} usa o slot ${usado}, que não existe nesta versão.`);
  }
  return { synthStatic, synthVariable };
}

// Nó da MISSÃO (modo progressão): mesma anatomia do sintetizador — bloco
// estático até o breakpoint (o `developer`, cacheável entre avaliações) e o
// resto variável, com os materiais do caso. Exige o slot da missão e o do
// atendimento avaliado; os outros slots do caso são opcionais aqui (o veredito
// da missão não depende da avaliação anterior, por exemplo). Puro, pelo mesmo
// motivo dos outros parsers: o editor de prompts valida um rascunho com ele.
function parseMissao(raw, arquivo = 'O prompt da missão', slotsCaso = SLOTS_CASO_PADRAO) {
  const texto = String(raw || '');
  const start = texto.indexOf('## [METACOMANDO]');
  const bp = texto.indexOf('<!-- CACHE BREAKPOINT');
  if (start === -1 || bp === -1) {
    throw new Error(`${arquivo} sem os marcadores esperados (METACOMANDO / CACHE BREAKPOINT).`);
  }
  const bpEnd = texto.indexOf('-->', bp) + 3;
  const missaoStatic = texto.slice(start, bp).trim();
  const missaoVariable = texto.slice(bpEnd).trim();
  for (const slot of ['{{MISSAO}}', '{{LOG}}']) {
    if (!missaoVariable.includes(slot)) throw new Error(`${arquivo} não contém o slot ${slot}.`);
  }
  // Slot que o prompt usa mas a versão não declara = erro de digitação num
  // nome de slot, que passaria batido e chegaria ao modelo como texto cru.
  for (const usado of missaoVariable.match(/\{\{[A-ZÇÃÉÍÓÚ_0-9]+\}\}/g) || []) {
    if (!slotsCaso.includes(usado)) throw new Error(`${arquivo} usa o slot ${usado}, que não existe nesta versão.`);
  }
  return { missaoStatic, missaoVariable };
}

const _assetsCache = new Map();

// Esquece os prompts memoizados. Chamado quando um .md do pipeline é salvo ou
// restaurado pelo editor de prompts — sem isto o servidor seguiria servindo a
// versão antiga até o próximo restart.
function clearAssetsCache() {
  _assetsCache.clear();
}

// Lê os .md do volume e devolve os blocos + os critérios da versão. Memoizado
// por versão e invalidado por clearAssetsCache.
function loadAssets(version = DEFAULT_VERSION) {
  const cfg = versionConfig(version);
  if (_assetsCache.has(version)) return _assetsCache.get(version);

  const dir = versionDir(cfg);
  const slotsCaso = slotsCasoDe(cfg);
  const { blockA, blockB, blockC } = parseMontado(fs.readFileSync(path.join(dir, cfg.montado), 'utf8'), cfg.montado, slotsCaso);

  // Critérios: da pasta da própria versão, ou da versão apontada por
  // `criteriosDe` (o modo progressão usa a MESMA grade do v29 — duplicar o .md
  // faria as duas cópias divergirem na primeira edição do painel).
  const dirCriterios = cfg.criteriosDe ? versionDir(versionConfig(cfg.criteriosDe)) : dir;
  const criteria = parseCriteria(fs.readFileSync(path.join(dirCriterios, cfg.criterios), 'utf8'));
  if (criteria.length !== cfg.nCriterios) {
    throw new Error(`Esperava ${cfg.nCriterios} critérios em ${cfg.criterios}, encontrei ${criteria.length}.`);
  }

  const { synthStatic, synthVariable } = parseSintetizador(
    fs.readFileSync(path.join(dir, cfg.sintetizador), 'utf8'), cfg.sintetizador, slotsSintetizadorDe(cfg),
  );

  // Nó da MISSÃO (só o modo progressão tem): uma chamada à parte que responde se
  // a sidequest/missão diária foi cumprida. Mesma anatomia do sintetizador
  // (estático cacheável + parte variável).
  let missao = null;
  if (cfg.missao) {
    missao = parseMissao(fs.readFileSync(path.join(dir, cfg.missao), 'utf8'), cfg.missao, slotsCaso);
  }

  const assets = { version, cfg, blockA, blockB, blockC, criteria, synthStatic, synthVariable, missao, slotsCaso };
  _assetsCache.set(version, assets);
  return assets;
}

// Extrai, do .md de critérios: a descrição completa de cada critério (o bloco
// inteiro daquele número, que vai no slot {{CRITÉRIO}}) e o nome + linha curta
// (rótulos para a tela do supervisor). Devolve quantos houver, na ordem — quem
// confere se são 14 ou 15 é o loadAssets, pela versão.
function parseCriteria(raw) {
  const lcIdx = raw.indexOf('## Linha curta');
  const descSection = lcIdx !== -1 ? raw.slice(0, lcIdx) : raw;
  const shortSection = lcIdx !== -1 ? raw.slice(lcIdx) : '';

  const descs = {};
  const reDesc = /\*\*(\d{1,2}) · (.+?)\.\*\*[\s\S]*?(?=\n\*\*\d{1,2} · |\n---|\n## |$)/g;
  let m;
  while ((m = reDesc.exec(descSection))) {
    descs[Number(m[1])] = m[0].trim();
  }

  // Separador entre nome e linha curta: travessão até o v28, dois-pontos a
  // partir do v31. Aceita os dois para os .md das duas gerações conviverem.
  const shorts = {};
  const reShort = /^(\d{1,2})\.\s+\*\*(.+?)\*\*\s*(?:—|:)\s+(.+?)\.?\s*$/gm;
  while ((m = reShort.exec(shortSection))) {
    shorts[Number(m[1])] = { nome: m[2].trim(), linhaCurta: m[3].trim() };
  }

  return Object.keys(descs)
    .map(Number)
    .filter((i) => shorts[i])
    .sort((a, b) => a - b)
    .map((i) => ({ num: i, nome: shorts[i].nome, linhaCurta: shorts[i].linhaCurta, descricao: descs[i] }));
}

// Substituição literal (função replacer) — evita que `$` no log/bloco1/critério
// seja interpretado como referência de captura ($&, $1, ...).
function fill(str, slot, value) {
  return str.replace(slot, () => value);
}

// Concorrência do fan-out dos nós no GLM (z.ai). Conta nova tem rate limit
// apertado; 14 requisições de uma vez estouram 429. Roda em lotes pequenos.
const GLM_V25_CONCURRENCY = Number(process.env.GLM_V25_CONCURRENCY || 3);
// Concorrência do fan-out no GPT (OpenAI). O limite que estoura primeiro NÃO é
// requisições por minuto, é TOKENS por minuto: o contador de TPM da OpenAI
// RESERVA o max_completion_tokens de cada chamada, então cada nó pesa
// input + o teto de saída — e não o que ele de fato gerar.
//
// Este número é o TETO da concorrência; quem decide de verdade é
// concorrenciaPorTPM(), que mede a chamada real. Um número fixo aqui envelhece
// mal: com prompt e log pequenos, cada nó pesava ~20k e 4 em paralelo cabiam
// nos 200k; com o v28 (prompt maior) e um log longo, o mesmo nó pesa ~32k e os
// mesmos 4 pedem ~130k de uma vez, o que estoura a janela junto com o que ainda
// está pendurado nela ("Limit 200000, Used 184969, Requested 32528").
const OPENAI_V25_CONCURRENCY = Number(process.env.AVALIACAO_V25_CONCURRENCY || 4);
// Teto de TPM da organização (o do erro 429). Serve para dimensionar o fan-out;
// mude por env se o seu tier for outro.
const OPENAI_V25_TPM = Number(process.env.AVALIACAO_V25_TPM || 200000);
// Que fração do teto um ÚNICO lote pode pedir. Não é 1 nem perto disso porque a
// janela é DESLIZANTE: quando o lote novo sai, o anterior ainda está contando
// nela. Em 0,5 dois lotes seguidos cabem juntos no minuto. Foi exatamente esse o
// erro visto em produção — o lote pedia 130k "sozinho", mas chegou numa janela
// que já tinha 185k dentro.
const OPENAI_V25_TPM_FATOR = Number(process.env.AVALIACAO_V25_TPM_FATOR || 0.5);

// Tokens estimados de um texto. Heurística grosseira e de propósito PESSIMISTA
// (3,5 chars/token; português com acento rende menos que os 4 do inglês):
// superestimar reduz a concorrência, que é o lado seguro do erro.
function estimarTokens(str) {
  return Math.ceil(String(str || '').length / 3.5);
}

// --- Limitador de TPM por janela deslizante -------------------------------
//
// Por que o heurístico de concorrência não bastava: ele conta chamadas EM VOO,
// e o limite da OpenAI conta tokens POR MINUTO. As duas coisas só coincidem se
// toda chamada demorar o mesmo. No v32 não demoram: cada nó são duas chamadas em
// sequência, a segunda bem mais curta, então com a MESMA concorrência passam
// mais chamadas por minuto — e a janela enche por acúmulo ("Used 195581,
// Requested 16111"), sem que nenhuma chamada isolada seja grande.
//
// Este limitador modela o que a OpenAI de fato faz: mantém as reservas dos
// últimos 60s e segura a próxima chamada até ela caber. É GLOBAL de propósito —
// o teto é da organização, então duas avaliações rodando juntas dividem o mesmo
// orçamento em vez de se atropelarem.
const _tpmJanela = []; // { t: ms, tokens }

// Teto efetivo, lido a cada chamada. `0` desliga o limitador (usado nos testes,
// que não falam com a rede e não podem dormir esperando janela).
function tpmTeto() {
  if (process.env.AVALIACAO_V25_TPM_LIMITER === '0') return 0;
  const n = Number(process.env.AVALIACAO_V25_TPM);
  return Number.isFinite(n) && n > 0 ? n : OPENAI_V25_TPM;
}

// Fração do teto que deixamos ocupar. Abaixo de 1 porque a nossa estimativa de
// input é aproximada (chars/3.5) e porque o relógio da OpenAI não é o nosso.
const TPM_OCUPACAO = Number(process.env.AVALIACAO_V25_TPM_OCUPACAO || 0.85);

function _limpaJanela(agora) {
  while (_tpmJanela.length && agora - _tpmJanela[0].t >= 60000) _tpmJanela.shift();
}

// Espera até que `tokens` caibam na janela, e então os registra. Uma chamada
// maior que o orçamento inteiro passa assim que a janela esvazia — travá-la
// seria pior do que tomar o 429, que o retry já cobre.
async function reservarTPM(tokens) {
  const teto = tpmTeto();
  if (!teto || !Number.isFinite(tokens) || tokens <= 0) return;
  const orcamento = teto * TPM_OCUPACAO;
  for (;;) {
    const agora = Date.now();
    _limpaJanela(agora);
    const usados = _tpmJanela.reduce((a, r) => a + r.tokens, 0);
    if (!_tpmJanela.length || usados + tokens <= orcamento) {
      _tpmJanela.push({ t: agora, tokens });
      return;
    }
    // Espera o suficiente para a reserva mais antiga sair da janela.
    const esperar = 60000 - (agora - _tpmJanela[0].t) + 50;
    console.log(`[v25-tpm] janela em ${Math.round(usados / 1000)}k/${Math.round(orcamento / 1000)}k — segurando ${Math.round(tokens / 1000)}k por ${Math.round(esperar / 100) / 10}s`);
    await sleep(Math.max(50, Math.min(esperar, 60000)));
  }
}

// Só para teste: esvazia a janela entre casos.
function _resetTPM() {
  _tpmJanela.length = 0;
}

// Quantos nós disparar juntos sem estourar o TPM. Cada chamada RESERVA
// input + maxTokens na janela, então o que cabe é orçamento / reserva. Nunca
// abaixo de 1: aí vira serial, e o que sobrar o retry cobre.
function concorrenciaPorTPM(reservaPorChamada, tetoConfigurado) {
  if (!Number.isFinite(reservaPorChamada) || reservaPorChamada <= 0) return tetoConfigurado;
  const cabem = Math.floor((OPENAI_V25_TPM * OPENAI_V25_TPM_FATOR) / reservaPorChamada);
  return Math.max(1, Math.min(tetoConfigurado, cabem));
}

// Refazer o nó quando a ANÁLISE vem ANTES das travas. DESLIGADO por padrão, por
// dois motivos que se somam:
//
//   1. Custo: cada disparo é uma chamada inteira a mais. Num caso em que o
//      modelo erra a ordem sistematicamente, a run inteira dobra.
//   2. O remédio não pega a doença. O que preocupa é a impressão formada ANTES
//      de qualquer linha ser escrita, dentro do raciocínio. Um modelo que
//      decidiu a nota na cabeça e depois emitiu as travas na ordem certa passa
//      no teste; um que emitiu fora de ordem pode ter respondido pergunta por
//      pergunta. A ordem no papel não é evidência da ordem no pensamento.
//
// A DETECÇÃO fica: a parte é marcada com `analiseForaDeOrdem` e aparece na tela
// e no .txt. Como diagnóstico ela é barata e honesta — diz que aquele nó não
// seguiu o formato, sem fingir que provou algo sobre o raciocínio dele.
// Para experimentar com retentativa: AVALIACAO_V25_RETRY_ORDEM=1. Lido a cada
// chamada (como o interruptor do raciocínio), para dar pra ligar e desligar sem
// reiniciar o servidor no meio de uma bateria de teste.
function retriesDeOrdem() {
  const n = Number(process.env.AVALIACAO_V25_RETRY_ORDEM);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Refazer o nó quando ele volta SEM ANÁLISE. LIGADO por padrão (uma vez), e o
// motivo é outro do que o da ordem acima: aqui não há nada a interpretar — o
// formato pede a análise, ela é o último campo da saída, e voltar sem ela é
// defeito objetivo. Foi visto em produção: numa run do modo progressão, doze dos
// quinze nós devolveram as travas (logo, nota) e pararam antes da análise. A nota
// não se move com isso, mas o SINTETIZADOR passa a escrever o feedback do aluno
// com um quinto da evidência — e é o feedback que o aluno lê.
//
// Uma tentativa só: se o modelo repetir a omissão, o critério segue contando na
// nota e fica de fora do feedback (o comportamento de sempre), agora com aviso
// no log. Desligue com AVALIACAO_V25_RETRY_ANALISE=0 se quiser medir a
// frequência crua da omissão.
function retriesDeAnalise() {
  const raw = process.env.AVALIACAO_V25_RETRY_ANALISE;
  if (raw === '0') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// Retentativas por chamada, acima das do SDK. O SDK da OpenAI retenta 429/5xx só
// 2× com backoff de ~0,5s/1s — curto demais quando o Retry-After é de segundos
// (o TPM só libera na virada da janela de 1 minuto). Aqui esperamos o que o
// provedor pedir, com backoff exponencial como piso.
const V25_MAX_RETRIES = Number(process.env.AVALIACAO_V25_MAX_RETRIES || 6);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 (rate limit), 5xx e quedas de conexão valem retentar; 4xx de request
// inválido (400/401/404) não — retentar não conserta e só atrasa o erro.
function isRetryableAIError(err) {
  const status = err && (err.status || err.statusCode);
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
  if (status) return false;
  const code = String((err && (err.code || (err.cause && err.cause.code))) || '');
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)
    || (err && err.name === 'APIConnectionError')
    || (err && err.name === 'APIConnectionTimeoutError');
}

// Quanto esperar: Retry-After do provedor quando existe (header ou o "try again
// in 6.116s" da mensagem), senão backoff exponencial 2s→30s. Sempre com jitter,
// senão os nós do lote acordam todos juntos e estouram o limite de novo.
function retryDelayMs(err, attempt) {
  const h = (err && err.headers) || {};
  const get = (k) => (typeof h.get === 'function' ? h.get(k) : h[k]);
  const afterMs = Number(get('retry-after-ms'));
  const afterS = Number(get('retry-after'));
  let base = null;
  if (Number.isFinite(afterMs) && afterMs > 0) base = afterMs;
  else if (Number.isFinite(afterS) && afterS > 0) base = afterS * 1000;
  else {
    const m = String((err && err.message) || '').match(/try again in ([\d.]+)\s*(ms|s)\b/i);
    if (m) base = Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
  }
  if (base == null) base = Math.min(30000, 2000 * Math.pow(2, attempt));
  return Math.min(60000, Math.round(base * 1.25) + Math.floor(Math.random() * 1000));
}

// Executa `fn` retentando erros transitórios. `rotulo` só aparece no log.
async function withRetry(rotulo, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= V25_MAX_RETRIES || !isRetryableAIError(e)) throw e;
      const wait = retryDelayMs(e, attempt);
      console.warn(`[v25-retry] ${rotulo}: ${e.status || e.code || e.name} — nova tentativa em ${Math.round(wait / 100) / 10}s (${attempt + 1}/${V25_MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

// Map com concorrência limitada (mantém a ordem no array de saída).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Chamada não-streaming ao GPT (reasoning model). `developer` = prefixo
// estático/do-caso (cacheado automaticamente pela OpenAI); `user` = a parte que
// varia. Sem cache_control manual — não existe na OpenAI.
async function gptComplete(openai, developer, user, maxTokens, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', rotulo = 'chamada', captura = false) {
  // A OpenAI reserva input + o TETO de saída no contador de TPM, mesmo que o
  // modelo gere menos. Reservamos a mesma coisa, antes de chamar. (O GLM tem
  // limite próprio, tratado pela concorrência menor do fan-out.)
  if (provider === 'openai') {
    await reservarTPM(estimarTokens(developer) + estimarTokens(user) + maxTokens);
  }
  // Captura ligada + OpenAI → Responses API, o único lugar onde o resumo do
  // raciocínio existe. Nos demais casos segue o chat.completions de sempre.
  if (captura && provider === 'openai') {
    return gptCompleteResponses(openai, developer, user, maxTokens, model, effort, rotulo);
  }
  const resp = await withRetry(rotulo, () => openai.chat.completions.create(buildChatBody({
    provider,
    model,
    maxTokens,
    effort,
    messages: [
      { role: 'developer', content: developer },
      { role: 'user', content: user },
    ],
  })));
  const message = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
  return {
    text: message.content || '',
    // GLM devolve o raciocínio aqui mesmo, sem custo nem chamada extra.
    reasoning: captura ? extractChatReasoning(message) : '',
    usage: resp.usage || null,
  };
}

// A OpenAI só emite resumo de raciocínio nos modelos que têm sumarizador — o
// "mini" não tem, e mandar `summary` para ele faz a chamada falhar. Mesma regra
// que o avaliador de prompt único usa (ver buildSingleEvalResponsesArgs).
function modelEmiteResumo(model) {
  return !/mini/i.test(String(model || ''));
}

// Junta o resumo do raciocínio da Responses API. A OpenAI entrega o texto nos
// eventos `reasoning_summary_text.delta` — no não-streaming ele costuma vir
// vazio, por isso consumimos o stream aqui dentro (igual ao caminho do avaliador
// de prompt único). O visível e o usage saem do mesmo stream.
async function gptCompleteResponses(openai, developer, user, maxTokens, model, effort, rotulo) {
  return withRetry(rotulo, async () => {
    const stream = await openai.responses.create({
      model,
      reasoning: modelEmiteResumo(model) ? { effort, summary: 'auto' } : { effort },
      max_output_tokens: maxTokens,
      instructions: developer, // prefixo estático + caso → é o que a OpenAI cacheia
      input: [{ role: 'user', content: user }],
      stream: true,
    });
    let text = '';
    let reasoning = '';
    let usage = null;
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') {
        if (ev.delta) text += ev.delta;
      } else if (ev.type === 'response.reasoning_summary_text.delta') {
        if (ev.delta) reasoning += ev.delta;
      } else if (ev.type === 'response.reasoning_summary_part.added') {
        if (reasoning) reasoning += '\n\n'; // separa as partes do resumo
      } else if (ev.type === 'response.completed') {
        usage = (ev.response && ev.response.usage) || null;
      }
    }
    return { text, reasoning: reasoning.trim(), usage };
  });
}

// Raciocínio que o provedor devolveu junto da resposta do chat.completions. O
// GLM (z.ai) manda em `message.reasoning_content` quando o thinking está ligado;
// alguns provedores embutem em <think>…</think> no próprio conteúdo. A OpenAI,
// por este endpoint, não manda nada (só a contagem de tokens).
function extractChatReasoning(message) {
  const m = message || {};
  const rc = m.reasoning_content || m.reasoning || '';
  if (rc && String(rc).trim()) return String(rc).trim();
  const c = typeof m.content === 'string' ? m.content : '';
  const tag = c.match(/<think>([\s\S]*?)<\/think>/i);
  return tag ? tag[1].trim() : '';
}

// Notas de cada faixa: [completa (par), incompleta (ímpar)]. É a tabela que o
// prompt do v28 NÃO mostra ao modelo — ele responde travas e realização, e o
// número nasce aqui.
const NOTAS_POR_FAIXA = { 1: [2, 1], 2: [4, 3], 3: [6, 5], 4: [8, 7], 5: [10, 9] };

// Ordem em que as travas são testadas. A trava da FN é a passagem para a faixa N,
// então quem não passa a da F2 fica na F1.
const TRAVAS = [2, 3, 4, 5];

// Deriva a faixa a partir das respostas: sobe de baixo para cima e para na
// primeira que não passou. É AQUI que a hierarquia acumulativa vira regra de
// verdade — o modelo responde as quatro, mas uma trava aberta depois de uma
// fechada não promove ninguém.
//
// `inconsistente` marca justamente esse caso (respondeu `passa` numa trava acima
// de uma que não passou). Não é erro de formato: é o sinal de que o nó não está
// pensando em hierarquia, e vale ver na tela do supervisor.
function derivarFaixa(travas) {
  if (!travas || travas[2] == null) return { faixa: null, inconsistente: false };
  let faixa = 1;
  let parou = false;
  let inconsistente = false;
  for (const n of TRAVAS) {
    const passou = travas[n] === true;
    if (parou) {
      if (passou) inconsistente = true; // abriu uma trava acima de uma fechada
      continue;
    }
    if (passou) faixa = n;
    else parou = true;
  }
  return { faixa, inconsistente };
}

// Captura do resumo do raciocínio: a versão pede, mas dá para desligar por env
// sem deploy (AVALIACAO_V25_REASONING=0) — é o interruptor para medir se ela
// pesa no billing ou no rate limit. Nota: a RESERVA de TPM não muda com ela,
// porque o teto de saída é o mesmo nos dois caminhos; o que muda é o transporte.
function capturaLigada(cfg) {
  if (process.env.AVALIACAO_V25_REASONING === '0') return false;
  return !!(cfg && cfg.capturaReasoning);
}

// Etiqueta que o sintetizador lê no início de cada análise. Sai SÓ da faixa —
// completa/incompleta não a muda. É escrita por código: o nó nunca a vê, então
// não pode escolher o tom da própria análise. Ver sintetizador-v31.md.
const ETIQUETA_POR_FAIXA = { 1: 'erro', 2: 'clichê', 3: 'potente', 4: 'preciso', 5: 'excepcional' };

// Saída do nó: uma linha `Fn abre` por trava e uma `Fn realizada` por faixa
// aberta (mais a da F1 quando a trava da F2 não abre), com a ANÁLISE no FIM.
//
// Conviviam aqui outros dois parsers, um por formato de saída: o do v25 (o nó
// escrevia a NOTA direto) e o do v28 (`F3: passa`, com CONFIANÇA). Saíram com
// as versões; sobrou este, que é o do v29.
//
// O nó responde as quatro travas como perguntas independentes e não sabe onde
// vai parar — por isso responde a realização de todas as faixas que abriu. Só a
// realização da faixa DERIVADA conta; as outras são descartadas aqui mesmo e não
// chegam a ser persistidas. Se o nó soubesse qual delas contaria, saberia a nota
// e poderia preencher as travas de trás para frente.
function parseSaidaDoNo(text) {
  const t = String(text || '');

  const travas = {};
  const realizadas = {};
  for (const n of [1, 2, 3, 4, 5]) {
    if (n >= 2) {
      const abre = t.match(new RegExp(`^[^\\S\\n]*F${n}\\s+abre\\s*:\\s*(sim|n[ãa]o)`, 'im'));
      travas[n] = abre ? /^sim$/i.test(abre[1]) : null;
    }
    const real = t.match(new RegExp(`^[^\\S\\n]*F${n}\\s+realizada\\s*:\\s*(completa|incompleta)`, 'im'));
    realizadas[n] = real ? real[1].toLowerCase() : null;
  }

  const { faixa, inconsistente } = derivarFaixa(travas);
  // Realização ausente vale `completa`: a ímpar tem de ser afirmada, nunca
  // acontecer por omissão. Vale inclusive na F1, onde completa é a nota maior.
  const realizacao = faixa == null ? null : realizadas[faixa];
  const nota = faixa == null ? null : NOTAS_POR_FAIXA[faixa][realizacao === 'incompleta' ? 1 : 0];

  // A ANÁLISE vem por último no formato. Se ela aparecer ANTES da primeira
  // linha de trava, a prosa ancorou as respostas — é o que o caller retenta.
  const idxAnalise = t.search(/^[^\S\n]*AN[ÁA]LISE\s*:/im);
  const idxPrimeiraTrava = t.search(/^[^\S\n]*F[1-5]\s+(?:abre|realizada)\s*:/im);
  const analiseForaDeOrdem = idxAnalise !== -1 && idxPrimeiraTrava !== -1 && idxAnalise < idxPrimeiraTrava;

  const anaM = t.match(/AN[ÁA]LISE\s*:\s*([\s\S]*?)(?=\n[^\S\n]*F[1-5]\s+(?:abre|realizada)\s*:|$)/i);
  const analise = anaM ? anaM[1].trim() : '';

  return {
    nota,
    analise,
    travas,
    faixa,
    realizacao,
    inconsistente,
    analiseForaDeOrdem,
    etiqueta: faixa == null ? null : ETIQUETA_POR_FAIXA[faixa],
  };
}

// Um nó: uma chamada, um critério. `developer` (bloco estático + caso) vem
// pronto do caller — é idêntico em todos os nós, é justamente o prefixo que a
// OpenAI cacheia, e montá-lo uma vez só evita refazer a concatenação grande a
// cada nó. Ver buildDeveloper.
async function runNode(openai, assets, developer, criterio, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', captura = capturaLigada(assets.cfg)) {
  const user = fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao);

  // A tentativa descartada FOI COBRADA: o usage de todas entra na conta, não só
  // o da última. Sem isto o laboratório subestimaria o custo justamente nas runs
  // em que ele mais sobe — e o número daqui existe para ser comparado com o
  // billing real.
  const usages = [];
  let out;
  let parsed;
  let retentativas = 0;
  for (let tentativa = 0; ; tentativa++) {
    out = await gptComplete(openai, developer, user, V25_MAX_TOKENS, model, effort, provider, `nó ${criterio.num}`, captura);
    usages.push(out.usage);
    parsed = parseSaidaDoNo(out.text);

    // Sem ANÁLISE, mas com faixa: o nó pontuou e parou antes do último campo.
    const semAnalise = !parsed.analise && parsed.faixa != null;
    if (semAnalise && tentativa < retriesDeAnalise()) {
      retentativas++;
      console.warn(`[v29-nó] nó ${criterio.num} (${criterio.nome}) voltou sem ANÁLISE — refazendo (${tentativa + 1}/${retriesDeAnalise()})`);
      continue;
    }
    if (semAnalise) {
      console.warn(`[v29-nó] nó ${criterio.num} (${criterio.nome}) segue sem ANÁLISE: conta na nota, fica fora do feedback do aluno.`);
      break;
    }

    const teto = retriesDeOrdem();
    if (!parsed.analiseForaDeOrdem || tentativa >= teto) break;
    retentativas++;
    console.warn(`[v25-ordem] nó ${criterio.num}: análise veio antes das travas — refazendo (${tentativa + 1}/${teto})`);
  }

  return {
    num: criterio.num,
    nome: criterio.nome,
    linhaCurta: criterio.linhaCurta,
    ...parsed,
    reasoning: out.reasoning || '',
    usage: out.usage,
    // Todas as chamadas deste nó (a aproveitada e as descartadas).
    usages,
    retentativas,
  };
}

// Um critério entra na nota quando tem nota — e só isso. (No v25 a CONFIANÇA
// `baixa` também o tirava da conta; o campo deixou de existir na régua nova, e
// com ele a exceção.) Nó fora de formato não devolve número e fica de fora,
// marcado na tela do supervisor.
function entraNaNota(r) {
  return Number.isFinite(r.nota);
}

// Agregador determinístico. Pesos iguais por enquanto (parametrizáveis).
// Normaliza a média (1–10) para 0–100.
function aggregate(results, weights) {
  let ws = 0;
  let wt = 0;
  results.forEach((r, i) => {
    if (entraNaNota(r)) {
      const w = weights[i] != null ? weights[i] : 1;
      ws += r.nota * w;
      wt += w;
    }
  });
  if (!wt) return { notaFinal: null, media: null, considerados: 0 };
  const media = ws / wt;
  return { notaFinal: Math.round(media * 10), media, considerados: wt };
}

// Monta o bloco {{ANALISES}} do sintetizador: para cada critério que entra na
// nota, na ordem dos critérios, cabeçalho (nº + nome) + linha curta + a prosa do
// nó. Sem NOTA (a valência já vem na etiqueta e na 1ª palavra da prosa). Vazio
// se nenhum. Critério sem prosa (nó fora de formato) não entra.
function buildAnalises(results) {
  const blocks = results
    .filter((r) => r.analise)
    .sort((a, b) => a.num - b.num)
    .map((r) => {
      // A etiqueta ([preciso], [clichê]...) é colada por CÓDIGO a partir da
      // faixa. O nó não a escreve nem a vê, então não escolhe o tom com que a
      // própria análise chega ao sintetizador.
      const etiqueta = r.etiqueta ? `[${r.etiqueta}] ` : '';
      return `## ${r.num} · ${r.nome}\n${r.linhaCurta}\n${etiqueta}${r.analise}`;
    });
  return blocks.join('\n\n');
}

// Sintetizador: 1 chamada. developer = bloco estático (cacheável entre
// avaliações); user = log + análises. Devolve só o corpo (sem nota, sem saudação).
async function runSynthesizer(openai, assets, log, analises, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', captura = false, extras = {}) {
  let user = fill(fill(assets.synthVariable, '{{LOG}}', log), '{{ANALISES}}', analises);
  // Slots próprios da versão (modo progressão). O que a versão declara e o
  // caller não mandou entra com a frase de ausência, nunca cru.
  for (const slot of slotsSintetizadorDe(assets.cfg)) {
    const valor = extras && extras[slot] != null ? String(extras[slot]).trim() : '';
    user = fill(user, slot, valor || AUSENTE_POR_SLOT[slot] || '(não informado)');
  }
  const { text, reasoning, usage } = await gptComplete(openai, assets.synthStatic, user, V25_SYNTH_MAX_TOKENS, model, effort, provider, 'sintetizador', captura);
  return { corpo: (text || '').trim(), reasoning: reasoning || '', usage };
}

// Montagem final (código): nota + saudação da versão + corpo do sintetizador.
function montarFeedback(notaFinal, corpo, saudacao = SAUDACAO) {
  return `Nota: ${notaFinal}/100\n\n${saudacao}\n\n${corpo}`;
}

// (A saudação é uma só — ver SAUDACAO no topo. A produção monta o texto do
// aluno como SAUDACAO + corpo, sem a linha "Nota: X/100" do montarFeedback: lá
// a nota aparece como selo na tela.)

// --- Nó da MISSÃO (modo progressão) ---------------------------------------
//
// Uma chamada só, fora dos 15 critérios: responde se a sidequest/missão diária
// foi cumprida. Fica separada de propósito. No v18.25 o veredito vinha pendurado
// no fim do texto do avaliador ([sidequest-resultado] + JSON), e quem escrevia o
// feedback decidia a recompensa na mesma passada — dois trabalhos numa cabeça.
// Aqui o veredito é de quem só olha a missão, e o sintetizador nem o vê.
//
// Formato (ver missao-v29-progressao.md):
//   CUMPRIDA: <sim|não>
//   JUSTIFICATIVA: <uma a duas frases>
function parseSaidaMissao(text) {
  const t = String(text || '');
  const m = t.match(/^[^\S\n]*CUMPRIDA\s*:\s*(sim|n[ãa]o)/im);
  const j = t.match(/^[^\S\n]*JUSTIFICATIVA\s*:\s*([\s\S]*)$/im);
  return {
    // Sem resposta legível a missão NÃO é cumprida: a conclusão desbloqueia
    // recompensa, então o silêncio nunca pode virar um "sim" por omissão.
    cumprida: m ? /^sim$/i.test(m[1]) : false,
    legivel: !!m,
    justificativa: j ? j[1].trim().replace(/\s+/g, ' ') : '',
  };
}

async function runMissaoNode(openai, assets, materiais, model, effort, provider, captura) {
  let user = assets.missao.missaoVariable;
  for (const [slot, valor] of Object.entries(materiais)) user = fill(user, slot, valor);
  const out = await gptComplete(openai, assets.missao.missaoStatic, user, V25_MISSAO_MAX_TOKENS, model, effort, provider, 'nó da missão', captura);
  return { ...parseSaidaMissao(out.text), reasoning: out.reasoning || '', usage: out.usage };
}

// Resumo de uso + CUSTO EXATO da run. Soma os tokens que cada uma das 15
// chamadas (14 nós + sintetizador) devolveu e multiplica pela tabela de preço do
// modelo — é exatamente sobre esses tokens que a OpenAI cobra, então o número é o
// custo real daquela avaliação (não estimativa), instantâneo e sem depender do
// painel/admin key. Campos de usage da OpenAI: prompt_tokens (input TOTAL, inclui
// cacheados), prompt_tokens_details.cached_tokens, completion_tokens (inclui
// reasoning), completion_tokens_details.reasoning_tokens. A OpenAI cobra TODO o
// completion_tokens no rate de saída (o reasoning é subconjunto, cobrado igual);
// o split saída-visível/reasoning abaixo é só informativo.
// Soma os campos de uma lista de `usage` da OpenAI em {input(fresco), cached, output, reasoning}.
function sumUsages(usages) {
  const t = { input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const u of usages || []) {
    if (!u) continue;
    const promptTotal = u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0);
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
      || (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
    const completion = u.completion_tokens != null ? u.completion_tokens : (u.output_tokens || 0);
    const total = u.total_tokens != null ? u.total_tokens
      : (u.input_tokens != null && u.output_tokens != null ? u.input_tokens + u.output_tokens : 0);
    // GLM (z.ai): completion_tokens pode sub-reportar o thinking → usa total como piso.
    t.input += Math.max(0, promptTotal - cached);
    t.cached += cached;
    t.output += Math.max(completion, total > promptTotal ? total - promptTotal : 0);
    t.reasoning += (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens)
      || (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0;
  }
  return t;
}

// Custo (USD) de um `totais` pelos preços do modelo × fator (0,5 = batch). `null`
// se o modelo não tiver preço conhecido.
function custoFromTotais(totais, prices, factor) {
  if (!prices) return null;
  const f = factor == null ? 1 : factor;
  const usd = ((totais.input * prices.input + totais.cached * prices.cached + totais.output * prices.output) / 1e6) * f;
  return {
    usd,
    componentes: {
      input: (totais.input * prices.input / 1e6) * f,
      cached: (totais.cached * prices.cached / 1e6) * f,
      output: (totais.output * prices.output / 1e6) * f,
    },
  };
}

// Resumo de uso + CUSTO EXATO da run. `batch` aplica o desconto de 50% da Batch
// API — nos 14 NÓS (que rodam em lote); o sintetizador roda síncrono no coletor,
// então é cobrado full, e o custo abaixo soma nós(×0,5) + synth(×1) corretamente.
function buildInstrumentacao(model, nodeResults, synthUsage, effort = V25_EFFORT, batch = false) {
  // `usages` traz TODAS as chamadas do nó (incluindo tentativas descartadas por
  // ordem); `usage` sozinho é o fallback das versões que não retentam.
  const usagesNodes = [];
  let retentativas = 0;
  for (const r of nodeResults || []) {
    if (!r) continue;
    if (Array.isArray(r.usages) && r.usages.length) usagesNodes.push(...r.usages);
    else usagesNodes.push(r.usage);
    retentativas += r.retentativas || 0;
  }
  const totaisNodes = sumUsages(usagesNodes);
  const totaisSynth = sumUsages(synthUsage ? [synthUsage] : []);
  const totais = {
    input: totaisNodes.input + totaisSynth.input,
    cached: totaisNodes.cached + totaisSynth.cached,
    output: totaisNodes.output + totaisSynth.output,
    reasoning: totaisNodes.reasoning + totaisSynth.reasoning,
  };

  const prices = resolvePrices(model);
  let custo = null;
  if (prices) {
    const cNodes = custoFromTotais(totaisNodes, prices, batch ? 0.5 : 1);
    const cSynth = custoFromTotais(totaisSynth, prices, 1); // synth sempre síncrono
    const usd = cNodes.usd + cSynth.usd;
    const componentes = {
      input: cNodes.componentes.input + cSynth.componentes.input,
      cached: cNodes.componentes.cached + cSynth.componentes.cached,
      output: cNodes.componentes.output + cSynth.componentes.output,
    };
    custo = { usd, moeda: 'USD', precosPorMTok: prices, componentes, batch: !!batch };
  }

  // `retentativas` = chamadas EXTRAS cobradas por ordem trocada. Aparece na tela
  // para o custo de uma run não subir sem explicação.
  return { model, effort, totais, custo, batch: !!batch, retentativas, chamadas: usagesNodes.length + (synthUsage ? 1 : 0) };
}

// Monta o .txt do raciocínio que o supervisor baixa: cabeçalho com o que a run
// foi, um bloco por nó (com a nota e a confiança ao lado, que é o que dá sentido
// ao resumo) e o do sintetizador no fim. Puro — recebe o resultado, devolve
// texto — para o servidor só gravar e a rota só servir.
//
// Devolve '' quando não há resumo nenhum: aí não existe arquivo a guardar nem
// botão a mostrar (batch, modelo "mini", GLM com thinking desligado).
function buildReasoningTxt({ evaluatorLabel, version, model, effort, batch, casoNome, notaFinal, partes, reasoningSintetizador, criadoEm }) {
  const blocos = (partes || []).filter((p) => p.reasoning && p.reasoning.trim());
  if (!blocos.length && !(reasoningSintetizador || '').trim()) return '';

  const L = [];
  L.push('AVALIAÇÃO INDEPENDENTE — RACIOCÍNIO DA AVALIAÇÃO');
  L.push('='.repeat(52));
  L.push(`Avaliador: ${evaluatorLabel || version || '—'}`);
  L.push(`Modelo: ${model || '—'} · effort: ${effort || '—'}${batch ? ' · batch' : ''}`);
  if (casoNome) L.push(`Caso: ${casoNome}`);
  if (notaFinal != null) L.push(`Nota final: ${notaFinal}/100`);
  if (criadoEm) L.push(`Gerado em: ${criadoEm}`);
  L.push('');
  L.push('O que é este arquivo: o RESUMO do raciocínio de cada nó, do jeito que o');
  L.push('provedor o entrega. Não é a cadeia bruta de pensamento — a OpenAI não a');
  L.push('expõe em lugar nenhum, só este resumo. Serve para o supervisor entender');
  L.push('por que um critério recebeu a nota que recebeu, e não vai para o aluno.');
  L.push('');

  for (const p of blocos) {
    L.push('─'.repeat(52));
    L.push(`${p.num} · ${p.nome}`);
    const meta = [
      Number.isFinite(p.nota) ? `nota ${p.nota}/10` : 'sem nota',
      p.etiqueta ? `etiqueta ${p.etiqueta}` : null,
      p.incluido ? 'na nota final' : 'fora da nota final',
    ].filter(Boolean);
    L.push(`[${meta.join(' · ')}]`);
    // Como a nota foi derivada — quais travas abriram e onde parou.
    if (p.travas) {
      const linha = [2, 3, 4, 5].map((n) => `F${n} ${p.travas[n] === true ? '✓' : p.travas[n] === false ? '✗' : '?'}`).join('  ');
      L.push(`[${linha}  →  faixa F${p.faixa} · realização ${p.realizacao || 'não declarada (assumida completa)'}]`);
      if (p.travasInconsistentes) L.push('[⚠ trava aberta acima de uma fechada — descartada; o código parou na primeira fechada]');
      if (p.analiseForaDeOrdem) L.push('[⚠ a análise veio antes das travas mesmo depois da retentativa]');
    }
    L.push('');
    L.push(p.reasoning.trim());
    L.push('');
  }

  if ((reasoningSintetizador || '').trim()) {
    L.push('─'.repeat(52));
    L.push('Sintetizador (quem escreve o feedback do aluno)');
    L.push('');
    L.push(reasoningSintetizador.trim());
    L.push('');
  }

  const semResumo = (partes || []).filter((p) => !(p.reasoning && p.reasoning.trim()));
  if (semResumo.length) {
    L.push('─'.repeat(52));
    L.push(`Sem resumo de raciocínio em ${semResumo.length} nó(s): ${semResumo.map((p) => p.num).join(', ')}.`);
    L.push('O provedor não devolveu texto para eles nesta run.');
  }
  return L.join('\n');
}

// Materiais do caso, por SLOT do bloco B. As versões padrão têm dois
// ({{BLOCO_1}} e {{LOG}}); o modo progressão tem cinco. Aceita as duas formas de
// chamada — `{ bloco1, log }` (todo o código antigo) e `{ materiais }` (o mapa
// slot → texto) — e completa o que faltar com o aviso de ausência, para nenhum
// slot chegar ao modelo como texto cru `{{ASSIM}}`.
function normalizeMateriais(assets, { bloco1, log, materiais } = {}) {
  const slots = assets.slotsCaso || SLOTS_CASO_PADRAO;
  const out = {};
  for (const slot of slots) {
    const dado = materiais && materiais[slot] != null ? materiais[slot]
      : slot === '{{BLOCO_1}}' ? bloco1
        : slot === '{{LOG}}' ? log
          : null;
    const txt = dado == null ? '' : String(dado).trim();
    out[slot] = txt || AUSENTE_POR_SLOT[slot] || '(não informado)';
  }
  return out;
}

// O que vai no slot quando o material não existe naquela avaliação. Texto, e não
// vazio, porque o prompt tem seção sobre cada material: uma seção em branco o
// modelo interpreta como falha nossa, e uma frase explícita ele sabe ler (o
// prompt da progressão tem a cláusula "quando não há atendimento 1").
const AUSENTE_POR_SLOT = {
  '{{BLOCO_1}}': '(este caso não tem Bloco 1 configurado)',
  '{{ATENDIMENTO_1}}': '(não houve atendimento anterior — este é o primeiro atendimento do aluno neste caso)',
  '{{AVALIACAO_1}}': '(não há avaliação anterior)',
  '{{MISSAO}}': '(não há missão ativa neste atendimento)',
  '{{MISSAO_VEREDITO}}': '(não há missão ativa neste atendimento)',
  '{{LOG}}': '(sem mensagens)',
};

// Prefixo cacheável de um caso: bloco estático (A) + os materiais do caso (B).
function buildDeveloper(assets, materiaisNormalizados) {
  let blockB = assets.blockB;
  for (const [slot, valor] of Object.entries(materiaisNormalizados)) blockB = fill(blockB, slot, valor);
  return assets.blockA + '\n\n' + blockB;
}

// Executa o pipeline completo: nós → agregador → sintetizador → montagem.
// Semeia o cache rodando 1 nó primeiro (escreve A+B no cache da OpenAI), depois
// os demais em lotes (ver OPENAI_V25_CONCURRENCY / GLM_V25_CONCURRENCY) — assim
// o prefixo A+B (com o log) é cobrado cheio uma vez e lido barato pelos outros.
// O sintetizador roda por último.
async function runAvaliacaoIndependente({
  openai, bloco1, log, materiais, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai',
  version = DEFAULT_VERSION, evaluatorId,
  // Produção: acompanha o andamento sem revelar quantos nós existem (ver
  // /api/evaluate — o aluno vê uma barra, não "critério 7 de 15").
  onProgress,
  // `false` desliga a captura do resumo de raciocínio mesmo nas versões que a
  // pedem. A produção desliga: são 15 resumos por sessão avaliada, que ninguém
  // leria, e ligar troca o transporte das chamadas (Responses em vez de
  // chat.completions) sem mudar nada do que o aluno ou o supervisor recebem.
  capturarReasoning,
} = {}) {
  const assets = loadAssets(version);
  const { criteria } = assets;
  const weights = criteria.map(() => 1);
  const captura = capturarReasoning === undefined ? capturaLigada(assets.cfg) : !!capturarReasoning;
  const materiaisCaso = normalizeMateriais(assets, { bloco1, log, materiais });
  const logDoCaso = materiaisCaso['{{LOG}}'];

  // Progresso: os nós dos critérios + o da missão (quando há) + o sintetizador.
  const totalPassos = criteria.length + (assets.missao ? 1 : 0) + 1;
  let feitos = 0;
  const avancar = () => {
    feitos++;
    if (typeof onProgress === 'function') {
      try { onProgress({ feitos, total: totalPassos }); } catch {}
    }
  };

  const developer = buildDeveloper(assets, materiaisCaso);
  const rodarNo = async (c) => {
    const r = await runNode(openai, assets, developer, c, model, effort, provider, captura);
    avancar();
    return r;
  };

  const first = await rodarNo(criteria[0]);
  // Fan-out em lotes nos DOIS provedores: GLM tem rate limit apertado em conta
  // nova, e na OpenAI o que estoura é o TPM. Lá o lote é dimensionado pelo peso
  // REAL desta run (prompt + Bloco 1 + log + teto de saída), porque o mesmo nó
  // pesa muito diferente com um log curto ou com uma sessão inteira colada.
  let conc;
  if (provider === 'glm') {
    conc = GLM_V25_CONCURRENCY;
  } else {
    const maiorCriterio = criteria.reduce((a, c) => Math.max(a, (c.descricao || '').length), 0);
    const reserva = estimarTokens(developer) + estimarTokens(assets.blockC)
      + estimarTokens('x'.repeat(maiorCriterio)) + V25_MAX_TOKENS;
    conc = concorrenciaPorTPM(reserva, OPENAI_V25_CONCURRENCY);
    console.log(`[v25-fanout] ${criteria.length} nós · ~${reserva} tok reservados por chamada · concorrência ${conc} (teto ${OPENAI_V25_CONCURRENCY}, TPM ${OPENAI_V25_TPM})`);
  }
  // O nó da MISSÃO entra no mesmo fan-out dos critérios: ele não depende de
  // nenhum deles, e serializá-lo só somaria latência à espera do aluno.
  const [rest, missao] = await Promise.all([
    mapLimit(criteria.slice(1), conc, (c) => rodarNo(c)),
    assets.missao
      ? runMissaoNode(openai, assets, materiaisCaso, model, effort, provider, captura).then((r) => { avancar(); return r; })
      : Promise.resolve(null),
  ]);
  const results = [first, ...rest].sort((a, b) => a.num - b.num);

  const out = await finishPipeline({
    openai, assets, log: logDoCaso, results, weights, model, effort, provider, batch: false, evaluatorId,
    capturaSint: captura, missao, materiais: materiaisCaso,
  });
  avancar(); // sintetizador
  return out;
}

// Passo comum do fim do pipeline (síncrono e batch): agregador → partes →
// sintetizador → montagem → instrumentação.
async function finishPipeline({ openai, assets, log, results, weights, model, effort, provider, batch, evaluatorId, capturaSint = false, missao = null, materiais = null }) {
  const { cfg, version } = assets;

  const { notaFinal, considerados } = aggregate(results, weights);

  const partes = results.map((r) => ({
    num: r.num,
    nome: r.nome,
    linhaCurta: r.linhaCurta,
    analise: r.analise,
    nota: r.nota,
    // Como a nota foi derivada. Deixa o supervisor ver ONDE o caso parou, que é
    // a estatística que interessa — se a F3 está segurando ou se todo mundo
    // chega à F4.
    travas: r.travas || null,
    faixa: r.faixa != null ? r.faixa : null,
    realizacao: r.realizacao || null,
    // Etiqueta derivada da faixa (a que o sintetizador lê) e o aviso de que a
    // prosa veio antes das travas mesmo depois da retentativa.
    etiqueta: r.etiqueta || null,
    analiseForaDeOrdem: !!r.analiseForaDeOrdem,
    // Trava aberta acima de uma fechada foi DESCARTADA pelo código. Sem a
    // confiança, este é o sinal mais próximo que sobrou de "o nó titubeou aqui".
    travasInconsistentes: !!r.inconsistente,
    // Fora da conta final (nó que não devolveu número). Aparece na tela do
    // supervisor de qualquer jeito, marcado.
    incluido: entraNaNota(r),
  }));

  // Sintetizador + feedback do aluno só fazem sentido com pelo menos um critério
  // avaliável. Caso degenerado (nenhum nó devolveu nota legível): só o
  // supervisor vê as partes; não há feedback de aluno a montar.
  const analises = buildAnalises(results);
  let corpoSintetizador = null;
  let feedbackAluno = null;
  let synthUsage = null;
  let synthReasoning = '';
  if (notaFinal != null && analises) {
    // Extras do sintetizador (modo progressão): o atendimento anterior, a
    // missão e o VEREDITO dela, que já foi decidido pelo nó da missão. O
    // sintetizador recebe o veredito como fato para não escrever uma prosa que
    // contradiga o que o sistema vai registrar.
    const extras = {};
    if (materiais) {
      extras['{{ATENDIMENTO_1}}'] = materiais['{{ATENDIMENTO_1}}'];
      extras['{{MISSAO}}'] = materiais['{{MISSAO}}'];
    }
    if (missao) {
      extras['{{MISSAO_VEREDITO}}'] = `${missao.cumprida ? 'CUMPRIDA' : 'NÃO CUMPRIDA'}${missao.justificativa ? ` — ${missao.justificativa}` : ''}`;
    }
    const synth = await runSynthesizer(openai, assets, log, analises, model, effort, provider, capturaSint, extras);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    synthReasoning = synth.reasoning || '';
    feedbackAluno = montarFeedback(notaFinal, corpoSintetizador, cfg.saudacao);
  }

  // O nó da missão é uma chamada como as outras: entra na conta de custo junto
  // dos nós de critério (senão o custo do modo progressão apareceria menor do
  // que é). Só não entra na nota — missão cumprida não infla critério nenhum.
  const paraCusto = missao ? [...results, { usage: missao.usage, usages: [missao.usage] }] : results;
  const instrumentacao = buildInstrumentacao(model, paraCusto, synthUsage, effort, batch);

  // Raciocínio: o .txt já montado (ou '' quando não houve resumo nenhum). Sai
  // separado do resto porque é grande — o caller grava em arquivo próprio em vez
  // de engordar o store que é lido inteiro a cada avaliação.
  const reasoningTxt = buildReasoningTxt({
    evaluatorLabel: evaluatorId || version,
    version, model, effort, batch, casoNome: null, notaFinal,
    partes: partes.map((p, i) => ({ ...p, reasoning: results[i] ? results[i].reasoning : '' })),
    reasoningSintetizador: synthReasoning,
    criadoEm: new Date().toISOString(),
  });

  // `evaluator` é o id do avaliador no alternador (v28, v28-nota, ...) quando o
  // caller o informa; sem ele, a própria versão do pipeline.
  return {
    evaluator: evaluatorId || version, version, notaFinal, considerados, partes,
    corpoSintetizador, feedbackAluno, instrumentacao, reasoningTxt,
    // Veredito da missão (só o modo progressão). `null` quando a versão não tem
    // nó de missão — quem lê distingue "não há missão" de "não foi cumprida".
    missao: missao ? { cumprida: !!missao.cumprida, legivel: !!missao.legivel, justificativa: missao.justificativa || '' } : null,
  };
}

// --- Suporte a BATCH API (os nós num lote; sintetizador roda síncrono no coletor) ---

// Corpos /v1/chat/completions dos nós (mesmo developer cacheável + user do
// critério). O caller monta o custom_id (ex.: `${jobId}::${num}`) e o JSONL.
function buildPipelineNodeRequests({ bloco1, log, materiais, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION }) {
  const assets = loadAssets(version);
  const developer = buildDeveloper(assets, normalizeMateriais(assets, { bloco1, log, materiais }));
  return assets.criteria.map((criterio) => ({
    num: criterio.num,
    body: buildChatBody({
      provider,
      model,
      maxTokens: V25_MAX_TOKENS,
      effort,
      messages: [
        { role: 'developer', content: developer },
        { role: 'user', content: fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao) },
      ],
    }),
  }));
}

// Finaliza a partir das saídas dos nós do batch. `nodeOutputs` = [{ num, text, usage }].
// Roda o agregador, o sintetizador (síncrono, 1 chamada) e a instrumentação.
async function finalizePipeline({ openai, log, materiais, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION, nodeOutputs, batch = false, evaluatorId, missao = null }) {
  const assets = loadAssets(version);
  const weights = assets.criteria.map(() => 1);
  const byNum = new Map((nodeOutputs || []).map((o) => [o.num, o]));
  const results = assets.criteria
    .map((c) => {
      const o = byNum.get(c.num) || { text: '', usage: null };
      return { num: c.num, nome: c.nome, linhaCurta: c.linhaCurta, ...parseSaidaDoNo(o.text), usage: o.usage };
    })
    .sort((a, b) => a.num - b.num);

  // `capturaSint: false` sempre: aqui os nós vieram da Batch API, que roda em
  // /v1/chat/completions e não devolve resumo de raciocínio. Capturar só o do
  // sintetizador daria um arquivo manco (14 ou 15 nós em branco) e ainda trocaria
  // o transporte de uma run cujo motivo de existir é medir custo.
  return finishPipeline({
    openai, assets, log, results, weights, model, effort, provider, batch, evaluatorId,
    capturaSint: false, missao, materiais: materiais ? normalizeMateriais(assets, { materiais }) : null,
  });
}

module.exports = {
  // Execução do pipeline
  runAvaliacaoIndependente,
  buildChatBody,
  // Versões (v29 e o modo progressão dele)
  PIPELINE_VERSIONS,
  PIPELINE_VERSIONS_IDS,
  DEFAULT_VERSION,
  SAUDACAO,
  slotsCasoDe,
  slotsSintetizadorDe,
  normalizeMateriais,
  // Batch API (nós no lote; sintetizador roda síncrono no coletor)
  buildPipelineNodeRequests,
  finalizePipeline,
  // Raciocínio (laboratório) e utilidades de fila/custo
  buildReasoningTxt,
  modelEmiteResumo,
  extractChatReasoning,
  estimarTokens,
  concorrenciaPorTPM,
  reservarTPM,
  _resetTPM,
  // Usados pelo editor de prompts — a validação de um rascunho roda o MESMO
  // parser da produção.
  parseMontado,
  parseSintetizador,
  parseMissao,
  clearAssetsCache,
  // Exportados para teste
  loadAssets,
  parseCriteria,
  parseSaidaDoNo,
  parseSaidaMissao,
  derivarFaixa,
  NOTAS_POR_FAIXA,
  ETIQUETA_POR_FAIXA,
  aggregate,
  buildAnalises,
  montarFeedback,
  buildInstrumentacao,
  resolvePrices,
  isRetryableAIError,
  retryDelayMs,
};
