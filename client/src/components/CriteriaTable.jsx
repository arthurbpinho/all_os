// Tabela de notas por critério do avaliador v15 (chaves "1".."6").
// DESTINADA SÓ A SUPERVISOR/ADMIN — nunca ao aluno. Quem renderiza é responsável
// por gatear por role: nos Logs o servidor já esconde criteriaScores do aluno;
// na aba Avaliar Sessão (onde o bloco vem cru no texto) o gate é por role no
// cliente. Renderiza qualquer criteriaScores não-vazio, ordenando por chave.
export const V15_CRITERIA = {
  '1': 'Construção linguística',
  '2': 'Relação terapêutica',
  '3': 'Confiança transmitida',
  '4': 'Priorização',
  '5': 'Aprofundamento',
  '6': 'Flexibilidade e Criatividade',
};

export default function CriteriaTable({ criteriaScores }) {
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
                {V15_CRITERIA[k] || `Critério ${k}`}
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
