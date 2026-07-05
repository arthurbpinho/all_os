import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PatientAvatarButton } from '../components/PatientAvatar';

// Fluxo público do candidato do Processo Seletivo. Renderizado FORA do shell do
// app (App.jsx intercepta /processo-seletivo antes do gate de login), então este
// componente é auto-contido: senha → formulário + termo → simulação → agradecimento.
//
// Invariante crítica: a nota, o feedback qualitativo e a avaliação NUNCA chegam
// ao candidato. A avaliação roda 100% no servidor (POST /api/selecao/finish) e só
// alimenta os logs do avaliador.
//
// Persistência: a sessão EM ANDAMENTO (token do candidato + personagem +
// mensagens + nº de sessão + início) é salva numa chave PRÓPRIA de localStorage
// (PS_KEY), separada do auth global, pra que refresh/sair da página NÃO perca o
// progresso. É limpa ao finalizar. O token efêmero (role candidate) fica só nessa
// chave, então não colide com uma sessão logada aberta no mesmo navegador.

const TERMO = 'Essa é uma simulação de atendimento realizada por Inteligência Artificial simulando o paciente, seu objetivo é tentar atendê-la da melhor maneira possível. Sua avaliação será enviada posteriormente para nossos avaliadores. Ao confirmar, você consente com a utilização da ferramenta de IA, e dos seus textos inseridos serem enviados para os seus servidores e para nossos avaliadores. Utilizaremos os dados para fins de apuração do processo seletivo e de forma anônima para pesquisas de inovação dentro da Associação Allos.';

const AGRADECIMENTO = 'Obrigado por participar do nosso processo seletivo. Após análise dos nossos avaliadores, entraremos em contato via WhatsApp para confirmar se você foi selecionado para a próxima fase.';

// Máximo de sessões com o mesmo paciente (igual à Simulação padrão). Passar de
// sessão permite avaliar a evolução do candidato ao longo do acompanhamento.
const MAX_SELECAO_SESSIONS = 6;
// Mensagem oculta que avisa o paciente que passou uma semana (mesma da Simulação).
const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o paciente), acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana, você já está na sala novamente com o terapeuta.';

// Persistência da sessão em andamento (sobrevive a refresh/saída da página).
const PS_KEY = 'allos_ps_session';
// Tempo máximo da avaliação: 60 min de relógio, contados a partir do início.
const SESSION_LIMIT_MS = 60 * 60 * 1000;
const SESSION_WARN_MS = 5 * 60 * 1000; // fica em alerta nos últimos 5 min

function fmtRemaining(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Mensagens no formato que o /api/selecao/chat espera (só role/content de turnos
// reais; marcadores de sessão, que não têm role, ficam de fora).
function toApiMessages(msgs) {
  return msgs
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }));
}

function Brand() {
  return (
    <div className="selecao-brand">
      <h1>all<span className="accent">_OS</span></h1>
      <p>Processo Seletivo</p>
    </div>
  );
}

export default function ProcessoSeletivo() {
  // Restaura a sessão em andamento (refresh / reabrir a página) SEM flash: lê o
  // localStorage uma única vez, antes dos useState, e usa como valor inicial. Só
  // restaura o passo 'chat' (senha/form são rápidos de refazer).
  const savedRef = useRef(undefined);
  if (savedRef.current === undefined) {
    try {
      const raw = localStorage.getItem(PS_KEY);
      const s = raw ? JSON.parse(raw) : null;
      savedRef.current = (s && s.token && s.step === 'chat' && Array.isArray(s.messages)) ? s : null;
    } catch { savedRef.current = null; }
  }
  const saved = savedRef.current;

  const [step, setStep] = useState(saved ? 'chat' : 'senha'); // senha | form | instrucoes | chat | done

  // Senha
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(false);
  const [senhaError, setSenhaError] = useState('');

  // Formulário
  const [form, setForm] = useState({ nome: '', email: '', whatsapp: '', faculdade: '', periodo: '' });
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState('');

  // Sessão
  const [token, setToken] = useState(saved ? saved.token : '');
  const [character, setCharacter] = useState(saved ? (saved.character || null) : null);
  const [messages, setMessages] = useState(saved ? saved.messages : []); // { role, content, hidden? }
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const [chatError, setChatError] = useState('');
  const [startedAt, setStartedAt] = useState(saved && Number.isFinite(saved.startedAt) ? saved.startedAt : 0);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Sessões (passar sessão, máx. 6) + destaque/comentário das intervenções.
  const [sessionNumber, setSessionNumber] = useState(saved && Number.isFinite(saved.sessionNumber) ? saved.sessionNumber : 1);
  const [skipping, setSkipping] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(false);
  const [highlightTarget, setHighlightTarget] = useState(null); // { idx }
  const [highlightDraft, setHighlightDraft] = useState('');
  // Cronômetro (60 min) — tempo restante em ms, derivado de startedAt.
  const [remainingMs, setRemainingMs] = useState(null);

  const endRef = useRef(null);
  const taRef = useRef(null);
  const doFinishRef = useRef(null); // aponta pra doFinish atual (pro auto-envio do timer)
  const finishGuard = useRef(false); // trava reentrância do finish (timer + clique)

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  // Persiste a sessão a cada mudança relevante (só no chat).
  useEffect(() => {
    if (step !== 'chat' || !token) return;
    try {
      localStorage.setItem(PS_KEY, JSON.stringify({ token, character, messages, sessionNumber, startedAt, step: 'chat' }));
    } catch {
      /* quota / modo privado → segue sem persistir */
    }
  }, [step, token, character, messages, sessionNumber, startedAt]);

  // Retomada: se a página foi recarregada ENQUANTO o paciente respondia (a última
  // mensagem com role é do candidato, sem resposta), re-solicita a resposta pra
  // não deixar a conversa travada. Roda uma vez, só quando restaurou uma sessão.
  useEffect(() => {
    if (!saved || step !== 'chat') return;
    const roleMsgs = (saved.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const last = roleMsgs[roleMsgs.length - 1];
    if (!last || last.role !== 'user') return;
    let cancelled = false;
    setTyping(true);
    (async () => {
      try {
        const data = await api.selecaoChat(saved.token, toApiMessages(saved.messages));
        if (cancelled) return;
        const content = typeof data === 'string' ? data : (data.content || data.message || '');
        setMessages((prev) => [...prev, { role: 'assistant', content, session: saved.sessionNumber || 1 }]);
      } catch (err) {
        if (!cancelled) setChatError(err.message || 'Erro ao retomar a conversa.');
      } finally {
        if (!cancelled) setTyping(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cronômetro de 60 min a partir de startedAt (relógio real — conta mesmo se a
  // pessoa sair e voltar). Ao zerar, envia a avaliação automaticamente.
  useEffect(() => {
    if (step !== 'chat' || !startedAt) { setRemainingMs(null); return; }
    const tick = () => {
      const rem = SESSION_LIMIT_MS - (Date.now() - startedAt);
      setRemainingMs(rem);
      if (rem <= 0 && doFinishRef.current) doFinishRef.current();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, startedAt]);

  function clearSession() {
    try { localStorage.removeItem(PS_KEY); } catch {}
  }

  async function submitSenha(e) {
    e.preventDefault();
    if (checking) return;
    setSenhaError('');
    setChecking(true);
    try {
      await api.selecaoSenha(password);
      setStep('form');
    } catch (err) {
      setSenhaError(err.message || 'Senha incorreta.');
    } finally {
      setChecking(false);
    }
  }

  function onField(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function submitForm(e) {
    e.preventDefault();
    if (starting) return;
    setFormError('');
    const { nome, email, whatsapp, faculdade, periodo } = form;
    if (!nome.trim() || !email.trim() || !whatsapp.trim() || !faculdade.trim() || !periodo.trim()) {
      setFormError('Preencha todos os campos.');
      return;
    }
    if (!consent) {
      setFormError('É necessário aceitar o termo de consentimento.');
      return;
    }
    setStarting(true);
    try {
      const data = await api.selecaoIniciar({
        password,
        nome: nome.trim(),
        email: email.trim(),
        whatsapp: whatsapp.trim(),
        faculdade: faculdade.trim(),
        periodo: periodo.trim(),
        consent: true,
      });
      setToken(data.token);
      setCharacter(data.character);
      // Não entra direto no chat: mostra as instruções primeiro. O cronômetro de
      // 60 min só começa quando o candidato clica em "Começar" (em beginChat).
      setStep('instrucoes');
      setStarting(false);
    } catch (err) {
      // 403 com daysLeft = já fez a avaliação nos últimos 15 dias.
      setFormError(err.message || 'Não foi possível iniciar a avaliação.');
      setStarting(false);
    }
  }

  async function beginChat(tok, char) {
    setStep('chat');
    setStartedAt(Date.now());
    setStarting(false);
    // Mensagem oculta de kickoff: o paciente abre a conversa (mesmo padrão da
    // Simulação). Ela vai ao servidor mas não aparece na tela nem na avaliação.
    const seed = [{ role: 'user', content: 'Iniciar', hidden: true, session: 1 }];
    setMessages(seed);
    setTyping(true);
    try {
      const data = await api.selecaoChat(tok, toApiMessages(seed));
      const content = typeof data === 'string' ? data : (data.content || data.message || '');
      setMessages([...seed, { role: 'assistant', content, session: 1 }]);
    } catch (err) {
      setChatError(err.message || 'Erro ao iniciar a conversa.');
    } finally {
      setTyping(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || typing || skipping || finishing) return;
    const next = [...messages, { role: 'user', content: text, session: sessionNumber }];
    setMessages(next);
    setInput('');
    setChatError('');
    setTyping(true);
    try {
      const data = await api.selecaoChat(token, toApiMessages(next));
      const content = typeof data === 'string' ? data : (data.content || data.message || '');
      setMessages([...next, { role: 'assistant', content, session: sessionNumber }]);
    } catch (err) {
      setChatError(err.message || 'Erro ao enviar a mensagem.');
    } finally {
      setTyping(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // Passar sessão (time skip). O paciente "volta na semana seguinte". Insere um
  // marcador visual e manda a mensagem oculta de virada de semana ao paciente.
  function handleSkip() {
    if (typing || skipping || finishing) return;
    if (sessionNumber >= MAX_SELECAO_SESSIONS) { setSessionLimit(true); return; }
    setConfirmSkip(true);
  }

  async function doSkip() {
    setConfirmSkip(false);
    if (typing || skipping || finishing || sessionNumber >= MAX_SELECAO_SESSIONS) return;
    const newNumber = sessionNumber + 1;
    setSessionNumber(newNumber);
    setSkipping(true);
    setChatError('');
    const marker = { type: 'session-break', sessionNumber: newNumber, stage: 'transitioning' };
    const hiddenSkip = { role: 'user', content: SKIP_PROMPT, hidden: true, session: newNumber };
    const base = messages;
    setMessages([...base, marker, hiddenSkip]);
    setTyping(true);
    const arrive = (m) => (m.type === 'session-break' && m.sessionNumber === newNumber ? { ...m, stage: 'arrived' } : m);
    try {
      const data = await api.selecaoChat(token, toApiMessages([...base, hiddenSkip]));
      const content = typeof data === 'string' ? data : (data.content || data.message || '');
      setMessages((prev) => prev.map(arrive).concat({ role: 'assistant', content, session: newNumber }));
    } catch (err) {
      setChatError(err.message || 'Erro ao passar de sessão.');
      setMessages((prev) => prev.map(arrive));
    } finally {
      setTyping(false);
      setSkipping(false);
    }
  }

  // Destaque + comentário: o candidato marca uma intervenção sua e explica o
  // raciocínio (vai pro log e pesa na avaliação, como na Simulação padrão).
  function openHighlight(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'user' || msg.hidden) return;
    setHighlightTarget({ idx });
    setHighlightDraft(msg.comment || '');
  }
  function saveHighlight() {
    if (!highlightTarget) return;
    setMessages((prev) => prev.map((m, i) => (i === highlightTarget.idx ? { ...m, highlighted: true, comment: highlightDraft.trim() } : m)));
    setHighlightTarget(null);
    setHighlightDraft('');
  }
  function removeHighlight(idx) {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, highlighted: false, comment: '' } : m)));
  }

  async function doFinish() {
    if (finishGuard.current) return; // trava síncrona (timer + clique podem coincidir)
    finishGuard.current = true;
    setFinishing(true);
    setConfirmFinish(false);
    const visible = messages
      .filter((m) => !m.hidden && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content, highlighted: !!m.highlighted, comment: m.comment || '', session: m.session || 1 }));
    const durationSeconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    try {
      await api.selecaoFinish(token, { messages: visible, durationSeconds });
      clearSession();
      setStep('done');
    } catch (err) {
      setChatError(err.message || 'Erro ao finalizar a avaliação.');
      setFinishing(false);
      finishGuard.current = false; // permite tentar de novo
    }
  }
  doFinishRef.current = doFinish; // sempre a versão atual (pro auto-envio do timer)

  const hasUserTurn = messages.some((m) => !m.hidden && m.role === 'user');
  const timeUp = remainingMs != null && remainingMs <= 0;

  // ---- Render ----
  if (step === 'senha') {
    return (
      <div className="selecao-page">
        <div className="selecao-card">
          <Brand />
          <h2>Acesso à avaliação</h2>
          <p className="selecao-sub">Digite a senha que você recebeu para iniciar.</p>
          <form onSubmit={submitSenha} className="admin-form">
            <div>
              <label htmlFor="ps-senha">Senha</label>
              <input
                id="ps-senha"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••"
                autoFocus
              />
            </div>
            {senhaError && <div className="alert error">{senhaError}</div>}
            <button type="submit" className="btn btn-primary" disabled={checking || !password}>
              {checking ? 'Verificando…' : 'Continuar'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (step === 'form') {
    return (
      <div className="selecao-page">
        <div className="selecao-card wide">
          <Brand />
          <h2>Antes de começar</h2>
          <p className="selecao-sub">Preencha seus dados. Eles são usados apenas para o processo seletivo.</p>
          <form onSubmit={submitForm} className="admin-form">
            <div>
              <label htmlFor="ps-nome">Nome e sobrenome</label>
              <input id="ps-nome" name="nome" value={form.nome} onChange={onField} placeholder="Ex: Ana Silva" autoComplete="name" />
            </div>
            <div>
              <label htmlFor="ps-email">E-mail</label>
              <input id="ps-email" name="email" type="email" value={form.email} onChange={onField} placeholder="ana@exemplo.com" autoComplete="email" />
            </div>
            <div>
              <label htmlFor="ps-wa">Número de WhatsApp (com DDD da sua região)</label>
              <input id="ps-wa" name="whatsapp" value={form.whatsapp} onChange={onField} placeholder="(11) 91234-5678" inputMode="tel" autoComplete="tel" />
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: '2 1 200px' }}>
                <label htmlFor="ps-fac">Nome da faculdade</label>
                <input id="ps-fac" name="faculdade" value={form.faculdade} onChange={onField} placeholder="Ex: USP" />
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <label htmlFor="ps-per">Período</label>
                <input id="ps-per" name="periodo" value={form.periodo} onChange={onField} placeholder="Ex: 7º" />
              </div>
            </div>

            <label className="selecao-consent">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{TERMO}</span>
            </label>

            {formError && <div className="alert error">{formError}</div>}

            <button type="submit" className="btn btn-primary btn-lg" disabled={!consent || starting}>
              {starting ? 'Iniciando…' : 'Iniciar avaliação'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (step === 'instrucoes') {
    return (
      <div className="selecao-page">
        <div className="selecao-card wide">
          <Brand />
          <h2>Como funciona a simulação</h2>
          <p className="selecao-sub">Leia com atenção antes de começar. O tempo só começa a contar quando você iniciar.</p>

          <ul className="selecao-instrucoes">
            <li>
              <span className="selecao-instrucoes-ico">🗓</span>
              <div>Você terá até <strong>{MAX_SELECAO_SESSIONS} sessões</strong> com o mesmo paciente, para acompanhar a evolução ao longo do tempo.</div>
            </li>
            <li>
              <span className="selecao-instrucoes-ico">→</span>
              <div>Use o botão <strong>“Passar sessão →”</strong> para avançar para a próxima sessão. <strong>Seu progresso não é perdido</strong> ao passar de sessão.</div>
            </li>
            <li>
              <span className="selecao-instrucoes-ico">★</span>
              <div>Você pode <strong>destacar (★) suas intervenções</strong> e explicar seu raciocínio — isso ajuda os avaliadores a entenderem suas escolhas.</div>
            </li>
            <li>
              <span className="selecao-instrucoes-ico">✓</span>
              <div>Nada é enviado até você clicar em <strong>“Finalizar avaliação”</strong>. Só então o atendimento vai para os avaliadores.</div>
            </li>
            <li>
              <span className="selecao-instrucoes-ico">⏱</span>
              <div>Você tem <strong>60 minutos</strong> no total. Ao esgotar o tempo, a avaliação é enviada automaticamente.</div>
            </li>
          </ul>

          <div className="selecao-instrucoes-aviso">
            <strong>⚠ Não saia desta janela</strong> enquanto estiver fazendo a simulação — principalmente no <strong>celular</strong>. Se você fechar ou trocar de aba/aplicativo, seu progresso pode ser perdido.
          </div>

          <button
            type="button"
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginTop: 18 }}
            onClick={() => beginChat(token, character)}
          >
            Começar simulação
          </button>
        </div>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="selecao-page">
        <div className="selecao-card">
          <Brand />
          <div className="selecao-done">
            <div className="selecao-done-check">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </div>
            <p>{AGRADECIMENTO}</p>
          </div>
        </div>
      </div>
    );
  }

  // step === 'chat'
  return (
    <div className="selecao-chat-wrap">
      <div className="chat-container echo-chat">
        <div className="chat-header">
          <div className="selecao-chat-brand">all<span className="accent">_OS</span> · Processo Seletivo</div>
          {character?.name && (
            <PatientAvatarButton name={character.name} iconUrl={character.photoIcon} fullUrl={character.photoFull} size={42} className="chat-header-avatar" />
          )}
          <div className="chat-title">
            <h3>Sessão com {character?.name || '...'}</h3>
            <div className="chat-status">Simulação de atendimento · Sessão {sessionNumber} de {MAX_SELECAO_SESSIONS}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {remainingMs != null && (
              <div
                className={`timer-chip ${remainingMs <= SESSION_WARN_MS ? 'limit' : ''}`}
                title="Tempo restante da avaliação (60 min). Ao zerar, é enviada automaticamente."
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                <span>{fmtRemaining(remainingMs)}</span>
              </div>
            )}
            <button
              className="btn btn-sm"
              onClick={handleSkip}
              disabled={typing || skipping || finishing || timeUp}
              title={sessionNumber >= MAX_SELECAO_SESSIONS ? `Máximo de ${MAX_SELECAO_SESSIONS} sessões` : 'Encerrar esta sessão e retomar na próxima semana'}
              style={{ background: 'var(--success)', color: '#fff', borderColor: 'var(--success)' }}
            >
              Passar sessão →
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setConfirmFinish(true)}
              disabled={typing || skipping || finishing || timeUp || !hasUserTurn}
              title={hasUserTurn ? 'Encerrar e enviar a avaliação' : 'Converse com o paciente antes de finalizar'}
            >
              Finalizar avaliação
            </button>
          </div>
        </div>

        {timeUp && (
          <div className="alert" style={{ background: 'var(--terra-tint)', color: 'var(--terra)' }}>
            Tempo esgotado (60 min). Sua avaliação está sendo enviada automaticamente…
          </div>
        )}

        {chatError && (
          <div className="alert error">
            {chatError}
            <button onClick={() => setChatError('')} className="close">×</button>
          </div>
        )}

        <div className="chat-messages">
          {messages.filter((m) => !m.hidden).length === 0 && (
            <div className="empty-chat" style={{ marginTop: 80 }}>
              O paciente vai abrir a conversa. Atenda-o da melhor maneira possível.
              Use ★ para destacar e explicar suas intervenções, e "Passar sessão" para avançar o acompanhamento (até {MAX_SELECAO_SESSIONS} sessões).
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.type === 'session-break') {
              const transitioning = msg.stage !== 'arrived';
              return (
                <div key={i} className={`session-break ${transitioning ? 'transitioning' : 'arrived'}`}>
                  <div className="session-break-line" />
                  <div className="session-break-card">
                    <div className="session-break-badge">Sessão #{msg.sessionNumber}</div>
                    {transitioning ? (
                      <>
                        <div className="session-break-text">A sessão foi encerrada. Passando semana…</div>
                        <div className="session-break-loader"><span className="dot" /><span className="dot" /><span className="dot" /></div>
                      </>
                    ) : (
                      <div className="session-break-text">Seu paciente chegou para a sessão da próxima semana, pode iniciar o atendimento.</div>
                    )}
                  </div>
                  <div className="session-break-line" />
                </div>
              );
            }
            if (msg.hidden) return null;
            const isUser = msg.role === 'user';
            return (
              <div key={i} className={`chat-message-row ${msg.role} ${msg.highlighted ? 'highlighted' : ''}`}>
                <div className="chat-message-author">
                  {msg.highlighted && <span className="star-inline">★</span>} {isUser ? 'Você' : (character?.name || 'Paciente')}
                </div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
                {isUser && !finishing && (
                  <div className="message-tools">
                    {msg.highlighted ? (
                      <>
                        <button className="tool-btn active" onClick={() => openHighlight(i)} title="Editar destaque">★</button>
                        <button className="tool-btn" onClick={() => removeHighlight(i)} title="Remover destaque">×</button>
                      </>
                    ) : (
                      <button className="tool-btn" onClick={() => openHighlight(i)} title="Destacar e explicar esta intervenção">★</button>
                    )}
                  </div>
                )}
                {isUser && msg.highlighted && msg.comment && (
                  <div className="highlight-comment">{`{${msg.comment}}`}</div>
                )}
              </div>
            );
          })}
          {typing && (
            <div className="chat-message-row assistant">
              <div className="chat-message-author">{character?.name || 'Paciente'}</div>
              <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
                <span className="loading-dots">Pensando</span>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="chat-input-area">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={timeUp ? 'Tempo esgotado — enviando…' : 'Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha'}
            rows={1}
            disabled={typing || finishing || timeUp}
          />
          <button
            type="button"
            className="icon-btn primary"
            onClick={send}
            disabled={!input.trim() || typing || finishing || timeUp}
            title="Enviar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>

      {confirmFinish && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmFinish(false); }}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <h3>Finalizar avaliação?</h3>
            <p style={{ color: 'var(--ink-soft)', marginTop: -6, marginBottom: 16 }}>
              Ao finalizar, o atendimento é encerrado e enviado para os avaliadores. Você não poderá refazê-lo.
            </p>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setConfirmFinish(false)} disabled={finishing}>Continuar atendimento</button>
              <button className="btn btn-primary" onClick={doFinish} disabled={finishing}>
                {finishing ? 'Enviando…' : 'Finalizar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSkip && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmSkip(false); }}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <h3>Passar para a próxima sessão?</h3>
            <p style={{ color: 'var(--ink-soft)', marginTop: -6, marginBottom: 16 }}>
              A sessão de hoje será encerrada e o paciente voltará na semana seguinte — você continua o acompanhamento.
              (Sessão {sessionNumber} de {MAX_SELECAO_SESSIONS}.)
            </p>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setConfirmSkip(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={doSkip}>Passar sessão</button>
            </div>
          </div>
        </div>
      )}

      {sessionLimit && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setSessionLimit(false); }}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <h3>Limite de sessões</h3>
            <p style={{ color: 'var(--ink-soft)', marginTop: -6, marginBottom: 16 }}>
              Você atingiu o máximo de {MAX_SELECAO_SESSIONS} sessões com este paciente. Finalize a avaliação para enviá-la aos avaliadores.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={() => setSessionLimit(false)}>Entendi</button>
            </div>
          </div>
        </div>
      )}

      {highlightTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setHighlightTarget(null); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Destacar intervenção</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginBottom: 14 }}>
              Explique por que você fez essa intervenção — isso ajuda os avaliadores a entenderem seu raciocínio clínico. <em>(opcional)</em>
            </p>
            <textarea
              value={highlightDraft}
              onChange={(e) => setHighlightDraft(e.target.value)}
              placeholder="Ex: reformulei para checar a hipótese, o paciente reagiu emocionalmente…"
              style={{ minHeight: 120, width: '100%' }}
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
