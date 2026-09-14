// Duelo feito como visitante (link aberto) levado para uma conta nova.
//
// O visitante tem id efêmero; no fim do duelo recebe um "vale" (claimToken)
// que viaja pelo cadastro e, na confirmação do e-mail, transfere o lado dele no
// duelo para a conta criada.
// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');
const mailer = require('../server/email');

const CHAR = 'fp-test-1';
const msgs = [
  { role: 'user', content: 'Olá, como você está?' },
  { role: 'assistant', content: 'Mais ou menos…' },
];

// Domínio .invalid (RFC 6761): nunca entrega e-mail de verdade.
function cadastro(n) {
  return {
    username: `duelista${n}`,
    name: 'Bia Duelista',
    email: `duelista${n}@exemplo.invalid`,
    password: 'Ab1@cdef',
    origem: '',
    aceiteTermos: true,
  };
}

function tokenDoUltimoEmail() {
  const alvo = mailer.emailsCapturados().reverse().find((e) => e.subject.includes('Confirme seu cadastro'));
  if (!alvo) throw new Error('Nenhum e-mail de confirmação capturado');
  return /token=([A-Za-z0-9_-]+)/.exec(alvo.text || '')[1];
}

async function cadastrarEConfirmar(n, duelClaim) {
  const res = await request(app).post('/api/cadastro').send({ ...cadastro(n), duelClaim });
  expect(res.status).toBe(200);
  const conf = await request(app).post('/api/confirmar-email').send({ token: tokenDoUltimoEmail() });
  expect(conf.status).toBe(200);
  return conf.body;
}

async function duelAbertoAceitoPorVisitante() {
  const aluno = await loginAs('aluno');
  const create = await request(app).post('/api/duel').set(authHeader(aluno))
    .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
  expect(create.status).toBe(200);
  const visitor = await loginVisitor();
  const accept = await request(app).post(`/api/duel/by-token/${create.body.token}/accept`).set(authHeader(visitor));
  expect(accept.status).toBe(200);
  return { aluno, visitor, duelId: create.body.id };
}

describe('duelo de visitante levado para a conta nova', () => {
  beforeEach(() => { resetData(); mailer.limparCapturados(); });

  it('vale só depois do envio; confirmar o cadastro transfere o duelo', async () => {
    const { aluno, visitor, duelId } = await duelAbertoAceitoPorVisitante();

    // Antes de enviar a sessão não há log a guardar.
    const antes = await request(app).get(`/api/duel/${duelId}`).set(authHeader(visitor));
    expect(antes.body.claimToken).toBeUndefined();

    const sub = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(visitor))
      .send({ messages: msgs, durationSeconds: 60 });
    const vale = sub.body.claimToken;
    expect(vale).toBeTypeOf('string');

    // Só o visitante recebe; e o vale não serve como sessão.
    const doDesafiante = await request(app).get(`/api/duel/${duelId}`).set(authHeader(aluno));
    expect(doDesafiante.body.claimToken).toBeUndefined();
    expect((await request(app).get('/api/me').set(authHeader(vale))).status).toBe(401);

    const conf = await cadastrarEConfirmar(1, vale);
    expect(conf.duelId).toBe(duelId);

    const daConta = await request(app).get(`/api/duel/${duelId}`).set(authHeader(conf.token));
    expect(daConta.status).toBe(200);
    expect(daConta.body.youAre).toBe('opponent');
    expect(daConta.body.opponent.isVisitor).toBe(false);
    expect(daConta.body.opponent.name).toBe('Bia Duelista');

    // O desafiante termina depois: o resultado já é da conta nova.
    const fim = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno))
      .send({ messages: msgs, durationSeconds: 60 });
    expect(fim.body.status).toBe('completed');
    const social = await request(app).get('/api/duels/social').set(authHeader(conf.token));
    expect(social.body.length).toBe(1);
    expect(social.body[0].opponent.name).toBe('Aluno A');

    // O id efêmero do visitante perdeu o acesso.
    expect((await request(app).get(`/api/duel/${duelId}`).set(authHeader(visitor))).status).toBe(403);
  });

  it('vale inválido não impede o cadastro; vale reaproveitado não mexe no duelo', async () => {
    const semVale = await cadastrarEConfirmar(2, 'nao-e-um-jwt');
    expect(semVale.duelId).toBeNull();

    const { visitor, duelId } = await duelAbertoAceitoPorVisitante();
    const sub = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(visitor))
      .send({ messages: msgs, durationSeconds: 60 });

    const primeira = await cadastrarEConfirmar(3, sub.body.claimToken);
    expect(primeira.duelId).toBe(duelId);

    const segunda = await cadastrarEConfirmar(4, sub.body.claimToken);
    expect(segunda.duelId).toBeNull();
    const d = await request(app).get(`/api/duel/${duelId}`).set(authHeader(primeira.token));
    expect(d.body.youAre).toBe('opponent');
  });

  it('token de sessão comum não vale como vale de duelo', async () => {
    const { visitor, duelId } = await duelAbertoAceitoPorVisitante();
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(visitor))
      .send({ messages: msgs, durationSeconds: 60 });
    const conf = await cadastrarEConfirmar(5, visitor);
    expect(conf.duelId).toBeNull();
  });
});
