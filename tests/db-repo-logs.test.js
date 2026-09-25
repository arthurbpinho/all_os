// Repositório de logs (server/repos/logs.js) contra o Postgres de teste.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de logs', () => {
  const { criarRepoLogs } = require('../server/repos/logs');
  const { criarRepoContas } = require('../server/repos/contas');

  let db;
  let logs;
  let contas;
  let aluno;
  let outro;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    logs = criarRepoLogs(db.pool);
    contas = criarRepoContas(db.pool);
    aluno = await contas.criar({ username: 'aluno', name: 'Aluno A', role: 'therapist', passwordHash: 'h' });
    outro = await contas.criar({ username: 'outro', name: 'Outro B', role: 'therapist', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  let seq = 0;
  const minutosAtras = (n) => new Date(Date.now() - n * 60000).toISOString();

  // Um log como o POST /api/logs monta.
  const novoLog = (dados = {}) => logs.criar({
    id: `log${Date.now()}-${(seq++).toString(16).padStart(6, '0')}`,
    timestamp: new Date().toISOString(),
    type: 'freeplay',
    mode: 'training',
    itemId: 'fp-1',
    itemTitle: 'Sofia',
    skillId: null,
    difficulty: null,
    durationSeconds: 60,
    score: 72.5,
    criteriaScores: { 1: 7, 2: 8 },
    evaluation: 'Bom trabalho.',
    evalVersion: 'v34',
    evalPartsId: 'av-1-abcd1234',
    imageSchema: null,
    cost: null,
    messages: [
      { role: 'user', content: 'Oi', highlighted: false, comment: '' },
      { role: 'assistant', content: 'Olá', highlighted: true, comment: 'boa abertura' },
    ],
    neuroTests: null,
    userId: aluno.id,
    userName: aluno.name,
    ...dados,
  });

  const contarMensagens = async () => (await db.pool.query('SELECT count(*)::int AS n FROM log_messages')).rows[0].n;

  describe('gravação e leitura', () => {
    it('devolve o log no formato do logs.json', async () => {
      const criado = await novoLog();

      const log = await logs.porId(criado.id);

      expect(log).toMatchObject({
        id: criado.id, type: 'freeplay', mode: 'training', itemId: 'fp-1', itemTitle: 'Sofia',
        durationSeconds: 60, score: 72.5, criteriaScores: { 1: 7, 2: 8 }, evaluation: 'Bom trabalho.',
        evalVersion: 'v34', evalPartsId: 'av-1-abcd1234', userId: aluno.id, userName: 'Aluno A',
        evaluationPending: false,
      });
      expect(typeof log.score).toBe('number');
      expect(log.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(log.messages).toEqual([
        { role: 'user', content: 'Oi', highlighted: false, comment: '' },
        { role: 'assistant', content: 'Olá', highlighted: true, comment: 'boa abertura' },
      ]);
      // Campos do ciclo do Competitivo não aparecem num log que não passou por ele.
      expect(log).not.toHaveProperty('evalBatchId');
      expect(log).not.toHaveProperty('mmrBefore');
    });

    it('log de visitante é gravado e lido pelo id efêmero', async () => {
      await novoLog({ userId: 'visitor-abc123', userName: 'Visitante' });

      const doVisitante = await logs.listarDoDono('visitor-abc123');

      expect(doVisitante).toHaveLength(1);
      expect(doVisitante[0].userId).toBe('visitor-abc123');
    });

    it('recusa dono que não é conta nem visitante', async () => {
      await expect(novoLog({ userId: 'lixo' })).rejects.toThrow(/Dono de log inválido/);
    });

    it('lista por dono, por várias contas e todos, em ordem cronológica', async () => {
      const antigo = await novoLog({ timestamp: minutosAtras(10) });
      const novo = await novoLog({ timestamp: minutosAtras(1) });
      const doOutro = await novoLog({ userId: outro.id, timestamp: minutosAtras(5) });

      expect((await logs.listarDoDono(aluno.id)).map((l) => l.id)).toEqual([antigo.id, novo.id]);
      expect((await logs.listarDeContas([outro.id])).map((l) => l.id)).toEqual([doOutro.id]);
      expect((await logs.listarTodos()).map((l) => l.id)).toEqual([antigo.id, doOutro.id, novo.id]);
    });

    it('log de conta excluída continua ligado a ela', async () => {
      const log = await novoLog();

      await contas.excluir(aluno.id);

      expect((await logs.listarDoDono(aluno.id)).map((l) => l.id)).toEqual([log.id]);
    });
  });

  describe('progressão', () => {
    it('último atendimento com o paciente ignora log sem conversa e pega o mais recente', async () => {
      await novoLog({ timestamp: minutosAtras(10) });
      const recente = await novoLog({ timestamp: minutosAtras(5) });
      await novoLog({ timestamp: minutosAtras(1), messages: [] });
      await novoLog({ timestamp: minutosAtras(1), itemId: 'fp-2' });

      expect((await logs.ultimoDoPaciente(aluno.id, 'fp-1')).id).toBe(recente.id);
      expect(await logs.ultimoDoPaciente(aluno.id, 'fp-inexistente')).toBeNull();
    });

    it('pacientes atendidos: um por paciente, com o atendimento mais recente', async () => {
      await novoLog({ timestamp: minutosAtras(10), itemTitle: 'Sofia (antigo)' });
      await novoLog({ timestamp: minutosAtras(2), itemTitle: 'Sofia' });
      await novoLog({ timestamp: minutosAtras(5), itemId: 'fp-2', itemTitle: 'Bruno' });
      await novoLog({ timestamp: minutosAtras(1), itemId: 'fp-3', messages: [] });

      const pacientes = await logs.pacientesAtendidos(aluno.id);

      expect(pacientes.map((p) => [p.itemId, p.itemTitle]).sort()).toEqual([['fp-1', 'Sofia'], ['fp-2', 'Bruno']]);
    });
  });

  describe('ciclo do Competitivo', () => {
    const pendente = (dados = {}) => novoLog({
      mode: 'competitive', score: null, criteriaScores: null, evaluation: '', evalVersion: null, evalPartsId: null,
      evaluationPending: true, evalBatchId: null, ...dados,
    });

    it('separa os pendentes sem lote dos que já estão num lote', async () => {
      const semLote = await pendente();
      const comLote = await pendente({ evalBatchId: 'batch_1' });
      await novoLog();

      expect((await logs.pendentesCompetitivos()).map((l) => l.id)).toEqual([semLote.id]);
      expect((await logs.pendentesCompetitivos({ comLote: true })).map((l) => l.id)).toEqual([comLote.id]);
    });

    it('fechar a avaliação só vale para log ainda pendente', async () => {
      const log = await pendente();
      const fechado = await logs.atualizar(log.id, { score: 80, evaluationPending: false }, { soSePendente: true });
      expect(fechado).toMatchObject({ score: 80, evaluationPending: false });

      const reaberto = await logs.atualizar(log.id, { score: 10 }, { soSePendente: true });

      expect(reaberto).toBeNull();
      expect((await logs.porId(log.id)).score).toBe(80);
    });

    it('marcar o lote só vale se o log ainda está sem lote', async () => {
      const log = await pendente();
      expect(await logs.atualizar(log.id, { evalBatchId: 'batch_1' }, { soSePendente: true, loteAtual: null })).not.toBeNull();

      const segundo = await logs.atualizar(log.id, { evalBatchId: 'batch_2' }, { soSePendente: true, loteAtual: null });

      expect(segundo).toBeNull();
      expect((await logs.porId(log.id)).evalBatchId).toBe('batch_1');
    });

    it('duas atualizações simultâneas de campos diferentes não se apagam', async () => {
      const log = await pendente();

      await Promise.all([
        logs.atualizar(log.id, { evalBatchAt: new Date().toISOString() }),
        logs.atualizar(log.id, { mmrBefore: 1200, mmrAfter: 1215 }),
      ]);

      const final = await logs.porId(log.id);
      expect(final.evalBatchAt).toBeTruthy();
      expect(final).toMatchObject({ mmrBefore: 1200, mmrAfter: 1215 });
    });
  });

  describe('administração e retenção', () => {
    it('excluir devolve o log removido e leva as mensagens junto', async () => {
      const log = await novoLog();

      const removido = await logs.excluir(log.id);

      expect(removido.messages).toHaveLength(2);
      expect(await logs.porId(log.id)).toBeNull();
      expect(await contarMensagens()).toBe(0);
      expect(await logs.excluir(log.id)).toBeNull();
    });

    it('reset do ranking zera as notas, devolve os detalhes a apagar e preserva o texto', async () => {
      await novoLog({ evalPartsId: 'av-1-aaaaaaaa' });
      await novoLog({ score: null, criteriaScores: null, evalPartsId: null });

      const r = await logs.zerarNotas();

      expect(r).toEqual({ notasZeradas: 1, evalPartsIds: ['av-1-aaaaaaaa'] });
      for (const l of await logs.listarTodos()) {
        expect(l).toMatchObject({ score: null, criteriaScores: null, evalPartsId: null, evaluation: expect.any(String) });
      }
    });

    it('logs são persistentes (demandas.md §24.0): não há mais poda', () => {
      expect(logs).not.toHaveProperty('podarVencidos');
    });
  });
});
