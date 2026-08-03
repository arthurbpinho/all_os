import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatar } from '../components/PatientAvatar';

export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [bestScores, setBestScores] = useState({});
  const [attended, setAttended] = useState(() => new Set());
  const [sidequest, setSidequest] = useState(null);
  const [dailyMission, setDailyMission] = useState(null); // { mission, completed }
  // titulares: mapa { characterId: titularSummary } do modo Desafio. Cada card
  // mostra a foto+nome no canto inferior direito (clique → /chat/desafio/<id>),
  // ou o 👑 quando não há Titular.
  const [titulares, setTitulares] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const isVisitor = user?.role === 'visitor';

  useEffect(() => {
    // Logs do próprio usuário pra calcular a melhor nota por personagem e saber
    // quais pacientes já foram atendidos (reatender = progressão). EchoSession
    // (freeplay) só grava em logs.json — então o log é a fonte de verdade.
    Promise.all([
      api.getFreeplay(),
      user?.id ? api.getLogs(user.id) : Promise.resolve([]),
      isVisitor ? Promise.resolve({ active: null }) : api.getMySidequest().catch(() => ({ active: null })),
      api.getTitulares().catch(() => ({})),
      isVisitor ? Promise.resolve({ mission: null }) : api.getMyDailyMission().catch(() => ({ mission: null })),
    ])
      .then(([chars, logs, sq, tit, daily]) => {
        setCharacters(chars || []);
        const max = {};
        const seen = new Set();
        for (const l of logs || []) {
          if (l.type !== 'freeplay') continue;
          if (!l.itemId) continue;
          seen.add(String(l.itemId));
          if (!Number.isFinite(l.score)) continue;
          if (max[l.itemId] === undefined || l.score > max[l.itemId]) {
            max[l.itemId] = l.score;
          }
        }
        setBestScores(max);
        setAttended(seen);
        setSidequest(sq && sq.active ? sq.active : null);
        setTitulares(tit || {});
        setDailyMission(daily && daily.mission ? daily : null);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  // Wrapper que para a propagação: o card inteiro tem onClick (atende normal),
  // então o footer de coroa precisa stopPropagation antes de navegar pra rota
  // de Desafio. Senão, clicar na foto do Titular dispararia AMBOS os navegues.
  function openDesafio(e, characterId) {
    e.stopPropagation();
    navigate(`/chat/desafio/${characterId}`);
  }

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Treinamento</div>
        <h2><Typewriter text="Treina" /><span className="accent"><Typewriter text="mento" delayStart={180} /></span></h2>
        <p>
          Atenda pacientes simulados para praticar escuta, manejo relacional e tempo de sessão. Ao reatender
          um paciente que você já viu, a avaliação compara sua <strong>evolução</strong> com o atendimento
          anterior. Ao finalizar, o log é salvo no seu histórico e enviado ao seu supervisor vinculado.
        </p>
        <div className="ornament" />
      </div>

      {sidequest && (
        <div className="sidequest-banner">
          <div className="sidequest-banner-label">✦ Sidequest ativa · objetivo principal</div>
          <div className="sidequest-banner-title">{sidequest.title}</div>
          <div className="sidequest-banner-desc">{sidequest.description}</div>
          <div className="sidequest-banner-hint">
            Esta missão é o foco do seu próximo treino — escolha um paciente e persiga o objetivo acima.
            {' '}Enquanto ela estiver ativa, a missão diária fica pausada: é uma missão por vez.
          </div>
        </div>
      )}

      {dailyMission && (
        <div className={`sidequest-banner daily-mission-banner ${dailyMission.completed ? 'completed' : ''}`}>
          <div className="sidequest-banner-label">
            ◷ Missão diária{dailyMission.completed ? ' · concluída hoje ✓' : ' · desafio do dia'}
          </div>
          <div className="sidequest-banner-title">{dailyMission.mission.title}</div>
          <div className="sidequest-banner-desc">{dailyMission.mission.description}</div>
          <div className="sidequest-banner-hint">
            {dailyMission.completed
              ? 'Você já cumpriu o desafio de hoje. Amanhã entra uma nova missão.'
              : 'Desafio do dia (rotaciona diariamente). Cumpra durante um atendimento de Treinamento para ganhar a recompensa.'}
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando personagens…</span>
        </div>
      ) : characters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Nenhum personagem cadastrado ainda.
        </div>
      ) : (
        <div className="card-grid">
          {characters.map((char) => {
            const charBest = bestScores[char.id];
            const isReturn = attended.has(String(char.id));
            const titular = titulares[char.id];
            return (
              <div
                key={char.id}
                className="character-card"
                onClick={() => navigate(`/chat/freeplay/${char.id}`)}
              >
                <div className="character-card-top">
                  <PatientAvatar name={char.name} iconUrl={char.photoIcon} size={72} className="character-card-photo" />
                  <div className="character-card-meta">
                    <div className="character-card-header">
                      <h3>{char.name}</h3>
                      {Number.isFinite(charBest) && (
                        <span title="Sua maior nota com este paciente">
                          <ScoreBadge score={charBest} />
                        </span>
                      )}
                    </div>
                    <div className="age">{char.age} anos</div>
                  </div>
                </div>
                <p>{char.description}</p>
                {isReturn && (
                  <div className="progression-tag" title="Você já atendeu este paciente — reatender avalia sua evolução">
                    ↗ Progressão · reatendimento
                  </div>
                )}
                {/* Footer de coroa (modo Desafio). Se há Titular: foto+nome
                    clicáveis abrem a sessão de Desafio. Se não há: botão 👑
                    pequeno permite reivindicar a posição. Clique aqui NÃO
                    abre o atendimento normal (stopPropagation). */}
                {titular ? (
                  <button
                    type="button"
                    className="titular-footer"
                    onClick={(e) => openDesafio(e, char.id)}
                    title={titular.isVisitor
                      ? `${titular.name} é Titular — clique para desafiar`
                      : `${titular.name} é Titular deste caso — clique para desafiar`}
                  >
                    <span className="crown-emoji" aria-hidden>👑</span>
                    <span className="titular-avatar">
                      {titular.profilePhoto
                        ? <img src={titular.profilePhoto} alt={titular.name} />
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>}
                    </span>
                    <span className="titular-name">{titular.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="titular-claim-btn"
                    onClick={(e) => openDesafio(e, char.id)}
                    title="Ninguém é Titular ainda — clique para garantir seu título"
                    aria-label="Reivindicar título"
                  >
                    <span aria-hidden>👑</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* CTA flutuante no canto inferior direito da página de Treinamento.
          Lembra ao aluno que clicar no rosto do Titular abre o modo Desafio. */}
      <div className="desafio-cta" role="note">
        Desafie seus amigos no modo <span aria-hidden>👑</span> clicando no ícone para ser titular de um paciente
      </div>
    </div>
  );
}
