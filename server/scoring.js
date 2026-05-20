// Cálculo da nota final (0–100) a partir das notas por critério.
//
// Por que isto vive em código (e não na IA): os avaliadores (v15, progressão e
// comparativo) emitem APENAS o bloco [notas-supervisor] com a nota de cada
// critério (0–10). A nota de cada critério já é a média aritmética dos seus
// subcritérios — esse passo o avaliador faz. O que a IA NÃO faz mais (porque
// errava com frequência) é a conta da nota final: somar os critérios e
// converter de base para 0–100. Esse passo é determinístico e fica aqui.
//
// Fórmula (decisão do dono): soma das notas dos critérios (base = nº de
// critérios × 10, ex.: 6 critérios → base 60) convertida para base 100:
//   nota_final = round( soma / base * 100 )
// Com 6 critérios isso equivale a (média dos 6) × 10, mas mantemos a forma
// "soma → base → 100" para ser robusto quando algum critério opcional não vem.

function finalScoreFromCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const vals = Object.values(criteria)
    .map((v) => Number(String(v).replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = vals.length * 10; // 6 critérios → base 60
  if (base === 0) return null;
  return Math.round((sum / base) * 100);
}

// Separa o JSON comparativo (chaves A1..A6 / B1..B6) nas notas de cada aluno e
// calcula a nota final 0–100 de cada um. Retorna também o vencedor.
// Retorna null se não der pra montar as duas notas.
function comparativeScores(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const a = {};
  const b = {};
  for (const [k, v] of Object.entries(criteria)) {
    const m = /^([AB])\s*0*(\d+)$/i.exec(String(k).trim());
    if (!m) continue;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    if (m[1].toUpperCase() === 'A') a[m[2]] = n;
    else b[m[2]] = n;
  }
  const scoreA = finalScoreFromCriteria(a);
  const scoreB = finalScoreFromCriteria(b);
  if (scoreA === null || scoreB === null) return null;
  let winner;
  if (scoreA > scoreB) winner = 'A';
  else if (scoreB > scoreA) winner = 'B';
  else winner = 'draw';
  return { criteriaA: a, criteriaB: b, scoreA, scoreB, winner };
}

module.exports = { finalScoreFromCriteria, comparativeScores };
