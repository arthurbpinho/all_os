// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

// Duelos rodam em modo demonstração aqui (ANTHROPIC_API_KEY vazia), então a
// avaliação comparativa usa o fallback neutro: notas 5 pros dois → 50 × 50 →
// empate. O foco do teste é o fluxo (criar/convidar/aceitar/submeter/resultado),
// não a qualidade da avaliação.
describe('duelos', () => {
  beforeEach(() => resetData());

  const CHAR = 'fp-test-1';
  const msgs = [
    { role: 'user', content: 'Olá, como você está?' },
    { role: 'assistant', content: 'Mais ou menos…' },
  ];

  it('lista de oponentes traz terapeutas (exceto você) e nega visitante', async () => {
    const aluno = await loginAs('aluno');
    const res = await request(app).get('/api/duel/opponents').set(authHeader(aluno));
    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.userId);
    expect(ids).toContain('5');   // aluno2 é terapeuta
    expect(ids).not.toContain('3'); // não inclui você
    expect(ids).not.toContain('2'); // supervisor não entra

    const visitor = await loginVisitor();
    const vres = await request(app).get('/api/duel/opponents').set(authHeader(visitor));
    expect(vres.status).toBe(403);
  });

  it('fluxo completo de convite in-app: notifica, aceita, submete, gera resultado', async () => {
    const aluno = await loginAs('aluno');
    const aluno2 = await loginAs('aluno2');

    // 1. cria o duelo convidando aluno2 pelo sistema
    const create = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: CHAR, opponentUserId: '5', inviteMethod: 'system' });
    expect(create.status).toBe(200);
    const duelId = create.body.id;
    expect(create.body.youAre).toBe('challenger');
    expect(create.body.token).toBeTruthy();          // challenger vê o token
    expect(create.body.opponent.state).toBe('invited');

    // 2. aluno2 recebe a notificação de convite
    const notif = await request(app).get('/api/notifications').set(authHeader(aluno2));
    expect(notif.body.unread).toBe(1);
    const invite = notif.body.items.find((n) => n.type === 'duel_invite');
    expect(invite.duelId).toBe(duelId);

    // 3. aluno2 aceita
    const accept = await request(app).post(`/api/duel/${duelId}/accept`).set(authHeader(aluno2));
    expect(accept.status).toBe(200);
    expect(accept.body.youAre).toBe('opponent');
    expect(accept.body.opponent.accepted).toBe(true);

    // convite marcado como lido após aceitar
    const notif2 = await request(app).get('/api/notifications').set(authHeader(aluno2));
    expect(notif2.body.unread).toBe(0);

    // 4. challenger submete — fica pendente (oponente ainda não enviou)
    const sub1 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno))
      .send({ messages: msgs, durationSeconds: 120 });
    expect(sub1.status).toBe(200);
    expect(sub1.body.status).toBe('pending');

    // 5. oponente submete — dispara a avaliação comparativa e completa o duelo
    const sub2 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno2))
      .send({ messages: msgs, durationSeconds: 90 });
    expect(sub2.status).toBe(200);
    expect(sub2.body.status).toBe('completed');
    expect(sub2.body.result).toBeTruthy();
    // demo: empate 50 × 50
    expect(sub2.body.result.winner).toBe('draw');
    expect(sub2.body.result.scoreChallenger).toBe(50);
    expect(sub2.body.result.scoreOpponent).toBe(50);

    // 6. challenger vê o resultado ao consultar
    const get = await request(app).get(`/api/duel/${duelId}`).set(authHeader(aluno));
    expect(get.body.status).toBe('completed');
    expect(get.body.result.winner).toBe('draw');

    // 7. ambos recebem notificação de resultado
    const rn1 = await request(app).get('/api/notifications').set(authHeader(aluno));
    expect(rn1.body.items.some((n) => n.type === 'duel_result' && n.duelId === duelId)).toBe(true);
    const rn2 = await request(app).get('/api/notifications').set(authHeader(aluno2));
    expect(rn2.body.items.some((n) => n.type === 'duel_result' && n.duelId === duelId)).toBe(true);

    // 8. logs sociais — cada um vê o outro como oponente, 1 partida
    const soc1 = await request(app).get('/api/duels/social').set(authHeader(aluno));
    expect(soc1.body.length).toBe(1);
    expect(soc1.body[0].opponent.name).toBe('Aluno B');
    expect(soc1.body[0].count).toBe(1);
    expect(soc1.body[0].draws).toBe(1);

    const soc2 = await request(app).get('/api/duels/social').set(authHeader(aluno2));
    expect(soc2.body[0].opponent.name).toBe('Aluno A');
  });

  it('duelo aberto (WhatsApp/link) aceito por visitante', async () => {
    const aluno = await loginAs('aluno');

    const create = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
    expect(create.status).toBe(200);
    const { id: duelId, token } = create.body;
    expect(create.body.opponent.kind).toBe('open');

    // visitante abre o link
    const visitor = await loginVisitor();
    const byTok = await request(app).get(`/api/duel/by-token/${token}`).set(authHeader(visitor));
    expect(byTok.status).toBe(200);
    expect(byTok.body.challengerName).toBe('Aluno A');
    expect(byTok.body.character.name).toBe('Sofia Test');

    const accept = await request(app).post(`/api/duel/by-token/${token}/accept`).set(authHeader(visitor));
    expect(accept.status).toBe(200);
    expect(accept.body.opponent.isVisitor).toBe(true);

    // visitante e challenger submetem
    await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(visitor)).send({ messages: msgs, durationSeconds: 60 });
    const sub2 = await request(app).post(`/api/duel/${duelId}/submit`).set(authHeader(aluno)).send({ messages: msgs, durationSeconds: 60 });
    expect(sub2.body.status).toBe('completed');
    expect(sub2.body.result.winner).toBe('draw');

    // visitante não tem logs sociais (id efêmero)
    const vsoc = await request(app).get('/api/duels/social').set(authHeader(visitor));
    expect(vsoc.body).toEqual([]);

    // challenger vê o visitante como oponente
    const soc = await request(app).get('/api/duels/social').set(authHeader(aluno));
    expect(soc.body[0].opponent.isVisitor).toBe(true);
  });

  it('não deixa duelar consigo mesmo e nega acesso de não-participante', async () => {
    const aluno = await loginAs('aluno');
    const self = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: CHAR, opponentUserId: '3', inviteMethod: 'system' });
    expect(self.status).toBe(400);

    // cria um duelo aberto e tenta acessar como terceiro não-participante
    const create = await request(app).post('/api/duel').set(authHeader(aluno))
      .send({ characterId: CHAR, inviteMethod: 'whatsapp' });
    const outro = await loginAs('prof'); // supervisor, não participa
    const get = await request(app).get(`/api/duel/${create.body.id}`).set(authHeader(outro));
    expect(get.status).toBe(403);
  });
});
