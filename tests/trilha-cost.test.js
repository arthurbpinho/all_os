// Custo dos Logs da Trilha — POST /api/logs deve calcular o custo real (chat +
// avaliador + esquema visual) a partir do usage acumulado que o cliente manda,
// resolvendo o MODELO sempre a partir do exercício salvo (nunca confia no
// cliente pra isso). Preços vêm de TRILHA_COST_PRICES (server/index.js).

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

// gpt-5.4-mini: {input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 4.5} por 1M tokens.
const GPT_MINI_ID = 'gpt-5.4-mini-2026-03-17';

function usdMini({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  return (input * 0.75 + cacheRead * 0.075 + cacheWrite * 0.75 + output * 4.5) / 1e6;
}

describe('Custo dos Logs da Trilha (/api/logs)', () => {
  beforeEach(() => resetData());

  it('exercício sem avaliador/esquema: só cost.chat, modelo resolvido do exercício (não do cliente)', async () => {
    const token = await loginAs('aluno');
    const usage = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 };
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: 'ex-test-2', itemTitle: 'Exercise sem evaluator', skillId: 2,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage: usage,
      // "trapaça": manda um modelo mentiroso — o servidor deve IGNORAR e
      // resolver o modelo real do exercício (que não tem chatModel setado,
      // então cai no default gpt-5.4-mini).
      chatModel: 'claude-sonnet-5',
    });
    expect(res.status).toBe(200);
    const log = res.body;
    expect(log.cost).toBeTruthy();
    expect(log.cost.chat.model).toBe(GPT_MINI_ID);
    expect(log.cost.chat.usd).toBeCloseTo(usdMini(usage), 10);
    expect(log.cost.evaluator).toBeUndefined();
    expect(log.cost.imageSchema).toBeUndefined();
    expect(log.cost.totalUsd).toBeCloseTo(usdMini(usage), 10);
  });

  it('exercício com avaliador: soma chat + evaluator no totalUsd', async () => {
    const token = await loginAs('aluno');
    const chatUsage = { input: 2000, cacheRead: 100, cacheWrite: 0, output: 300 };
    const evaluatorUsage = { input: 5000, cacheRead: 0, cacheWrite: 0, output: 800 };
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: 'ex-test-1', itemTitle: 'Test Exercise', skillId: 1,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage, evaluatorUsage,
    });
    expect(res.status).toBe(200);
    const { cost } = res.body;
    expect(cost.chat.usd).toBeCloseTo(usdMini(chatUsage), 10);
    // ex-test-1 também não tem evaluatorModel setado → default gpt-5.4-mini.
    expect(cost.evaluator.model).toBe(GPT_MINI_ID);
    expect(cost.evaluator.usd).toBeCloseTo(usdMini(evaluatorUsage), 10);
    expect(cost.totalUsd).toBeCloseTo(usdMini(chatUsage) + usdMini(evaluatorUsage), 10);
  });

  it('exercício com esquema visual em claude-sonnet-5: preço do Claude, não do GPT', async () => {
    const adminToken = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(adminToken)).send({
      title: 'Com esquema', skillId: 1, specificInstruction: 'x',
      imageSchemaEnabled: true, imageSchemaModel: 'claude-sonnet-5',
    });

    const token = await loginAs('aluno');
    const imageSchemaUsage = { input: 4000, cacheRead: 0, cacheWrite: 0, output: 1000 };
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: created.body.id, itemTitle: 'Com esquema', skillId: 1,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 },
      imageSchemaUsage,
    });
    expect(res.status).toBe(200);
    const { cost } = res.body;
    expect(cost.imageSchema.model).toBe('claude-sonnet-5');
    // claude-sonnet-5: {input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10}
    const expectedClaudeUsd = (4000 * 2 + 1000 * 10) / 1e6;
    expect(cost.imageSchema.usd).toBeCloseTo(expectedClaudeUsd, 10);
  });

  it('sanitiza usage inválido (negativo/NaN) pra zero, sem quebrar — custo vira $0, não null', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: 'ex-test-2', itemTitle: 'x', skillId: 2,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage: { input: -5, cacheRead: 'abc', cacheWrite: undefined, output: NaN },
    });
    expect(res.status).toBe(200);
    expect(res.body.cost.chat.usage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    expect(res.body.cost.chat.usd).toBe(0);
  });

  it('sem nenhum usage enviado (cliente antigo): cost fica null, não quebra', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: 'ex-test-2', itemTitle: 'x', skillId: 2,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
    });
    expect(res.status).toBe(200);
    expect(res.body.cost).toBeNull();
  });

  it('freeplay/neuro: cost sempre null (só a Trilha tem custo rastreado)', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 },
    });
    expect(res.status).toBe(200);
    expect(res.body.cost).toBeNull();
  });

  it('admin vê o campo cost via GET /api/logs', async () => {
    const token = await loginAs('aluno');
    await request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'exercise', itemId: 'ex-test-2', itemTitle: 'x', skillId: 2,
      messages: [{ role: 'user', content: 'oi' }],
      durationSeconds: 60,
      chatUsage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 },
    });

    const adminToken = await loginAs('admin');
    const list = await request(app).get('/api/logs').set(authHeader(adminToken));
    const log = list.body.find((l) => l.itemId === 'ex-test-2');
    expect(log.cost).toBeTruthy();
    expect(log.cost.chat.usd).toBeGreaterThan(0);
  });
});
