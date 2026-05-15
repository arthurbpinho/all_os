import { useEffect, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

const SORT_OPTIONS = [
  { id: 'global',   label: 'Nota global' },
  { id: 'sessions', label: 'Mais sessões' },
  { id: 'alpha',    label: 'Ordem alfabética' },
];

function comparator(sort) {
  if (sort === 'sessions') {
    return (a, b) => b.totalSessions - a.totalSessions
      || (b.globalScore ?? -1) - (a.globalScore ?? -1);
  }
  if (sort === 'alpha') {
    return (a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR');
  }
  // padrão: nota global decrescente; nulls pra trás
  return (a, b) => {
    const av = a.globalScore == null ? -Infinity : a.globalScore;
    const bv = b.globalScore == null ? -Infinity : b.globalScore;
    if (bv !== av) return bv - av;
    return b.totalSessions - a.totalSessions;
  };
}

export default function Ranking({ user }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('global');

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    api.getRanking()
      .then((data) => { if (!cancel) setItems(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancel) setError(e.message || 'Erro ao carregar ranking'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  const sorted = [...items].sort(comparator(sort));

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Comunidade</div>
        <h2>
          <Typewriter text="Ranking " />
          <span className="accent"><Typewriter text="Global" delayStart={460} /></span>
        </h2>
        <p>
          A nota global é a média das maiores notas que cada jogador tirou em cada personagem
          jogado da Simulação. Repetir o mesmo personagem não infla — só conta o seu melhor com ele.
        </p>
      </div>

      <div className="card tight" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, marginRight: 4 }}>Ordenar por</span>
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`btn ${sort === opt.id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSort(opt.id)}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="card tight">Carregando ranking…</div>}
      {!!error && <div className="card tight" style={{ color: 'var(--terra)' }}>{error}</div>}
      {!loading && !error && sorted.length === 0 && (
        <div className="card tight">Ninguém jogou ainda — seja o primeiro a aparecer aqui.</div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div className="card tight" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 56, textAlign: 'center' }}>#</th>
                <th>Jogador</th>
                <th style={{ textAlign: 'right' }}>Nota global</th>
                <th style={{ textAlign: 'right' }}>Personagens</th>
                <th style={{ textAlign: 'right' }}>Sessões</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isMe = r.userId === user?.id;
                return (
                  <tr key={r.userId} style={isMe ? { background: 'var(--cream-2)' } : undefined}>
                    <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--muted)' }}>
                      {i + 1}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span
                          className="profile-mini-avatar"
                          style={{ width: 32, height: 32, flexShrink: 0 }}
                        >
                          {r.profilePhoto
                            ? <img src={r.profilePhoto} alt={r.name} />
                            : (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                                <circle cx="12" cy="8" r="4" />
                                <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
                              </svg>
                            )}
                        </span>
                        <span>
                          {r.name}
                          {isMe && (
                            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                              (você)
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {r.globalScore != null ? r.globalScore.toFixed(1) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.charactersPlayed}</td>
                    <td style={{ textAlign: 'right' }}>{r.totalSessions}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
