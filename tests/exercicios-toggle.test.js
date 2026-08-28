// Interruptor de Exercícios (as antigas sidequests) no Perfil.
//
// O que este arquivo garante:
//   1. o campo nasce ligado e o usuário consegue desligar pelo próprio perfil;
//   2. desligado, NENHUM objetivo é servido — nem a sidequest do supervisor,
//      nem a missão diária que entraria no lugar dela;
//   3. desligar NÃO cancela o que o supervisor atribuiu: religar devolve;
//   4. conta antiga (sem o campo em disco) continua recebendo, como antes.
const { app, request, resetData, loginAs, authHeader, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');

function lerUsuarios() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf-8'));
}
function gravarUsuarios(users) {
  fs.writeFileSync(path.join(DATA_DIR, 'users.json'), JSON.stringify(users, null, 2));
}

// Banco de sidequests + uma atribuída ao aluno '3'.
function semearSidequest() {
  fs.writeFileSync(path.join(DATA_DIR, 'sidequests.json'), JSON.stringify({
    bank: [{
      id: 'sq-1',
      title: 'Sustentar o silêncio',
      description: 'Deixe o paciente conduzir o ritmo por pelo menos três trocas.',
      rewardTitleId: 'qt-silencio',
      rewardTitleLabel: 'Quem escuta',
      rewardTitleTier: 'quest',
    }],
    active: {},
    completed: {},
  }, null, 2));
}

async function atribuir(adminToken) {
  return request(app).post('/api/sidequests/assign')
    .set(authHeader(adminToken)).send({ userId: '3', sidequestId: 'sq-1' });
}

beforeEach(() => {
  resetData();
  semearSidequest();
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
  expect(lerUsuarios().find((u) => u.id === '3').sidequestsEnabled).toBe(false);
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
  // Guardada em disco: o supervisor não perdeu a atribuição.
  const store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sidequests.json'), 'utf-8'));
  expect(store.active['3']).toBeTruthy();

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
  const users = lerUsuarios();
  for (const u of users) delete u.sidequestsEnabled;
  gravarUsuarios(users);
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
