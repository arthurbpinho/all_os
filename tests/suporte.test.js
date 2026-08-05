// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

// Suporte: a mensagem do usuário cai no painel de Logs de Erro do admin (canal
// provisório, decisão do dono), marcada com where 'suporte/mensagem' e sem
// status HTTP (não é falha). O código devolvido é a ponte usuário ↔ admin.
describe('suporte (/api/suporte)', () => {
  beforeEach(() => resetData());

  async function enviar(token, body) {
    return request(app).post('/api/suporte').set(authHeader(token)).send(body);
  }

  it('grava a mensagem nos logs de erro e devolve o código ao usuário', async () => {
    const aluno = await loginAs('aluno');
    const res = await enviar(aluno, { subject: 'A avaliação não carregou', message: 'Travou na tela de avaliando.' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.codigo).toMatch(/^err-/);

    const admin = await loginAs('admin');
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    const entrada = painel.body.errors.find((e) => e.id === res.body.codigo);
    expect(entrada).toBeTruthy();
    expect(entrada.where).toBe('suporte/mensagem');
    expect(entrada.message).toBe('Travou na tela de avaliando.');
    expect(entrada.extra.assunto).toBe('A avaliação não carregou');
    expect(entrada.actor.role).toBe('therapist');
    // Não é falha: sem status HTTP e sem stack.
    expect(entrada.status).toBeNull();
    expect(entrada.stack).toBeNull();
  });

  it('assunto é opcional', async () => {
    const aluno = await loginAs('aluno');
    const res = await enviar(aluno, { message: 'Só uma sugestão.' });
    expect(res.status).toBe(200);

    const admin = await loginAs('admin');
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    const entrada = painel.body.errors.find((e) => e.id === res.body.codigo);
    expect(entrada.extra.assunto).toBe('(sem assunto)');
  });

  it('recusa mensagem vazia e mensagem acima do limite', async () => {
    const aluno = await loginAs('aluno');
    expect((await enviar(aluno, { message: '   ' })).status).toBe(400);
    expect((await enviar(aluno, {})).status).toBe(400);
    // Acima do limite recusa em vez de truncar sem avisar.
    const longa = await enviar(aluno, { message: 'x'.repeat(1001) });
    expect(longa.status).toBe(400);
    expect(longa.body.error).toMatch(/1000/);
    // No limite exato passa.
    expect((await enviar(aluno, { message: 'x'.repeat(1000) })).status).toBe(200);
  });

  it('visitante também consegue pedir ajuda', async () => {
    const visitante = await loginVisitor();
    const res = await enviar(visitante, { message: 'Não consegui entrar na minha conta.' });
    expect(res.status).toBe(200);

    const admin = await loginAs('admin');
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    const entrada = painel.body.errors.find((e) => e.id === res.body.codigo);
    expect(entrada.actor.role).toBe('visitor');
  });

  it('exige autenticação', async () => {
    const res = await request(app).post('/api/suporte').send({ message: 'oi' });
    expect(res.status).toBe(401);
  });
});
