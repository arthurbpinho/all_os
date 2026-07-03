import { useMemo, useState } from 'react';

// Lista searchable + agrupada por categoria de testes neuropsicológicos, com
// checkboxes. Corpo reutilizável: o admin embute inline (com input de resultado
// por teste via renderResult); o aluno usa dentro do modal "Escolher Testes".
//
// Props:
//   catalog     : [{ category, tests: [{ id, abbr, name }] }]
//   selected    : array de ids selecionados
//   onChange    : (nextIds) => void
//   renderResult: (test) => ReactNode  (opcional — slot sob cada teste marcado)
//   disabled    : bool
export default function NeuroTestSelector({ catalog, selected, onChange, renderResult, disabled }) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selected || []), [selected]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog || [];
    return (catalog || [])
      .map((g) => ({
        ...g,
        tests: g.tests.filter((t) =>
          `${t.abbr} ${t.name} ${g.category}`.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.tests.length > 0);
  }, [catalog, query]);

  function toggle(id) {
    if (disabled) return;
    const set = new Set(selected || []);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange(Array.from(set));
  }

  const totalSelected = (selected || []).length;

  return (
    <div className="neuro-test-selector">
      <div className="neuro-test-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar teste (ex: WAIS, atenção, memória)…"
          disabled={disabled}
        />
        {query && (
          <button type="button" className="neuro-test-search-clear" onClick={() => setQuery('')} title="Limpar busca">×</button>
        )}
      </div>

      <div className="neuro-test-count">
        {totalSelected === 0 ? 'Nenhum teste selecionado' : `${totalSelected} ${totalSelected === 1 ? 'teste selecionado' : 'testes selecionados'}`}
      </div>

      <div className="neuro-test-groups">
        {groups.length === 0 ? (
          <div className="neuro-test-empty">Nenhum teste encontrado para “{query}”.</div>
        ) : (
          groups.map((g) => (
            <div key={g.category} className="neuro-test-group">
              <div className="neuro-test-group-title">{g.category}</div>
              <div className="neuro-test-list">
                {g.tests.map((t) => {
                  const checked = selectedSet.has(t.id);
                  return (
                    <div key={t.id} className={`neuro-test-item ${checked ? 'checked' : ''}`}>
                      <label className="neuro-test-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(t.id)}
                          disabled={disabled}
                        />
                        <span className="neuro-test-abbr">{t.abbr}</span>
                        <span className="neuro-test-name">{t.name}</span>
                      </label>
                      {checked && renderResult && (
                        <div className="neuro-test-result-slot">{renderResult(t)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
