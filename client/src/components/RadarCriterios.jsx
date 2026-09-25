// Gráfico de radar das notas por critério (0–10), em SVG puro: o app não tem
// biblioteca de gráficos e um radar não justifica trazer uma.
//
// `itens` = [{ nome, valor }]. Com menos de 3 critérios um radar vira uma linha,
// então quem chama mostra só a tabela.

const MAX = 10;
const ANEIS = [2, 4, 6, 8, 10];

function quebrarNome(nome, max = 16) {
  const palavras = String(nome).split(/\s+/);
  const linhas = [];
  let atual = '';
  for (const p of palavras) {
    if ((atual + ' ' + p).trim().length > max && atual) { linhas.push(atual); atual = p; }
    else atual = (atual + ' ' + p).trim();
  }
  if (atual) linhas.push(atual);
  return linhas.slice(0, 3);
}

export default function RadarCriterios({ itens, tamanho = 320, rotulo = 'Notas por critério' }) {
  const dados = (itens || []).filter((i) => Number.isFinite(Number(i.valor)));
  if (dados.length < 3) return null;

  // Margem para os nomes em volta do círculo.
  const margem = 78;
  const lado = tamanho + margem * 2;
  const c = lado / 2;
  const r = tamanho / 2;
  const angulo = (i) => -Math.PI / 2 + (2 * Math.PI * i) / dados.length;
  const ponto = (i, v) => {
    const k = Math.max(0, Math.min(MAX, v)) / MAX;
    return [c + Math.cos(angulo(i)) * r * k, c + Math.sin(angulo(i)) * r * k];
  };
  const poligono = (fn) => dados.map((d, i) => fn(d, i).join(',')).join(' ');

  return (
    <svg
      viewBox={`0 0 ${lado} ${lado}`}
      role="img"
      aria-label={`${rotulo}: ${dados.map((d) => `${d.nome} ${d.valor}`).join('; ')}`}
      style={{ width: '100%', maxWidth: lado, height: 'auto', display: 'block', margin: '0 auto' }}
    >
      {ANEIS.map((a) => (
        <polygon
          key={a}
          points={poligono((_, i) => ponto(i, a))}
          fill="none"
          stroke="var(--sand, #e5e1d8)"
          strokeWidth={a === MAX ? 1.5 : 1}
        />
      ))}
      {dados.map((_, i) => {
        const [x, y] = ponto(i, MAX);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="var(--sand, #e5e1d8)" />;
      })}
      <polygon
        points={poligono((d, i) => ponto(i, Number(d.valor)))}
        fill="var(--marrs, #2a8f8f)"
        fillOpacity="0.22"
        stroke="var(--marrs-deep, #1c6b6b)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {dados.map((d, i) => {
        const [x, y] = ponto(i, Number(d.valor));
        return <circle key={i} cx={x} cy={y} r="3.5" fill="var(--marrs-deep, #1c6b6b)" />;
      })}
      {dados.map((d, i) => {
        const a = angulo(i);
        const lx = c + Math.cos(a) * (r + 14);
        const ly = c + Math.sin(a) * (r + 14);
        const cos = Math.cos(a);
        const ancora = Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end';
        const linhas = quebrarNome(d.nome);
        // Nomes em cima sobem, embaixo descem: não encostam no polígono.
        const dy0 = Math.sin(a) < -0.2 ? -(linhas.length - 1) * 13 : Math.sin(a) > 0.2 ? 8 : -((linhas.length - 1) * 13) / 2 + 4;
        return (
          <text key={i} x={lx} y={ly + dy0} textAnchor={ancora} fontSize="12" fill="var(--ink-soft, #555)">
            {linhas.map((l, j) => (
              <tspan key={j} x={lx} dy={j === 0 ? 0 : 13}>{l}</tspan>
            ))}
            <tspan x={lx} dy="13" fontWeight="700" fill="var(--marrs-deep, #1c6b6b)">{d.valor}</tspan>
          </text>
        );
      })}
    </svg>
  );
}
