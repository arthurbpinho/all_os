import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Aba Duelo — proposta de avaliação comparada entre dois alunos atendendo o
// MESMO personagem. Fluxo de criação:
//   1. Escolher o paciente (personagem) que você vai atender.
//   2. Escolher o oponente: um terapeuta do sistema (convite in-app ou WhatsApp)
//      ou um visitante (link aberto).
//   3. Despachar o convite e iniciar a sua sessão. A nota da sua sessão é o que
//      vale contra a nota da outra pessoa quando ela também terminar.
// Só vale pra treino por enquanto (não toca no MMR).

function buildInviteLink(token) {
  return `${window.location.origin}/duelo/convite/${token}`;
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

export default function Duelo({ user }) {
  const [step, setStep] = useState('character'); // character | opponent
  const [mode, setMode] = useState('training'); // training | competitive
  const [characters, setCharacters] = useState([]);
  const [opponents, setOpponents] = useState([]);
  const [selectedChar, setSelectedChar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState(null); // { duel, method, opponentName, link }
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.getFreeplay(), api.getDuelOpponents().catch(() => [])])
      .then(([chars, opps]) => {
        setCharacters(chars || []);
        setOpponents(opps || []);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar dados.'))
      .finally(() => setLoading(false));
  }, [user]);

  function pickCharacter(char) {
    setSelectedChar(char);
    setStep('opponent');
  }

  async function startInvite({ opponentUserId, opponentName, method }) {
    if (!selectedChar || creating) return;
    setCreating(true);
    setError('');
    try {
      const duel = await api.createDuel({
        characterId: selectedChar.id,
        opponentUserId: opponentUserId || undefined,
        inviteMethod: method,
        mode,
      });
      const link = duel.token ? buildInviteLink(duel.token) : '';
      if (method === 'whatsapp') {
        const text = `Te desafio para um duelo clínico no all_OS! Atenda ${selectedChar.name} e vamos ver quem se sai melhor. Aceite aqui: ${link}`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      }
      setInvite({ duel, method, opponentName: opponentName || 'seu convidado', link });
    } catch (err) {
      setError(err.message || 'Erro ao criar o duelo.');
    } finally {
      setCreating(false);
    }
  }

  function startMySession() {
    if (invite?.duel?.id) navigate(`/duelo/sessao/${invite.duel.id}`);
  }

  async function copyLink() {
    if (!invite?.link) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  // ---- Tela de convite despachado (gate antes de iniciar a sessão) ----
  if (invite) {
    const isWhats = invite.method === 'whatsapp';
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Duelo {mode === 'competitive' ? 'competitivo' : 'de treino'} · {selectedChar?.name}</div>
          <h2>Convite <span className="accent">enviado</span></h2>
          <div className="ornament" />
        </div>
        <div className="card duel-invite-sent">
          {isWhats ? (
            <>
              <p style={{ fontSize: 15, lineHeight: 1.6 }}>
                Compartilhe o link do duelo com a pessoa. Assim que ela abrir, também começa o
                atendimento de <strong>{selectedChar?.name}</strong> — e no fim comparamos as duas notas.
              </p>
              <div className="duel-link-row">
                <input readOnly value={invite.link} onFocus={(e) => e.target.select()} />
                <button className="btn btn-outline btn-sm" onClick={copyLink}>{copied ? 'Copiado!' : 'Copiar'}</button>
              </div>
              <div className="duel-confirm-box">
                <h4>Você já enviou o link pra pessoa?</h4>
                <p>Assim que enviar, iniciaremos a sua sessão.</p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" onClick={startMySession}>Sim! Enviei.</button>
                  <button className="btn btn-outline" onClick={() => { setInvite(null); setStep('opponent'); }}>Voltar</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 15, lineHeight: 1.6 }}>
                Convite enviado para <strong>{invite.opponentName}</strong> pelo sistema — vai aparecer nas
                notificações dela. Você já pode iniciar a sua sessão; o resultado fica pendente até ela atender
                <strong> {selectedChar?.name}</strong> também.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                <button className="btn btn-primary" onClick={startMySession}>Iniciar minha sessão</button>
                <button className="btn btn-outline" onClick={() => { setInvite(null); setStep('opponent'); }}>Voltar</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Sistema 2 · Duelo</div>
        <h2><Typewriter text="Due" /><span className="accent"><Typewriter text="lo" delayStart={140} /></span></h2>
        <p>
          Avaliação comparada: você e outra pessoa atendem o <strong>mesmo paciente</strong>, cada um na sua
          sessão. No fim, o avaliador comparativo lê os dois atendimentos lado a lado, dá uma nota a cada um e
          aponta o vencedor. Por enquanto vale só pra treino (sem MMR).
        </p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

      {/* Indicador de passos */}
      <div className="duel-steps">
        <span className={step === 'character' ? 'active' : 'done'}>1 · Paciente</span>
        <span className="duel-steps-sep">→</span>
        <span className={step === 'opponent' ? 'active' : ''}>2 · Oponente</span>
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span>
        </div>
      ) : step === 'character' ? (
        <>
          <h3 className="duel-section-title">Escolha o paciente que você vai atender no duelo</h3>
          {characters.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
              Nenhum personagem cadastrado ainda.
            </div>
          ) : (
            <div className="card-grid">
              {characters.map((char) => (
                <div key={char.id} className="character-card" onClick={() => pickCharacter(char)}>
                  <div className="character-card-header"><h3>{char.name}</h3></div>
                  <div className="age">{char.age} anos</div>
                  <p>{char.description}</p>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="duel-selected-char">
            <span>Paciente: <strong>{selectedChar?.name}</strong></span>
            <button className="btn btn-ghost btn-sm" onClick={() => { setStep('character'); setSelectedChar(null); }}>trocar</button>
          </div>

          {/* Modo do duelo */}
          <div className="duel-mode-block">
            <div className="duel-mode-toggle">
              <button className={mode === 'training' ? 'active' : ''} onClick={() => setMode('training')}>Treino</button>
              <button className={mode === 'competitive' ? 'active' : ''} onClick={() => setMode('competitive')}>Competitivo</button>
            </div>
            <p className="duel-mode-hint">
              {mode === 'competitive'
                ? 'Vale MMR. Só conta entre jogadores cadastrados e fora da calibração; se a diferença de nível for muito grande (nota muito baixa de um dos lados), não é contabilizado (anti-smurf).'
                : 'Sem ranking — só treino e feedback comparativo. Pode duelar contra visitante.'}
            </p>
          </div>

          <h3 className="duel-section-title">Quem você quer desafiar?</h3>

          {/* Visitante / link aberto — só no treino (competitivo exige cadastro) */}
          {mode !== 'competitive' && (
          <div className="card duel-visitor-card">
            <div className="duel-opp-info">
              <span className="duel-avatar">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
              </span>
              <div>
                <div className="duel-opp-name">Duelar contra um visitante</div>
                <div className="duel-opp-sub">Gera um link aberto — quem abrir entra como visitante e atende o mesmo paciente.</div>
              </div>
            </div>
            <div className="duel-opp-actions">
              <button className="btn btn-secondary btn-sm" disabled={creating} onClick={() => startInvite({ method: 'whatsapp', opponentName: 'visitante' })}>
                Gerar link / WhatsApp
              </button>
            </div>
          </div>
          )}

          {/* Lista de terapeutas */}
          {opponents.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '28px 24px', color: 'var(--ink-soft)' }}>
              Nenhum outro terapeuta cadastrado para desafiar. Você ainda pode duelar contra um visitante acima.
            </div>
          ) : (
            <div className="duel-opp-list">
              {opponents.map((o) => (
                <div key={o.userId} className="duel-opp-row">
                  <div className="duel-opp-info">
                    <span className="duel-avatar">{avatar(o.profilePhoto, o.name)}</span>
                    <div className="duel-opp-name">{o.name}</div>
                  </div>
                  <div className="duel-opp-actions">
                    <button className="btn btn-primary btn-sm" disabled={creating} onClick={() => startInvite({ opponentUserId: o.userId, opponentName: o.name, method: 'system' })}>
                      Convidar
                    </button>
                    <button className="btn btn-outline btn-sm duel-whats-btn" disabled={creating} title="Convidar por WhatsApp" onClick={() => startInvite({ opponentUserId: o.userId, opponentName: o.name, method: 'whatsapp' })}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.8 14.16c-.24.68-1.42 1.32-1.95 1.36-.5.04-.96.22-3.23-.67-2.73-1.08-4.46-3.88-4.6-4.06-.13-.18-1.1-1.46-1.1-2.79 0-1.33.7-1.98.94-2.25.24-.27.53-.34.71-.34.18 0 .35 0 .51.01.16.01.39-.06.6.46.24.56.82 1.94.89 2.08.07.14.12.3.02.48-.09.18-.14.3-.27.46-.14.16-.29.36-.41.48-.14.14-.28.29-.12.56.16.27.71 1.17 1.53 1.9 1.05.94 1.94 1.23 2.21 1.37.27.14.43.12.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.22.6-.13.24.09 1.55.73 1.81.86.27.13.45.2.51.31.07.11.07.64-.17 1.32z"/></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
