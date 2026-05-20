// Testes de regressão dos bugs encontrados na rodada de QA.
// Cada bloco describe representa um bug específico — se algum desses voltar
// no futuro, o teste correspondente falha.

const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, loginVisitor, authHeader, DATA_DIR } = require('./helpers');

describe('regressão — bugs do pentest e da rodada de QA', () => {
  beforeEach(() => resetData());

  // === Pentest (já corrigido — mantido como regressão) ===
  describe('pentest: /api/chat não aceita mais systemPrompt do cliente', () => {
    it('rejeita body com systemPrompt', async () => {
      const token = await loginAs('admin');
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader(token))
        .send({ messages: [], systemPrompt: 'INJETADO POR ATACANTE' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/systemPrompt/);
    });

    it('exige context com type e itemId', async () => {
      const token = await loginAs('aluno');
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader(token))
        .send({ messages: [] }); // sem context
      expect(res.status).toBe(400);
    });

    it('mode entrevistador só admin', async () => {
      const visitorToken = await loginVisitor();
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader(visitorToken))
        .send({ messages: [], mode: 'entrevistador' });
      expect(res.status).toBe(403);
    });

    it('visitor não consegue chat com neuro (premissa pedagógica)', async () => {
      const token = await loginVisitor();
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader(token))
        .send({ messages: [], context: { type: 'neuro', itemId: 'nr-test-1' } });
      expect(res.status).toBe(403);
    });

    it('chat funciona em modo demo (sem ANTHROPIC_API_KEY)', async () => {
      const token = await loginAs('aluno');
      const res = await request(app)
        .post('/api/chat')
        .set(authHeader(token))
        .send({ messages: [{ role: 'user', content: 'oi' }], context: { type: 'freeplay', itemId: 'fp-test-1' } });
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('assistant');
      expect(res.body.content).toMatch(/Modo demonstração/);
    });
  });

  // === Bug J — Allowlist em PUT de conteúdo ===
  describe('Bug J: PUT /api/exercises/:id ignora campos não-listados', () => {
    it('campo arbitrário no body não persiste', async () => {
      const token = await loginAs('admin');
      const res = await request(app)
        .put('/api/exercises/ex-test-1')
        .set(authHeader(token))
        .send({ title: 'Novo título', maliciousField: 'injected', anotherJunk: 123 });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Novo título');
      expect(res.body.maliciousField).toBeUndefined();
      expect(res.body.anotherJunk).toBeUndefined();
    });

    it('id no body não sobrescreve id da URL', async () => {
      const token = await loginAs('admin');
      const res = await request(app)
        .put('/api/exercises/ex-test-1')
        .set(authHeader(token))
        .send({ id: 'ex-spoofed', title: 'X' });
      expect(res.body.id).toBe('ex-test-1'); // id original preservado
    });
  });

  // === Bug D — IDs únicos ===
  describe('Bug D: IDs gerados são únicos (sem colisão de Date.now)', () => {
    it('dois POST /api/exercises consecutivos geram IDs diferentes', async () => {
      const token = await loginAs('admin');
      const a = await request(app).post('/api/exercises').set(authHeader(token)).send({ title: 'A' });
      const b = await request(app).post('/api/exercises').set(authHeader(token)).send({ title: 'B' });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.id).not.toBe(b.body.id);
      expect(a.body.id).toMatch(/^ex\d+-[0-9a-f]+$/);
    });

    it('mesmo padrão pra freeplay e neuro', async () => {
      const token = await loginAs('admin');
      const fp1 = await request(app).post('/api/freeplay').set(authHeader(token)).send({ name: 'A' });
      const fp2 = await request(app).post('/api/freeplay').set(authHeader(token)).send({ name: 'B' });
      const nr1 = await request(app).post('/api/neuro').set(authHeader(token)).send({ name: 'C' });
      const nr2 = await request(app).post('/api/neuro').set(authHeader(token)).send({ name: 'D' });
      expect(fp1.body.id).not.toBe(fp2.body.id);
      expect(nr1.body.id).not.toBe(nr2.body.id);
    });
  });

  // === Logs: allowlist + autoria forçada + DELETE admin ===
  describe('/api/logs hardening', () => {
    it('POST aceita só campos da allowlist; userId/userName forçados do JWT', async () => {
      const token = await loginAs('aluno');
      const res = await request(app)
        .post('/api/logs')
        .set(authHeader(token))
        .send({
          type: 'exercise',
          itemId: 'ex-test-1',
          itemTitle: 'log de teste',
          messages: [{ role: 'user', content: 'oi' }],
          // tentativas maliciosas:
          userId: '999',                     // ignorado
          userName: 'OUTRO ALUNO',           // ignorado
          campoMalicioso: 'shouldNotPersist',
        });
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe('3');     // id do "aluno" do seed
      expect(res.body.userName).toBe('Aluno A');
      expect(res.body.campoMalicioso).toBeUndefined();
    });

    it('POST com type inválido retorna 400', async () => {
      const token = await loginAs('admin');
      const res = await request(app)
        .post('/api/logs')
        .set(authHeader(token))
        .send({ type: 'malicious_type', itemId: 'x' });
      expect(res.status).toBe(400);
    });

    it('DELETE /api/logs/:id é admin-only', async () => {
      const adminToken = await loginAs('admin');
      // cria 1 log
      const created = await request(app)
        .post('/api/logs')
        .set(authHeader(adminToken))
        .send({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 't' });
      const logId = created.body.id;
      expect(logId).toBeTruthy();

      // aluno não pode deletar
      const alunoToken = await loginAs('aluno');
      const forbid = await request(app)
        .delete(`/api/logs/${logId}`)
        .set(authHeader(alunoToken));
      expect(forbid.status).toBe(403);

      // admin consegue
      const ok = await request(app)
        .delete(`/api/logs/${logId}`)
        .set(authHeader(adminToken));
      expect(ok.status).toBe(200);
    });
  });

  // === Acesso a recursos por role ===
  describe('canAccessUserResource', () => {
    it('professor vê logs de SEU aluno', async () => {
      const profToken = await loginAs('prof'); // supervisor do aluno 3
      const res = await request(app)
        .get('/api/logs?userId=3')
        .set(authHeader(profToken));
      expect(res.status).toBe(200);
    });

    it('professor NÃO vê logs de aluno de OUTRO professor', async () => {
      const profToken = await loginAs('prof'); // tem aluno 3, não tem 5
      const res = await request(app)
        .get('/api/logs?userId=5')           // aluno do prof2
        .set(authHeader(profToken));
      expect(res.status).toBe(403);
    });

    it('aluno só vê os PRÓPRIOS logs (mesmo passando outro userId)', async () => {
      const alunoToken = await loginAs('aluno'); // id 3
      // POST log como aluno (será dele)
      await request(app)
        .post('/api/logs')
        .set(authHeader(alunoToken))
        .send({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 'meu log' });

      // GET sem filtro: retorna só os próprios
      const res = await request(app)
        .get('/api/logs')
        .set(authHeader(alunoToken));
      expect(res.status).toBe(200);
      for (const log of res.body) expect(log.userId).toBe('3');
    });
  });

  // === Export admin (backup / migração SQL) ===
  describe('/api/admin/export', () => {
    it('admin baixa dump completo com Content-Disposition', async () => {
      const token = await loginAs('admin');
      const res = await request(app).get('/api/admin/export').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="allos-export-/);
      // Payload tem todas as chaves esperadas
      expect(res.body.schemaVersion).toBe(1);
      expect(res.body.exportedBy).toBe('admin');
      expect(res.body.data.users).toBeTypeOf('object');
      expect(res.body.data.exercises).toBeTypeOf('object');
      expect(res.body.data.freeplayCharacters).toBeTypeOf('object');
      expect(res.body.data.neuroCharacters).toBeTypeOf('object');
      expect(res.body.data.progress).toBeTypeOf('object');
      expect(res.body.data.logs).toBeTypeOf('object');
      expect(res.body.data.achievements).toBeTypeOf('object');
      expect(res.body.data.activeSessions).toBeTypeOf('object');
    });

    it('inclui passwordHash dos users (necessário pra migração — admin já tem total)', async () => {
      const token = await loginAs('admin');
      const res = await request(app).get('/api/admin/export').set(authHeader(token));
      expect(res.body.data.users[0].passwordHash).toBeTruthy();
    });

    it('aluno recebe 403', async () => {
      const token = await loginAs('aluno');
      const res = await request(app).get('/api/admin/export').set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('professor recebe 403', async () => {
      const token = await loginAs('prof');
      const res = await request(app).get('/api/admin/export').set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('visitor recebe 403', async () => {
      const token = await loginVisitor();
      const res = await request(app).get('/api/admin/export').set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('sem token retorna 401', async () => {
      const res = await request(app).get('/api/admin/export');
      expect(res.status).toBe(401);
    });
  });

  // === CRUD admin ===
  describe('admin pode criar/deletar professor com regra de alunos vinculados', () => {
    it('DELETE professor COM alunos vinculados retorna 400', async () => {
      const token = await loginAs('admin');
      const res = await request(app)
        .delete('/api/admin/users/2')        // prof tem aluno 3
        .set(authHeader(token));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/aluno/i);
    });

    it('DELETE professor SEM alunos vinculados funciona', async () => {
      const token = await loginAs('admin');
      // primeiro desvincular aluno 5 do prof2
      await request(app)
        .put('/api/admin/users/5')
        .set(authHeader(token))
        .send({ role: 'therapist', teacherId: '2' }); // muda pra outro prof
      // agora prof2 não tem alunos — pode deletar
      const res = await request(app)
        .delete('/api/admin/users/4')
        .set(authHeader(token));
      expect(res.status).toBe(200);
    });
  });

  // === Reset de ranking (admin) — zera notas, preserva logs ===
  describe('POST /api/admin/ranking/reset', () => {
    async function seedScoredLog(token) {
      // cria log + força um score editando o JSON (POST não aceita score do aluno? aceita via allowlist)
      const res = await request(app)
        .post('/api/logs')
        .set(authHeader(token))
        .send({ type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia', score: 80, messages: [{ role: 'user', content: 'oi' }] });
      return res.body.id;
    }

    it('zera score/criteriaScores dos logs mas mantém os logs e mensagens', async () => {
      const aluno = await loginAs('aluno');
      const logId = await seedScoredLog(aluno);
      // confirma que o score foi gravado
      const before = await request(app).get('/api/logs').set(authHeader(aluno));
      const logBefore = before.body.find((l) => l.id === logId);
      expect(logBefore.score).toBe(80);

      const admin = await loginAs('admin');
      const reset = await request(app).post('/api/admin/ranking/reset').set(authHeader(admin));
      expect(reset.status).toBe(200);
      expect(reset.body.ok).toBe(true);
      expect(reset.body.clearedScores).toBeGreaterThanOrEqual(1);

      const after = await request(app).get('/api/logs').set(authHeader(aluno));
      const logAfter = after.body.find((l) => l.id === logId);
      expect(logAfter).toBeTruthy();          // log preservado
      expect(logAfter.score).toBeNull();      // nota zerada
      expect(logAfter.messages.length).toBe(1); // conversa preservada
    });

    it('é admin-only', async () => {
      const aluno = await loginAs('aluno');
      const r1 = await request(app).post('/api/admin/ranking/reset').set(authHeader(aluno));
      expect(r1.status).toBe(403);
      const prof = await loginAs('prof');
      const r2 = await request(app).post('/api/admin/ranking/reset').set(authHeader(prof));
      expect(r2.status).toBe(403);
    });
  });

  // === Expiração de logs (30 dias) ===
  describe('expiração de logs', () => {
    it('GET /api/logs anexa expiresAt ~30 dias após o timestamp', async () => {
      const aluno = await loginAs('aluno');
      await request(app).post('/api/logs').set(authHeader(aluno))
        .send({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 'x' });
      const res = await request(app).get('/api/logs').set(authHeader(aluno));
      const log = res.body[0];
      expect(log.expiresAt).toBeTruthy();
      const delta = new Date(log.expiresAt) - new Date(log.timestamp);
      expect(Math.round(delta / 86400000)).toBe(30);
    });

    it('logs com mais de 30 dias são removidos no GET', async () => {
      const aluno = await loginAs('aluno');
      await request(app).post('/api/logs').set(authHeader(aluno))
        .send({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 'velho' });
      // envelhece o log direto no JSON (40 dias atrás)
      const file = path.join(DATA_DIR, 'logs.json');
      const logs = JSON.parse(fs.readFileSync(file, 'utf-8'));
      logs[0].timestamp = new Date(Date.now() - 40 * 86400000).toISOString();
      fs.writeFileSync(file, JSON.stringify(logs));
      const res = await request(app).get('/api/logs').set(authHeader(aluno));
      expect(res.body.length).toBe(0);
    });

    it('GET /api/logs/policy expõe ttlDays', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/logs/policy').set(authHeader(aluno));
      expect(res.status).toBe(200);
      expect(res.body.ttlDays).toBe(30);
    });
  });

  // === Títulos desbloqueáveis ===
  describe('POST /api/me/title', () => {
    it('rejeita título não desbloqueado (403) e aceita após desbloquear', async () => {
      const aluno = await loginAs('aluno');
      // sem sessões: nenhuma conquista → 403
      const fail = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: 'first_session' });
      expect(fail.status).toBe(403);
      // cria 1 sessão → desbloqueia 'first_session'
      await request(app).post('/api/logs').set(authHeader(aluno))
        .send({ type: 'exercise', itemId: 'ex-test-1', itemTitle: 'x' });
      const ok = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: 'first_session' });
      expect(ok.status).toBe(200);
      expect(ok.body.activeTitle).toBe('first_session');
      expect(ok.body.titleLabel).toBeTruthy();
      // título vazio limpa
      const clear = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: '' });
      expect(clear.body.activeTitle).toBe('');
    });

    it('titleId inexistente retorna 400', async () => {
      const aluno = await loginAs('aluno');
      const res = await request(app).post('/api/me/title').set(authHeader(aluno)).send({ titleId: 'nao_existe' });
      expect(res.status).toBe(400);
    });
  });
});
