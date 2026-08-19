// Avaliação Independente — avaliadores de PROMPT ÚNICO (v16-2 e v18-25) +
// registry de todos os avaliadores do alternador.
//
// Ferramenta de teste de pricing (supervisor/admin). ISOLADO: só LÊ os .md dos
// prompts; não altera os avaliadores de produção, a simulação nem o processo
// seletivo. Os avaliadores de PIPELINE do alternador (v28 e v25, cada um em duas
// variantes) rodam em avaliacao-v25.js, que hospeda as duas versões — este
// módulo cobre só os dois de uma chamada e diz, no registry, qual versão e qual
// variante cada entrada do alternador usa.
//
// NOTA: o v18-25 lido aqui é o MESMO arquivo que a produção usa como avaliador
// individual (avaliacao/avaliador 18/avaliador-v18-25.md) — editar aquele .md
// muda os dois.
//
// Formato de saída do v18-25 (por isso o parser próprio): bloco `[notas]`
// (15 linhas "N: nota|NA", 1–10) NO INÍCIO, depois `[feedback]` + o corpo.
// `NA` nos critérios 10 e 13. A nota final sai de finalScoreFromCriteria
// (soma/(nº×10)×100), que já exclui NA (vira NaN → filtrado). Ver server/scoring.js.
//
// O v16-2 (6 critérios) saiu do alternador: nenhum modo de produção usa mais
// aquela grade, e o laboratório passou a comparar só as linhas vivas — v18-25,
// v25, v28 e v31. O parser dele (parseV162) fica, porque o store guarda runs
// antigas que ainda são lidas por ele.

const fs = require('fs');
const path = require('path');
const { finalScoreFromCriteria } = require('./scoring');
const { resolvePrices, buildChatBody } = require('./avaliacao-v25');
const { PROMPTS_DIR } = require('./paths');

const AVALIACAO_DIR = path.join(PROMPTS_DIR, 'avaliacao');
// TETO de tokens (reasoning oculto + saída visível) — só paga o gerado. Folga
// generosa pro v16-2, cuja prosa é longa; se curto, o modelo devolve vazio.
const SINGLE_MAX_TOKENS = Number(process.env.AVALIACAO_SINGLE_MAX_TOKENS || 64000);

// Nomes dos critérios (rótulos de tela). Fonte: os próprios .md dos avaliadores.
// O v16-2 saiu do alternador, mas o mapa fica: o store guarda runs antigas dele,
// e sem isto elas voltariam a exibir "Critério 1", "Critério 2"...
const CRIT_V162 = {
  1: 'Construção linguística das intervenções',
  2: 'Relação terapêutica',
  3: 'Confiança transmitida',
  4: 'Priorização',
  5: 'Aprofundamento',
  6: 'Flexibilidade e Criatividade',
};
const CRIT_V1825 = {
  1: 'Precisão lexical', 2: 'Construção e economia', 3: 'Modulação da intensidade clínica',
  4: 'Adequação à prontidão para mudança', 5: 'Manejo do vínculo', 6: 'Antifragilidade',
  7: 'Coerência interna', 8: 'Coerência narrativa', 9: 'Ganchos verbais', 10: 'Ganchos não-verbais',
  11: 'Profundidade vertical', 12: 'Articulação lateral', 13: 'Formulação',
  14: 'Flexibilidade', 15: 'Criatividade',
};

// Registry dos avaliadores do alternador. Os `kind:'pipeline'` rodam em
// avaliacao-v25.js — aqui só declaramos rótulo, `version` (qual trio de .md e
// quais regras de agregação) e `variant` (qual saída o nó produz).
//
// As duas entradas de uma mesma versão compartilham prompt, critérios, agregador
// e código; a única diferença é a variante do nó:
//   ...        → nó devolve ANÁLISE+NOTA+CONFIANÇA → sintetizador → feedback.
//   ...-nota   → nó devolve só a NOTA → sem sintetizador, sem feedback (barato).
//
// v31 é a versão em teste (travas respondidas uma a uma, análise depois delas,
// sem confiança, etiqueta escrita por código); v28 e v25 ficam no alternador
// para rodar o MESMO log e comparar nota, feedback e custo. Nenhuma delas é
// usada por modo de produção — a produção segue no avaliador de sempre.
const EVALUATORS = {
  'v18-25': { id: 'v18-25', label: 'v18.25 · 15 critérios', kind: 'single', promptFile: path.join(AVALIACAO_DIR, 'avaliador 18', 'avaliador-v18-25.md'), criterios: CRIT_V1825 },
  // v32: o nó vira duas chamadas (perguntas sem régua → código deriva a faixa →
  // régua + faixa decidem a realização). 30 chamadas por avaliação, não 15.
  'v32': { id: 'v32', label: 'v32 · pipeline (15 nós × 2 fases)', kind: 'pipeline', version: 'v32', variant: null, criterios: null },
  // v31 não tem variante: o .md não traz blocos @variante, e a saída é uma só.
  'v31': { id: 'v31', label: 'v31 · pipeline (15 nós)', kind: 'pipeline', version: 'v31', variant: null, criterios: null },
  'v28': { id: 'v28', label: 'v28 · pipeline (15 nós) · com feedback', kind: 'pipeline', version: 'v28', variant: 'com-feedback', criterios: null },
  'v28-nota': { id: 'v28-nota', label: 'v28 · pipeline (15 nós) · só nota', kind: 'pipeline', version: 'v28', variant: 'so-nota', criterios: null },
  'v25': { id: 'v25', label: 'v25 · pipeline (14 nós) · com feedback', kind: 'pipeline', version: 'v25', variant: 'com-feedback', criterios: null },
  'v25-nota': { id: 'v25-nota', label: 'v25 · pipeline (14 nós) · só nota', kind: 'pipeline', version: 'v25', variant: 'so-nota', criterios: null },
};

function isValidEvaluator(id) {
  return Object.prototype.hasOwnProperty.call(EVALUATORS, id);
}

// true para os avaliadores que rodam o pipeline multi-nó (v28/v25, em qualquer
// variante). Use isto em vez de comparar com a string 'v25'.
function isPipeline(id) {
  const ev = EVALUATORS[id];
  return !!ev && ev.kind === 'pipeline';
}

// Variante do nó para um avaliador do registry (null se não for pipeline).
function variantFor(id) {
  const ev = EVALUATORS[id];
  return ev && ev.kind === 'pipeline' ? ev.variant : null;
}

// Versão do pipeline ('v28' | 'v25') de um avaliador do registry — é ela que
// decide o trio de .md e a regra de agregação (null se não for pipeline).
function versionFor(id) {
  const ev = EVALUATORS[id];
  return ev && ev.kind === 'pipeline' ? ev.version : null;
}

function loadEvaluatorPrompt(evaluatorId) {
  const ev = EVALUATORS[evaluatorId];
  if (!ev || ev.kind !== 'single') throw new Error('Avaliador inválido (single): ' + evaluatorId);
  return fs.readFileSync(ev.promptFile, 'utf8');
}

// Corpo /v1/chat/completions do avaliador de prompt único: developer = o prompt
// do avaliador (prefixo cacheável); user = Bloco 1 + log (o material). Serve para
// a chamada síncrona e para o batch (mesmo corpo).
// Partes do input single: o prompt do avaliador (prefixo cacheável) + a mensagem
// do usuário (Bloco 1 + log). Reusado pelo corpo chat.completions e pela Responses.
function singleEvalParts({ evaluatorId, bloco1, log }) {
  const prompt = loadEvaluatorPrompt(evaluatorId);
  const user = `[BLOCO 1 DO CASO] (critério de correção / gabarito)\n${bloco1 || '(sem Bloco 1)'}\n\n---\n\n[LOG DO ATENDIMENTO]\n${log}`;
  return { prompt, user };
}

// Corpo /chat/completions (GLM usa este — devolve reasoning_content; e o batch).
function buildSingleEvalBody({ evaluatorId, bloco1, log, model, effort, provider = 'openai' }) {
  const { prompt, user } = singleEvalParts({ evaluatorId, bloco1, log });
  return buildChatBody({
    provider,
    model,
    maxTokens: SINGLE_MAX_TOKENS,
    effort,
    messages: [
      { role: 'developer', content: prompt },
      { role: 'user', content: user },
    ],
  });
}

// Args da Responses API (GPT síncrono usa este pra pegar o RESUMO do raciocínio).
// `summary:'auto'` só nos modelos que suportam — o mini não emite resumo, então
// mandamos só o effort (senão a chamada falha).
function buildSingleEvalResponsesArgs({ evaluatorId, bloco1, log, model, effort }) {
  const { prompt, user } = singleEvalParts({ evaluatorId, bloco1, log });
  const reasoning = /mini/i.test(String(model)) ? { effort } : { effort, summary: 'auto' };
  return {
    model,
    reasoning,
    max_output_tokens: SINGLE_MAX_TOKENS,
    instructions: prompt,
    input: [{ role: 'user', content: user }],
  };
}

// Extrai o RESUMO do raciocínio da saída da Responses API (itens type:'reasoning'
// com `summary:[{text}]`). A OpenAI só expõe o resumo, não a cadeia bruta.
function extractResponsesReasoning(resp) {
  const out = (resp && resp.output) || [];
  const parts = [];
  for (const item of out) {
    if (item && item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s && typeof s.text === 'string' && s.text.trim()) parts.push(s.text.trim());
      }
    }
  }
  return parts.join('\n\n').trim();
}

// v16-2: prosa + `[notas-supervisor]` + JSON, no fim. Retorna { notas, feedback }.
function parseV162(text) {
  const t = String(text || '');
  const m = t.match(/\n*(?:-{3,}[^\S\n]*\r?\n+)?\[notas-supervisor\][^\S\n]*\r?\n?([\s\S]*)$/i);
  if (!m) return { notas: null, feedback: t.trim() };
  const feedback = t.slice(0, m.index).replace(/\s+$/, '');
  let payload = (m[1] || '').trim().replace(/^```[a-z]*[ \t]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '').trim();
  let notas = null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      notas = {};
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(String(v).replace(',', '.'));
        if (Number.isFinite(n)) notas[String(k)] = n;
      }
    }
  } catch {}
  return { notas: notas && Object.keys(notas).length ? notas : null, feedback };
}

// v18-25: `[notas]` (linhas "N: nota|NA") no início, depois `[feedback]` + corpo.
// `NA` é preservado como string 'NA' (aparece na tela; finalScoreFromCriteria o
// exclui). Retorna { notas, feedback }.
function parseV1825(text) {
  const t = String(text || '');
  const notasBlock = t.match(/\[notas\]([\s\S]*?)(?:\n\s*\[feedback\]|$)/i);
  const notas = {};
  if (notasBlock) {
    for (const line of notasBlock[1].split(/\r?\n/)) {
      const lm = line.match(/^\s*(\d{1,2})\s*:\s*(NA|[-+]?\d+(?:[.,]\d+)?)\s*$/i);
      if (!lm) continue;
      notas[lm[1]] = /^na$/i.test(lm[2]) ? 'NA' : Number(lm[2].replace(',', '.'));
    }
  }
  const fb = t.match(/\[feedback\]\s*([\s\S]*)$/i);
  const feedback = fb ? fb[1].trim() : (notasBlock ? '' : t.trim());
  return { notas: Object.keys(notas).length ? notas : null, feedback };
}

// Parseia a saída de um avaliador single → { notas, notasDetalhe, feedback, score }.
function parseSingleEvalOutput(evaluatorId, text) {
  const ev = EVALUATORS[evaluatorId] || {};
  const { notas, feedback } = evaluatorId === 'v16-2' ? parseV162(text) : parseV1825(text);
  const score = finalScoreFromCriteria(notas);
  // Fallback do v16-2: fora do registry, mas as runs guardadas ainda se leem.
  const nomes = ev.criterios || (evaluatorId === 'v16-2' ? CRIT_V162 : null);
  const notasDetalhe = notas
    ? Object.keys(notas)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => ({ num: Number(k), nome: (nomes && nomes[Number(k)]) || `Critério ${k}`, nota: notas[k] }))
    : [];
  return { notas, notasDetalhe, feedback, score };
}

// Aceita os dois formatos de usage: chat.completions (prompt_tokens/completion_tokens)
// e Responses API (input_tokens/output_tokens). GLM segue o chat.completions.
// GOTCHA GLM (z.ai): o effort max gera muito thinking, mas o `usage` do GLM não
// tem campo de reasoning e, ao que tudo indica, o `completion_tokens` sub-reporta
// o thinking — o billing real fica maior. Usamos `total_tokens - prompt_tokens`
// como PISO da saída (recupera o thinking quando ele está no total mas não no
// completion). Se ainda ficar abaixo do billing, é porque a z.ai não devolve o
// thinking nem no total — aí não dá pra calcular exato pelo usage.
function sumUsage(u) {
  if (!u) return { input: 0, cached: 0, output: 0, reasoning: 0 };
  const promptTotal = u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0);
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
    || (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  const completion = u.completion_tokens != null ? u.completion_tokens : (u.output_tokens || 0);
  const total = u.total_tokens != null ? u.total_tokens
    : (u.input_tokens != null && u.output_tokens != null ? u.input_tokens + u.output_tokens : 0);
  const output = Math.max(completion, total > promptTotal ? total - promptTotal : 0);
  const reasoning = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens)
    || (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0;
  return { input: Math.max(0, promptTotal - cached), cached, output, reasoning };
}

// Instrumentação de custo de UMA chamada (avaliador single). `batch` aplica 50%.
function buildSingleInstrumentacao(model, effort, usage, batch) {
  const totais = sumUsage(usage);
  const prices = resolvePrices(model);
  let custo = null;
  if (prices) {
    const f = batch ? 0.5 : 1;
    const usd = ((totais.input * prices.input + totais.cached * prices.cached + totais.output * prices.output) / 1e6) * f;
    custo = {
      usd,
      moeda: 'USD',
      precosPorMTok: prices,
      componentes: {
        input: (totais.input * prices.input / 1e6) * f,
        cached: (totais.cached * prices.cached / 1e6) * f,
        output: (totais.output * prices.output / 1e6) * f,
      },
      batch: !!batch,
    };
  }
  return { model, effort, totais, custo, batch: !!batch };
}

// Raciocínio "gasto" que o supervisor lê (v16-2/v18-25 raciocinam no canal oculto
// e a análise por critério vive lá). A z.ai/GLM devolve em `message.reasoning_content`
// (com thinking ligado). A OpenAI via chat.completions NÃO devolve o texto (só a
// contagem de reasoning tokens) — aí volta vazio e a UI avisa. Fallback: extrai de
// <think>…</think> se vier embutido no content.
function extractReasoning(message) {
  const m = message || {};
  const rc = m.reasoning_content || m.reasoning || '';
  if (rc && String(rc).trim()) return String(rc).trim();
  const c = typeof m.content === 'string' ? m.content : '';
  const tag = c.match(/<think>([\s\S]*?)<\/think>/i);
  return tag ? tag[1].trim() : '';
}

// Remove <think>…</think> do texto visível (caso o provedor embuta no content).
function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Monta o resultado unificado de um avaliador single a partir do texto + usage +
// (opcional) reasoning do supervisor.
function finalizeSingle({ evaluatorId, text, usage, model, effort, batch, reasoning }) {
  const { notas, notasDetalhe, feedback, score } = parseSingleEvalOutput(evaluatorId, stripThink(text));
  return {
    evaluator: evaluatorId,
    notaFinal: score,
    notas,
    notasDetalhe,
    partes: null, // exclusivo do v25
    corpoSintetizador: null,
    feedbackAluno: feedback,
    reasoning: reasoning || '', // raciocínio visível ao supervisor (GLM devolve; GPT chat.completions não)
    instrumentacao: buildSingleInstrumentacao(model, effort, usage, batch),
  };
}

module.exports = {
  EVALUATORS,
  isValidEvaluator,
  isPipeline,
  variantFor,
  versionFor,
  loadEvaluatorPrompt,
  buildSingleEvalBody,
  buildSingleEvalResponsesArgs,
  extractResponsesReasoning,
  parseSingleEvalOutput,
  buildSingleInstrumentacao,
  finalizeSingle,
  extractReasoning,
  // exportados para teste:
  parseV162,
  parseV1825,
};
