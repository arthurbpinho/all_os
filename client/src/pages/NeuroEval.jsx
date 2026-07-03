import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatar } from '../components/PatientAvatar';

export default function NeuroEval({ user }) {
  const [characters, setCharacters] = useState([]);
  const [progress, setProgress] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      api.getNeuro(),
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
        <div className="eyebrow">Sistema 3 · Diagnóstico</div>
        <h2><Typewriter text="Neuro" /><span className="accent"><Typewriter text="avaliação" delayStart={260} /></span></h2>
        <p>
          Pacientes com diagnósticos específicos ocultos. O exercício é identificar o quadro durante a
          escuta. Ao finalizar, o log é enviado ao seu professor vinculado para correção.
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
                className="character-card diagnosis-card"
                onClick={() => navigate(`/chat/neuro/${char.id}`)}
              >
                <div className="character-card-top">
                  <PatientAvatar name={char.name} iconUrl={char.photoIcon} size={72} className="character-card-photo" />
                  <div className="character-card-meta">
                    <div className="character-card-header">
                      <h3>{char.name}</h3>
                      {charScore !== undefined && charScore !== null && (
                        <ScoreBadge score={charScore} />
                      )}
                    </div>
                    <div className="age">{char.age} anos</div>
                  </div>
                </div>
                <p>{char.description}</p>
                <span className="tag">Diagnóstico oculto</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
