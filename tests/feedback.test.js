// Feedback da plataforma (POST /api/feedback).
//
// O que este arquivo garante:
//   1. o Aluno Externo dá UM feedback, anônimo: sem nome e sem o id da conta;
//   2. depois dele, o pedido some (feedbackPendente) e um segundo é recusado;
//   3. cada feedback novo avisa os admins no sino;
//   4. o visitante continua mandando feedback como antes.
const { app, request, resetData, loginAs, loginVisitor, authHeader, db } = require('./helpers');

async function loginExterno() {
  await db.query(`UPDATE users SET role = 'external', teacher_id = NULL WHERE id = 5`);
  return loginAs('aluno2');
}

async function avisosDeFeedback() {
  const { rows } = await db.query(
    `SELECT user_id, doc FROM notificacoes WHERE doc->>'type' = 'feedback_received' ORDER BY user_id`,
  );
  return rows;
}

describe('feedback da plataforma', () => {
  beforeEach(async () => {
    await resetData();
  });

  it('Aluno Externo: um feedback anônimo, e o pedido some depois dele', async () => {
    const externo = await loginExterno();
    const antes = await request(app).get('/api/session-quota').set(authHeader(externo));
    expect(antes.body.feedbackPendente).toBe(true);

    const r = await request(app).post('/api/feedback').set(authHeader(externo))
      .send({ stars: 4, message: 'Muito bom, queria mais sessões.' });
    expect(r.status).toBe(200);

    const { rows } = await db.query('SELECT user_id, user_name, role, stars FROM feedback');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_name: '', role: 'external', stars: 4 });
    expect(rows[0].user_id).toMatch(/^anon-[0-9a-f]{32}$/);
    expect(rows[0].user_id).not.toBe('5'); // nunca o id da conta

    const depois = await request(app).get('/api/session-quota').set(authHeader(externo));
    expect(depois.body.feedbackPendente).toBe(false);

    const segundo = await request(app).post('/api/feedback').set(authHeader(externo)).send({ stars: 5 });
    expect(segundo.status).toBe(409);

    const admin = await loginAs('admin');
    const lista = await request(app).get('/api/admin/feedback').set(authHeader(admin));
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0]).toMatchObject({ userId: null, userName: '', role: 'external', stars: 4 });
  });

  it('só o Aluno Externo tem o pedido pendente', async () => {
    const interno = await loginAs('aluno');
    const r = await request(app).get('/api/session-quota').set(authHeader(interno));
    expect(r.body.feedbackPendente).toBe(false);
  });

  it('cada feedback novo avisa os admins no sino, sem identificar o externo', async () => {
    const externo = await loginExterno();
    await request(app).post('/api/feedback').set(authHeader(externo)).send({ stars: 3, message: 'Ok.' });
    const visitante = await loginVisitor();
    await request(app).post('/api/feedback').set(authHeader(visitante)).send({ message: 'Gostei!' });

    const { rows: admins } = await db.query(`SELECT id::text FROM users WHERE role = 'admin' AND excluido_em IS NULL`);
    const avisos = await avisosDeFeedback();
    expect(avisos).toHaveLength(2 * admins.length);
    expect(avisos.every((a) => admins.some((x) => x.id === a.user_id))).toBe(true);

    const textos = avisos.map((a) => a.doc.message);
    expect(textos).toContain('★★★☆☆ Aluno Externo (anônimo): Ok.');
    expect(textos).toContain('Visitante: Gostei!');
  });
});
