import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import { buildDirectEvaluationPrompt } from '../prompts';
import ScoreBadge from '../components/ScoreBadge';

// Sessão livre (FreePlay e Neuroavaliação) — fluxo herdado do Echos:
// 1. Iniciar Sessão (cronômetro começa, chat libera)
// 2. Conversa com personagem (Assistants API se houver assistant_id, senão chat completion)
// 3. Destaque de mensagens do terapeuta (estrela + comentário)
// 4. Finalizar → tela pós-sessão com duração e download de log

// Mensagem invisível enviada à IA quando o aluno usa o "time skip" entre sessões.
const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o paciente), acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana, você já está na sala novamente com o terapeuta.';
// Tempo mínimo da tela de transição entre sessões (ms) — é um efeito visual,
// independente do tempo real de resposta da IA.
const SKIP_MIN_DELAY_MS = 2200;

export default function EchoSession({ user, sessionType }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
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

  // "Time skip" entre sessões — efeito visual (não muda o lado da IA além de
  // uma mensagem invisível de contexto).
  const [sessionNumber, setSessionNumber] = useState(1);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // Pós-sessão: salvamento do log + avaliação IA (avaliador v9 global).
  const [savingLog, setSavingLog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [evalScore, setEvalScore] = useState(null);

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false); // já tentou restaurar
  const finishedRef = useRef(false); // sessão finalizada — não salvar mais
  const sessionDataRef = useRef(null); // snapshot da sessão pra flush em qualquer momento

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
        // System prompt resolvido no servidor (a partir de context: { type, itemId }).
        // O cliente nunca recebe specificInstruction.

        // Restaura sessão pendente (se houver). Visitantes nunca persistem.
        if (!restoredRef.current && user?.id && user.role !== 'visitor') {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, sessionType, id);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
            if (saved.threadId) setThreadId(saved.threadId);
            if (Number.isFinite(saved.sessionNumber) && saved.sessionNumber >= 1) {
              setSessionNumber(saved.sessionNumber);
            }
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

  // Autosave: localStorage síncrono em cada mudança + servidor com debounce 1.5s.
  // Por que síncrono no localStorage: se o usuário sair em < 3s (caso comum logo
  // após Iniciar), o debounce do servidor é cancelado mas o localStorage já tem.
  // Visitantes não persistem nada.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !item || !user?.id) return;
    if (finishedRef.current) return;
    if (user.role === 'visitor') return;

    const data = { messages, elapsedSeconds: elapsed, threadId, itemTitle: item.name, sessionNumber };
    sessionDataRef.current = data;
    saveLocal(user.id, sessionType, id, data);

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      // Mesmo race do ChatSession: usuário finaliza no meio do debounce, o
      // DELETE de clearActiveSession roda, e o PUT chega depois ressuscitando
      // a sessão. Bloqueamos checando finishedRef no momento do disparo.
      if (finishedRef.current) return;
      api.saveActiveSession(sessionType, id, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, threadId, sessionNumber, user?.id, id, sessionType]);

  // Flush: ao trocar de rota, fechar a aba, ou ir pra background.
  // localStorage sempre, servidor best-effort. Visitantes não persistem.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !user?.id) return;
    if (user.role === 'visitor') return;

    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, sessionType, id, data);
      api.saveActiveSession(sessionType, id, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush(); // unmount também é "saída"
    };
  }, [sessionStarted, sessionEnded, user?.id, id, sessionType]);

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
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role) // markers visuais (separadores de sessão) não têm role
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: sessionType, itemId: id });
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

  function handleSkipSession() {
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;
    setConfirmingSkip(true);
  }

  async function doSkipSession() {
    setConfirmingSkip(false);
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;

    const newNumber = sessionNumber + 1;
    setSessionNumber(newNumber);
    setSkipping(true);

    // Marker visual (sem role) + mensagem oculta para a IA (com role:'user' + isSystem)
    const breakMarker = { type: 'session-break', sessionNumber: newNumber, stage: 'transitioning' };
    const hiddenSkip = { role: 'user', content: SKIP_PROMPT, isSystem: true, highlighted: false, comment: '' };
    const messagesBeforeSend = [...messages, breakMarker, hiddenSkip];
    setMessages(messagesBeforeSend);
    setIsTyping(true);

    const minDelay = new Promise((r) => setTimeout(r, SKIP_MIN_DELAY_MS));
    try {
      // Envia via mesmo canal das mensagens normais. Para Assistants API, só
      // 'text' vai pro thread; para chat completion, mandamos o histórico anterior
      // (sem o marker e sem a hiddenSkip — sendToAI já usa apenas 'messages' anterior).
      const [reply] = await Promise.all([sendToAI(SKIP_PROMPT, messages), minDelay]);
      const flipMarker = (m) =>
        m && m.type === 'session-break' && m.sessionNumber === newNumber
          ? { ...m, stage: 'arrived' }
          : m;
      setMessages((prev) => prev.map(flipMarker).concat({ role: 'assistant', content: reply }));
    } catch (err) {
      const flipMarker = (m) =>
        m && m.type === 'session-break' && m.sessionNumber === newNumber
          ? { ...m, stage: 'arrived' }
          : m;
      setMessages((prev) =>
        prev.map(flipMarker).concat({ role: 'assistant', content: `Erro ao retomar a sessão: ${err.message}` })
      );
    } finally {
      setIsTyping(false);
      setSkipping(false);
      textareaRef.current?.focus();
    }
  }

  function buildTranscript() {
    return messages
      .filter((m) => !m.isSystem)
      .map((m) => {
        const author = m.role === 'user' ? user.name : item.name;
        const star = m.highlighted ? ' ★' : '';
        const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
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
    finishedRef.current = true; // bloqueia autosave/flush a partir daqui
    const visibleMessages = messages.filter((m) => !m.isSystem);
    if (visibleMessages.length === 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      setSessionEnded(true);
      clearActiveSession(user.id, sessionType, id);
      return;
    }

    if (timerRef.current) clearInterval(timerRef.current);
    setSessionEnded(true);
    setSavingLog(true);
    setEvaluating(true);
    setSaveError('');
    setEvalError('');

    // Monta a transcrição que vai pro avaliador (mesma forma do downloadLog,
    // pra que o avaliador veja exatamente o que o aluno destacou).
    const transcriptText = visibleMessages.map((m) => {
      const author = m.role === 'user' ? user.name : (item?.name || 'Paciente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');

    const sessionLabel = sessionType === 'freeplay' ? 'Simulação' : 'Neuroavaliação';

    // 1. Roda o avaliador global (v9). FreePlay/Neuro nunca têm evaluatorPrompt
    //    customizado por personagem, então não passamos `context` — o servidor
    //    usa o avaliador global.
    let evalContent = '';
    let totalScore = null;
    try {
      const evalMsg = {
        role: 'user',
        content: buildDirectEvaluationPrompt(sessionLabel, item?.name || '—', transcriptText),
      };
      // context permite o servidor injetar o Bloco 1 (gabarito) do personagem
      // antes do log, server-side — sem expor o gabarito ao cliente.
      const reply = await api.evaluate([evalMsg], { type: sessionType, itemId: id });
      evalContent = typeof reply === 'string' ? reply : reply.content || '';
      const v9 = evalContent.match(/\*\*\s*Nota:\s*(\d{1,3})\s*\/\s*100\s*\*\*/i);
      if (v9) {
        totalScore = Number(v9[1]);
      } else {
        const m = evalContent.match(/\[NOTA:\s*([-+]?\d+(?:[.,]\d+)?)\s*\]/i);
        if (m) totalScore = Number(m[1].replace(',', '.'));
      }
      if (totalScore !== null && Number.isFinite(totalScore)) {
        totalScore = Math.round(totalScore);
      } else {
        totalScore = null;
      }
      setEvaluationText(evalContent);
      setEvalScore(totalScore);
    } catch (err) {
      setEvalError(err.message || 'Erro ao avaliar a sessão.');
    } finally {
      setEvaluating(false);
    }

    // 2. Salva o log no histórico já com score + texto da avaliação.
    try {
      await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: sessionType,
        itemId: id,
        itemTitle: item.name,
        messages: visibleMessages.map((m) => ({
          role: m.role,
          content: m.content,
          highlighted: m.highlighted || false,
          comment: m.comment || '',
        })),
        durationSeconds: elapsed,
        score: totalScore,
        evaluation: evalContent,
      });
    } catch (err) {
      setSaveError(err.message || 'Erro ao salvar o log.');
    } finally {
      setSavingLog(false);
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

  // -------- TELA DE LOADING (avaliando) --------
  // Mostrada enquanto o avaliador roda. O log não fica visível ao terapeuta
  // durante esse momento — só a animação e o status.
  if (sessionEnded && evaluating) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>Avaliando sua <span className="accent">sessão</span></h2>
          <p>A IA está analisando o atendimento com {item?.name}. Pode levar alguns segundos.</p>
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
            <div className="evaluating-line"><span className="dot active" /> Aplicando os 6 critérios da Allos</div>
            <div className="evaluating-line"><span className="dot pulse" /> Citando trechos e formulando análise</div>
            <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA PÓS-SESSÃO --------
  // Terapeuta vê apenas a avaliação — o log completo é destinado ao supervisor
  // (acessível via /supervisor). Mensagens cruas, destaques e download do log
  // não aparecem aqui.
  if (sessionEnded) {
    const visibleMessages = messages.filter((m) => !m.isSystem);

    // Mensagem de envio: para alunos com professor vinculado, indica destino;
    // para outros perfis (admin, professor, visitante), mostra histórico apenas.
    const teacherName = user?.teacherName;
    const isVisitor = user?.role === 'visitor';
    let sentMessage;
    if (isVisitor) {
      sentMessage = 'Você está em modo visitante — o log desta sessão não foi salvo.';
    } else if (teacherName) {
      sentMessage = `O log completo desta sessão foi enviado para o professor ${teacherName}.`;
    } else {
      sentMessage = 'O log completo foi salvo no seu histórico de supervisão.';
    }

    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>
            Avaliação da sua <span className="accent">sessão</span>
          </h2>
          <p>Sessão com <strong>{item?.name}</strong> · duração {formatTime(elapsed)}</p>
          <div className="ornament" />
        </div>

        {saveError && <div className="alert error">Falha ao salvar log: {saveError}</div>}
        {evalError && <div className="alert error">Falha na avaliação: {evalError}</div>}

        <div className="card">
          {savingLog ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--ink-soft)' }}>
              <span className="spinner" />{' '}
              <span style={{ marginLeft: 12 }}>Salvando log…</span>
            </div>
          ) : (
            <div className="alert" style={{ marginBottom: 16 }}>
              {sentMessage}
            </div>
          )}

          <div className="post-session-stats">
            <div>
              <span className="post-stat-label">Duração</span>
              <span className="post-stat-value">{formatTime(elapsed)}</span>
            </div>
            <div>
              <span className="post-stat-label">Mensagens</span>
              <span className="post-stat-value">{visibleMessages.length}</span>
            </div>
            {evalScore !== null && (
              <div>
                <span className="post-stat-label">Nota final</span>
                <ScoreBadge score={evalScore} size="xl" />
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
                  .replace(/\*\*\s*Nota:\s*\d{1,3}\s*\/\s*100\s*\*\*\s*/i, '')
                  .trim()}
              </div>
            </div>
          )}

          <div className="post-session-actions">
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
          <div className="chat-status">
            {sessionLabel}{sessionType === 'neuro' ? ' · diagnóstico oculto' : ''}
            {sessionStarted && <> · <strong>Sessão #{sessionNumber}</strong></>}
          </div>
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
            {sessionStarted ? `Sessão #${sessionNumber}` : 'Aguardando início'}
          </div>
          {sessionStarted && (
            <>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleSkipSession}
                disabled={isTyping || skipping}
                title="Avançar para a próxima sessão (time skip)"
              >
                Próxima sessão →
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>
                Finalizar
              </button>
            </>
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
                  <div className="highlight-comment">{`{${msg.comment}}`}</div>
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
                  ? 'A sessão não tem mensagens ainda. Deseja finalizar mesmo assim?'
                  : 'Você quer finalizar a sessão agora? O log será salvo no seu histórico e enviado ao seu professor vinculado.'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>
                  {empty ? 'Finalizar mesmo assim' : 'Finalizar sessão'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal de confirmação de "time skip" entre sessões */}
      {confirmingSkip && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingSkip(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Avançar para a próxima sessão</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18 }}>
              Tem certeza que deseja ir para a próxima sessão? Lembre-se de fazer um encerramento primeiro com seu paciente — essa função é um <em>time skip</em>.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingSkip(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doSkipSession}>
                Passar para a próxima sessão
              </button>
            </div>
          </div>
        </div>
      )}

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
