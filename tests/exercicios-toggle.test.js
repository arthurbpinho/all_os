// Interruptor de Exercícios (as antigas sidequests) no Perfil.
//
// O que este arquivo garante:
//   1. o campo nasce ligado e o usuário consegue desligar pelo próprio perfil;
//   2. desligado, NENHUM objetivo é servido — nem a sidequest do supervisor,
//      nem a missão diária que entraria no lugar dela;
//   3. desligar NÃO cancela o que o supervisor atribuiu: religar devolve;
//   4. conta antiga (sem o campo em disco) continua recebendo, como antes.
const { app, request, resetData, loginAs, authHeader, db, lerUsuarios } = require('./helpers');

// Banco de sidequests com uma definição (a atribuição ao aluno '3' é feita pela
// rota, em cada teste). Direto no banco, e a cópia em memória recarregada.
async function semearSidequest() {
  await db.query('INSERT INTO sidequests_banco (id, doc) VALUES ($1, $2)', ['sq-1', JSON.stringify({
    id: 'sq-1',
    title: 'Sustentar o silêncio',
    description: 'Deixe o paciente conduzir o ritmo por pelo menos três trocas.',
    rewardTitleId: 'qt-silencio',
    rewardTitleLabel: 'Quem escuta',
    rewardTitleTier: 'quest',
  })]);
  await app.__test.recarregarConfig();
}

async function atribuir(adminToken) {
  return request(app).post('/api/sidequests/assign')
    .set(authHeader(adminToken)).send({ userId: '3', sidequestId: 'sq-1' });
}

beforeEach(async () => {
  await resetData();
  await semearSidequest();
});

test('o campo nasce ligado e o próprio usuário desliga', async () => {
  const aluno = await loginAs('aluno');
  const me = await request(app).get('/api/me').set(authHeader(aluno));
  // Conta antiga não tem o campo em disco; o que importa é não ser `false`.
  expect(me.body.user.sidequestsEnabled).not.toBe(false);

  const salvo = await request(app).put('/api/users/3').set(authHeader(aluno))
    .send({ sidequestsEnabled: false });
  expect(salvo.status).toBe(200);
  expect(salvo.body.sidequestsEnabled).toBe(false);
  expect((await lerUsuarios()).find((u) => u.id === '3').sidequestsEnabled).toBe(false);
});

test('valor não-booleano é normalizado em vez de gravado cru', async () => {
  const aluno = await loginAs('aluno');
  const r = await request(app).put('/api/users/3').set(authHeader(aluno))
    .send({ sidequestsEnabled: 'talvez' });
  expect(r.body.sidequestsEnabled).toBe(true);
});

test('desligado, a sidequest atribuída não é servida — mas continua guardada', async () => {
  const admin = await loginAs('admin');
  expect((await atribuir(admin)).status).toBe(200);
  const aluno = await loginAs('aluno');

  const ligado = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
  expect(ligado.body.active).not.toBeNull();
  expect(ligado.body.enabled).toBe(true);

  await request(app).put('/api/users/3').set(authHeader(aluno)).send({ sidequestsEnabled: false });

  const desligado = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
  expect(desligado.body.active).toBeNull();
  expect(desligado.body.enabled).toBe(false);
  // Guardada no banco: o supervisor não perdeu a atribuição.
  const { rows } = await db.query('SELECT doc FROM sidequests_ativas WHERE user_id = 3');
  expect(rows[0]).toBeTruthy();

  // Religar devolve exatamente a mesma.
  await request(app).put('/api/users/3').set(authHeader(aluno)).send({ sidequestsEnabled: true });
  const religado = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
  expect(religado.body.active.title).toBe('Sustentar o silêncio');
});

test('desligado, a missão diária TAMBÉM não entra no lugar', async () => {
  const aluno = await loginAs('aluno');
  // Sem sidequest atribuída, a diária é quem apareceria.
  const antes = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
  expect(antes.body.mission).not.toBeNull();

  await request(app).put('/api/users/3').set(authHeader(aluno)).send({ sidequestsEnabled: false });
  const depois = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
  expect(depois.body.mission).toBeNull();
  expect(depois.body.disabled).toBe(true);
});

test('conta sem o campo em disco continua recebendo o objetivo', async () => {
  // No banco não existe "campo ausente": a coluna nasce com o padrão (ligado),
  // que é o equivalente da conta antiga que não tinha o campo em disco.
  await db.query('UPDATE users SET sidequests_enabled = DEFAULT');
  const aluno = await loginAs('aluno');
  const r = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
  expect(r.body.mission).not.toBeNull();
});

test('o interruptor de um aluno não vaza para outro', async () => {
  const aluno = await loginAs('aluno');
  await request(app).put('/api/users/3').set(authHeader(aluno)).send({ sidequestsEnabled: false });
  const outro = await loginAs('aluno2');
  const r = await request(app).get('/api/me/daily-mission').set(authHeader(outro));
  expect(r.body.mission).not.toBeNull();
});

test('abordagem é aceita, cortada em 120 caracteres e sem espaço nas pontas', async () => {
  const aluno = await loginAs('aluno');
  const r = await request(app).put('/api/users/3').set(authHeader(aluno))
    .send({ abordagem: '  ' + 'x'.repeat(300) + '  ' });
  expect(r.body.abordagem).toBe('x'.repeat(120));
});
