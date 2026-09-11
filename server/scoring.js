// Cálculo da nota final (0–100) a partir das notas por critério.
//
// Por que isto vive em código (e não na IA): os avaliadores de prompt único
// emitem APENAS as notas por critério (v18.25, hoje só o de Neuro: bloco
// [notas], notas de 1 a 10 ou NA; logs antigos: [notas-supervisor] com 6
// critérios). O que a IA NÃO faz (porque errava com frequência) é a conta da
// nota final: somar os critérios e converter de base para 0–100. Esse passo é
// determinístico e fica aqui.
//
// O AVALIADOR OFICIAL (pipeline v34) não passa por aqui: lá a nota de cada
// critério é a soma de cinco qualidades e a final é a média × 10, feita pelo
// agregador do pipeline. Aqui ficam os caminhos que ainda leem um bloco
// [notas] de texto — Neuro e os logs antigos.
//
// Daqui saiu também o `comparativeScores`, que separava as chaves A1..A15 /
// B1..B15 do avaliador comparativo do Duelo. O Duelo passou a rodar no v34
// (entrada `v34-duelo`), onde as duas notas saem do agregador do pipeline, uma
// por lado, e não há bloco de texto a fatiar.
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

module.exports = { finalScoreFromCriteria };
