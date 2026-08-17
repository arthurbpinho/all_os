import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { downloadText } from '../logFiles';

export default function ProgressionChat({ patient, user, onEvaluationComplete, onCancel }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState('simulation'); // simulation | evaluating | concluded
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [evaluationText, setEvaluationText] = useState('');
  const [criteria, setCriteria] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStarted, setSessionStarted] = useState(false);

  const messagesEndRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(null);
  const finishedRef = useRef(false);
  const initializedRef = useRef(false);
  const textareaRef = useRef(null);

  // Timer para cronômetro
  useEffect(() => {
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // Kickoff: paciente fala primeiro
  useEffect(() => {
    if (initializedRef.current || sessionStarted) return;
    initializedRef.current = true;

    async function startSession() {
      const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true };
      setMessages([kickoffMsg]);
      setIsTyping(true);

      try {
        const apiMessages = [{ role: 'user', content: 'Iniciar' }];
        const response = await api.chat(apiMessages, { type: 'freeplay', itemId: patient.characterId, category: 'treinamento' });
        const assistantContent = typeof response === 'string' ? response : (response.content || response.message || '');

        if (assistantContent) {
          setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
        }
      } catch (err) {
        setError(err.message || 'Erro ao iniciar conversa.');
      } finally {
        setIsTyping(false);
        setSessionStarted(true);
      }
    }

    startSession();
  }, [patient]);

  // Auto-scroll no chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || isTyping || !sessionStarted || phase !== 'simulation') return;

    const userMessage = { role: 'user', content: input.trim() };
    setInput('');
    setMessages((prev) => [...prev, userMessage]);
    setIsTyping(true);
    setError('');

    try {
      const apiMessages = [...messages, userMessage]
        .filter((m) => m && m.role)
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await api.chat(apiMessages, { type: 'freeplay', itemId: patient.characterId, category: 'treinamento' });
      const assistantContent = typeof response === 'string' ? response : (response.content || response.message || '');

      if (assistantContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
      }
    } catch (err) {
      setError(err.message || 'Erro ao enviar mensagem.');
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsTyping(false);
    }
  }

  async function submitEvaluation() {
    if (finishedRef.current || phase !== 'evaluating') return;
    finishedRef.current = true;
    setError('');

    try {
      // Filtra mensagens de sistema (kickoff "Iniciar")
      const apiMessages = messages
        .filter((m) => !m.isSystem)
        .map((m) => ({ role: m.role, content: m.content }));

      const result = await api.evaluateProgression({
        characterId: patient.characterId,
        messages: apiMessages,
      });

      setEvaluationText(result.evaluation || '');
      setCriteria(result.criteria || null);
      setPhase('concluded');

      // Salva o log
      const logMessages = messages
        .filter((m) => !m.isSystem)
        .map((m) => ({ role: m.role, content: m.content }));

      await api.saveLog({
        type: 'freeplay',
        mode: 'progression',
        itemId: patient.characterId,
        itemTitle: patient.characterName,
        durationSeconds: elapsed,
        messages: logMessages,
        evaluation: result.evaluation,
        criteriaScores: result.criteria,
      });

      // Callback com os resultados
      onEvaluationComplete({ evaluation: result.evaluation, criteria: result.criteria });
    } catch (err) {
      setError(err.message || 'Erro ao executar avaliação.');
      finishedRef.current = false;
    }
  }

  function downloadEvaluation() {
    if (!evaluationText) return;
    const text = `AVALIAÇÃO DE PROGRESSÃO
Paciente: ${patient.characterName}
Data: ${new Date().toLocaleString('pt-BR')}

${evaluationText}`;
    downloadText(`progressao_${patient.characterName}.txt`, text);
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // ---- Fase de conclusão (resultado) ----
  if (phase === 'concluded') {
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Progressão · {patient.characterName}</div>
          <h2>Avaliação <span className="accent">concluída</span></h2>
          <div className="ornament" />
        </div>

        {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

        <div className="chat-evaluation-display">
          <div className="evaluation-section">
            <div className="evaluation-text">
              {evaluationText}
            </div>
          </div>

          {criteria && (
            <div className="evaluation-scores">
              <h3>Notas do Atendimento 2</h3>
              <div className="scores-grid">
                {Object.entries(criteria).map(([criterion, score]) => (
                  <div key={criterion} className="score-item">
                    <span>{criterion}</span>
                    <strong>{score}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="evaluation-actions">
            <button className="btn btn-outline btn-sm" onClick={downloadEvaluation}>
              Baixar avaliação
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Fase de simulação (chat) ou aguardando avaliação ----
  return (
    <div className="chat-session">
      <div className="chat-header">
        <div>
          <h2>{patient.characterName}</h2>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>Avaliação de progressão</p>
        </div>
        <div className="chat-header-right">
          <div className="elapsed-time">{formatTime(elapsed)}</div>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>×</button>
        </div>
      </div>

      {error && <div className="alert error" style={{ margin: '0 16px' }}>{error}<button onClick={() => setError('')} className="close">×</button></div>}

      <div className="chat-container">
        <div className="chat-messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`chat-message-row ${msg.role}`}>
              <div className={`chat-message ${msg.role}`}>{msg.content}</div>
            </div>
          ))}
          {isTyping && (
            <div className="chat-message-row assistant">
              <div className="chat-message assistant">
                <span className="spinner" style={{ marginRight: 8 }} />
                {patient.characterName} está digitando…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {phase === 'simulation' && (
        <div className="chat-input-area">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
            placeholder="Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha"
            rows={1}
            disabled={isTyping || !sessionStarted}
          />
          <button
            className="btn btn-primary"
            onClick={sendMessage}
            disabled={isTyping || !input.trim() || !sessionStarted}
          >
            Enviar
          </button>

          <div style={{ marginTop: 8 }}>
            {!confirmingFinalize ? (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setConfirmingFinalize(true)}
                disabled={isTyping || messages.length <= 1}
              >
                Finalizar e avaliar
              </button>
            ) : (
              <div className="confirm-box">
                <p>Finalizar a sessão e avaliar progresso?</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setPhase('evaluating');
                      submitEvaluation();
                    }}
                  >
                    Sim, finalizar
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmingFinalize(false)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === 'evaluating' && (
        <div className="chat-input-area">
          <div style={{ textAlign: 'center', padding: '16px' }}>
            <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Avaliando progresso…</span>
          </div>
        </div>
      )}
    </div>
  );
}
