import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

export default function AdminEntrevistador({ user }) {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [loadingPrompt, setLoadingPrompt] = useState(true);
  const [showCharModal, setShowCharModal] = useState(false);
  const [charForm, setCharForm] = useState({ name: '', age: '', description: '', specificInstruction: '' });
  const [savingChar, setSavingChar] = useState(false);
  const [charSaved, setCharSaved] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  useEffect(() => {
    api.getEntrevistadorPrompt()
      .then((data) => setSystemPrompt(data.prompt || ''))
      .catch((err) => setError('Erro ao carregar o prompt do entrevistador: ' + err.message))
      .finally(() => setLoadingPrompt(false));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || !systemPrompt) return;

    const userMsg = { role: 'user', content: trimmed };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput('');
    setIsTyping(true);

    try {
      const apiMessages = updated.map((m) => ({ role: m.role, content: m.content }));
      // maxTokens alto: o entrevistador precisa gerar o prompt completo do paciente
      // (vários milhares de tokens) sem ser cortado pelo limite default.
      const reply = await api.chat(apiMessages, systemPrompt, 'gpt-5.4-2026-03-05', 16000);
      const content = typeof reply === 'string' ? reply : reply.content || reply.message || '';
      setMessages((prev) => [...prev, { role: 'assistant', content }]);
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

  async function toggleRecording() {
    if (!systemPrompt || isTranscribing) return;
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

  // Concatena tudo que o assistente disse para extrair os blocos
  function getAssistantText() {
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n');
  }

  // Extrai o prompt do paciente (saída final do entrevistador).
  // Reconhece dois formatos:
  //  - Novo: começa em "## [I. CONTENÇÃO]" e vai até "## [V. ABERTURA E CONTINUIDADE]"
  //          (ou frase de encerramento "Pronto. É só colar isso no simulador").
  //  - Antigo: "BLOCO 2 — PROMPT PARA O SIMULADOR" até "Pronto. Bloco 1...".
  function extractBloco2(text) {
    // Formato novo
    const newStart = text.search(/##\s*\[\s*I\.\s*CONTENÇÃO\s*\]/i);
    if (newStart !== -1) {
      let body = text.slice(newStart);
      // Possíveis encerramentos no final do prompt
      const endPatterns = [
        /\n\s*-{3,}\s*\n\s*Pronto\.?\s*É só colar/i,
        /\n\s*Pronto\.?\s*É só colar/i,
        /\n\s*Pronto\.?\s*Obrigado pela construção/i,
      ];
      for (const re of endPatterns) {
        const m = body.match(re);
        if (m) { body = body.slice(0, m.index); break; }
      }
      return body.trim();
    }

    // Formato antigo
    const oldStart = text.search(/BLOCO\s*2\b[^\n]*PROMPT/i);
    if (oldStart !== -1) {
      let body = text.slice(oldStart);
      const endMatch = body.match(/\n\s*"?Pronto\.?\s*Bloco\s*1/i);
      if (endMatch) body = body.slice(0, endMatch.index);
      return body.trim();
    }

    return null;
  }

  // Extrai nome / idade / descrição da saída do entrevistador.
  function extractMetaFromBloco1(text) {
    const meta = { name: '', age: '', description: '' };

    // Nome — funciona em ambos os formatos: "Você representa NOME, ..."
    const nomeMatch = text.match(/Você\s+representa\s+([^,.\n]+)/i);
    if (nomeMatch) meta.name = nomeMatch[1].trim();

    // Descrição — formato novo: "### Quem ela é\n[parágrafo]"
    const newQuemMatch = text.match(/###\s*Quem\s+(?:ela|ele)\s+é\s*\n+([\s\S]+?)(?=\n\s*###|\n\s*##|\n\s*\*\*Camada)/i);
    if (newQuemMatch) {
      const para = newQuemMatch[1].trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      meta.description = para.slice(0, 240);
      const ageMatch = para.match(/\b(\d{1,3})\s*anos?\b/i);
      if (ageMatch) meta.age = ageMatch[1];
      return meta;
    }

    // Descrição — formato antigo: "QUEM ESSA PESSOA É\n[parágrafo]"
    const block1Match = text.match(/BLOCO\s*1[^\n]*\n([\s\S]+?)(?=BLOCO\s*2|---)/i);
    const source = block1Match ? block1Match[1] : text;
    const oldQuemMatch = source.match(/QUEM ESSA PESSOA É\s*\n([\s\S]+?)(?=\n[A-Z][A-Z\s—-]{4,}\n)/);
    if (oldQuemMatch) {
      const para = oldQuemMatch[1].trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      meta.description = para.slice(0, 240);
      const ageMatch = para.match(/\b(\d{1,3})\s*anos?\b/i);
      if (ageMatch) meta.age = ageMatch[1];
    }

    return meta;
  }

  function handlePrepareCharacter() {
    const text = getAssistantText();
    const bloco2 = extractBloco2(text);
    if (!bloco2) {
      alert('Ainda não encontrei o prompt final do paciente na conversa. Aguarde o entrevistador concluir a entrevista e devolver o prompt formatado (começando em "## [I. CONTENÇÃO]").');
      return;
    }
    const meta = extractMetaFromBloco1(text);
    setCharForm({
      name: meta.name || '',
      age: meta.age || '',
      description: meta.description || '',
      specificInstruction: bloco2,
    });
    setCharSaved(null);
    setShowCharModal(true);
  }

  async function handleCreateCharacter(e) {
    e.preventDefault();
    if (!charForm.name.trim()) {
      alert('Defina um nome para o personagem.');
      return;
    }
    setSavingChar(true);
    try {
      const created = await api.createFreeplay({
        name: charForm.name.trim(),
        age: charForm.age !== '' ? Number(charForm.age) : null,
        description: charForm.description.trim(),
        assistantId: '',
        specificInstruction: charForm.specificInstruction,
      });
      setCharSaved(created);
    } catch (err) {
      alert('Erro ao criar personagem: ' + err.message);
    } finally {
      setSavingChar(false);
    }
  }

  function downloadConversation() {
    const lines = messages.map((m) => `[${m.role === 'user' ? user.name : 'Entrevistador'}]\n${m.content}`);
    const header = `Entrevista de construção de personagem · ${new Date().toLocaleString('pt-BR')}\nAdmin: ${user.name}\n\n---\n\n`;
    const blob = new Blob([header + lines.join('\n\n---\n\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `entrevista-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBloco2() {
    const bloco2 = extractBloco2(getAssistantText());
    if (!bloco2) {
      alert('O prompt final do paciente ainda não foi gerado pelo entrevistador.');
      return;
    }
    const blob = new Blob([bloco2], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompt-personagem-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetConversation() {
    if (messages.length > 0 && !window.confirm('Apagar a conversa atual e começar uma nova entrevista?')) return;
    setMessages([]);
    setInput('');
    setCharSaved(null);
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Construção de personagens</div>
          <h2><Typewriter text="Entre" /><span className="accent"><Typewriter text="vistador" delayStart={180} /></span></h2>
          <p>
            Conduza uma entrevista com o agente entrevistador da Allos para co-construir um novo personagem-paciente.
            Ao final, o entrevistador devolve o prompt do paciente pronto para criar um personagem na biblioteca de Simulação.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {messages.length > 0 && (
            <>
              <button className="btn btn-outline btn-sm" onClick={downloadConversation}>Baixar conversa</button>
              <button className="btn btn-outline btn-sm" onClick={downloadBloco2}>Baixar prompt (.md)</button>
              <button className="btn btn-primary btn-sm" onClick={handlePrepareCharacter}>Criar personagem</button>
              <button className="btn btn-ghost btn-sm" onClick={resetConversation}>Nova entrevista</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loadingPrompt ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando prompt do entrevistador…</span>
        </div>
      ) : (
        <div className="chat-container entrevistador-chat">
          <div className="chat-messages">
            {messages.length === 0 && !isTyping && (
              <div className="empty-chat" style={{ marginTop: 80 }}>
                Comece a entrevista — diga ao entrevistador que tipo de personagem você quer construir, ou peça que ele inicie pela calibragem de ritmo.
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`chat-message-row ${msg.role}`}>
                <div className="chat-message-author">
                  {msg.role === 'user' ? user.name : 'Entrevistador'}
                </div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
              </div>
            ))}

            {isTyping && (
              <div className="chat-message-row assistant">
                <div className="chat-message-author">Entrevistador</div>
                <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                  <span className="loading-dots">Pensando</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {isTranscribing ? (
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
                placeholder="Sua resposta…  ·  Enter envia · Shift+Enter quebra linha"
                rows={1}
                disabled={isTyping || !systemPrompt}
              />
              <button
                type="button"
                className={`icon-btn ${isRecording ? 'recording' : ''}`}
                onClick={toggleRecording}
                title={isRecording ? 'Parar gravação' : 'Gravar áudio'}
                disabled={isTyping || !systemPrompt}
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
        </div>
      )}

      {showCharModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowCharModal(false); }}>
          <div className="modal" style={{ maxWidth: 720 }}>
            <h3>{charSaved ? 'Personagem criado' : 'Criar personagem na Simulação'}</h3>

            {charSaved ? (
              <div>
                <div className="alert success">
                  <strong>{charSaved.name}</strong> foi criado(a) na biblioteca de Simulação.
                </div>
                <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginBottom: 18 }}>
                  Você pode editá-lo em <code>Administração · Personagens da Simulação</code>.
                </p>
                <div className="modal-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setShowCharModal(false)}>
                    Fechar
                  </button>
                </div>
              </div>
            ) : (
              <form className="admin-form" onSubmit={handleCreateCharacter}>
                <div style={{ display: 'flex', gap: 14 }}>
                  <div style={{ flex: 2 }}>
                    <label htmlFor="ent-name">Nome</label>
                    <input
                      id="ent-name"
                      value={charForm.name}
                      onChange={(e) => setCharForm({ ...charForm, name: e.target.value })}
                      required
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label htmlFor="ent-age">Idade</label>
                    <input
                      id="ent-age"
                      type="number"
                      min="1"
                      max="120"
                      value={charForm.age}
                      onChange={(e) => setCharForm({ ...charForm, age: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="ent-desc">Descrição visível</label>
                  <input
                    id="ent-desc"
                    value={charForm.description}
                    onChange={(e) => setCharForm({ ...charForm, description: e.target.value })}
                    placeholder="Apresentação curta para o aluno"
                  />
                </div>
                <div>
                  <label htmlFor="ent-prompt">
                    Prompt do simulador <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(extraído da entrevista)</em>
                  </label>
                  <textarea
                    id="ent-prompt"
                    value={charForm.specificInstruction}
                    onChange={(e) => setCharForm({ ...charForm, specificInstruction: e.target.value })}
                    style={{ minHeight: 280, fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}
                  />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-outline" onClick={() => setShowCharModal(false)} disabled={savingChar}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={savingChar}>
                    {savingChar ? 'Criando…' : 'Criar personagem'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
