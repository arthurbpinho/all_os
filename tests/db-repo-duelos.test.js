// Repositório de duelos (server/repos/duelos.js) contra o Postgres de teste.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de duelos', () => {
  const { criarRepoDuelos } = require('../server/repos/duelos');

  let db;
  let duelos;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    duelos = criarRepoDuelos(db.pool);
  });

  afterEach(() => db.descartar());

  let seq = 0;
  // Um duelo como o POST /api/duel monta, com convite aberto por link.
  const novoDuelo = (dados = {}) => {
    seq += 1;
    return duelos.criar({
      id: `duel-${Date.now()}-${seq}`,
      token: `token-${seq}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: 'training',
      status: 'pending',
      inviteMethod: 'whatsapp',
      character: { id: 'fp-1', name: 'Sofia' },
      challenger: { userId: '3', name: 'Aluno A', isVisitor: false, state: 'in_progress', messages: [], durationSeconds: 0, submittedAt: null },
      opponent: { userId: null, name: null, isVisitor: true, kind: 'open', state: 'invited', accepted: false, messages: [], durationSeconds: 0, submittedAt: null },
      result: null,
      ...dados,
    });
  };

  // O aceite de duelo aberto: o primeiro trava o lado do oponente.
  const aceitar = (token, userId) => duelos.travar({ token }, (d) => {
    if (d.opponent.userId && d.opponent.userId !== userId) return { valor: 'já aceito por outra pessoa' };
    Object.assign(d.opponent, { userId, name: userId, accepted: true, state: 'in_progress' });
    return { gravar: true, valor: 'ok' };
  });

  it('grava e lê o documento por id e por token', async () => {
    const d = await novoDuelo();

    expect(await duelos.porId(d.id)).toEqual(d);
    expect((await duelos.porToken(d.token)).id).toBe(d.id);
    expect(await duelos.porId('duel-inexistente')).toBeNull();
  });

  it('lista os duelos de um participante, conta ou visitante', async () => {
    const meu = await novoDuelo();
    const aceito = await novoDuelo();
    await aceitar(aceito.token, 'visitor-abc123');
    await novoDuelo({ challenger: { userId: '9', name: 'Outro', state: 'in_progress', messages: [] } });

    expect((await duelos.listarDoParticipante('3')).map((d) => d.id)).toEqual([meu.id, aceito.id]);
    expect((await duelos.listarDoParticipante('visitor-abc123')).map((d) => d.id)).toEqual([aceito.id]);
    expect(await duelos.listarTodos()).toHaveLength(3);
  });

  it('travar grava a alteração, exclui quando pedido e avisa quando não encontra', async () => {
    const d = await novoDuelo();

    const r = await duelos.travar({ id: d.id }, (x) => { x.status = 'completed'; return { gravar: true, valor: x.status }; });
    expect(r).toEqual({ encontrado: true, valor: 'completed' });
    expect((await duelos.porId(d.id)).status).toBe('completed');

    await duelos.travar({ id: d.id }, () => ({ excluir: true }));
    expect(await duelos.porId(d.id)).toBeNull();

    expect(await duelos.travar({ id: d.id }, () => ({ gravar: true }))).toEqual({ encontrado: false });
  });

  it('dois aceites simultâneos do mesmo link: só o primeiro fica com o lado', async () => {
    const d = await novoDuelo();

    const respostas = await Promise.all([
      aceitar(d.token, 'visitor-aaa111'),
      aceitar(d.token, 'visitor-bbb222'),
    ]);

    expect(respostas.map((r) => r.valor).sort()).toEqual(['já aceito por outra pessoa', 'ok']);
    const final = await duelos.porId(d.id);
    expect(['visitor-aaa111', 'visitor-bbb222']).toContain(final.opponent.userId);
  });

  it('poda remove só os vencidos e devolve as chaves dos detalhes deles', async () => {
    const velho = new Date(Date.now() - 40 * 86400000).toISOString();
    await novoDuelo({ createdAt: velho, result: { evalPartsId: 'av-1-aaaaaaaa' } });
    const recente = await novoDuelo();

    const r = await duelos.podarVencidos(30 * 86400000);

    expect(r).toEqual({ removidos: 1, evalPartsIds: ['av-1-aaaaaaaa'] });
    expect((await duelos.listarTodos()).map((x) => x.id)).toEqual([recente.id]);
  });
});
