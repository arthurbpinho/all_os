// Avaliação Independente — pipeline multi-nó (AvaliAllos), em TESTE e isolado
// dos avaliadores de produção. Hospeda DUAS VERSÕES do mesmo desenho, v25 e v28
// (ver PIPELINE_VERSIONS); o nome "v25" no arquivo, nas envs e no store JSON é
// histórico — quem escolhe a versão é o registry de avaliadores.
//
// Roda em GPT-5.x (OpenAI, mesma OPENAI_API_KEY do resto; modelo por env
// AVALIACAO_V25_MODEL, hoje gpt-5.4-mini-2026-03-17). Os demais avaliadores
// (Treino/Competitivo/Duelo/Neuro/Trilha) NÃO são tocados por este arquivo.
//
// Pipeline completo (ver avaliacao/nova avaliacao/brief-pipeline-v25-completo.md):
//   1) Um nó GPT por critério, em paralelo (14 no v25, 15 no v28). Cada nó vê só
//      o seu critério + o Bloco 1 + o log, e devolve ANÁLISE / NOTA / CONFIANÇA.
//   2) Agregador determinístico (código): aplica pesos (iguais por enquanto) e
//      normaliza a média(1–10) para 0–100. No v25 os critérios de confiança
//      `baixa` ficam de fora da conta; no v28 a confiança não mexe no cálculo.
//   3) Sintetizador (1 chamada): recebe só o log + as análises em prosa (sem
//      números, sem Bloco 1) e devolve o corpo do feedback do aluno.
//   4) Montagem final (código): cola "Nota: X/100" + saudação fixa + corpo.
//
// Duas VARIANTES do nó (ver PIPELINE_VARIANTS), escolhidas no alternador da tela:
//   com-feedback → o nó devolve ANÁLISE + NOTA + CONFIANÇA (pipeline completo,
//                  com sintetizador e feedback do aluno);
//   so-nota      → o nó devolve só a NOTA (sem análise, o passo 3 é pulado e não
//                  há feedback do aluno; nota final e partes saem iguais). Roda
//                  mais barato — some o texto por critério do billing.
// As duas moram no MESMO .md do prompt do nó, em blocos `@variante`.
//
// RACIOCÍNIO (só v28, `capturaReasoning`): a OpenAI não entrega a cadeia bruta
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
// nem a varia — ver brief, "Montagem final"). É POR VERSÃO: cada uma tem a sua
// em PIPELINE_VERSIONS.saudacao, porque o texto faz parte do que a versão
// entrega ao aluno, não do encanamento.
//
// v25: os dois parágrafos do brief original, intocados (as runs dele são linha
// de base — mudar o texto mudaria o que já foi medido).
const SAUDACAO_V25 = `Trate este feedback como pré-correção, um ponto de partida para a conversa com seu supervisor e colegas, não um veredito.

Eu só tenho acesso ao que você escreveu, não ao que você pensou. Quando o raciocínio por trás de uma fala importar, descreva-o no botão de estrela. Isso me ajuda a separar uma decisão clínica consciente de um erro por falta de percepção.`;

// v28: só o enquadramento do feedback. O segundo parágrafo do v25 (o pedido para
// descrever o raciocínio na caixa de estrela) sai daqui.
const SAUDACAO_V28 = `Trate este feedback como pré-correção, um ponto de partida para a conversa com seu supervisor e colegas, não um veredito.`;

// VERSÕES do pipeline. Cada uma é um trio de .md no PROMPTS_DIR (prompt do nó,
// critérios, sintetizador) mais o que muda no CÓDIGO entre elas:
//
//   v25 → 14 critérios. CONFIANÇA `baixa` significa "o log não deu material":
//         o critério sai da nota final e sai do sintetizador.
//   v28 → 15 critérios (coerência interna e narrativa voltam separadas, desfeita
//         a fusão em "Confiança transmitida"). A CONFIANÇA virou recado para o
//         supervisor e NÃO entra mais no cálculo — o próprio prompt manda dar
//         nota de todo jeito ([SAÍDA]: "Ela não entra no cálculo... A nota você
//         dá de todo jeito"), então todo critério com nota entra na média e nas
//         análises do sintetizador.
//
// `dirs` é lista porque a pasta do v25 tem nomes diferentes nos dois lugares: no
// volume de produção ela se chama "nova avaliacao" e a cópia local do repo (a
// que semeia o volume e os testes) se chama "v25". Vale a primeira que existir,
// então os dois ambientes rodam sem renomear pasta em produção.
const PIPELINE_VERSIONS = {
  v25: {
    id: 'v25',
    dirs: ['nova avaliacao', 'v25'],
    montado: 'prompt-no-v25-montado.md',
    criterios: 'criterios-no-v25.md',
    sintetizador: 'sintetizador-v25.md',
    nCriterios: 14,
    confiancaBaixaExclui: true,
    capturaReasoning: false,
    saudacao: SAUDACAO_V25,
  },
  v28: {
    id: 'v28',
    dirs: ['v28'],
    montado: 'prompt-no-v28-montado.md',
    criterios: 'criterios-no-v28.md',
    sintetizador: 'sintetizador-v28.md',
    nCriterios: 15,
    confiancaBaixaExclui: false,
    // Guarda o RESUMO do raciocínio de cada nó (ver captureReasoning abaixo).
    // Só no v28: ligar isto no v25 trocaria o transporte das chamadas dele e
    // sujaria a linha de base de custo/latência que já foi medida.
    capturaReasoning: true,
    saudacao: SAUDACAO_V28,
  },
};
const PIPELINE_VERSIONS_IDS = Object.keys(PIPELINE_VERSIONS);
const DEFAULT_VERSION = 'v25';

function versionConfig(version) {
  const cfg = PIPELINE_VERSIONS[version];
  if (!cfg) throw new Error(`Versão do pipeline inválida: ${version} (${PIPELINE_VERSIONS_IDS.join(' | ')}).`);
  return cfg;
}

// Pasta da versão dentro do PROMPTS_DIR: a primeira de `dirs` que já tenha o
// prompt do nó. Nenhuma existindo, devolve a primeira — assim o erro que sobe é
// o ENOENT do caminho canônico, que diz onde o arquivo deveria estar.
function versionDir(cfg) {
  const base = path.join(PROMPTS_DIR, 'avaliacao');
  const achada = cfg.dirs.find((d) => fs.existsSync(path.join(base, d, cfg.montado)));
  return path.join(base, achada || cfg.dirs[0]);
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

// Variantes de saída do NÓ, marcadas no próprio prompt do nó montado com
// blocos `<!-- @variante:X -->…<!-- /@variante -->` (iguais nas duas versões):
//   com-feedback → ANÁLISE + NOTA + CONFIANÇA (o pipeline inteiro: agregador +
//                  sintetizador + feedback do aluno);
//   so-nota      → só a NOTA (sem análise ⇒ sem sintetizador ⇒ sem feedback do
//                  aluno; nota final e partes seguem iguais). Mais barato: o
//                  texto por critério some do billing, o reasoning fica.
// O resto do prompt é compartilhado — editar fora dos blocos muda as duas.
const PIPELINE_VARIANTS = ['com-feedback', 'so-nota'];
const DEFAULT_VARIANT = 'com-feedback';

function isValidVariant(v) {
  return PIPELINE_VARIANTS.includes(v);
}

// Mantém os blocos da variante escolhida e apaga os das outras. Se o arquivo não
// tiver marcador nenhum (versão antiga do .md, ainda no volume de produção),
// falha em vez de rodar silenciosamente a variante errada. `arquivo` só aparece
// na mensagem de erro (é o .md da versão em uso).
function selectVariant(text, variant, arquivo = 'O prompt do nó montado') {
  const re = /[ \t]*<!--\s*@variante:([a-z0-9-]+)\s*-->\r?\n?([\s\S]*?)[ \t]*<!--\s*\/@variante\s*-->\r?\n?/g;
  let found = false;
  const out = String(text).replace(re, (_m, v, inner) => {
    found = true;
    return v === variant ? inner : '';
  });
  if (!found) {
    throw new Error(`${arquivo} sem os blocos <!-- @variante:… --> (variante "${variant}"). Atualize o .md pelo painel de prompts (Administração → Prompts).`);
  }
  return out;
}

// Fatia o prompt do nó nos três blocos (A estático, B do caso, C do nó), pelos
// comentários de CACHE BREAKPOINT, já com a variante escolhida aplicada. PURO
// (recebe o texto, não lê disco) para o editor de prompts poder validar um
// rascunho com exatamente o mesmo parser que a produção usa.
function parseMontado(raw, variant = DEFAULT_VARIANT, arquivo = 'O prompt do nó montado') {
  if (!isValidVariant(variant)) throw new Error('Variante inválida: ' + variant);
  const montado = selectVariant(raw, variant, arquivo);

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

  for (const [name, blk, slot] of [['B', blockB, '{{BLOCO_1}}'], ['B', blockB, '{{LOG}}'], ['C', blockC, '{{CRITÉRIO}}']]) {
    if (!blk.includes(slot)) throw new Error(`Bloco ${name} do ${arquivo} não contém o slot ${slot}.`);
  }
  return { blockA, blockB, blockC };
}

// Sintetizador: bloco estático (do METACOMANDO até o breakpoint) vira o
// `developer` cacheável; o resto ({{LOG}} + {{ANALISES}} + tarefa) vira `user`.
// Puro, pelo mesmo motivo do parseMontado.
function parseSintetizador(sint, arquivo = 'O sintetizador') {
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
  return { synthStatic, synthVariable };
}

const _assetsCache = new Map();

// Esquece os prompts memoizados. Chamado quando um .md do pipeline é salvo ou
// restaurado pelo editor de prompts — sem isto o servidor seguiria servindo a
// versão antiga até o próximo restart.
function clearAssetsCache() {
  _assetsCache.clear();
}

// Lê os .md do volume e devolve os blocos + os critérios da versão. Memoizado
// por (versão, variante) e invalidado por clearAssetsCache.
function loadAssets(version = DEFAULT_VERSION, variant = DEFAULT_VARIANT) {
  const cfg = versionConfig(version);
  if (!isValidVariant(variant)) throw new Error('Variante inválida: ' + variant);
  const chave = `${version}|${variant}`;
  if (_assetsCache.has(chave)) return _assetsCache.get(chave);

  const dir = versionDir(cfg);
  const { blockA, blockB, blockC } = parseMontado(fs.readFileSync(path.join(dir, cfg.montado), 'utf8'), variant, cfg.montado);

  const criteria = parseCriteria(fs.readFileSync(path.join(dir, cfg.criterios), 'utf8'));
  if (criteria.length !== cfg.nCriterios) {
    throw new Error(`Esperava ${cfg.nCriterios} critérios em ${cfg.criterios}, encontrei ${criteria.length}.`);
  }

  const { synthStatic, synthVariable } = parseSintetizador(fs.readFileSync(path.join(dir, cfg.sintetizador), 'utf8'), cfg.sintetizador);

  const assets = { version, variant, cfg, blockA, blockB, blockC, criteria, synthStatic, synthVariable };
  _assetsCache.set(chave, assets);
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

  const shorts = {};
  const reShort = /^(\d{1,2})\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)\.?\s*$/gm;
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

// Quantos nós disparar juntos sem estourar o TPM. Cada chamada RESERVA
// input + maxTokens na janela, então o que cabe é orçamento / reserva. Nunca
// abaixo de 1: aí vira serial, e o que sobrar o retry cobre.
function concorrenciaPorTPM(reservaPorChamada, tetoConfigurado) {
  if (!Number.isFinite(reservaPorChamada) || reservaPorChamada <= 0) return tetoConfigurado;
  const cabem = Math.floor((OPENAI_V25_TPM * OPENAI_V25_TPM_FATOR) / reservaPorChamada);
  return Math.max(1, Math.min(tetoConfigurado, cabem));
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

// Estrutura a saída do nó por regex simples (conforme [SAÍDA] do prompt).
function parseNodeOutput(text) {
  const t = String(text || '');
  const notaM = t.match(/NOTA:\s*\[?\s*([0-9]{1,2})/i);
  const confM = t.match(/CONFIAN[ÇC]A:\s*(alta|m[ée]dia|baixa)/i);
  const anaM = t.match(/AN[ÁA]LISE:\s*([\s\S]*?)(?=\n[^\S\n]*NOTA:|$)/i);

  let nota = notaM ? Number(notaM[1]) : null;
  if (nota !== null && Number.isFinite(nota)) nota = Math.max(1, Math.min(10, Math.round(nota)));
  else nota = null;

  let confianca = confM ? confM[1].toLowerCase() : null;
  if (confianca === 'media') confianca = 'média';

  // Sem rótulo ANÁLISE (ex.: modo teste "só nota", ou nó fora de formato) → análise
  // vazia, para não injetar texto cru no sintetizador (que então é pulado).
  const analise = anaM ? anaM[1].trim() : '';
  return { nota, confianca, analise };
}

// `developer` (bloco estático + caso) vem pronto do caller: é idêntico em todos
// os nós — é justamente o prefixo que a OpenAI cacheia — e montá-lo uma vez só
// evita refazer a concatenação grande a cada nó. Ver buildDeveloper.
async function runNode(openai, assets, developer, criterio, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai') {
  const user = fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao);
  const captura = !!(assets.cfg && assets.cfg.capturaReasoning);
  const { text, reasoning, usage } = await gptComplete(openai, developer, user, V25_MAX_TOKENS, model, effort, provider, `nó ${criterio.num}`, captura);
  const parsed = parseNodeOutput(text);
  return {
    num: criterio.num,
    nome: criterio.nome,
    linhaCurta: criterio.linhaCurta,
    ...parsed,
    reasoning: reasoning || '',
    usage,
  };
}

// Um critério entra na nota quando tem nota. Na v25 a CONFIANÇA `baixa` também
// o tira (o prompt de lá manda usar `baixa` para "o log não deu material");
// na v28 a confiança é só recado ao supervisor e não mexe no cálculo.
function entraNaNota(r, confiancaBaixaExclui) {
  if (!Number.isFinite(r.nota)) return false;
  return !confiancaBaixaExclui || r.confianca !== 'baixa';
}

// Agregador determinístico. Pesos iguais por enquanto (parametrizáveis).
// Normaliza a média (1–10) para 0–100.
function aggregate(results, weights, confiancaBaixaExclui = true) {
  let ws = 0;
  let wt = 0;
  results.forEach((r, i) => {
    if (entraNaNota(r, confiancaBaixaExclui)) {
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
// nó. Sem NOTA nem CONFIANÇA (a valência já vem na 1ª palavra da prosa). Vazio
// se nenhum. Critério sem prosa (variante só-nota, ou nó fora de formato) não
// entra. O corte por confiança segue o da versão: na v25 `baixa` também sai do
// feedback; na v28 todas as análises vão para o sintetizador, que espera uma
// por critério.
function buildAnalises(results, confiancaBaixaExclui = true) {
  const blocks = results
    .filter((r) => (!confiancaBaixaExclui || r.confianca !== 'baixa') && r.analise)
    .sort((a, b) => a.num - b.num)
    .map((r) => `## ${r.num} · ${r.nome}\n${r.linhaCurta}\n${r.analise}`);
  return blocks.join('\n\n');
}

// Sintetizador: 1 chamada. developer = bloco estático (cacheável entre
// avaliações); user = log + análises. Devolve só o corpo (sem nota, sem saudação).
async function runSynthesizer(openai, assets, log, analises, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', captura = false) {
  const user = fill(fill(assets.synthVariable, '{{LOG}}', log), '{{ANALISES}}', analises);
  const { text, reasoning, usage } = await gptComplete(openai, assets.synthStatic, user, V25_SYNTH_MAX_TOKENS, model, effort, provider, 'sintetizador', captura);
  return { corpo: (text || '').trim(), reasoning: reasoning || '', usage };
}

// Montagem final (código): nota + saudação da versão + corpo do sintetizador.
function montarFeedback(notaFinal, corpo, saudacao = SAUDACAO_V25) {
  return `Nota: ${notaFinal}/100\n\n${saudacao}\n\n${corpo}`;
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
  const totaisNodes = sumUsages(nodeResults.map((r) => r && r.usage));
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

  return { model, effort, totais, custo, batch: !!batch };
}

// Monta o .txt do raciocínio que o supervisor baixa: cabeçalho com o que a run
// foi, um bloco por nó (com a nota e a confiança ao lado, que é o que dá sentido
// ao resumo) e o do sintetizador no fim. Puro — recebe o resultado, devolve
// texto — para o servidor só gravar e a rota só servir.
//
// Devolve '' quando não há resumo nenhum: aí não existe arquivo a guardar nem
// botão a mostrar (batch, modelo "mini", GLM com thinking desligado).
function buildReasoningTxt({ evaluatorLabel, version, variant, model, effort, batch, casoNome, notaFinal, partes, reasoningSintetizador, criadoEm }) {
  const blocos = (partes || []).filter((p) => p.reasoning && p.reasoning.trim());
  if (!blocos.length && !(reasoningSintetizador || '').trim()) return '';

  const L = [];
  L.push('AVALIAÇÃO INDEPENDENTE — RACIOCÍNIO DA AVALIAÇÃO');
  L.push('='.repeat(52));
  L.push(`Avaliador: ${evaluatorLabel || version || '—'}${variant ? ` (${variant})` : ''}`);
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
      p.confianca ? `confiança ${p.confianca}` : 'sem confiança',
      p.incluido ? 'na nota final' : 'fora da nota final',
    ];
    L.push(`[${meta.join(' · ')}]`);
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

// Prefixo cacheável de um caso: bloco estático (A) + Bloco 1 e log (B).
function buildDeveloper(assets, bloco1, log) {
  return assets.blockA + '\n\n' + fill(fill(assets.blockB, '{{BLOCO_1}}', bloco1), '{{LOG}}', log);
}

// Executa o pipeline completo: nós → agregador → sintetizador → montagem.
// Semeia o cache rodando 1 nó primeiro (escreve A+B no cache da OpenAI), depois
// os demais em lotes (ver OPENAI_V25_CONCURRENCY / GLM_V25_CONCURRENCY) — assim
// o prefixo A+B (com o log) é cobrado cheio uma vez e lido barato pelos outros.
// O sintetizador roda por último.
async function runAvaliacaoIndependente({ openai, bloco1, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION, variant = DEFAULT_VARIANT, evaluatorId }) {
  const assets = loadAssets(version, variant);
  const { criteria } = assets;
  const weights = criteria.map(() => 1);

  const developer = buildDeveloper(assets, bloco1, log);

  const first = await runNode(openai, assets, developer, criteria[0], model, effort, provider);
  // Fan-out em lotes nos DOIS provedores: GLM tem rate limit apertado em conta
  // nova, e na OpenAI o que estoura é o TPM. Lá o lote é dimensionado pelo peso
  // REAL desta run (prompt + Bloco 1 + log + teto de saída), porque o mesmo nó
  // pesa muito diferente com um log curto ou com uma sessão inteira colada.
  let conc;
  if (provider === 'glm') {
    conc = GLM_V25_CONCURRENCY;
  } else {
    const maiorCriterio = criteria.reduce((a, c) => Math.max(a, (c.descricao || '').length), 0);
    const reserva = estimarTokens(developer) + estimarTokens(assets.blockC) + estimarTokens('x'.repeat(maiorCriterio)) + V25_MAX_TOKENS;
    conc = concorrenciaPorTPM(reserva, OPENAI_V25_CONCURRENCY);
    console.log(`[v25-fanout] ${criteria.length} nós · ~${reserva} tok reservados por chamada · concorrência ${conc} (teto ${OPENAI_V25_CONCURRENCY}, TPM ${OPENAI_V25_TPM})`);
  }
  const rest = await mapLimit(criteria.slice(1), conc, (c) => runNode(openai, assets, developer, c, model, effort, provider));
  const results = [first, ...rest].sort((a, b) => a.num - b.num);

  return finishPipeline({
    openai, assets, log, results, weights, model, effort, provider, batch: false, evaluatorId,
    capturaSint: !!(assets.cfg && assets.cfg.capturaReasoning),
  });
}

// Passo comum do fim do pipeline (síncrono e batch): agregador → partes →
// sintetizador → montagem → instrumentação.
async function finishPipeline({ openai, assets, log, results, weights, model, effort, provider, batch, evaluatorId, capturaSint = false }) {
  const { cfg, version, variant } = assets;
  const excluiBaixa = cfg.confiancaBaixaExclui;

  const { notaFinal, considerados } = aggregate(results, weights, excluiBaixa);

  const partes = results.map((r) => ({
    num: r.num,
    nome: r.nome,
    linhaCurta: r.linhaCurta,
    analise: r.analise,
    nota: r.nota,
    confianca: r.confianca,
    // Fora da conta final (v25: `baixa`; qualquer versão: nó que não devolveu
    // número). Aparece na tela do supervisor de qualquer jeito, marcado.
    incluido: entraNaNota(r, excluiBaixa),
  }));

  // Sintetizador + feedback do aluno só fazem sentido com pelo menos um critério
  // avaliável. Caso degenerado (nenhuma nota, ou tudo `baixa` no v25): só o
  // supervisor vê as partes; não há feedback de aluno a montar.
  const analises = buildAnalises(results, excluiBaixa);
  let corpoSintetizador = null;
  let feedbackAluno = null;
  let synthUsage = null;
  let synthReasoning = '';
  if (notaFinal != null && analises) {
    const synth = await runSynthesizer(openai, assets, log, analises, model, effort, provider, capturaSint);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    synthReasoning = synth.reasoning || '';
    feedbackAluno = montarFeedback(notaFinal, corpoSintetizador, cfg.saudacao);
  }

  const instrumentacao = buildInstrumentacao(model, results, synthUsage, effort, batch);

  // Raciocínio: o .txt já montado (ou '' quando não houve resumo nenhum). Sai
  // separado do resto porque é grande — o caller grava em arquivo próprio em vez
  // de engordar o store que é lido inteiro a cada avaliação.
  const reasoningTxt = buildReasoningTxt({
    evaluatorLabel: evaluatorId || version,
    version, variant, model, effort, batch, casoNome: null, notaFinal,
    partes: partes.map((p, i) => ({ ...p, reasoning: results[i] ? results[i].reasoning : '' })),
    reasoningSintetizador: synthReasoning,
    criadoEm: new Date().toISOString(),
  });

  // `evaluator` é o id do avaliador no alternador (v28, v28-nota, ...) quando o
  // caller o informa; sem ele, a própria versão do pipeline.
  return { evaluator: evaluatorId || version, version, variant, notaFinal, considerados, partes, corpoSintetizador, feedbackAluno, instrumentacao, reasoningTxt };
}

// --- Suporte a BATCH API (os nós num lote; sintetizador roda síncrono no coletor) ---

// Corpos /v1/chat/completions dos nós (mesmo developer cacheável + user do
// critério). O caller monta o custom_id (ex.: `${jobId}::${num}`) e o JSONL.
function buildPipelineNodeRequests({ bloco1, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION, variant = DEFAULT_VARIANT }) {
  const assets = loadAssets(version, variant);
  const developer = assets.blockA + '\n\n' + fill(fill(assets.blockB, '{{BLOCO_1}}', bloco1), '{{LOG}}', log);
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
async function finalizePipeline({ openai, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION, variant = DEFAULT_VARIANT, nodeOutputs, batch = false, evaluatorId }) {
  const assets = loadAssets(version, variant);
  const weights = assets.criteria.map(() => 1);
  const byNum = new Map((nodeOutputs || []).map((o) => [o.num, o]));
  const results = assets.criteria
    .map((c) => {
      const o = byNum.get(c.num) || { text: '', usage: null };
      return { num: c.num, nome: c.nome, linhaCurta: c.linhaCurta, ...parseNodeOutput(o.text), usage: o.usage };
    })
    .sort((a, b) => a.num - b.num);

  // `capturaSint: false` sempre: aqui os nós vieram da Batch API, que roda em
  // /v1/chat/completions e não devolve resumo de raciocínio. Capturar só o do
  // sintetizador daria um arquivo manco (14 ou 15 nós em branco) e ainda trocaria
  // o transporte de uma run cujo motivo de existir é medir custo.
  return finishPipeline({ openai, assets, log, results, weights, model, effort, provider, batch, evaluatorId, capturaSint: false });
}

module.exports = {
  runAvaliacaoIndependente,
  buildChatBody,
  PIPELINE_VERSIONS,
  DEFAULT_VERSION,
  PIPELINE_VARIANTS,
  DEFAULT_VARIANT,
  isValidVariant,
  selectVariant,
  // Batch API (Avaliação Independente):
  buildPipelineNodeRequests,
  finalizePipeline,
  buildReasoningTxt,
  modelEmiteResumo,
  estimarTokens,
  concorrenciaPorTPM,
  // usados pelo editor de prompts (validação com o parser da produção):
  parseMontado,
  parseSintetizador,
  clearAssetsCache,
  // exportados para teste:
  loadAssets,
  parseCriteria,
  parseNodeOutput,
  aggregate,
  buildAnalises,
  montarFeedback,
  buildInstrumentacao,
  resolvePrices,
  isRetryableAIError,
  retryDelayMs,
};
