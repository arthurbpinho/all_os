const { finalScoreFromCriteria, comparativeScores } = require('../server/scoring');

// Fórmula (decisão do dono): soma das notas dos critérios convertida de base
// (nº de critérios × 10) para base 100.
describe('finalScoreFromCriteria', () => {
  it('6 critérios → soma/60 × 100, arredondado', () => {
    // soma = 30.33 → 30.33/60*100 = 50.55 → 51
    const s = finalScoreFromCriteria({ 1: 4.33, 2: 5.25, 3: 5.5, 4: 4.75, 5: 5, 6: 5.5 });
    expect(s).toBe(51);
  });

  it('todos 10 → 100; todos 0 → 0; todos 5 → 50', () => {
    expect(finalScoreFromCriteria({ 1: 10, 2: 10, 3: 10, 4: 10, 5: 10, 6: 10 })).toBe(100);
    expect(finalScoreFromCriteria({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 })).toBe(0);
    expect(finalScoreFromCriteria({ 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5 })).toBe(50);
  });

  it('robusto quando vêm menos de 6 critérios (base = nº × 10)', () => {
    // 3 critérios [6,8,10] → soma 24, base 30 → 80
    expect(finalScoreFromCriteria({ 1: 6, 2: 8, 3: 10 })).toBe(80);
  });

  it('aceita vírgula decimal e ignora valores não numéricos', () => {
    expect(finalScoreFromCriteria({ 1: '4,5', 2: 5.5, x: 'abc' })).toBe(50); // (4.5+5.5)/20*100
  });

  it('retorna null sem critérios válidos', () => {
    expect(finalScoreFromCriteria({})).toBeNull();
    expect(finalScoreFromCriteria(null)).toBeNull();
    expect(finalScoreFromCriteria({ a: 'x' })).toBeNull();
  });
});

describe('comparativeScores', () => {
  it('separa A1..A6 / B1..B6, calcula notas e aponta o vencedor', () => {
    const criteria = {
      A1: 6, A2: 6, A3: 6, A4: 6, A5: 6, A6: 6,
      B1: 8, B2: 8, B3: 8, B4: 8, B5: 8, B6: 8,
    };
    const r = comparativeScores(criteria);
    expect(r.scoreA).toBe(60);
    expect(r.scoreB).toBe(80);
    expect(r.winner).toBe('B');
    expect(r.criteriaA).toEqual({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: 6 });
  });

  it('empate quando as notas finais coincidem', () => {
    const r = comparativeScores({ A1: 5, A2: 5, A3: 5, A4: 5, A5: 5, A6: 5, B1: 5, B2: 5, B3: 5, B4: 5, B5: 5, B6: 5 });
    expect(r.winner).toBe('draw');
    expect(r.scoreA).toBe(50);
    expect(r.scoreB).toBe(50);
  });

  it('A vence quando soma mais', () => {
    const r = comparativeScores({ A1: 9, A2: 9, A3: 9, A4: 9, A5: 9, A6: 9, B1: 4, B2: 4, B3: 4, B4: 4, B5: 4, B6: 4 });
    expect(r.winner).toBe('A');
  });

  it('retorna null se faltar um dos lados', () => {
    expect(comparativeScores({ A1: 5, A2: 5 })).toBeNull(); // sem B
    expect(comparativeScores({})).toBeNull();
  });
});
