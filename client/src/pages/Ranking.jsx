import { useEffect, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

const SORT_OPTIONS = [
  { id: 'mmr',      label: 'MMR' },
  { id: 'matches',  label: 'Mais partidas' },
  { id: 'alpha',    label: 'Ordem alfabética' },
];

// Medalhas para o pódio (top 3 por MMR). Ouro, prata e bronze.
const MEDALS = ['🥇', '🥈', '🥉'];
const MEDAL_LABELS = ['Ouro', 'Prata', 'Bronze'];

// Jogadores em calibração (mmr === null) vão sempre para o fim do ranking.
function mmrComparator(a, b) {
  const av = a.mmr == null ? -Infinity : a.mmr;
  const bv = b.mmr == null ? -Infinity : b.mmr;
  if (bv !== av) return bv - av;
  return b.matches - a.matches;
}

function comparator(sort) {
  if (sort === 'matches') {
    return (a, b) => b.matches - a.matches || mmrComparator(a, b);
  }
  if (sort === 'alpha') {
    return (a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR');
  }
  return mmrComparator;
}

export default function Ranking({ user }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState('mmr');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState('');

  const isAdmin = user?.role === 'admin';

  function loadRanking() {
    setLoading(true);
    return api.getRanking()
      .then((data) => setItems(Array.isArray(data) ? data : []))
      .catch((e) => setError(e.message || 'Erro ao carregar ranking'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    api.getRanking()
      .then((data) => { if (!cancel) setItems(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancel) setError(e.message || 'Erro ao carregar ranking'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, []);

  async function handleReset() {
    setResetting(true);
    setError('');
    try {
      const res = await api.adminResetRanking();
      setConfirmingReset(false);
      setNotice(`Notas zeradas — ${res.clearedScores || 0} nota(s) das sessões. Logs e MMR preservados.`);
      await loadRanking();
      setTimeout(() => setNotice(''), 6000);
    } catch (e) {
      setError(e.message || 'Erro ao zerar notas');
    } finally {
      setResetting(false);
    }
  }

  // Pódio: medalha por posição na ordenação canônica (MMR), independente do
  // critério escolhido. Só jogadores fora da calibração entram no pódio.
  const medalByUser = {};
  [...items]
    .filter((r) => r.mmr != null)
    .sort(mmrComparator)
    .slice(0, 3)
    .forEach((r, i) => { medalByUser[r.userId] = i; });

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
          A classificação é pelo <strong>MMR</strong> do modo Competitivo — uma medida de habilidade que
          sobe e desce conforme você joga contra a dificuldade real de cada caso. Nas 3 primeiras partidas
          o MMR fica em calibração e não aparece.
        </p>
      </div>

      {notice && <div className="alert" style={{ background: 'var(--marrs-50, #e6f4f4)', color: 'var(--marrs-dark, #0a6)' }}>{notice}</div>}

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
          {isAdmin && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setConfirmingReset(true)}
              style={{ padding: '6px 14px', fontSize: 13, marginLeft: 'auto', color: 'var(--terra)', borderColor: 'var(--terra)' }}
              title="Zera as notas das sessões (preserva logs e MMR)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6, verticalAlign: '-2px' }}>
                <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" />
              </svg>
              Zerar notas das sessões
            </button>
          )}
        </div>
      </div>

      {loading && <div className="card tight">Carregando ranking…</div>}
      {!!error && <div className="card tight" style={{ color: 'var(--terra)' }}>{error}</div>}
      {!loading && !error && sorted.length === 0 && (
        <div className="card tight">Ninguém jogou competitivo ainda — seja o primeiro a aparecer aqui.</div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div className="card tight" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 56, textAlign: 'center' }}>#</th>
                <th>Jogador</th>
                <th style={{ textAlign: 'right' }}>MMR</th>
                <th style={{ textAlign: 'right' }}>Partidas</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isMe = r.userId === user?.id;
                const medal = medalByUser[r.userId];
                return (
                  <tr key={r.userId} style={isMe ? { background: 'var(--cream-2)' } : undefined}>
                    <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--muted)' }}>
                      {medal != null
                        ? <span title={`Medalha de ${MEDAL_LABELS[medal]}`} style={{ fontSize: 20 }}>{MEDALS[medal]}</span>
                        : i + 1}
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
                          <span>
                            {r.name}
                            {isMe && (
                              <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--muted)' }}>
                                (você)
                              </span>
                            )}
                          </span>
                          {r.title && (
                            <span className={`player-title tier-${r.titleTier || 'bronze'}`}>
                              {r.title}
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {r.calibrating
                        ? <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>
                            Em calibração{r.matchesRemaining > 0 ? ` · faltam ${r.matchesRemaining}` : ''}
                          </span>
                        : r.mmr}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.matches}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !resetting) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 500 }}>
            <h3>Zerar notas das sessões</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              Isso vai <strong>zerar as notas de todas as sessões</strong> (logs) e o progresso da trilha.
              Os <strong>logs e as conversas são preservados</strong>, e o <strong>MMR competitivo não é afetado</strong> —
              o ranking continua intacto. Use quando o modelo do avaliador muda e as notas antigas perdem a validade.
              <br /><br />
              Tem certeza?
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingReset(false)} disabled={resetting}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={handleReset} disabled={resetting} style={{ background: 'var(--terra)', borderColor: 'var(--terra)' }}>
                {resetting ? 'Zerando…' : 'Sim, zerar as notas'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
