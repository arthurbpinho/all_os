// Repositório de MMR, TRI e recordes (server/repos/mmr.js) contra o Postgres
// de teste, reformulado para o motor por critério (spec MMR-por-criterio.md).
//
// O motor tem os próprios testes puros em tests/mmr.test.js; aqui o que se
// prova é a persistência, e principalmente que partidas simultâneas não se
// perdem no formato JSONB novo.

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

  // "Veterano" no formato novo: 1 critério "c1" com P razoável e passou da
  // calibração (nEntradas = 10).
  const veterano = () => ({
    nEntradas: 10,
    criterios: { c1: { P: 60, n: 10, janela: [{ N: 60, D_antes: 50, P_antes: 60 }] } },
  });

  // Uma partida competitiva, como o POST /api/logs aplica agora.
  const partida = (userId, characterId, criteriosById, notaTotal) => mmr.aplicar(
    { characterId, userIds: [userId] },
    ({ players, character, fontes }) => {
      const out = mmrEngine.updateMatch(players[userId], character, fontes, {
        criterios: criteriosById, notaTotal, fonte: 'competitivo',
      });
      return {
        players: { [userId]: out.player },
        character: out.character,
        fontes: out.fontes,
        result: out.result,
      };
    },
  );

  it('grava jogador e paciente com o formato novo (nEntradas + criterios)', async () => {
    await partida(a.id, 'fp-1', { c1: 70 }, 70);
    const estado = await mmr.jogador(a.id);
    expect(estado.nEntradas).toBe(1);
    expect(estado.criterios.c1.n).toBe(1);
    // D moveu-se (a trava de 25 só bloqueia quando o total é < 25)
    expect((await mmr.personagens())['fp-1'].criterios.c1.n_D).toBe(1);
    // Fonte por critério (spec §12)
    expect((await mmr.fontes())['fp-1'].c1.competitivo).toBe(1);
  });

  it('trava de 25 não move o D nem incrementa a fonte, mas move o P', async () => {
    await partida(a.id, 'fp-1', { c1: 20 }, 20);
    expect((await mmr.jogador(a.id)).criterios.c1.n).toBe(1);
    // O motor cria a linha do critério dentro do character antes da trava,
    // então a estrutura existe em default (D=50, n_D=0). O que importa é que
    // D não se moveu e n_D ficou zerado.
    const char = (await mmr.personagens())['fp-1'];
    const cc = char.criterios.c1;
    expect(cc.D).toBe(50);
    expect(cc.n_D).toBe(0);
    expect(cc.historico).toEqual([]);
    expect(await mmr.fontes()).toEqual({});
  });

  it('duas partidas simultâneas do mesmo aluno contam as duas', async () => {
    await Promise.all([
      partida(a.id, 'fp-1', { c1: 70 }, 70),
      partida(a.id, 'fp-2', { c1: 60 }, 60),
    ]);
    expect((await mmr.jogador(a.id)).nEntradas).toBe(2);
  });

  it('dois alunos no mesmo paciente ao mesmo tempo: n_D conta os dois', async () => {
    await Promise.all([
      partida(a.id, 'fp-1', { c1: 40 }, 40),
      partida(b.id, 'fp-1', { c1: 45 }, 45),
    ]);
    expect((await mmr.personagens())['fp-1'].criterios.c1.n_D).toBe(2);
    expect((await mmr.fontes())['fp-1'].c1.competitivo).toBe(2);
  });

  it('só grava o que o cálculo devolve (duelo não rankeado não mexe em nada)', async () => {
    const antes = veterano();
    await mmr.importar({ players: { [a.id]: antes } });
    await mmr.aplicar({ characterId: 'fp-1', userIds: [a.id, b.id] }, () => ({ ranked: false }));
    expect(await mmr.jogador(a.id)).toEqual(antes);
    expect((await mmr.personagens())['fp-1'].criterios).toEqual({});
  });

  it('snapshot devolve o formato do mmr.json com o shape novo', async () => {
    const dados = {
      players: { [a.id]: veterano() },
      characters: { 'fp-1': { criterios: { c1: { D: 60, n_D: 3, beta: 1, historico: [] } } } },
      anonPlayers: { visitante: veterano() },
      charSources: { 'fp-1': { c1: { competitivo: 3, selecao: 0, visitante: 0 } } },
    };
    await mmr.importar(dados);
    expect(await mmr.snapshot()).toEqual(dados);
  });

  describe('recordes 👑', () => {
    it('só nota maior troca o dono; empate fica com quem chegou primeiro', async () => {
      expect(await mmr.registrarRecorde('fp-1', 70, { userId: a.id, userName: 'Aluno A' })).toMatchObject({ score: 70, origem: 'competitivo' });
      expect(await mmr.registrarRecorde('fp-1', 70, { userId: b.id, userName: 'Outro B' })).toBeNull();
      expect(await mmr.registrarRecorde('fp-1', 60, { userId: b.id, userName: 'Outro B' })).toBeNull();

      await mmr.registrarRecorde('fp-1', 80, { userId: b.id, userName: 'Outro B', userPhoto: '/b.jpg' });

      expect((await mmr.recordes())['fp-1']).toMatchObject({
        score: 80, userId: String(b.id), userName: 'Outro B', userPhoto: '/b.jpg', origem: 'competitivo',
      });
    });

    it('candidato do seletivo bate recorde sem userId (spec §9)', async () => {
      const r = await mmr.registrarRecorde('fp-1', 92, {
        userId: null, userName: 'Ana Beatriz', origem: 'selecao',
      });
      expect(r).toMatchObject({ score: 92, userId: null, userName: 'Ana Beatriz', origem: 'selecao' });
      // Um competitivo maior toma o lugar (a comparação é só pela nota).
      await mmr.registrarRecorde('fp-1', 95, { userId: a.id, userName: 'Aluno A', origem: 'competitivo' });
      expect((await mmr.recordes())['fp-1']).toMatchObject({ score: 95, origem: 'competitivo' });
    });

    it('recusa origem inválida', async () => {
      await expect(mmr.registrarRecorde('fp-1', 70, {
        userId: a.id, userName: 'x', origem: 'visitante',
      })).rejects.toThrow(/origem/);
    });

    it('notas simultâneas no mesmo paciente: fica a maior', async () => {
      await Promise.all([40, 90, 70, 85].map((nota, i) =>
        mmr.registrarRecorde('fp-1', nota, {
          userId: i % 2 ? a.id : b.id, userName: 'x', origem: 'competitivo',
        })));
      expect((await mmr.recordes())['fp-1'].score).toBe(90);
    });

    it('reset do ranking limpa os recordes', async () => {
      await mmr.registrarRecorde('fp-1', 70, { userId: a.id, userName: 'Aluno A' });
      await mmr.limparRecordes();
      expect(await mmr.recordes()).toEqual({});
    });
  });
});
