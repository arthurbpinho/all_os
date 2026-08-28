// Contas cujos usernames só diferem em maiúsculas.
//
// O servidor tratava isso como fatal (process.exit(1)) e entrava em loop de
// restart: duas contas duplicadas derrubavam a plataforma inteira, incluindo a
// única tela capaz de resolver o problema. Aconteceu em produção com
// "victor.toscano" / "Victor.toscano" em 2026-08-28.
//
// O que este arquivo garante:
//   1. o servidor SOBE com a base nesse estado;
//   2. nenhuma das duas contas ambíguas consegue entrar;
//   3. quem não está no conflito continua entrando normalmente;
//   4. renomear uma delas destrava a outra NA HORA, sem reiniciar.
const { app, request, resetData, loginAs, authHeader, TEST_PASSWORD, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');

const USERS = path.join(DATA_DIR, 'users.json');
const ler = () => JSON.parse(fs.readFileSync(USERS, 'utf-8'));
const gravar = (u) => fs.writeFileSync(USERS, JSON.stringify(u, null, 2));

// Duplica o aluno '3' trocando só o caixa do nome — o estado exato de produção.
function criarConflito() {
  const users = ler();
  const base = users.find((u) => u.id === '3');
  users.push({ ...base, id: '99', username: 'Aluno', usernameLower: 'aluno', name: 'Aluno Duplicado' });
  gravar(users);
}

beforeEach(() => {
  resetData();
  criarConflito();
});

const login = (username) =>
  request(app).post('/api/login').send({ username, password: TEST_PASSWORD });

test('as duas contas em conflito ficam sem login', async () => {
  for (const nome of ['aluno', 'Aluno', 'ALUNO']) {
    const r = await login(nome);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/duplicado/i);
  }
});

test('o resto da plataforma continua funcionando', async () => {
  // Se o guard ainda derrubasse o processo, nem chegaríamos aqui.
  const admin = await loginAs('admin');
  const lista = await request(app).get('/api/admin/users').set(authHeader(admin));
  expect(lista.status).toBe(200);

  const outro = await login('aluno2');
  expect(outro.status).toBe(200);
});

test('renomear uma das contas destrava a outra sem reiniciar', async () => {
  const admin = await loginAs('admin');
  const r = await request(app).put('/api/admin/users/99').set(authHeader(admin))
    .send({ username: 'aluno.duplicado' });
  expect(r.status).toBe(200);

  // Mesma instância do servidor, sem restart: o conflito acabou.
  expect((await login('aluno')).status).toBe(200);
  expect((await login('aluno.duplicado')).status).toBe(200);
});

test('a senha errada continua dando 401, não 409', async () => {
  const users = ler();
  gravar(users.filter((u) => u.id !== '99')); // desfaz o conflito
  const r = await request(app).post('/api/login').send({ username: 'aluno', password: 'errada' });
  expect(r.status).toBe(401);
});
