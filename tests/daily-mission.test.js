// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

// Cria uma sidequest no banco (admin) e devolve a entrada criada.
async function seedBankMission(token, title = 'Reformular a queixa') {
  const r = await request(app).post('/api/sidequests/bank').set(authHeader(token)).send({
    title,
    description: 'Reformule a queixa inicial do paciente ao menos uma vez durante o atendimento.',
    rewardTitle: 'Reformulador',
  });
  return r.body;
}

// Avaliação fake com o bloco de resultado da missão diária.
function evalWithDaily(completed) {
  return `Análise do atendimento... prosa clínica.\n\n[missao-diaria-resultado]\n{"daily_completed": ${completed}, "justification": "teste"}\n\n[notas-supervisor]\n{"1":5,"2":5,"3":5,"4":5,"5":5,"6":5}`;
}

describe('Missão diária (rotação do banco de sidequests)', () => {
  beforeEach(() => resetData());

  it('banco vazio → não há missão diária', async () => {
    const aluno = await loginAs('aluno');
    const mine = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(mine.status).toBe(200);
    expect(mine.body.mission).toBeNull();
  });

  it('/api/me/daily-mission expõe a missão de hoje quando o banco tem entradas', async () => {
    const admin = await loginAs('admin');
    await seedBankMission(admin);
    const aluno = await loginAs('aluno');
    const dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(dm.status).toBe(200);
    expect(dm.body.mission.title).toBe('Reformular a queixa');
    expect(dm.body.mission.description).toBeTruthy();
    expect(dm.body.completed).toBe(false);
    // não vaza campos internos sensíveis
    expect(dm.body.mission.createdBy).toBeUndefined();
  });

  it('missão diária e sidequest atribuída COEXISTEM (uma não anula a outra)', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    const def = await seedBankMission(admin);
    // admin atribui a sidequest ao aluno '3'
    await request(app).post('/api/sidequests/assign').set(authHeader(admin)).send({ userId: '3', sidequestId: def.id });

    const sq = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
    const dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(sq.body.active).toBeTruthy();   // sidequest ativa
    expect(dm.body.mission).toBeTruthy();  // missão diária presente ao mesmo tempo
    expect(dm.body.completed).toBe(false);
  });

  it('cumprir a missão diária no Treinamento concede recompensa e marca como concluída', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    const def = await seedBankMission(admin);

    const res = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: evalWithDaily(true),
    });
    expect(res.status).toBe(200);
    expect(res.body.dailyMission).toBeTruthy();
    expect(res.body.dailyMission.completed).toBe(true);
    expect(res.body.dailyMission.rewardTitleLabel).toBe('Reformulador');

    // agora a missão de hoje aparece como concluída
    const dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(dm.body.completed).toBe(true);

    // e entra como conquista (quest) na gamificação + vira título selecionável
    const gami = (await request(app).get('/api/gamification/3').set(authHeader(aluno))).body;
    expect(gami.achievements.some((a) => a.id === def.rewardTitleId && a.earned)).toBe(true);
  });

  it('não dá pra farmar: cumprir de novo não duplica a recompensa', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    await seedBankMission(admin);
    const body = {
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      messages: [{ role: 'user', content: 'oi' }], evaluation: evalWithDaily(true),
    };
    await request(app).post('/api/logs').set(authHeader(aluno)).send(body);
    const again = await request(app).post('/api/logs').set(authHeader(aluno)).send(body);
    // já concluída → não há novo outcome de missão diária
    expect(again.body.dailyMission).toBeNull();

    const sq = (await request(app).get('/api/me/sidequest').set(authHeader(aluno))).body;
    expect(sq.completed.length).toBe(1); // só uma recompensa registrada
  });

  it('a sidequest atribuída continua sendo avaliada normalmente (independente da diária)', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    const def = await seedBankMission(admin, 'Sustentar silêncio');
    await request(app).post('/api/sidequests/assign').set(authHeader(admin)).send({ userId: '3', sidequestId: def.id });
    // bloco da sidequest (não da diária)
    const evaluation = `Prosa...\n\n[sidequest-resultado]\n{"sidequest_completed": true, "justification": "ok"}\n\n[notas-supervisor]\n{"1":5,"2":5,"3":5,"4":5,"5":5,"6":5}`;
    const res = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      messages: [{ role: 'user', content: 'oi' }], evaluation,
    });
    expect(res.body.sidequest).toBeTruthy();
    expect(res.body.sidequest.completed).toBe(true);
  });
});
