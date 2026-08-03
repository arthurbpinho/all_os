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

  // Regra do dono: UMA ou OUTRA, nunca as duas. Sidequest do supervisor tem
  // prioridade; sem sidequest, a diária assume. O aluno nunca fica sem missão.
  it('sidequest ativa DESLIGA a missão diária; ao remover a sidequest, a diária volta', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    const def = await seedBankMission(admin);

    // Sem sidequest: a diária está no ar.
    let dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(dm.body.mission).toBeTruthy();

    // Supervisor atribui a sidequest ao aluno '3' → a diária sai do ar.
    await request(app).post('/api/sidequests/assign').set(authHeader(admin)).send({ userId: '3', sidequestId: def.id });
    const sq = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
    dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(sq.body.active).toBeTruthy();
    expect(dm.body.mission).toBeNull();
    expect(dm.body.pausedBySidequest).toBe(true);

    // Removida a sidequest, a diária volta a valer (nunca fica sem missão).
    await request(app).post('/api/sidequests/unassign').set(authHeader(admin)).send({ userId: '3' });
    dm = await request(app).get('/api/me/daily-mission').set(authHeader(aluno));
    expect(dm.body.mission).toBeTruthy();
    expect(dm.body.pausedBySidequest).toBeUndefined();
  });

  it('com sidequest ativa, bloco de missão diária no avaliador NÃO concede a diária', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    // Duas entradas no banco: descobrimos qual é a diária de hoje e atribuímos a
    // OUTRA como sidequest — assim a diária tem recompensa própria e o teste
    // isola de fato a exclusividade (não o dedup de recompensa).
    const a = await seedBankMission(admin, 'Missão A');
    const b = await seedBankMission(admin, 'Missão B');
    const hoje = (await request(app).get('/api/me/daily-mission').set(authHeader(aluno))).body.mission;
    const outra = [a, b].find((s) => s.title !== hoje.title);
    await request(app).post('/api/sidequests/assign').set(authHeader(admin)).send({ userId: '3', sidequestId: outra.id });

    // O avaliador emite os DOIS blocos (cenário defensivo: não deve valer a diária).
    const evaluation = [
      'Prosa...', '',
      '[sidequest-resultado]', '{"sidequest_completed": true, "justification": "ok"}', '',
      '[missao-diaria-resultado]', '{"daily_completed": true, "justification": "ok"}', '',
      '[notas-supervisor]', '{"1":5,"2":5,"3":5,"4":5,"5":5,"6":5}',
    ].join('\n');
    const res = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      messages: [{ role: 'user', content: 'oi' }], evaluation,
    });
    expect(res.body.sidequest.completed).toBe(true);  // a sidequest conta
    expect(res.body.dailyMission).toBeNull();         // a diária, não

    // Só a recompensa da sidequest foi registrada.
    const sq = (await request(app).get('/api/me/sidequest').set(authHeader(aluno))).body;
    expect(sq.completed.length).toBe(1);
    expect(sq.completed[0].rewardTitleId).toBe(outra.rewardTitleId);
    expect(sq.completed[0].daily).toBeUndefined();
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

  it('a sidequest atribuída continua sendo avaliada normalmente (ela é a missão da vez)', async () => {
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
