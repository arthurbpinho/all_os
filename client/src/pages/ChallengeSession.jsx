import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import { useWakeLock } from '../useWakeLock';

// Sessão do modo Desafio (titular-desafiante). Vive dentro da aba Treinamento
// como atalho clicando no canto inferior direito do card de um paciente:
// - Quando NÃO há Titular do caso → modo 'reivindicar': o aluno atende, vira
//   Titular ao final independente da nota, e recebe avaliação individual (v15)
//   do seu atendimento — opaca, sem nota (consistente com a opacidade do modo).
// - Quando HÁ Titular → modo 'desafiar': o aluno atende, o avaliador
//   titular-desafiante compara o log dele com o do Titular atual e decide
//   binariamente se o Desafiante assume.
// Ambos os avaliadores rodam no SIM/5.4 (Desafio vive no Treinamento).
//
// ISOLAMENTO: o log NÃO entra em logs.json, não puxa sidequest, não conta
// melhor-score, não toca o MMR competitivo. Vive em desafio.json à parte.

const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o paciente), acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana, você já está na sala novamente com o terapeuta.';
const SKIP_MIN_DELAY_MS = 2200;
const MAX_SESSIONS = 6;

export default function ChallengeSession({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState(null); // { mode, character, titular }
  const [stateError, setStateError] = useState('');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const [sessionNumber, setSessionNumber] = useState(1);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [showSessionLimit, setShowSessionLimit] = useState(false);

  // Pós-sessão
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState(null); // 'claimed' | 'desafiante-assume' | 'titular-permanece'
  const [evaluationText, setEvaluationText] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [newTitular, setNewTitular] = useState(null);
  const [submitError, setSubmitError] = useState('');

  // Visitante que venceu (virou Titular) pode digitar o próprio nome — sem
  // foto. Incentivo pra visitante topar o Modo Desafio.
  const [visitorNameInput, setVisitorNameInput] = useState('');
  const [visitorNameSaving, setVisitorNameSaving] = useState(false);
  const [visitorNameError, setVisitorNameError] = useState('');
  const [visitorNameDone, setVisitorNameDone] = useState(false);

  // Mantém a tela ativa enquanto a IA avalia (pode levar dezenas de segundos).
  useWakeLock(submitting);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getDesafioState(id)
      .then((s) => { if (!cancelled) setState(s); })
      .catch((err) => { if (!cancelled) setStateError(err.message || 'Erro ao carregar.'); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (sessionStarted && !sessionEnded) {
      timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [sessionStarted, sessionEnded]);

  // Limite de tempo ativo da sessão atingido (200 min "no chat").
  const limitReached = elapsed >= SESSION_LIMIT_SECONDS;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, streamingText]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function sendToAI(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role)
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: 'freeplay', itemId: id });
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function handleStart() {
    if (!state) return;
    setError('');
    setSessionStarted(true);
    const kickoff = { role: 'user', content: 'Iniciar', isSystem: true, highlighted: false, comment: '' };
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
    if (!trimmed || isTyping || !sessionStarted || sessionEnded || limitReached) return;
    const userMsg = { role: 'user', content: trimmed, highlighted: false, comment: '' };
    const updated = [...messages, userMsg];
    setMessages(updated);
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  function handleSkip() {
    if (!sessionStarted || sessionEnded || isTyping || skipping || limitReached) return;
    if (sessionNumber >= MAX_SESSIONS) { setShowSessionLimit(true); return; }
    setConfirmingSkip(true);
  }

  async function doSkip() {
    setConfirmingSkip(false);
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;
    let newNumber;
    setSessionNumber((prev) => { newNumber = prev + 1; return newNumber; });
    setSkipping(true);
    const breakMarker = { type: 'session-break', sessionNumber: newNumber, stage: 'transitioning' };
    const hiddenSkip = { role: 'user', content: SKIP_PROMPT, isSystem: true, highlighted: false, comment: '' };
    setMessages((prev) => [...prev, breakMarker, hiddenSkip]);
    setIsTyping(true);
    const minDelay = new Promise((r) => setTimeout(r, SKIP_MIN_DELAY_MS));
    try {
      const [reply] = await Promise.all([sendToAI(SKIP_PROMPT, messages), minDelay]);
      const flip = (m) => (m && m.type === 'session-break' && m.sessionNumber === newNumber)
        ? { ...m, stage: 'arrived' } : m;
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: reply }));
    } catch (err) {
      const flip = (m) => (m && m.type === 'session-break' && m.sessionNumber === newNumber)
        ? { ...m, stage: 'arrived' } : m;
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: `Erro ao retomar: ${err.message}` }));
    } finally {
      setIsTyping(false);
      setSkipping(false);
      textareaRef.current?.focus();
    }
  }

  function doReset() {
    setConfirmingReset(false);
    if (timerRef.current) clearInterval(timerRef.current);
    setMessages([]);
    setInput('');
    setElapsed(0);
    setSessionNumber(1);
    setSessionStarted(false);
    setError('');
  }

  function handleFinalize() {
    if (!sessionStarted || sessionEnded) return;
    setConfirmingFinalize(true);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (!sessionStarted || sessionEnded) return;
    const visible = messages.filter((m) => !m.isSystem);
    if (visible.length === 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      setSessionEnded(true);
      return;
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setSessionEnded(true);
    setSubmitting(true);
    setSubmitError('');

    const payload = {
      characterId: id,
      messages: visible.map((m) => ({
        role: m.role,
        content: m.content,
        highlighted: m.highlighted || false,
        comment: m.comment || '',
      })),
      durationSeconds: elapsed,
    };

    try {
      if (state?.mode === 'reivindicar') {
        const res = await api.reivindicarTitular(payload, (_delta, full) => setStreamingText(full));
        setOutcome(res.kind === 'claimed' ? 'claimed' : 'titular-permanece');
        setEvaluationText(res.evaluation || res.evaluationStream || '');
        setNewTitular(res.titular || null);
      } else {
        // Modo desafiar: stream do avaliador titular-desafiante.
        const res = await api.desafiarTitular(payload, (_delta, full) => setStreamingText(full));
        setOutcome(res.outcome || 'titular-permanece');
        setEvaluationText(res.evaluation || res.evaluationStream || '');
        setNewTitular(res.titular || null);
      }
    } catch (err) {
      setSubmitError(err.message || 'Erro ao concluir o desafio.');
    } finally {
      setSubmitting(false);
    }
  }

  // Formulário "digite seu nome" — só aparece pra visitante que acabou de
  // virar Titular (reivindicou ou venceu um desafio), uma vez por sessão.
  function renderVisitorNamePrompt() {
    if (user?.role !== 'visitor') return null;
    if (visitorNameDone) {
      return (
        <p style={{ fontSize: 13.5, color: 'var(--marrs-deep)', fontWeight: 600, marginTop: 10 }}>
          ✓ Salvo — agora você aparece como <strong>{newTitular?.name}</strong>.
        </p>
      );
    }
    return (
      <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--cream-2)', borderRadius: 'var(--radius-lg)' }}>
        <p style={{ margin: '0 0 8px', fontSize: 13.5, color: 'var(--ink-soft)' }}>
          Quer aparecer com o seu nome em vez de "Um visitante"? (sem foto)
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text" value={visitorNameInput} maxLength={40}
            onChange={(e) => setVisitorNameInput(e.target.value)}
            placeholder="Seu nome…" style={{ flex: '1 1 180px' }}
            disabled={visitorNameSaving}
          />
          <button
            type="button" className="btn btn-primary btn-sm"
            onClick={submitVisitorName} disabled={!visitorNameInput.trim() || visitorNameSaving}
          >
            {visitorNameSaving ? 'Salvando…' : 'Salvar nome'}
          </button>
        </div>
        {visitorNameError && <div className="alert error" style={{ marginTop: 8 }}>{visitorNameError}</div>}
      </div>
    );
  }

  async function submitVisitorName() {
    const name = visitorNameInput.trim();
    if (!name || visitorNameSaving) return;
    setVisitorNameSaving(true);
    setVisitorNameError('');
    try {
      const res = await api.setDesafioVisitorName(id, name);
      setNewTitular(res.titular || null);
      setVisitorNameDone(true);
    } catch (err) {
      setVisitorNameError(err.message || 'Erro ao salvar o nome.');
    } finally {
      setVisitorNameSaving(false);
    }
  }

  // ---------- Renderizações ----------

  if (stateError) {
    return (
      <div className="post-session">
        <div className="card" style={{ padding: 24 }}>
          <h3>Não foi possível abrir o modo Desafio</h3>
          <p style={{ color: 'var(--ink-soft)' }}>{stateError}</p>
          <button className="btn btn-primary" onClick={() => navigate('/freeplay')}>Voltar</button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando modo Desafio…</span>
      </div>
    );
  }

  // Bloqueio: usuário já é o Titular deste caso (não pode se desafiar).
  if (state.mode === 'auto-titular') {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Modo Desafio · 👑</div>
          <h2>Você já é o <span className="accent">Titular</span></h2>
          <p>Você detém a posição de referência de <strong>{state.character.name}</strong> no momento. Espere alguém te desafiar — ou treine normalmente.</p>
          <div className="ornament" />
        </div>
        <div className="card" style={{ padding: 24 }}>
          <button className="btn btn-primary" onClick={() => navigate('/freeplay')}>Voltar ao Treinamento</button>
        </div>
      </div>
    );
  }

  // Pós-sessão (após envio do desafio/reivindicação)
  if (sessionEnded) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Modo Desafio · 👑</div>
          <h2>
            {submitting
              ? <>Avaliando seu <span className="accent">desafio</span></>
              : outcome === 'claimed'
                ? <>Você é o novo <span className="accent">Titular</span> 👑</>
                : outcome === 'desafiante-assume'
                  ? <><span className="accent">Desafiante assume</span> como Titular 👑</>
                  : <>Titular <span className="accent">permanece</span></>}
          </h2>
          <p>
            Caso: <strong>{state.character.name}</strong> · duração {formatTime(elapsed)}
          </p>
          <div className="ornament" />
        </div>

        {submitError && <div className="alert error">{submitError}</div>}

        <div className="card">
          {submitting ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--ink-soft)' }}>
              <span className="spinner" />
              <span style={{ marginLeft: 12 }}>
                {state.mode === 'reivindicar'
                  ? 'Você vira Titular. A IA está avaliando seu atendimento — pode levar alguns segundos.'
                  : 'A IA está comparando seu trabalho com o do Titular. Pode levar alguns segundos.'}
              </span>
              {streamingText && (
                <div className="post-evaluation" style={{ marginTop: 16, textAlign: 'left' }}>
                  <div className="post-evaluation-body" style={{ opacity: 0.85 }}>{streamingText}</div>
                </div>
              )}
            </div>
          ) : outcome === 'claimed' ? (
            <>
              <div className="alert" style={{ marginBottom: 16 }}>
                Você foi marcado como Titular de <strong>{state.character.name}</strong>. Até alguém te desafiar e
                vencer, esse título fica seu — aparece no seu perfil como <strong>👑 {state.character.name}</strong>.
              </div>
              {renderVisitorNamePrompt()}
              {evaluationText ? (
                <div className="post-evaluation">
                  <h4>Avaliação do seu atendimento</h4>
                  <div className="post-evaluation-body">{evaluationText}</div>
                </div>
              ) : (
                <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                  Seu log fica salvo como base de comparação para quem te desafiar no futuro.
                </p>
              )}
            </>
          ) : (
            <>
              <div className={`alert ${outcome === 'desafiante-assume' ? 'success' : ''}`} style={{ marginBottom: 16 }}>
                {outcome === 'desafiante-assume'
                  ? <>Você superou o Titular e <strong>assumiu a posição</strong> de <strong>{state.character.name}</strong>.</>
                  : <>O Titular <strong>permaneceu</strong> na posição de <strong>{state.character.name}</strong>.</>}
              </div>
              {outcome === 'desafiante-assume' && renderVisitorNamePrompt()}
              {evaluationText && (
                <div className="post-evaluation">
                  <h4>Análise comparativa da IA</h4>
                  <div className="post-evaluation-body">{evaluationText}</div>
                </div>
              )}
            </>
          )}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate('/freeplay')}>
              Voltar ao Treinamento
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Tela de chat ----------
  const titular = state.titular;
  const modeLabel = state.mode === 'reivindicar'
    ? '👑 Reivindicação'
    : `👑 Desafio · vs ${titular ? titular.name : 'Titular'}`;

  return (
    <div className="chat-container echo-chat">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>
        <div className="chat-title">
          <h3>Sessão com {state.character.name}</h3>
          <div className="chat-status">
            {modeLabel}
            {sessionStarted && <> · <strong>Sessão #{sessionNumber}</strong></>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {sessionStarted && (
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          {sessionStarted && (
            <>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmingReset(true)}
                disabled={isTyping || skipping}
                title="Reiniciar a simulação do zero"
                style={{ color: 'var(--terra)', borderColor: 'var(--terra)' }}
              >
                Reiniciar
              </button>
              <button
                className="btn btn-sm"
                onClick={handleSkip}
                disabled={isTyping || skipping}
                title="Avançar para a próxima sessão"
                style={{ background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}
              >
                Próxima sessão →
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>
                {state.mode === 'reivindicar' ? 'Concluir e reivindicar' : 'Enviar desafio'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">
          {error}<button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem).length === 0 && !sessionStarted && (
          <div className="empty-chat" style={{ marginTop: 100 }}>
            {state.mode === 'reivindicar'
              ? `Ninguém é Titular de ${state.character.name} ainda. Atenda e você vira Titular ao final — independente da nota — e recebe a avaliação do seu atendimento. Seu log fica de base para desafios futuros.`
              : `${titular?.name || 'O Titular atual'} detém a posição de ${state.character.name}. Atenda o paciente; a IA vai comparar seu trabalho com o do Titular e decidir se você assume.`}
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg && msg.type === 'session-break') {
            const isTransitioning = msg.stage !== 'arrived';
            return (
              <div key={i} className={`session-break ${isTransitioning ? 'transitioning' : 'arrived'}`}>
                <div className="session-break-line" />
                <div className="session-break-card">
                  <div className="session-break-badge">Sessão #{msg.sessionNumber}</div>
                  {isTransitioning ? (
                    <>
                      <div className="session-break-text">A sessão foi encerrada. Passando semana…</div>
                      <div className="session-break-loader">
                        <span className="dot" /><span className="dot" /><span className="dot" />
                      </div>
                    </>
                  ) : (
                    <div className="session-break-text">
                      Seu paciente chegou para a sessão da próxima semana, pode iniciar o atendimento.
                    </div>
                  )}
                </div>
                <div className="session-break-line" />
              </div>
            );
          }
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? (user?.name || 'Terapeuta') : state.character.name;
          return (
            <div key={i}>
              <div className={`chat-message-row ${msg.role}`}>
                <div className="chat-message-author">{author}</div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{state.character.name}</div>
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
            <h4>Pronto para começar?</h4>
            <p>
              {state.mode === 'reivindicar'
                ? `Você está reivindicando a posição de Titular de ${state.character.name}. Atenda como faria em qualquer sessão — vira Titular ao final, independente da nota, e recebe a avaliação do seu atendimento.`
                : `Você está desafiando ${titular?.name || 'o Titular atual'} pela posição de ${state.character.name}. Faça seu melhor — a IA vai comparar.`}
            </p>
            <button className="btn btn-primary btn-lg" onClick={handleStart}>
              Iniciar atendimento
            </button>
          </div>
        </div>
      ) : limitReached ? (
        <div className="chat-input-area session-limit-bar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span>Limite de {SESSION_LIMIT_MINUTES} min de sessão atingido. Finalize a sessão para concluir.</span>
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
          <button
            type="button"
            className="icon-btn primary"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isTyping}
            title="Enviar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      )}

      {confirmingFinalize && (() => {
        const visible = messages.filter((m) => !m.isSystem).length;
        const empty = visible === 0;
        const isReivindicar = state.mode === 'reivindicar';
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 500 }}>
              <h3>{isReivindicar ? 'Concluir e reivindicar' : 'Enviar desafio'}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
                {empty
                  ? 'A sessão não tem mensagens ainda. Tem certeza que deseja enviar?'
                  : isReivindicar
                    ? `Ao concluir, você vira Titular de ${state.character.name} (independente da nota) e recebe a avaliação do seu atendimento. A avaliação é definitiva — não dá pra continuar este atendimento depois.`
                    : `Sua sessão será comparada com a do Titular atual pela IA. Se você for melhor, assume a posição; senão, o Titular permanece. Esta avaliação é definitiva — não dá pra continuar este atendimento depois.`}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>
                  {isReivindicar ? 'Sim, reivindicar' : 'Sim, enviar desafio'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar simulação</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              Toda a conversa atual, o tempo e o número da sessão serão <strong>perdidos</strong>. Esta ação não pode ser desfeita.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingReset(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doReset} style={{ background: 'var(--terra)', borderColor: 'var(--terra)' }}>
                Sim, reiniciar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingSkip && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingSkip(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Avançar para a próxima sessão</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18 }}>
              Faça um encerramento com seu paciente antes — essa função é um <em>time skip</em>.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingSkip(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doSkip}>Passar para a próxima sessão</button>
            </div>
          </div>
        </div>
      )}

      {showSessionLimit && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSessionLimit(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Limite de sessões atingido</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              Você atingiu o limite de 6 sessões deste atendimento. Encerre em até 3 mensagens e envie o desafio.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowSessionLimit(false)}>Entendi</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
