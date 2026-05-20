import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [bestScores, setBestScores] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    // Logs do próprio usuário pra calcular a melhor nota por personagem.
    // EchoSession (freeplay) não grava em progress.json — só em logs.json —
    // então a fonte de verdade pra "melhor nota com esse paciente" é o log.
    Promise.all([
      api.getFreeplay(),
      user?.id ? api.getLogs(user.id) : Promise.resolve([]),
    ])
      .then(([chars, logs]) => {
        setCharacters(chars || []);
        const max = {};
        for (const l of logs || []) {
          if (l.type !== 'freeplay') continue;
          if (!Number.isFinite(l.score)) continue;
          if (!l.itemId) continue;
          if (max[l.itemId] === undefined || l.score > max[l.itemId]) {
            max[l.itemId] = l.score;
          }
        }
        setBestScores(max);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Simulação Livre</div>
        <h2><Typewriter text="Simu" /><span className="accent"><Typewriter text="lação" delayStart={180} /></span></h2>
        <p>
          Pacientes simulados sem objetivo de treino estruturado por competência. Praticar escuta, manejo
          relacional e tempo de sessão — sem nota nem avaliação ao final. Ao finalizar, o log é salvo no seu
          histórico e enviado ao seu professor vinculado.
        </p>
        <div className="ornament" />
      </div>

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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
