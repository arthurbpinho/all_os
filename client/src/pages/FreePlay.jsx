import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatar } from '../components/PatientAvatar';

// Progressão (nome antigo: Treinamento) — prática livre, sem ranking, onde o
// valor é REATENDER: da segunda vez em diante a avaliação compara a sessão nova
// com a anterior. Vive dentro da Trilha (competência "Treinamento"), junto de
// Duelo; a Simulação é que ficou como porta grande da tela de Início.
//
// O componente segue chamado FreePlay e o tipo interno segue 'freeplay' (log.type,
// context.type, chaves de autosave, /chat/freeplay/:id): o que virou "Progressão"
// é o NOME VISÍVEL. A rota antiga /freeplay redireciona pra /progressao.
export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [bestScores, setBestScores] = useState({});
  const [attended, setAttended] = useState(() => new Set());
  const [sidequest, setSidequest] = useState(null);
  const [dailyMission, setDailyMission] = useState(null); // { mission, completed }
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
      isVisitor ? Promise.resolve({ mission: null }) : api.getMyDailyMission().catch(() => ({ mission: null })),
    ])
      .then(([chars, logs, sq, daily]) => {
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
        setDailyMission(daily && daily.mission ? daily : null);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Treinamento · Progressão</div>
        <h2><Typewriter text="Progre" /><span className="accent"><Typewriter text="ssão" delayStart={180} /></span></h2>
        <p>
          Atenda pacientes simulados para praticar escuta, manejo relacional e tempo de sessão, sem
          valer ranking. Ao <strong>reatender</strong> um paciente que você já viu, a avaliação compara
          sua evolução com o atendimento anterior — é o que dá nome ao modo. Ao finalizar, o log é
          salvo no seu histórico e enviado ao seu supervisor vinculado.
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
              : 'Desafio do dia (rotaciona diariamente). Cumpra durante um atendimento de Progressão para ganhar a recompensa.'}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
