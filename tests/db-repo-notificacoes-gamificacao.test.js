// Notificações, push, conquistas, contadores e operação (server/repos/
// notificacoes.js, gamificacao.js, operacao.js) contra o Postgres de teste.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('notificações, gamificação e operação no banco', () => {
  const { criarRepoNotificacoes, MAX_POR_PESSOA } = require('../server/repos/notificacoes');
  const { criarRepoGamificacao } = require('../server/repos/gamificacao');
  const { criarRepoOperacao } = require('../server/repos/operacao');
  const { criarRepoContas } = require('../server/repos/contas');

  let db;
  let conta;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    conta = await criarRepoContas(db.pool).criar({ username: 'aluno', name: 'Aluno', role: 'therapist', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  describe('notificações', () => {
    let notif;
    beforeEach(() => { notif = criarRepoNotificacoes(db.pool); });

    it('a mais recente vem primeiro, e o sino guarda só as 50 últimas', async () => {
      for (let i = 0; i < MAX_POR_PESSOA + 5; i++) {
        await notif.criar(conta.id, `ntf-${i}`, { type: 'admin_notice', message: `aviso ${i}` });
      }
      const lista = await notif.doUsuario(conta.id);
      expect(lista).toHaveLength(MAX_POR_PESSOA);
      expect(lista[0]).toMatchObject({ id: `ntf-${MAX_POR_PESSOA + 4}`, read: false, type: 'admin_notice' });
      expect(lista.at(-1).id).toBe('ntf-5');
    });

    it('a mesma avaliação é UMA notificação: atualizar mescla, desmarca a leitura e sobe ao topo', async () => {
      const fila = await notif.criarOuAtualizar(conta.id, 'log:1', 'ntf-a', { type: 'evaluation_queued', message: 'na fila' });
      await notif.criar(conta.id, 'ntf-b', { type: 'admin_notice' });
      await notif.marcarTodasLidas(conta.id);

      await notif.criarOuAtualizar(conta.id, 'log:1', 'ntf-c', { type: 'evaluation_ready', message: 'pronta' });

      const [topo, segunda] = await notif.doUsuario(conta.id);
      expect(topo).toMatchObject({ id: fila.id, refId: 'log:1', type: 'evaluation_ready', message: 'pronta', read: false });
      expect(segunda.id).toBe('ntf-b');
    });

    it('atualizações simultâneas da mesma avaliação não duplicam', async () => {
      await Promise.all([1, 2, 3].map((n) => notif.criarOuAtualizar(conta.id, 'log:9', `ntf-${n}`, { type: 'evaluation_ready' })));
      expect(await notif.doUsuario(conta.id)).toHaveLength(1);
    });

    it('convite de duelo: marcar lido e remover mexem só no convite daquele duelo', async () => {
      await notif.criar(conta.id, 'n1', { type: 'duel_invite', duelId: 'd1' });
      await notif.criar(conta.id, 'n2', { type: 'duel_invite', duelId: 'd2' });

      await notif.marcarConviteDeDueloLido(conta.id, 'd1');
      expect((await notif.doUsuario(conta.id)).map((n) => [n.id, n.read])).toEqual([['n2', false], ['n1', true]]);

      await notif.removerConviteDeDuelo(conta.id, 'd2');
      expect((await notif.doUsuario(conta.id)).map((n) => n.id)).toEqual(['n1']);
    });

    it('visitante não recebe nem lê notificação', async () => {
      expect(await notif.criar('visitor-abc', 'x', { type: 'admin_notice' })).toBeNull();
      expect(await notif.doUsuario('visitor-abc')).toEqual([]);
    });

    it('push: renova no lugar, guarda até 10 dispositivos e remove os mortos', async () => {
      const sub = (n) => ({ endpoint: `https://push/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` }, ua: 'x' });
      for (let i = 0; i < 12; i++) await notif.inscrever(conta.id, sub(i));
      await notif.inscrever(conta.id, { ...sub(5), keys: { p256dh: 'novo', auth: 'novo' } });

      const lista = await notif.inscricoes(conta.id);
      expect(lista.map((s) => s.endpoint)).toEqual(Array.from({ length: 10 }, (_, i) => `https://push/${i + 2}`));
      expect(lista.find((s) => s.endpoint === 'https://push/5').keys).toEqual({ p256dh: 'novo', auth: 'novo' });

      await notif.desinscrever(conta.id, ['https://push/2', 'https://push/3']);
      expect(await notif.inscricoes(conta.id)).toHaveLength(8);
    });
  });

  describe('gamificação', () => {
    let gam;
    beforeEach(() => { gam = criarRepoGamificacao(db.pool); });

    it('resgatar é idempotente e guarda a primeira data', async () => {
      const primeira = await gam.resgatar(conta.id, 'primeira_sessao');
      const segunda = await gam.resgatar(conta.id, 'primeira_sessao');
      expect(segunda).toBe(primeira);
      expect(await gam.resgatadas(conta.id)).toEqual({ primeira_sessao: primeira });
      expect(await gam.todasResgatadas()).toEqual({ [conta.id]: { primeira_sessao: primeira } });
    });

    it('conquistas vistas: a primeira gravação é a linha de base, depois devolve o anterior', async () => {
      expect(await gam.trocarVistas(conta.id, ['a'])).toBeNull();
      expect(await gam.trocarVistas(conta.id, ['a', 'b'])).toEqual(['a']);
      expect(await gam.trocarVistas(conta.id, ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('microfone conta certo com usos simultâneos', async () => {
      await Promise.all(Array.from({ length: 7 }, () => gam.contarUsoDoMicrofone(conta.id)));
      expect(await gam.usosDoMicrofone(conta.id)).toBe(7);
      expect(await gam.usosDoMicrofone('visitor-x')).toBe(0);
    });

    it('sequência de missões: continua de ontem, recomeça depois de um buraco, conta o dia uma vez só', async () => {
      await gam.contarDiaDeMissoes(conta.id, '2026-09-10', '2026-09-09');
      await gam.contarDiaDeMissoes(conta.id, '2026-09-11', '2026-09-10');
      expect(await gam.contarDiaDeMissoes(conta.id, '2026-09-11', '2026-09-10')).toEqual({ current: 2, best: 2, lastDate: '2026-09-11' });

      expect(await gam.contarDiaDeMissoes(conta.id, '2026-09-14', '2026-09-13')).toEqual({ current: 1, best: 2, lastDate: '2026-09-14' });
    });
  });

  describe('operação', () => {
    let op;
    beforeEach(() => { op = criarRepoOperacao(db.pool); });

    const entrada = (id, idadeMs = 0) => ({ id, timestamp: new Date(Date.now() - idadeMs).toISOString(), where: 'teste', message: id });

    it('erros: mais recente primeiro, poda por teto e por idade', async () => {
      await op.registrarErro(entrada('velho', 40 * 86400000), { maximo: 3, ttlMs: 30 * 86400000 });
      for (const [i, id] of ['e1', 'e2', 'e3', 'e4'].entries()) {
        await op.registrarErro(entrada(id, (4 - i) * 1000), { maximo: 3, ttlMs: 30 * 86400000 });
      }
      expect((await op.erros()).map((e) => e.id)).toEqual(['e4', 'e3', 'e2']);
      expect(await op.limparErros()).toBe(3);
    });

    it('feedback: cria, lista do mais recente e exclui', async () => {
      await op.criarFeedback({ id: 'fb1', timestamp: '2026-09-01T10:00:00Z', userId: 'visitor-x', role: 'visitor', stars: 4, message: 'bom' });
      await op.criarFeedback({ id: 'fb2', timestamp: '2026-09-02T10:00:00Z', userId: conta.id, userName: 'Aluno', stars: 5, message: '' });
      expect((await op.feedbacks()).map((f) => f.id)).toEqual(['fb2', 'fb1']);
      expect(await op.excluirFeedback('fb1')).toBe(true);
      expect(await op.excluirFeedback('fb1')).toBe(false);
    });

    it('configuração: leitura é cópia, e alterações simultâneas de chaves diferentes não se perdem', async () => {
      await op.carregarConfig();
      const lida = op.lerConfig('settings', {});
      lida.sujeira = true;
      expect(op.lerConfig('settings', {})).toEqual({});

      await Promise.all([
        op.atualizarConfig('settings', {}, (s) => { s.visitorEvaluationEnabled = true; }),
        op.atualizarConfig('settings', {}, (s) => { s.selecaoPassword = 'nova'; }),
      ]);
      expect(op.lerConfig('settings', {})).toEqual({ visitorEvaluationEnabled: true, selecaoPassword: 'nova' });

      // E a memória bate com o banco depois de recarregar.
      await op.carregarConfig();
      expect(op.lerConfig('settings', {})).toEqual({ visitorEvaluationEnabled: true, selecaoPassword: 'nova' });

      // `false` não grava.
      await op.atualizarConfig('settings', {}, () => false);
      expect(op.lerConfig('settings', {})).toEqual({ visitorEvaluationEnabled: true, selecaoPassword: 'nova' });
    });
  });
});
