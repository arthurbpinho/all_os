import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Ordem e rótulos das faixas de dificuldade. Sidequests (tier 'quest') entram
// num grupo próprio no fim.
const TIER_GROUPS = [
  { tier: 'gold',   label: 'Ouro',  hint: 'Conquistas de ouro podem virar título de perfil.' },
  { tier: 'silver', label: 'Prata', hint: '' },
  { tier: 'bronze', label: 'Bronze', hint: '' },
  { tier: 'quest',  label: 'Recompensas de missão', hint: '' },
];

export default function Missoes({ user }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claimingId, setClaimingId] = useState(null);
  const [claimError, setClaimError] = useState('');

  const load = useCallback(() => {
    return api.getGamification(user.id)
      .then(setData)
      .catch((err) => setError(err.message || 'Erro ao carregar indicadores'));
  }, [user.id]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleClaim(id) {
    setClaimError('');
    setClaimingId(id);
    try {
      await api.claimAchievement(id);
      await load();
    } catch (err) {
      setClaimError(err.message || 'Não foi possível resgatar a conquista.');
    } finally {
      setClaimingId(null);
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando seus indicadores…</span>
      </div>
    );
  }

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return null;

  const { streak, dailyMissions, achievements, stats } = data;
  const claimedCount = achievements.filter((a) => a.claimed).length;
  const claimableCount = achievements.filter((a) => a.claimable).length;

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Seu desenvolvimento</div>
        <h2>
          <Typewriter text="Objetivos e " />
          <span className="accent"><Typewriter text="metas" delayStart={300} /></span>
        </h2>
        <p>Mantenha a constância, conclua os objetivos diários e resgate marcos do seu aprimoramento técnico.</p>
        <div className="ornament" />
      </div>

      <div className={`streak-hero status-${streak.status} ${streak.isAlive ? '' : 'dead'}`}>
        <div className="streak-flame-wrap">
          <span className="streak-flame-icon" role="img" aria-label="constância">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 12h3l3-8 4 16 3-8h5" />
            </svg>
          </span>
        </div>
        <div className="streak-info">
          <div className="streak-eyebrow">
            {streak.isAlive ? 'Constância ativa' : 'Constância pausada'}
          </div>
          <div className="streak-count">
            <strong>{streak.current}</strong>
            <span> {streak.current === 1 ? 'semana' : 'semanas'}</span>
            {streak.status === 'monthly' && <span className="streak-tier-pill monthly">Mensal</span>}
            {streak.status === 'weekly' && <span className="streak-tier-pill weekly">Semanal</span>}
          </div>
          <div className="streak-meta">
            {streak.isAlive ? (
              streak.status === 'monthly' ? (
                <span>Constância mensal mantida — marco registrado no perfil.</span>
              ) : streak.status === 'weekly' ? (
                <span>Constância semanal ativa. Faltam <strong>{streak.weeksToMonthly}</strong> {streak.weeksToMonthly === 1 ? 'semana' : 'semanas'} para a marca mensal.</span>
              ) : (
                <span>Conclua um atendimento esta semana para começar uma sequência de constância.</span>
              )
            ) : (
              <span>Conclua um atendimento esta semana para retomar sua constância.</span>
            )}
          </div>
          <div className="streak-record">Sequência máxima registrada: <strong>{streak.longest}</strong> {streak.longest === 1 ? 'semana' : 'semanas'}</div>
        </div>
      </div>

      <h3 className="section-heading">Objetivos de hoje</h3>
      <div className="mission-grid">
        {dailyMissions.map((m) => (
          <div key={m.id} className={`mission-card ${m.completed ? 'completed' : ''}`}>
            <div className="mission-icon" aria-hidden>{m.icon}</div>
            <div className="mission-body">
              <h4>{m.title}</h4>
              <p>{m.description}</p>
              <div className="mission-progress">
                <div className="mission-progress-bar">
                  <div
                    className="mission-progress-fill"
                    style={{ width: `${Math.min(100, (m.progress / m.target) * 100)}%` }}
                  />
                </div>
                <span className="mission-progress-text">
                  {m.progress}/{m.target}
                </span>
              </div>
            </div>
            {m.completed && <div className="mission-check" aria-label="concluída">✓</div>}
          </div>
        ))}
      </div>

      <h3 className="section-heading">Indicadores de prática</h3>
      <div className="stats-grid">
        <div className="stat-card"><span>Sessões</span><strong>{stats.totalSessions}</strong></div>
        <div className="stat-card"><span>Trilha</span><strong>{stats.totalExercise}</strong></div>
        <div className="stat-card"><span>Simulação</span><strong>{stats.totalFreeplay}</strong></div>
        <div className="stat-card"><span>Neuro</span><strong>{stats.totalNeuro}</strong></div>
        {stats.averageScore !== null && (
          <div className="stat-card"><span>Pontuação média</span><strong>{stats.averageScore > 0 ? '+' : ''}{stats.averageScore}</strong></div>
        )}
        {stats.bestScore !== null && (
          <div className="stat-card"><span>Melhor pontuação</span><strong>{stats.bestScore > 0 ? '+' : ''}{stats.bestScore}</strong></div>
        )}
      </div>

      <h3 className="section-heading">Metas</h3>
      <p className="section-sub">
        {claimedCount} de {achievements.length} resgatadas
        {claimableCount > 0 && <span className="metas-claimable-pill"> · {claimableCount} para resgatar</span>}
      </p>
      {claimError && <div className="alert error" style={{ marginBottom: 14 }}>{claimError}</div>}

      {TIER_GROUPS.map(({ tier, label, hint }) => {
        const items = achievements.filter((a) => a.tier === tier);
        if (items.length === 0) return null;
        return (
          <div key={tier} className="achievement-tier-group">
            <div className="achievement-tier-header">
              <span className={`achievement-tier-badge tier-${tier}`}>{label}</span>
              {hint && <span className="achievement-tier-hint">{hint}</span>}
            </div>
            <div className="achievement-grid">
              {items.map((a) => {
                const state = a.claimed ? 'earned' : a.claimable ? 'claimable' : 'locked';
                const hasBar = Number.isFinite(a.target);
                const pct = hasBar ? Math.min(100, (a.progress / a.target) * 100) : 0;
                return (
                  <div
                    key={a.id}
                    className={`achievement-card tier-${a.tier} ${state}`}
                    title={a.claimed && a.earnedAt ? `Resgatada em ${new Date(a.earnedAt).toLocaleDateString('pt-BR')}` : a.description}
                  >
                    <div className="achievement-icon" aria-hidden>{a.icon}</div>
                    <div className="achievement-title">{a.title}</div>
                    <div className="achievement-description">{a.description}</div>

                    {hasBar && !a.claimed && (
                      <div className="achievement-progress">
                        <div className="achievement-progress-bar">
                          <div className="achievement-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="achievement-progress-text">{a.progress}/{a.target}</span>
                      </div>
                    )}

                    {a.claimable && (
                      <button
                        className="btn btn-primary btn-sm achievement-claim-btn"
                        onClick={() => handleClaim(a.id)}
                        disabled={claimingId === a.id}
                      >
                        {claimingId === a.id ? 'Resgatando…' : 'Resgatar'}
                      </button>
                    )}
                    {a.claimed && a.earnedAt && (
                      <div className="achievement-date">
                        ✓ {new Date(a.earnedAt).toLocaleDateString('pt-BR')}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
