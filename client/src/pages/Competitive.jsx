import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { PatientAvatar } from '../components/PatientAvatar';

// Simulação (nome antigo: Competitivo) — o modo BASE do app, e por isso uma das
// duas portas da tela de Início. Mesmos personagens da Progressão, mas cada
// partida finalizada alimenta o MMR (rating). A dificuldade de cada personagem é
// aberta e exibida no card. O MMR fica oculto até a 4ª partida (calibração de 3).
//
// Dois enfeites de card vivem SÓ aqui (o servidor manda ambos em /api/freeplay):
//   - record   → 👑 com a maior nota já tirada naquele paciente no Competitivo e
//                quem a tirou. Substituiu o antigo Modo Desafio: virou recorde,
//                não uma disputa à parte.
//   - featured → "Paciente em Destaque", o ÚLTIMO personagem cadastrado. Ganha
//                fundo amarelo E vai pro começo da lista, pra puxar atendimentos
//                e calibrar o TRI dele mais rápido. Puro truque visual, nenhuma
//                regra depende disso — e o reordenamento é SÓ desta tela: as
//                outras (Progressão, Duelo, admin) mantêm a ordem de cadastro.
//
// O componente segue chamado Competitive e a rota antiga /competitivo continua
// respondendo (redireciona pra /simulacao): o identificador interno do modo é
// 'competitive' em log.mode, MMR e Duelo, e renomeá-lo migraria dados por
// cosmética. O que virou "Simulação" é o NOME VISÍVEL.
export default function Competitive({ user }) {
  const [characters, setCharacters] = useState([]);
  const [mmr, setMmr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getFreeplay(), api.getMyMmr().catch(() => null)])
      .then(([chars, myMmr]) => {
        // Destaque primeiro; o resto mantém a ordem de cadastro que veio do
        // servidor (sort estável).
        const list = [...(chars || [])].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
        setCharacters(list);
        setMmr(myMmr);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Prática · Simulação</div>
        <h2><Typewriter text="Simu" /><span className="accent"><Typewriter text="lação" delayStart={180} /></span></h2>
        <p>
          Atender pacientes simulados valendo ranking — é aqui que a sua evolução é medida contra
          a comunidade. Ao finalizar, a partida é enviada para avaliação e sua <strong>nota</strong> +{' '}
          <strong>MMR</strong> são calculados em até <strong>24 horas</strong> — você confere em{' '}
          <strong>Minhas Sessões</strong>. A dificuldade de cada personagem se ajusta ao desempenho
          coletivo. As 3 primeiras partidas são de calibração.
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
          {characters.map((char) => {
            const record = char.record;
            return (
              <div
                key={char.id}
                className={`character-card${char.featured ? ' featured-card' : ''}`}
                onClick={() => navigate(`/chat/freeplay/${char.id}?mode=competitive`)}
              >
                <div className="character-card-top">
                  <PatientAvatar name={char.name} iconUrl={char.photoIcon} size={72} className="character-card-photo" />
                  <div className="character-card-meta">
                    <div className="character-card-header">
                      <h3>{char.name}</h3>
                    </div>
                    <div className="age">{char.age} anos</div>
                  </div>
                </div>
                <p>{char.description}</p>
                <div className="difficulty-tag" title="Dificuldade atual deste personagem (1–100), ajustada pelo desempenho coletivo">
                  DIFICULDADE: <strong>{Number.isFinite(char.difficulty) ? char.difficulty : '—'}</strong>
                </div>
                {/* Paciente em Destaque: o personagem mais novo do acervo. Fundo
                    amarelo + selo pra puxar atendimentos e calibrar o TRI dele. */}
                {char.featured && (
                  <div className="featured-badge" title="Personagem recém-adicionado — atenda para ajudar a calibrar a dificuldade dele">
                    <span aria-hidden>★</span> Paciente em destaque
                  </div>
                )}
                {/* Recorde 👑: maior nota que alguém já tirou neste paciente no
                    Competitivo. Só informativo — não é clicável. */}
                {record ? (
                  <div
                    className="record-footer"
                    title={`Recorde deste paciente: ${record.score} — ${record.userName}`}
                  >
                    <span className="crown-emoji" aria-hidden>👑</span>
                    <span className="record-avatar">
                      {record.userPhoto
                        ? <img src={record.userPhoto} alt="" />
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>}
                    </span>
                    <span className="record-score">{record.score}</span>
                    <span className="record-name">{record.userName}</span>
                  </div>
                ) : (
                  <div className="record-footer record-empty" title="Ninguém pontuou neste paciente ainda — o recorde está em aberto">
                    <span className="crown-emoji" aria-hidden>👑</span>
                    <span className="record-name">Recorde em aberto</span>
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
