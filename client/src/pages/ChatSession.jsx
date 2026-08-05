import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { cleanEvaluationForStudent } from '../prompts';
import { PatientAvatarButton } from '../components/PatientAvatar';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';
import { makeLogItems, evalSection as evalSectionTxt, downloadText } from '../logFiles';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import { useWakeLock } from '../useWakeLock';

const PHASE_SIMULATION = 'simulation';
const PHASE_EVALUATING = 'evaluating';
const PHASE_CONCLUDED  = 'concluded';

const DIFFICULTY_LABEL = {
  iniciante: 'Iniciante',
  intermediario: 'Intermediário',
  avancado: 'Avançado',
};

export default function ChatSession({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
  const [skillsById, setSkillsById] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState(PHASE_SIMULATION);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showSaveLoad, setShowSaveLoad] = useState(false);
  const [error, setError] = useState('');
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [score, setScore] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [imageSchema, setImageSchema] = useState(null);
  const [imageSchemaError, setImageSchemaError] = useState('');
  const [imageSchemaUrl, setImageSchemaUrl] = useState(null);

  // O SVG do esquema visual é renderizado via <img src="blob:..."> — nunca
  // injetado no DOM (dangerouslySetInnerHTML): SVG carregado em contexto de
  // imagem não executa <script>/eventos, mesmo vindo de uma IA cuja entrada
  // inclui texto do aluno (não confiável). Blob URL evita o problema de
  // codificar unicode em base64 (btoa não lida bem com acentos).
  useEffect(() => {
    if (!imageSchema) { setImageSchemaUrl(null); return; }
    const url = URL.createObjectURL(new Blob([imageSchema], { type: 'image/svg+xml' }));
    setImageSchemaUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageSchema]);

  // Mantém a tela ativa enquanto a IA avalia (pode levar dezenas de segundos).
  useWakeLock(phase === PHASE_EVALUATING);

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false);
  const finishedRef = useRef(false);
  const sessionDataRef = useRef(null);
  const fileInputRef = useRef(null);
  // Custo dos Logs da Trilha (admin): acumula o usage de CADA turno do chat
  // com o personagem (soma ao longo de toda a sessão) — o servidor devolve o
  // usage já normalizado por provedor em cada resposta (ver /api/chat).
  const chatUsageRef = useRef({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

  // Limite de 30 dias para saves de sessão (alinhado à expiração de logs).
  const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  useEffect(() => {
    let cancelled = false;
    async function loadItem() {
      try {
        const [items, skillList] = await Promise.all([api.getExercises(), api.getTrilhaSkills().catch(() => [])]);
        const found = items.find((i) => String(i.id) === String(id));
        if (cancelled) return;
        if (!found) { setError('Exercício não encontrado.'); return; }
        setItem(found);
        setSkillsById(Object.fromEntries((skillList || []).map((s) => [s.id, s])));
        // O system prompt é resolvido no servidor a partir do context — o
        // cliente nunca recebe o texto do specificInstruction.

        // Tenta restaurar sessão pendente (F5 / sair e voltar). Visitantes nunca persistem.
        if (!restoredRef.current && user?.id && user.role !== 'visitor') {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, 'exercise', id);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            const savedElapsed = saved.elapsedSeconds || 0;
            setMessages(saved.messages);
            setElapsed(savedElapsed);
            setSessionStarted(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Erro ao carregar exercício.');
      }
    }
    loadItem();
    return () => { cancelled = true; };
  }, [id, user?.id]);

  // Autosave: localStorage síncrono em cada mudança + servidor com debounce 1.5s.
  // Visitantes não persistem.
  useEffect(() => {
    if (!sessionStarted || phase !== PHASE_SIMULATION || !item || !user?.id) return;
    if (finishedRef.current) return;
    if (user.role === 'visitor') return;

    const data = { messages, elapsedSeconds: elapsed, itemTitle: item.title };
    sessionDataRef.current = data;
    saveLocal(user.id, 'exercise', id, data);

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      // Race: o usuário pode ter clicado "Finalizar" entre o agendamento do
      // timer e o disparo dele. Se finalizou, NÃO grava — senão a sessão
      // ressurge zumbi (o DELETE de clearActiveSession já rodou).
      if (finishedRef.current) return;
      api.saveActiveSession('exercise', id, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, phase, item, user?.id, id]);

  // Flush em visibility/pagehide/unmount. Visitantes não persistem.
  useEffect(() => {
    if (!sessionStarted || phase !== PHASE_SIMULATION || !user?.id) return;
    if (user.role === 'visitor') return;

    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, 'exercise', id, data);
      api.saveActiveSession('exercise', id, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [sessionStarted, phase, user?.id, id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Cronômetro: conta SÓ enquanto a pessoa está no chat (aba/app visível). Começa
  // ao iniciar o atendimento e para ao finalizar. Não usa relógio de parede — tempo
  // fora do chat (background, app fechado, outra aba) não é contado.
  useEffect(() => {
    if (sessionStarted && phase === PHASE_SIMULATION) {
      timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [sessionStarted, phase]);

  // Limite de tempo ativo da sessão atingido (200 min "no chat").
  const limitReached = elapsed >= SESSION_LIMIT_SECONDS;

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function accumulateUsage(ref, usage) {
    if (!usage) return;
    ref.current = {
      input: ref.current.input + (usage.input || 0),
      cacheRead: ref.current.cacheRead + (usage.cacheRead || 0),
      cacheWrite: ref.current.cacheWrite + (usage.cacheWrite || 0),
      output: ref.current.output + (usage.output || 0),
    };
  }

  async function sendToAI(allMessages) {
    const apiMessages = allMessages.map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: 'exercise', itemId: id });
    accumulateUsage(chatUsageRef, data && data.usage);
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function handleStartSession() {
    if (!item || sessionStarted) return;
    setError('');
    setSessionStarted(true);

    // O paciente fala primeiro: enviamos "Iniciar" oculto à IA pra disparar a abertura.
    const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true };
    setMessages([kickoffMsg]);
    setIsTyping(true);
    try {
      const reply = await sendToAI([kickoffMsg]);
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
    if (!trimmed || isTyping || phase !== PHASE_SIMULATION || !sessionStarted || limitReached) return;

    const userMsg = { role: 'user', content: trimmed };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput('');
    setIsTyping(true);

    try {
      const response = await sendToAI(updated);
      setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
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
      .map((m) => `[${m.role === 'user' ? user.name : item.title}]\n${m.content}`)
      .join('\n\n---\n\n');
  }

  function handleFinalize() {
    if (phase !== PHASE_SIMULATION || isTyping) return;
    setConfirmingFinalize(true);
  }

  // Marca o exercício como concluído sem nota (score:null, passed:true) — pra
  // liberar a próxima fase quando não há avaliador (a sessão só finaliza, com
  // ou sem esquema visual).
  async function markPassedWithoutScore() {
    try {
      const current = await api.getProgress(user.id);
      const existing = current?.[id];
      if (!existing || existing.passed !== true) {
        await api.saveProgress(user.id, {
          [id]: {
            score: null,
            skillId: item.skillId,
            passed: true,
            difficulty: item.difficulty,
            completedAt: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      console.warn('Erro ao salvar progresso:', err);
    }
  }

  // Exercício SEM avaliador nem esquema visual: nenhum processamento de IA no
  // final — a sessão só finaliza. Conta como concluída (passed:true,
  // score:null) pra liberar a próxima fase, já que não há nota a exigir.
  async function finalizeWithoutExtras() {
    setEvalError('');
    setEvaluationText('');
    setScore(null);
    setImageSchemaError('');
    setImageSchema(null);
    setPhase(PHASE_CONCLUDED);

    try {
      await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: 'exercise',
        itemId: id,
        itemTitle: item.title,
        skillId: item.skillId,
        difficulty: item.difficulty || null,
        messages: messages.filter((m) => !m.isSystem),
        durationSeconds: elapsed,
        score: null,
        criteriaScores: null,
        evaluation: '',
        // Custo dos Logs da Trilha: o personagem sempre custa, mesmo sem
        // avaliador/esquema visual habilitados.
        chatUsage: chatUsageRef.current,
      });
    } catch (err) {
      setError('Erro ao salvar log: ' + err.message);
    }

    await markPassedWithoutScore();
    clearActiveSession(user.id, 'exercise', id);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (phase !== PHASE_SIMULATION || isTyping) return;
    finishedRef.current = true; // bloqueia autosave/flush
    const visibleCount = messages.filter((m) => !m.isSystem).length;
    if (visibleCount === 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      setPhase(PHASE_CONCLUDED);
      clearActiveSession(user.id, 'exercise', id);
      return;
    }

    if (timerRef.current) clearInterval(timerRef.current);

    const needsEval = item.hasCustomEvaluator;
    const needsImage = item.hasImageSchema;

    if (!needsEval && !needsImage) {
      await finalizeWithoutExtras();
      return;
    }

    setPhase(PHASE_EVALUATING);
    setEvalError('');
    setImageSchemaError('');
    setImageSchema(null);

    const skillName = skillsById[item.skillId]?.name || `Skill ${item.skillId}`;
    const sessionLabel = `Trilha · ${skillName}`;
    const transcript = buildTranscript();
    const visibleMessages = messages.filter((m) => !m.isSystem);

    let evalContent = '';
    let totalScore = null;
    let evaluatorUsage = null;
    let svg = null;
    let imageSchemaUsage = null;
    const tasks = [];

    if (needsEval) {
      // Avaliador customizado do exercício: o servidor já injeta o
      // evaluatorPrompt como system prompt — mensagem do usuário fica curta.
      const evalMessages = [{
        role: 'user',
        content: `Sessão: ${sessionLabel}\nExercício: ${item.title}\nDificuldade: ${DIFFICULTY_LABEL[item.difficulty] || '—'}\nTerapeuta: ${user.name}\n\n## TRANSCRIÇÃO DA SESSÃO\n\n${transcript}\n\nFaça a avaliação completa neste único turno.`,
      }];
      tasks.push((async () => {
        try {
          const reply = await api.evaluate(evalMessages, { type: 'exercise', itemId: id });
          evalContent = typeof reply === 'string' ? reply : reply.content || '';
          evaluatorUsage = (reply && reply.usage) || null;

          // Nota da Trilha = PORCENTAGEM de domínio (0–100). O avaliador
          // customizado do exercício emite [NOTA:X] com X de 0 a 100. Aceita
          // também "**Nota: X/100**" e variações "Nota final: X/100" / "X%".
          const m =
            evalContent.match(/\[NOTA:\s*(\d{1,3})\s*\]/i) ||
            evalContent.match(/\*\*\s*Nota:?\s*(\d{1,3})\s*\/\s*100\s*\*\*/i) ||
            evalContent.match(/\bNota\s*(?:final)?\s*[:=]?\s*(\d{1,3})\s*(?:\/\s*100|%)/i);
          if (m) {
            const v = Number(m[1]);
            if (Number.isFinite(v)) totalScore = Math.max(0, Math.min(100, Math.round(v)));
          }
          setEvaluationText(evalContent);
          setScore(totalScore);
        } catch (err) {
          setEvalError(err.message || 'Erro ao avaliar.');
        }
      })());
    }

    if (needsImage) {
      // Esquema visual: manda a transcrição crua (user/assistant); a
      // observação do admin é injetada pelo servidor — nunca sai pro aluno.
      const imageMessages = visibleMessages.map((m) => ({ role: m.role, content: m.content }));
      tasks.push((async () => {
        try {
          const result = await api.generateImageSchema(id, imageMessages);
          svg = result.svg;
          imageSchemaUsage = result.usage || null;
          setImageSchema(svg);
        } catch (err) {
          setImageSchemaError(err.message || 'Erro ao gerar o esquema visual.');
        }
      })());
    }

    await Promise.allSettled(tasks);
    setPhase(PHASE_CONCLUDED);

    // Persistir log + progresso
    try {
      await api.saveLog({
        userId: user.id,
        userName: user.name,
        type: 'exercise',
        itemId: id,
        itemTitle: item.title,
        skillId: item.skillId,
        difficulty: item.difficulty || null,
        messages: visibleMessages,
        durationSeconds: elapsed,
        score: totalScore,
        criteriaScores: null,
        evaluation: evalContent,
        imageSchema: svg || '',
        // Custo dos Logs da Trilha (admin): usage acumulado/normalizado; o
        // servidor resolve os MODELOS a partir do exercício e calcula o preço.
        chatUsage: chatUsageRef.current,
        evaluatorUsage,
        imageSchemaUsage,
      });
    } catch (err) {
      setError('Erro ao salvar log: ' + err.message);
    }

    if (needsEval) {
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
                skillId: item.skillId,
                passed: totalScore >= 75,
                difficulty: item.difficulty,
                completedAt: new Date().toISOString(),
              },
            });
          }
        } catch (err) {
          console.warn('Erro ao salvar progresso:', err);
        }
      }
    } else {
      // Só tinha esquema visual habilitado, sem avaliador — mesma regra de
      // "só finaliza" (passed:true, sem nota).
      await markPassedWithoutScore();
    }

    // Sessão finalizada — limpa o autosave ativo
    clearActiveSession(user.id, 'exercise', id);
  }

  async function toggleRecording() {
    if (phase !== PHASE_SIMULATION || !sessionStarted || isTranscribing) return;
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

  // Builders de texto pro <LogActions> (copiar/baixar log / avaliação / tudo).
  // Header MINIMAL: só Terapeuta + Exercício. Nota geral fica apenas dentro da
  // seção de avaliação (mesma decisão que vale pra freeplay/neuro em
  // EchoSession e pros logs salvos em Logs.jsx).
  function chatLogHeader() {
    return `Terapeuta: ${user.name}\nExercício: ${item.title}`;
  }
  function chatTranscript() {
    return messages
      .filter((m) => !m.isSystem)
      .map((m) => `[${m.role === 'user' ? user.name : item.title}]\n${m.content}`)
      .join('\n\n---\n\n');
  }
  function chatEvaluationBody() {
    const clean = cleanEvaluationForStudent(evaluationText);
    const line = score !== null ? `Nota final: ${score}%\n\n` : '';
    return `${line}${clean}`;
  }
  const logText = () => `${chatLogHeader()}\n\n---\n\n${chatTranscript()}`;
  const evalText = () => `${chatLogHeader()}${evalSectionTxt(chatEvaluationBody())}`.trimEnd();
  const bothText = () => `${chatLogHeader()}\n\n---\n\n${chatTranscript()}${evalSectionTxt(chatEvaluationBody())}`;
  const logFileBase = () => (item?.title ? `trilha-${item.title}` : 'trilha');
  // Download rápido do log no cabeçalho (durante a sessão ainda não há avaliação).
  function downloadLog() {
    downloadText(`${logFileBase().replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.txt`, bothText());
  }

  // Reinicia a simulação do zero: descarta a conversa, zera o cronômetro e
  // volta à tela de início. A confirmação acontece no modal antes de chamar.
  function doReset() {
    setConfirmingReset(false);
    // Bloqueia autosave/flush durante o reset pra não ressuscitar a sessão zumbi.
    finishedRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    sessionDataRef.current = null;
    chatUsageRef.current = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    clearActiveSession(user.id, 'exercise', id);
    setMessages([]);
    setInput('');
    setElapsed(0);
    setSessionStarted(false);
    setError('');
    // Reabilita a persistência para a próxima sessão iniciada.
    setTimeout(() => { finishedRef.current = false; }, 0);
  }

  // Baixa um "save" portátil da sessão em andamento (JSON), para retomar depois.
  function downloadSave() {
    const save = {
      allosSave: true,
      version: 1,
      type: 'exercise',
      itemId: String(id),
      itemTitle: item?.title || '',
      messages,
      elapsedSeconds: elapsed,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `allos-save-trilha-${(item?.title || 'sessao').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Baixa o esquema visual (.svg) gerado ao final do exercício.
  function downloadImageSchema() {
    if (!imageSchema) return;
    const blob = new Blob([imageSchema], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `esquema-${(item?.title || 'exercicio').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Carrega um save (.json) e retoma a sessão. Valida o formato, o vínculo com
  // este exercício e o limite de 30 dias.
  function handleLoadSaveFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // permite recarregar o mesmo arquivo depois
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const save = JSON.parse(reader.result);
        if (!save || save.allosSave !== true || !Array.isArray(save.messages)) {
          throw new Error('Arquivo de save inválido.');
        }
        if (save.type !== 'exercise' || String(save.itemId) !== String(id)) {
          throw new Error('Este save é de outro exercício. Abra o exercício correspondente para carregá-lo.');
        }
        const savedAt = new Date(save.savedAt || 0).getTime();
        if (Number.isFinite(savedAt) && savedAt > 0 && Date.now() - savedAt > SAVE_TTL_MS) {
          throw new Error('Este save expirou — saves de sessão valem por 30 dias.');
        }
        finishedRef.current = false;
        setMessages(save.messages);
        const sec = Number.isFinite(save.elapsedSeconds) ? save.elapsedSeconds : 0;
        setElapsed(sec);
        setSessionStarted(true);
        setError('');
      } catch (err) {
        setError(err.message || 'Não foi possível carregar o save.');
      }
    };
    reader.readAsText(file);
  }

  // -------- TELA DE LOADING (avaliando / gerando esquema) --------
  if (phase === PHASE_EVALUATING) {
    const needsEval = item?.hasCustomEvaluator;
    const needsImage = item?.hasImageSchema;
    const headline = needsEval && needsImage
      ? 'Processando seu exercício'
      : needsImage
        ? 'Gerando o esquema visual'
        : 'Avaliando seu exercício';
    const sub = needsEval && needsImage
      ? 'A IA está avaliando a sessão e desenhando o esquema visual. Pode levar até um minuto.'
      : needsImage
        ? 'A IA está desenhando um esquema a partir da transcrição da sessão. Pode levar alguns segundos.'
        : 'A IA está analisando a transcrição com o avaliador deste exercício. Pode levar alguns segundos.';
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>{headline}</h2>
          <p>{sub}</p>
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
            {needsEval && <div className="evaluating-line"><span className="dot active" /> Aplicando os critérios do exercício</div>}
            {needsEval && <div className="evaluating-line"><span className="dot pulse" /> Citando trechos e formulando análise</div>}
            {needsEval && <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>}
            {needsImage && <div className="evaluating-line"><span className="dot pulse" /> Desenhando o esquema visual</div>}
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE RESULTADO --------
  if (phase === PHASE_CONCLUDED) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>{item && !item.hasCustomEvaluator ? 'Exercício concluído' : (<>Avaliação do <span className="accent">exercício</span></>)}</h2>
          <p>{item?.title} · {skillsById[item?.skillId]?.name || ''}</p>
          <div className="ornament" />
        </div>

        {evalError && <div className="alert error">Falha ao avaliar: {evalError}</div>}

        {item && !item.hasCustomEvaluator ? (
          <div className="trilha-result-flag neutral">
            Este exercício não tem avaliação automática — a sessão foi registrada e a próxima fase foi liberada.
          </div>
        ) : score !== null && (
          <div className={`trilha-result-flag ${score >= 75 ? 'pass' : 'fail'}`}>
            {score >= 75
              ? '✓ Aprovado — a próxima fase da trilha foi liberada.'
              : `Você atingiu ${score}%. São necessários 75% para liberar a próxima fase — refaça quando quiser.`}
          </div>
        )}

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
              <span className="post-stat-label">Dificuldade</span>
              <span className="post-stat-value" style={{ fontSize: 18 }}>{DIFFICULTY_LABEL[item?.difficulty] || '—'}</span>
            </div>
            {score !== null && (
              <div>
                <span className="post-stat-label">Nota</span>
                <span className="post-stat-value" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
                  <ScoreBadge score={score} size="xl" />
                  <span style={{ fontSize: 15, color: 'var(--ink-soft)', fontWeight: 600 }}>%</span>
                </span>
              </div>
            )}
          </div>

          {evaluationText && (
            <div className="post-evaluation">
              <h4>Análise da IA</h4>
              <div className="post-evaluation-body">
                {/* Blocos de máquina (notas por critério, marcadores de nota)
                    somem da visão do aluno, mas continuam salvos no log. */}
                {cleanEvaluationForStudent(evaluationText)}
              </div>
            </div>
          )}

          {(imageSchemaUrl || imageSchemaError) && (
            <div className="post-evaluation" style={{ marginTop: 14 }}>
              <h4>Esquema visual</h4>
              {imageSchemaError && <div className="alert error">Falha ao gerar o esquema: {imageSchemaError}</div>}
              {imageSchemaUrl && (
                <>
                  <div style={{ background: 'var(--cream-2)', borderRadius: 'var(--radius-lg)', padding: 16, marginTop: 8 }}>
                    {/* Renderizado como <img> (não injetado no DOM) — SVG em contexto
                        de imagem não executa script/eventos, mesmo vindo de uma IA
                        cuja entrada inclui texto do aluno. */}
                    <img src={imageSchemaUrl} alt="Esquema visual do exercício" style={{ maxWidth: '100%', height: 'auto', display: 'block', margin: '0 auto' }} />
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button type="button" className="btn btn-outline btn-sm" onClick={downloadImageSchema}>Baixar esquema (.svg)</button>
                  </div>
                </>
              )}
            </div>
          )}

          {messages.filter((m) => !m.isSystem).length > 0 && (() => {
            const hasEval = !!cleanEvaluationForStudent(evaluationText).trim();
            return (
              <div style={{ marginTop: 14 }}>
                <LogActions
                  items={makeLogItems({
                    baseName: logFileBase(),
                    getLog: logText,
                    getEval: hasEval ? evalText : null,
                    getBoth: hasEval ? bothText : null,
                  })}
                />
              </div>
            );
          })()}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate('/skills')}>
              Voltar à trilha
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  return (
    <div className="chat-container">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>

        {item?.title && <PatientAvatarButton name={item.title} iconUrl={item.photoIcon} fullUrl={item.photoFull} size={42} className="chat-header-avatar" />}

        <div className="chat-title">
          <h3>{item?.title || '...'}</h3>
          <div className="chat-status">
            {item ? `${skillsById[item.skillId]?.name || ''}` : ''}
            {item?.difficulty ? ` · ${DIFFICULTY_LABEL[item.difficulty]}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            <span>{formatTime(elapsed)}</span>
          </div>
          {messages.length > 0 && (
            <button onClick={downloadLog} className="btn btn-outline btn-sm" title="Baixar log">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Log
            </button>
          )}
          {sessionStarted && (
            <button onClick={() => setShowSaveLoad(true)} className="btn btn-outline btn-sm" title="Guardar ou carregar o progresso desta sessão">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
              Save/Load
            </button>
          )}
          {sessionStarted && (
            <button
              onClick={() => setConfirmingReset(true)}
              disabled={isTyping}
              className="btn btn-outline btn-sm"
              title="Reiniciar a simulação do zero"
              style={{ color: 'var(--terra)', borderColor: 'var(--terra)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" /></svg>
              Reiniciar
            </button>
          )}
          {sessionStarted && (
            <button
              onClick={handleFinalize}
              disabled={isTyping || !item}
              className="btn btn-secondary btn-sm"
            >
              Finalizar Sessão
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
            {item ? `Exercício: ${item.title}` : 'Carregando exercício…'}
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.isSystem) return null;
          return (
            <div key={i} className={`chat-message-row ${msg.role}`}>
              <div className="chat-message-author">
                {msg.role === 'user' ? user.name : item?.title || 'Paciente'}
              </div>
              <div className={`chat-message ${msg.role}`}>{msg.content}</div>
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{item?.title || 'Paciente'}</div>
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
            <p>Ao iniciar, o paciente abrirá a conversa. Você responde a partir da fala dele.</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-lg" onClick={handleStartSession} disabled={!item}>
                Iniciar atendimento
              </button>
              <button className="btn btn-outline btn-lg" onClick={() => fileInputRef.current?.click()} disabled={!item} title="Retomar a partir de um arquivo de save (.json)">
                Carregar save
              </button>
            </div>
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

      {/* Input de arquivo (oculto) usado pelo "Carregar" — fica no topo do
          chat para estar disponível tanto na tela inicial quanto durante a sessão. */}
      <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleLoadSaveFile} style={{ display: 'none' }} />

      {/* Modal Guardar / Carregar progresso */}
      {showSaveLoad && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem).length;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSaveLoad(false); }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>Progresso da sessão</h3>
              <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
                Você quer <strong>guardar</strong> o progresso atual num arquivo (.json) para retomar depois,
                ou <strong>carregar</strong> um progresso salvo? Carregar substitui a conversa atual.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => { setShowSaveLoad(false); fileInputRef.current?.click(); }}
                >
                  Carregar o progresso
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => { setShowSaveLoad(false); downloadSave(); }}
                  disabled={visibleCount === 0}
                  title={visibleCount === 0 ? 'A sessão ainda não tem mensagens para guardar' : 'Baixar o save desta sessão'}
                >
                  Guardar o progresso
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

      {/* Modal de confirmação de reinício */}
      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar simulação</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              Tem certeza que deseja reiniciar? Toda a conversa atual e o tempo decorrido serão <strong>perdidos</strong> e você voltará à tela de início. Esta ação não pode ser desfeita.
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
    </div>
  );
}
