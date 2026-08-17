// Avaliação Independente v25 (AvaliAllos) — TESTE, isolado do avaliador v16.2.
//
// Roda em GPT-5.x (OpenAI, mesma OPENAI_API_KEY do resto; modelo por env
// AVALIACAO_V25_MODEL, hoje gpt-5.4-mini-2026-03-17). Os demais avaliadores
// (Treino/Competitivo/Duelo/Neuro/Trilha) NÃO são tocados por este arquivo.
//
// Pipeline completo (ver avaliacao/nova avaliacao/brief-pipeline-v25-completo.md):
//   1) 14 nós GPT em paralelo, um por critério. Cada nó vê só o seu critério +
//      o Bloco 1 + o log, e devolve ANÁLISE / NOTA / CONFIANÇA.
//   2) Agregador determinístico (código): exclui os de confiança baixa, aplica
//      pesos (iguais por enquanto) e normaliza a média(1–10) para 0–100.
//   3) Sintetizador (1 chamada): recebe só o log + as análises em prosa (sem
//      números, sem Bloco 1) e devolve o corpo do feedback do aluno.
//   4) Montagem final (código): cola "Nota: X/100" + saudação fixa + corpo.
//
// Duas VARIANTES do nó (ver V25_VARIANTS), escolhidas no alternador da tela:
//   com-feedback → o nó devolve ANÁLISE + NOTA + CONFIANÇA (pipeline completo,
//                  com sintetizador e feedback do aluno);
//   so-nota      → o nó devolve só a NOTA (sem análise, o passo 3 é pulado e não
//                  há feedback do aluno; nota final e partes saem iguais). Roda
//                  mais barato — some o texto por critério do billing.
// As duas moram no MESMO prompt-no-v25-montado.md, em blocos `@variante`.
//
// Prompt caching: a OpenAI cacheia o maior prefixo comum automaticamente
// (>~1024 tokens, sem marcação manual). Por isso o bloco estático + o caso vão
// na mensagem `developer` (o prefixo), e só o critério/as análises na `user` (o
// que varia). Os 13 nós seguintes leem A+B do cache. Roda 1 nó primeiro pra
// semear o cache, depois os outros 13 em paralelo (igual à versão anterior).
//
// Os prompts (nó + sintetizador) e os 14 critérios vêm dos .md em
// avaliacao/nova avaliacao/ — fonte única da verdade; editar o .md muda o
// comportamento. Instrumentação de tokens/custo embutida para o teste de pricing.

const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR } = require('./paths');

const DIR = path.join(PROMPTS_DIR, 'avaliacao', 'nova avaliacao');

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

// Saudação fixa colada por código no topo do feedback do aluno (o modelo não a
// gera nem a varia — ver brief, "Montagem final").
const SAUDACAO_FIXA = `Trate este feedback como pré-correção, um ponto de partida para a conversa com seu supervisor e colegas, não um veredito.

Eu só tenho acesso ao que você escreveu, não ao que você pensou. Quando o raciocínio por trás de uma fala importar, descreva-o no botão de estrela. Isso me ajuda a separar uma decisão clínica consciente de um erro por falta de percepção.`;

// Variantes de saída do NÓ, marcadas no próprio prompt-no-v25-montado.md com
// blocos `<!-- @variante:X -->…<!-- /@variante -->`:
//   com-feedback → ANÁLISE + NOTA + CONFIANÇA (o pipeline inteiro: agregador +
//                  sintetizador + feedback do aluno);
//   so-nota      → só a NOTA (sem análise ⇒ sem sintetizador ⇒ sem feedback do
//                  aluno; nota final e partes seguem iguais). Mais barato: o
//                  texto por critério some do billing, o reasoning fica.
// O resto do prompt é compartilhado — editar fora dos blocos muda as duas.
const V25_VARIANTS = ['com-feedback', 'so-nota'];
const V25_DEFAULT_VARIANT = 'com-feedback';

function isValidVariant(v) {
  return V25_VARIANTS.includes(v);
}

// Mantém os blocos da variante escolhida e apaga os das outras. Se o arquivo não
// tiver marcador nenhum (versão antiga do .md, ainda no volume de produção),
// falha em vez de rodar silenciosamente a variante errada.
function selectVariant(text, variant) {
  const re = /[ \t]*<!--\s*@variante:([a-z0-9-]+)\s*-->\r?\n?([\s\S]*?)[ \t]*<!--\s*\/@variante\s*-->\r?\n?/g;
  let found = false;
  const out = String(text).replace(re, (_m, v, inner) => {
    found = true;
    return v === variant ? inner : '';
  });
  if (!found) {
    throw new Error(`prompt-no-v25-montado.md sem os blocos <!-- @variante:… --> (variante "${variant}"). Atualize o .md pelo painel de prompts (Administração → Prompts).`);
  }
  return out;
}

// Fatia o prompt do nó nos três blocos (A estático, B do caso, C do nó), pelos
// comentários de CACHE BREAKPOINT, já com a variante escolhida aplicada. PURO
// (recebe o texto, não lê disco) para o editor de prompts poder validar um
// rascunho com exatamente o mesmo parser que a produção usa.
function parseMontado(raw, variant = V25_DEFAULT_VARIANT) {
  if (!isValidVariant(variant)) throw new Error('Variante v25 inválida: ' + variant);
  const montado = selectVariant(raw, variant);

  const start = montado.indexOf('## [METACOMANDO]');
  const bpA = montado.indexOf('<!-- ===== CACHE BREAKPOINT A');
  const bpB = montado.indexOf('<!-- ===== CACHE BREAKPOINT B');
  if (start === -1 || bpA === -1 || bpB === -1) {
    throw new Error('prompt-no-v25-montado.md sem os marcadores esperados (METACOMANDO / BREAKPOINT A / BREAKPOINT B).');
  }
  const bpAEnd = montado.indexOf('-->', bpA) + 3;
  const bpBEnd = montado.indexOf('-->', bpB) + 3;

  const blockA = montado.slice(start, bpA).trim();          // estático
  const blockB = montado.slice(bpAEnd, bpB).trim();          // {{BLOCO_1}} + {{LOG}}
  const blockC = montado.slice(bpBEnd).trim();               // {{CRITÉRIO}}

  for (const [name, blk, slot] of [['B', blockB, '{{BLOCO_1}}'], ['B', blockB, '{{LOG}}'], ['C', blockC, '{{CRITÉRIO}}']]) {
    if (!blk.includes(slot)) throw new Error(`Bloco ${name} do prompt v25 não contém o slot ${slot}.`);
  }
  return { blockA, blockB, blockC };
}

// Sintetizador: bloco estático (do METACOMANDO até o breakpoint) vira o
// `developer` cacheável; o resto ({{LOG}} + {{ANALISES}} + tarefa) vira `user`.
// Puro, pelo mesmo motivo do parseMontado.
function parseSintetizador(sint) {
  const sStart = sint.indexOf('## [METACOMANDO]');
  const sBp = sint.indexOf('<!-- CACHE BREAKPOINT');
  if (sStart === -1 || sBp === -1) {
    throw new Error('sintetizador-v25.md sem os marcadores esperados (METACOMANDO / CACHE BREAKPOINT).');
  }
  const sBpEnd = sint.indexOf('-->', sBp) + 3;
  const synthStatic = sint.slice(sStart, sBp).trim();
  const synthVariable = sint.slice(sBpEnd).trim();
  for (const slot of ['{{LOG}}', '{{ANALISES}}']) {
    if (!synthVariable.includes(slot)) throw new Error(`Sintetizador v25 não contém o slot ${slot}.`);
  }
  return { synthStatic, synthVariable };
}

const _assetsByVariant = new Map();

// Esquece os prompts memoizados. Chamado quando um .md do v25 é salvo ou
// restaurado pelo editor de prompts — sem isto o servidor seguiria servindo a
// versão antiga até o próximo restart.
function clearAssetsCache() {
  _assetsByVariant.clear();
}

// Lê os .md do volume e devolve os blocos + os 14 critérios. Memoizado por
// variante (invalidado por clearAssetsCache).
function loadAssets(variant = V25_DEFAULT_VARIANT) {
  if (!isValidVariant(variant)) throw new Error('Variante v25 inválida: ' + variant);
  if (_assetsByVariant.has(variant)) return _assetsByVariant.get(variant);

  const { blockA, blockB, blockC } = parseMontado(fs.readFileSync(path.join(DIR, 'prompt-no-v25-montado.md'), 'utf8'), variant);

  const criteria = parseCriteria(fs.readFileSync(path.join(DIR, 'criterios-no-v25.md'), 'utf8'));
  if (criteria.length !== 14) {
    throw new Error(`Esperava 14 critérios em criterios-no-v25.md, encontrei ${criteria.length}.`);
  }

  const { synthStatic, synthVariable } = parseSintetizador(fs.readFileSync(path.join(DIR, 'sintetizador-v25.md'), 'utf8'));

  const assets = { variant, blockA, blockB, blockC, criteria, synthStatic, synthVariable };
  _assetsByVariant.set(variant, assets);
  return assets;
}

// Extrai, de criterios-no-v25.md: a descrição completa de cada critério (o bloco
// inteiro daquele número, que vai no slot {{CRITÉRIO}}) e o nome + linha curta
// (rótulos para a tela do supervisor).
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

  const out = [];
  for (let i = 1; i <= 14; i++) {
    if (descs[i] && shorts[i]) {
      out.push({ num: i, nome: shorts[i].nome, linhaCurta: shorts[i].linhaCurta, descricao: descs[i] });
    }
  }
  return out;
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
// ~input + 16k ≈ 20k tokens. Num tier de 200k TPM cabem ~10 nós por minuto —
// os 13 do fan-out de uma vez pedem ~270k e tomam 429 na cara ("Limit 200000,
// Used 200000"). Em lotes de 4 a run inteira fica dentro do teto. Não custa
// tempo de parede proporcional: o gargalo já era o rate limit, não o paralelismo
// (e a run é um job em background, sem timeout de HTTP para respeitar).
const OPENAI_V25_CONCURRENCY = Number(process.env.AVALIACAO_V25_CONCURRENCY || 4);

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
async function gptComplete(openai, developer, user, maxTokens, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', rotulo = 'chamada') {
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
  return { text: resp.choices && resp.choices[0] && resp.choices[0].message ? resp.choices[0].message.content || '' : '', usage: resp.usage || null };
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

async function runNode(openai, assets, bloco1, log, criterio, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai') {
  // developer = A (estático) + B (Bloco 1 + log) → idêntico nos 14 nós deste caso
  // (logo, cacheado). user = C com o critério → o que varia por nó.
  const developer = assets.blockA + '\n\n' + fill(fill(assets.blockB, '{{BLOCO_1}}', bloco1), '{{LOG}}', log);
  const user = fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao);
  const { text, usage } = await gptComplete(openai, developer, user, V25_MAX_TOKENS, model, effort, provider, `nó ${criterio.num}`);
  const parsed = parseNodeOutput(text);
  return {
    num: criterio.num,
    nome: criterio.nome,
    linhaCurta: criterio.linhaCurta,
    ...parsed,
    usage,
  };
}

// Agregador determinístico. Pesos iguais por enquanto (parametrizáveis). Exclui
// os critérios de confiança `baixa`. Normaliza a média (1–10) para 0–100.
function aggregate(results, weights) {
  let ws = 0;
  let wt = 0;
  results.forEach((r, i) => {
    if (r.confianca !== 'baixa' && Number.isFinite(r.nota)) {
      const w = weights[i] != null ? weights[i] : 1;
      ws += r.nota * w;
      wt += w;
    }
  });
  if (!wt) return { notaFinal: null, media: null, considerados: 0 };
  const media = ws / wt;
  return { notaFinal: Math.round(media * 10), media, considerados: wt };
}

// Monta o bloco {{ANALISES}} do sintetizador: para cada critério NÃO-`baixa`, na
// ordem dos critérios, cabeçalho (nº + nome) + linha curta + a prosa do nó. Sem
// NOTA nem CONFIANÇA (a valência já vem na 1ª palavra da prosa). Vazio se nenhum.
function buildAnalises(results) {
  const blocks = results
    .filter((r) => r.confianca !== 'baixa' && r.analise)
    .sort((a, b) => a.num - b.num)
    .map((r) => `## ${r.num} · ${r.nome}\n${r.linhaCurta}\n${r.analise}`);
  return blocks.join('\n\n');
}

// Sintetizador: 1 chamada. developer = bloco estático (cacheável entre
// avaliações); user = log + análises. Devolve só o corpo (sem nota, sem saudação).
async function runSynthesizer(openai, assets, log, analises, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai') {
  const user = fill(fill(assets.synthVariable, '{{LOG}}', log), '{{ANALISES}}', analises);
  const { text, usage } = await gptComplete(openai, assets.synthStatic, user, V25_SYNTH_MAX_TOKENS, model, effort, provider, 'sintetizador');
  return { corpo: (text || '').trim(), usage };
}

// Montagem final (código): nota + saudação fixa + corpo do sintetizador.
function montarFeedback(notaFinal, corpo) {
  return `Nota: ${notaFinal}/100\n\n${SAUDACAO_FIXA}\n\n${corpo}`;
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

// Executa o pipeline completo: 14 nós → agregador → sintetizador → montagem.
// Semeia o cache rodando 1 nó primeiro (escreve A+B no cache da OpenAI), depois
// os outros 13 em lotes (ver OPENAI_V25_CONCURRENCY / GLM_V25_CONCURRENCY) —
// assim o prefixo A+B (com o log) é cobrado cheio uma vez e lido barato pelos
// demais. O sintetizador roda por último.
async function runAvaliacaoIndependente({ openai, bloco1, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', variant = V25_DEFAULT_VARIANT }) {
  const assets = loadAssets(variant);
  const { criteria } = assets;
  const weights = criteria.map(() => 1);

  const first = await runNode(openai, assets, bloco1, log, criteria[0], model, effort, provider);
  // Fan-out em lotes nos DOIS provedores: GLM tem rate limit apertado em conta
  // nova, e na OpenAI os 13 de uma vez estouram o TPM (cada nó reserva ~20k
  // tokens; ver OPENAI_V25_CONCURRENCY).
  const conc = provider === 'glm' ? GLM_V25_CONCURRENCY : OPENAI_V25_CONCURRENCY;
  const rest = await mapLimit(criteria.slice(1), conc, (c) => runNode(openai, assets, bloco1, log, c, model, effort, provider));
  const results = [first, ...rest].sort((a, b) => a.num - b.num);

  const { notaFinal, considerados } = aggregate(results, weights);

  const partes = results.map((r) => ({
    num: r.num,
    nome: r.nome,
    linhaCurta: r.linhaCurta,
    analise: r.analise,
    nota: r.nota,
    confianca: r.confianca,
    // `baixa` (ou sem nota) aparece na tela mas não entra na conta final.
    incluido: r.confianca !== 'baixa' && Number.isFinite(r.nota),
  }));

  // Sintetizador + feedback do aluno só fazem sentido com pelo menos um critério
  // avaliável. Caso degenerado (tudo `baixa` → "não avaliável"): só o supervisor
  // vê as partes; não há feedback de aluno a montar.
  const analises = buildAnalises(results);
  let corpoSintetizador = null;
  let feedbackAluno = null;
  let synthUsage = null;
  if (notaFinal != null && analises) {
    const synth = await runSynthesizer(openai, assets, log, analises, model, effort, provider);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    feedbackAluno = montarFeedback(notaFinal, corpoSintetizador);
  }

  const instrumentacao = buildInstrumentacao(model, results, synthUsage, effort, false);

  return { evaluator: 'v25', variant, notaFinal, considerados, partes, corpoSintetizador, feedbackAluno, instrumentacao };
}

// --- Suporte a BATCH API (14 nós num lote; sintetizador roda síncrono no coletor) ---

// Corpos /v1/chat/completions dos 14 nós (mesmo developer cacheável + user do
// critério). O caller monta o custom_id (ex.: `${jobId}::${num}`) e o JSONL.
function buildV25NodeRequests({ bloco1, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', variant = V25_DEFAULT_VARIANT }) {
  const assets = loadAssets(variant);
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
async function finalizeV25({ openai, log, model = V25_MODEL, effort = V25_EFFORT, provider = 'openai', variant = V25_DEFAULT_VARIANT, nodeOutputs, batch = false }) {
  const assets = loadAssets(variant);
  const weights = assets.criteria.map(() => 1);
  const byNum = new Map((nodeOutputs || []).map((o) => [o.num, o]));
  const results = assets.criteria
    .map((c) => {
      const o = byNum.get(c.num) || { text: '', usage: null };
      return { num: c.num, nome: c.nome, linhaCurta: c.linhaCurta, ...parseNodeOutput(o.text), usage: o.usage };
    })
    .sort((a, b) => a.num - b.num);

  const { notaFinal, considerados } = aggregate(results, weights);
  const partes = results.map((r) => ({
    num: r.num, nome: r.nome, linhaCurta: r.linhaCurta, analise: r.analise,
    nota: r.nota, confianca: r.confianca,
    incluido: r.confianca !== 'baixa' && Number.isFinite(r.nota),
  }));

  const analises = buildAnalises(results);
  let corpoSintetizador = null;
  let feedbackAluno = null;
  let synthUsage = null;
  if (notaFinal != null && analises) {
    const synth = await runSynthesizer(openai, assets, log, analises, model, effort, provider);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    feedbackAluno = montarFeedback(notaFinal, corpoSintetizador);
  }

  const instrumentacao = buildInstrumentacao(model, results, synthUsage, effort, batch);
  return { evaluator: 'v25', variant, notaFinal, considerados, partes, corpoSintetizador, feedbackAluno, instrumentacao };
}

module.exports = {
  runAvaliacaoIndependente,
  buildChatBody,
  V25_VARIANTS,
  V25_DEFAULT_VARIANT,
  isValidVariant,
  selectVariant,
  // Batch API (Avaliação Independente):
  buildV25NodeRequests,
  finalizeV25,
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
