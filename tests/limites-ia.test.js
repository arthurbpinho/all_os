// Modelo de IA e limite semanal do Terapeuta externo (demandas.md §16.2 e §18):
// janela deslizante de 7 dias, em dólares e/ou tokens, com aviso ao suporte.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const li = require('../server/limites-ia');

beforeEach(() => resetData());

describe('limites-ia (puro)', () => {
  it('custo e tokens por modelo, pelo prefixo mais longo', () => {
    const uso = { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 };
    expect(li.custoUsd('gpt-5.4-mini-2026-03-17', uso)).toBeCloseTo(5.25);
    expect(li.custoUsd('gpt-5.4-2026-03-05', uso)).toBeCloseTo(17.5);
    expect(li.custoUsd('modelo-desconhecido', uso)).toBeNull();
    expect(li.tokensDe(uso)).toBe(2e6);
  });

  it('normaliza a configuração: modelo fora dos presets e limite inválido viram padrão', () => {
    const presets = { pacientes: { 'gpt-5.4-mini': {} }, avaliadores: { 'gpt-5.5': {} } };
    expect(li.normalizarConfig({ modeloPaciente: 'gpt-5.4-mini', modeloAvaliador: 'x', limiteUsd: '2.555', limiteTokens: -3 }, presets))
      .toEqual({ modeloPaciente: 'gpt-5.4-mini', modeloAvaliador: '', limiteUsd: 2.56, limiteTokens: null });
  });

  it('estado: excede pelo que chegar primeiro e diz quando algo volta a caber', () => {
    const agora = Date.parse('2026-09-15T12:00:00Z');
    const cfg = { limiteUsd: 5, limiteTokens: 1000 };
    expect(li.estado({ usd: 4, tokens: 999 }, cfg, agora).excedido).toBe(false);
    const e = li.estado({ usd: 1, tokens: 1000, primeiro: '2026-09-10T12:00:00Z' }, cfg, agora);
    expect(e).toMatchObject({ excedido: true, motivo: 'tokens', renovaEm: '2026-09-17T12:00:00.000Z' });
    expect(li.estado({ usd: 100, tokens: 1e9 }, {}, agora).excedido).toBe(false);
  });

  it('equivalências: quanto um valor em dólar compra de entrada e de saída', () => {
    const [eq] = li.equivalencias(1, [{ key: 'm', label: 'Mini', model: 'gpt-5.4-mini' }]);
    expect(eq.tokensEntrada).toBe(1333333);
    expect(eq.tokensSaida).toBe(222222);
  });
});

async function loginExterno() {
  await db.query(`UPDATE users SET role = 'external', teacher_id = NULL WHERE id = 5`);
  return loginAs('aluno2');
}

async function configurar(admin, limitesExterno) {
  const r = await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ limitesExterno });
  expect(r.status).toBe(200);
  return r.body;
}

const chat = (token) => request(app).post('/api/chat').set(authHeader(token)).send({
  context: { type: 'freeplay', itemId: 'fp-test-1' },
  messages: [{ role: 'user', content: 'oi' }],
});

async function avisosDoAdmin() {
  const { rows } = await db.query(`SELECT doc->>'message' AS m FROM notificacoes WHERE user_id = 1`);
  return rows.map((r) => r.m).filter((m) => m && m.includes('limite semanal'));
}

describe('limite semanal do Terapeuta externo', () => {
  it('admin configura em Acessos e vê as equivalências', async () => {
    const admin = await loginAs('admin');
    const body = await configurar(admin, { modeloPaciente: 'gpt-5.4-mini', limiteUsd: 3, limiteTokens: '' });
    expect(body.limitesExterno).toEqual({ modeloPaciente: 'gpt-5.4-mini', modeloAvaliador: '', limiteUsd: 3, limiteTokens: null });
    expect(body.opcoesPaciente.some((o) => o.key === 'gpt-5.4-mini')).toBe(true);
    expect(body.equivalencias.find((e) => e.key === 'gpt-5.4-mini').tokensSaida).toBe(666666);
  });

  it('estourou na janela de 7 dias: chat, avaliação e transcrição param, e o suporte é avisado uma vez', async () => {
    const admin = await loginAs('admin');
    await configurar(admin, { limiteUsd: 1 });
    const externo = await loginExterno();
    await db.query(`INSERT INTO uso_ia (user_id, categoria, modelo, tokens, usd) VALUES (5, 'treinamento', 'gpt-5.4-mini', 1000, 1.2)`);

    const r = await chat(externo);
    expect(r.status).toBe(429);
    expect(r.body.limiteIa).toMatchObject({ excedido: true, motivo: 'usd' });
    expect(r.body.error).toMatch(/limite semanal/);
    expect((await chat(externo)).status).toBe(429);
    expect((await request(app).post('/api/transcribe').set(authHeader(externo)).send({ audio: '' })).status).toBe(429);
    expect((await request(app).post('/api/evaluate').set(authHeader(externo)).send({ messages: [], context: { type: 'freeplay', mode: 'training', itemId: 'fp-test-1' } })).status).toBe(429);

    // Um aviso por estouro, não um por chamada recusada.
    expect(await avisosDoAdmin()).toHaveLength(1);

    const meu = await request(app).get('/api/me/uso-ia').set(authHeader(externo));
    expect(meu.body).toMatchObject({ temLimite: true, excedido: true, limiteUsd: 1 });
    const painel = await request(app).get('/api/admin/uso-ia').set(authHeader(admin));
    expect(painel.body.contas.find((c) => c.userId === '5')).toMatchObject({ excedido: true, usd: 1.2 });
  });

  it('uso de mais de 7 dias sai da conta (janela deslizante)', async () => {
    const admin = await loginAs('admin');
    await configurar(admin, { limiteTokens: 500 });
    const externo = await loginExterno();
    await db.query(`INSERT INTO uso_ia (user_id, tokens, usd, criado_em) VALUES (5, 10000, 5, now() - interval '8 days')`);
    const r = await chat(externo);
    expect(r.status).not.toBe(429);
  });

  it('só o Terapeuta externo tem limite', async () => {
    const admin = await loginAs('admin');
    await configurar(admin, { limiteUsd: 0.01 });
    await db.query(`INSERT INTO uso_ia (user_id, tokens, usd) VALUES (3, 10, 50)`);
    const aluno = await loginAs('aluno');
    expect((await chat(aluno)).status).not.toBe(429);
    expect((await request(app).get('/api/me/uso-ia').set(authHeader(aluno))).body).toEqual({ temLimite: false });
    expect((await request(app).get('/api/admin/uso-ia').set(authHeader(aluno))).status).toBe(403);
  });
});
