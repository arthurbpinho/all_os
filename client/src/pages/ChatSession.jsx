import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  buildFreeplayPrompt,
  buildDirectEvaluationPrompt,
  parseCriteriaScores,
  calculateScores,
  SKILL_NAMES,
} from '../prompts';
import ScoreBadge from '../components/ScoreBadge';

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
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState(PHASE_SIMULATION);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState('');
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [score, setScore] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(null);

  useEffect(() => {
    async function loadItem() {
      try {
        const items = await api.getExercises();
        const found = items.find((i) => String(i.id) === String(id));
        if (!found) { setError('Exercício não encontrado.'); return; }
        setItem(found);
        // Patient persona — sem rubrica de avaliação embutida
        setSystemPrompt(buildFreeplayPrompt(found.specificInstruction));
      } catch (err) {
        setError(err.message || 'Erro ao carregar exercício.');
      }
    }
    loadItem();
  }, [id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Cronômetro: começa quando o item carrega (entrada na sessão), para ao finalizar
  useEffect(() => {
    if (item && phase === PHASE_SIMULATION && !startedAtRef.current) {
      startedAtRef.current = Date.now();
    }
    if (phase === PHASE_SIMULATION && startedAtRef.current) {
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [item, phase]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function sendToAI(allMessages) {
    const apiMessages = allMessages.map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, systemPrompt);
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || phase !== PHASE_SIMULATION) return;

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
      .map((m) => `[${m.role === 'user' ? user.name : item.title}]\n${m.content}`)
      .join('\n\n---\n\n');
  }

  async function handleFinalize() {
    if (phase !== PHASE_SIMULATION || isTyping) return;
    if (messages.length === 0) {
      if (!window.confirm('A sessão está vazia. Finalizar mesmo assim (sem avaliação)?')) return;
      if (timerRef.current) clearInterval(timerRef.current);
      setPhase(PHASE_CONCLUDED);
      return;
    }
    if (!window.confirm('Finalizar a sessão e iniciar a avaliação?')) return;

    if (timerRef.current) clearInterval(timerRef.current);
    setPhase(PHASE_EVALUATING);
    setEvalError('');

    const skillName = SKILL_NAMES[item.skillId] || `Skill ${item.skillId}`;
    const sessionLabel = `Trilha · ${skillName}`;
    const transcript = buildTranscript();

    let evalMessages;
    let overrideSystemPrompt;

    if (item.evaluatorPrompt && item.evaluatorPrompt.trim()) {
      // Avaliador customizado pelo admin
      overrideSystemPrompt = item.evaluatorPrompt;
      evalMessages = [{
        role: 'user',
        content: `Sessão: ${sessionLabel}\nExercício: ${item.title}\nDificuldade: ${DIFFICULTY_LABEL[item.difficulty] || '—'}\nTerapeuta: ${user.name}\n\n## TRANSCRIÇÃO DA SESSÃO\n\n${transcript}\n\nFaça a avaliação completa neste único turno.`,
      }];
    } else {
      // Fallback: avaliador global Allos (single-shot)
      evalMessages = [{
        role: 'user',
        content: buildDirectEvaluationPrompt(sessionLabel, item.title, transcript),
      }];
    }

    let evalContent = '';
    let totalScore = null;
    let parsedCriteria = null;

    try {
      const reply = await api.evaluate(evalMessages, overrideSystemPrompt);
      evalContent = typeof reply === 'string' ? reply : reply.content || '';

      // Tenta primeiro [CRITERIOS:...] (Allos format), depois [NOTA:X] (genérico)
      parsedCriteria = parseCriteriaScores(evalContent);
      if (parsedCriteria) {
        totalScore = calculateScores(parsedCriteria).totalScore;
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
      setScore(totalScore);
    } catch (err) {
      setEvalError(err.message || 'Erro ao avaliar.');
    } finally {
      setPhase(PHASE_CONCLUDED);
    }

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
        messages,
        durationSeconds: elapsed,
        score: totalScore,
        criteriaScores: parsedCriteria,
        evaluation: evalContent,
      });
    } catch (err) {
      setError('Erro ao salvar log: ' + err.message);
    }

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
              skillScores: parsedCriteria ? calculateScores(parsedCriteria).skillScores : null,
              criteriaScores: parsedCriteria,
              difficulty: item.difficulty,
              completedAt: new Date().toISOString(),
            },
          });
        }
      } catch (err) {
        console.warn('Erro ao salvar progresso:', err);
      }
    }
  }

  async function toggleRecording() {
    if (phase !== PHASE_SIMULATION) return;
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

  function downloadLog() {
    const lines = messages.map((m) =>
      `[${m.role === 'user' ? user.name : item.title}]\n${m.content}`
    );
    const skillName = SKILL_NAMES[item.skillId] || '';
    const header = `Trilha · ${skillName}\nExercício: ${item.title}\nDificuldade: ${DIFFICULTY_LABEL[item.difficulty] || '—'}\nDuração: ${formatTime(elapsed)}\nTerapeuta: ${user.name}\n${score !== null ? `Nota final: ${score > 0 ? '+' : ''}${score}\n` : ''}\n---\n\n`;
    const evalSection = evaluationText
      ? `\n\n===========================\nAVALIAÇÃO DA IA\n===========================\n\n${evaluationText}`
      : '';
    const blob = new Blob([header + lines.join('\n\n---\n\n') + evalSection], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trilha-${item.title.replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -------- TELA DE LOADING (avaliando) --------
  if (phase === PHASE_EVALUATING) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>Avaliando seu <span className="accent">exercício</span></h2>
          <p>A IA está analisando a transcrição com o avaliador deste exercício. Pode levar alguns segundos.</p>
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
            <div className="evaluating-line"><span className="dot active" /> Aplicando os critérios do exercício</div>
            <div className="evaluating-line"><span className="dot pulse" /> Citando trechos e formulando análise</div>
            <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>
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
          <h2>Avaliação do <span className="accent">exercício</span></h2>
          <p>{item?.title} · {SKILL_NAMES[item?.skillId] || ''}</p>
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
              <span className="post-stat-label">Dificuldade</span>
              <span className="post-stat-value" style={{ fontSize: 18 }}>{DIFFICULTY_LABEL[item?.difficulty] || '—'}</span>
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

          <div className="post-session-actions">
            <button className="btn btn-outline" onClick={downloadLog}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Baixar log
            </button>
            <button className="btn btn-primary" onClick={() => navigate('/skills')}>
              Voltar ao mapa
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

        <div className="chat-title">
          <h3>{item?.title || '...'}</h3>
          <div className="chat-status">
            {item ? `${SKILL_NAMES[item.skillId] || ''}` : ''}
            {item?.difficulty ? ` · ${DIFFICULTY_LABEL[item.difficulty]}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="timer-chip" title="Duração da sessão">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            <span>{formatTime(elapsed)}</span>
          </div>
          {messages.length > 0 && (
            <button onClick={downloadLog} className="btn btn-outline btn-sm" title="Baixar log">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Log
            </button>
          )}
          <button
            onClick={handleFinalize}
            disabled={isTyping || !item}
            className="btn btn-secondary btn-sm"
          >
            Finalizar Sessão
          </button>
        </div>
      </div>

      {error && (
        <div className="alert error">
          {error}
          <button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className="chat-messages">
        {messages.length === 0 && !isTyping && (
          <div className="empty-chat">
            Sessão iniciada. Cumprimente o paciente para começar.
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-message-row ${msg.role}`}>
            <div className="chat-message-author">
              {msg.role === 'user' ? user.name : item?.title || 'Paciente'}
            </div>
            <div className={`chat-message ${msg.role}`}>{msg.content}</div>
          </div>
        ))}

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
    </div>
  );
}
