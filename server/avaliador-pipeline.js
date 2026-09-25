// PIPELINE DO AVALIADOR — AvaliAllos v34 (a régua LTS da escola).
//
// Uma régua só, em três entradas. O v34 fechou como a versão de longo prazo em
// 2026-09, e desde então é ele que corrige TODOS os modos de sessão que passam
// por aqui. As três entradas são o mesmo desenho — oito nós, cinco qualidades
// por nó, nota derivada por código, um sintetizador que nunca vê o Bloco 1 — e
// diferem só no que chega ao nó:
//
//   v34            → um atendimento (Bloco 1 + log). Treinamento, Competitivo,
//                    Visitante, Processo Seletivo e a correção manual do
//                    supervisor.
//   v34-progressao → o aluno reatende um caso: chegam os dois atendimentos, a
//                    avaliação que ele leu do primeiro e, às vezes, a missão
//                    ativa. Tem um nó a mais, o da missão, que decide se a
//                    sidequest/desafio do dia foi cumprida e não pontua
//                    critério nenhum.
//   v34-duelo      → dois alunos atenderam o MESMO caso: cada nó lê os dois
//                    logs e responde as cinco qualidades para cada um deles,
//                    mais uma análise comparativa. Duas notas saem daqui, e o
//                    vencedor é quem tirou a maior.
//
// O nome "v25" que sobrou nas envs (AVALIACAO_V25_*) e no store JSON é
// histórico — trocá-los apagaria a configuração de quem já tem essas envs
// setadas no painel do Railway.
//
// Roda em GPT-5.x (OpenAI) ou GLM (z.ai). Na produção o modelo vem da categoria
// em Administração → Modelos de IA; na aba do supervisor, do seletor da tela. Os
// avaliadores que ficaram FORA do pipeline (Neuro e Trilha) não passam aqui.
//
// Pipeline completo:
//   1) Os nós, em paralelo. Cada um vê só o Bloco 1 + o(s) log(s) + o critério
//      que lhe cabe, e nunca a nota. Devolve as cinco qualidades daquele
//      critério (`plena|parcial|ausente`) e a ANÁLISE. No modo duelo são dois
//      conjuntos de cinco, um por aluno, e a análise é comparativa.
//   2) Agregador determinístico (código): a nota de cada critério é a soma das
//      cinco qualidades (0–10), com pesos iguais por enquanto, e a média × 10
//      vira a nota final (0–100). Fica de fora só o critério cuja saída não deu
//      para ler.
//   3) Sintetizador (1 chamada): recebe só o(s) log(s) + o material dos nós (sem
//      números, sem Bloco 1) e devolve o corpo do feedback.
//   4) Montagem final (código): cola a nota (no laboratório) e a saudação fixa.
//
// Aqui moravam também as réguas de TRAVAS (v25, v28, v29, v31, v32), que
// derivavam a nota de uma tabela de faixas, e o v43, que era o v34 outra vez com
// as cinco qualidades decididas em cinco chamadas cegas. Saíram todas quando o
// v34 virou a LTS: o app roda uma régua só, e manter as outras significava
// manter dois parsers, dois formatos de saída e duas telas para o supervisor.
// As runs antigas continuam legíveis no histórico da Avaliação Independente
// porque o que ficou guardado é RESULTADO, não prompt.
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
// Os prompts (nó + sintetizador) e os critérios vêm dos .md guardados no banco
// (lidos da cópia em memória, server/prompt-store.js) — fonte única da verdade;
// editar o .md pelo painel muda o comportamento. Instrumentação de
// tokens/custo embutida para o teste de pricing.

const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR } = require('./paths');
const promptStore = require('./prompt-store');

// Saudação colada por código no topo do feedback do aluno (o modelo não a gera
// nem a varia). É só o enquadramento do feedback: a nota aparece como selo na
// tela (produção) ou no cabeçalho do relatório (laboratório).
//
// Era uma por versão enquanto o v34 convivia com a régua de travas, que trazia
// uma saudação mais longa. Com uma régua só, sobrou uma saudação só.
const SAUDACAO = `Este feedback é pré-correção: o começo da conversa com seu supervisor e seus colegas, não um veredito.`;

// As TRÊS entradas do v34. A régua, os critérios e o contrato de saída do nó são
// os mesmos nas três — o que muda é o que chega ao nó e quem escreve o feedback.
//
// `criteriosDe` faz a versão LER os critérios da pasta de outra. É o mesmo
// arquivo nas três, e duplicá-lo faria as cópias divergirem na primeira edição
// pelo painel de Administração → Prompts.
const PIPELINE_VERSIONS = {
  // O modo padrão: um atendimento, um aluno.
  v34: {
    id: 'v34',
    dir: 'v34',
    montado: 'prompt-no-v34-montado.md',
    criterios: 'criterios-no-v34.md',
    sintetizador: 'sintetizador-v34.md',
    capturaReasoning: true,
  },
  // Reatendimento. O que esta versão tem de próprio são os cinco slots do caso,
  // três slots extras no sintetizador e o prompt do nó da missão.
  'v34-progressao': {
    id: 'v34-progressao',
    dir: 'v34-progressao',
    montado: 'prompt-no-v34-progressao-montado.md',
    criterios: 'criterios-no-v34.md',
    criteriosDe: 'v34',
    sintetizador: 'sintetizador-v34-progressao.md',
    slotsSintetizador: ['{{ATENDIMENTO_1}}', '{{MISSAO}}', '{{MISSAO_VEREDITO}}'],
    missao: 'missao-v34-progressao.md',
    slotsCaso: ['{{BLOCO_1}}', '{{ATENDIMENTO_1}}', '{{AVALIACAO_1}}', '{{MISSAO}}', '{{LOG}}'],
    capturaReasoning: true,
  },
  // Duelo. A única entrada COMPARATIVA: o nó lê os dois logs e responde as cinco
  // qualidades para cada aluno, na mesma chamada. É o que torna a comparação
  // possível na régua nova — a alternativa (avaliar os dois separados e comparar
  // as notas) não produz o texto comparativo que os dois alunos leem, e é o
  // texto que ensina.
  //
  // `lados` liga o caminho comparativo: dois conjuntos de qualidades por
  // critério, duas notas finais, e uma análise só, que fala dos dois.
  'v34-duelo': {
    id: 'v34-duelo',
    dir: 'v34-duelo',
    montado: 'prompt-no-v34-duelo-montado.md',
    criterios: 'criterios-no-v34.md',
    criteriosDe: 'v34',
    sintetizador: 'sintetizador-v34-duelo.md',
    capturaReasoning: true,
    lados: ['A', 'B'],
    slotsCaso: ['{{BLOCO_1}}', '{{ALUNO_A}}', '{{LOG_A}}', '{{ALUNO_B}}', '{{LOG_B}}'],
    // O sintetizador comparativo recebe os dois logs no lugar do {{LOG}} único.
    slotsLog: ['{{ALUNO_A}}', '{{LOG_A}}', '{{ALUNO_B}}', '{{LOG_B}}'],
    // Sem saudação: o texto do duelo é comparativo, escrito na terceira pessoa
    // para os dois alunos, e a saudação em segunda pessoa do singular não cabe.
    saudacao: '',
  },
};

// Versões em que cada nó avalia DOIS alunos na mesma chamada. Muda o parser
// (dois conjuntos de qualidades por critério), o agregador (duas notas) e o que
// o sintetizador recebe.
function ladosDe(cfg) {
  return (cfg && Array.isArray(cfg.lados) && cfg.lados.length) ? cfg.lados : null;
}
function ehComparativa(cfg) {
  return !!ladosDe(cfg);
}

// Slot do sintetizador que recebe o material dos nós.
const SLOT_MATERIAL = '{{ANALISES}}';

// Slots da RÉGUA (demandas.md §16.6 e §20): quantos critérios existem e quais
// são. O código os preenche ao carregar a versão, em qualquer bloco. Existem
// porque o número de critérios deixou de ser fixo: um prompt que escrevesse
// "os oito critérios" à mão ficaria errado no primeiro "Adicionar critério" do
// painel, e o modelo leria a contagem velha. Opcionais: nenhum prompt é obrigado
// a usá-los, mas nenhum parser os recusa.
const SLOTS_REGUA = ['{{N_CRITERIOS}}', '{{N_CRITERIOS_EXTENSO}}', '{{LISTA_CRITERIOS}}'];
const NUMEROS_EXTENSO = 'zero um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis'.split(' ');

function preencherSlotsDaRegua(texto, criteria) {
  if (typeof texto !== 'string' || !texto.includes('{{')) return texto;
  const n = (criteria || []).length;
  const lista = (criteria || []).map((c) => `${c.num}. ${c.nome}: ${c.linhaCurta}`).join('\n');
  return texto
    .split('{{N_CRITERIOS_EXTENSO}}').join(NUMEROS_EXTENSO[n] || String(n))
    .split('{{N_CRITERIOS}}').join(String(n))
    .split('{{LISTA_CRITERIOS}}').join(lista);
}

// Slots do bloco do caso (bloco B do prompt do nó) de uma versão. O padrão são
// os dois de sempre; progressão e duelo declaram os seus em `slotsCaso`.
const SLOTS_CASO_PADRAO = ['{{BLOCO_1}}', '{{LOG}}'];
function slotsCasoDe(cfg) {
  return (cfg && Array.isArray(cfg.slotsCaso) && cfg.slotsCaso.length) ? cfg.slotsCaso : SLOTS_CASO_PADRAO;
}

// Slots de LOG que o sintetizador de uma versão exige, e que são preenchidos a
// partir dos materiais do caso. As versões individuais têm um só ({{LOG}}); o
// duelo tem os dois logs e os dois nomes.
const SLOTS_LOG_PADRAO = ['{{LOG}}'];
function slotsLogDe(cfg) {
  return (cfg && Array.isArray(cfg.slotsLog) && cfg.slotsLog.length) ? cfg.slotsLog : SLOTS_LOG_PADRAO;
}

// Slots ADICIONAIS que o sintetizador de uma versão pode usar, além dos de LOG e
// do {{ANALISES}} que todos têm. O modo progressão precisa do atendimento
// anterior e da missão (com o veredito já decidido) para escrever a comparação e
// falar da missão sem contradizer o nó que a julgou.
function slotsSintetizadorDe(cfg) {
  return (cfg && Array.isArray(cfg.slotsSintetizador)) ? cfg.slotsSintetizador : [];
}
const PIPELINE_VERSIONS_IDS = Object.keys(PIPELINE_VERSIONS);
const DEFAULT_VERSION = 'v34';

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

// Um .md da versão. Os prompts moram no banco e são lidos da cópia em memória
// (server/prompt-store.js), pelo mesmo caminho que tinham na pasta.
function lerDaVersao(cfg, arquivo) {
  return promptStore.lerObrigatorio(`avaliacao/${cfg.dir}/${arquivo}`);
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
// este parser escolhia uma. Do v29 em diante o arquivo inteiro é o prompt. Havia
// também um terceiro breakpoint, que só o v43 usava para mandar uma qualidade
// por chamada; saiu com ele.
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

  const blockA = montado.slice(start, bpA).trim();  // estático
  const blockB = montado.slice(bpAEnd, bpB).trim(); // os materiais do caso
  const blockC = montado.slice(bpBEnd).trim();      // {{CRITÉRIO}}

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
// `developer` cacheável; o resto (os logs + {{ANALISES}} + tarefa) vira `user`.
// Puro, pelo mesmo motivo do parseMontado.
//
// `slotsLog` são os slots de log EXIGIDOS pela versão: um só nas individuais, e
// os dois logs (mais os dois nomes) no duelo.
function parseSintetizador(sint, arquivo = 'O sintetizador', slotsExtra = [], slotsLog = SLOTS_LOG_PADRAO) {
  const sStart = sint.indexOf('## [METACOMANDO]');
  const sBp = sint.indexOf('<!-- CACHE BREAKPOINT');
  if (sStart === -1 || sBp === -1) {
    throw new Error(`${arquivo} sem os marcadores esperados (METACOMANDO / CACHE BREAKPOINT).`);
  }
  const sBpEnd = sint.indexOf('-->', sBp) + 3;
  const synthStatic = sint.slice(sStart, sBp).trim();
  const synthVariable = sint.slice(sBpEnd).trim();
  for (const slot of [...slotsLog, SLOT_MATERIAL]) {
    if (!synthVariable.includes(slot)) throw new Error(`${arquivo} não contém o slot ${slot}.`);
  }
  // Slot que o .md usa mas a versão não conhece seria enviado ao modelo como
  // texto cru `{{ASSIM}}`. Barra aqui, na gravação do prompt, e não em produção.
  const conhecidos = [...slotsLog, SLOT_MATERIAL, ...(slotsExtra || []), ...SLOTS_REGUA];
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
    if (!slotsCaso.includes(usado) && !SLOTS_REGUA.includes(usado)) throw new Error(`${arquivo} usa o slot ${usado}, que não existe nesta versão.`);
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

  const slotsCaso = slotsCasoDe(cfg);
  const { blockA, blockB, blockC } = parseMontado(
    lerDaVersao(cfg, cfg.montado), cfg.montado, slotsCaso,
  );

  // Critérios: da pasta da própria versão, ou da versão apontada por
  // `criteriosDe` (progressão e duelo usam a MESMA grade do v34 — duplicar o .md
  // faria as cópias divergirem na primeira edição do painel).
  const cfgCriterios = cfg.criteriosDe ? versionConfig(cfg.criteriosDe) : cfg;
  const criteria = parseCriteria(lerDaVersao(cfgCriterios, cfg.criterios));
  // Quantos critérios é decisão do admin ("Adicionar critério"), dentro da faixa.
  const limites = require('./limites-criterios');
  if (criteria.length < limites.min || criteria.length > limites.max) {
    throw new Error(`Esperava de ${limites.min} a ${limites.max} critérios em ${cfg.criterios}, encontrei ${criteria.length}.`);
  }

  const { synthStatic, synthVariable } = parseSintetizador(
    lerDaVersao(cfg, cfg.sintetizador), cfg.sintetizador, slotsSintetizadorDe(cfg), slotsLogDe(cfg),
  );

  // Nó da MISSÃO (só o modo progressão tem): uma chamada à parte que responde se
  // a sidequest/missão diária foi cumprida. Mesma anatomia do sintetizador
  // (estático cacheável + parte variável).
  let missao = null;
  if (cfg.missao) {
    missao = parseMissao(lerDaVersao(cfg, cfg.missao), cfg.missao, slotsCaso);
  }

  // Slots da régua: preenchidos uma vez, aqui. O texto resultante é estável
  // enquanto os critérios não mudarem, então o cache de prompt dos provedores
  // continua valendo entre avaliações.
  const regua = (t) => preencherSlotsDaRegua(t, criteria);
  if (missao) missao = { ...missao, missaoStatic: regua(missao.missaoStatic), missaoVariable: regua(missao.missaoVariable) };
  const assets = {
    version, cfg, blockA: regua(blockA), blockB: regua(blockB), blockC: regua(blockC), criteria,
    synthStatic: regua(synthStatic), synthVariable: regua(synthVariable), missao, slotsCaso,
  };
  _assetsCache.set(version, assets);
  return assets;
}

// Extrai, do .md de critérios: a descrição completa de cada critério (o bloco
// inteiro daquele número, que vai no slot {{CRITÉRIO}}) e o nome + linha curta
// (rótulos para a tela do supervisor). Devolve quantos houver, na ordem — quem
// confere se são oito é o loadAssets, pela versão.
function parseCriteria(raw) {
  const lcIdx = raw.indexOf('## Linha curta');
  const descSection = lcIdx !== -1 ? raw.slice(0, lcIdx) : raw;
  const shortSection = lcIdx !== -1 ? raw.slice(lcIdx) : '';

  // Um bloco é a seção aberta por `## 1 · Comunicação` e vai até a próxima. O
  // bloco INTEIRO (cabeçalho incluído) é o que vai ao slot {{CRITÉRIO}}: a
  // numeração é a ordem de um octógono, não hierarquia, e o nó não a usa — mas
  // ela também não atrapalha, e mantê-la deixa o que o modelo leu igual ao que
  // está no .md, que é o que se confere quando uma nota surpreende.
  //
  // O `$(?![\s\S])` do fim é o de VERDADE (fim do texto): com a flag `m`, um
  // `$` sozinho casaria com o fim da primeira linha e o bloco viria só com o
  // cabeçalho dentro.
  const descs = {};
  let m;
  const reDesc = /^## (\d{1,2}) · (.+?)[^\S\n]*$[\s\S]*?(?=\n## |\n---|$(?![\s\S]))/gm;
  while ((m = reDesc.exec(descSection))) {
    descs[Number(m[1])] = m[0].trim();
  }

  // Separador entre nome e linha curta: o v34 usa dois-pontos, e o travessão
  // segue aceito porque as réguas antigas o usavam e um .md restaurado do
  // histórico de versões ainda pode chegar assim ao parser.
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
// quinze nós da régua da época devolveram a nota e pararam antes da análise. A nota
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

// Refazer o nó do v34 quando falta uma das CINCO linhas de qualidade. Ligado por
// padrão (uma vez), pelo mesmo motivo da análise: o formato pede as cinco, e
// faltar uma é defeito objetivo, não interpretação. A diferença é o preço do
// erro — sem as cinco não há soma, então o critério inteiro sai da nota, e a
// média cai para sete oitavos do que devia medir.
//
// Knob próprio (e não o da análise) porque as duas frequências dizem coisas
// diferentes sobre o modelo, e o primeiro lote precisa medi-las separadas.
// Desligue com AVALIACAO_V34_RETRY_QUALIDADES=0 para ver a taxa crua.
function retriesDeQualidades() {
  const raw = process.env.AVALIACAO_V34_RETRY_QUALIDADES;
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

// Captura do resumo do raciocínio: a versão pede, mas dá para desligar por env
// sem deploy (AVALIACAO_V25_REASONING=0) — é o interruptor para medir se ela
// pesa no billing ou no rate limit. Nota: a RESERVA de TPM não muda com ela,
// porque o teto de saída é o mesmo nos dois caminhos; o que muda é o transporte.
function capturaLigada(cfg) {
  if (process.env.AVALIACAO_V25_REASONING === '0') return false;
  return !!(cfg && cfg.capturaReasoning);
}

// --- v34: cinco qualidades por critério ------------------------------------
//
// A régua nova não tem trava, faixa nem realização. Cada nó situa o trabalho do
// aluno em CINCO qualidades independentes, escolhendo entre três descrições em
// cada uma, e a nota do critério é a soma delas. As qualidades estão na ordem em
// que o prompt as apresenta — que é a ordem em que o nó deve escrevê-las e a
// ordem em que elas vão ao sintetizador.
const QUALIDADES_V34 = [
  { chave: 'integridade', rotulo: 'Integridade' },
  { chave: 'autoria', rotulo: 'Autoria' },
  { chave: 'potencia', rotulo: 'Potência' },
  { chave: 'calibracao', rotulo: 'Calibração' },
  { chave: 'excepcionalidade', rotulo: 'Excepcionalidade' },
];

// O MAPA. É o único lugar do sistema onde ele existe, e é decisão de projeto que
// ele não vaze para o prompt em forma nenhuma: sem número à vista, o modelo não
// tem alvo a mirar. Se um dia isto aparecer num .md, a régua deixou de medir o
// que dizia medir.
const PONTOS_POR_QUALIDADE = { plena: 2, parcial: 1, ausente: 0 };

// Rótulo do modelo → chave interna. Sem acento e em minúscula dos dois lados,
// porque `Potencia:` e `Calibracao:` chegam assim com alguma frequência e
// recusar a linha por causa de um til seria perder o critério inteiro.
function normalizaRotulo(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
const QUALIDADE_POR_ROTULO = new Map(QUALIDADES_V34.map((q) => [normalizaRotulo(q.rotulo), q.chave]));

// Uma linha de qualidade, como fonte de regex. Vem em duas peças porque ela é
// usada de dois jeitos: ancorada em início de linha (com a flag `m`) para varrer
// a saída, e precedida de `\n` explícito no lookahead que fecha a análise —
// onde a flag `m` não pode entrar, senão o `$` do fim cortaria uma análise de
// mais de uma linha. Tolera bullet, negrito e espaço sobrando: é o que muda
// entre uma saída limpa e uma enfeitada.
const RE_QUALIDADE_CORPO = '[^\\S\\n]*(?:[-*\u2022]\\s*)?\\**\\s*(\\p{L}+)\\s*\\**\\s*:\\s*\\**\\s*(plena|parcial|ausente)\\b';
const RE_LINHA_QUALIDADE = '^' + RE_QUALIDADE_CORPO;

// Saída do nó do v34: cinco linhas nomeadas + a ANÁLISE.
//
//   Integridade: <plena|parcial|ausente>
//   ...
//   ANÁLISE: <uma a três frases>
//
// LÊ POR NOME, e é esse o ponto. Os três valores possíveis se repetem entre as
// cinco qualidades, então posição não identifica nada: uma linha faltando ou
// fora de ordem deslocaria todas as seguintes em silêncio, e a run sairia com
// nota errada sem nada acusar. Ordem trocada, por isso, não é erro — o nome
// resolve.
//
// Linha FALTANDO, ao contrário, é erro explícito: o critério fica sem nota e sai
// da conta, marcado. Não existe aqui o valor assumido que a régua de travas
// tinha (lá a realização ímpar precisava ser afirmada, e a omissão valia
// `completa`); nas qualidades não há valor padrão defensável — assumir `parcial`
// inventaria um ponto e assumir `ausente` puniria um defeito de formato.
function parseSaidaDoNoQualidades(text) {
  const t = String(text || '');

  const qualidades = {};
  const linhas = {};
  // Uma passada pelas linhas, casando `Rótulo: valor` com tolerância a bullet,
  // negrito e espaço — o que muda entre uma saída limpa e uma enfeitada.
  const re = new RegExp(RE_LINHA_QUALIDADE, 'gimu');
  let m;
  while ((m = re.exec(t))) {
    const chave = QUALIDADE_POR_ROTULO.get(normalizaRotulo(m[1]));
    // Repetição: vale a PRIMEIRA. O nó que escreve a mesma qualidade duas vezes
    // já está fora do contrato, e trocar por cima faria a última linha (a mais
    // provável de ser um resumo solto) decidir a nota.
    if (chave && qualidades[chave] === undefined) {
      qualidades[chave] = m[2].toLowerCase();
      linhas[chave] = m[0].trim();
    }
  }

  const faltantes = QUALIDADES_V34.filter((q) => qualidades[q.chave] === undefined).map((q) => q.rotulo);
  // Soma das cinco: 0 a 10. Sem as cinco não há nota — nem soma parcial, que
  // seria uma nota baixa fingindo de avaliação.
  const nota = faltantes.length ? null
    : QUALIDADES_V34.reduce((acc, q) => acc + PONTOS_POR_QUALIDADE[qualidades[q.chave]], 0);

  // Mesma vigilância da régua anterior: a análise é o ÚLTIMO campo do formato,
  // e se ela vier antes das qualidades a prosa pode ter ancorado as escolhas.
  const idxAnalise = t.search(/^[^\S\n]*\**\s*AN[ÁA]LISE\s*\**\s*:/im);
  const idxPrimeira = t.search(new RegExp(RE_LINHA_QUALIDADE, 'imu'));
  const analiseForaDeOrdem = idxAnalise !== -1 && idxPrimeira !== -1 && idxAnalise < idxPrimeira;

  // A análise vai até o fim, ou até a próxima linha de qualidade quando o nó
  // escreveu fora de ordem — assim ela não engole as escolhas que vierem depois.
  const anaM = t.match(new RegExp(`AN[\u00c1A]LISE\\s*\\**\\s*:\\s*([\\s\\S]*?)(?=\\n${RE_QUALIDADE_CORPO}|$)`, 'iu'));
  const analise = anaM ? anaM[1].trim().replace(/^\**\s*/, '') : '';

  return {
    nota,
    analise,
    qualidades,
    // As cinco linhas como o nó as escreveu, para o supervisor conferir o que
    // chegou antes da normalização.
    qualidadesLinhas: linhas,
    faltantes,
    analiseForaDeOrdem,
  };
}

// As cinco linhas no formato que vai ao sintetizador: nome canônico e valor, na
// ordem do prompt. O código não escolhe nem resume nada aqui — não existe mais
// etiqueta única derivada de faixa, e quem conhece o significado das cinco
// qualidades e das três posições é o sintetizador, que decide o tom com elas.
function linhasDasQualidades(qualidades) {
  return QUALIDADES_V34
    .filter((q) => qualidades && qualidades[q.chave])
    .map((q) => `${q.rotulo}: ${qualidades[q.chave]}`);
}

// --- v34-duelo: dois alunos na mesma chamada -------------------------------
//
// O nó comparativo lê os DOIS logs e responde as cinco qualidades para cada
// aluno, mais uma análise que fala dos dois. É a única entrada do v34 em que uma
// chamada produz duas notas.
//
// Por que o nó vê os dois logs em vez de rodarmos a régua individual duas vezes:
// o que o duelo entrega aos alunos é o TEXTO COMPARATIVO, e ele só existe se
// alguém tiver lido as duas condutas contra o mesmo material. Rodar duas
// avaliações cegas daria duas notas comparáveis e nenhuma comparação.
//
// O preço disso é conhecido e está no prompt: um nó que vê os dois logs pode
// deixar a leitura de um contaminar a do outro (o clássico é puxar as escolhas
// de um para baixo porque o outro brilhou no mesmo momento). O prompt do nó
// carrega a cláusula que barra isso; o código não tem como conferir.
//
// Formato da saída, por critério:
//
//   A · Integridade: plena
//   ... (as cinco de A)
//   B · Integridade: parcial
//   ... (as cinco de B)
//   ANÁLISE: <comparativa>
//
// Mesma leitura POR NOME do parser individual, com a letra do aluno na frente.
// Posição não identifica nada aqui tampouco: os três valores se repetem entre as
// dez linhas, e uma linha faltando deslocaria todas as seguintes em silêncio.
const RE_LINHA_QUALIDADE_LADO = '^[^\\S\\n]*(?:[-*\u2022]\\s*)?\\**\\s*(?:Aluno\\s+)?([AB])\\s*\\**\\s*[\u00b7\u2013\u2014:.)\\-]\\s*\\**\\s*(\\p{L}+)\\s*\\**\\s*:\\s*\\**\\s*(plena|parcial|ausente)\\b';

// Saída do nó comparativo: as cinco qualidades de cada lado + a ANÁLISE.
//
// Devolve `notas` e `qualidades` indexados pela letra do aluno, e `faltantes`
// com os pares lado-qualidade que não vieram. A regra de invalidação é a mesma
// da régua individual, aplicada POR LADO: sem as cinco de um aluno não há soma
// para ele, e aquele critério sai da nota DELE — o outro lado, que veio
// completo, continua contando. Somar as que chegaram seria uma nota baixa
// fingindo de avaliação; derrubar os dois lados puniria um aluno pelo defeito de
// formato da resposta sobre o outro.
function parseSaidaDoNoComparativa(text, lados = ['A', 'B']) {
  const t = String(text || '');

  const qualidades = {};
  const qualidadesLinhas = {};
  for (const lado of lados) {
    qualidades[lado] = {};
    qualidadesLinhas[lado] = {};
  }

  const re = new RegExp(RE_LINHA_QUALIDADE_LADO, 'gimu');
  let m;
  while ((m = re.exec(t))) {
    const lado = m[1].toUpperCase();
    if (!qualidades[lado]) continue; // letra fora dos lados desta versão
    const chave = QUALIDADE_POR_ROTULO.get(normalizaRotulo(m[2]));
    // Repetição: vale a PRIMEIRA, pelo mesmo motivo da régua individual.
    if (chave && qualidades[lado][chave] === undefined) {
      qualidades[lado][chave] = m[3].toLowerCase();
      qualidadesLinhas[lado][chave] = m[0].trim();
    }
  }

  const faltantes = [];
  const notas = {};
  for (const lado of lados) {
    const faltam = QUALIDADES_V34.filter((q) => qualidades[lado][q.chave] === undefined).map((q) => q.rotulo);
    if (faltam.length) faltantes.push(...faltam.map((r) => `${lado} · ${r}`));
    notas[lado] = faltam.length ? null
      : QUALIDADES_V34.reduce((acc, q) => acc + PONTOS_POR_QUALIDADE[qualidades[lado][q.chave]], 0);
  }

  // Mesma vigilância da régua individual: a análise é o ÚLTIMO campo, e vir
  // antes das escolhas sugere que a prosa ancorou as dez linhas.
  const idxAnalise = t.search(/^[^\S\n]*\**\s*AN[ÁA]LISE\s*\**\s*:/im);
  const idxPrimeira = t.search(new RegExp(RE_LINHA_QUALIDADE_LADO, 'imu'));
  const analiseForaDeOrdem = idxAnalise !== -1 && idxPrimeira !== -1 && idxAnalise < idxPrimeira;

  const anaM = t.match(new RegExp(`AN[\u00c1A]LISE\\s*\\**\\s*:\\s*([\\s\\S]*?)(?=\\n${RE_LINHA_QUALIDADE_LADO.slice(1)}|$)`, 'iu'));
  const analise = anaM ? anaM[1].trim().replace(/^\**\s*/, '') : '';

  return { notas, qualidades, qualidadesLinhas, faltantes, analise, analiseForaDeOrdem };
}

// Parser do nó pela versão: comparativo no duelo, individual nas outras duas.
function parseSaidaDoNoDaVersao(text, cfg) {
  const lados = ladosDe(cfg);
  return lados ? parseSaidaDoNoComparativa(text, lados) : parseSaidaDoNoQualidades(text);
}

// Um nó: uma chamada, um critério. `developer` (bloco estático + caso) vem
// pronto do caller — é idêntico em todos os nós, é justamente o prefixo que a
// OpenAI cacheia, e montá-lo uma vez só evita refazer a concatenação grande a
// cada nó. Ver buildDeveloper.
//
// O nó saiu com número? Uma nota na régua individual, ou a de qualquer um dos
// dois lados no duelo. Serve para decidir se vale retentar por análise ausente:
// quando não houve nota nenhuma o formato já quebrou antes, e a retentativa das
// qualidades é que cobre esse caso.
function temAlgumaNota(parsed) {
  if (!parsed) return false;
  if (Number.isFinite(parsed.nota)) return true;
  return Object.values(parsed.notas || {}).some((n) => Number.isFinite(n));
}

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
    parsed = parseSaidaDoNoDaVersao(out.text, assets.cfg);

    // Linha de qualidade faltando é saída fora do contrato — aquele critério
    // fica SEM nota, e sem nota ele sai da conta. Vale uma retentativa pelo
    // mesmo motivo da análise ausente: aqui não há o que interpretar, o formato
    // pede as cinco linhas (dez no duelo) e faltar uma é defeito objetivo.
    // Insistindo, o critério fica de fora, marcado na tela do supervisor.
    if (parsed.faltantes && parsed.faltantes.length) {
      if (tentativa < retriesDeQualidades()) {
        retentativas++;
        console.warn(`[v34-nó] nó ${criterio.num} (${criterio.nome}) voltou sem ${parsed.faltantes.join(', ')} — refazendo (${tentativa + 1}/${retriesDeQualidades()})`);
        continue;
      }
      console.warn(`[v34-nó] nó ${criterio.num} (${criterio.nome}) segue sem ${parsed.faltantes.join(', ')}: fica fora da nota.`);
      break;
    }

    // Sem ANÁLISE, mas com nota: o nó pontuou e parou antes do último campo.
    const semAnalise = !parsed.analise && temAlgumaNota(parsed);
    if (semAnalise && tentativa < retriesDeAnalise()) {
      retentativas++;
      console.warn(`[v34-nó] nó ${criterio.num} (${criterio.nome}) voltou sem ANÁLISE — refazendo (${tentativa + 1}/${retriesDeAnalise()})`);
      continue;
    }
    if (semAnalise) {
      console.warn(`[v34-nó] nó ${criterio.num} (${criterio.nome}) segue sem ANÁLISE: conta na nota, fica fora do feedback do aluno.`);
      break;
    }

    const teto = retriesDeOrdem();
    if (!parsed.analiseForaDeOrdem || tentativa >= teto) break;
    retentativas++;
    console.warn(`[v25-ordem] nó ${criterio.num}: análise veio antes das escolhas — refazendo (${tentativa + 1}/${teto})`);
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

// A nota de um critério, pelo lado. `lado` null é a régua individual (`r.nota`);
// no duelo a nota mora em `r.notas.A` / `r.notas.B`.
function notaDoCriterio(r, lado) {
  if (!r) return null;
  const n = lado ? (r.notas && r.notas[lado]) : r.nota;
  return Number.isFinite(n) ? n : null;
}

// Um critério entra na nota quando tem nota — e só isso. (No v25 a CONFIANÇA
// `baixa` também o tirava da conta; o campo deixou de existir na régua nova, e
// com ele a exceção.) Nó fora de formato não devolve número e fica de fora,
// marcado na tela do supervisor.
//
// No duelo a pergunta é por LADO: um critério pode contar para um aluno e não
// para o outro, quando o nó devolveu as cinco qualidades de um e não as do
// outro. Derrubar os dois puniria um aluno pelo defeito de formato da resposta
// sobre o adversário.
function entraNaNota(r, lado = null) {
  return notaDoCriterio(r, lado) != null;
}

// Agregador determinístico. Pesos iguais por enquanto (parametrizáveis), e é
// aqui que a média por critério vira a nota da escola: média × 10.
//
// A nota de um critério é a soma de cinco qualidades que podem ser zero, então
// vai de 0 a 10 por critério e de 0 a 100 no fim.
//
// O DENOMINADOR é o número de critérios que devolveram nota legível, e não uma
// constante: a régua não exclui critério por juízo, mas um nó cuja saída não deu
// para ler não tem valor a somar. Contá-lo como zero transformaria um defeito de
// formato em nota baixa; `considerados` diz sobre quantos a média foi feita, e a
// tela mostra quem ficou de fora.
//
// No duelo isto roda uma vez por lado, e é por isso que as duas notas seguem
// comparáveis mesmo quando um critério sai da conta de um só dos dois: as duas
// são médias normalizadas, não somas.
function aggregate(results, weights, lado = null) {
  let ws = 0;
  let wt = 0;
  results.forEach((r, i) => {
    const nota = notaDoCriterio(r, lado);
    if (nota != null) {
      const w = weights[i] != null ? weights[i] : 1;
      ws += nota * w;
      wt += w;
    }
  });
  if (!wt) return { notaFinal: null, media: null, considerados: 0 };
  const media = ws / wt;
  return { notaFinal: Math.round(media * 10), media, considerados: wt };
}

// Monta o bloco {{ANALISES}} do sintetizador: um bloco por critério, na ordem
// dos critérios, com cabeçalho (nº + nome) e a linha curta — o sintetizador não
// conhece o vocabulário dos critérios, e é a linha curta que diz o que aquela
// dimensão media. Vazio se nenhum; critério sem prosa (nó fora de formato) não
// entra. Sem NOTA em versão nenhuma: o sintetizador escreve a partir do que
// aconteceu clinicamente, não de números.
//
// O miolo são as CINCO linhas, uma por qualidade, como o nó as escolheu, e
// depois a análise. O código não resume nada: quem conhece o significado das
// cinco qualidades e das três posições é o sintetizador, e é ele quem decide o
// tom. (A régua de travas colava aqui uma etiqueta derivada da faixa; com a
// faixa fora, não há o que derivar.)
//
// No duelo o bloco traz os dois conjuntos de cinco, um por aluno, antes da
// análise comparativa — que é uma só e fala dos dois.
function buildAnalises(results, cfg) {
  const lados = ladosDe(cfg);
  const blocks = results
    .filter((r) => r.analise)
    .sort((a, b) => a.num - b.num)
    .map((r) => {
      const cabeca = `## ${r.num} · ${r.nome}\n${r.linhaCurta}`;
      if (!lados) return `${cabeca}\n${linhasDasQualidades(r.qualidades).join('\n')}\n${r.analise}`;
      const porLado = lados
        .map((lado) => `Aluno ${lado} — ${linhasDasQualidades((r.qualidades || {})[lado]).join(' · ')}`)
        .join('\n');
      return `${cabeca}\n${porLado}\n${r.analise}`;
    });
  return blocks.join('\n\n');
}

// Sintetizador: 1 chamada. developer = bloco estático (cacheável entre
// avaliações); user = o(s) log(s) + as análises. Devolve só o corpo (sem nota,
// sem saudação).
//
// Os slots de LOG saem dos materiais do caso já normalizados — um nas versões
// individuais, os dois logs e os dois nomes no duelo.
async function runSynthesizer(openai, assets, materiais, analises, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', captura = false, extras = {}) {
  let user = fill(assets.synthVariable, SLOT_MATERIAL, analises);
  for (const slot of slotsLogDe(assets.cfg)) {
    user = fill(user, slot, (materiais && materiais[slot]) || AUSENTE_POR_SLOT[slot] || '(não informado)');
  }
  // Slots próprios da versão (modo progressão). O que a versão declara e o
  // caller não mandou entra com a frase de ausência, nunca cru.
  for (const slot of slotsSintetizadorDe(assets.cfg)) {
    const valor = extras && extras[slot] != null ? String(extras[slot]).trim() : '';
    user = fill(user, slot, valor || AUSENTE_POR_SLOT[slot] || '(não informado)');
  }
  const { text, reasoning, usage } = await gptComplete(openai, assets.synthStatic, user, V25_SYNTH_MAX_TOKENS, model, effort, provider, 'sintetizador', captura);
  return { corpo: (text || '').trim(), reasoning: reasoning || '', usage };
}

// Montagem final (código): cabeçalho de nota + saudação + corpo do sintetizador.
//
// `nota` é uma string já pronta, e não um número, porque o duelo tem DUAS notas
// e nenhum "Nota: X/100" faz sentido lá. Passar '' tira o cabeçalho inteiro.
// Saudação vazia (o duelo não tem, o texto dele é comparativo e em terceira
// pessoa) também não deixa linha em branco sobrando.
//
// A produção monta o texto do aluno como SAUDACAO + corpo, sem o cabeçalho de
// nota: lá a nota aparece como selo na tela.
function montarFeedback(nota, corpo, saudacao = SAUDACAO) {
  const cabecalho = nota === '' || nota == null ? '' : (typeof nota === 'number' ? `Nota: ${nota}/100` : String(nota));
  return [cabecalho, saudacao, corpo].filter((p) => p && String(p).trim()).join('\n\n');
}

// --- Nó da MISSÃO (modo progressão) ---------------------------------------
//
// Uma chamada só, fora dos 15 critérios: responde se a sidequest/missão diária
// foi cumprida. Fica separada de propósito. No v18.25 o veredito vinha pendurado
// no fim do texto do avaliador ([sidequest-resultado] + JSON), e quem escrevia o
// feedback decidia a recompensa na mesma passada — dois trabalhos numa cabeça.
// Aqui o veredito é de quem só olha a missão, e o sintetizador nem o vê.
//
// Formato (ver missao-v34-progressao.md):
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
// foi, um bloco por nó (com as cinco escolhas e a nota ao lado, que é o que dá
// sentido ao resumo) e o do sintetizador no fim. Puro — recebe o resultado,
// devolve texto — para o servidor só gravar e a rota só servir.
//
// Devolve '' quando não há resumo nenhum: aí não existe arquivo a guardar nem
// botão a mostrar (batch, modelo "mini", GLM com thinking desligado).
function buildReasoningTxt({ evaluatorLabel, version, model, effort, batch, casoNome, notaFinal, comparativo, partes, reasoningSintetizador, criadoEm }) {
  const blocos = (partes || []).filter((p) => p.reasoning && p.reasoning.trim());
  if (!blocos.length && !(reasoningSintetizador || '').trim()) return '';

  const L = [];
  L.push('AVALIAÇÃO INDEPENDENTE — RACIOCÍNIO DA AVALIAÇÃO');
  L.push('='.repeat(52));
  L.push(`Avaliador: ${evaluatorLabel || version || '—'}`);
  L.push(`Modelo: ${model || '—'} · effort: ${effort || '—'}${batch ? ' · batch' : ''}`);
  if (casoNome) L.push(`Caso: ${casoNome}`);
  if (notaFinal != null) L.push(`Nota final: ${notaFinal}/100`);
  // Duelo: duas notas e o vencedor no lugar da nota única.
  if (comparativo) {
    L.push(`Notas: ${Object.entries(comparativo.notas).map(([l, n]) => `Aluno ${l} ${n == null ? '—' : `${n}/100`}`).join(' · ')}`);
    L.push(`Vencedor: ${comparativo.vencedor === 'empate' ? 'empate' : comparativo.vencedor ? `Aluno ${comparativo.vencedor}` : 'indefinido'}`);
  }
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
    // As cinco escolhas que somaram a nota (dez no duelo, cinco por aluno). É o
    // que faz o resumo do raciocínio ser legível — sem elas o supervisor lê o
    // pensamento sem saber onde ele parou.
    if (p.notas) {
      for (const [lado, nota] of Object.entries(p.notas)) {
        const dentro = p.incluido && typeof p.incluido === 'object' ? p.incluido[lado] : null;
        const meta = [
          Number.isFinite(nota) ? `nota ${nota}/10` : 'sem nota',
          dentro === false ? 'fora da nota final' : 'na nota final',
        ];
        L.push(`[Aluno ${lado} · ${meta.join(' · ')}]`);
        L.push(`[${linhasDasQualidades((p.qualidades || {})[lado]).join('  ·  ')}]`);
      }
    } else {
      const meta = [
        Number.isFinite(p.nota) ? `nota ${p.nota}/10` : 'sem nota',
        p.incluido ? 'na nota final' : 'fora da nota final',
      ];
      L.push(`[${meta.join(' · ')}]`);
      if (p.qualidades) L.push(`[${linhasDasQualidades(p.qualidades).join('  ·  ')}]`);
    }
    if (p.qualidadesFaltantes) L.push(`[⚠ o nó não devolveu ${p.qualidadesFaltantes.join(', ')} — sem as cinco não há soma, e aquele lado ficou fora da nota]`);
    if (p.analiseForaDeOrdem) L.push('[⚠ a análise veio antes das escolhas]');
    L.push('');
    L.push(p.reasoning.trim());
    L.push('');
  }

  if ((reasoningSintetizador || '').trim()) {
    L.push('─'.repeat(52));
    L.push('Sintetizador (quem escreve o feedback que o aluno lê)');
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
  // Duelo: o nome de cada aluno e o log dele. O nome cai num rótulo neutro
  // quando não vem — o prompt fala de "Aluno A" e "Aluno B" de qualquer jeito.
  '{{ALUNO_A}}': 'Aluno A',
  '{{ALUNO_B}}': 'Aluno B',
  '{{LOG_A}}': '(sem mensagens)',
  '{{LOG_B}}': '(sem mensagens)',
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
  // pedem. A produção desliga: são oito resumos por sessão avaliada, que ninguém
  // leria, e ligar troca o transporte das chamadas (Responses em vez de
  // chat.completions) sem mudar nada do que o aluno ou o supervisor recebem.
  capturarReasoning,
} = {}) {
  const assets = loadAssets(version);
  const { criteria } = assets;
  const weights = criteria.map(() => 1);
  const captura = capturarReasoning === undefined ? capturaLigada(assets.cfg) : !!capturarReasoning;
  const materiaisCaso = normalizeMateriais(assets, { bloco1, log, materiais });

  // Progresso: uma unidade por nó + a da missão (quando há) + a do sintetizador.
  // A barra do aluno não revela a aritmética; ela só precisa não pular.
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
  //
  let conc;
  if (provider === 'glm') {
    conc = GLM_V25_CONCURRENCY;
  } else {
    const maiorCriterio = criteria.reduce((a, c) => Math.max(a, (c.descricao || '').length), 0);
    const reserva = estimarTokens(developer) + estimarTokens(assets.blockC)
      + estimarTokens('x'.repeat(maiorCriterio)) + V25_MAX_TOKENS;
    conc = concorrenciaPorTPM(reserva, OPENAI_V25_CONCURRENCY);
    console.log(`[v25-fanout] ${criteria.length} nó(s) · ~${reserva} tok reservados por chamada · concorrência ${conc} (teto ${OPENAI_V25_CONCURRENCY}, TPM ${OPENAI_V25_TPM})`);
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
    openai, assets, results, weights, model, effort, provider, batch: false, evaluatorId,
    capturaSint: captura, missao, materiais: materiaisCaso,
  });
  avancar(); // sintetizador
  return out;
}

// Passo comum do fim do pipeline (síncrono e batch): agregador → partes →
// sintetizador → montagem → instrumentação.
async function finishPipeline({ openai, assets, results, weights, model, effort, provider, batch, evaluatorId, capturaSint = false, missao = null, materiais = null }) {
  const { cfg, version } = assets;
  const lados = ladosDe(cfg);

  // Individual: uma nota. Duelo: uma por lado, mais o vencedor, que é só a
  // comparação das duas — o modelo não o declara em lugar nenhum, de propósito.
  let notaFinal = null;
  let considerados = 0;
  let comparativo = null;
  if (lados) {
    const porLado = {};
    for (const lado of lados) porLado[lado] = aggregate(results, weights, lado);
    const notas = {};
    const consideradosPorLado = {};
    for (const lado of lados) {
      notas[lado] = porLado[lado].notaFinal;
      consideradosPorLado[lado] = porLado[lado].considerados;
    }
    // Sem as duas notas não há duelo a decidir: o caller trata `vencedor: null`
    // como "não foi possível avaliar" e devolve o duelo para pendente.
    const [a, b] = lados;
    const vencedor = (notas[a] == null || notas[b] == null) ? null
      : notas[a] > notas[b] ? a : notas[b] > notas[a] ? b : 'empate';
    comparativo = { notas, considerados: consideradosPorLado, vencedor };
    considerados = Math.max(...Object.values(consideradosPorLado));
  } else {
    const ag = aggregate(results, weights);
    notaFinal = ag.notaFinal;
    considerados = ag.considerados;
  }

  const partes = results.map((r) => ({
    num: r.num,
    nome: r.nome,
    linhaCurta: r.linhaCurta,
    analise: r.analise,
    // Individual: a nota do critério. Duelo: `null` aqui, e as duas em `notas`.
    nota: lados ? null : r.nota,
    notas: lados ? (r.notas || null) : null,
    // Os CINCO valores, e não só a soma. É o que permite reprocessar offline se
    // a ponderação mudar (qualquer função futura tem de ser monótona, não
    // depender do perfil do aluno e sair destes valores) e é onde vai entrar a
    // complexidade de agregação depois. Guardar só a nota jogaria fora
    // justamente a informação que a régua foi feita para produzir.
    //
    // No duelo é um mapa por lado: { A: {...cinco}, B: {...cinco} }.
    qualidades: r.qualidades || null,
    // Quais não vieram, quando o nó insistiu em sair do contrato. No duelo vêm
    // rotuladas com o lado (`A · Potência`), que é o que diz de quem foi.
    qualidadesFaltantes: (r.faltantes && r.faltantes.length) ? r.faltantes : null,
    // A prosa veio antes das escolhas mesmo depois da retentativa.
    analiseForaDeOrdem: !!r.analiseForaDeOrdem,
    // Fora da conta final (nó que não devolveu número). Aparece na tela do
    // supervisor de qualquer jeito, marcado. No duelo é por lado.
    incluido: lados ? Object.fromEntries(lados.map((l) => [l, entraNaNota(r, l)])) : entraNaNota(r),
  }));

  // Sintetizador + feedback do aluno só fazem sentido com pelo menos um critério
  // avaliável. Caso degenerado (nenhum nó devolveu nota legível): só o
  // supervisor vê as partes; não há feedback de aluno a montar.
  const analises = buildAnalises(results, cfg);
  const temNota = lados ? Object.values(comparativo.notas).some((n) => n != null) : notaFinal != null;
  let corpoSintetizador = null;
  let feedbackAluno = null;
  let synthUsage = null;
  let synthReasoning = '';
  if (temNota && analises) {
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
    const synth = await runSynthesizer(openai, assets, materiais, analises, model, effort, provider, capturaSint, extras);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    synthReasoning = synth.reasoning || '';
    // No duelo são duas notas, e o cabeçalho de nota única não cabe: as duas
    // aparecem lado a lado na tela do resultado.
    const cabecalho = lados
      ? lados.map((l) => `Aluno ${l}: ${comparativo.notas[l] == null ? '—' : `${comparativo.notas[l]}/100`}`).join(' · ')
      : notaFinal;
    feedbackAluno = montarFeedback(cabecalho, corpoSintetizador, cfg.saudacao);
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
    version, model, effort, batch, casoNome: null, notaFinal, comparativo,
    partes: partes.map((p, i) => ({ ...p, reasoning: results[i] ? results[i].reasoning : '' })),
    reasoningSintetizador: synthReasoning,
    criadoEm: new Date().toISOString(),
  });

  // `evaluator` é o id do avaliador no alternador quando o caller o informa;
  // sem ele, a própria versão do pipeline.
  return {
    evaluator: evaluatorId || version, version, notaFinal, considerados, partes,
    corpoSintetizador, feedbackAluno, instrumentacao, reasoningTxt,
    // Duelo: as duas notas e o vencedor. `null` nas versões individuais — quem
    // lê distingue "não é duelo" de "deu empate".
    comparativo,
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
    chave: String(criterio.num),
    body: buildChatBody({
      provider,
      model,
      effort,
      maxTokens: V25_MAX_TOKENS,
      messages: [
        { role: 'developer', content: developer },
        { role: 'user', content: fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao) },
      ],
    }),
  }));
}

// Finaliza a partir das saídas dos nós do batch. `nodeOutputs` = [{ num, text, usage }].
// Roda o agregador, o sintetizador (síncrono, 1 chamada) e a instrumentação.
async function finalizePipeline({ openai, bloco1, log, materiais, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', version = DEFAULT_VERSION, nodeOutputs, batch = false, evaluatorId, missao = null }) {
  const assets = loadAssets(version);
  const weights = assets.criteria.map(() => 1);

  const byNum = new Map((nodeOutputs || []).map((o) => [o.num, o]));
  const results = assets.criteria.map((c) => {
    const o = byNum.get(c.num) || { text: '', usage: null };
    return { num: c.num, nome: c.nome, linhaCurta: c.linhaCurta, ...parseSaidaDoNoDaVersao(o.text, assets.cfg), usage: o.usage };
  });
  results.sort((a, b) => a.num - b.num);

  // `capturaSint: false` sempre: aqui os nós vieram da Batch API, que roda em
  // /v1/chat/completions e não devolve resumo de raciocínio. Capturar só o do
  // sintetizador daria um arquivo manco (os oito nós em branco) e ainda trocaria
  // o transporte de uma run cujo motivo de existir é medir custo.
  // As duas formas de chamada: `{ bloco1, log }` (o laboratório, que corrige um
  // log colado) e `{ materiais }` (a produção, um slot por material). O
  // normalizeMateriais aceita as duas e completa o que faltar com a frase de
  // ausência — sem isto o sintetizador do batch receberia "(sem mensagens)" no
  // lugar do log, e escreveria o feedback sobre o nada.
  return finishPipeline({
    openai, assets, results, weights, model, effort, provider, batch, evaluatorId,
    capturaSint: false, missao, materiais: normalizeMateriais(assets, { bloco1, log, materiais }),
  });
}

module.exports = {
  // Execução do pipeline
  runAvaliacaoIndependente,
  buildChatBody,
  // Versões (v34 e as duas entradas dele)
  PIPELINE_VERSIONS,
  PIPELINE_VERSIONS_IDS,
  DEFAULT_VERSION,
  SAUDACAO,
  ladosDe,
  ehComparativa,
  slotsCasoDe,
  slotsLogDe,
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
  // Slots da régua (quantidade e lista de critérios), preenchidos no loadAssets.
  SLOTS_REGUA,
  preencherSlotsDaRegua,
  // Exportados para teste
  loadAssets,
  parseCriteria,
  parseSaidaDoNoQualidades,
  parseSaidaDoNoComparativa,
  parseSaidaDoNoDaVersao,
  linhasDasQualidades,
  QUALIDADES_V34,
  PONTOS_POR_QUALIDADE,
  parseSaidaMissao,
  aggregate,
  buildAnalises,
  montarFeedback,
  buildInstrumentacao,
  resolvePrices,
  isRetryableAIError,
  retryDelayMs,
};
