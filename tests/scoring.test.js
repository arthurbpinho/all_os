const { finalScoreFromCriteria } = require('../server/scoring');

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
