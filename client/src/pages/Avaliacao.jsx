import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { useWakeLock } from '../useWakeLock';
import { downloadText } from '../logFiles';
import RichText from '../components/RichText';

// Avaliação Independente — laboratório de PRICING (supervisor/admin). Alterna o
// PROMPT (v16-2 / v18-25 / pipeline v28 ou v25, com feedback ou só nota), o
// MODELO e o EFFORT (low/medium/high); roda SÍNCRONO ou via BATCH (50% off) com
// uma fila. Mostra a nota + o CUSTO EXATO (tokens × preço do modelo) e permite
// baixar um relatório com tudo. Isolado do avaliador de produção e da simulação.

// Precisa espelhar o registry EVALUATORS do servidor (server/avaliacao-independente.js),
// que é quem valida. O v31 é a versão em teste (travas respondidas uma a uma,
// análise depois delas, sem confiança); v28 e v25 ficam para rodar o mesmo log e
// comparar. Nas versões que têm duas entradas, é o mesmo código mudando só a
// saída do nó: em 'vNN-nota' ele devolve só a nota, sem análise nem feedback do
// aluno — mais barato, porque o texto por critério some do billing.
const EVALUATORS = [
  { id: 'v32', label: 'v32 · pipeline (15 nós × 2 fases)', nos: 15, fases: 2 },
  { id: 'v31', label: 'v31 · pipeline (15 nós)', nos: 15 },
  { id: 'v28', label: 'v28 · pipeline (15 nós) · com feedback', nos: 15 },
  { id: 'v28-nota', label: 'v28 · pipeline (15 nós) · só nota', nos: 15 },
  { id: 'v25', label: 'v25 · pipeline (14 nós) · com feedback', nos: 14 },
  { id: 'v25-nota', label: 'v25 · pipeline (14 nós) · só nota', nos: 14 },
  { id: 'v18-25', label: 'v18.25 · 15 critérios' },
];
// Avaliadores que rodam o pipeline multi-nó (v28/v25, qualquer variante) — são
// os que têm contagem de nós no registry.
function isPipelineId(id) {
  const e = EVALUATORS.find((x) => x.id === id);
  return !!(e && e.nos);
}
// Quantos nós a versão roda (para os textos de tela). 0 se não for pipeline.
function nosDe(id) {
  const e = EVALUATORS.find((x) => x.id === id);
  return (e && e.nos) || 0;
}
// Variante "só nota" (o nó devolve apenas a NOTA, sem análise nem sintetizador).
function isSoNotaId(id) {
  return /-nota$/.test(String(id || ''));
}
// `efforts` só aparece no modelo que FOGE do padrão do provedor. A família 5.6
// aceita dois degraus a mais (xhigh, max) — por isso a lista de effort virou
// por modelo, e não só por provedor. Precisa espelhar AVAL_MODELOS no servidor,
// que é quem valida (o cliente aqui só evita oferecer combinação que dá 400).
const EFFORTS_5_6 = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = [
  { key: 'gpt-5.6-sol', label: 'GPT 5.6 Sol', provider: 'openai', efforts: EFFORTS_5_6 },
  { key: 'gpt-5.6-terra', label: 'GPT 5.6 Terra', provider: 'openai', efforts: EFFORTS_5_6 },
  { key: 'gpt-5.6-luna', label: 'GPT 5.6 Luna', provider: 'openai', efforts: EFFORTS_5_6 },
  { key: 'gpt-5.5', label: 'GPT 5.5', provider: 'openai' },
  { key: 'gpt-5.4', label: 'GPT 5.4', provider: 'openai' },
  { key: 'gpt-5.4-mini', label: 'GPT 5.4 mini', provider: 'openai' },
  { key: 'glm-5.2', label: 'GLM 5.2 (z.ai)', provider: 'glm' },
];
// Padrão por provedor: GPT usa low/medium/high; GLM (z.ai) usa disabled
// (thinking off) / high / max.
const EFFORTS_BY_PROVIDER = {
  openai: ['low', 'medium', 'high'],
  glm: ['disabled', 'high', 'max'],
};
function modelOf(modelKey) {
  return MODELS.find((x) => x.key === modelKey) || null;
}
function providerOf(modelKey) {
  const m = modelOf(modelKey);
  return m ? m.provider : 'openai';
}
function effortsFor(modelKey) {
  const m = modelOf(modelKey);
  if (m && m.efforts) return m.efforts;
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
// v28: linha das travas no card do critério. Mostra onde a subida parou, que é
// o que diz se a trava está de fato segurando (um 7 exige F3 e F4 abertas).
function TravasLinha({ p }) {
  if (!p.travas) return null;
  return (
    <div className="v25-card-travas">
      {[2, 3, 4, 5].map((n) => (
        <span key={n} className={`v25-trava ${p.travas[n] === true ? 'passa' : p.travas[n] === false ? 'fecha' : 'na'}`}>
          F{n}
        </span>
      ))}
      <span className="v25-trava-faixa">
        faixa F{p.faixa} · {p.realizacao || 'realização assumida completa'}
      </span>
      {p.travasInconsistentes && (
        <span className="v25-trava-alerta" title="O nó abriu uma trava acima de uma que fechou. O código descartou a de cima e parou na primeira fechada — mas o sinal indica que ele hesitou neste critério.">
          ⚠ trava descartada
        </span>
      )}
    </div>
  );
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
  if (inst.chamadas) L.push(`Chamadas ao modelo: ${inst.chamadas}${inst.retentativas ? ` (${inst.retentativas} refeitas por ordem trocada)` : ''}`);
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
  const [evaluator, setEvaluator] = useState('v32');
  const [baixandoReasoning, setBaixandoReasoning] = useState(false);
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

  // O raciocínio não vem no resultado (é grande, e ninguém lê no caminho
  // normal): mora em arquivo no servidor e só é buscado quando o supervisor
  // pede. Ver GET /api/avaliacao-independente/:id/reasoning.
  async function downloadReasoning(res) {
    if (!res || !res.id || baixandoReasoning) return;
    setBaixandoReasoning(true);
    setError('');
    try {
      const txt = await api.avaliacaoReasoning(res.id);
      const date = new Date().toISOString().slice(0, 10);
      const name = `raciocinio-${res.evaluator || 'run'}-${(res.instrumentacao && res.instrumentacao.model) || ''}-${date}.txt`.replace(/\s+/g, '_');
      downloadText(name, txt);
    } catch (e) {
      setError(e.message || 'Erro ao baixar o raciocínio.');
    } finally {
      setBaixandoReasoning(false);
    }
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
    const isPipe = isPipelineId(evaluator);
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
              <div className="evaluating-line"><span className="dot active" /> {isPipe ? `${nosDe(evaluator)} nós avaliando, um por critério` : 'Avaliando os critérios'}</div>
              <div className="evaluating-line"><span className="dot pulse" /> {isSoNotaId(evaluator) ? 'Calculando a nota (esta variante não gera feedback)' : 'Calculando a nota e o feedback'}</div>
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
    // Quem ficou fora da nota depende da VERSÃO do pipeline: no v25 a confiança
    // baixa exclui o critério; no v28 ela é só recado ao supervisor, e só fica de
    // fora o nó que não devolveu número. Runs antigas não gravaram `version` —
    // sem ela, a regra é a do v25, que era a única que existia.
    const versaoPipe = result.version || 'v25';
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
            {result.reasoningDisponivel && (
              <button
                className="btn btn-outline"
                onClick={() => downloadReasoning(result)}
                disabled={baixandoReasoning}
                title="Resumo do raciocínio de cada nó, como o provedor o entrega. Material do supervisor — não vai para o aluno."
              >
                {baixandoReasoning ? 'Baixando…' : 'Baixar raciocínio (.txt)'}
              </button>
            )}
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
            {inst.retentativas > 0 && (
              <span className="v25-trava-alerta" title="Chamadas EXTRAS cobradas porque a análise veio antes das travas e o nó foi refeito. Cada uma custa uma chamada inteira; desligue com AVALIACAO_V25_RETRY_ORDEM=0.">
                {' '}· <strong>{inst.retentativas} retentativa(s) de ordem</strong>
              </span>
            )}
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
                      ? `Agregada de ${incluidos} de ${result.partes.length} critérios ${versaoPipe === 'v28' ? '(a confiança não tira ninguém da nota; fica de fora só o nó sem nota legível).' : '(os de confiança baixa ficaram fora).'}`
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
                    <TravasLinha p={p} />
                    <div className="v25-card-analise"><RichText text={p.analise} /></div>
                    <div className="v25-card-foot">
                      {/* A confiança saiu no v31; no lugar dela, a etiqueta que o
                          sintetizador recebe (derivada da faixa, escrita por código). */}
                      {p.etiqueta
                        ? <span className="v25-etiqueta">[{p.etiqueta}]</span>
                        : <span className={`v25-conf-chip conf-${(p.confianca === 'média' || p.confianca === 'media') ? 'media' : (p.confianca || 'na')}`}>{confLabel(p.confianca)}</span>}
                      {p.analiseForaDeOrdem && (
                        <span className="v25-trava-alerta" title="A análise veio antes das travas mesmo depois da retentativa: a prosa pode ter ancorado as respostas deste critério.">⚠ análise fora de ordem</span>
                      )}
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

            {/* Pipeline com captura (v28): o raciocínio vai para arquivo e sai
                pelo botão do topo. Quando não houve, o aviso explica por quê —
                senão o supervisor procura um botão que não existe. */}
            {isPipe && versaoPipe === 'v28' && (
              <div className="card aval-reasoning">
                <div className="aval-reasoning-head">Raciocínio dos nós</div>
                {result.reasoningDisponivel
                  ? (
                    <div className="aval-reasoning-empty">
                      Guardado nesta avaliação: use <strong>Baixar raciocínio (.txt)</strong>, no topo. É o resumo que
                      o provedor entrega de cada nó (a cadeia bruta não é exposta por ninguém), com a nota e a
                      confiança ao lado. Material do supervisor — não vai para o aluno.
                    </div>
                  )
                  : (
                    <div className="aval-reasoning-empty">
                      Sem resumo nesta run{inst?.totais?.reasoning ? <> (foram <strong>{fmtTok(inst.totais.reasoning)}</strong> tokens de reasoning, já cobrados na saída)</> : null}.
                      O resumo só existe no modo <strong>síncrono</strong>: o <strong>batch</strong> roda por um endpoint que não devolve esse texto,
                      e o modelo <strong>"mini"</strong> não emite resumo.
                    </div>
                  )}
              </div>
            )}

            {/* Raciocínio "gasto" que o supervisor lê (o v18-25 raciocina no
                canal oculto). GLM (z.ai) devolve o texto; GPT via chat.completions não. */}
            {!isPipe && (
              <div className="card aval-reasoning">
                <div className="aval-reasoning-head">Raciocínio — visível ao supervisor</div>
                {result.reasoning
                  ? <div className="aval-reasoning-text"><RichText text={result.reasoning} /></div>
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
              ? <div className="v25-feedback-text"><RichText text={result.feedbackAluno} /></div>
              : (result.variant === 'so-nota' || isSoNotaId(result.evaluator))
                ? <div className="v25-feedback-empty">A variante <strong>só nota</strong> não gera feedback: os nós devolvem apenas a nota de cada critério, sem análise, e o sintetizador não roda. Para o feedback do aluno, rode a mesma versão em <strong>com feedback</strong>.</div>
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
            {isPipelineId(evaluator) && (
              <div className="aval-ev-hint">
                {!isSoNotaId(evaluator)
                  ? <>Os {nosDe(evaluator)} nós avaliam um critério cada, e o sintetizador escreve o feedback do aluno a partir das análises.</>
                  : <>Os {nosDe(evaluator)} nós devolvem <strong>só a nota</strong>: mesma nota final, sem análise e sem feedback do aluno — mais barato (o texto por critério sai do billing; o reasoning continua).</>}
                {evaluator.startsWith('v28') && <> No v28 a confiança é recado para o supervisor: ela aparece no critério, mas <strong>não tira ninguém da nota</strong>.</>}
                {evaluator === 'v31' && <> O nó responde as quatro travas como perguntas independentes e a análise vem <strong>depois</strong> delas; faixa, realização e nota são derivadas por código.</>}
                {evaluator === 'v32' && <> Cada nó são <strong>duas chamadas</strong>: a primeira responde as quatro perguntas <strong>sem ver a régua</strong> (sem escada à vista, a impressão do atendimento não tem onde pousar), o código deriva a faixa, e a segunda decide completa ou incompleta com a régua inteira. São 30 chamadas por avaliação: pesa em tempo, pouco em dinheiro.</>}
              </div>
            )}
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
