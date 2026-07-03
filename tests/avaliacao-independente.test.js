// Avaliação Independente — parsers dos avaliadores (o v18-25 tem formato próprio),
// pricing dos 3 modelos, desconto de batch, e validação de allowlist no endpoint.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const ai = require('../server/avaliacao-independente');
const { resolvePrices, buildChatBody } = require('../server/avaliacao-v25');
const { finalScoreFromCriteria } = require('../server/scoring');

describe('Avaliação Independente — parsers e pricing', () => {
  it('parser v18-25: [notas]/NA/[feedback], 15 critérios, NA fora da nota', () => {
    const text = [
      '[notas]', '1: 8', '2: 7', '3: 6', '4: 7', '5: 8', '6: 6', '7: 7', '8: 7',
      '9: 7', '10: NA', '11: 6', '12: 5', '13: NA', '14: 6', '15: 7',
      '[feedback]', 'Você conduziu bem a abertura.',
    ].join('\n');
    const r = ai.parseSingleEvalOutput('v18-25', text);
    expect(r.notasDetalhe.length).toBe(15);
    expect(r.notas['10']).toBe('NA');
    expect(r.notas['13']).toBe('NA');
    expect(r.feedback).toBe('Você conduziu bem a abertura.');
    // 13 notas finitas somam 87 → round(87 / (13×10) × 100) = 67
    expect(r.score).toBe(67);
  });

  it('parser v16-2: [notas-supervisor] JSON, 6 critérios, prosa limpa', () => {
    const text = 'Boa condução geral.\n\n[notas-supervisor]\n{"1": 8, "2": 6, "3": 7, "4": 5, "5": 6, "6": 7}';
    const r = ai.parseSingleEvalOutput('v16-2', text);
    expect(r.feedback).toBe('Boa condução geral.');
    expect(r.notasDetalhe.length).toBe(6);
    // soma 39 / 60 × 100 = 65
    expect(r.score).toBe(65);
  });

  it('finalScoreFromCriteria: NA vira NaN e sai da base', () => {
    // finitas [8,6] → 14 / 20 × 100 = 70
    expect(finalScoreFromCriteria({ 1: 8, 2: 'NA', 3: 6 })).toBe(70);
  });

  it('resolvePrices resolve os 4 modelos (mini antes de 5.4; glm)', () => {
    expect(resolvePrices('gpt-5.5-2026-04-23')).toMatchObject({ input: 5, cached: 0.5, output: 30 });
    expect(resolvePrices('gpt-5.4-2026-03-05')).toMatchObject({ input: 2.5, cached: 0.25, output: 15 });
    expect(resolvePrices('gpt-5.4-mini-2026-03-17')).toMatchObject({ input: 0.75, cached: 0.075, output: 4.5 });
    expect(resolvePrices('glm-5.2')).toMatchObject({ input: 1.4, cached: 0.26, output: 4.4 });
  });

  it('extractReasoning: GLM reasoning_content; fallback reasoning e <think>', () => {
    expect(ai.extractReasoning({ reasoning_content: 'pensei nisso' })).toBe('pensei nisso');
    expect(ai.extractReasoning({ reasoning: 'r' })).toBe('r');
    expect(ai.extractReasoning({ content: 'a <think>oculto</think> b' })).toBe('oculto');
    expect(ai.extractReasoning({ content: 'só o texto visível' })).toBe('');
  });

  it('finalizeSingle: carrega reasoning e tira <think> do texto visível', () => {
    const text = '<think>não deveria aparecer</think>[notas]\n1: 8\n2: 6\n3: 7\n4: 5\n5: 6\n6: 7\n[feedback]\nOk.';
    const r = ai.finalizeSingle({ evaluatorId: 'v18-25', text, reasoning: 'raciocínio do GLM', usage: null, model: 'glm-5.2', effort: 'max', batch: false });
    expect(r.reasoning).toBe('raciocínio do GLM');
    expect(r.feedbackAluno).toBe('Ok.');
    expect(r.feedbackAluno).not.toMatch(/não deveria/);
  });

  it('Responses args (GPT): summary só fora do mini; extractResponsesReasoning', () => {
    const big = ai.buildSingleEvalResponsesArgs({ evaluatorId: 'v18-25', bloco1: 'b', log: 'l', model: 'gpt-5.4-2026-03-05', effort: 'medium' });
    expect(big.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(big.max_output_tokens).toBeGreaterThan(0);
    expect(String(big.instructions)).toMatch(/AVALIADOR/i);
    const mini = ai.buildSingleEvalResponsesArgs({ evaluatorId: 'v18-25', bloco1: 'b', log: 'l', model: 'gpt-5.4-mini-2026-03-17', effort: 'low' });
    expect(mini.reasoning).toEqual({ effort: 'low' }); // sem summary
    const reasoning = ai.extractResponsesReasoning({ output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'pensei A' }, { type: 'summary_text', text: 'pensei B' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'ignora' }] },
    ] });
    expect(reasoning).toBe('pensei A\n\npensei B');
  });

  it('buildSingleInstrumentacao aceita usage da Responses API', () => {
    const usage = { input_tokens: 40000, input_tokens_details: { cached_tokens: 30000 }, output_tokens: 5000, output_tokens_details: { reasoning_tokens: 3500 } };
    const inst = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, false);
    expect(inst.totais).toEqual({ input: 10000, cached: 30000, output: 5000, reasoning: 3500 });
    expect(inst.custo.usd).toBeCloseTo(0.1075, 6);
  });

  it('buildChatBody: GPT usa reasoning_effort/max_completion_tokens; GLM usa thinking/max_tokens', () => {
    const msgs = [{ role: 'developer', content: 's' }, { role: 'user', content: 'u' }];
    const gpt = buildChatBody({ provider: 'openai', model: 'gpt-5.4', messages: msgs, maxTokens: 16000, effort: 'medium' });
    expect(gpt.reasoning_effort).toBe('medium');
    expect(gpt.max_completion_tokens).toBe(16000);
    expect(gpt.thinking).toBeUndefined();
    const glm = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 16000, effort: 'max' });
    expect(glm.thinking).toEqual({ type: 'enabled' });
    expect(glm.reasoning_effort).toBe('max');
    expect(glm.max_tokens).toBe(16000);
    expect(glm.max_completion_tokens).toBeUndefined();
    const glmOff = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 16000, effort: 'disabled' });
    expect(glmOff.thinking).toEqual({ type: 'disabled' });
    expect(glmOff.reasoning_effort).toBeUndefined();
  });

  it('buildSingleInstrumentacao aplica 50% no batch', () => {
    const usage = {
      prompt_tokens: 1000, completion_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 500 },
    };
    const sync = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, false);
    const batch = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, true);
    expect(batch.custo.usd).toBeCloseTo(sync.custo.usd / 2, 8);
    expect(batch.custo.batch).toBe(true);
  });
});

describe('Avaliação Independente — endpoint', () => {
  beforeEach(() => resetData());

  it('valida avaliador/modelo/effort (400)', async () => {
    const t = await loginAs('prof'); // supervisor
    const base = { log: 'x', casoId: 'fp-test-1' };
    const bad1 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'nope' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'v25', model: 'bad' });
    expect(bad2.status).toBe(400);
    const bad3 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'v25', model: 'gpt-5.5', effort: 'ultra' });
    expect(bad3.status).toBe(400);
  });

  it('GLM: effort medium é inválido; batch é bloqueado', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', evaluator: 'v25', model: 'glm-5.2' };
    const effErr = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, effort: 'medium' });
    expect(effErr.status).toBe(400);
    expect(effErr.body.error).toMatch(/effort inválido/i);
    const batchErr = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, effort: 'max', batch: true });
    expect(batchErr.status).toBe(400);
    expect(batchErr.body.error).toMatch(/batch/i);
  });

  it('fila: supervisor vê (lista); aluno é barrado (403)', async () => {
    const sup = await loginAs('prof');
    const okr = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(sup));
    expect(okr.status).toBe(200);
    expect(Array.isArray(okr.body)).toBe(true);
    const aluno = await loginAs('aluno');
    const den = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(aluno));
    expect(den.status).toBe(403);
  });
});
