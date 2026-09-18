// Processo Seletivo e Comunidade (server/repos/selecao.js, comunidade.js) contra
// o Postgres de teste.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('seletivo e comunidade no banco', () => {
  const { criarRepoSelecao } = require('../server/repos/selecao');
  const { criarRepoComunidade } = require('../server/repos/comunidade');

  let db;

  beforeEach(async () => { db = await criarPoolIsolado(); });
  afterEach(() => db.descartar());

  describe('seletivo', () => {
    let sel;
    beforeEach(() => { sel = criarRepoSelecao(db.pool); });

    const log = (id, extra = {}) => ({
      id, sessionId: `sessao-${id}`, timestamp: new Date().toISOString(),
      candidate: { nome: 'Ana', whatsapp: '(11) 91234-5678' }, messages: [], status: 'pending', ...extra,
    });

    it('um log por sessão, mesmo com /finish simultâneo', async () => {
      const r = await Promise.all([sel.criar(log('a'), '11912345678'), sel.criar({ ...log('b'), sessionId: 'sessao-a' }, '11912345678')]);
      expect(r.filter(Boolean)).toHaveLength(1);
      expect(await sel.existeSessao('sessao-a')).toBe(true);
      expect(await sel.listar()).toHaveLength(1);
    });

    it('dedup por WhatsApp e poda de 15 dias', async () => {
      await sel.criar(log('a'), '11912345678');
      expect(await sel.ultimoDoWhatsapp('11912345678')).toBeGreaterThan(Date.now() - 60000);
      expect(await sel.ultimoDoWhatsapp('11900000000')).toBeNull();

      await db.pool.query(`UPDATE selecao_logs SET criado_em = now() - interval '16 days'`);
      expect(await sel.podarVencidos(15 * 86400000)).toBe(1);
      expect(await sel.ultimoDoWhatsapp('11912345678')).toBeNull();
    });

    it('pendentes com e sem batch, e fechar só os ainda pendentes', async () => {
      await sel.criar(log('a'), '1');
      await sel.criar(log('b', { evalBatchId: 'batch-1' }), '2');
      await sel.criar(log('c', { status: 'ativo' }), '3');

      expect((await sel.pendentes({ comBatch: false })).map((l) => l.id)).toEqual(['a']);
      expect((await sel.pendentes({ comBatch: true })).map((l) => l.id)).toEqual(['b']);

      const fechados = await sel.atualizarVarios(['a', 'c'], (l) => {
        if (l.status !== 'pending') return false;
        l.status = 'rejeitado';
      });
      expect(fechados.map((l) => l.id)).toEqual(['a']);

      await sel.atualizarDoBatch('batch-1', (l) => { l.evalBatchId = null; });
      expect((await sel.pendentes({ comBatch: false })).map((l) => l.id).sort()).toEqual(['b']);
    });

    it('fechamentos simultâneos do mesmo candidato: só um vale', async () => {
      await sel.criar(log('a'), '1');
      const fechar = () => sel.atualizar('a', (l) => { if (l.status !== 'pending') return false; l.status = 'ativo'; });
      const r = await Promise.all([fechar(), fechar(), fechar()]);
      expect(r.filter(Boolean)).toHaveLength(1);
    });

    it('estatísticas anônimas por período', async () => {
      await sel.registrarEstatisticas([
        { timestamp: new Date(Date.now() - 40 * 86400000).toISOString(), score: 30, status: 'rejeitado' },
        { timestamp: new Date().toISOString(), score: 70, status: 'ativo' },
      ]);
      const mes = await sel.estatisticasDesde(new Date(Date.now() - 30 * 86400000));
      expect(mes.map((s) => [s.score, s.status])).toEqual([[70, 'ativo']]);
    });
  });

  describe('comunidade', () => {
    let com;
    beforeEach(() => { com = criarRepoComunidade(db.pool); });

    const discussao = (authorId) => (id) => ({
      id, title: `Discussão ${id}`, body: 'texto', authorId, author: { role: 'therapist' },
      createdAt: new Date().toISOString(), votes: {}, comments: [],
    });

    it('ids sequenciais, como na URL pública', async () => {
      const a = await com.criar(discussao('3'));
      const b = await com.criar(discussao('5'));
      expect([a.id, b.id]).toEqual(['1', '2']);
      expect((await com.porId('2')).authorId).toBe('5');
      expect(await com.porId('abc')).toBeNull();
    });

    it('comentários simultâneos na mesma discussão não se perdem', async () => {
      await com.criar(discussao('3'));
      await Promise.all(Array.from({ length: 8 }, (_, i) => com.travar('1', (d) => {
        d.comments.push({ id: `c${i}`, body: 'oi', authorId: '5' });
        return { gravar: true };
      })));
      expect((await com.porId('1')).comments).toHaveLength(8);
    });

    it('purgar apaga as discussões do usuário e vira lápide nos comentários dele', async () => {
      await com.criar(discussao('3'));
      await com.criar(discussao('5'));
      await com.travar('2', (d) => { d.comments.push({ id: 'c1', body: 'spam', authorId: '3', author: { role: 'therapist' } }); return { gravar: true }; });

      expect(await com.purgar('3')).toBe(2);
      const restantes = await com.listar();
      expect(restantes.map((d) => d.id)).toEqual(['2']);
      expect(restantes[0].comments[0]).toMatchObject({ deleted: true, body: '' });
      expect(restantes[0].comments[0].author).toBeUndefined();
    });

    it('purgar só as discussões escolhidas não mexe em comentário', async () => {
      await com.criar(discussao('3'));
      await com.criar(discussao('3'));
      expect(await com.purgar('3', ['2'])).toBe(1);
      expect((await com.listar()).map((d) => d.id)).toEqual(['1']);
    });
  });
});
