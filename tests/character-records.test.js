// Recorde 👑 por paciente + "Paciente em Destaque" — as duas coisas que
// substituíram o Modo Desafio. Ambas saem em GET /api/freeplay:
//   record   → maior nota já tirada naquele paciente no Competitivo (+ quem)
//   featured → o ÚLTIMO personagem cadastrado (fundo amarelo no Competitivo)
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

function byId(list, id) {
  return list.find((c) => c.id === id);
}

// Sessão competitiva com nota, pelo caminho síncrono de /api/logs.
function postCompetitiveLog(token, itemId, score) {
  return request(app).post('/api/logs').set(authHeader(token)).send({
    type: 'freeplay',
    mode: 'competitive',
    itemId,
    itemTitle: 'Sofia Test',
    score,
    messages: [{ role: 'user', content: 'oi' }],
  });
}

describe('Recorde 👑 do paciente', () => {
  beforeEach(() => resetData());

  it('sem sessão competitiva, o recorde vem null', async () => {
    const t = await loginAs('aluno');
    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(res.status).toBe(200);
    expect(byId(res.body, 'fp-test-1').record).toBeNull();
  });

  it('nota competitiva vira recorde com a nota e o nome de quem tirou', async () => {
    const t = await loginAs('aluno');
    expect((await postCompetitiveLog(t, 'fp-test-1', 72)).status).toBe(200);

    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').record).toMatchObject({ score: 72, userName: 'Aluno A' });
    // userId nunca sai pro cliente — o card só precisa do nome.
    expect(byId(res.body, 'fp-test-1').record.userId).toBeUndefined();
  });

  it('só a MAIOR nota fica; empate não troca o dono', async () => {
    const a = await loginAs('aluno');
    const b = await loginAs('aluno2');

    await postCompetitiveLog(a, 'fp-test-1', 80);
    await postCompetitiveLog(b, 'fp-test-1', 65); // menor → não troca
    let res = await request(app).get('/api/freeplay').set(authHeader(a));
    expect(byId(res.body, 'fp-test-1').record).toMatchObject({ score: 80, userName: 'Aluno A' });

    await postCompetitiveLog(b, 'fp-test-1', 80); // empate → quem chegou primeiro fica
    res = await request(app).get('/api/freeplay').set(authHeader(a));
    expect(byId(res.body, 'fp-test-1').record).toMatchObject({ score: 80, userName: 'Aluno A' });

    await postCompetitiveLog(b, 'fp-test-1', 91); // maior → troca
    res = await request(app).get('/api/freeplay').set(authHeader(a));
    expect(byId(res.body, 'fp-test-1').record).toMatchObject({ score: 91, userName: 'Aluno B' });
  });

  it('sessão de treinamento não vira recorde (só o Competitivo conta)', async () => {
    const t = await loginAs('aluno');
    await request(app).post('/api/logs').set(authHeader(t)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', score: 99,
      messages: [{ role: 'user', content: 'oi' }],
    });
    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').record).toBeNull();
  });

  it('visitante não fica com o recorde (id efêmero)', async () => {
    const v = await loginVisitor();
    await postCompetitiveLog(v, 'fp-test-1', 95);
    const t = await loginAs('aluno');
    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').record).toBeNull();
  });

  it('reset de ranking zera os recordes junto com as notas', async () => {
    const t = await loginAs('aluno');
    await postCompetitiveLog(t, 'fp-test-1', 88);
    const admin = await loginAs('admin');
    const reset = await request(app).post('/api/admin/ranking/reset').set(authHeader(admin)).send({});
    expect(reset.status).toBe(200);

    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').record).toBeNull();
  });
});

describe('Paciente em Destaque', () => {
  beforeEach(() => resetData());

  it('o último personagem cadastrado é o destaque; os outros não', async () => {
    const admin = await loginAs('admin');
    const t = await loginAs('aluno');

    // Só um personagem no seed → ele é o destaque.
    let res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').featured).toBe(true);

    // Cadastra um novo → o destaque migra pra ele.
    const novo = await request(app).post('/api/freeplay').set(authHeader(admin))
      .send({ name: 'Paciente Novo', age: 40, description: 'Recém-chegado' });
    expect(novo.status).toBe(200);

    res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, 'fp-test-1').featured).toBe(false);
    expect(byId(res.body, novo.body.id).featured).toBe(true);
    // Exatamente um destaque de cada vez.
    expect(res.body.filter((c) => c.featured).length).toBe(1);
  });

  it('editar um personagem antigo não rouba o destaque do mais novo', async () => {
    const admin = await loginAs('admin');
    const t = await loginAs('aluno');
    const novo = await request(app).post('/api/freeplay').set(authHeader(admin))
      .send({ name: 'Paciente Novo', age: 40, description: 'Recém-chegado' });

    await request(app).put('/api/freeplay/fp-test-1').set(authHeader(admin))
      .send({ description: 'Descrição editada' });

    const res = await request(app).get('/api/freeplay').set(authHeader(t));
    expect(byId(res.body, novo.body.id).featured).toBe(true);
    expect(byId(res.body, 'fp-test-1').featured).toBe(false);
  });
});
