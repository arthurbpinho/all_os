import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import { buildDirectEvaluationPrompt, stripSupervisorBlock } from '../prompts';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import { makeLogItems, evalSection as evalSectionTxt } from '../logFiles';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import { useWakeLock } from '../useWakeLock';

// Sessão livre (FreePlay e Neuroavaliação) — fluxo herdado do Echos:
// 1. Iniciar Sessão (cronômetro começa, chat libera)
// 2. Conversa com personagem via /api/chat (Anthropic Sonnet 4.6, stateless)
// 3. Destaque de mensagens do terapeuta (estrela + comentário)
// 4. Finalizar → tela pós-sessão com duração e download de log

// Mensagem invisível enviada à IA quando o aluno usa o "time skip" entre sessões.
const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o paciente), acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana, você já está na sala novamente com o terapeuta.';
// Tempo mínimo da tela de transição entre sessões (ms) — é um efeito visual,
// independente do tempo real de resposta da IA.
const SKIP_MIN_DELAY_MS = 2200;

// Limite de sessões por atendimento durante o período de teste do app.
// Aplica-se apenas à Simulação (freeplay); Neuro segue sem cap.
const MAX_FREEPLAY_SESSIONS = 6;

export default function EchoSession({ user, sessionType }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Modo competitivo: só vale para freeplay (Simulação). Alimenta o MMR ao
  // finalizar. Treino mantém o comportamento de hoje (sem MMR).
  const isCompetitive = sessionType === 'freeplay' && searchParams.get('mode') === 'competitive';
  const logMode = isCompetitive ? 'competitive' : 'training';
  // Simulação Livre = freeplay em treino. Volta a rodar o avaliador (como
  // Competitivo e Neuro), porém no modelo mais barato (5.4) — o servidor escolhe
  // pelo context.mode='training' — e com aviso de que a nota é MENOS precisa que
  // a do Competitivo. Não pula mais o avaliador; isFreeSim só dirige a copy/aviso.
  const isFreeSim = sessionType === 'freeplay' && !isCompetitive;
  const isVisitor = user?.role === 'visitor';
  // Avaliação para VISITANTE é controlada pelo admin (toggle p/ palestras/eventos),
  // default off. Quando off, o visitante encerra a sessão sem avaliação. Usuário
  // real (aluno/prof/admin) sempre avalia. Carregado do servidor no mount.
  const [visitorEvalEnabled, setVisitorEvalEnabled] = useState(false);
  const skipEvaluator = isVisitor && !visitorEvalEnabled;
  // Chave de autosave separada por modo: senão uma sessão de treino e uma
  // competitiva com o MESMO personagem colidiriam (mesmo type+itemId), uma
  // restaurando a outra. O itemId real (id) continua indo pro chat e pro log.
  const autoItemId = isCompetitive ? `${id}::comp` : id;

  const [item, setItem] = useState(null);
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
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // "Time skip" entre sessões — efeito visual (não muda o lado da IA além de
  // uma mensagem invisível de contexto).
  const [sessionNumber, setSessionNumber] = useState(1);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [showSessionLimit, setShowSessionLimit] = useState(false);

  // Pós-sessão: salvamento do log + avaliação IA (avaliador v9 global).
  const [savingLog, setSavingLog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [evalScore, setEvalScore] = useState(null);
  const [mmrResult, setMmrResult] = useState(null); // resultado MMR pós-partida competitiva
  const [sidequest, setSidequest] = useState(null); // sidequest ativa (objetivo principal do Treinamento)
  const [sidequestOutcome, setSidequestOutcome] = useState(null); // resultado pós-correção (concluída?)
  const [dailyMission, setDailyMission] = useState(null); // missão diária ativa (desafio do dia)
  const [dailyMissionOutcome, setDailyMissionOutcome] = useState(null); // resultado pós-correção
  // Banners de objetivo: recolhidos por padrão pra não taparem o chat — a setinha
  // à esquerda expande/recolhe a descrição completa.
  const [sidequestOpen, setSidequestOpen] = useState(false);
  const [dailyOpen, setDailyOpen] = useState(false);

  // Feedback do visitante: popup ao encerrar a sessão (estrelas 0–5 + mensagem).
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackStars, setFeedbackStars] = useState(0);
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState(false);

  // Mantém a tela ativa enquanto a IA avalia (pode levar dezenas de segundos).
  useWakeLock(evaluating);

  // Visitante: ao encerrar a sessão, abre o popup de feedback (uma única vez).
  useEffect(() => {
    if (sessionEnded && isVisitor && !feedbackDone) setShowFeedback(true);
  }, [sessionEnded, isVisitor, feedbackDone]);

  async function submitFeedback() {
    if (feedbackSending) return;
    setFeedbackSending(true);
    try {
      await api.submitFeedback({ stars: feedbackStars, message: feedbackMessage.trim() });
      setFeedbackDone(true);
      setShowFeedback(false);
    } catch (err) {
      // Não bloqueia o visitante: se falhar, apenas fecha o popup.
      console.error('Falha ao enviar feedback:', err.message);
      setFeedbackDone(true);
      setShowFeedback(false);
    } finally {
      setFeedbackSending(false);
    }
  }

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false); // já tentou restaurar
  const finishedRef = useRef(false); // sessão finalizada — não salvar mais
  const sessionDataRef = useRef(null); // snapshot da sessão pra flush em qualquer momento
  const fileInputRef = useRef(null);

  // Limite de 30 dias para saves de sessão (alinhado à expiração de logs).
  const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  // Visitante: checa se o admin ligou a avaliação (toggle de evento). Só pra
  // visitante — usuário real sempre avalia, não precisa do fetch.
  useEffect(() => {
    if (!isVisitor) return;
    let cancelled = false;
    api.getSettings()
      .then((s) => { if (!cancelled) setVisitorEvalEnabled(!!s.visitorEvaluationEnabled); })
      .catch(() => { /* mantém off se falhar */ });
    return () => { cancelled = true; };
  }, [isVisitor]);

  // Sidequest ativa: só no Treinamento (freeplay sem competitivo) e para usuário
  // real. Quando há, ela vira o objetivo principal exibido durante o atendimento
  // e o avaliador de progressão decide se foi cumprida ao final.
  useEffect(() => {
    if (!isFreeSim || isVisitor) return;
    let cancelled = false;
    api.getMySidequest()
      .then((d) => { if (!cancelled) setSidequest(d && d.active ? d.active : null); })
      .catch(() => { /* sem sidequest se falhar */ });
    return () => { cancelled = true; };
  }, [isFreeSim, isVisitor]);

  // Missão diária (desafio do dia): objetivo adicional do Treinamento, mostrado
  // durante o atendimento se ainda não foi cumprido hoje. Avaliada ao final.
  useEffect(() => {
    if (!isFreeSim || isVisitor) return;
    let cancelled = false;
    api.getMyDailyMission()
      .then((d) => { if (!cancelled) setDailyMission(d && d.mission && !d.completed ? d.mission : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isFreeSim, isVisitor]);

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
          const saved = await loadActiveSession(user.id, sessionType, autoItemId);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
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

    const data = { messages, elapsedSeconds: elapsed, itemTitle: item.name, sessionNumber };
    sessionDataRef.current = data;
    saveLocal(user.id, sessionType, autoItemId, data);

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      // Mesmo race do ChatSession: usuário finaliza no meio do debounce, o
      // DELETE de clearActiveSession roda, e o PUT chega depois ressuscitando
      // a sessão. Bloqueamos checando finishedRef no momento do disparo.
      if (finishedRef.current) return;
      api.saveActiveSession(sessionType, autoItemId, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, sessionNumber, user?.id, autoItemId, sessionType]);

  // Flush: ao trocar de rota, fechar a aba, ou ir pra background.
  // localStorage sempre, servidor best-effort. Visitantes não persistem.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !user?.id) return;
    if (user.role === 'visitor') return;

    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, sessionType, autoItemId, data);
      api.saveActiveSession(sessionType, autoItemId, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush(); // unmount também é "saída"
    };
  }, [sessionStarted, sessionEnded, user?.id, autoItemId, sessionType]);

  // Cronômetro
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
  }, [messages, isTyping]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function handleStartSession() {
    if (!item) return;
    setError('');
    try {
      setSessionStarted(true);

      // Disparo: o paciente fala primeiro. Mandamos "Iniciar" oculto pra IA
      // gerar a abertura do atendimento (que costuma ser a abertura fixa do prompt).
      const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true, highlighted: false, comment: '' };
      setMessages([kickoffMsg]);
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
    } catch (err) {
      setError('Erro ao iniciar atendimento: ' + err.message);
    }
  }

  async function sendToAI(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role) // markers visuais (separadores de sessão) não têm role
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: sessionType, itemId: id });
    return typeof data === 'string' ? data : data.content || data.message || '';
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

  function handleSkipSession() {
    if (!sessionStarted || sessionEnded || isTyping || skipping || limitReached) return;
    if (sessionType === 'freeplay' && sessionNumber >= MAX_FREEPLAY_SESSIONS) {
      setShowSessionLimit(true);
      return;
    }
    setConfirmingSkip(true);
  }

  async function doSkipSession() {
    setConfirmingSkip(false);
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;

    // Functional update + log de diagnóstico — se você ainda ver o chip stuck
    // no #1 depois do rebuild, abra o devtools e veja se este log aparece com
    // o valor correto. Se aparecer mas a UI não atualiza, problema é de render.
    let newNumber;
    setSessionNumber((prev) => {
      newNumber = prev + 1;
      console.log('[skip] sessionNumber:', prev, '→', newNumber);
      return newNumber;
    });
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

  // Reinicia a simulação do zero: descarta a conversa, zera cronômetro e número
  // de sessão, e volta à tela de início. Confirmação acontece no modal.
  function doReset() {
    setConfirmingReset(false);
    // Bloqueia autosave/flush durante o reset pra não ressuscitar a sessão zumbi.
    finishedRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    sessionDataRef.current = null;
    clearActiveSession(user.id, sessionType, autoItemId);
    setMessages([]);
    setInput('');
    setElapsed(0);
    setSessionNumber(1);
    setSessionStarted(false);
    setError('');
    setTimeout(() => { finishedRef.current = false; }, 0);
  }

  // Baixa um "save" portátil da sessão em andamento (JSON), para retomar depois.
  function downloadSave() {
    const save = {
      allosSave: true,
      version: 1,
      type: sessionType,
      itemId: String(id),
      itemTitle: item?.name || '',
      messages,
      elapsedSeconds: elapsed,
      sessionNumber,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const label = sessionType === 'freeplay' ? 'simulacao' : 'neuro';
    a.href = url;
    a.download = `allos-save-${label}-${(item?.name || 'sessao').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Carrega um save (.json) e retoma a sessão. Valida formato, vínculo com este
  // personagem e o limite de 30 dias.
  function handleLoadSaveFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const save = JSON.parse(reader.result);
        if (!save || save.allosSave !== true || !Array.isArray(save.messages)) {
          throw new Error('Arquivo de save inválido.');
        }
        if (save.type !== sessionType || String(save.itemId) !== String(id)) {
          throw new Error('Este save é de outro personagem. Abra o personagem correspondente para carregá-lo.');
        }
        const savedAt = new Date(save.savedAt || 0).getTime();
        if (Number.isFinite(savedAt) && savedAt > 0 && Date.now() - savedAt > SAVE_TTL_MS) {
          throw new Error('Este save expirou — saves de sessão valem por 30 dias.');
        }
        finishedRef.current = false;
        setMessages(save.messages);
        setElapsed(Number.isFinite(save.elapsedSeconds) ? save.elapsedSeconds : 0);
        if (Number.isFinite(save.sessionNumber) && save.sessionNumber >= 1) {
          setSessionNumber(save.sessionNumber);
        }
        setSessionStarted(true);
        setError('');
      } catch (err) {
        setError(err.message || 'Não foi possível carregar o save.');
      }
    };
    reader.readAsText(file);
  }

  // Builders de texto pro <LogActions> (copiar/baixar log / avaliação / tudo).
  // O aluno nunca recebe o bloco [notas-supervisor]. Todas as sessões (inclusive
  // a Simulação Livre) têm avaliação, então "Avaliação" fica disponível quando há.
  //
  // Header MINIMAL por decisão de produto: log limpo só com Terapeuta + Caso +
  // transcrição. A nota numérica vive APENAS na seção de avaliação (não no
  // header), pra que o log cru fique livre de score quando exportado isolado.
  function buildLogHeader() {
    return [
      `Terapeuta: ${user?.name || '—'}`,
      `Caso: ${item?.name || '—'}`,
    ].join('\n');
  }
  function buildTranscript() {
    return messages.filter((m) => !m.isSystem).map((m) => {
      const author = m.role === 'user' ? (user?.name || 'Terapeuta') : (item?.name || 'Paciente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');
  }
  // Texto da avaliação prefixado pela nota geral (única menção da nota num log
  // exportado). Limpo do bloco [notas-supervisor] que é só pra backend.
  function buildEvaluationBody() {
    const clean = stripSupervisorBlock(evaluationText);
    const score = evalScore !== null ? `Nota final: ${evalScore}\n\n` : '';
    return `${score}${clean}`;
  }
  const logText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}`;
  const evalText = () => `${buildLogHeader()}${evalSectionTxt(buildEvaluationBody())}`.trimEnd();
  const bothText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}${evalSectionTxt(buildEvaluationBody())}`;

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
      clearActiveSession(user.id, sessionType, autoItemId);
      return;
    }

    if (timerRef.current) clearInterval(timerRef.current);
    setSessionEnded(true);
    setSavingLog(true);
    if (!skipEvaluator) setEvaluating(true);
    setSaveError('');
    setEvalError('');

    // 1. Avaliador roda em quase todas as sessões (Simulação Livre, Competitivo e
    //    Neuro). ÚNICA exceção: VISITANTE quando o admin não ligou a avaliação
    //    (skipEvaluator) — encerra salvando só o log. FreePlay/Neuro nunca têm
    //    evaluatorPrompt customizado, então não passamos `context` de exercício —
    //    o servidor usa o avaliador global (v15). O `mode` diz ao servidor qual
    //    modelo usar: 'training' (Simulação Livre) → 5.4 barato; 'competitive' → 5.5.
    let evalContent = '';
    let totalScore = null;
    if (!skipEvaluator) {
      // Monta a transcrição que vai pro avaliador (mesma forma do downloadLog,
      // pra que o avaliador veja exatamente o que o aluno destacou).
      const transcriptText = visibleMessages.map((m) => {
        const author = m.role === 'user' ? user.name : (item?.name || 'Paciente');
        const star = m.highlighted ? ' ★' : '';
        const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
        return `[${author}${star}]\n${m.content}${comment}`;
      }).join('\n\n---\n\n');
      const sessionLabel = sessionType === 'freeplay' ? 'Treinamento' : 'Neuroavaliação';
      try {
        const evalMsg = {
          role: 'user',
          content: buildDirectEvaluationPrompt(sessionLabel, item?.name || '—', transcriptText),
        };
        // context permite o servidor injetar o Bloco 1 (gabarito) do personagem
        // antes do log, server-side — sem expor o gabarito ao cliente.
        const reply = await api.evaluate([evalMsg], { type: sessionType, itemId: id, mode: logMode });
        evalContent = typeof reply === 'string' ? reply : reply.content || '';
        // A nota final NÃO vem mais do texto da IA — o backend a calcula em código
        // a partir do bloco [notas-supervisor] (server/scoring.js) e devolve no
        // save (saved.score). Mantemos um parse de fallback só para avaliadores
        // antigos que ainda escreviam **Nota: X/100** ou [NOTA:X].
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
    }

    // 2. Salva o log no histórico já com score + texto da avaliação.
    //    Em modo competitivo o servidor atualiza o MMR e devolve o resultado.
    try {
      const saved = await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: sessionType,
        mode: logMode,
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
      // A nota exibida é a calculada em código no backend (saved.score), não a
      // parseada do texto. Só faz override se o backend devolveu nota numérica.
      if (saved && Number.isFinite(saved.score)) setEvalScore(saved.score);
      if (saved && saved.mmr) setMmrResult(saved.mmr);
      // Resultado da sidequest (Treinamento): concluída → celebração + título.
      if (saved && saved.sidequest) setSidequestOutcome(saved.sidequest);
      // Resultado da missão diária (desafio do dia): mesma celebração.
      if (saved && saved.dailyMission) setDailyMissionOutcome(saved.dailyMission);
    } catch (err) {
      setSaveError(err.message || 'Erro ao salvar o log.');
    } finally {
      setSavingLog(false);
    }

    // Sessão finalizada — limpa o autosave ativo
    clearActiveSession(user.id, sessionType, autoItemId);
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
            {skipEvaluator
              ? <>Sessão <span className="accent">concluída</span></>
              : <>Avaliação da sua <span className="accent">sessão</span></>}
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

          {sidequestOutcome && (
            <div className={`sidequest-result ${sidequestOutcome.completed ? 'completed' : 'incomplete'}`}>
              {sidequestOutcome.completed ? (
                <>
                  <div className="sidequest-result-badge">✦ Sidequest concluída</div>
                  <h4>{sidequestOutcome.title}</h4>
                  <p>
                    Você desbloqueou o título <strong>{sidequestOutcome.rewardTitleLabel}</strong>.
                    Escolha-o como seu subtítulo no <strong>Perfil</strong>.
                  </p>
                </>
              ) : (
                <>
                  <div className="sidequest-result-badge incomplete">Sidequest ainda não concluída</div>
                  <h4>{sidequestOutcome.title}</h4>
                  {sidequestOutcome.reason && (
                    <p className="sidequest-result-reason">{sidequestOutcome.reason}</p>
                  )}
                  <p>A missão continua ativa. Releia o objetivo e tente novamente no próximo atendimento.</p>
                </>
              )}
            </div>
          )}

          {dailyMissionOutcome && (
            <div className={`sidequest-result daily ${dailyMissionOutcome.completed ? 'completed' : 'incomplete'}`}>
              {dailyMissionOutcome.completed ? (
                <>
                  <div className="sidequest-result-badge">◷ Missão diária concluída</div>
                  <h4>{dailyMissionOutcome.title}</h4>
                  <p>
                    Você cumpriu o desafio do dia e desbloqueou o título{' '}
                    <strong>{dailyMissionOutcome.rewardTitleLabel}</strong>.
                  </p>
                </>
              ) : (
                <>
                  <div className="sidequest-result-badge incomplete">Missão diária não concluída</div>
                  <h4>{dailyMissionOutcome.title}</h4>
                  {dailyMissionOutcome.reason && (
                    <p className="sidequest-result-reason">{dailyMissionOutcome.reason}</p>
                  )}
                  <p>O desafio de hoje continua valendo. Tente de novo em outro atendimento ainda hoje.</p>
                </>
              )}
            </div>
          )}

          {isCompetitive && (
            <div className="mmr-result-card">
              {mmrResult ? (
                mmrResult.calibrating ? (
                  <>
                    <span className="post-stat-label">MMR · Em calibração</span>
                    <p className="mmr-result-note">
                      Partida {mmrResult.n} de 3 da calibração — seu MMR aparece após a 3ª.
                      {mmrResult.matchesRemaining > 0 && (
                        <> Faltam <strong>{mmrResult.matchesRemaining}</strong> {mmrResult.matchesRemaining === 1 ? 'partida' : 'partidas'}.</>
                      )}
                    </p>
                  </>
                ) : (
                  <>
                    <span className="post-stat-label">Seu MMR</span>
                    <div className="mmr-result-value">
                      {Math.round(mmrResult.P_after)}
                      <span className={`mmr-delta ${mmrResult.delta >= 0 ? 'up' : 'down'}`}>
                        {mmrResult.delta >= 0 ? '▲' : '▼'} {Math.abs(mmrResult.delta).toFixed(1)}
                      </span>
                    </div>
                    <p className="mmr-result-note">
                      Dificuldade de {item?.name} agora: <strong>{Math.round(mmrResult.D_after)}</strong>
                    </p>
                  </>
                )
              ) : (
                <p className="mmr-result-note">
                  O MMR não foi atualizado — a sessão não recebeu uma nota numérica do avaliador.
                </p>
              )}
            </div>
          )}

          {isFreeSim && !isVisitor && (
            <div className="alert" style={{ marginBottom: 16, borderLeft: '3px solid var(--warning, #d99100)' }}>
              <strong>Treinamento.</strong> Este é o espaço de prática e progressão: ao
              reatender o mesmo paciente, a avaliação compara sua evolução com o
              atendimento anterior. A nota de um primeiro atendimento isolado é menos
              precisa que a do modo <strong>Competitivo</strong>.
            </div>
          )}

          {evaluationText && (
            <div className="post-evaluation">
              <h4>Análise da IA</h4>
              <div className="post-evaluation-body">
                {evaluationText
                  .replace(/\[CRITERIOS:[^\]]+\]\s*/g, '')
                  .replace(/\[NOTA:[^\]]+\]\s*/g, '')
                  .replace(/\*\*\s*Nota:\s*\d{1,3}\s*\/\s*100\s*\*\*\s*/i, '')
                  // [sidequest-resultado] / [missao-diaria-resultado] (JSON de
                  // conclusão) são só pro sistema/supervisor.
                  .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[sidequest-resultado\][\s\S]*$/i, '')
                  .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[missao-diaria-resultado\][\s\S]*$/i, '')
                  // v15: bloco [notas-supervisor] (Base64) é só pro supervisor —
                  // some da visão do aluno, mas continua salvo no log.
                  .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[notas-supervisor\][\s\S]*$/i, '')
                  .trim()}
              </div>
            </div>
          )}

          {visibleMessages.length > 0 && (() => {
            const hasEval = !!stripSupervisorBlock(evaluationText).trim();
            return (
              <div style={{ marginTop: 14 }}>
                <LogActions
                  items={makeLogItems({
                    baseName: item?.name || 'sessao',
                    getLog: logText,
                    getEval: hasEval ? evalText : null,
                    getBoth: hasEval ? bothText : null,
                  })}
                />
              </div>
            );
          })()}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate(isCompetitive ? '/competitivo' : (sessionType === 'freeplay' ? '/freeplay' : '/neuro'))}>
              Voltar à biblioteca
            </button>
          </div>
        </div>

        {showFeedback && (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) { setFeedbackDone(true); setShowFeedback(false); } }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>Gostou da plataforma?</h3>
              <p style={{ color: 'var(--ink-soft)', marginTop: -8, marginBottom: 18 }}>
                Gostou da plataforma e quer continuar tendo acesso? Deixe seu comentário!
              </p>

              <div className="feedback-stars" role="group" aria-label="Avaliação de 0 a 5 estrelas">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`feedback-star ${n <= feedbackStars ? 'on' : ''}`}
                    aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
                    aria-pressed={n <= feedbackStars}
                    onClick={() => setFeedbackStars(n === feedbackStars ? 0 : n)}
                  >
                    {n <= feedbackStars ? '★' : '☆'}
                  </button>
                ))}
              </div>

              <textarea
                className="feedback-message"
                rows={4}
                value={feedbackMessage}
                onChange={(e) => setFeedbackMessage(e.target.value)}
                placeholder="Deixe sua mensagem (opcional)…"
                maxLength={2000}
              />

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setFeedbackDone(true); setShowFeedback(false); }}
                  disabled={feedbackSending}
                >
                  Agora não
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={submitFeedback}
                  disabled={feedbackSending || (!feedbackStars && !feedbackMessage.trim())}
                >
                  {feedbackSending ? 'Enviando…' : 'Enviar feedback'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  const sessionLabel = isCompetitive
    ? 'Competitivo'
    : (sessionType === 'freeplay' ? 'Treinamento' : 'Neuroavaliação');
  // Diagnóstico temporário: deve logar a cada render com o sessionNumber atual.
  // Depois de clicar "passar sessão", o próximo render aqui deve mostrar #2.
  if (sessionStarted) console.log('[render] sessionNumber =', sessionNumber);

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
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
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
              {messages.filter((m) => !m.isSystem).length > 0 && (
                <button
                  className="btn btn-outline btn-sm"
                  onClick={downloadSave}
                  disabled={isTyping || skipping}
                  title="Baixar save desta sessão (.json) para retomar depois"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
                  Save
                </button>
              )}
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmingReset(true)}
                disabled={isTyping || skipping}
                title="Reiniciar a simulação do zero"
                style={{ color: 'var(--terra)', borderColor: 'var(--terra)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" /></svg>
                Reiniciar
              </button>
              <button
                className="btn btn-sm"
                onClick={handleSkipSession}
                disabled={isTyping || skipping}
                title="Avançar para a próxima sessão (time skip)"
                style={{ background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}
              >
                Próxima sessão →
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>
                {skipEvaluator ? 'Encerrar sessão' : 'Enviar para correção'}
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

      {sidequest && (
        <div className={`sidequest-banner ${sidequestOpen ? 'open' : 'collapsed'}`}>
          <button
            type="button"
            className="sidequest-banner-head"
            onClick={() => setSidequestOpen((o) => !o)}
            aria-expanded={sidequestOpen}
            title={sidequestOpen ? 'Recolher objetivo' : 'Ver objetivo completo'}
          >
            <svg className="sidequest-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
            <span className="sidequest-banner-headtext">
              <span className="sidequest-banner-label">✦ Sidequest ativa · objetivo principal</span>
              <span className="sidequest-banner-title">{sidequest.title}</span>
            </span>
          </button>
          {sidequestOpen && <div className="sidequest-banner-desc">{sidequest.description}</div>}
        </div>
      )}

      {dailyMission && (
        <div className={`sidequest-banner daily-mission-banner ${dailyOpen ? 'open' : 'collapsed'}`}>
          <button
            type="button"
            className="sidequest-banner-head"
            onClick={() => setDailyOpen((o) => !o)}
            aria-expanded={dailyOpen}
            title={dailyOpen ? 'Recolher missão' : 'Ver missão completa'}
          >
            <svg className="sidequest-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>
            <span className="sidequest-banner-headtext">
              <span className="sidequest-banner-label">◷ Missão diária · desafio do dia</span>
              <span className="sidequest-banner-title">{dailyMission.title}</span>
            </span>
          </button>
          {dailyOpen && <div className="sidequest-banner-desc">{dailyMission.description}</div>}
        </div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem).length === 0 && !sessionStarted && (
          <div className="empty-chat" style={{ marginTop: 100 }}>
            {isCompetitive
              ? 'Modo competitivo — esta sessão é avaliada e vale ranking (MMR) ao final.'
              : (sessionType === 'freeplay'
                ? (isVisitor
                    ? (skipEvaluator
                        ? 'Treinamento — sessão de demonstração, sem avaliação ao final.'
                        : 'Treinamento — você recebe uma avaliação da IA ao final (demonstração).')
                    : (sidequest
                        ? 'Treinamento com sidequest ativa — o objetivo principal é a missão acima; a avaliação verifica se você a cumpriu.'
                        : 'Treinamento — recebe avaliação e nota ao final. Ao reatender o mesmo paciente, sua evolução é comparada com o atendimento anterior.'))
                : 'Neuroavaliação — avaliação ao final, foco no raciocínio diagnóstico.')}
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
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-lg" onClick={handleStartSession} disabled={!item}>
                Iniciar atendimento
              </button>
              <button className="btn btn-outline btn-lg" onClick={() => fileInputRef.current?.click()} disabled={!item} title="Retomar a partir de um arquivo de save (.json)">
                Carregar save
              </button>
            </div>
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleLoadSaveFile} style={{ display: 'none' }} />
          </div>
        </div>
      ) : isTranscribing ? (
        <div className="chat-input-area transcribing">
          <div className="transcribing-indicator">
            <span className="spinner" />
            <span>Transcrevendo áudio…</span>
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
        const title = empty ? 'Sessão vazia' : (skipEvaluator ? 'Encerrar sessão' : 'Enviar para correção');
        const bodyText = empty
          ? `A sessão não tem mensagens ainda. Deseja ${skipEvaluator ? 'encerrar' : 'enviar para correção'} mesmo assim?`
          : (skipEvaluator
            ? 'Tem certeza que deseja encerrar? Esta sessão não terá avaliação nem nota. (A avaliação para visitantes está desligada.)'
            : isFreeSim
            ? (sidequest
                ? 'Tem certeza? Esta é uma sessão de Treinamento com sidequest ativa — a avaliação vai verificar se você cumpriu a missão. O log será salvo e você não poderá continuar este atendimento depois.'
                : 'Tem certeza? Esta é uma sessão de Treinamento: ela recebe avaliação e nota, e ao reatender o mesmo paciente sua evolução será comparada. O log será salvo no seu histórico e você não poderá continuar este atendimento depois.')
            : 'VOCÊ TEM CERTEZA QUE DESEJA ENVIAR PARA CORREÇÃO? VOCÊ NUNCA MAIS CONSEGUIRÁ FAZER MAIS SESSÕES NESSE ATENDIMENTO. O PACIENTE SERÁ RESETADO E AS SESSÕES ATUAIS ENVIADAS PARA A CORREÇÃO.');
        const confirmLabel = empty
          ? (skipEvaluator ? 'Encerrar mesmo assim' : 'Enviar mesmo assim')
          : (skipEvaluator ? 'Encerrar sessão' : 'Enviar para correção');
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 500 }}>
              <h3>{title}</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
                {bodyText}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>
                  {confirmLabel}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal de confirmação de reinício */}
      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar simulação</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              Tem certeza que deseja reiniciar? Toda a conversa atual, o tempo decorrido e o número da sessão serão <strong>perdidos</strong> e você voltará à tela de início. Esta ação não pode ser desfeita.
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

      {/* Modal de limite de sessões (período de teste) */}
      {showSessionLimit && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSessionLimit(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Limite de sessões atingido</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              No momento, como estamos em período de teste do aplicativo, você só tem direito a fazer 6 sessões. Por favor faça o encerramento em no máximo 3 mensagens e envie o caso para correção.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowSessionLimit(false)}>
                Entendi
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
