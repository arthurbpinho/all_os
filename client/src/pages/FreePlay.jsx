import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

export default function FreePlay({ user }) {
  const [characters, setCharacters] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      api.getFreeplay(),
      user?.id ? api.getProgress(user.id) : Promise.resolve({}),
    ])
      .then(([chars, prog]) => {
        setCharacters(chars || []);
        setProgress(prog || {});
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Simulação Livre</div>
        <h2><Typewriter text="Free" /><span className="accent"><Typewriter text="Play" delayStart={180} /></span></h2>
        <p>
          Pacientes simulados sem objetivo de treino estruturado por competência. Praticar escuta, manejo
          relacional e tempo de sessão. Ao finalizar, a IA da Allos avalia automaticamente sua sessão.
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
            const charProgress = progress[char.id];
            const charScore = charProgress?.score;
            return (
              <div
                key={char.id}
                className="character-card"
                onClick={() => navigate(`/chat/freeplay/${char.id}`)}
              >
                <div className="character-card-header">
                  <h3>{char.name}</h3>
                  {charScore !== undefined && charScore !== null && (
                    <ScoreBadge score={charScore} />
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
