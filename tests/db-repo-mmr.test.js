// Repositório de MMR, TRI e recordes (server/repos/mmr.js) contra o Postgres de teste.
//
// O motor (server/mmr.js) tem os próprios testes; aqui o que se prova é a
// persistência e, principalmente, que partidas simultâneas não se perdem.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de MMR', () => {
  const { criarRepoMmr } = require('../server/repos/mmr');
  const { criarRepoContas } = require('../server/repos/contas');
  const mmrEngine = require('../server/mmr');

  let db;
  let mmr;
  let a;
  let b;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    mmr = criarRepoMmr(db.pool);
    const contas = criarRepoContas(db.pool);
    a = await contas.criar({ username: 'aluno', name: 'Aluno A', role: 'therapist', passwordHash: 'h' });
    b = await contas.criar({ username: 'outro', name: 'Outro B', role: 'therapist', passwordHash: 'h' });
  });

  afterEach(() => db.descartar());

  const veterano = () => ({ P: 50, n: 10, W: [{ S_aj: 50, D: 50, P: 50 }] });

  // Uma partida competitiva, como o POST /api/logs aplica.
  const partida = (userId, characterId, nota) => mmr.aplicar(
    { characterId, userIds: [userId], fonte: 'competitivo' },
    ({ players, character }) => {
      const out = mmrEngine.updateMatch(players[userId], character, nota);
      return {
        players: { [userId]: out.player },
        character: out.character,
        contarFonte: !out.result.calibratingBefore,
        result: out.result,
      };
    },
  );

  it('grava jogador e paciente, e só conta a fonte fora da calibração', async () => {
    const { result } = await partida(a.id, 'fp-1', 70);

    expect(result.calibratingBefore).toBe(true);
    expect((await mmr.jogador(a.id)).n).toBe(1);
    expect((await mmr.personagens())['fp-1'].n_D).toBe(0);
    expect(await mmr.fontes()).toEqual({});
  });

  it('duas partidas simultâneas do mesmo aluno contam as duas', async () => {
    await Promise.all([partida(a.id, 'fp-1', 70), partida(a.id, 'fp-2', 60)]);

    expect((await mmr.jogador(a.id)).n).toBe(2);
  });

  it('dois alunos no mesmo paciente ao mesmo tempo: a dificuldade conta os dois atendimentos', async () => {
    await mmr.importar({ players: { [a.id]: veterano(), [b.id]: veterano() } });

    await Promise.all([partida(a.id, 'fp-1', 20), partida(b.id, 'fp-1', 30)]);

    expect((await mmr.personagens())['fp-1'].n_D).toBe(2);
    expect(await mmr.fontes()).toEqual({ 'fp-1': { competitivo: 2 } });
  });

  it('TRI: terapeuta de MMR alto que vai mal empurra a dificuldade do paciente para cima', async () => {
    await mmr.importar({
      players: { [a.id]: { P: 85, n: 10, W: [{ S_aj: 85, D: 50, P: 85 }] } },
      characters: { 'fp-1': { D: 50, n_D: 5, alpha: null, beta: null, history: [] } },
    });

    await partida(a.id, 'fp-1', 20);

    expect((await mmr.personagens())['fp-1'].D).toBeGreaterThan(50);
  });

  it('TRI: terapeuta de MMR baixo que vai bem puxa a dificuldade para baixo', async () => {
    await mmr.importar({
      players: { [a.id]: { P: 20, n: 10, W: [{ S_aj: 20, D: 50, P: 20 }] } },
      characters: { 'fp-1': { D: 50, n_D: 5, alpha: null, beta: null, history: [] } },
    });

    await partida(a.id, 'fp-1', 90);

    expect((await mmr.personagens())['fp-1'].D).toBeLessThan(50);
  });

  it('só grava o que o cálculo devolve (duelo não rankeado não mexe no MMR)', async () => {
    await mmr.importar({ players: { [a.id]: veterano() } });

    await mmr.aplicar({ characterId: 'fp-1', userIds: [a.id, b.id] }, () => ({ ranked: false }));

    expect(await mmr.jogador(a.id)).toEqual(veterano());
    expect((await mmr.personagens())['fp-1']).toEqual(mmrEngine.newCharacter());
  });

  it('população anônima tem rating próprio e mexe na dificuldade compartilhada', async () => {
    await mmr.importar({
      characters: { 'fp-1': { D: 50, n_D: 5, alpha: null, beta: null, history: [] } },
      anonPlayers: { selecao: veterano() },
    });

    await mmr.aplicar({ characterId: 'fp-1', populacao: 'selecao', fonte: 'selecao' }, ({ populacao, character }) => {
      const out = mmrEngine.updateMatch(populacao, character, 20, { dWeight: 0.35 });
      return { populacao: out.player, character: out.character, contarFonte: !out.result.calibratingBefore };
    });

    expect((await mmr.populacoes()).selecao.n).toBe(11);
    expect((await mmr.personagens())['fp-1'].D).toBeGreaterThan(50);
    expect((await mmr.fontes())['fp-1']).toEqual({ selecao: 1 });
  });

  it('snapshot devolve o formato do mmr.json', async () => {
    const dados = {
      players: { [a.id]: veterano() },
      characters: { 'fp-1': { D: 60, n_D: 3, alpha: null, beta: null, history: [] } },
      anonPlayers: { visitante: veterano() },
      charSources: { 'fp-1': { competitivo: 3 } },
    };
    await mmr.importar(dados);

    expect(await mmr.snapshot()).toEqual(dados);
  });

  describe('recordes 👑', () => {
    it('só uma nota maior troca o dono; empate fica com quem chegou primeiro', async () => {
      expect(await mmr.registrarRecorde('fp-1', 70, { userId: a.id, userName: 'Aluno A' })).toMatchObject({ score: 70 });
      expect(await mmr.registrarRecorde('fp-1', 70, { userId: b.id, userName: 'Outro B' })).toBeNull();
      expect(await mmr.registrarRecorde('fp-1', 60, { userId: b.id, userName: 'Outro B' })).toBeNull();

      await mmr.registrarRecorde('fp-1', 80, { userId: b.id, userName: 'Outro B', userPhoto: '/b.jpg' });

      expect((await mmr.recordes())['fp-1']).toMatchObject({ score: 80, userId: b.id, userName: 'Outro B', userPhoto: '/b.jpg' });
    });

    it('notas simultâneas no mesmo paciente: fica a maior', async () => {
      await Promise.all([40, 90, 70, 85].map((nota, i) =>
        mmr.registrarRecorde('fp-1', nota, { userId: i % 2 ? a.id : b.id, userName: 'x' })));

      expect((await mmr.recordes())['fp-1'].score).toBe(90);
    });

    it('reset do ranking limpa os recordes', async () => {
      await mmr.registrarRecorde('fp-1', 70, { userId: a.id, userName: 'Aluno A' });

      await mmr.limparRecordes();

      expect(await mmr.recordes()).toEqual({});
    });
  });
});
