import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { copyText } from '../logFiles';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

// Logs Sociais — resultados dos duelos, agrupados por oponente. A lista vem do
// servidor já ordenada por número de partidas (desc) e nome do oponente (asc).
// Aqui dá pra cancelar duelos ainda não aceitos e baixar o log dos concluídos.
// Duelos em andamento ou concluídos não podem ser excluídos; tudo some sozinho
// 30 dias após a criação.
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

function statusChip(d) {
  if (d.status === 'completed') {
    if (d.outcome === 'win') return <span className="duel-outcome-chip win">vitória</span>;
    if (d.outcome === 'loss') return <span className="duel-outcome-chip loss">derrota</span>;
    if (d.outcome === 'draw') return <span className="duel-outcome-chip draw">empate</span>;
    return <span className="duel-outcome-chip pending">concluído</span>;
  }
  if (d.status === 'evaluating') return <span className="duel-outcome-chip ongoing">avaliando…</span>;
  if (d.accepted) return <span className="duel-outcome-chip ongoing">em andamento</span>;
  return <span className="duel-outcome-chip waiting">aguardando aceite</span>;
}

export default function LogsSociais({ user, embedded = false }) {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null); // duelo em ação (cancelar/baixar)
  const [copiedId, setCopiedId] = useState(null); // duelo recém-copiado
  const navigate = useNavigate();

  const load = useCallback(() => {
    return api.getSocialLogs()
      .then((data) => setGroups(data || []))
      .catch((err) => setError(err.message || 'Erro ao carregar os logs sociais.'));
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load, user]);

  async function handleCancel(e, d) {
    e.stopPropagation();
    if (!window.confirm('Cancelar este convite de duelo? Como ele ainda não foi aceito, será excluído.')) return;
    setBusyId(d.id);
    setError('');
    try {
      await api.cancelDuel(d.id);
      await load();
    } catch (err) {
      setError(err.message || 'Não foi possível cancelar o duelo.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDownload(e, d) {
    e.stopPropagation();
    setBusyId(d.id);
    setError('');
    try {
      const { blob, filename } = await api.exportDuelLog(d.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Não foi possível baixar o log.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCopy(e, d) {
    e.stopPropagation();
    setBusyId(d.id);
    setError('');
    try {
      const { blob } = await api.exportDuelLog(d.id);
      await copyText(await blob.text());
      setCopiedId(d.id);
      setTimeout(() => setCopiedId((id) => (id === d.id ? null : id)), 1500);
    } catch (err) {
      setError(err.message || 'Não foi possível copiar o log.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {/* Quando embutido em "Minhas Sessões" (aba Duelos), não repete o
          page-header — a página externa já tem o seu. */}
      {!embedded && (
        <div className="page-header">
          <div className="eyebrow">Duelo · Histórico</div>
          <h2>Logs <span className="accent"><Typewriter text="de Duelo" /></span></h2>
          <p>Seus duelos agrupados por adversário, do mais frequente ao menos. Toque em um duelo para ver o resultado e a análise comparativa.</p>
          <div className="ornament" />
        </div>
      )}

      <div className="social-retention-note">
        Convites ainda não aceitos podem ser cancelados. Duelos em andamento ou concluídos não podem ser excluídos — baixe o log (avaliação cruzada, notas e as duas sessões) enquanto quiser: tudo é apagado automaticamente 30 dias após a criação do duelo.
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
                  <div key={d.id} className="social-duel-row">
                    <button className="social-duel-open" onClick={() => navigate(`/duelo/sessao/${d.id}`)}>
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
                        {statusChip(d)}
                      </div>
                    </button>
                    {(d.canExport || d.canCancel) && (
                      <div className="social-duel-actions">
                        {d.canExport && (
                          <button
                            className="social-duel-action"
                            title="Copiar o log deste duelo"
                            disabled={busyId === d.id}
                            onClick={(e) => handleCopy(e, d)}
                          >
                            {copiedId === d.id
                              ? <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="20 6 9 17 4 12" /></svg>
                              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
                          </button>
                        )}
                        {d.canExport && (
                          <button
                            className="social-duel-action"
                            title="Baixar o log deste duelo"
                            disabled={busyId === d.id}
                            onClick={(e) => handleDownload(e, d)}
                          >
                            {busyId === d.id
                              ? <span className="spinner spinner-sm" />
                              : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>}
                          </button>
                        )}
                        {d.canCancel && (
                          <button
                            className="social-duel-action danger"
                            title="Cancelar convite (ainda não aceito)"
                            disabled={busyId === d.id}
                            onClick={(e) => handleCancel(e, d)}
                          >
                            {busyId === d.id
                              ? <span className="spinner spinner-sm" />
                              : <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
