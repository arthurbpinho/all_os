// Verificação de segurança do login e do cadastro (demandas.md §16.8), de ponta
// a ponta, com os limites de tentativa desligados (os limites têm arquivo
// próprio: seguranca-limites.test.js).
//
// O que este arquivo prova:
//   1. o login não entrega quem tem conta (conta inexistente, senha errada e
//      conta excluída respondem igual);
//   2. token forjado, vencido, de outro tipo ou de conta excluída não abre sessão,
//      e o papel vem da conta viva, não do token;
//   3. entrada com formato inesperado não derruba a rota;
//   4. cabeçalhos de segurança e CORS;
//   5. os links de e-mail (confirmação e nova senha) são de uso único, vencem, e
//      um não serve no lugar do outro.
const { app, request, resetData, loginAs, authHeader, db, TEST_PASSWORD } = require('./helpers');
const jwt = require('jsonwebtoken');
const mailer = require('../server/email');

const SEGREDO = process.env.JWT_SECRET;

// O token mais recente que saiu por e-mail (sem Graph, os envios ficam na captura
// em memória do módulo de e-mail).
function tokenDoUltimoEmail() {
  const enviado = mailer.emailsCapturados().reverse().find((e) => /token=/.test(e.text || ''));
  if (!enviado) throw new Error('Nenhum e-mail com link capturado');
  return /token=([A-Za-z0-9_-]+)/.exec(enviado.text)[1];
}

// Conta de aluno externo com e-mail confirmado, pelo fluxo público de verdade.
async function contaConfirmada(username, email) {
  mailer.limparCapturados();
  const cad = await request(app).post('/api/cadastro').send({
    username, name: 'Pessoa Teste', email, password: 'Ab1@cdef', aceiteTermos: true,
  });
  expect(cad.status).toBe(200);
  const conf = await request(app).post('/api/confirmar-email').send({ token: tokenDoUltimoEmail() });
  expect(conf.status).toBe(200);
  return conf.body;
}

beforeEach(async () => {
  await resetData();
  mailer.limparCapturados();
});

describe('login não entrega quem tem conta', () => {
  it('conta inexistente, senha errada e conta excluída respondem exatamente igual', async () => {
    const inexistente = await request(app).post('/api/login').send({ username: 'ninguem.aqui', password: 'Qualquer1!' });
    const senhaErrada = await request(app).post('/api/login').send({ username: 'aluno', password: 'Errada123!' });

    const aluno = await loginAs('aluno');
    await request(app).delete('/api/me').set(authHeader(aluno)).send({ password: TEST_PASSWORD }).expect(200);
    const excluida = await request(app).post('/api/login').send({ username: 'aluno', password: TEST_PASSWORD });

    for (const r of [inexistente, senhaErrada, excluida]) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'Credenciais inválidas' });
    }
  });

  it('a resposta de login nunca leva o hash da senha', async () => {
    const res = await request(app).post('/api/login').send({ username: 'aluno', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
  });
});

describe('sessão: só token legítimo de conta viva', () => {
  const me = (token) => request(app).get('/api/me').set(authHeader(token));

  it('token sem assinatura (alg none) ou assinado com outro segredo é recusado', async () => {
    const semAssinatura = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: '1', role: 'admin', tv: 0 })).toString('base64url'),
      '',
    ].join('.');
    expect((await me(semAssinatura)).status).toBe(401);

    const outroSegredo = jwt.sign({ sub: '1', role: 'admin', tv: 0 }, 'b'.repeat(48));
    expect((await me(outroSegredo)).status).toBe(401);
  });

  it('token vencido é recusado', async () => {
    const vencido = jwt.sign({ sub: '3', role: 'therapist', tv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, SEGREDO);
    expect((await me(vencido)).status).toBe(401);
  });

  it('token assinado de OUTRO tipo (candidato do seletivo, vale de duelo) não vira sessão', async () => {
    const candidato = jwt.sign({ sub: 'sel-123-abc', role: 'candidate', characterId: 'fp-test-1', candidate: {} }, SEGREDO);
    const valeDeDuelo = jwt.sign({ purpose: 'duel-claim', duelId: 'duel-1', side: 'opponent', visitorId: 'visitor-x' }, SEGREDO);
    for (const t of [candidato, valeDeDuelo]) {
      const r = await me(t);
      expect(r.status).toBe(401);
    }
  });

  it('token de conta excluída deixa de valer na hora', async () => {
    const aluno = await loginAs('aluno');
    await request(app).delete('/api/me').set(authHeader(aluno)).send({ password: TEST_PASSWORD }).expect(200);
    expect((await me(aluno)).status).toBe(401);
  });

  it('o papel vem da conta, não do token: rebaixado, perde o acesso com o mesmo token', async () => {
    const admin = await loginAs('admin');
    // O supervisor 'prof' vira aluno; o token dele ainda diz supervisor.
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/benchmark-simulacao/fila').set(authHeader(prof))).status).toBe(200);

    await db.query(`UPDATE users SET role = 'therapist', teacher_id = 4 WHERE id = 2`);
    expect((await request(app).get('/api/benchmark-simulacao/fila').set(authHeader(prof))).status).toBe(403);
    expect((await me(prof)).body.user.role).toBe('therapist');
    expect(admin).toBeTruthy();
  });

  it('token de visitante não alcança rota de conta nem de admin', async () => {
    const v = await request(app).post('/api/login/visitor').send({});
    const visitante = v.body.token;
    expect((await request(app).post('/api/me/password').set(authHeader(visitante))
      .send({ currentPassword: 'x', newPassword: 'Ab1@cdefgh' })).status).toBe(400);
    expect((await request(app).get('/api/admin/error-logs').set(authHeader(visitante))).status).toBe(403);
    expect((await request(app).post('/api/me/email').set(authHeader(visitante))
      .send({ senhaAtual: 'x', novoEmail: 'v@exemplo.invalid' })).status).toBe(403);
  });
});

describe('entrada com formato inesperado não derruba o login', () => {
  it('username ou senha como objeto, lista ou texto gigante: 400/401, nunca 500', async () => {
    const casos = [
      { username: { $ne: '' }, password: 'x' },
      { username: ['admin'], password: ['testpass1234'] },
      { username: 'a'.repeat(200000), password: 'x' },
      { username: 'aluno', password: 'x'.repeat(1024 * 1024) },
      { username: 'aluno', password: { $gt: '' } },
    ];
    for (const corpo of casos) {
      const r = await request(app).post('/api/login').send(corpo);
      expect([400, 401], JSON.stringify(corpo).slice(0, 60)).toContain(r.status);
    }
  });

  it('senha certa continua valendo depois do corte de tamanho da comparação', async () => {
    const r = await request(app).post('/api/login').send({ username: 'ALUNO', password: TEST_PASSWORD });
    expect(r.status).toBe(200);
  });

  it('cadastro com campos do tipo errado responde 400, não 500', async () => {
    const r = await request(app).post('/api/cadastro').send({
      username: { x: 1 }, name: ['a'], email: 12345, password: null, aceiteTermos: 'sim',
    });
    expect(r.status).toBe(400);
  });
});

describe('cabeçalhos de segurança e CORS', () => {
  it('a API sai com os cabeçalhos de proteção e sem anunciar o servidor', async () => {
    const r = await request(app).get('/api/config');
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('origem de fora recebe 403 sem sujar o painel de Logs de Erro', async () => {
    const r = await request(app).post('/api/login').set('Origin', 'https://site-malicioso.example')
      .send({ username: 'aluno', password: TEST_PASSWORD });
    expect(r.status).toBe(403);
    expect(r.body.token).toBeUndefined();

    const admin = await loginAs('admin');
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    expect(painel.body.errors.some((e) => /CORS/i.test(e.message || ''))).toBe(false);
  });

  it('o front local e a mesma origem continuam passando', async () => {
    const dev = await request(app).get('/api/config').set('Origin', 'http://localhost:5173');
    expect(dev.status).toBe(200);
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const mesma = await request(app).get('/api/config').set('Host', 'app.exemplo.invalid').set('Origin', 'https://app.exemplo.invalid');
    expect(mesma.status).toBe(200);
  });
});

describe('links de e-mail: uso único, validade e cada um no seu lugar', () => {
  it('link de nova senha vale uma vez só', async () => {
    await contaConfirmada('bia.externa', 'bia@exemplo.invalid');
    mailer.limparCapturados();
    await request(app).post('/api/senha/esqueci').send({ email: 'bia@exemplo.invalid' }).expect(200);
    const token = tokenDoUltimoEmail();

    const primeira = await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Nova1@senha' });
    expect(primeira.status).toBe(200);
    const segunda = await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Outra2@senha' });
    expect(segunda.status).toBe(400);

    expect((await request(app).post('/api/login').send({ username: 'bia.externa', password: 'Nova1@senha' })).status).toBe(200);
  });

  it('link de nova senha vencido (1h) é recusado', async () => {
    await contaConfirmada('caio.externo', 'caio@exemplo.invalid');
    mailer.limparCapturados();
    await request(app).post('/api/senha/esqueci').send({ email: 'caio@exemplo.invalid' }).expect(200);
    const token = tokenDoUltimoEmail();
    await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);

    const r = await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Nova1@senha' });
    expect(r.status).toBe(400);
  });

  it('link de confirmação vencido (48h) não cria a conta', async () => {
    await request(app).post('/api/cadastro').send({
      username: 'duda.externa', name: 'Duda Teste', email: 'duda@exemplo.invalid', password: 'Ab1@cdef', aceiteTermos: true,
    }).expect(200);
    const token = tokenDoUltimoEmail();
    await db.query(`UPDATE pending_registrations SET expires_at = now() - interval '1 minute'`);

    expect((await request(app).post('/api/confirmar-email').send({ token })).status).toBe(400);
    expect((await request(app).post('/api/login').send({ username: 'duda.externa', password: 'Ab1@cdef' })).status).toBe(401);
  });

  it('link de nova senha não confirma cadastro, e link de cadastro não redefine senha', async () => {
    await contaConfirmada('eva.externa', 'eva@exemplo.invalid');
    mailer.limparCapturados();
    await request(app).post('/api/senha/esqueci').send({ email: 'eva@exemplo.invalid' }).expect(200);
    const tokenReset = tokenDoUltimoEmail();
    expect((await request(app).post('/api/confirmar-email').send({ token: tokenReset })).status).toBe(400);

    mailer.limparCapturados();
    await request(app).post('/api/cadastro').send({
      username: 'fabi.externa', name: 'Fabi Teste', email: 'fabi@exemplo.invalid', password: 'Ab1@cdef', aceiteTermos: true,
    }).expect(200);
    const tokenCadastro = tokenDoUltimoEmail();
    expect((await request(app).post('/api/senha/redefinir').send({ token: tokenCadastro, newPassword: 'Nova1@senha' })).status).toBe(400);
  });

  it('reenviar confirmação para endereço sem pendência responde igual e não envia nada', async () => {
    const r = await request(app).post('/api/cadastro/reenviar').send({ email: 'ninguem@exemplo.invalid' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(mailer.emailsCapturados()).toHaveLength(0);
  });

  it('reenviar mata o link anterior', async () => {
    await request(app).post('/api/cadastro').send({
      username: 'gil.externo', name: 'Gil Teste', email: 'gil@exemplo.invalid', password: 'Ab1@cdef', aceiteTermos: true,
    }).expect(200);
    const antigo = tokenDoUltimoEmail();
    await request(app).post('/api/cadastro/reenviar').send({ email: 'gil@exemplo.invalid' }).expect(200);
    const novo = tokenDoUltimoEmail();
    expect(novo).not.toBe(antigo);

    expect((await request(app).post('/api/confirmar-email').send({ token: antigo })).status).toBe(400);
    expect((await request(app).post('/api/confirmar-email').send({ token: novo })).status).toBe(200);
  });

  it('nenhum token de link fica em texto no banco, só o hash', async () => {
    await request(app).post('/api/cadastro').send({
      username: 'hana.externa', name: 'Hana Teste', email: 'hana@exemplo.invalid', password: 'Ab1@cdef', aceiteTermos: true,
    }).expect(200);
    const token = tokenDoUltimoEmail();
    const { rows } = await db.query('SELECT row_to_json(p)::text AS linha FROM pending_registrations p');
    expect(rows.map((r) => r.linha).join('\n')).not.toContain(token);
    // E a senha da pendência já está com hash.
    expect(rows.map((r) => r.linha).join('\n')).not.toContain('Ab1@cdef');
  });
});
