import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

export default function AdminEntrevistador({ user }) {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [loadingPrompt, setLoadingPrompt] = useState(true);
  const [showCharModal, setShowCharModal] = useState(false);
  const [charForm, setCharForm] = useState({ name: '', age: '', description: '', specificInstruction: '' });
  const [savingChar, setSavingChar] = useState(false);
  const [charSaved, setCharSaved] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

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
      const reply = await api.chat(apiMessages, systemPrompt, 'gpt-5.4-2026-03-05');
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

  // Concatena tudo que o assistente disse para extrair os blocos
  function getAssistantText() {
    return messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n');
  }

  // BLOCO 2 começa em "BLOCO 2 — PROMPT PARA O SIMULADOR" e vai até o "Pronto. Bloco 1..." final
  function extractBloco2(text) {
    const startIdx = text.search(/BLOCO\s*2\b[^\n]*PROMPT/i);
    if (startIdx === -1) return null;
    let body = text.slice(startIdx);
    const endMatch = body.match(/\n\s*"?Pronto\.?\s*Bloco\s*1/i);
    if (endMatch) body = body.slice(0, endMatch.index);
    return body.trim();
  }

  // Tenta extrair nome/idade/descrição do BLOCO 1 ou da síntese
  function extractMetaFromBloco1(text) {
    const meta = { name: '', age: '', description: '' };
    const block1Match = text.match(/BLOCO\s*1[^\n]*\n([\s\S]+?)(?=BLOCO\s*2|---)/i);
    const source = block1Match ? block1Match[1] : text;

    // Quem essa pessoa é
    const quemMatch = source.match(/QUEM ESSA PESSOA É\s*\n([\s\S]+?)(?=\n[A-Z][A-Z\s—-]{4,}\n)/);
    if (quemMatch) {
      const para = quemMatch[1].trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      meta.description = para.slice(0, 240);
      const ageMatch = para.match(/\b(\d{1,3})\s*anos?\b/i);
      if (ageMatch) meta.age = ageMatch[1];
    }

    // Tenta inferir nome em "## [I. CONTENÇÃO]" do BLOCO 2: "Você representa NOME, descrição"
    const nomeMatch = text.match(/Você\s+representa\s+([^,.\n]+)/i);
    if (nomeMatch) meta.name = nomeMatch[1].trim();

    return meta;
  }

  function handlePrepareCharacter() {
    const text = getAssistantText();
    const bloco2 = extractBloco2(text);
    if (!bloco2) {
      alert('Ainda não encontrei o BLOCO 2 (prompt do simulador) na conversa. Continue a entrevista até o entrevistador devolver os dois blocos finais.');
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
      alert('BLOCO 2 ainda não foi gerado pelo entrevistador.');
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
            Ao final, o entrevistador devolve dois blocos — o segundo é o prompt pronto para criar um personagem na biblioteca de Simulação.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {messages.length > 0 && (
            <>
              <button className="btn btn-outline btn-sm" onClick={downloadConversation}>Baixar conversa</button>
              <button className="btn btn-outline btn-sm" onClick={downloadBloco2}>Baixar BLOCO 2 (.md)</button>
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
        <div className="chat-container" style={{ height: 'calc(100vh - 220px)', maxWidth: 960 }}>
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
                    Prompt do simulador <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(BLOCO 2 extraído da entrevista)</em>
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
