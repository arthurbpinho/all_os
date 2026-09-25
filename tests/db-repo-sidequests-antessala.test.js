// Sidequests e Antessala (server/repos/sidequests.js, antessala.js) contra o
// Postgres de teste. O que se prova é o que o arquivo não garantia: conclusões
// simultâneas não concedem o título duas vezes, e a memória acompanha o banco.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('sidequests e antessala no banco', () => {
  const { criarRepoSidequests } = require('../server/repos/sidequests');
  const { criarRepoAntessala } = require('../server/repos/antessala');
  const { criarRepoContas } = require('../server/repos/contas');

  let db;
  let aluno;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    aluno = await criarRepoContas(db.pool).criar({ username: 'aluno', name: 'Aluno', role: 'therapist', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  describe('sidequests', () => {
    let sq;
    beforeEach(() => { sq = criarRepoSidequests(db.pool); });

    const def = { id: 'sq-1', title: 'Silêncio', description: 'd', rewardTitleId: 'qt-sq-1', rewardTitleLabel: 'Quem escuta', createdAt: '2026-05-25T15:08:45.367Z' };
    const registro = (a) => ({ sidequestId: a.sidequestId, title: a.title, rewardTitleId: a.rewardTitleId, completedAt: new Date().toISOString() });

    it('semeia o banco uma vez só, e a memória acompanha o banco', async () => {
      await sq.semearBancoUmaVez([def]);
      await sq.removerDoBanco('sq-1');
      await sq.semearBancoUmaVez([def]); // não volta
      await sq.carregar();
      expect(sq.ler().bank).toEqual([]);
    });

    it('atribuir, concluir e desatribuir refletem na memória e sobrevivem a recarregar', async () => {
      await sq.adicionarAoBanco(def);
      await sq.atribuir(aluno.id, { sidequestId: 'sq-1', title: 'Silêncio', rewardTitleId: 'qt-sq-1' });
      expect(sq.ler().active[aluno.id].title).toBe('Silêncio');

      const r = await sq.concluirAtiva(aluno.id, registro);
      expect(r.rewardTitleId).toBe('qt-sq-1');
      expect(sq.ler().active[aluno.id]).toBeUndefined();
      expect(sq.ler().completed[aluno.id]).toHaveLength(1);

      await sq.carregar();
      expect(sq.ler()).toEqual({ bank: [def], active: {}, completed: { [aluno.id]: [r] } });
    });

    it('duas conclusões simultâneas da mesma sidequest: só uma concede o título', async () => {
      await sq.atribuir(aluno.id, { sidequestId: 'sq-1', title: 'Silêncio', rewardTitleId: 'qt-sq-1' });
      const [a, b] = await Promise.all([sq.concluirAtiva(aluno.id, registro), sq.concluirAtiva(aluno.id, registro)]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM sidequests_concluidas');
      expect(rows[0].n).toBe(1);
    });

    it('missão diária: a mesma recompensa não é concedida duas vezes, nem em paralelo', async () => {
      const diaria = { sidequestId: 'sq-1', rewardTitleId: 'qt-sq-1', daily: true };
      const r = await Promise.all([1, 2, 3].map(() => sq.concluirDiaria(aluno.id, { ...diaria })));
      expect(r.filter(Boolean)).toHaveLength(1);
      expect(await sq.concluirDiaria(aluno.id, diaria)).toBeNull();
      expect(sq.ler().completed[aluno.id]).toHaveLength(1);
    });
  });

  describe('antessala', () => {
    let ant;
    beforeEach(() => { ant = criarRepoAntessala(db.pool); });

    const mapa = (id, extra = {}) => ({
      id, ownerId: aluno.id, ownerName: 'Aluno', titulo: id, fatos: [], status: 'draft',
      createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', deliveredAt: null, ...extra,
    });

    it('lista do dono pela última alteração, e entregues por dono', async () => {
      await ant.criar(mapa('a'));
      await ant.criar(mapa('b', { updatedAt: '2026-09-02T10:00:00Z', status: 'delivered', deliveredAt: '2026-09-02T10:00:00Z' }));

      expect((await ant.doDono(aluno.id)).map((m) => m.id)).toEqual(['b', 'a']);
      expect((await ant.entregues([aluno.id])).map((m) => m.id)).toEqual(['b']);
      expect(await ant.entregues(['999'])).toEqual([]);
      expect(await ant.entregues([])).toEqual([]);
      expect((await ant.entregues()).map((m) => m.id)).toEqual(['b']);
    });

    it('travar grava, exclui e avisa quando não encontra', async () => {
      await ant.criar(mapa('a'));
      await ant.travar('a', (m) => ({ gravar: { ...m, status: 'delivered', titulo: 'entregue' }, valor: 'ok' }));
      expect(await ant.porId('a')).toMatchObject({ status: 'delivered', titulo: 'entregue' });

      expect(await ant.travar('a', () => ({ excluir: true }))).toEqual({ encontrado: true, valor: undefined });
      expect(await ant.travar('a', () => ({ excluir: true }))).toEqual({ encontrado: false });
    });

    it('edição e entrega simultâneas: quem chega depois vê o mapa já entregue', async () => {
      await ant.criar(mapa('a'));
      const editar = () => ant.travar('a', (m) => (m.status === 'delivered'
        ? { valor: 'recusado' }
        : { gravar: { ...m, titulo: 'editado' }, valor: 'editado' }));
      const entregar = () => ant.travar('a', (m) => ({ gravar: { ...m, status: 'delivered' }, valor: 'entregue' }));

      const r = await Promise.all([entregar(), editar()]);
      const final = await ant.porId('a');
      expect(final.status).toBe('delivered');
      // Se a edição passou, foi antes da entrega — nunca depois dela.
      if (r[1].valor === 'editado') expect(final.titulo).toBe('editado');
    });
  });
});
