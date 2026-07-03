import { useState } from 'react';

// Comparação da bateria: seleção do aluno vs. bateria recomendada (gabarito),
// acurácia (Jaccard), faltantes/extras, as justificativas do aluno e, sob
// demanda, os resultados do paciente. Recebe `result` (payload de comparação).
//
// Modos:
//   - modal (default): overlay + botão Fechar (precisa de `onClose`).
//   - embedded: renderiza inline, sem overlay nem Fechar (tela de resultado).
export default function NeuroTestComparison({ result, onClose, justifications, embedded = false }) {
  const [revealed, setRevealed] = useState(false);
  if (!result) return null;

  const { accuracy = null, counts = {}, selected = [], recommended = [], matched = [], missing = [], extra = [], results = [] } = result;
  const just = justifications || result.justifications || {};
  const matchedIds = new Set(matched.map((t) => t.id));
  const recIds = new Set(recommended.map((t) => t.id));
  const hasAccuracy = typeof accuracy === 'number';
  const accClass = !hasAccuracy ? 'na' : accuracy >= 75 ? 'good' : accuracy >= 50 ? 'mid' : 'low';

  const body = (
    <>
      <h3>Comparação da bateria de testes</h3>
      <p className="neuro-comparison-sub">
        Sua seleção foi comparada com a bateria recomendada para este caso. A acurácia penaliza
        tanto testes que faltaram quanto testes desnecessários.
      </p>

      <div className="neuro-comparison-top">
        <div className={`neuro-accuracy-ring ${accClass}`} style={{ '--acc': hasAccuracy ? accuracy : 0 }}>
          <div className="neuro-accuracy-inner">
            <span className="neuro-accuracy-value">{hasAccuracy ? `${accuracy}%` : 'N/A'}</span>
            <span className="neuro-accuracy-label">nota dos testes</span>
          </div>
        </div>
        <div className="neuro-comparison-counts">
          <div className="ncc-item ok"><span className="ncc-num">{counts.matched ?? matched.length}</span><span className="ncc-lbl">acertos</span></div>
          <div className="ncc-item miss"><span className="ncc-num">{counts.missing ?? missing.length}</span><span className="ncc-lbl">faltaram</span></div>
          <div className="ncc-item extra"><span className="ncc-num">{counts.extra ?? extra.length}</span><span className="ncc-lbl">extras</span></div>
        </div>
      </div>

      <div className="neuro-comparison-cols">
        <div className="neuro-comparison-col">
          <div className="neuro-col-title">Você indicou ({selected.length})</div>
          {selected.length === 0 ? (
            <div className="neuro-col-empty">Nenhum teste indicado.</div>
          ) : (
            <ul className="neuro-chip-list">
              {selected.map((t) => {
                const ok = recIds.has(t.id);
                return (
                  <li key={t.id} className={`neuro-chip ${ok ? 'ok' : 'extra'}`} title={t.name}>
                    <span className="neuro-chip-mark">{ok ? '✓' : '+'}</span>
                    <span className="neuro-chip-abbr">{t.abbr}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="neuro-comparison-col">
          <div className="neuro-col-title">Recomendado para o caso ({recommended.length})</div>
          {recommended.length === 0 ? (
            <div className="neuro-col-empty">Este paciente não tem bateria recomendada cadastrada.</div>
          ) : (
            <ul className="neuro-chip-list">
              {recommended.map((t) => {
                const ok = matchedIds.has(t.id);
                return (
                  <li key={t.id} className={`neuro-chip ${ok ? 'ok' : 'miss'}`} title={t.name}>
                    <span className="neuro-chip-mark">{ok ? '✓' : '!'}</span>
                    <span className="neuro-chip-abbr">{t.abbr}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {missing.length > 0 && (
        <div className="neuro-comparison-note miss">
          <strong>Testes que você deixou de aplicar:</strong>{' '}
          {missing.map((t) => `${t.abbr} (${t.name})`).join(' · ')}
        </div>
      )}
      {extra.length > 0 && (
        <div className="neuro-comparison-note extra">
          <strong>Testes extras / não recomendados:</strong>{' '}
          {extra.map((t) => `${t.abbr} (${t.name})`).join(' · ')}
        </div>
      )}

      {selected.length > 0 && (
        <div className="neuro-justif-review">
          <div className="neuro-col-title">Suas justificativas</div>
          <ul className="neuro-justif-list">
            {selected.map((t) => (
              <li key={t.id}>
                <span className="neuro-chip-abbr">{t.abbr}</span>
                <span className="neuro-justif-text">{((just && just[t.id]) || '').trim() || '(não justificou)'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="neuro-results-section">
        {!revealed ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setRevealed(true)}
            disabled={results.length === 0}
            title={results.length === 0 ? 'Este paciente não tem resultados cadastrados.' : 'Revelar os resultados do paciente'}
          >
            Ver resultados do paciente
          </button>
        ) : (
          <div className="neuro-results">
            <div className="neuro-results-title">Resultados do paciente (bateria recomendada)</div>
            {results.length === 0 ? (
              <div className="neuro-col-empty">Nenhum resultado cadastrado para este paciente.</div>
            ) : (
              <ul className="neuro-results-list">
                {results.map((r) => (
                  <li key={r.id} className={`neuro-result-row ${matchedIds.has(r.id) ? '' : 'was-missing'}`}>
                    <div className="neuro-result-head">
                      <span className="neuro-result-abbr">{r.abbr}</span>
                      <span className="neuro-result-name">{r.name}</span>
                      {!matchedIds.has(r.id) && <span className="neuro-result-tag">você não aplicou</span>}
                    </div>
                    <div className="neuro-result-value">{r.result}</div>
                  </li>
                ))}
              </ul>
            )}
            <p className="neuro-results-hint">
              Use esses resultados para montar sua devolutiva estruturada com o paciente.
            </p>
          </div>
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div className="neuro-comparison-embedded">{body}</div>;
  }

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}>
      <div className="modal neuro-comparison-modal">
        {body}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
