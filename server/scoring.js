// Cálculo da nota final (0–100) a partir das notas por critério.
//
// Por que isto vive em código (e não na IA): os avaliadores emitem APENAS as
// notas por critério (v18.25: bloco [notas], 15 critérios de 1 a 10 ou NA; logs
// antigos: [notas-supervisor] com 6 critérios). O que a IA NÃO faz (porque
// errava com frequência) é a conta da nota final: somar os critérios e
// converter de base para 0–100. Esse passo é determinístico e fica aqui.
//
// Fórmula (decisão do dono): soma das notas dos critérios (base = nº de
// critérios × 10, ex.: 15 critérios → base 150) convertida para base 100:
//   nota_final = round( soma / base * 100 )
// Isso equivale à média das notas × 10, mas mantemos a forma "soma → base → 100"
// porque a base varia: critério NA (10 e 13, quando o caso não dá material) fica
// FORA da conta — Number('NA') é NaN e o filtro abaixo o descarta —, então um
// atendimento com 14 critérios avaliados tem base 140, não 150.

function finalScoreFromCriteria(criteria) {
  if (!criteria || typeof criteria !== 'object') return null;
  const vals = Object.values(criteria)
    .map((v) => Number(String(v).replace(',', '.')))
    .filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = vals.length * 10; // 15 critérios → base 150 (14 se um sai NA)
  if (base === 0) return null;
  return Math.round((sum / base) * 100);
}

// Separa as notas comparativas (chaves A1..A15 / B1..B15) nas notas de cada aluno
// e calcula a nota final 0–100 de cada um. Retorna também o vencedor. Como cada
// nota final é uma média normalizada, os dois lados seguem comparáveis mesmo se
// um deles tiver um critério NA a mais (o 13 depende do que cada aluno explicitou).
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
