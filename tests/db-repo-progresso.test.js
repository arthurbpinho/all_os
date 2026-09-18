// Repositório de progresso da Trilha (server/repos/progresso.js) contra o Postgres de teste.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de progresso', () => {
  const { criarRepoProgresso } = require('../server/repos/progresso');
  const { criarRepoContas } = require('../server/repos/contas');

  let db;
  let progresso;
  let aluno;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    progresso = criarRepoProgresso(db.pool);
    aluno = await criarRepoContas(db.pool).criar({ username: 'aluno', name: 'Aluno A', role: 'therapist', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  it('merge raso por chave, como o POST /api/progress fazia', async () => {
    await progresso.mesclar(aluno.id, { 'ex-1': { score: 80, passed: true, tentativas: 2 } });
    await progresso.mesclar(aluno.id, { 'ex-2': { score: 50, passed: false } });

    // A chave inteira é substituída: `tentativas` some, como no spread do JSON.
    const final = await progresso.mesclar(aluno.id, { 'ex-1': { score: 90, passed: true } });

    expect(final).toEqual({
      'ex-1': { score: 90, passed: true },
      'ex-2': { score: 50, passed: false },
    });
    expect(Object.keys(await progresso.doDono(aluno.id))).toEqual(['ex-1', 'ex-2']);
  });

  it('visitante também tem progresso, pelo id efêmero', async () => {
    await progresso.mesclar('visitor-abc123', { 'ex-1': { passed: true } });

    expect(await progresso.doDono('visitor-abc123')).toEqual({ 'ex-1': { passed: true } });
    expect(await progresso.doDono(aluno.id)).toEqual({});
  });

  it('gravações simultâneas de chaves diferentes não se apagam', async () => {
    const chaves = Array.from({ length: 10 }, (_, i) => `ex-${i}`);

    await Promise.all(chaves.map((c) => progresso.mesclar(aluno.id, { [c]: { passed: true } })));

    expect(Object.keys(await progresso.doDono(aluno.id)).sort()).toEqual([...chaves].sort());
  });

  it('dono inválido: leitura vazia e gravação recusada', async () => {
    expect(await progresso.doDono('lixo')).toEqual({});
    expect(await progresso.mesclar('lixo', { 'ex-1': {} })).toBeNull();
  });

  it('reset do ranking limpa o progresso de todo mundo', async () => {
    await progresso.mesclar(aluno.id, { 'ex-1': { passed: true } });
    await progresso.mesclar('visitor-abc123', { 'ex-1': { passed: true } });

    await progresso.limparTudo();

    expect(await progresso.doDono(aluno.id)).toEqual({});
    expect(await progresso.doDono('visitor-abc123')).toEqual({});
  });
});
