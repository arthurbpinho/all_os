// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const mmr = require('../server/mmr');

describe('MMR engine (server/mmr.js)', () => {
  describe('expectedScore', () => {
    it('cold start usa a fórmula provisória 50 + 0,5·(P−D)', () => {
      const p = { P: 70 };
      const c = mmr.newCharacter(); // n_D=0, cold start
      c.D = 80;
      expect(mmr.expectedScore(p, c)).toBeCloseTo(50 + 0.5 * (70 - 80), 6); // 45
    });

    it('fase madura usa a regressão (alpha + beta·gap) só com n_D ≥ 20 e coef finitos', () => {
      const p = { P: 70 };
      const c = { D: 80, n_D: 25, alpha: 52, beta: 0.45, history: [] };
      expect(mmr.expectedScore(p, c)).toBeCloseTo(47.5, 6);
      // sem coeficientes ainda → cai no cold start mesmo com n_D alto
      const c2 = { D: 80, n_D: 25, alpha: null, beta: null, history: [] };
      expect(mmr.expectedScore(p, c2)).toBeCloseTo(45, 6);
    });
  });

  describe('linearWeights', () => {
    it('normaliza, dá o maior peso ao MAIS RECENTE (último) e razão de 20× na janela cheia', () => {
      const w = mmr.linearWeights(20);
      const sum = w.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(w[19]).toBeGreaterThan(w[0]);            // mais recente > mais antigo
      expect(w[19] / w[0]).toBeCloseTo(20, 6);        // 20× (§5.2)
      expect(w[19]).toBeCloseTo(20 / 210, 6);         // ~9,5%
      expect(w[0]).toBeCloseTo(1 / 210, 6);           // ~0,5%
    });
    it('janela vazia → []', () => {
      expect(mmr.linearWeights(0)).toEqual([]);
    });
  });

  describe('sensitivity (K_p)', () => {
    it('0,50 na 1ª partida (n=0) e assintótico em 0,10', () => {
      expect(mmr.sensitivity(0)).toBeCloseTo(0.50, 6);
      expect(mmr.sensitivity(10)).toBeCloseTo(0.10 + 0.40 * Math.exp(-1.5), 6); // ~0,189
      expect(mmr.sensitivity(1000)).toBeCloseTo(0.10, 6);
    });
  });

  describe('fitRegression', () => {
    it('recupera alpha/beta de uma reta perfeita S = 50 + 0,5·gap', () => {
      const history = [
        { P: 60, D: 40, S: 60 }, // gap 20 → 60
        { P: 50, D: 50, S: 50 }, // gap 0  → 50
        { P: 40, D: 60, S: 40 }, // gap -20 → 40
        { P: 70, D: 30, S: 70 }, // gap 40 → 70
      ];
      const fit = mmr.fitRegression(history);
      expect(fit.alpha).toBeCloseTo(50, 6);
      expect(fit.beta).toBeCloseTo(0.5, 6);
    });
    it('retorna null com gap constante (variância ~0) ou poucos pontos', () => {
      expect(mmr.fitRegression([{ P: 50, D: 50, S: 40 }, { P: 60, D: 60, S: 70 }])).toBeNull();
      expect(mmr.fitRegression([{ P: 50, D: 50, S: 40 }])).toBeNull();
    });
  });

  describe('updateMatch — calibração e fronteira', () => {
    it('1ª partida: EMA pura, dificuldade NÃO muda, calibrando', () => {
      const { player, character, result } = mmr.updateMatch(undefined, undefined, 80);
      // P = (1-0.5)*50 + 0.5*S_aj, S_esp=50 (gap 0) → S_aj=80 → P=65
      expect(result.S_esp).toBeCloseTo(50, 6);
      expect(result.S_aj).toBeCloseTo(80, 6);
      expect(result.P_after).toBeCloseTo(65, 6);
      expect(result.D_after).toBe(50);          // dificuldade intacta na calibração
      expect(character.n_D).toBe(0);
      expect(result.n).toBe(1);
      expect(result.calibrating).toBe(true);
      expect(player.W.length).toBe(1);
    });

    it('dificuldade só se move a partir da 4ª partida (jogador fora da calibração)', () => {
      let p, c;
      for (let i = 1; i <= 3; i++) {
        const r = mmr.updateMatch(p, c, 80);
        p = r.player; c = r.character;
        expect(r.result.D_after).toBe(50);      // partidas 1..3: D fixo
        expect(c.n_D).toBe(0);
      }
      const r4 = mmr.updateMatch(p, c, 80);
      expect(r4.result.D_after).not.toBe(50);   // 4ª partida: D ajusta
      expect(r4.character.n_D).toBe(1);
      expect(r4.result.calibrating).toBe(false);
    });

    it('jogador forte (S=80) puxa a dificuldade pra baixo quando supera o esperado', () => {
      let p, c;
      for (let i = 1; i <= 3; i++) { const r = mmr.updateMatch(p, c, 80); p = r.player; c = r.character; }
      const r4 = mmr.updateMatch(p, c, 80);
      expect(r4.result.D_after).toBeLessThan(50); // overperformou → caso "mais fácil"
    });
  });

  describe('updateMatch — reproduz o exemplo do §6 do doc', () => {
    it('veterano (P=70,n=10) vs caso difícil maduro (D=80,α=52,β=0,45), S=40, P_W=72 → P≈66,4', () => {
      const W = Array.from({ length: 20 }, () => ({ S_aj: 72, D: 50, P: 70 })); // P_W = 72
      const player = { P: 70, n: 10, W };
      const character = { D: 80, n_D: 25, alpha: 52, beta: 0.45, history: [] };
      const { result } = mmr.updateMatch(player, character, 40);
      expect(result.S_esp).toBeCloseTo(47.5, 6);
      expect(result.D_after).toBeCloseTo(80.75, 6);
      expect(result.K_p).toBeCloseTo(0.189, 3);
      expect(result.S_aj).toBeCloseTo(42.5, 6);
      expect(result.P_after).toBeCloseTo(66.4, 1);
      expect(result.delta).toBeLessThan(0); // caiu de 70 → ~66,4
    });
  });

  describe('playerView', () => {
    it('oculta o MMR (null) durante a calibração e mostra arredondado depois', () => {
      expect(mmr.playerView({ P: 63.7, n: 2, W: [] })).toMatchObject({ calibrating: true, mmr: null, matchesRemaining: 1 });
      expect(mmr.playerView({ P: 63.7, n: 3, W: [] })).toMatchObject({ calibrating: false, mmr: 64 });
      expect(mmr.playerView(null)).toMatchObject({ calibrating: true, mmr: null, n: 0 });
    });
  });

  it('não muta o estado de entrada (funções puras)', () => {
    const player = mmr.newPlayer();
    const before = JSON.stringify(player);
    mmr.updateMatch(player, undefined, 70);
    expect(JSON.stringify(player)).toBe(before);
  });
});

describe('MMR via API', () => {
  beforeEach(() => resetData());

  async function competitiveMatch(token, score, itemId = 'fp-test-1') {
    return request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'freeplay', mode: 'competitive', itemId, itemTitle: 'Sofia',
      score, messages: [{ role: 'user', content: 'oi' }],
    });
  }

  it('partida competitiva atualiza o MMR e devolve o resultado no POST /api/logs', async () => {
    const aluno = await loginAs('aluno');
    const res = await competitiveMatch(aluno, 80);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('competitive');
    expect(res.body.mmr).toBeTruthy();
    expect(res.body.mmr.n).toBe(1);
    expect(res.body.mmr.calibrating).toBe(true);
  });

  it('modo treino (sem mode) NÃO mexe no MMR', async () => {
    const aluno = await loginAs('aluno');
    await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia', score: 80,
      messages: [{ role: 'user', content: 'oi' }],
    });
    const me = await request(app).get('/api/me/mmr').set(authHeader(aluno));
    expect(me.body.n).toBe(0);
    const rank = await request(app).get('/api/ranking').set(authHeader(aluno));
    expect(rank.body.find((r) => r.userId === '3')).toBeUndefined();
  });

  it('após 3 partidas o jogador aparece no ranking com MMR visível', async () => {
    const aluno = await loginAs('aluno');
    for (let i = 0; i < 3; i++) await competitiveMatch(aluno, 70);
    const rank = await request(app).get('/api/ranking').set(authHeader(aluno));
    const me = rank.body.find((r) => r.userId === '3');
    expect(me).toBeTruthy();
    expect(me.calibrating).toBe(false);
    expect(typeof me.mmr).toBe('number');
    expect(me.matches).toBe(3);
  });

  it('antes de completar a calibração (n<3) o ranking mostra calibrating=true e mmr=null', async () => {
    const aluno = await loginAs('aluno');
    for (let i = 0; i < 2; i++) await competitiveMatch(aluno, 70);
    const rank = await request(app).get('/api/ranking').set(authHeader(aluno));
    const me = rank.body.find((r) => r.userId === '3');
    expect(me.calibrating).toBe(true);
    expect(me.mmr).toBeNull();
    expect(me.matchesRemaining).toBe(1);
  });

  it('o reset de ranking PRESERVA o MMR (zera só as notas dos logs)', async () => {
    const aluno = await loginAs('aluno');
    const admin = await loginAs('admin');
    for (let i = 0; i < 5; i++) await competitiveMatch(aluno, 70);
    const before = (await request(app).get('/api/ranking').set(authHeader(aluno))).body.find((r) => r.userId === '3');

    const reset = await request(app).post('/api/admin/ranking/reset').set(authHeader(admin));
    expect(reset.status).toBe(200);

    const after = (await request(app).get('/api/ranking').set(authHeader(aluno))).body.find((r) => r.userId === '3');
    expect(after).toBeTruthy();
    expect(after.mmr).toBe(before.mmr);   // MMR intacto
    expect(after.matches).toBe(5);
  });

  it('GET /api/freeplay expõe a dificuldade (baseline 50 antes de qualquer partida)', async () => {
    const aluno = await loginAs('aluno');
    const res = await request(app).get('/api/freeplay').set(authHeader(aluno));
    const sofia = res.body.find((c) => c.id === 'fp-test-1');
    expect(sofia.difficulty).toBe(50);
    expect(sofia.competitiveMatches).toBe(0);
    // não vaza o prompt secreto pro aluno
    expect(sofia.specificInstruction).toBeUndefined();
  });

  it('visitante não pontua MMR mesmo enviando mode competitive', async () => {
    const visitor = await request(app).post('/api/login/visitor').send({});
    const vtoken = visitor.body.token;
    const res = await competitiveMatch(vtoken, 90);
    expect(res.status).toBe(200);
    expect(res.body.mmr).toBeNull(); // visitante não entra no MMR
  });
});
