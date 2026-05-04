// Badge de nota com faixas:
//   < 0          → vermelho
//   0..10        → laranja
//   > 10         → verde claro
export default function ScoreBadge({ score, size = 'md', className = '' }) {
  if (score === null || score === undefined) return null;
  const num = Number(score);
  if (Number.isNaN(num)) return null;
  let variant = 'mid';
  if (num < 0) variant = 'negative';
  else if (num > 10) variant = 'positive';
  const label = num > 0 ? `+${num}` : `${num}`;
  return (
    <span className={`score-pill score-${variant} score-${size} ${className}`}>
      {label}
    </span>
  );
}
