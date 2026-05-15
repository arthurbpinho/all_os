// Badge de nota — escala 0-100 (avaliador v9), com 5 faixas correspondentes
// às faixas do system prompt:
//   ≤ 22       → Erro              (vermelho)
//   23..37     → Burocrático       (terra avermelhada)
//   38..57     → Boa condução      (âmbar)
//   58..80     → Atingiu gabarito  (verde claro)
//   ≥ 81       → Excelência        (verde forte)
//
// Notas legadas fora de 0-100 (sistema antigo de 10 critérios ponderados)
// são clampadas para o intervalo antes de aplicar a faixa — a coloração fica
// aproximada, mas o badge não quebra.
export default function ScoreBadge({ score, size = 'md', className = '' }) {
  if (score === null || score === undefined) return null;
  const raw = Number(score);
  if (Number.isNaN(raw)) return null;

  const clamped = Math.max(0, Math.min(100, Math.round(raw)));

  let variant;
  if (clamped <= 22) variant = 'f1';
  else if (clamped <= 37) variant = 'f2';
  else if (clamped <= 57) variant = 'f3';
  else if (clamped <= 80) variant = 'f4';
  else variant = 'f5';

  return (
    <span className={`score-pill score-${variant} score-${size} ${className}`}>
      {clamped}
    </span>
  );
}
