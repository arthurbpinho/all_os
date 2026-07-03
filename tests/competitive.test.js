// Competitivo assíncrono: o /finish salva o log PENDENTE em logs.json (nota+MMR
// vêm depois, via batch), e ele aparece nas Minhas Sessões do aluno como pendente.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

describe('Competitivo assíncrono', () => {
  beforeEach(() => resetData());

  it('finish salva log pendente (mode competitive, sem nota) e aparece nos logs do aluno', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).post('/api/competitive/finish').set(authHeader(t)).send({
      itemId: 'fp-test-1',
      itemTitle: 'Sofia Test',
      messages: [{ role: 'assistant', content: 'Oi.' }, { role: 'user', content: 'Como você está?' }],
      durationSeconds: 120,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pending: true });
    expect(typeof r.body.logId).toBe('string');

    const logs = await request(app).get('/api/logs').set(authHeader(t));
    expect(logs.status).toBe(200);
    const log = logs.body.find((l) => l.id === r.body.logId);
    expect(log).toBeTruthy();
    expect(log.type).toBe('freeplay');
    expect(log.mode).toBe('competitive');
    expect(log.evaluationPending).toBe(true);
    expect(log.score).toBeNull();
    expect(log.messages.length).toBe(2);
  });

  it('valida itemId e mensagens (400); bloqueia visitante (403)', async () => {
    const t = await loginAs('aluno');
    const noItem = await request(app).post('/api/competitive/finish').set(authHeader(t)).send({ messages: [{ role: 'user', content: 'x' }] });
    expect(noItem.status).toBe(400);
    const noMsg = await request(app).post('/api/competitive/finish').set(authHeader(t)).send({ itemId: 'fp-test-1', messages: [] });
    expect(noMsg.status).toBe(400);

    const vt = await loginVisitor();
    const vis = await request(app).post('/api/competitive/finish').set(authHeader(vt)).send({ itemId: 'fp-test-1', messages: [{ role: 'user', content: 'x' }] });
    expect(vis.status).toBe(403);
  });
});
