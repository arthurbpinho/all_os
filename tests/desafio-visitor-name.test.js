// Modo Desafio (Titular-Desafiante) — visitante que vence pode digitar o
// próprio nome (sem foto), mas só a MESMA sessão de visitante que venceu pode
// nomear (server/index.js: visitorSessionId trava isso).

const { app, request, resetData, loginVisitor, loginAs, authHeader } = require('./helpers');

// OPENAI_API_KEY vazio no ambiente de teste (helpers.js) → reivindicar cai no
// branch skipEval e devolve JSON puro com kind:'claimed', sem bater na rede.
async function reivindicar(token, characterId) {
  return request(app).post('/api/desafio/reivindicar').set(authHeader(token)).send({
    characterId,
    messages: [{ role: 'user', content: 'Olá' }, { role: 'assistant', content: 'Oi' }],
    durationSeconds: 30,
  });
}

describe('Modo Desafio — visitante nomeia a si mesmo ao vencer', () => {
  beforeEach(() => resetData());

  it('visitante reivindica: titular aparece como "Um visitante", sem foto', async () => {
    const token = await loginVisitor();
    const res = await reivindicar(token, 'fp-test-1');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('claimed');
    expect(res.body.titular.isVisitor).toBe(true);
    expect(res.body.titular.name).toBe('Um visitante');
    expect(res.body.titular.profilePhoto).toBe('');
  });

  it('a mesma sessão de visitante que venceu pode nomear a si mesma', async () => {
    const token = await loginVisitor();
    await reivindicar(token, 'fp-test-1');

    const res = await request(app).post('/api/desafio/nome-visitante').set(authHeader(token)).send({
      characterId: 'fp-test-1', name: 'Zé das Couves',
    });
    expect(res.status).toBe(200);
    expect(res.body.titular.name).toBe('Zé das Couves');
    expect(res.body.titular.profilePhoto).toBe(''); // nunca ganha foto

    // Persiste: uma nova leitura mostra o nome salvo.
    const list = await request(app).get('/api/desafio/titulares').set(authHeader(token));
    expect(list.body['fp-test-1'].name).toBe('Zé das Couves');
  });

  it('OUTRO visitante não pode nomear o Titular de quem já venceu', async () => {
    const winner = await loginVisitor();
    await reivindicar(winner, 'fp-test-1');

    const intruder = await loginVisitor(); // sessão de visitante DIFERENTE (id novo)
    const res = await request(app).post('/api/desafio/nome-visitante').set(authHeader(intruder)).send({
      characterId: 'fp-test-1', name: 'Sequestrador',
    });
    expect(res.status).toBe(403);

    // Nome do vencedor original continua intacto.
    const list = await request(app).get('/api/desafio/titulares').set(authHeader(winner));
    expect(list.body['fp-test-1'].name).toBe('Um visitante');
  });

  it('usuário logado (não-visitante) não pode usar o recurso', async () => {
    const token = await loginVisitor();
    await reivindicar(token, 'fp-test-1');

    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/desafio/nome-visitante').set(authHeader(aluno)).send({
      characterId: 'fp-test-1', name: 'Qualquer coisa',
    });
    expect(res.status).toBe(403);
  });

  it('rejeita nome vazio e characterId ausente', async () => {
    const token = await loginVisitor();
    await reivindicar(token, 'fp-test-1');

    const semNome = await request(app).post('/api/desafio/nome-visitante').set(authHeader(token)).send({
      characterId: 'fp-test-1', name: '   ',
    });
    expect(semNome.status).toBe(400);

    const semId = await request(app).post('/api/desafio/nome-visitante').set(authHeader(token)).send({
      name: 'Nome válido',
    });
    expect(semId.status).toBe(400);
  });

  it('404 quando não há Titular pra esse personagem', async () => {
    const token = await loginVisitor();
    const res = await request(app).post('/api/desafio/nome-visitante').set(authHeader(token)).send({
      characterId: 'fp-test-1', name: 'Ninguém',
    });
    expect(res.status).toBe(404);
  });

  it('não pode nomear um Titular que é usuário real (não-visitante)', async () => {
    const aluno = await loginAs('aluno');
    await reivindicar(aluno, 'fp-test-1');

    const visitante = await loginVisitor();
    const res = await request(app).post('/api/desafio/nome-visitante').set(authHeader(visitante)).send({
      characterId: 'fp-test-1', name: 'Tentativa',
    });
    expect(res.status).toBe(403);
  });
});
