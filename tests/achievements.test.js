// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

// Helpers locais
function find(list, id) { return list.find((a) => a.id === id); }
async function gami(token, userId) {
  return (await request(app).get(`/api/gamification/${userId}`).set(authHeader(token))).body;
}
async function logSession(token, extra = {}) {
  return request(app).post('/api/logs').set(authHeader(token))
    .send({ type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia', messages: [{ role: 'user', content: 'oi' }], ...extra });
}

describe('Conquistas — claim, tiers e progresso', () => {
  beforeEach(() => resetData());

  it('nada é resgatado automaticamente: cumprir critério deixa "claimable", não "claimed"', async () => {
    const aluno = await loginAs('aluno');
    await logSession(aluno, { score: 50 });
    const g = await gami(aluno, '3');
    const first = find(g.achievements, 'first_session');
    expect(first.unlocked).toBe(true);
    expect(first.claimable).toBe(true);
    expect(first.claimed).toBe(false);
    expect(first.earned).toBe(false);
  });

  it('resgate (claim) grava a conquista e é idempotente', async () => {
    const aluno = await loginAs('aluno');
    await logSession(aluno, { score: 50 });
    const claim = await request(app).post('/api/achievements/first_session/claim').set(authHeader(aluno));
    expect(claim.status).toBe(200);
    expect(claim.body.claimed).toBe(true);

    const g = await gami(aluno, '3');
    const first = find(g.achievements, 'first_session');
    expect(first.claimed).toBe(true);
    expect(first.earned).toBe(true);
    expect(first.claimable).toBe(false);
    expect(first.earnedAt).toBeTruthy();

    // resgatar de novo não quebra nem muda a data
    const again = await request(app).post('/api/achievements/first_session/claim').set(authHeader(aluno));
    expect(again.status).toBe(200);
    expect(again.body.claimedAt).toBe(first.earnedAt);
  });

  it('não resgata o que não foi cumprido (403) e id inválido dá 404', async () => {
    const aluno = await loginAs('aluno');
    const notMet = await request(app).post('/api/achievements/perfeicao/claim').set(authHeader(aluno));
    expect(notMet.status).toBe(403);
    const bad = await request(app).post('/api/achievements/nao_existe/claim').set(authHeader(aluno));
    expect(bad.status).toBe(404);
  });

  it('visitante não resgata conquista (403)', async () => {
    const v = await loginVisitor();
    const r = await request(app).post('/api/achievements/first_session/claim').set(authHeader(v));
    expect(r.status).toBe(403);
  });

  it('detecta conquistas via sessões: ranqueada, excelência (≥90) e perfeição (100)', async () => {
    const aluno = await loginAs('aluno');
    await logSession(aluno, { mode: 'competitive', score: 100 });
    const g = await gami(aluno, '3');
    expect(find(g.achievements, 'first_ranked').claimable).toBe(true);
    expect(find(g.achievements, 'excelencia').claimable).toBe(true);
    expect(find(g.achievements, 'perfeicao').claimable).toBe(true);
  });

  it('"Eficiência" exige sessão rápida com nota acima de 60 (≤60 não conta)', async () => {
    const aluno = await loginAs('aluno');
    await logSession(aluno, { score: 55, durationSeconds: 120 }); // rápido mas nota baixa
    let g = await gami(aluno, '3');
    expect(find(g.achievements, 'eficiencia').unlocked).toBe(false);
    await logSession(aluno, { score: 75, durationSeconds: 120 }); // rápido e nota >60
    g = await gami(aluno, '3');
    expect(find(g.achievements, 'eficiencia').unlocked).toBe(true);
  });

  it('barra de progresso: "centena" expõe target 100 e progress acompanha as sessões', async () => {
    const aluno = await loginAs('aluno');
    await logSession(aluno, { score: 10 });
    await logSession(aluno, { score: 10 });
    const g = await gami(aluno, '3');
    const centena = find(g.achievements, 'centena');
    expect(centena.target).toBe(100);
    expect(centena.progress).toBe(2);
    expect(centena.claimable).toBe(false);
  });

  it('"Não sou mais o Isaac" dispara ao trocar a foto de perfil', async () => {
    const aluno = await loginAs('aluno');
    let g = await gami(aluno, '3');
    expect(find(g.achievements, 'changed_photo').unlocked).toBe(false);
    await request(app).put('/api/users/3').set(authHeader(aluno)).send({ profilePhoto: '/profiles_icon/nova.png' });
    g = await gami(aluno, '3');
    expect(find(g.achievements, 'changed_photo').unlocked).toBe(true);
  });

  it('as metas têm exatamente os três tiers bronze/prata/ouro', async () => {
    const aluno = await loginAs('aluno');
    const g = await gami(aluno, '3');
    const tiers = new Set(g.achievements.map((a) => a.tier));
    expect(tiers.has('bronze')).toBe(true);
    expect(tiers.has('silver')).toBe(true);
    expect(tiers.has('gold')).toBe(true);
    // não há mais o tier 'platinum' (foi todo redistribuído)
    expect(g.achievements.some((a) => a.tier === 'platinum')).toBe(false);
  });

  it('objetivos diários agora são Sessão diária + Competindo', async () => {
    const aluno = await loginAs('aluno');
    const g = await gami(aluno, '3');
    const ids = g.dailyMissions.map((m) => m.id);
    expect(ids).toContain('daily_session');
    expect(ids).toContain('daily_ranked');
    expect(g.dailyMissions.length).toBe(2);
  });
});
