// Cobre o fluxo de sidequests integrado ao Treinamento/Progressão:
// banco (supervisor/admin), atribuição (1 ativa por aluno, só dos seus alunos),
// conclusão via [sidequest-resultado] no save do log, e o título de recompensa
// virando subtítulo selecionável.

const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

async function createBankSidequest(token, over = {}) {
  const res = await request(app).post('/api/sidequests/bank').set(authHeader(token)).send({
    title: 'Sustentar o silêncio',
    description: 'Em ao menos um momento, sustente um silêncio terapêutico sem preenchê-lo.',
    rewardTitle: 'Mestre do Silêncio',
    ...over,
  });
  return res;
}

describe('sidequests', () => {
  beforeEach(() => resetData());

  describe('banco', () => {
    it('supervisor cria e lista sidequests no banco', async () => {
      const token = await loginAs('prof');
      const created = await createBankSidequest(token);
      expect(created.status).toBe(200);
      expect(created.body.id).toMatch(/^sq-/);
      expect(created.body.rewardTitleId).toBe('qt-' + created.body.id);

      const list = await request(app).get('/api/sidequests/bank').set(authHeader(token));
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);
      expect(list.body[0].rewardTitleLabel).toBe('Mestre do Silêncio');
    });

    it('therapist e visitante NÃO acessam o banco (403)', async () => {
      const aluno = await loginAs('aluno');
      const visitor = await loginVisitor();
      expect((await request(app).get('/api/sidequests/bank').set(authHeader(aluno))).status).toBe(403);
      expect((await request(app).post('/api/sidequests/bank').set(authHeader(aluno)).send({ title: 'x', description: 'y', rewardTitle: 'z' })).status).toBe(403);
      expect((await request(app).get('/api/sidequests/bank').set(authHeader(visitor))).status).toBe(403);
    });

    it('rejeita criação sem campos obrigatórios', async () => {
      const token = await loginAs('prof');
      const res = await request(app).post('/api/sidequests/bank').set(authHeader(token)).send({ title: 'só título' });
      expect(res.status).toBe(400);
    });
  });

  describe('atribuição', () => {
    it('supervisor atribui ao seu aluno; aluno vê a ativa em /api/me/sidequest', async () => {
      const prof = await loginAs('prof');
      const sq = (await createBankSidequest(prof)).body;
      const assign = await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq.id });
      expect(assign.status).toBe(200);
      expect(assign.body.active.title).toBe('Sustentar o silêncio');

      const aluno = await loginAs('aluno');
      const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
      expect(mine.status).toBe(200);
      expect(mine.body.active.title).toBe('Sustentar o silêncio');
      expect(mine.body.active.description).toContain('silêncio');
    });

    it('só 1 ativa por aluno — atribuir de novo substitui', async () => {
      const prof = await loginAs('prof');
      const sq1 = (await createBankSidequest(prof, { title: 'Missão 1' })).body;
      const sq2 = (await createBankSidequest(prof, { title: 'Missão 2' })).body;
      await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq1.id });
      await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq2.id });
      const got = await request(app).get('/api/sidequests/student/3').set(authHeader(prof));
      expect(got.body.active.title).toBe('Missão 2');
    });

    it('supervisor NÃO atribui a aluno de outro supervisor (403)', async () => {
      const prof = await loginAs('prof');
      const sq = (await createBankSidequest(prof)).body;
      // aluno2 (id 5) é do prof2 (id 4), não do prof (id 2)
      const res = await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '5', sidequestId: sq.id });
      expect(res.status).toBe(403);
    });

    it('unassign remove a ativa sem concluir', async () => {
      const prof = await loginAs('prof');
      const sq = (await createBankSidequest(prof)).body;
      await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq.id });
      await request(app).post('/api/sidequests/unassign').set(authHeader(prof)).send({ userId: '3' });
      const got = await request(app).get('/api/sidequests/student/3').set(authHeader(prof));
      expect(got.body.active).toBeNull();
      expect(got.body.completed.length).toBe(0);
    });
  });

  describe('conclusão via save do log', () => {
    const evalCompleted = [
      'Boa sessão, você sustentou o silêncio no momento certo.',
      '',
      '[sidequest-resultado]',
      '{"sidequest_completed": true, "justification": "Sustentou o silêncio e o paciente elaborou."}',
      '',
      '[notas-supervisor]',
      '{"1":6,"2":6,"3":6,"4":6,"5":6,"6":6}',
    ].join('\n');

    async function assignTo3() {
      const prof = await loginAs('prof');
      const sq = (await createBankSidequest(prof)).body;
      await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq.id });
      return sq;
    }

    it('Treinamento com sidequest cumprida → conclui, concede título e limpa a ativa', async () => {
      const sq = await assignTo3();
      const aluno = await loginAs('aluno');
      const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
        type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
        durationSeconds: 120, messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: '...' }],
        evaluation: evalCompleted,
      });
      expect(saved.status).toBe(200);
      // resultado da sidequest devolvido pra celebração
      expect(saved.body.sidequest).toBeTruthy();
      expect(saved.body.sidequest.completed).toBe(true);
      expect(saved.body.sidequest.rewardTitleId).toBe(sq.rewardTitleId);
      // blocos internos saem do texto salvo
      expect(saved.body.evaluation).not.toContain('[sidequest-resultado]');
      expect(saved.body.evaluation).not.toContain('[notas-supervisor]');
      // notas extraídas
      expect(saved.body.criteriaScores).toBeTruthy();

      // ativa virou concluída
      const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
      expect(mine.body.active).toBeNull();
      expect(mine.body.completed.length).toBe(1);
      expect(mine.body.completed[0].rewardTitleId).toBe(sq.rewardTitleId);

      // título de recompensa selecionável e refletido no perfil
      const setTitle = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: sq.rewardTitleId });
      expect(setTitle.status).toBe(200);
      expect(setTitle.body.titleLabel).toBe('Mestre do Silêncio');
      expect(setTitle.body.titleTier).toBe('quest');

      // aparece como conquista na gamificação
      const gam = await request(app).get('/api/gamification/3').set(authHeader(aluno));
      const questBadge = gam.body.achievements.find((a) => a.id === sq.rewardTitleId);
      expect(questBadge).toBeTruthy();
      expect(questBadge.earned).toBe(true);
    });

    it('sidequest NÃO cumprida → permanece ativa, sem título', async () => {
      const sq = await assignTo3();
      const aluno = await loginAs('aluno');
      const evalFail = evalCompleted.replace('"sidequest_completed": true', '"sidequest_completed": false');
      const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
        type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
        durationSeconds: 60, messages: [{ role: 'user', content: 'oi' }], evaluation: evalFail,
      });
      expect(saved.body.sidequest.completed).toBe(false);
      const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
      expect(mine.body.active).toBeTruthy();
      expect(mine.body.completed.length).toBe(0);
      // não pode setar o título ainda
      const setTitle = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: sq.rewardTitleId });
      expect(setTitle.status).toBe(403);
    });

    it('não pode setar título de sidequest que não desbloqueou (403)', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: 'qt-sq-inexistente' });
      expect(res.status).toBe(403);
    });
  });
});
