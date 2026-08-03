import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { downloadText } from '../logFiles';

// Simulação Independente — laboratório de PRICING do PACIENTE (supervisor/admin).
//
// Irmão da aba "Avaliar Sessão", mas do outro lado: aqui roda a IA que CONVERSA
// com o aluno (o personagem), não o avaliador. A diferença de fluxo é que o custo
// aparece em TEMPO REAL — cada turno traz tokens, custo em USD e latência, e a
// barra do topo soma tudo enquanto a conversa acontece. Não há avaliador: o que
// se mede é custo × qualidade da FALA do paciente.
//
// O modelo e o effort podem ser trocados NO MEIO da conversa: o histórico é o
// mesmo, então dá pra comparar como cada modelo responde ao mesmo contexto. O
// custo é contabilizado por modelo (quebra na barra do topo).

// Quantos turnos tem uma sessão típica de atendimento — base da projeção de custo.
const TURNOS_SESSAO = 40;

function fmtUSD(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  return '$' + (usd < 0.01 ? usd.toFixed(6) : usd.toFixed(4));
}
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}
function fmtSeg(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}
function zeroTotais() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}
function somaTotais(a, b) {
  return {
    input: a.input + (b.input || 0),
    cacheRead: a.cacheRead + (b.cacheRead || 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite || 0),
    output: a.output + (b.output || 0),
    reasoning: a.reasoning + (b.reasoning || 0),
  };
}

// Relatório .txt: resumo de custo, quebra por modelo, tabela turno a turno e a
// transcrição inteira (pra julgar a QUALIDADE junto do custo).
function buildSimReport({ caso, turnos, messages, agregado, porModelo }) {
  const L = [];
  L.push('SIMULAÇÃO INDEPENDENTE — RELATÓRIO DE CUSTO × QUALIDADE');
  L.push('='.repeat(56));
  L.push(`Personagem: ${caso || '—'}`);
  L.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  L.push(`Turnos do paciente: ${turnos.length}`);
  L.push('');
  L.push('— CUSTO TOTAL —');
  L.push(`Total: ${agregado.custoUsd != null ? '$' + agregado.custoUsd.toFixed(6) : 'n/d'}`);
  if (turnos.length) {
    L.push(`Média por turno: ${agregado.custoUsd != null ? '$' + (agregado.custoUsd / turnos.length).toFixed(6) : 'n/d'}`);
    if (agregado.custoUsd != null) {
      L.push(`Projeção de uma sessão de ${TURNOS_SESSAO} turnos (ritmo do último turno): $${agregado.projecao.toFixed(6)}`);
    }
  }
  L.push(`Tokens: ${agregado.totais.input} input · ${agregado.totais.cacheRead} cache (leitura) · ${agregado.totais.cacheWrite} cache (escrita) · ${agregado.totais.output} output (${agregado.totais.reasoning} reasoning)`);
  L.push('');
  L.push('— POR MODELO —');
  for (const m of porModelo) {
    L.push(`${m.label} · effort ${m.efforts.join('/')} — ${m.turnos} turno(s), ${m.custoUsd != null ? '$' + m.custoUsd.toFixed(6) : 'n/d'}, ${Math.round(m.latenciaMedia)}ms/turno em média`);
  }
  L.push('');
  L.push('— TURNO A TURNO —');
  turnos.forEach((t, i) => {
    L.push(`#${i + 1} ${t.modelKey} (${t.effort}) — ${t.custo ? '$' + t.custo.usd.toFixed(6) : 'n/d'} · ${t.totais.input} in · ${t.totais.cacheRead} cache · ${t.totais.output} out · ${t.latenciaMs}ms`);
  });
  L.push('');
  L.push('— TRANSCRIÇÃO —');
  for (const m of messages) {
    if (m.isSystem) continue;
    L.push(`${m.role === 'user' ? 'TERAPEUTA' : 'PACIENTE'}: ${m.content}`);
    L.push('');
  }
  return L.join('\n');
}

export default function SimulacaoIndependente({ user }) {
  const [catalogo, setCatalogo] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [casoId, setCasoId] = useState('');
  const [modelKey, setModelKey] = useState('gpt-5.4-mini');
  const [effort, setEffort] = useState('none');

  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState([]); // { role, content, isSystem?, turno? }
  const [turnos, setTurnos] = useState([]);     // instrumentação de cada resposta do paciente
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.simIndependenteModelos(), api.getFreeplay()])
      .then(([cat, list]) => {
        if (cancelled) return;
        const modelos = (cat && Array.isArray(cat.modelos)) ? cat.modelos : [];
        setCatalogo(modelos);
        if (modelos.length && !modelos.some((m) => m.key === modelKey)) {
          setModelKey(modelos[0].key);
          setEffort(modelos[0].efforts[0]);
        }
        setCharacters(
          (Array.isArray(list) ? list : [])
            .map((c) => ({ id: c.id, name: c.name, age: c.age }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR')),
        );
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Erro ao carregar modelos e personagens.'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const modelInfo = useMemo(() => catalogo.find((m) => m.key === modelKey) || null, [catalogo, modelKey]);
  const caso = useMemo(() => characters.find((c) => String(c.id) === String(casoId)) || null, [characters, casoId]);

  function changeModel(key) {
    setModelKey(key);
    const m = catalogo.find((x) => x.key === key);
    if (m && !m.efforts.includes(effort)) setEffort(m.efforts[0]);
  }

  // Agregado ao vivo: soma de tokens, custo e projeção.
  const agregado = useMemo(() => {
    let totais = zeroTotais();
    let custoUsd = 0;
    let semPreco = false;
    for (const t of turnos) {
      totais = somaTotais(totais, t.totais || {});
      if (t.custo && Number.isFinite(t.custo.usd)) custoUsd += t.custo.usd;
      else semPreco = true;
    }
    const ultimo = turnos.length ? turnos[turnos.length - 1] : null;
    const ultimoUsd = ultimo && ultimo.custo ? ultimo.custo.usd : 0;
    // Projeção: o custo por turno CRESCE (o histórico entra no input de novo a
    // cada turno), então extrapolar pela média subestima. Usamos o ritmo do
    // último turno para os turnos que faltam — estimativa conservadora.
    const restantes = Math.max(0, TURNOS_SESSAO - turnos.length);
    return {
      totais,
      custoUsd: semPreco && custoUsd === 0 ? null : custoUsd,
      semPreco,
      projecao: custoUsd + ultimoUsd * restantes,
      ultimo,
    };
  }, [turnos]);

  // Quebra por modelo — o ponto da aba: comparar dois modelos no mesmo caso.
  const porModelo = useMemo(() => {
    const map = new Map();
    for (const t of turnos) {
      const cur = map.get(t.modelKey) || {
        key: t.modelKey,
        label: (catalogo.find((m) => m.key === t.modelKey) || {}).label || t.modelKey,
        turnos: 0, custoUsd: 0, semPreco: false, latenciaTotal: 0, efforts: new Set(),
      };
      cur.turnos += 1;
      cur.latenciaTotal += t.latenciaMs || 0;
      cur.efforts.add(t.effort);
      if (t.custo && Number.isFinite(t.custo.usd)) cur.custoUsd += t.custo.usd;
      else cur.semPreco = true;
      map.set(t.modelKey, cur);
    }
    return [...map.values()].map((m) => ({
      ...m,
      efforts: [...m.efforts],
      custoUsd: m.semPreco && m.custoUsd === 0 ? null : m.custoUsd,
      latenciaMedia: m.turnos ? m.latenciaTotal / m.turnos : 0,
      custoPorTurno: m.custoUsd != null && m.turnos ? m.custoUsd / m.turnos : null,
    }));
  }, [turnos, catalogo]);

  // Uma chamada ao personagem. Recebe o histórico a enviar e devolve o turno.
  const askPatient = useCallback(async (history) => {
    const payload = {
      casoId,
      model: modelKey,
      effort,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    };
    const data = await api.simIndependenteChat(payload);
    return data;
  }, [casoId, modelKey, effort]);

  async function handleStart() {
    if (!casoId) { setError('Selecione o personagem.'); return; }
    setError('');
    // Mesmo kickoff da produção: o paciente abre a conversa. O turno é real e
    // portanto entra na conta do custo.
    const kickoff = { role: 'user', content: 'Iniciar', isSystem: true };
    setMessages([kickoff]);
    setStarted(true);
    setIsTyping(true);
    try {
      const data = await askPatient([kickoff]);
      setMessages([kickoff, { role: 'assistant', content: data.content, turno: data.turno }]);
      setTurnos([data.turno]);
    } catch (err) {
      setError(err.message || 'Erro ao iniciar a conversa.');
      setMessages([]);
      setStarted(false);
    } finally {
      setIsTyping(false);
    }
  }

  async function sendMessage(text) {
    const content = (text || '').trim();
    if (!content || isTyping) return;
    setError('');
    setInput('');
    const userMsg = { role: 'user', content };
    const history = [...messages, userMsg];
    setMessages(history);
    setIsTyping(true);
    try {
      const data = await askPatient(history);
      setMessages([...history, { role: 'assistant', content: data.content, turno: data.turno }]);
      setTurnos((prev) => [...prev, data.turno]);
    } catch (err) {
      setError(err.message || 'Erro ao falar com o personagem.');
      // Devolve o texto ao campo pra não perder a intervenção digitada.
      setMessages(messages);
      setInput(content);
    } finally {
      setIsTyping(false);
    }
  }

  // Regerar a última fala do paciente com o modelo/effort ATUAL — o jeito direto
  // de comparar dois modelos no MESMO contexto. O custo da resposta descartada
  // continua na conta (foi gasto de verdade).
  async function regenerate() {
    if (isTyping) return;
    const lastIdx = [...messages].reverse().findIndex((m) => m.role === 'assistant');
    if (lastIdx === -1) return;
    const cut = messages.length - 1 - lastIdx;
    const history = messages.slice(0, cut);
    if (!history.length) return;
    setError('');
    setIsTyping(true);
    try {
      const data = await askPatient(history);
      setMessages([...history, { role: 'assistant', content: data.content, turno: data.turno }]);
      setTurnos((prev) => [...prev, data.turno]);
    } catch (err) {
      setError(err.message || 'Erro ao regerar a resposta.');
    } finally {
      setIsTyping(false);
    }
  }

  function doReset() {
    setConfirmReset(false);
    setStarted(false);
    setMessages([]);
    setTurnos([]);
    setInput('');
    setError('');
  }

  function baixarRelatorio() {
    const date = new Date().toISOString().slice(0, 10);
    const nome = `simulacao-custo-${(caso && caso.name ? caso.name : 'caso').replace(/\s+/g, '_')}-${date}.txt`;
    downloadText(nome, buildSimReport({
      caso: caso ? `${caso.name}${caso.age ? `, ${caso.age}` : ''}` : '',
      turnos, messages, agregado, porModelo,
    }));
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  // ── Tela inicial ──────────────────────────────────────────────────────────
  if (!started) {
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Simulação Independente</div>
          <h2><Typewriter text="Custo do " /><span className="accent"><Typewriter text="Personagem" delayStart={520} /></span></h2>
          <p>
            Laboratório de teste da IA que <strong>conversa com o aluno</strong>: escolha o personagem, o{' '}
            <strong>modelo</strong> e o <strong>effort</strong>, e converse. O <strong>custo aparece em tempo real</strong>,
            turno a turno — sem avaliador. Dá para trocar de modelo no meio da conversa para comparar as respostas
            no mesmo contexto.
          </p>
          <div className="ornament" />
        </div>

        <div className="avaliacao-intro">
          <div>
            <label htmlFor="sim-caso">Personagem <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
            <select id="sim-caso" value={casoId} onChange={(e) => setCasoId(e.target.value)} style={{ width: '100%' }}>
              <option value="">— selecione o personagem —</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.age ? `, ${c.age}` : ''}</option>
              ))}
            </select>
            <small style={{ display: 'block', marginTop: 6, color: 'var(--marrs-dark)', fontSize: 12 }}>
              É o mesmo prompt de personagem da produção — o que você lê aqui é o que o aluno leria.
            </small>
          </div>

          <div className="aval-controls">
            <div>
              <label htmlFor="sim-model">Modelo</label>
              <select id="sim-model" value={modelKey} onChange={(e) => changeModel(e.target.value)} style={{ width: '100%' }}>
                {catalogo.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="sim-effort">Effort</label>
              <select id="sim-effort" value={effort} onChange={(e) => setEffort(e.target.value)} style={{ width: '100%' }}>
                {(modelInfo ? modelInfo.efforts : []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          </div>

          {modelInfo && (
            <div className="sim-model-card">
              <div className="sim-model-card-head">
                <strong>{modelInfo.label}</strong>
                <span className="sim-provider-chip">{modelInfo.provider}</span>
                {modelInfo.nota && <span className="sim-model-nota">{modelInfo.nota}</span>}
              </div>
              {modelInfo.precos ? (
                <div className="sim-model-precos">
                  por 1M tokens: <strong>${modelInfo.precos.input}</strong> input ·{' '}
                  <strong>${modelInfo.precos.cacheRead}</strong> cache (leitura) ·{' '}
                  <strong>${modelInfo.precos.cacheWrite}</strong> cache (escrita) ·{' '}
                  <strong>${modelInfo.precos.output}</strong> output
                </div>
              ) : (
                <div className="sim-model-precos">Sem preço na tabela — a tela mostrará tokens, mas não custo.</div>
              )}
            </div>
          )}

          {error && <div className="alert error">{error}</div>}

          <button className="btn btn-primary btn-lg" onClick={handleStart} disabled={!casoId || !catalogo.length}>
            Iniciar conversa
          </button>
        </div>
      </div>
    );
  }

  // ── Tela de conversa (com HUD de custo ao vivo) ────────────────────────────
  const nTurnos = turnos.length;
  return (
    <div className="chat-container">
      <div className="chat-header">
        <button onClick={() => setConfirmReset(true)} className="btn btn-outline btn-sm">Reiniciar</button>
        <div className="chat-title">
          <h3>{caso ? caso.name : 'Personagem'}</h3>
          <div className="chat-status">Simulação Independente · teste de custo</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={modelKey} onChange={(e) => changeModel(e.target.value)} className="sim-inline-select" title="Trocar o modelo do próximo turno">
            {catalogo.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <select value={effort} onChange={(e) => setEffort(e.target.value)} className="sim-inline-select" title="Effort do próximo turno">
            {(modelInfo ? modelInfo.efforts : []).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={isTyping || !nTurnos} title="Refazer a última fala do paciente com o modelo selecionado agora">
            Regerar
          </button>
          <button className="btn btn-outline btn-sm" onClick={baixarRelatorio} disabled={!nTurnos}>Relatório</button>
        </div>
      </div>

      {/* HUD de custo — atualiza a cada turno */}
      <div className="sim-hud">
        <div className="sim-hud-main">
          <div className="sim-hud-total">
            <span className="sim-hud-num">{fmtUSD(agregado.custoUsd)}</span>
            <span className="sim-hud-label">custo acumulado · {nTurnos} {nTurnos === 1 ? 'turno' : 'turnos'}</span>
          </div>
          <div className="sim-hud-stats">
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{nTurnos && agregado.custoUsd != null ? fmtUSD(agregado.custoUsd / nTurnos) : '—'}</span>
              <span className="sim-hud-stat-key">média/turno</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{agregado.ultimo && agregado.ultimo.custo ? fmtUSD(agregado.ultimo.custo.usd) : '—'}</span>
              <span className="sim-hud-stat-key">último turno</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{agregado.ultimo ? fmtSeg(agregado.ultimo.latenciaMs) : '—'}</span>
              <span className="sim-hud-stat-key">latência</span>
            </div>
            <div className="sim-hud-stat" title={`Custo estimado de uma sessão de ${TURNOS_SESSAO} turnos, mantendo o ritmo do último turno`}>
              <span className="sim-hud-stat-val">{agregado.custoUsd != null ? fmtUSD(agregado.projecao) : '—'}</span>
              <span className="sim-hud-stat-key">sessão de {TURNOS_SESSAO}</span>
            </div>
          </div>
        </div>
        <div className="sim-hud-tokens">
          {fmtTok(agregado.totais.input)} input · {fmtTok(agregado.totais.cacheRead)} cache (leitura)
          {agregado.totais.cacheWrite ? ` · ${fmtTok(agregado.totais.cacheWrite)} cache (escrita)` : ''}
          {' '}· {fmtTok(agregado.totais.output)} output
          {agregado.totais.reasoning ? ` (${fmtTok(agregado.totais.reasoning)} reasoning)` : ''}
        </div>
        {agregado.totais.cacheWrite > 0 && (
          <div className="sim-hud-nota">
            A <strong>escrita de cache</strong> (1,25× o input, cobrada só pela Anthropic) concentra-se no{' '}
            <strong>1º turno</strong> e se paga do 2º em diante, quando o mesmo prefixo é lido a 0,1×. Compare
            modelos pelo custo do <strong>último turno</strong>, não pelo primeiro.
          </div>
        )}
        {porModelo.length > 1 && (
          <div className="sim-hud-models">
            {porModelo.map((m) => (
              <div key={m.key} className="sim-hud-model">
                <strong>{m.label}</strong>
                <span>{m.efforts.join('/')}</span>
                <span>{m.turnos} {m.turnos === 1 ? 'turno' : 'turnos'}</span>
                <span>{fmtUSD(m.custoUsd)}</span>
                <span>{m.custoPorTurno != null ? fmtUSD(m.custoPorTurno) + '/turno' : '—'}</span>
                <span>{Math.round(m.latenciaMedia)}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="alert error">
          {error}
          <button onClick={() => setError('')} className="close">×</button>
        </div>
      )}

      <div className="chat-messages">
        {messages.map((msg, i) => {
          if (msg.isSystem) return null;
          const t = msg.turno;
          return (
            <div key={i} className={`chat-message-row ${msg.role}`}>
              <div className="chat-message-author">
                {msg.role === 'user' ? (user?.name || 'Terapeuta') : (caso ? caso.name : 'Paciente')}
              </div>
              <div className={`chat-message ${msg.role}`}>{msg.content}</div>
              {t && (
                <div className="sim-turn-chip">
                  <strong>{t.custo ? fmtUSD(t.custo.usd) : 'custo n/d'}</strong>
                  <span>{t.modelKey} · {t.effort}</span>
                  <span>{fmtTok(t.totais.input)} in · {fmtTok(t.totais.cacheRead)} cache · {fmtTok(t.totais.output)} out</span>
                  <span>{fmtSeg(t.latenciaMs)}</span>
                </div>
              )}
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{caso ? caso.name : 'Paciente'}</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}>
              <span className="loading-dots">Respondendo</span>
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

      {confirmReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmReset(false); }}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <h3>Reiniciar teste</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
              A conversa e a contagem de custo desta sessão serão <strong>perdidas</strong>. Baixe o relatório antes se
              quiser guardar os números.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmReset(false)}>Cancelar</button>
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
