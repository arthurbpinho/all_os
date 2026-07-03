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

const DIR = path.join(__dirname, '..', 'avaliacao', 'nova avaliacao');

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
const V25_PRICES = {
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
};

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

let _assets = null;

// Lê e fatia o prompt montado nos três blocos (A estático, B do caso, C do nó),
// usando os comentários de CACHE BREAKPOINT como divisores, e parseia os 14
// critérios. Memoizado.
function loadAssets() {
  if (_assets) return _assets;

  const montado = fs.readFileSync(path.join(DIR, 'prompt-no-v25-montado.md'), 'utf8');
  const criteriosRaw = fs.readFileSync(path.join(DIR, 'criterios-no-v25.md'), 'utf8');

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

  const criteria = parseCriteria(criteriosRaw);
  if (criteria.length !== 14) {
    throw new Error(`Esperava 14 critérios em criterios-no-v25.md, encontrei ${criteria.length}.`);
  }

  // Sintetizador: bloco estático (do METACOMANDO até o breakpoint) vira o
  // `developer` cacheável; o resto ({{LOG}} + {{ANALISES}} + tarefa) vira `user`.
  const sint = fs.readFileSync(path.join(DIR, 'sintetizador-v25.md'), 'utf8');
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

  _assets = { blockA, blockB, blockC, criteria, synthStatic, synthVariable };
  return _assets;
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

// Chamada não-streaming ao GPT (reasoning model). `developer` = prefixo
// estático/do-caso (cacheado automaticamente pela OpenAI); `user` = a parte que
// varia. Sem cache_control manual — não existe na OpenAI.
async function gptComplete(openai, developer, user, maxTokens) {
  const resp = await openai.chat.completions.create({
    model: V25_MODEL,
    reasoning_effort: V25_EFFORT,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'developer', content: developer },
      { role: 'user', content: user },
    ],
  });
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

async function runNode(openai, assets, bloco1, log, criterio) {
  // developer = A (estático) + B (Bloco 1 + log) → idêntico nos 14 nós deste caso
  // (logo, cacheado). user = C com o critério → o que varia por nó.
  const developer = assets.blockA + '\n\n' + fill(fill(assets.blockB, '{{BLOCO_1}}', bloco1), '{{LOG}}', log);
  const user = fill(assets.blockC, '{{CRITÉRIO}}', criterio.descricao);
  const { text, usage } = await gptComplete(openai, developer, user, V25_MAX_TOKENS);
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
async function runSynthesizer(openai, assets, log, analises) {
  const user = fill(fill(assets.synthVariable, '{{LOG}}', log), '{{ANALISES}}', analises);
  const { text, usage } = await gptComplete(openai, assets.synthStatic, user, V25_SYNTH_MAX_TOKENS);
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
function buildInstrumentacao(model, nodeResults, synthUsage) {
  const totais = { input: 0, cached: 0, output: 0, reasoning: 0 };
  const add = (u) => {
    const promptTotal = (u && u.prompt_tokens) || 0;
    const cached = (u && u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
    totais.input += Math.max(0, promptTotal - cached);
    totais.cached += cached;
    totais.output += (u && u.completion_tokens) || 0;
    totais.reasoning += (u && u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
  };
  nodeResults.forEach((r) => add(r.usage));
  if (synthUsage) add(synthUsage);

  // Custo exato = input-fresco + cache + saída (tudo por MTok). `null` se o modelo
  // não tiver preço conhecido — aí a UI mostra só os tokens.
  const prices = resolvePrices(model);
  let custo = null;
  if (prices) {
    const usd =
      (totais.input * prices.input +
        totais.cached * prices.cached +
        totais.output * prices.output) / 1e6;
    // Decomposição por componente, útil pra ver onde o dinheiro vai.
    const comp = {
      input: (totais.input * prices.input) / 1e6,
      cached: (totais.cached * prices.cached) / 1e6,
      output: (totais.output * prices.output) / 1e6,
    };
    custo = { usd, moeda: 'USD', precosPorMTok: prices, componentes: comp };
  }

  return { model, effort: V25_EFFORT, totais, custo };
}

// Executa o pipeline completo: 14 nós → agregador → sintetizador → montagem.
// Semeia o cache rodando 1 nó primeiro (escreve A+B no cache da OpenAI), depois
// os outros 13 em paralelo — assim o prefixo A+B (com o log) é cobrado cheio uma
// vez e lido barato pelos demais. O sintetizador roda por último.
async function runAvaliacaoIndependente({ openai, bloco1, log }) {
  const assets = loadAssets();
  const { criteria } = assets;
  const weights = criteria.map(() => 1);

  const first = await runNode(openai, assets, bloco1, log, criteria[0]);
  const rest = await Promise.all(
    criteria.slice(1).map((c) => runNode(openai, assets, bloco1, log, c)),
  );
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
    const synth = await runSynthesizer(openai, assets, log, analises);
    corpoSintetizador = synth.corpo;
    synthUsage = synth.usage;
    feedbackAluno = montarFeedback(notaFinal, corpoSintetizador);
  }

  const instrumentacao = buildInstrumentacao(V25_MODEL, results, synthUsage);

  return { notaFinal, considerados, partes, corpoSintetizador, feedbackAluno, instrumentacao };
}

module.exports = {
  runAvaliacaoIndependente,
  // exportados para teste:
  loadAssets,
  parseCriteria,
  parseNodeOutput,
  aggregate,
  buildAnalises,
  montarFeedback,
  buildInstrumentacao,
  resolvePrices,
};
