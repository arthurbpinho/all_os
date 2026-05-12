const { app, request, resetData, loginAs, loginVisitor, authHeader, TEST_PASSWORD } = require('./helpers');

describe('auth', () => {
  beforeEach(() => resetData());

  it('login com credenciais válidas retorna token + user (sem passwordHash)', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.role).toBe('admin');
    // passwordHash NUNCA deve vazar pro cliente
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.password).toBeUndefined();
  });

  it('login com senha errada retorna 401 sem revelar se user existe', async () => {
    const wrongPass = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'errada' });
    const wrongUser = await request(app)
      .post('/api/login')
      .send({ username: 'naoexiste', password: 'errada' });
    expect(wrongPass.status).toBe(401);
    expect(wrongUser.status).toBe(401);
    // Mensagem deve ser igual para os dois (anti-enumeration)
    expect(wrongPass.body.error).toBe(wrongUser.body.error);
  });

  it('login com body vazio retorna 400', async () => {
    const res = await request(app).post('/api/login').send({});
    expect(res.status).toBe(400);
  });

  it('login visitor gera token sem persistir em users.json', async () => {
    const res = await request(app).post('/api/login/visitor').send({});
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.role).toBe('visitor');
    expect(res.body.user.id).toMatch(/^visitor-/);
  });

  it('GET /api/me sem token retorna 401', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/me com token válido retorna user', async () => {
    const token = await loginAs('admin');
    const res = await request(app).get('/api/me').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('admin');
  });

  it('GET /api/me com token malformado retorna 401', async () => {
    const res = await request(app)
      .get('/api/me')
      .set({ Authorization: 'Bearer abc.fake.token' });
    expect(res.status).toBe(401);
  });

  it('admin não pode rebaixar o próprio role', async () => {
    const token = await loginAs('admin');
    const res = await request(app)
      .put('/api/admin/users/1')
      .set(authHeader(token))
      .send({ role: 'therapist' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/própria função/i);
  });

  it('admin pode resetar senha de aluno; senha antiga falha, nova funciona', async () => {
    const adminToken = await loginAs('admin');
    const reset = await request(app)
      .post('/api/admin/users/3/reset-password')
      .set(authHeader(adminToken))
      .send({ newPassword: 'novasenhaXYZ' });
    expect(reset.status).toBe(200);

    const oldFails = await request(app)
      .post('/api/login')
      .send({ username: 'aluno', password: TEST_PASSWORD });
    expect(oldFails.status).toBe(401);

    const newWorks = await request(app)
      .post('/api/login')
      .send({ username: 'aluno', password: 'novasenhaXYZ' });
    expect(newWorks.status).toBe(200);
  });
});
