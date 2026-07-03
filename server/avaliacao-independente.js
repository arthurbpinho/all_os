// Avaliação Independente — avaliadores de PROMPT ÚNICO (v16-2 e v18-25).
//
// Ferramenta de teste de pricing (supervisor/admin). ISOLADO: só LÊ os .md dos
// prompts; não altera os avaliadores de produção, a simulação nem o processo
// seletivo. O terceiro avaliador do alternador (v25) é o pipeline de 14 nós, que
// vive em avaliacao-v25.js — este módulo cobre só os dois de uma chamada.
//
// Diferença crítica entre os dois formatos de saída (por isso parsers distintos):
//   v16-2  → prosa + bloco `[notas-supervisor]` (JSON, 6 critérios 0–10) NO FIM.
//   v18-25 → bloco `[notas]` (15 linhas "N: nota|NA", 1–10) NO INÍCIO, depois
//            `[feedback]` + o corpo. `NA` nos critérios 10 e 13.
// A nota final dos dois sai do mesmo finalScoreFromCriteria (soma/(nº×10)×100),
// que já exclui NA (vira NaN → filtrado). Ver server/scoring.js.

const fs = require('fs');
const path = require('path');
const { finalScoreFromCriteria } = require('./scoring');
const { resolvePrices, buildChatBody } = require('./avaliacao-v25');

const AVALIACAO_DIR = path.join(__dirname, '..', 'avaliacao');
// TETO de tokens (reasoning oculto + saída visível) — só paga o gerado. Folga
// generosa pro v16-2, cuja prosa é longa; se curto, o modelo devolve vazio.
const SINGLE_MAX_TOKENS = Number(process.env.AVALIACAO_SINGLE_MAX_TOKENS || 64000);

// Nomes dos critérios (rótulos de tela). Fonte: os próprios .md dos avaliadores.
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

// Registry dos avaliadores do alternador. 'v25' é `kind:'pipeline'` (roda em
// avaliacao-v25.js) — aqui só declaramos o rótulo pra UI/validação.
const EVALUATORS = {
  'v16-2': { id: 'v16-2', label: 'v16.2 · 6 critérios', kind: 'single', promptFile: path.join(AVALIACAO_DIR, 'avaliador-v16-2.md'), criterios: CRIT_V162 },
  'v18-25': { id: 'v18-25', label: 'v18.25 · 15 critérios', kind: 'single', promptFile: path.join(AVALIACAO_DIR, 'avaliador 18', 'avaliador-v18-25.md'), criterios: CRIT_V1825 },
  'v25': { id: 'v25', label: 'v25 · pipeline (14 nós)', kind: 'pipeline', criterios: null },
};

function isValidEvaluator(id) {
  return Object.prototype.hasOwnProperty.call(EVALUATORS, id);
}

function loadEvaluatorPrompt(evaluatorId) {
  const ev = EVALUATORS[evaluatorId];
  if (!ev || ev.kind !== 'single') throw new Error('Avaliador inválido (single): ' + evaluatorId);
  return fs.readFileSync(ev.promptFile, 'utf8');
}

// Corpo /v1/chat/completions do avaliador de prompt único: developer = o prompt
// do avaliador (prefixo cacheável); user = Bloco 1 + log (o material). Serve para
// a chamada síncrona e para o batch (mesmo corpo).
function buildSingleEvalBody({ evaluatorId, bloco1, log, model, effort, provider = 'openai' }) {
  const prompt = loadEvaluatorPrompt(evaluatorId);
  const user = `[BLOCO 1 DO CASO] (critério de correção / gabarito)\n${bloco1 || '(sem Bloco 1)'}\n\n---\n\n[LOG DO ATENDIMENTO]\n${log}`;
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
  const notasDetalhe = notas
    ? Object.keys(notas)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => ({ num: Number(k), nome: (ev.criterios && ev.criterios[Number(k)]) || `Critério ${k}`, nota: notas[k] }))
    : [];
  return { notas, notasDetalhe, feedback, score };
}

function sumUsage(u) {
  const promptTotal = (u && u.prompt_tokens) || 0;
  const cached = (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    input: Math.max(0, promptTotal - cached),
    cached,
    output: (u && u.completion_tokens) || 0,
    reasoning: (u && u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
  };
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

// Monta o resultado unificado de um avaliador single a partir do texto + usage.
function finalizeSingle({ evaluatorId, text, usage, model, effort, batch }) {
  const { notas, notasDetalhe, feedback, score } = parseSingleEvalOutput(evaluatorId, text);
  return {
    evaluator: evaluatorId,
    notaFinal: score,
    notas,
    notasDetalhe,
    partes: null, // exclusivo do v25
    corpoSintetizador: null,
    feedbackAluno: feedback,
    instrumentacao: buildSingleInstrumentacao(model, effort, usage, batch),
  };
}

module.exports = {
  EVALUATORS,
  isValidEvaluator,
  loadEvaluatorPrompt,
  buildSingleEvalBody,
  parseSingleEvalOutput,
  buildSingleInstrumentacao,
  finalizeSingle,
  // exportados para teste:
  parseV162,
  parseV1825,
};
