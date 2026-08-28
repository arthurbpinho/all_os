// Exclusão da PRÓPRIA conta (DELETE /api/me) — distinta da exclusão de DADOS,
// que continua sendo só por e-mail a suporte@allos.org.br (ver política de
// privacidade). Este endpoint só derruba o login.
const { app, request, resetData, loginAs, authHeader, loginVisitor, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');

function lerUsers() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf-8'));
}

describe('DELETE /api/me — exclusão da própria conta', () => {
  beforeEach(resetData);

  it('exige a senha atual', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({});
    expect(res.status).toBe(400);
    expect(lerUsers().some((u) => u.id === '3')).toBe(true);
  });

  // 400, não 401: o cliente trata TODO 401 como sessão expirada e desloga na
  // hora (ver api.js) — aqui a sessão continua válida, só a senha está errada.
  it('recusa com senha errada e mantém a conta', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'senhaerrada' });
    expect(res.status).toBe(400);
    expect(lerUsers().some((u) => u.id === '3')).toBe(true);
  });

  it('exclui a conta do aluno com a senha certa, e o token para de funcionar', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'testpass1234' });
    expect(res.status).toBe(200);
    expect(lerUsers().some((u) => u.id === '3')).toBe(false);

    const me = await request(app).get('/api/me').set(authHeader(token));
    expect(me.status).toBe(401);
  });

  it('bloqueia admin de excluir a própria conta', async () => {
    const token = await loginAs('admin');
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'testpass1234' });
    expect(res.status).toBe(400);
    expect(lerUsers().some((u) => u.id === '1')).toBe(true);
  });

  it('bloqueia supervisor com alunos vinculados', async () => {
    const token = await loginAs('prof'); // id 2, tem o aluno id 3 vinculado
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'testpass1234' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/vinculado/);
    expect(lerUsers().some((u) => u.id === '2')).toBe(true);
  });

  it('supervisor sem aluno vinculado consegue excluir', async () => {
    // Reatribui o único aluno do prof2 (id 4) pro prof (id 2) antes.
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/users/5').set(authHeader(admin)).send({ teacherId: '2' });

    const token = await loginAs('prof2');
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'testpass1234' });
    expect(res.status).toBe(200);
    expect(lerUsers().some((u) => u.id === '4')).toBe(false);
  });

  it('visitante não tem conta para excluir', async () => {
    const token = await loginVisitor();
    const res = await request(app).delete('/api/me').set(authHeader(token)).send({ password: 'qualquer' });
    expect(res.status).toBe(400);
  });
});
