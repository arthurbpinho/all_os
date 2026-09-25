// Sessões ativas, cota do externo, jobs e ledger (server/repos/sessoes.js,
// cota.js, jobs.js) contra o Postgres de teste. O que se prova é o que o arquivo
// não garantia: salvamentos e aberturas simultâneos não se perdem.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('sessões ativas, cota e filas no banco', () => {
  const { criarRepoSessoes } = require('../server/repos/sessoes');
  const { criarRepoCota } = require('../server/repos/cota');
  const { criarRepoJobs } = require('../server/repos/jobs');
  const { criarRepoContas } = require('../server/repos/contas');
  const sessionQuota = require('../server/session-quota');

  let db;
  let conta;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    conta = await criarRepoContas(db.pool).criar({ username: 'ext', name: 'Externo', role: 'external', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  describe('sessões ativas', () => {
    let sessoes;
    beforeEach(() => { sessoes = criarRepoSessoes(db.pool); });

    const base = { tipo: 'freeplay', itemId: 'fp-1', itemTitle: 'Sofia', elapsedSeconds: 30 };

    it('salva e devolve a conversa como veio, inclusive campos extras da mensagem', async () => {
      const messages = [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Olá…', highlighted: true, comment: 'boa abertura' },
      ];
      const salva = await sessoes.salvar(conta.id, { ...base, messages });

      expect(salva).toMatchObject({ userId: conta.id, type: 'freeplay', itemId: 'fp-1', itemTitle: 'Sofia', elapsedSeconds: 30, messages });
      expect(await sessoes.porChave(conta.id, 'freeplay', 'fp-1')).toEqual(salva);
    });

    it('a conversa que cresce e encolhe fica igual ao último salvamento', async () => {
      const m = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` }));
      await sessoes.salvar(conta.id, { ...base, messages: m(5) });
      await sessoes.salvar(conta.id, { ...base, messages: m(8) });
      expect((await sessoes.porChave(conta.id, 'freeplay', 'fp-1')).messages).toEqual(m(8));

      await sessoes.salvar(conta.id, { ...base, messages: m(2) });
      expect((await sessoes.porChave(conta.id, 'freeplay', 'fp-1')).messages).toEqual(m(2));
    });

    it('visitante tem sessão própria; excluir e poda de 15 dias', async () => {
      await sessoes.salvar('visitor-abc', { ...base, messages: [{ role: 'user', content: 'x' }] });
      await sessoes.salvar(conta.id, { ...base, messages: [] });
      expect(await sessoes.listarDoDono('visitor-abc')).toHaveLength(1);

      expect(await sessoes.excluir('visitor-abc', 'freeplay', 'fp-1')).toBe(true);
      expect(await sessoes.listarDoDono('visitor-abc')).toEqual([]);

      await db.pool.query(`UPDATE sessoes_ativas SET ultimo_salvamento = now() - interval '16 days'`);
      expect(await sessoes.podarVencidas(15 * 86400000)).toBe(1);
      expect(await sessoes.listarDoDono(conta.id)).toEqual([]);
    });

    it('salvamentos simultâneos da mesma conversa não duplicam a sessão', async () => {
      await Promise.all([1, 2, 3].map((n) => sessoes.salvar(conta.id, {
        ...base, messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: String(i) })),
      })));
      const lista = await sessoes.listarDoDono(conta.id);
      expect(lista).toHaveLength(1);
      expect(lista[0].messages.map((x) => x.content)).toEqual(
        Array.from({ length: lista[0].messages.length }, (_, i) => String(i)),
      );
    });
  });

  describe('cota do externo', () => {
    let cota;
    beforeEach(() => { cota = criarRepoCota(db.pool); });

    // O mesmo fluxo do consumeSessionQuota do index.js.
    const abrir = (chave) => cota.comTrava(conta.id, sessionQuota.QUOTA_WINDOW_MS, async (inicios, { registrar }) => {
      if (sessionQuota.hasOpenSession(inicios, chave)) return 'continua';
      if (sessionQuota.quotaState(inicios).blocked) return 'bloqueada';
      await registrar(chave);
      return 'abriu';
    });

    it('dez aberturas simultâneas de pacientes diferentes: só três passam', async () => {
      const r = await Promise.all(Array.from({ length: 10 }, (_, i) => abrir(`freeplay:fp-${i}`)));
      expect(r.filter((x) => x === 'abriu')).toHaveLength(3);
      expect((await cota.inicios(conta.id, sessionQuota.QUOTA_WINDOW_MS))).toHaveLength(3);
    });

    it('continuar sessão aberta é de graça; fechar mantém o slot gasto', async () => {
      expect(await abrir('freeplay:fp-1')).toBe('abriu');
      expect(await abrir('freeplay:fp-1')).toBe('continua');

      await cota.fechar(conta.id, 'freeplay:fp-1');
      const inicios = await cota.inicios(conta.id, sessionQuota.QUOTA_WINDOW_MS);
      expect(inicios).toEqual([{ t: expect.any(Number), key: null }]);
      expect(await abrir('freeplay:fp-1')).toBe('abriu');
    });

    it('abertura fora da janela de 24h não conta e é apagada', async () => {
      await abrir('freeplay:fp-1');
      await db.pool.query(`UPDATE cota_sessoes SET iniciado_em = now() - interval '25 hours'`);
      expect(await cota.inicios(conta.id, sessionQuota.QUOTA_WINDOW_MS)).toEqual([]);
      await abrir('freeplay:fp-2');
      expect((await db.pool.query('SELECT count(*)::int AS n FROM cota_sessoes')).rows[0].n).toBe(1);
    });
  });

  describe('jobs e ledger', () => {
    let jobs;
    beforeEach(() => { jobs = criarRepoJobs(db.pool); });

    it('filtra por status, batch e dono, na ordem de chegada ou dos mais recentes', async () => {
      const fila = jobs.fila('avaliacao-fila');
      const t = (min) => new Date(Date.UTC(2026, 8, 1, 10, min)).toISOString();
      await fila.criar({ id: 'a', userId: '1', status: 'aguardando', createdAt: t(1) });
      await fila.criar({ id: 'b', userId: '2', status: 'processing', batchId: 'batch-1', createdAt: t(2) });
      await fila.criar({ id: 'c', userId: '1', status: 'aguardando', createdAt: t(3) });

      expect((await fila.listar({ status: 'aguardando' })).map((j) => j.id)).toEqual(['a', 'c']);
      expect((await fila.listar({ comBatch: true })).map((j) => j.id)).toEqual(['b']);
      expect((await fila.listar({ userId: '1', recentesPrimeiro: true, limite: 1 })).map((j) => j.id)).toEqual(['c']);
      expect((await fila.listar({ statusEm: ['processing', 'aguardando'] }))).toHaveLength(3);
      // Filas não se misturam.
      expect(await jobs.fila('benchmark-fila').listar()).toEqual([]);
    });

    it('atualizações simultâneas do mesmo job não se sobrescrevem', async () => {
      const fila = jobs.fila('benchmark-fila');
      await fila.criar({ id: 'run', status: 'processing', contador: 0 });

      await Promise.all(Array.from({ length: 10 }, () => fila.atualizar('run', (j) => { j.contador += 1; })));

      expect((await fila.porId('run')).contador).toBe(10);
    });

    it('atualizarDoBatch fecha só os itens do batch, e pula os que a função recusa', async () => {
      const fila = jobs.fila('trilha-avaliacao');
      await fila.criar({ id: 'x', status: 'processing', batchId: 'b1' });
      await fila.criar({ id: 'y', status: 'error', batchId: 'b1' });
      await fila.criar({ id: 'z', status: 'processing', batchId: 'b2' });

      const fechados = await fila.atualizarDoBatch('b1', (j) => {
        if (j.status !== 'processing') return false;
        j.status = 'completed';
      });

      expect(fechados.map((j) => j.id)).toEqual(['x']);
      expect((await fila.listar({ status: 'processing' })).map((j) => j.id)).toEqual(['z']);
    });

    it('ledger: soma por modelo sem diferenciar caixa, e libera por id e por idade', async () => {
      await jobs.registrarBatch({ batchId: 'b1', model: 'gpt-5.6-luna', tokens: 1000, modo: 'trilha' });
      await jobs.registrarBatch({ batchId: 'b2', model: 'GPT-5.6-LUNA', tokens: 500, modo: 'aval' });
      await jobs.registrarBatch({ batchId: 'b3', model: 'gpt-5.5', tokens: 9, modo: 'aval' });

      expect((await jobs.batchesEmVoo('gpt-5.6-luna')).map((e) => e.tokens).sort()).toEqual([1000, 500]);

      await db.pool.query(`UPDATE batches_em_voo SET criado_em = now() - interval '30 hours' WHERE batch_id = 'b3'`);
      await jobs.liberarBatch('b1', 26 * 3600000);
      const restantes = (await db.pool.query('SELECT batch_id FROM batches_em_voo ORDER BY batch_id')).rows.map((r) => r.batch_id);
      expect(restantes).toEqual(['b2']);
    });
  });
});
