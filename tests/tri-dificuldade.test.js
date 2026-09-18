// TRI — a dificuldade do paciente reage ao NÍVEL de quem atendeu (demandas §16.7).
//
// A regra: depois de o terapeuta X atender o paciente Y e tirar a nota W, a
// dificuldade de Y é corrigida pela surpresa da nota em relação ao que o MMR de X
// previa. MMR alto + nota baixa → Y é mais difícil do que se pensava (D sobe);
// MMR baixo + nota alta → Y é mais fácil (D desce). Nas 3 primeiras partidas de
// um terapeuta (calibração) o D não mexe: o MMR dele ainda não diz nada.
//
// Aqui cada cenário é provado no motor puro (server/mmr.js) e depois ponta a
// ponta pelo caminho real do Competitivo (POST /api/logs), lendo o D de volta
// da tabela mmr_characters.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const mmr = require('../server/mmr');

// Terapeuta fora da calibração, com janela de uma partida no próprio nível.
const calibrado = (P) => ({ P, n: 10, W: [{ S_aj: P, D: 50, P }] });
const paciente = (D, extra = {}) => ({ D, n_D: 5, alpha: null, beta: null, history: [], ...extra });

describe('TRI — dificuldade do paciente no motor', () => {
  it('MMR alto e nota baixa: a dificuldade do paciente sobe', () => {
    const { character, result } = mmr.updateMatch(calibrado(85), paciente(50), 20);
    expect(result.calibratingBefore).toBe(false);
    expect(character.D).toBeGreaterThan(50);
    expect(character.n_D).toBe(6);
  });

  it('MMR baixo e nota alta: a dificuldade do paciente desce', () => {
    const { character } = mmr.updateMatch(calibrado(20), paciente(50), 90);
    expect(character.D).toBeLessThan(50);
  });

  it('nota igual à esperada: a dificuldade não muda', () => {
    // P 70 contra D 50 no cold start: esperada = 50 + 0,5 × 20 = 60.
    const antes = paciente(50);
    expect(mmr.expectedScore(calibrado(70), antes)).toBeCloseTo(60, 9);
    const { character } = mmr.updateMatch(calibrado(70), antes, 60);
    expect(character.D).toBeCloseTo(50, 9);
    // Ainda conta como atendimento observado, só que sem surpresa.
    expect(character.n_D).toBe(6);
  });

  it('terapeuta em calibração (menos de 3 partidas) não mexe na dificuldade', () => {
    // Sinal forte de propósito: se a calibração vazasse, o D andaria bastante.
    for (let n = 0; n < mmr.CALIBRATION_MATCHES; n++) {
      const jogador = { P: 90, n, W: [] };
      const { character, result } = mmr.updateMatch(jogador, paciente(50), 5);
      expect(result.calibratingBefore).toBe(true);
      expect(character.D).toBe(50);
      expect(character.n_D).toBe(5);
      expect(character.history).toEqual([]);
    }
    // Na 4ª partida (n = 3) o ajuste liga.
    const quarta = mmr.updateMatch({ P: 90, n: mmr.CALIBRATION_MATCHES, W: [{ S_aj: 90, D: 50, P: 90 }] }, paciente(50), 5);
    expect(quarta.result.calibratingBefore).toBe(false);
    expect(quarta.character.D).toBeGreaterThan(50);
  });

  it('calibração percorrida de verdade: as 3 primeiras partidas deixam o D intacto e a 4ª move', () => {
    let jogador;
    let pac = paciente(50);
    for (let i = 0; i < 3; i++) {
      ({ player: jogador, character: pac } = mmr.updateMatch(jogador, pac, 10));
      expect(pac.D).toBe(50);
    }
    const quarta = mmr.updateMatch(jogador, pac, 10);
    expect(quarta.character.D).not.toBe(50);
  });

  describe('magnitude: deltaD = 0,1 × (esperada − real)', () => {
    it('valor calculado à mão no cold start', () => {
      // P 80, D 50 → esperada = 50 + 0,5 × 30 = 65. Nota 25 → deltaD = 0,1 × 40 = 4.
      const { character, result } = mmr.updateMatch(calibrado(80), paciente(50), 25);
      expect(result.S_esp).toBeCloseTo(65, 9);
      expect(character.D).toBeCloseTo(54, 9);
    });

    it('valor calculado à mão no sentido contrário', () => {
      // P 30, D 60 → esperada = 50 + 0,5 × (−30) = 35. Nota 85 → deltaD = 0,1 × (−50) = −5.
      const { character } = mmr.updateMatch(calibrado(30), paciente(60), 85);
      expect(character.D).toBeCloseTo(55, 9);
    });

    it('com paciente maduro, a esperada vem da regressão e o passo segue a mesma razão', () => {
      // alpha 40, beta 0,8, gap 70 − 50 = 20 → esperada = 56. Nota 36 → deltaD = 2.
      const maduro = paciente(50, { n_D: 30, alpha: 40, beta: 0.8 });
      const { character, result } = mmr.updateMatch(calibrado(70), maduro, 36);
      expect(result.S_esp).toBeCloseTo(56, 9);
      expect(character.D).toBeCloseTo(52, 9);
    });

    it('o passo é proporcional à surpresa em várias combinações', () => {
      for (const [P, D, S] of [[85, 50, 20], [20, 50, 90], [60, 40, 55], [50, 70, 10]]) {
        const antes = paciente(D);
        const esperada = mmr.expectedScore(calibrado(P), antes);
        const { character, result } = mmr.updateMatch(calibrado(P), antes, S);
        expect(result.S_esp).toBeCloseTo(esperada, 9);
        expect(character.D - D).toBeCloseTo(0.1 * (esperada - S), 9);
      }
    });

    it('o D respeita o teto e o piso (10..90)', () => {
      expect(mmr.updateMatch(calibrado(90), paciente(89), 0).character.D).toBe(mmr.D_MAX);
      expect(mmr.updateMatch(calibrado(10), paciente(11), 100).character.D).toBe(mmr.D_MIN);
    });
  });
});

describe('TRI — dificuldade do paciente ponta a ponta (Competitivo → banco)', () => {
  beforeEach(() => resetData());

  const { criarRepoMmr } = require('../server/repos/mmr');
  const mmrRepo = criarRepoMmr(db.getPool());
  const ALUNO_ID = '3'; // 'aluno' semeado pelo resetData

  // Lê direto da tabela, sem passar pelo repo, para provar o que ficou gravado.
  async function dificuldadeGravada(characterId) {
    const { rows } = await db.query('SELECT estado FROM mmr_characters WHERE character_id = $1', [characterId]);
    return rows[0] ? rows[0].estado : null;
  }

  // O mesmo corpo que o cliente manda ao fim de uma partida competitiva com nota.
  const partidaCompetitiva = (token, score) => request(app).post('/api/logs').set(authHeader(token)).send({
    type: 'freeplay', mode: 'competitive', itemId: 'fp-test-1', itemTitle: 'Sofia',
    score, messages: [{ role: 'user', content: 'oi' }],
  });

  async function semear(P, D) {
    await mmrRepo.importar({
      players: { [ALUNO_ID]: calibrado(P) },
      characters: { 'fp-test-1': paciente(D) },
    });
  }

  it('MMR alto e nota baixa: o D gravado sobe exatamente o passo da fórmula', async () => {
    await semear(80, 50);
    const aluno = await loginAs('aluno');

    const res = await partidaCompetitiva(aluno, 25);
    expect(res.status).toBe(200);
    expect(res.body.mmr).toBeTruthy();

    const estado = await dificuldadeGravada('fp-test-1');
    expect(estado.D).toBeCloseTo(54, 9); // esperada 65, real 25 → +4
    expect(estado.n_D).toBe(6);
    expect(estado.history.at(-1)).toMatchObject({ P: 80, D: 50, S: 25 });
  });

  it('MMR baixo e nota alta: o D gravado desce', async () => {
    await semear(20, 50);
    const aluno = await loginAs('aluno');

    await partidaCompetitiva(aluno, 90);

    expect((await dificuldadeGravada('fp-test-1')).D).toBeLessThan(50);
  });

  it('o D persiste e acumula entre partidas (lido de volta do banco a cada vez)', async () => {
    await semear(85, 50);
    const aluno = await loginAs('aluno');

    await partidaCompetitiva(aluno, 20);
    const primeira = (await dificuldadeGravada('fp-test-1')).D;
    await partidaCompetitiva(aluno, 20);
    const segunda = (await dificuldadeGravada('fp-test-1')).D;

    expect(primeira).toBeGreaterThan(50);
    expect(segunda).toBeGreaterThan(primeira);
    // A dificuldade exposta ao aluno é a gravada.
    const lista = await request(app).get('/api/freeplay').set(authHeader(aluno));
    expect(lista.body.find((c) => c.id === 'fp-test-1').difficulty).toBe(Math.round(segunda));
  });

  it('aluno em calibração joga pelo Competitivo e o D gravado fica na baseline', async () => {
    const aluno = await loginAs('aluno');

    for (let i = 0; i < mmr.CALIBRATION_MATCHES; i++) {
      const res = await partidaCompetitiva(aluno, 5);
      expect(res.status).toBe(200);
      const estado = await dificuldadeGravada('fp-test-1');
      expect(estado.D).toBe(mmr.D0);
      expect(estado.n_D).toBe(0);
    }

    // Saiu da calibração: a 4ª partida já move o D.
    await partidaCompetitiva(aluno, 5);
    expect((await dificuldadeGravada('fp-test-1')).n_D).toBe(1);
  });
});

// --- Duelo ------------------------------------------------------------------
// No duelo cada lado é processado como uma partida contra o MESMO paciente, em
// sequência (A e depois B): a dificuldade recebe as duas surpresas. A regra de
// calibração vale para a dupla — basta um dos dois estar calibrando para o duelo
// não valer, e aí o paciente não é tocado.
describe('TRI — dificuldade do paciente no duelo', () => {
  it('duelo ranqueado move a dificuldade como duas partidas em sequência', () => {
    // As duas notas precisam ficar acima do piso anti-smurf (PVP_MIN_SCORE);
    // abaixo dele o duelo não vale, e é o que o terceiro caso cobre.
    const r = mmr.processDuel(calibrado(85), calibrado(30), paciente(50), 35, 90);
    expect(r.ranked).toBe(true);

    const upA = mmr.updateMatch(calibrado(85), paciente(50), 35);
    const upB = mmr.updateMatch(calibrado(30), upA.character, 90);
    expect(r.character.D).toBeCloseTo(upB.character.D, 9);
    expect(r.character.n_D).toBe(7); // os 5 de antes mais os dois lados
  });

  it('com alguém em calibração o duelo não vale e a dificuldade não muda', () => {
    const paciente50 = paciente(50);
    const r = mmr.processDuel({ P: 85, n: 1, W: [] }, calibrado(30), paciente50, 35, 90);
    expect(r).toMatchObject({ ranked: false, reason: 'calibrating' });
    expect(r.character).toBeUndefined();
    expect(paciente50).toMatchObject({ D: 50, n_D: 5 });
  });

  it('nota abaixo do piso anti-smurf também não mexe na dificuldade', () => {
    const paciente50 = paciente(50);
    const r = mmr.processDuel(calibrado(85), calibrado(30), paciente50, mmr.PVP_MIN_SCORE - 1, 90);
    expect(r).toMatchObject({ ranked: false, reason: 'anti_smurf' });
    expect(paciente50).toMatchObject({ D: 50, n_D: 5 });
  });
});
