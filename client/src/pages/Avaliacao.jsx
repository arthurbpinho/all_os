import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { useWakeLock } from '../useWakeLock';
import { downloadText } from '../logFiles';

// Avaliação Independente — laboratório de PRICING (supervisor/admin). Alterna o
// PROMPT (v16-2 / v18-25 / pipeline v25), o MODELO (GPT 5.5 / 5.4 / 5.4-mini) e o
// EFFORT (low/medium/high); roda SÍNCRONO ou via BATCH (50% off) com uma fila.
// Mostra a nota + o CUSTO EXATO (tokens × preço do modelo) e permite baixar um
// relatório com tudo. Isolado do avaliador de produção e da simulação.

const EVALUATORS = [
  { id: 'v25', label: 'v25 · pipeline (14 nós)' },
  { id: 'v16-2', label: 'v16.2 · 6 critérios' },
  { id: 'v18-25', label: 'v18.25 · 15 critérios' },
];
const MODELS = [
  { key: 'gpt-5.5', label: 'GPT 5.5', provider: 'openai' },
  { key: 'gpt-5.4', label: 'GPT 5.4', provider: 'openai' },
  { key: 'gpt-5.4-mini', label: 'GPT 5.4 mini', provider: 'openai' },
  { key: 'glm-5.2', label: 'GLM 5.2 (z.ai)', provider: 'glm' },
];
// O "effort" muda por provedor: GPT usa low/medium/high; GLM (z.ai) usa
// disabled (thinking off) / high / max.
const EFFORTS_BY_PROVIDER = {
  openai: ['low', 'medium', 'high'],
  glm: ['disabled', 'high', 'max'],
};
function providerOf(modelKey) {
  const m = MODELS.find((x) => x.key === modelKey);
  return m ? m.provider : 'openai';
}
function effortsFor(modelKey) {
  return EFFORTS_BY_PROVIDER[providerOf(modelKey)] || EFFORTS_BY_PROVIDER.openai;
}

function evaluatorLabel(id) {
  const e = EVALUATORS.find((x) => x.id === id);
  return e ? e.label : (id || '—');
}
function statusLabel(s) {
  if (s === 'completed') return 'Pronto';
  if (s === 'error') return 'Erro';
  return 'Na fila';
}
function confLabel(c) {
  if (c === 'alta') return 'confiança alta';
  if (c === 'média' || c === 'media') return 'confiança média';
  if (c === 'baixa') return 'confiança baixa';
  return 'sem confiança';
}
function fmtUSD(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  return '$' + usd.toFixed(4);
}
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}
function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Relatório .txt com TUDO: avaliador/prompt, modelo, effort, batch, custo, tokens,
// nota, notas por critério, feedback e (quando disponível) o log de entrada.
function buildReport(result, log) {
  const inst = result.instrumentacao || {};
  const c = inst.custo;
  const t = inst.totais || {};
  const L = [];
  L.push('AVALIAÇÃO INDEPENDENTE — RELATÓRIO');
  L.push('='.repeat(42));
  L.push(`Avaliador (prompt): ${evaluatorLabel(result.evaluator)}`);
  L.push(`Modelo: ${inst.model || '—'}`);
  L.push(`Effort: ${inst.effort || '—'}`);
  L.push(`Batch (50% off): ${inst.batch ? 'sim' : 'não'}`);
  if (result.casoNome) L.push(`Caso: ${result.casoNome}`);
  L.push('');
  L.push(`NOTA FINAL: ${result.notaFinal != null ? result.notaFinal + '/100' : '— (não avaliável)'}`);
  L.push('');
  L.push('— CUSTO —');
  if (c) {
    L.push(`Total: $${c.usd.toFixed(6)}`);
    L.push(`  input:  $${c.componentes.input.toFixed(6)}`);
    L.push(`  cache:  $${c.componentes.cached.toFixed(6)}`);
    L.push(`  output: $${c.componentes.output.toFixed(6)}`);
    L.push(`Preços/MTok: input $${c.precosPorMTok.input} · cache $${c.precosPorMTok.cached} · output $${c.precosPorMTok.output}${inst.batch ? ' (×0,5 batch)' : ''}`);
  } else {
    L.push('Custo: n/d (modelo sem preço na tabela)');
  }
  L.push('');
  L.push('— TOKENS —');
  L.push(`input (fresco): ${t.input || 0} · cache: ${t.cached || 0} · output: ${t.output || 0} (reasoning: ${t.reasoning || 0})`);
  L.push('');
  L.push('— NOTAS POR CRITÉRIO —');
  if (Array.isArray(result.partes)) {
    for (const p of result.partes) {
      L.push(`${p.num} · ${p.nome}: ${Number.isFinite(p.nota) ? p.nota + '/10' : '—'} [${p.confianca || 'sem confiança'}]${p.incluido ? '' : ' (fora da nota)'}`);
    }
  } else if (Array.isArray(result.notasDetalhe)) {
    for (const d of result.notasDetalhe) L.push(`${d.num} · ${d.nome}: ${d.nota}`);
  }
  L.push('');
  L.push('— FEEDBACK —');
  L.push(result.feedbackAluno || '(sem feedback)');
  if (result.reasoning) {
    L.push('');
    L.push('— RACIOCÍNIO (SUPERVISOR) —');
    L.push(result.reasoning);
  }
  if (log && log.trim()) {
    L.push('');
    L.push('— LOG DE ENTRADA —');
    L.push(log);
  }
  return L.join('\n');
}

export default function Avaliacao({ user }) {
  const [transcript, setTranscript] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  // Alternadores
  const [evaluator, setEvaluator] = useState('v25');
  const [model, setModel] = useState('gpt-5.5');
  const [effort, setEffort] = useState('medium');
  const [useBatch, setUseBatch] = useState(false);
  // Fluxo
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [queuedMsg, setQueuedMsg] = useState('');
  const [result, setResult] = useState(null);
  const [view, setView] = useState('supervisor'); // 'supervisor' | 'aluno'
  // Fila
  const [fila, setFila] = useState([]);
  const [filaOpen, setFilaOpen] = useState(false);
  const fileInputRef = useRef(null);

  useWakeLock(loading);

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
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const refreshFila = useCallback(() => {
    api.avaliacaoFila().then((list) => setFila(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  // Poll da fila (badge + jobs que ficam prontos). Leve, é ferramenta interna.
  useEffect(() => {
    refreshFila();
    const id = setInterval(refreshFila, 12000);
    return () => clearInterval(id);
  }, [refreshFila]);

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.txt')) { setError('Apenas arquivos .txt são aceitos.'); return; }
    const MAX = 2 * 1024 * 1024;
    if (file.size > MAX) { setError(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo: 2 MB.`); return; }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => setTranscript(ev.target.result);
    reader.readAsText(file);
  }

  // Job local (não-batch): a run roda em background no servidor (evita o timeout
  // 524 do Cloudflare em avaliações demoradas); aqui só ficamos perguntando por
  // ela até sair da fila, mantendo a tela de "avaliando" como antes.
  async function pollLocalJob(jobId) {
    const POLL_MS = 3000;
    const MAX_TRIES = 400; // teto de segurança (~20min)
    for (let i = 0; i < MAX_TRIES; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let list;
      try { list = await api.avaliacaoFila(); } catch { continue; }
      const job = Array.isArray(list) ? list.find((j) => j.id === jobId) : null;
      if (!job) continue;
      if (job.status === 'completed' && job.result) {
        setResult(job.result);
        setLoading(false);
        refreshFila();
        return;
      }
      if (job.status === 'error') {
        setError(job.error || 'Erro ao rodar a avaliação.');
        setLoading(false);
        refreshFila();
        return;
      }
    }
    setError('A avaliação está demorando demais. Confira em "Fila de avaliações" mais tarde.');
    setLoading(false);
  }

  async function handleStart() {
    if (!selectedCharacterId) { setError('Selecione o caso correspondente (necessário para o Bloco 1).'); return; }
    if (!transcript.trim()) { setError('Cole ou envie a transcrição da sessão.'); return; }
    setError('');
    setQueuedMsg('');
    setResult(null);
    const isBatch = useBatch;
    if (isBatch) setSubmitting(true); else setLoading(true);
    try {
      const data = await api.avaliacaoIndependente({
        log: transcript, casoId: selectedCharacterId, evaluator, model, effort, batch: isBatch,
      });
      if (data && data.queued && data.local) {
        await pollLocalJob(data.jobId);
      } else if (data && data.queued) {
        setQueuedMsg('Avaliação enviada para a fila (batch — ~50% mais barato, assíncrono). Ela aparece em "Fila de avaliações" quando o lote volta.');
        setFilaOpen(true);
        refreshFila();
        setLoading(false);
      } else {
        setResult(data);
        setLoading(false);
      }
    } catch (err) {
      setError(err.message || 'Erro ao rodar a avaliação.');
      setLoading(false);
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setResult(null);
    setView('supervisor');
    setError('');
    setQueuedMsg('');
  }

  function loadJob(job) {
    if (!job || !job.result) return;
    setResult(job.result);
    setView('supervisor');
    setFilaOpen(false);
    setError('');
  }

  function downloadReport(res, log) {
    const date = new Date().toISOString().slice(0, 10);
    const name = `avaliacao-${res.evaluator || 'run'}-${(res.instrumentacao && res.instrumentacao.model) || ''}-${date}.txt`.replace(/\s+/g, '_');
    downloadText(name, buildReport(res, log));
  }

  const pendingCount = fila.filter((j) => j.status === 'processing' || j.status === 'queued').length;

  // ── Botão flutuante + painel da Fila (presente em todas as telas) ──
  const filaUI = (
    <>
      <button className="aval-fila-btn" onClick={() => { setFilaOpen((o) => !o); refreshFila(); }}>
        Fila de avaliações
        {pendingCount > 0 && <span className="aval-fila-badge">{pendingCount}</span>}
      </button>
      {filaOpen && (
        <div className="aval-fila-panel">
          <div className="aval-fila-head">
            <strong>Fila de avaliações</strong>
            <button className="close" onClick={() => setFilaOpen(false)}>×</button>
          </div>
          <div className="aval-fila-body">
            {fila.length === 0 ? (
              <div className="aval-fila-empty">Nenhuma avaliação em batch ainda. Marque "Usar Batch" ao iniciar.</div>
            ) : fila.map((j) => {
              const cst = j.result && j.result.instrumentacao && j.result.instrumentacao.custo;
              return (
                <div key={j.id} className="aval-fila-job">
                  <div className="aval-fila-job-top">
                    <span className={`aval-job-status ${j.status}`}>{statusLabel(j.status)}</span>
                    <span className="aval-fila-job-caso">{j.casoNome || '—'}</span>
                    <span className="aval-fila-job-time">{fmtDate(j.createdAt)}</span>
                  </div>
                  <div className="aval-fila-job-meta">
                    {evaluatorLabel(j.evaluator)} · {j.model} · {j.effort}
                    {j.status === 'completed' && j.result ? ` · nota ${j.result.notaFinal ?? '—'}${cst ? ' · ' + fmtUSD(cst.usd) : ''}` : ''}
                    {j.error ? ` · ${j.error}` : ''}
                  </div>
                  {j.status === 'completed' && j.result && (
                    <div className="aval-fila-job-actions">
                      <button className="btn btn-outline btn-sm" onClick={() => loadJob(j)}>Ver</button>
                      <button className="btn btn-outline btn-sm" onClick={() => downloadReport(j.result, '')}>Baixar</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  // ── Tela de carregamento (sync) ──
  if (loading) {
    const isPipe = evaluator === 'v25';
    return (
      <div>
        <div className="post-session">
          <div className="page-header">
            <div className="eyebrow">Avaliação Independente</div>
            <h2>Avaliando a <span className="accent">sessão</span></h2>
            <p>{isPipe ? 'Cada critério é avaliado por um nó independente, em paralelo.' : 'Rodando o avaliador escolhido.'} Pode levar alguns segundos.</p>
            <div className="ornament" />
          </div>
          <div className="card evaluating-card">
            <div className="evaluating-orb">
              <div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" />
            </div>
            <div className="evaluating-status">
              <div className="evaluating-line"><span className="dot active" /> Lendo o Bloco 1 do caso e o log</div>
              <div className="evaluating-line"><span className="dot active" /> {isPipe ? '14 nós avaliando, um por critério' : 'Avaliando os critérios'}</div>
              <div className="evaluating-line"><span className="dot pulse" /> Calculando a nota e o feedback</div>
            </div>
          </div>
        </div>
        {filaUI}
      </div>
    );
  }

  // ── Tela de resultado ──
  if (result) {
    const inst = result.instrumentacao;
    const isPipe = Array.isArray(result.partes);
    const incluidos = isPipe ? result.partes.filter((p) => p.incluido).length : 0;
    const numNotas = Array.isArray(result.notasDetalhe) ? result.notasDetalhe.filter((d) => typeof d.nota === 'number').length : 0;
    const naNotas = Array.isArray(result.notasDetalhe) ? result.notasDetalhe.filter((d) => d.nota === 'NA').length : 0;
    return (
      <div>
        <div className="page-header with-action">
          <div>
            <div className="eyebrow">Avaliação Independente · {evaluatorLabel(result.evaluator)}</div>
            <h2>Resultado da <span className="accent">avaliação</span></h2>
            <p>{result.casoNome ? `Caso: ${result.casoNome}` : ''}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={() => downloadReport(result, transcript)}>Baixar relatório (.txt)</button>
            <button className="btn btn-outline" onClick={handleReset}>Nova avaliação</button>
          </div>
        </div>

        {inst && inst.model && (
          <div className="v25-modelbar">
            Avaliador: <strong>{evaluatorLabel(result.evaluator)}</strong>
            {' '}· Modelo: <strong>{inst.model}</strong>
            {inst.effort ? <> · effort: <strong>{inst.effort}</strong></> : null}
            {inst.batch ? <> · <strong>batch (50% off)</strong></> : null}
            {inst.custo
              ? <> · custo: <strong>{fmtUSD(inst.custo.usd)}</strong></>
              : (inst.totais ? <> · custo: <strong title="Modelo sem preço na tabela">n/d</strong></> : null)}
            {inst.totais && (
              <span className="v25-modelbar-tok">
                {' '}· {fmtTok(inst.totais.input)} in · {fmtTok(inst.totais.cached)} cache · {fmtTok(inst.totais.output)} out
                {inst.totais.reasoning ? ` (${fmtTok(inst.totais.reasoning)} reasoning)` : ''}
              </span>
            )}
          </div>
        )}

        <div className="v25-viewtabs">
          <button className={`v25-viewtab ${view === 'supervisor' ? 'active' : ''}`} onClick={() => setView('supervisor')}>{isPipe ? 'Visão do supervisor' : 'Notas por critério'}</button>
          <button className={`v25-viewtab ${view === 'aluno' ? 'active' : ''}`} onClick={() => setView('aluno')}>{isPipe ? 'Feedback do aluno' : 'Feedback'}</button>
        </div>

        {view === 'supervisor' ? (
          <>
            <div className="card v25-final">
              <div className="v25-final-score">
                <span className="v25-final-num">{result.notaFinal != null ? result.notaFinal : '—'}</span>
                <span className="v25-final-max">/100</span>
              </div>
              <div className="v25-final-meta">
                <div className="v25-final-label">Nota final</div>
                <div className="v25-final-sub">
                  {result.notaFinal == null
                    ? 'Não avaliável: sem critérios suficientes para uma nota.'
                    : isPipe
                      ? `Agregada de ${incluidos} de 14 critérios (os de confiança baixa ficaram fora).`
                      : `Média de ${numNotas} critérios${naNotas ? ` (${naNotas} marcados NA, fora da conta)` : ''}.`}
                </div>
              </div>
            </div>

            {isPipe ? (
              <div className="v25-grid">
                {result.partes.map((p) => (
                  <div key={p.num} className={`v25-card conf-${(p.confianca === 'média' || p.confianca === 'media') ? 'media' : (p.confianca || 'na')} ${p.incluido ? '' : 'excluded'}`}>
                    <div className="v25-card-head">
                      <span className="v25-card-num">{p.num}</span>
                      <span className="v25-card-name">{p.nome}</span>
                      <span className="v25-card-nota">{Number.isFinite(p.nota) ? `${p.nota}/10` : '—'}</span>
                    </div>
                    <div className="v25-card-short">{p.linhaCurta}</div>
                    <div className="v25-card-analise">{p.analise}</div>
                    <div className="v25-card-foot">
                      <span className={`v25-conf-chip conf-${(p.confianca === 'média' || p.confianca === 'media') ? 'media' : (p.confianca || 'na')}`}>{confLabel(p.confianca)}</span>
                      {!p.incluido && <span className="v25-excluded-tag">fora da nota</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="aval-notas-grid">
                {(result.notasDetalhe || []).map((d) => (
                  <div key={d.num} className={`aval-nota-item ${d.nota === 'NA' ? 'na' : ''}`}>
                    <span className="aval-nota-num">{d.num}</span>
                    <span className="aval-nota-nome">{d.nome}</span>
                    <span className="aval-nota-val">{d.nota === 'NA' ? 'NA' : `${d.nota}/10`}</span>
                  </div>
                ))}
                {(!result.notasDetalhe || result.notasDetalhe.length === 0) && (
                  <div className="aval-fila-empty">O avaliador não emitiu o bloco de notas (saída fora de formato). Veja o feedback.</div>
                )}
              </div>
            )}

            {/* Raciocínio "gasto" que o supervisor lê (v16-2/v18-25 raciocinam no
                canal oculto). GLM (z.ai) devolve o texto; GPT via chat.completions não. */}
            {!isPipe && (
              <div className="card aval-reasoning">
                <div className="aval-reasoning-head">Raciocínio — visível ao supervisor</div>
                {result.reasoning
                  ? <div className="aval-reasoning-text">{result.reasoning}</div>
                  : (
                    <div className="aval-reasoning-empty">
                      Sem texto de raciocínio nesta run{inst?.totais?.reasoning ? <> (foram <strong>{fmtTok(inst.totais.reasoning)}</strong> tokens de reasoning, já no custo de saída)</> : null}. O resumo do raciocínio aparece no modo <strong>síncrono</strong>: no <strong>GPT</strong> (exceto o "mini", que não emite resumo) e no <strong>GLM</strong> com effort <strong>high/max</strong>. No modo <strong>batch</strong> o texto não vem.
                    </div>
                  )}
              </div>
            )}
          </>
        ) : (
          <div className="card v25-feedback">
            {result.feedbackAluno
              ? <div className="v25-feedback-text">{result.feedbackAluno}</div>
              : <div className="v25-feedback-empty">Sem feedback gerado. Veja as notas por critério.</div>}
          </div>
        )}
        {filaUI}
      </div>
    );
  }

  // ── Tela inicial ──
  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Avaliação Independente</div>
        <h2><Typewriter text="Avaliar uma " /><span className="accent"><Typewriter text="Sessão" delayStart={520} /></span></h2>
        <p>
          Laboratório de teste: escolha o <strong>avaliador</strong>, o <strong>modelo</strong> e o <strong>effort</strong>,
          cole a transcrição e rode — na hora ou via <strong>batch</strong> (50% mais barato). Mostra a nota e o <strong>custo exato</strong> da run.
        </p>
        <div className="ornament" />
      </div>

      <div className="avaliacao-intro">
        <div className="aval-controls">
          <div>
            <label htmlFor="ev-select">Avaliador (prompt)</label>
            <select id="ev-select" value={evaluator} onChange={(e) => setEvaluator(e.target.value)} style={{ width: '100%' }}>
              {EVALUATORS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="md-select">Modelo</label>
            <select
              id="md-select"
              value={model}
              onChange={(e) => {
                const mk = e.target.value;
                setModel(mk);
                const efs = effortsFor(mk);
                if (!efs.includes(effort)) setEffort(efs.includes('medium') ? 'medium' : efs[0]);
                if (providerOf(mk) === 'glm') setUseBatch(false); // GLM não tem Batch API
              }}
              style={{ width: '100%' }}
            >
              {MODELS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ef-select">Effort</label>
            <select id="ef-select" value={effort} onChange={(e) => setEffort(e.target.value)} style={{ width: '100%' }}>
              {effortsFor(model).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>

        <label className={`aval-batch-toggle ${providerOf(model) === 'glm' ? 'disabled' : ''}`}>
          <input
            type="checkbox"
            checked={useBatch && providerOf(model) !== 'glm'}
            disabled={providerOf(model) === 'glm'}
            onChange={(e) => setUseBatch(e.target.checked)}
          />
          <span>
            {providerOf(model) === 'glm'
              ? <>Batch indisponível para <strong>GLM</strong> (z.ai não expõe Batch API) — roda síncrono; o caching por prefixo continua ativo.</>
              : <>Usar <strong>Batch</strong> (≈50% mais barato, assíncrono — o resultado cai na "Fila de avaliações")</>}
          </span>
        </label>

        <div>
          <label htmlFor="character-select">Caso correspondente <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
          <select id="character-select" value={selectedCharacterId} onChange={(e) => setSelectedCharacterId(e.target.value)} style={{ width: '100%' }}>
            <option value="">— selecione o caso —</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.age ? `, ${c.age}` : ''}</option>
            ))}
          </select>
          <small style={{ display: 'block', marginTop: 6, color: 'var(--marrs-dark)', fontSize: 12 }}>
            Obrigatório: o avaliador usa o Bloco 1 (gabarito) do caso como referência. O caso precisa ter o Bloco 1 configurado.
          </small>
        </div>

        <div>
          <label htmlFor="transcript">Transcrição da sessão</label>
          <textarea
            id="transcript"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Cole aqui a transcrição completa da sessão terapêutica…"
            style={{ minHeight: 260, width: '100%' }}
          />
        </div>

        <div className="avaliacao-row">
          <span className="avaliacao-divider">ou</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>Enviar arquivo .txt</button>
          <input ref={fileInputRef} type="file" accept=".txt" onChange={handleFileUpload} style={{ display: 'none' }} />
          {transcript && (
            <span style={{ fontSize: 12, color: 'var(--marrs-dark)', letterSpacing: '0.08em' }}>
              {transcript.length.toLocaleString('pt-BR')} caracteres carregados
            </span>
          )}
        </div>

        {error && <div className="alert error">{error}</div>}
        {queuedMsg && <div className="alert" style={{ background: 'var(--marrs-tint)', color: 'var(--marrs-deep)' }}>{queuedMsg}</div>}

        <button className="btn btn-primary btn-lg" onClick={handleStart} disabled={submitting}>
          {submitting ? 'Enviando à fila…' : (useBatch ? 'Enviar para a fila (batch)' : 'Iniciar Avaliação')}
        </button>
      </div>
      {filaUI}
    </div>
  );
}
