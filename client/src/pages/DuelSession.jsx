import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ScoreBadge from '../components/ScoreBadge';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import { useWakeLock } from '../useWakeLock';

// Sessão de duelo: você atende o personagem do duelo na sua própria sessão.
// Ao finalizar, a transcrição é enviada (submitDuel). Quando o OUTRO lado também
// envia, o avaliador comparativo roda no backend e o resultado (vencedor + as
// duas notas + análise) aparece aqui. Enquanto o oponente não termina, fica
// pendente (você pode aguardar aqui ou ver depois nos Logs de Duelo).

const POLL_MS = 5000;

function lsKey(id) { return `allos_duel_session__${id}`; }

export default function DuelSession({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [duel, setDuel] = useState(null);
  const [item, setItem] = useState(null); // personagem (id+name vêm do duelo)
  const [loadError, setLoadError] = useState('');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [highlightTarget, setHighlightTarget] = useState(null);
  const [highlightDraft, setHighlightDraft] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);

  const [submitting, setSubmitting] = useState(false); // enviando/avaliando
  const [view, setView] = useState('loading'); // loading | session | waiting | result | evaluating

  // Mantém a tela ativa durante o envio/avaliação. Não inclui 'waiting' (espera
  // pelo oponente), que pode durar horas — aí não faz sentido segurar a tela.
  useWakeLock(submitting || view === 'evaluating');

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const pollRef = useRef(null);
  const restoredRef = useRef(false);

  const youAre = duel?.youAre;
  const character = duel?.character;
  const opponentName = youAre === 'challenger'
    ? (duel?.opponent?.name || 'seu oponente')
    : (duel?.challenger?.name || 'o desafiante');
  const mySide = youAre ? duel?.[youAre] : null;
  const mySubmitted = mySide?.state === 'submitted';

  // Carrega o duelo e decide a tela.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await api.getDuel(id);
        if (cancelled) return;
        setDuel(d);
        setItem(d.character);
        if (d.result || d.status === 'completed') {
          setView('result');
        } else if (d[d.youAre]?.state === 'submitted') {
          setView('waiting');
        } else {
          setView('session');
          // Restaura rascunho local (refresh no meio do atendimento).
          if (!restoredRef.current) {
            restoredRef.current = true;
            try {
              const raw = localStorage.getItem(lsKey(id));
              const saved = raw ? JSON.parse(raw) : null;
              if (saved && Array.isArray(saved.messages) && saved.messages.length) {
                setMessages(saved.messages);
                setElapsed(saved.elapsed || 0);
                setSessionStarted(true);
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'Erro ao carregar o duelo.');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id]);

  // Cronômetro
  useEffect(() => {
    if (view === 'session' && sessionStarted) {
      timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [view, sessionStarted]);

  // Limite de tempo ativo da sessão atingido (200 min "no chat").
  const limitReached = elapsed >= SESSION_LIMIT_SECONDS;

  // Autosave local enquanto atende.
  useEffect(() => {
    if (view !== 'session' || !sessionStarted) return;
    try { localStorage.setItem(lsKey(id), JSON.stringify({ messages, elapsed })); } catch {}
  }, [messages, elapsed, view, sessionStarted, id]);

  // Polling do resultado enquanto aguarda o oponente.
  useEffect(() => {
    if (view !== 'waiting') return;
    pollRef.current = setInterval(async () => {
      try {
        const d = await api.getDuel(id);
        setDuel(d);
        if (d.result || d.status === 'completed') {
          setView('result');
          clearInterval(pollRef.current);
        }
      } catch {}
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [view, id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function sendToAI(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role)
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: 'freeplay', itemId: character.id });
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function handleStart() {
    if (!character) return;
    setSessionStarted(true);
    const kickoff = { role: 'user', content: 'Iniciar', isSystem: true };
    setMessages([kickoff]);
    setIsTyping(true);
    try {
      const reply = await sendToAI('Iniciar', []);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
      textareaRef.current?.focus();
    }
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || !sessionStarted || limitReached) return;
    const userMsg = { role: 'user', content: trimmed, highlighted: false, comment: '' };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    try {
      const reply = await sendToAI(trimmed, messages);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  function openHighlight(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'user') return;
    setHighlightTarget({ idx });
    setHighlightDraft(msg.comment || '');
  }
  function saveHighlight() {
    if (!highlightTarget) return;
    setMessages((prev) => prev.map((m, i) => i === highlightTarget.idx ? { ...m, highlighted: true, comment: highlightDraft.trim() } : m));
    setHighlightTarget(null);
    setHighlightDraft('');
  }
  function removeHighlight(idx) {
    setMessages((prev) => prev.map((m, i) => i === idx ? { ...m, highlighted: false, comment: '' } : m));
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (timerRef.current) clearInterval(timerRef.current);
    const visible = messages.filter((m) => !m.isSystem);
    setSubmitting(true);
    setView('evaluating');
    try {
      const payload = {
        messages: visible.map((m) => ({ role: m.role, content: m.content, highlighted: !!m.highlighted, comment: m.comment || '' })),
        durationSeconds: elapsed,
      };
      const updated = await api.submitDuel(id, payload);
      try { localStorage.removeItem(lsKey(id)); } catch {}
      setDuel(updated);
      if (updated.result || updated.status === 'completed') setView('result');
      else setView('waiting');
    } catch (err) {
      setError(err.message || 'Erro ao enviar a sessão.');
      setView('session');
    } finally {
      setSubmitting(false);
    }
  }

  // ---------------- TELAS ----------------
  if (loadError) {
    return (
      <div className="post-session">
        <div className="alert error">{loadError}</div>
        <button className="btn btn-outline" onClick={() => navigate('/duelo')}>Voltar ao Duelo</button>
      </div>
    );
  }

  if (view === 'loading' || !duel) {
    return (
      <div className="post-session">
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando duelo…</span>
        </div>
      </div>
    );
  }

  if (view === 'evaluating' || submitting) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Duelo · {character?.name}</div>
          <h2>Enviando seu <span className="accent">atendimento</span></h2>
          <p>Se o seu oponente já terminou, a avaliação comparativa começa agora.</p>
          <div className="ornament" />
        </div>
        <div className="card evaluating-card">
          <div className="evaluating-orb">
            <div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" />
          </div>
          <div className="evaluating-status">
            <div className="evaluating-line"><span className="dot active" /> Enviando sua transcrição</div>
            <div className="evaluating-line"><span className="dot pulse" /> Verificando se o oponente terminou</div>
            <div className="evaluating-line"><span className="dot" /> Avaliação comparativa</div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'waiting') {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Duelo · {character?.name}</div>
          <h2>Atendimento <span className="accent">enviado</span></h2>
          <div className="ornament" />
        </div>
        <div className="card" style={{ textAlign: 'center', padding: '36px 24px' }}>
          <div className="duel-waiting-orb"><span className="spinner" /></div>
          <h3 style={{ marginTop: 16 }}>Aguardando {opponentName} terminar…</h3>
          <p style={{ color: 'var(--ink-soft)', maxWidth: 460, margin: '8px auto 0', lineHeight: 1.6 }}>
            Seu resultado fica pendente até a outra pessoa concluir o atendimento de <strong>{character?.name}</strong>.
            Você pode esperar aqui (atualiza sozinho) ou ver depois nos Logs de Duelo.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
            <button className="btn btn-outline" onClick={() => navigate('/duelo/logs')}>Ver depois (Logs de Duelo)</button>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'result') {
    const r = duel.result;
    if (!r) {
      return (
        <div className="post-session">
          <div className="alert">Resultado indisponível para este duelo.</div>
          <button className="btn btn-outline" onClick={() => navigate('/duelo/logs')}>Logs de Duelo</button>
        </div>
      );
    }
    const myScore = youAre === 'opponent' ? r.scoreOpponent : r.scoreChallenger;
    const theirScore = youAre === 'opponent' ? r.scoreChallenger : r.scoreOpponent;
    const draw = r.winner === 'draw';
    const iWon = !draw && r.winner === youAre;
    const outcomeLabel = draw ? 'Empate' : iWon ? 'Você venceu!' : 'Você perdeu';
    const outcomeClass = draw ? 'draw' : iWon ? 'win' : 'loss';

    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Duelo concluído · {character?.name}</div>
          <h2>Resultado do <span className="accent">duelo</span></h2>
          <div className="ornament" />
        </div>

        <div className={`card duel-result-card ${outcomeClass}`}>
          <div className={`duel-outcome ${outcomeClass}`}>{outcomeLabel}</div>
          <div className="duel-scoreline">
            <div className="duel-score-side">
              <div className="duel-score-name">Você</div>
              <ScoreBadge score={myScore} size="xl" />
            </div>
            <div className="duel-score-vs">×</div>
            <div className="duel-score-side">
              <div className="duel-score-name">{opponentName}</div>
              <ScoreBadge score={theirScore} size="xl" />
            </div>
          </div>
        </div>

        {duel.mode === 'competitive' && (
          <div className="card duel-mmr-card">
            {r.mmr && r.mmr.ranked ? (() => {
              const m = youAre === 'opponent' ? r.mmr.opponent : r.mmr.challenger;
              const up = m.delta >= 0;
              return (
                <>
                  <span className="post-stat-label">Seu MMR</span>
                  <div className="mmr-result-value">
                    {m.after}
                    <span className={`mmr-delta ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {Math.abs(m.delta).toFixed(1)}</span>
                  </div>
                  <p className="mmr-result-note">
                    Dificuldade de {character?.name} agora: <strong>{r.mmr.characterDifficulty}</strong>
                  </p>
                </>
              );
            })() : (
              <>
                <span className="post-stat-label">Competitivo</span>
                <p className="mmr-result-note">
                  {r.mmr?.reason === 'anti_smurf'
                    ? 'Como a diferença de nível foi muito grande, este duelo não foi contabilizado para o competitivo.'
                    : r.mmr?.reason === 'calibrating'
                    ? 'Este duelo não contou para o competitivo — um dos jogadores ainda está em calibração (precisa completar as 3 primeiras partidas).'
                    : r.mmr?.reason === 'visitor'
                    ? 'Duelos competitivos valem só entre jogadores cadastrados — este não contou para o MMR.'
                    : 'Este duelo não foi contabilizado para o competitivo.'}
                </p>
              </>
            )}
          </div>
        )}

        {r.evaluation && (
          <div className="card">
            <div className="post-evaluation">
              <h4>Análise comparativa da IA</h4>
              <div className="post-evaluation-body">{r.evaluation}</div>
            </div>
          </div>
        )}

        <div className="post-session-actions">
          <button className="btn btn-primary" onClick={() => navigate('/duelo/logs')}>Logs de Duelo</button>
          <button className="btn btn-outline" onClick={() => navigate('/duelo')}>Novo duelo</button>
        </div>
      </div>
    );
  }

  // ---------------- TELA DE SESSÃO (chat) ----------------
  const visibleCount = messages.filter((m) => !m.isSystem).length;

  return (
    <div className="chat-container echo-chat">
      <div className="chat-header">
        <button onClick={() => navigate('/duelo')} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>
        <div className="chat-title">
          <h3>Duelo · {character?.name || '...'}</h3>
          <div className="chat-status">vs {opponentName}{duel?.mode === 'competitive' ? ' · Competitivo (MMR)' : ' · Treino'}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {sessionStarted && (
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          {sessionStarted && (
            <button className="btn btn-secondary btn-sm" onClick={() => setConfirmingFinalize(true)} disabled={isTyping}>
              Finalizar duelo
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {visibleCount === 0 && !sessionStarted && (
          <div className="empty-chat" style={{ marginTop: 100 }}>
            Atenda {character?.name} no seu melhor — a sua nota será comparada com a de {opponentName}.
          </div>
        )}
        {messages.map((msg, i) => {
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? user.name : (character?.name || 'Paciente');
          return (
            <div key={i}>
              <div className={`chat-message-row ${msg.role} ${msg.highlighted ? 'highlighted' : ''}`}>
                <div className="chat-message-author">
                  {msg.highlighted && <span className="star-inline">★</span>} {author}
                </div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
                {isUser && (
                  <div className="message-tools">
                    {msg.highlighted ? (
                      <>
                        <button className="tool-btn active" onClick={() => openHighlight(i)} title="Editar destaque">★</button>
                        <button className="tool-btn" onClick={() => removeHighlight(i)} title="Remover destaque">×</button>
                      </>
                    ) : (
                      <button className="tool-btn" onClick={() => openHighlight(i)} title="Destacar mensagem">★</button>
                    )}
                  </div>
                )}
                {isUser && msg.highlighted && msg.comment && (
                  <div className="highlight-comment">{`{${msg.comment}}`}</div>
                )}
              </div>
            </div>
          );
        })}
        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{character?.name || 'Paciente'}</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
              <span className="loading-dots">Pensando</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!sessionStarted ? (
        <div className="start-session-area">
          <div className="start-session-card">
            {youAre === 'opponent' ? (
              <>
                <h4>Você aceitou um duelo de {duel?.challenger?.name || 'alguém'}</h4>
                <p>Para atender <strong>{character?.name}</strong>. Ao iniciar, {character?.name} abre a conversa.
                  Use o botão de estrela (★) para marcar suas intervenções.</p>
              </>
            ) : (
              <>
                <h4>Pronto para o duelo?</h4>
                <p>Você vai atender <strong>{character?.name}</strong>. Sua nota nesta sessão é o que vale contra
                  {' '}{opponentName}. Ao iniciar, {character?.name} abre a conversa.</p>
              </>
            )}
            <button className="btn btn-primary btn-lg" onClick={handleStart} disabled={!character}>
              Iniciar atendimento
            </button>
          </div>
        </div>
      ) : limitReached ? (
        <div className="chat-input-area session-limit-bar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span>Limite de {SESSION_LIMIT_MINUTES} min de sessão atingido. Finalize o duelo para concluir.</span>
        </div>
      ) : (
        <div className="chat-input-area">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha"
            rows={1}
            disabled={isTyping}
          />
          <button type="button" className="icon-btn primary" onClick={() => sendMessage(input)} disabled={!input.trim() || isTyping} title="Enviar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          </button>
        </div>
      )}

      {confirmingFinalize && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
          <div className="modal" style={{ maxWidth: 500 }}>
            <h3>Finalizar duelo</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              {visibleCount === 0
                ? 'A sessão não tem mensagens ainda. Enviar mesmo assim?'
                : 'Tem certeza? Sua sessão será enviada para a avaliação comparativa e não poderá mais ser alterada.'}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doFinalize}>Enviar atendimento</button>
            </div>
          </div>
        </div>
      )}

      {highlightTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setHighlightTarget(null); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Destacar mensagem</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginBottom: 14 }}>
              Por que você está destacando essa intervenção? <em>(opcional)</em>
            </p>
            <textarea value={highlightDraft} onChange={(e) => setHighlightDraft(e.target.value)} placeholder="Ex: testei uma reformulação…" style={{ minHeight: 120 }} autoFocus />
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setHighlightTarget(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={saveHighlight}>Salvar destaque</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
