const mmr = require('../server/mmr');

// Jogador fora da calibração (n alto) com MMR P fixo.
function player(P, n = 10) {
  return { P, n, W: [] };
}

// Reproduz os exemplos numéricos do mmr_pvp_v1.md (§5). Asseguramos os DELTAS DA
// POOL PvP (pvp.deltaA/B), que são o que o doc tabela — o delta total do MMR
// inclui também o passo solo por cima.
describe('processDuel — exemplos do doc (PvP)', () => {
  it('Exemplo 1: favorito vence mas não domina (A 75 vs B 25, 60×40 → A −3 / B +3)', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 60, 40);
    expect(r.ranked).toBe(true);
    expect(r.pvp.pool).toBeCloseTo(20, 6);
    expect(r.pvp.deltaA).toBeCloseTo(-3, 6);
    expect(r.pvp.deltaB).toBeCloseTo(3, 6);
  });

  it('Exemplo 2: underdog domina (35×65 → A −8 / B +8)', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 35, 65);
    expect(r.pvp.deltaA).toBeCloseTo(-8, 6);
    expect(r.pvp.deltaB).toBeCloseTo(8, 6);
  });

  // OBS: o Exemplo 3 do doc (80×20) é INTERNAMENTE INCONSISTENTE — a nota 20 do
  // B viola a própria pré-condição anti-smurf (S >= 25). A regra (tabela §2 +
  // Exemplo 4) prevalece: 20 < 25 bloqueia. Implementamos a regra, não a tabela.
  it('80×20 é bloqueado pelo anti-smurf (20 < 25), apesar da tabela do Exemplo 3', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 80, 20);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
  });

  // Break-even (§6): favorito empata em MMR quando sua fração das notas = sua
  // fração do pool. A=75/B=25 → A precisa de 3× a nota de B → 75×25 dá delta 0.
  it('break-even: favorito com 3× a nota do oponente fica com delta ~0', () => {
    const r = mmr.processDuel(player(75), player(25), undefined, 75, 25);
    expect(r.ranked).toBe(true);
    expect(r.pvp.deltaA).toBeCloseTo(0, 6);
    expect(r.pvp.deltaB).toBeCloseTo(0, 6);
  });

  it('Exemplo 4: anti-smurf — nota < 25 bloqueia o duelo (sem alteração)', () => {
    const r = mmr.processDuel(player(70), player(68), undefined, 80, 18);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
    expect(r.pvp).toBeUndefined();
  });
});

describe('processDuel — pré-condições', () => {
  it('bloqueia se algum jogador ainda está em calibração (n < 5)', () => {
    const r = mmr.processDuel(player(60, 2), player(60, 10), undefined, 70, 60);
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('calibrating');
  });

  it('rankeado aplica delta PvP POR CIMA do MMR atualizado pelo solo', () => {
    const r = mmr.processDuel(player(50), player(70), undefined, 50, 50);
    expect(r.ranked).toBe(true);
    // notas iguais → cada um recebe metade do pool; quem tem MMR menor ganha
    // (apostou menos do que recebe). A apostou 10, B apostou 14, pool 24 → 12 cada.
    expect(r.pvp.deltaA).toBeCloseTo(2, 6);
    expect(r.pvp.deltaB).toBeCloseTo(-2, 6);
    // o MMR final é solo + pvp; não muta as entradas
    expect(r.playerA.P).not.toBe(50);
    expect(r.resultA.pvpDelta).toBeCloseTo(2, 6);
  });

  it('não muta os objetos de entrada', () => {
    const a = player(75);
    const b = player(25);
    mmr.processDuel(a, b, undefined, 60, 40);
    expect(a.P).toBe(75);
    expect(b.P).toBe(25);
    expect(a.n).toBe(10);
  });
});
