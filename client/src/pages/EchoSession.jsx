import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  buildFreeplayPrompt,
  buildNeuroPrompt,
  buildDirectEvaluationPrompt,
  parseCriteriaScores,
  calculateScores,
} from '../prompts';
import ScoreBadge from '../components/ScoreBadge';
import { loadActiveSession, saveActiveSession, clearActiveSession } from '../sessionStore';

// Sessão livre (FreePlay e Neuroavaliação) — fluxo herdado do Echos:
// 1. Iniciar Sessão (cronômetro começa, chat libera)
// 2. Conversa com personagem (Assistants API se houver assistant_id, senão chat completion)
// 3. Destaque de mensagens do terapeuta (estrela + comentário)
// 4. Finalizar → tela pós-sessão com duração e download de log

export default function EchoSession({ user, sessionType }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [threadId, setThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0); // segundos
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [highlightTarget, setHighlightTarget] = useState(null); // { msgIndex }
  const [highlightDraft, setHighlightDraft] = useState('');
  const [assistantBroken, setAssistantBroken] = useState(false);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);

  // Avaliação automática pós-sessão
  const [evaluating, setEvaluating] = useState(false);
  const [evaluationText, setEvaluationText] = useState('');
  const [score, setScore] = useState(null);
  const [criteriaScores, setCriteriaScores] = useState(null);
  const [evalError, setEvalError] = useState('');

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false); // já tentou restaurar

  // Carrega item + tenta restaurar sessão ativa (F5 / sair e voltar)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = sessionType === 'freeplay' ? await api.getFreeplay() : await api.getNeuro();
        const found = list.find((i) => String(i.id) === String(id));
        if (cancelled) return;
        if (!found) { setError('Personagem não encontrado.'); return; }
        setItem(found);
        const prompt = sessionType === 'freeplay'
          ? buildFreeplayPrompt(found.specificInstruction)
          : buildNeuroPrompt(found.specificInstruction);
        setSystemPrompt(prompt);

        // Restaura sessão pendente (se houver)
        if (!restoredRef.current && user?.id) {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, sessionType, id);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
            if (saved.threadId) setThreadId(saved.threadId);
            setSessionStarted(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Erro ao carregar personagem.');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, sessionType, user?.id]);

  // Autosave da sessão ativa (debounce 3s) sempre que messages ou elapsed muda
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !item) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      saveActiveSession(user.id, sessionType, id, {
        messages,
        elapsedSeconds: elapsed,
        threadId,
        itemTitle: item.name,
      });
    }, 3000);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, threadId, user?.id, id, sessionType]);

  // Cronômetro
  useEffect(() => {
    if (sessionStarted && !sessionEnded) {
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [sessionStarted, sessionEnded]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function handleStartSession() {
    if (!item) return;
    setError('');
    let localThreadId = null;
    try {
      // Cria thread só se houver assistantId
      if (item.assistantId) {
        const res = await api.createThread();
        localThreadId = res.threadId;
        setThreadId(res.threadId);
      }
      setSessionStarted(true);

      // Disparo: o paciente fala primeiro. Mandamos "Iniciar" oculto pra IA
      // gerar a abertura do atendimento (que costuma ser a abertura fixa do prompt).
      const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true, highlighted: false, comment: '' };
      setMessages([kickoffMsg]);
      setIsTyping(true);
      try {
        const reply = await sendToAI('Iniciar', [], localThreadId);
        setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
      } catch (err) {
        setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
      } finally {
        setIsTyping(false);
        textareaRef.current?.focus();
      }
    } catch (err) {
      setError('Erro ao iniciar atendimento: ' + err.message);
    }
  }

  async function sendViaChat(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }].map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const data = await api.chat(apiMessages, systemPrompt);
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function sendToAI(text, currentMessages, threadIdOverride) {
    const tid = threadIdOverride || threadId;
    // Se já degradou para chat completion (assistant_id ruim), continua nele
    if (item.assistantId && tid && !assistantBroken) {
      try {
        const data = await api.assistantMessage(tid, item.assistantId, text);
        return data.content;
      } catch (err) {
        // Se o erro é claramente de configuração do assistant_id, faz fallback
        const msg = err.message || '';
        if (
          /assistant[_ ]id/i.test(msg) ||
          /string too long/i.test(msg) ||
          /No assistant found/i.test(msg) ||
          /Invalid 'assistant_id'/i.test(msg)
        ) {
          setAssistantBroken(true);
          setError('Assistant ID configurado é inválido — usando o prompt de instrução específica como fallback.');
          return await sendViaChat(text, currentMessages);
        }
        throw err;
      }
    }
    return await sendViaChat(text, currentMessages);
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || !sessionStarted || sessionEnded) return;

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

  function buildTranscript() {
    return messages
      .filter((m) => !m.isSystem)
      .map((m) => {
        const author = m.role === 'user' ? user.name : item.name;
        const star = m.highlighted ? ' ★' : '';
        const comment = m.highlighted && m.comment ? `\n   [comentário do terapeuta: ${m.comment}]` : '';
        return `[${author}${star}]\n${m.content}${comment}`;
      })
      .join('\n\n---\n\n');
  }

  function handleFinalize() {
    if (!sessionStarted || sessionEnded) return;
    setConfirmingFinalize(true);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (!sessionStarted || sessionEnded) return;
    const visibleCount = messages.filter((m) => !m.isSystem).length;
    if (visibleCount === 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      setSessionEnded(true);
      clearActiveSession(user.id, sessionType, id);
      return;
    }

    if (timerRef.current) clearInterval(timerRef.current);
    setSessionEnded(true);
    setEvaluating(true);
    setEvalError('');

    const sessionLabel = sessionType === 'freeplay' ? 'Simulação' : 'Neuroavaliação';
    const transcript = buildTranscript();
    const evalMessages = [{
      role: 'user',
      content: buildDirectEvaluationPrompt(sessionLabel, item.name, transcript),
    }];

    let evalContent = '';
    let totalScore = null;
    let parsedCriteria = null;

    try {
      const reply = await api.evaluate(evalMessages);
      evalContent = typeof reply === 'string' ? reply : reply.content || '';

      parsedCriteria = parseCriteriaScores(evalContent);
      if (parsedCriteria) {
        totalScore = calculateScores(parsedCriteria).totalScore;
      } else {
        const m = evalContent.match(/\[NOTA:\s*([-+]?\d+(?:[.,]\d+)?)\s*\]/i);
        if (m) totalScore = Number(m[1].replace(',', '.'));
      }
      if (totalScore !== null && !Number.isFinite(totalScore)) totalScore = null;
      if (totalScore !== null) totalScore = Math.round(totalScore);

      setEvaluationText(evalContent);
      setScore(totalScore);
      setCriteriaScores(parsedCriteria);
    } catch (err) {
      setEvalError(err.message || 'Erro ao avaliar a sessão.');
    } finally {
      setEvaluating(false);
    }

    // Salvar log com a avaliação anexada
    try {
      await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: sessionType,
        itemId: id,
        itemTitle: item.name,
        messages: messages.filter((m) => !m.isSystem).map((m) => ({
          role: m.role,
          content: m.content,
          highlighted: m.highlighted || false,
          comment: m.comment || '',
        })),
        durationSeconds: elapsed,
        score: totalScore,
        criteriaScores: parsedCriteria,
        evaluation: evalContent,
      });
    } catch (err) {
      setError('Erro ao salvar log: ' + err.message);
    }

    // Atualizar progresso por personagem (mantém a maior nota, igual aos exercícios)
    if (totalScore !== null) {
      try {
        const current = await api.getProgress(user.id);
        const existing = current?.[id];
        const shouldUpdate = !existing
          || existing.score == null
          || totalScore > existing.score;
        if (shouldUpdate) {
          await api.saveProgress(user.id, {
            [id]: {
              score: totalScore,
              type: sessionType,
              criteriaScores: parsedCriteria,
              completedAt: new Date().toISOString(),
            },
          });
        }
      } catch (err) {
        // não-fatal, log já foi salvo
        console.warn('Erro ao atualizar progresso:', err);
      }
    }

    // Sessão finalizada — limpa o autosave ativo
    clearActiveSession(user.id, sessionType, id);
  }

  async function toggleRecording() {
    if (!sessionStarted || sessionEnded || isTranscribing) return;
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        setIsTranscribing(true);
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = reader.result.split(',')[1];
          try {
            const data = await api.transcribe(base64);
            const text = data.text || data.transcription || '';
            setInput((prev) => (prev ? prev + ' ' + text : text));
            textareaRef.current?.focus();
          } catch (err) {
            setError('Erro ao transcrever: ' + err.message);
          } finally {
            setIsTranscribing(false);
          }
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError('Não foi possível acessar o microfone: ' + err.message);
    }
  }

  function openHighlight(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'user') return;
    setHighlightTarget({ idx });
    setHighlightDraft(msg.comment || '');
  }

  function saveHighlight() {
    if (!highlightTarget) return;
    setMessages((prev) =>
      prev.map((m, i) =>
        i === highlightTarget.idx ? { ...m, highlighted: true, comment: highlightDraft.trim() } : m
      )
    );
    setHighlightTarget(null);
    setHighlightDraft('');
  }

  function removeHighlight(idx) {
    setMessages((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, highlighted: false, comment: '' } : m))
    );
  }

  function downloadLog() {
    const lines = messages.map((m) => {
      const author = m.role === 'user' ? user.name : item.name;
      const prefix = m.highlighted ? '★ ' : '';
      const comment = m.highlighted && m.comment ? `\n   ↳ comentário: ${m.comment}` : '';
      return `[${prefix}${author}]\n${m.content}${comment}`;
    });
    const header = `Sessão · ${sessionType === 'freeplay' ? 'Simulação' : 'Neuroavaliação'}\nPersonagem: ${item.name}\nDuração: ${formatTime(elapsed)}\nTerapeuta: ${user.name}\n${score !== null ? `Nota final: ${score > 0 ? '+' : ''}${score}\n` : ''}\n---\n\n`;

    const evalSection = evaluationText
      ? `\n\n===========================\nAVALIAÇÃO DA IA\n===========================\n\n${evaluationText}`
      : '';

    const blob = new Blob([header + lines.join('\n\n---\n\n') + evalSection], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sessionType}-${item.name.replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -------- TELA PÓS-SESSÃO --------
  if (sessionEnded) {
    const highlights = messages.filter((m) => m.highlighted);

    // Tela de carregamento enquanto a IA avalia
    if (evaluating) {
      return (
        <div className="post-session">
          <div className="page-header">
            <div className="eyebrow">Sessão concluída</div>
            <h2>Avaliando sua <span className="accent">sessão</span></h2>
            <p>A IA está analisando a transcrição. Isso pode levar alguns segundos.</p>
            <div className="ornament" />
          </div>

          <div className="card evaluating-card">
            <div className="evaluating-orb">
              <div className="orb-pulse" />
              <div className="orb-pulse delay-1" />
              <div className="orb-pulse delay-2" />
              <div className="orb-core" />
            </div>
            <div className="evaluating-status">
              <div className="evaluating-line"><span className="dot active" /> Construindo transcrição da sessão</div>
              <div className="evaluating-line"><span className="dot active" /> Aplicando os 10 critérios da Allos</div>
              <div className="evaluating-line"><span className="dot pulse" /> Citando trechos e formulando análise</div>
              <div className="evaluating-line"><span className="dot" /> Calculando notas ponderadas</div>
            </div>
          </div>
        </div>
      );
    }

    // Resultado da avaliação
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>
            Avaliação da <span className="accent">sessão</span>
          </h2>
          <p>Sessão com <strong>{item?.name}</strong> · duração {formatTime(elapsed)}</p>
          <div className="ornament" />
        </div>

        {evalError && <div className="alert error">Falha ao avaliar: {evalError}</div>}

        <div className="card">
          <div className="post-session-stats">
            <div>
              <span className="post-stat-label">Duração</span>
              <span className="post-stat-value">{formatTime(elapsed)}</span>
            </div>
            <div>
              <span className="post-stat-label">Mensagens</span>
              <span className="post-stat-value">{messages.length}</span>
            </div>
            <div>
              <span className="post-stat-label">Destaques</span>
              <span className="post-stat-value">{highlights.length}</span>
            </div>
            {score !== null && (
              <div>
                <span className="post-stat-label">Nota final</span>
                <ScoreBadge score={score} size="xl" />
              </div>
            )}
          </div>

          {evaluationText && (
            <div className="post-evaluation">
              <h4>Análise da IA</h4>
              <div className="post-evaluation-body">
                {evaluationText
                  .replace(/\[CRITERIOS:[^\]]+\]\s*/g, '')
                  .replace(/\[NOTA:[^\]]+\]\s*/g, '')
                  .trim()}
              </div>
            </div>
          )}

          {highlights.length > 0 && (
            <div className="post-highlights">
              <h4>Trechos destacados pelo terapeuta</h4>
              {highlights.map((m, i) => (
                <div key={i} className="post-highlight-item">
                  <div className="post-highlight-text">{m.content}</div>
                  {m.comment && <div className="post-highlight-comment">{m.comment}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="post-session-actions">
            <button className="btn btn-outline" onClick={downloadLog}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Baixar log
            </button>
            <button className="btn btn-primary" onClick={() => navigate(sessionType === 'freeplay' ? '/freeplay' : '/neuro')}>
              Voltar à biblioteca
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  const sessionLabel = sessionType === 'freeplay' ? 'Simulação' : 'Neuroavaliação';

  return (
    <div className="chat-container echo-chat">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>

        <div className="chat-title">
          <h3>Sessão com {item?.name || '...'}</h3>
          <div className="chat-status">{sessionLabel}{sessionType === 'neuro' ? ' · diagnóstico oculto' : ''}</div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {sessionStarted && (
            <div className="timer-chip" title="Duração da sessão">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          <div className={`session-chip ${sessionStarted ? 'active' : 'idle'}`}>
            <span className="dot" />
            {sessionStarted ? 'Em sessão' : 'Aguardando início'}
          </div>
          {sessionStarted && (
            <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>
              Finalizar
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">
          {error}
          <button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem).length === 0 && !sessionStarted && (
          <div className="empty-chat" style={{ marginTop: 100 }}>
            Esta é uma simulação livre — sem nota ao final, foco na escuta e manejo.
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? user.name : `${item?.name || 'Paciente'}`;
          return (
            <div key={i}>
              <div className={`chat-message-row ${msg.role} ${msg.highlighted ? 'highlighted' : ''}`}>
                <div className="chat-message-author">
                  {msg.highlighted && <span className="star-inline">★</span>} {author}
                </div>
                <div className={`chat-message ${msg.role}`}>
                  {msg.content}
                </div>
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
                  <div className="highlight-comment">↳ {msg.comment}</div>
                )}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{item?.name || 'Paciente'}</div>
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
            <p>Ao iniciar, {item?.name} abrirá a conversa. Use o botão de destaque (★) para marcar suas próprias intervenções para revisão posterior.</p>
            <button className="btn btn-primary btn-lg" onClick={handleStartSession} disabled={!item}>
              Iniciar atendimento
            </button>
          </div>
        </div>
      ) : isTranscribing ? (
        <div className="chat-input-area transcribing">
          <div className="transcribing-indicator">
            <span className="spinner" />
            <span>Transcrevendo áudio…</span>
          </div>
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
            className={`icon-btn ${isRecording ? 'recording' : ''}`}
            onClick={toggleRecording}
            title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
            disabled={isTyping}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill={isRecording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>
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

      {/* Modal de confirmação de finalização */}
      {confirmingFinalize && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem).length;
        const empty = visibleCount === 0;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>{empty ? 'Sessão vazia' : 'Finalizar atendimento'}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18 }}>
                {empty
                  ? 'A sessão não tem mensagens ainda. Deseja finalizar mesmo assim, sem avaliação?'
                  : 'Você quer finalizar a sessão agora e iniciar a avaliação automática?'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>
                  {empty ? 'Finalizar mesmo assim' : 'Finalizar e avaliar'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal de destaque/comentário */}
      {highlightTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setHighlightTarget(null); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Destacar mensagem</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginBottom: 14 }}>
              Por que você está destacando essa intervenção? <em>(opcional)</em>
            </p>
            <textarea
              value={highlightDraft}
              onChange={(e) => setHighlightDraft(e.target.value)}
              placeholder="Ex: testei uma reformulação, paciente reagiu emocionalmente…"
              style={{ minHeight: 120 }}
              autoFocus
            />
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
