import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Modo Competitivo: mesmos personagens da Simulação, mas cada partida finalizada
// alimenta o MMR (rating competitivo). A dificuldade de cada personagem é aberta
// e exibida no card. O MMR fica oculto até a 4ª partida (calibração de 3 partidas).
export default function Competitive({ user }) {
  const [characters, setCharacters] = useState([]);
  const [mmr, setMmr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getFreeplay(), api.getMyMmr().catch(() => null)])
      .then(([chars, myMmr]) => {
        setCharacters(chars || []);
        setMmr(myMmr);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Modo Competitivo</div>
        <h2><Typewriter text="Compe" /><span className="accent"><Typewriter text="titivo" delayStart={180} /></span></h2>
        <p>
          Os mesmos pacientes da Simulação, agora valendo ranking. Cada atendimento finalizado
          atualiza o seu <strong>MMR</strong> — e a <strong>dificuldade</strong> de cada personagem se ajusta ao
          desempenho coletivo. As 3 primeiras partidas são de calibração.
        </p>
        <div className="ornament" />
      </div>

      {mmr && (
        <div className="card tight" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>Seu MMR</span>
          {mmr.calibrating ? (
            <span style={{ fontWeight: 600, color: 'var(--ink-soft)' }}>
              Em calibração — {mmr.matchesRemaining} {mmr.matchesRemaining === 1 ? 'partida restante' : 'partidas restantes'}
            </span>
          ) : (
            <span style={{ fontWeight: 700, fontSize: 22, color: 'var(--marrs-deep)' }}>{mmr.mmr}</span>
          )}
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 13 }}>
            {mmr.n} {mmr.n === 1 ? 'partida competitiva' : 'partidas competitivas'}
          </span>
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
          {characters.map((char) => (
            <div
              key={char.id}
              className="character-card"
              onClick={() => navigate(`/chat/freeplay/${char.id}?mode=competitive`)}
            >
              <div className="character-card-header">
                <h3>{char.name}</h3>
              </div>
              <div className="age">{char.age} anos</div>
              <p>{char.description}</p>
              <div className="difficulty-tag" title="Dificuldade atual deste personagem (1–100), ajustada pelo desempenho coletivo">
                DIFICULDADE: <strong>{Number.isFinite(char.difficulty) ? char.difficulty : '—'}</strong>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
