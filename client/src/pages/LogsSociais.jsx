import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

// Logs Sociais — resultados dos duelos, agrupados por oponente. A lista vem do
// servidor já ordenada por número de partidas (desc) e nome do oponente (asc).
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function avatar(photo, name) {
  return photo
    ? <img src={photo} alt={name} className="duel-avatar-img" />
    : (
      <span className="duel-avatar-fallback">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
      </span>
    );
}

function outcomeChip(d) {
  if (d.status !== 'completed' || !d.outcome) {
    return <span className="duel-outcome-chip pending">pendente</span>;
  }
  if (d.outcome === 'win') return <span className="duel-outcome-chip win">vitória</span>;
  if (d.outcome === 'loss') return <span className="duel-outcome-chip loss">derrota</span>;
  return <span className="duel-outcome-chip draw">empate</span>;
}

export default function LogsSociais({ user }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.getSocialLogs()
      .then((data) => setGroups(data || []))
      .catch((err) => setError(err.message || 'Erro ao carregar os logs sociais.'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Duelo · Histórico</div>
        <h2>Logs <span className="accent"><Typewriter text="Sociais" /></span></h2>
        <p>Seus duelos agrupados por adversário, do mais frequente ao menos. Toque em um duelo para ver o resultado e a análise comparativa.</p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span>
        </div>
      ) : groups.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Você ainda não duelou com ninguém. Vá em <strong>Duelo</strong> para desafiar alguém.
        </div>
      ) : (
        <div className="social-groups">
          {groups.map((g, gi) => (
            <div key={g.opponent.userId || `${g.opponent.name}-${gi}`} className="card social-group">
              <div className="social-group-header">
                <span className="duel-avatar">{avatar(g.opponent.profilePhoto, g.opponent.name)}</span>
                <div className="social-group-id">
                  <div className="social-group-name">{g.opponent.name}{g.opponent.isVisitor && <span className="duel-visitor-tag"> · visitante</span>}</div>
                  <div className="social-group-record">
                    {g.count} {g.count === 1 ? 'duelo' : 'duelos'}
                    {' · '}
                    <span className="rec-w">{g.wins}V</span> <span className="rec-l">{g.losses}D</span> <span className="rec-d">{g.draws}E</span>
                  </div>
                </div>
              </div>
              <div className="social-duel-list">
                {g.duels.map((d) => (
                  <button key={d.id} className="social-duel-row" onClick={() => navigate(`/duelo/sessao/${d.id}`)}>
                    <div className="social-duel-main">
                      <span className="social-duel-char">{d.characterName}</span>
                      <span className="social-duel-date">{formatDate(d.date)}</span>
                    </div>
                    <div className="social-duel-right">
                      {d.status === 'completed' && Number.isFinite(d.yourScore) && Number.isFinite(d.theirScore) && (
                        <span className="social-duel-scores">
                          <ScoreBadge score={d.yourScore} /> <span className="vs">×</span> <ScoreBadge score={d.theirScore} />
                        </span>
                      )}
                      {outcomeChip(d)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
