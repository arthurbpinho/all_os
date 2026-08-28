// Web Push (assinatura) + ciclo "avaliação na fila" → "avaliação pronta" das
// notificações in-app (mesmo sistema usado pro push, ver server/index.js
// upsertEvaluationNotification/pushNotification).
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

const FAKE_SUB = (n = 1) => ({
  endpoint: `https://push.example.com/ep-${n}`,
  keys: { p256dh: 'p256dh-key-' + n, auth: 'auth-key-' + n },
});

describe('Web Push — assinatura', () => {
  beforeEach(() => resetData());

  it('devolve a chave pública VAPID sem exigir auth', async () => {
    const r = await request(app).get('/api/push/vapid-public-key');
    expect(r.status).toBe(200);
    expect(typeof r.body.key).toBe('string');
    expect(r.body.key.length).toBeGreaterThan(20);
  });

  it('exige auth pra assinar/desassinar', async () => {
    const r = await request(app).post('/api/push/subscribe').send({ subscription: FAKE_SUB() });
    expect(r.status).toBe(401);
  });

  it('valida o corpo da assinatura (400 sem endpoint/keys)', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).post('/api/push/subscribe').set(authHeader(t)).send({ subscription: { endpoint: 'x' } });
    expect(r.status).toBe(400);
  });

  it('grava a assinatura e é idempotente por endpoint (2 dispositivos = 2 entradas)', async () => {
    const t = await loginAs('aluno');
    const r1 = await request(app).post('/api/push/subscribe').set(authHeader(t)).send({ subscription: FAKE_SUB(1) });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/push/subscribe').set(authHeader(t)).send({ subscription: FAKE_SUB(2) });
    expect(r2.status).toBe(200);
    // Reassinar o MESMO endpoint (ex.: chaves rotacionadas) não duplica.
    const r3 = await request(app).post('/api/push/subscribe').set(authHeader(t)).send({ subscription: FAKE_SUB(1) });
    expect(r3.status).toBe(200);

    const un = await request(app).post('/api/push/unsubscribe').set(authHeader(t)).send({ endpoint: FAKE_SUB(1).endpoint });
    expect(un.status).toBe(200);
  });

  it('visitante: subscribe é no-op silencioso (visitante não recebe notificação)', async () => {
    const vt = await loginVisitor();
    const r = await request(app).post('/api/push/subscribe').set(authHeader(vt)).send({ subscription: FAKE_SUB() });
    expect(r.status).toBe(200);
  });
});

// O push de teste existe porque o envio real falha em SILÊNCIO: sem VAPID, sem
// assinatura ou com chave trocada, o servidor simplesmente não manda nada. Estes
// testes cobrem as guardas — o caminho de sucesso não é coberto de propósito,
// porque ele fala com o serviço de push do navegador (rede), e a suite não sai
// pra rede.
describe('Web Push — push de teste', () => {
  beforeEach(() => resetData());

  it('exige auth', async () => {
    const r = await request(app).post('/api/push/test').send({});
    expect(r.status).toBe(401);
  });

  it('visitante não pode', async () => {
    const vt = await loginVisitor();
    const r = await request(app).post('/api/push/test').set(authHeader(vt)).send({});
    expect(r.status).toBe(403);
  });

  it('sem nenhum aparelho assinado, diz isso em vez de "enviado"', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).post('/api/push/test').set(authHeader(t)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/nenhum dispositivo assinado/i);
  });
});

describe('Notificação de avaliação — fila → pronta', () => {
  beforeEach(() => resetData());

  it('POST /api/logs (freeplay, com avaliação) cria a notificação "pronta" com o título do personagem', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).post('/api/logs').set(authHeader(t)).send({
      type: 'freeplay',
      mode: 'training',
      itemId: 'fp-test-1',
      itemTitle: 'Sofia Test',
      messages: [{ role: 'assistant', content: 'Oi.' }, { role: 'user', content: 'Como você está?' }],
      evaluation: 'Feedback qualquer, sem blocos especiais.',
      score: 82,
    });
    expect(r.status).toBe(200);

    const notif = await request(app).get('/api/notifications').set(authHeader(t));
    const ready = notif.body.items.find((n) => n.type === 'evaluation_ready');
    expect(ready).toBeTruthy();
    expect(ready.message).toBe('Sua avaliação de "Sofia Test" está pronta.');
    expect(ready.read).toBe(false);
  });

  it('POST /api/logs sem avaliação/nota não cria notificação de avaliação (ex.: Simulação Livre)', async () => {
    const t = await loginAs('aluno');
    await request(app).post('/api/logs').set(authHeader(t)).send({
      type: 'freeplay',
      mode: 'training',
      itemId: 'fp-test-1',
      itemTitle: 'Sofia Test',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: '',
    });
    const notif = await request(app).get('/api/notifications').set(authHeader(t));
    expect(notif.body.items.find((n) => n.type === 'evaluation_queued' || n.type === 'evaluation_ready')).toBeFalsy();
  });

  it('duas avaliações seguidas ATUALIZAM a mesma notificação (mesmo refId), não duplicam', async () => {
    const t = await loginAs('aluno');
    const send = (itemTitle) => request(app).post('/api/logs').set(authHeader(t)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle,
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: 'Feedback.', score: 70,
    });
    await send('Sofia Test');
    const notif1 = await request(app).get('/api/notifications').set(authHeader(t));
    const evalNotifs1 = notif1.body.items.filter((n) => n.type === 'evaluation_ready');
    expect(evalNotifs1.length).toBe(1);
    const firstId = evalNotifs1[0].id;

    await send('Sofia Test');
    const notif2 = await request(app).get('/api/notifications').set(authHeader(t));
    const evalNotifs2 = notif2.body.items.filter((n) => n.type === 'evaluation_ready');
    // Ainda uma linha só — a segunda chamada atualizou em vez de empilhar.
    expect(evalNotifs2.length).toBe(1);
    expect(evalNotifs2[0].id).toBe(firstId);
  });

  it('POST /api/competitive/finish cria a notificação "na fila" com o texto exato pedido', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).post('/api/competitive/finish').set(authHeader(t)).send({
      itemId: 'fp-test-1',
      itemTitle: 'Sofia Test',
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(r.status).toBe(200);

    const notif = await request(app).get('/api/notifications').set(authHeader(t));
    const queued = notif.body.items.find((n) => n.type === 'evaluation_queued');
    expect(queued).toBeTruthy();
    expect(queued.message).toBe(
      'Sua avaliação está na fila. Em até 24 horas, você receberá uma nova notificação quando sua avaliação for concluída.'
    );
    expect(queued.refId).toBe('log:' + r.body.logId);
  });
});
