import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [bestScores, setBestScores] = useState({});
  const [attended, setAttended] = useState(() => new Set());
  const [sidequest, setSidequest] = useState(null);
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
    ])
      .then(([chars, logs, sq]) => {
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
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

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
                <div className="character-card-header">
                  <h3>{char.name}</h3>
                  {Number.isFinite(charBest) && (
                    <span title="Sua maior nota com este paciente">
                      <ScoreBadge score={charBest} />
                    </span>
                  )}
                </div>
                <div className="age">{char.age} anos</div>
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
