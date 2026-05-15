import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

export default function Avaliacao({ user }) {
  const [transcript, setTranscript] = useState('');
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Carrega lista de personagens FreePlay pra dropdown de critério de correção.
  // O `evaluationCriteria` (Bloco 1) não vem ao cliente — é resolvido server-side
  // em /api/evaluate a partir do context.itemId. Aqui só precisamos de id+nome.
  useEffect(() => {
    let cancelled = false;
    api.getFreeplay()
      .then((list) => {
        if (cancelled) return;
        const sorted = (Array.isArray(list) ? list : [])
          .map((c) => ({ id: c.id, name: c.name, age: c.age }))
          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
        setCharacters(sorted);
      })
      .catch(() => { /* sem dropdown se falhar; fluxo genérico continua */ });
    return () => { cancelled = true; };
  }, []);

  const evaluateContext = selectedCharacterId
    ? { type: 'freeplay', itemId: selectedCharacterId }
    : undefined;

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.txt')) {
      setError('Apenas arquivos .txt são aceitos.');
      return;
    }
    // Limite de tamanho — transcrições reais ficam abaixo de 500KB. Acima
    // disso é provavelmente um arquivo errado e travaria a aba lendo tudo
    // em memória + o servidor rejeitaria por exceder express.json limit.
    const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2 MB
    if (file.size > MAX_TRANSCRIPT_BYTES) {
      setError(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo: 2 MB.`);
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      setTranscript(ev.target.result);
    };
    reader.readAsText(file);
  }

  async function handleStart() {
    if (!transcript.trim()) {
      setError('Cole ou envie uma transcrição antes de iniciar a avaliação.');
      return;
    }
    setError('');
    setStarted(true);
    setLoading(true);

    const initialMessage = {
      role: 'user',
      content: `Aqui está a transcrição da sessão para avaliação:\n\n${transcript}`,
    };

    try {
      const reply = await api.evaluate([initialMessage], evaluateContext);
      setMessages([initialMessage, reply]);
    } catch (err) {
      setError(err.message || 'Erro ao iniciar avaliação');
      setStarted(false);
    } finally {
      setLoading(false);
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim() };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const reply = await api.evaluate(
        updated.map((m) => ({ role: m.role, content: m.content })),
        evaluateContext,
      );
      setMessages([...updated, reply]);
    } catch (err) {
      setError(err.message || 'Erro ao comunicar com a IA');
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function downloadLog() {
    const text = messages
      .map((m, i) => {
        const name = m.role === 'user' ? user?.name || 'Usuário' : 'all_OS';
        if (i === 0) return `[${name}]\n[Transcrição enviada · ${transcript.length} caracteres]`;
        return `[${name}]\n${m.content}`;
      })
      .join('\n\n---\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `avaliacao-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleReset() {
    setTranscript('');
    setStarted(false);
    setMessages([]);
    setInput('');
    setError('');
    setLoading(false);
    setSelectedCharacterId('');
  }

  if (!started) {
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Avaliação Independente</div>
          <h2><Typewriter text="Avaliar uma " /><span className="accent"><Typewriter text="Sessão" delayStart={520} /></span></h2>
          <p>
            Envie a transcrição completa de uma sessão terapêutica e receba uma análise densa seguindo
            os 6 critérios da Allos (avaliador v9). A análise vem em um único turno; você pode contestar
            e dialogar com a IA depois.
          </p>
          <div className="ornament" />
        </div>

        <div className="avaliacao-intro">
          <div>
            <label htmlFor="character-select">Critério de correção (personagem FreePlay)</label>
            <select
              id="character-select"
              value={selectedCharacterId}
              onChange={(e) => setSelectedCharacterId(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">Sem critério específico — avaliação genérica</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.age ? `, ${c.age}` : ''}
                </option>
              ))}
            </select>
            <small style={{ display: 'block', marginTop: 6, color: 'var(--marrs-dark)', fontSize: 12 }}>
              Quando selecionado, o avaliador recebe o Bloco 1 (gabarito) do caso como referência. O aluno não vê esse conteúdo.
            </small>
          </div>

          <div>
            <label htmlFor="transcript">Transcrição da sessão</label>
            <textarea
              id="transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Cole aqui a transcrição completa da sessão terapêutica…"
              style={{ minHeight: 280, width: '100%' }}
            />
          </div>

          <div className="avaliacao-row">
            <span className="avaliacao-divider">ou</span>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Enviar arquivo .txt
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            {transcript && (
              <span style={{ fontSize: 12, color: 'var(--marrs-dark)', letterSpacing: '0.08em' }}>
                {transcript.length.toLocaleString('pt-BR')} caracteres carregados
              </span>
            )}
          </div>

          {error && <div className="alert error">{error}</div>}

          <button className="btn btn-primary btn-lg" onClick={handleStart}>
            Iniciar Avaliação
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      <div className="chat-header">
        <div className="chat-title" style={{ textAlign: 'left' }}>
          <h3>Avaliação de Sessão</h3>
          <div className="chat-status">
            {(() => {
              const sel = characters.find((c) => c.id === selectedCharacterId);
              return sel
                ? `conversa com a IA · critério: ${sel.name}`
                : 'conversa com a IA · diálogo socrático';
            })()}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {messages.length > 0 && (
            <button onClick={downloadLog} className="btn btn-outline btn-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Log
            </button>
          )}
          <button className="btn btn-outline btn-sm" onClick={handleReset}>
            Nova Avaliação
          </button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message-row ${msg.role}`}>
            <div className="chat-message-author">
              {msg.role === 'user' ? user?.name || 'Usuário' : 'all_OS · Avaliador'}
            </div>
            <div
              className={`chat-message ${msg.role}`}
              style={i === 0 ? { fontStyle: 'italic', opacity: 0.85 } : undefined}
            >
              {i === 0
                ? `Transcrição enviada · ${transcript.length.toLocaleString('pt-BR')} caracteres`
                : msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">all_OS</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
              <span className="loading-dots">Analisando</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="alert error">
          {error}
          <button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className="chat-input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Responda ou questione a avaliação…"
          disabled={loading}
        />
        <button
          type="button"
          className="icon-btn primary"
          onClick={handleSend}
          disabled={loading || !input.trim()}
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
