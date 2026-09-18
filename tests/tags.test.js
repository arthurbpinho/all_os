// Tags de terapeutas (demandas.md §16.4): o admin cria e aplica; ranking e logs
// filtram por elas.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');

beforeEach(() => resetData());

async function criarTag(admin, nome) {
  const r = await request(app).post('/api/admin/tags').set(authHeader(admin)).send({ nome });
  expect(r.status).toBe(200);
  return r.body;
}

describe('tags de terapeutas', () => {
  it('admin cria, renomeia e exclui; nome repetido (sem diferença de caixa) é recusado', async () => {
    const admin = await loginAs('admin');
    const tag = await criarTag(admin, '  Psicanalista ');
    expect(tag.nome).toBe('Psicanalista');
    expect((await request(app).post('/api/admin/tags').set(authHeader(admin)).send({ nome: 'psicanalista' })).status).toBe(409);
    expect((await request(app).post('/api/admin/tags').set(authHeader(admin)).send({ nome: '   ' })).status).toBe(400);

    const outra = await criarTag(admin, 'Neuropsicólogo');
    expect((await request(app).put(`/api/admin/tags/${outra.id}`).set(authHeader(admin)).send({ nome: 'PSICANALISTA' })).status).toBe(409);
    expect((await request(app).put(`/api/admin/tags/${outra.id}`).set(authHeader(admin)).send({ nome: 'Neuropsicologia' })).status).toBe(200);

    expect((await request(app).delete(`/api/admin/tags/${tag.id}`).set(authHeader(admin))).status).toBe(200);
    const lista = await request(app).get('/api/admin/tags').set(authHeader(admin));
    expect(lista.body.map((t) => t.nome)).toEqual(['Neuropsicologia']);
  });

  it('só o admin mexe nas tags e nas tags das contas', async () => {
    const admin = await loginAs('admin');
    const tag = await criarTag(admin, 'TCC');
    for (const quem of ['prof', 'aluno']) {
      const t = await loginAs(quem);
      expect((await request(app).post('/api/admin/tags').set(authHeader(t)).send({ nome: 'x' })).status).toBe(403);
      expect((await request(app).put('/api/admin/users/3/tags').set(authHeader(t)).send({ tagIds: [tag.id] })).status).toBe(403);
    }
    // A lista de nomes é aberta a quem tem conta (é o filtro do ranking).
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/tags').set(authHeader(aluno))).body).toEqual([{ id: tag.id, nome: 'TCC' }]);
  });

  it('aplicar tags a uma conta aparece em Contas, com a contagem', async () => {
    const admin = await loginAs('admin');
    const a = await criarTag(admin, 'Psicanalista');
    const b = await criarTag(admin, 'Neuropsicólogo');
    const r = await request(app).put('/api/admin/users/3/tags').set(authHeader(admin)).send({ tagIds: [a.id, b.id, '999', 'lixo'] });
    expect(r.body.tags.map((t) => t.nome)).toEqual(['Neuropsicólogo', 'Psicanalista']);

    const contas = await request(app).get('/api/admin/users').set(authHeader(admin));
    expect(contas.body.find((u) => u.id === '3').tags).toHaveLength(2);
    expect(contas.body.find((u) => u.id === '5').tags).toEqual([]);
    expect((await request(app).get('/api/admin/tags').set(authHeader(admin))).body.find((t) => t.id === a.id).total).toBe(1);

    // Trocar é substituir, não somar.
    await request(app).put('/api/admin/users/3/tags').set(authHeader(admin)).send({ tagIds: [b.id] });
    const depois = await request(app).get('/api/admin/users').set(authHeader(admin));
    expect(depois.body.find((u) => u.id === '3').tags.map((t) => t.nome)).toEqual(['Neuropsicólogo']);
  });

  it('ranking filtra por tag', async () => {
    const admin = await loginAs('admin');
    const tag = await criarTag(admin, 'Psicanalista');
    await request(app).put('/api/admin/users/3/tags').set(authHeader(admin)).send({ tagIds: [tag.id] });
    await db.query(`INSERT INTO mmr_players (user_id, estado) VALUES (3, '{"P":55,"n":5,"W":[]}'), (5, '{"P":60,"n":5,"W":[]}')`);

    const aluno = await loginAs('aluno');
    const todos = await request(app).get('/api/ranking').set(authHeader(aluno));
    expect(todos.body.map((r) => r.userId).sort()).toEqual(['3', '5']);
    const filtrado = await request(app).get(`/api/ranking?tag=${tag.id}`).set(authHeader(aluno));
    expect(filtrado.body.map((r) => r.userId)).toEqual(['3']);
  });

  it('logs de supervisão filtram por tag; o aluno continua vendo só os próprios', async () => {
    const admin = await loginAs('admin');
    const tag = await criarTag(admin, 'Psicanalista');
    await request(app).put('/api/admin/users/5/tags').set(authHeader(admin)).send({ tagIds: [tag.id] });
    const log = (id, userId) => db.query(
      `INSERT INTO logs (id, user_id, type, item_id) VALUES ($1, $2, 'freeplay', 'fp-test-1')`, [id, userId],
    );
    await log('log-a', 3);
    await log('log-b', 5);

    const todos = await request(app).get('/api/logs').set(authHeader(admin));
    expect(todos.body.map((l) => l.id).sort()).toEqual(['log-a', 'log-b']);
    const filtrado = await request(app).get(`/api/logs?tag=${tag.id}`).set(authHeader(admin));
    expect(filtrado.body.map((l) => l.id)).toEqual(['log-b']);

    const aluno = await loginAs('aluno');
    const meus = await request(app).get(`/api/logs?tag=${tag.id}`).set(authHeader(aluno));
    expect(meus.body.map((l) => l.id)).toEqual(['log-a']);
  });
});
