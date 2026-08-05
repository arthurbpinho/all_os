// Tabela de notas por critério do avaliador.
// DESTINADA SÓ A SUPERVISOR/ADMIN — nunca ao aluno. Quem renderiza é responsável
// por gatear por role: nos Logs o servidor já esconde criteriaScores do aluno.
// Renderiza qualquer criteriaScores não-vazio, ordenando por chave.

// Avaliador v18.25 (atual): 15 critérios em 6 grupos. Os critérios 10 e 13 podem
// sair NA quando o caso não dá material — aí a linha simplesmente não aparece.
export const V18_CRITERIA = {
  '1': 'Precisão lexical',
  '2': 'Construção e economia',
  '3': 'Modulação da intensidade clínica',
  '4': 'Adequação à prontidão para mudança',
  '5': 'Manejo do vínculo',
  '6': 'Antifragilidade',
  '7': 'Coerência interna',
  '8': 'Coerência narrativa',
  '9': 'Ganchos verbais',
  '10': 'Ganchos não-verbais',
  '11': 'Profundidade vertical',
  '12': 'Articulação lateral',
  '13': 'Formulação',
  '14': 'Flexibilidade',
  '15': 'Criatividade',
};

// Avaliador v15/v16 (logs antigos, 6 critérios). Mantido porque o histórico não
// é reprocessado: log salvo com a grade antiga continua sendo lido com ela.
export const V15_CRITERIA = {
  '1': 'Construção linguística',
  '2': 'Relação terapêutica',
  '3': 'Confiança transmitida',
  '4': 'Priorização',
  '5': 'Aprofundamento',
  '6': 'Flexibilidade e Criatividade',
};

// Critérios do avaliador de Neuroavaliação (chaves "1".."4").
export const NEURO_CRITERIA = {
  '1': 'Acolhimento e vínculo',
  '2': 'Entrevista e investigação',
  '3': 'Raciocínio diagnóstico',
  '4': 'Indicação de testes',
};

// Escolhe a grade certa para um criteriaScores: neuro tem a própria (4
// critérios); fora dela, o número mais alto de critério distingue a grade de 15
// (v18.25) da de 6 (logs antigos), sem precisar de campo novo no log.
export function labelsForCriteria(criteriaScores, logType) {
  if (logType === 'neuro') return NEURO_CRITERIA;
  const keys = Object.keys(criteriaScores || {}).map((k) => Number(k)).filter(Number.isFinite);
  const max = keys.length ? Math.max(...keys) : 0;
  return max > 6 ? V18_CRITERIA : V15_CRITERIA;
}

export default function CriteriaTable({ criteriaScores, labels = V18_CRITERIA }) {
  if (!criteriaScores || typeof criteriaScores !== 'object') return null;
  const entries = Object.entries(criteriaScores)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  if (entries.length === 0) return null;
  return (
    <div className="criteria-table" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>
        Notas por critério <span style={{ textTransform: 'none', letterSpacing: 0 }}>(visível só ao supervisor/admin)</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} style={{ borderBottom: '1px solid var(--sand, #eee)' }}>
              <td style={{ padding: '5px 8px', color: 'var(--ink-soft)' }}>
                {labels[k] || `Critério ${k}`}
              </td>
              <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 600, color: 'var(--marrs-deep)', whiteSpace: 'nowrap' }}>
                {Number(v)}<span style={{ color: 'var(--muted)', fontWeight: 400 }}>/10</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
