import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { useWakeLock } from '../useWakeLock';
import { downloadText } from '../logFiles';
import RichText from '../components/RichText';

// "Avaliar Sessão" (supervisor/admin): corrige um log colado com a MESMA régua
// da produção — o pipeline v29, quinze nós, um por critério — e mostra a nota, o
// custo exato da run (tokens × preço do modelo) e o resumo do raciocínio de cada
// nó. Roda SÍNCRONO ou via BATCH (50% off) com uma fila. O que se alterna aqui é
// MODELO e EFFORT: é onde se compara modelo contra modelo antes de trocar o que
// a produção usa, em Administração → Modelos de IA.
//
// Havia também um alternador de PROMPT, com oito entradas (v16-2, v18.25, e os
// pipelines v25/v28/v31/v32 em duas variantes cada). Saiu em 2026-09, quando o
// app passou a rodar uma régua só. As runs antigas continuam no histórico, e a
// tela ainda sabe desenhá-las: o que ficou guardado é resultado, não prompt.

// O avaliador da produção, e o único que a rota aceita (o servidor valida).
const AVALIADOR = 'v29';
const NOS = 15;
// Rótulo de uma run: o do avaliador atual, ou o id cru quando a run é antiga —
// aí o id (v28-nota, v18-25...) já é o rótulo mais honesto que existe.
function evaluatorLabelDaRun(id) {
  return id === AVALIADOR ? 'v29 · pipeline (15 nós)' : (id || '—');
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
  return evaluatorLabelDaRun(id);
}
// Dois estados de espera, e a diferença importa para quem olha: 'aguardando' é
// a fila LOCAL (o job existe, mas o teto de tokens enfileirados do modelo na
// OpenAI está cheio); 'processing' é a Batch API já mastigando.
function statusLabel(s) {
  if (s === 'completed') return 'Pronto';
  if (s === 'error') return 'Erro';
  if (s === 'aguardando') return 'Aguardando vaga';
  return 'Na fila';
}
// Linha das travas no card do critério. Mostra onde a subida parou, que é o que
// diz se a trava está de fato segurando (um 7 exige F3 e F4 abertas).
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

// Linha sob a nota final: quem ficou de fora da conta. Na régua atual é só o nó
// cuja saída não deu para ler; nas runs ANTIGAS do v25 a confiança baixa também
// tirava o critério, e o histórico ainda as mostra.
function subNotaPipeline(versao, incluidos, total) {
  const base = `Agregada de ${incluidos} de ${total} critérios `;
  if (versao === 'v25') return base + '(run antiga: os de confiança baixa ficaram fora).';
  return base + '(fica de fora só o nó cuja saída não deu para ler).';
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
  if (result.alunoNome) L.push(`Aluno: ${result.alunoNome}`);
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
  const [alunoNome, setAlunoNome] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  // Alternadores
  // Abre na versão em teste (a primeira da lista) — é a que o supervisor roda
  // hoje; as outras ficam no alternador para comparar o mesmo log.
  const evaluator = AVALIADOR;
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
    if (!alunoNome.trim()) { setError('Informe o nome do aluno cuja sessão está sendo avaliada.'); return; }
    if (!transcript.trim()) { setError('Cole ou envie a transcrição da sessão.'); return; }
    setError('');
    setQueuedMsg('');
    setResult(null);
    const isBatch = useBatch;
    if (isBatch) setSubmitting(true); else setLoading(true);
    try {
      const data = await api.avaliacaoIndependente({
        log: transcript, casoId: selectedCharacterId, alunoNome: alunoNome.trim(), evaluator, model, effort, batch: isBatch,
      });
      if (data && data.queued && data.local) {
        await pollLocalJob(data.jobId);
      } else if (data && data.queued) {
        setQueuedMsg(data.status === 'aguardando'
          ? 'Avaliação na fila (batch — ~50% mais barato). A fila de tokens da OpenAI está cheia agora, então ela entra assim que abrir vaga e aparece em "Fila de avaliações" quando o lote volta. Nada se perde.'
          : 'Avaliação enviada para a fila (batch — ~50% mais barato, assíncrono). Ela aparece em "Fila de avaliações" quando o lote volta.');
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

  const pendingCount = fila.filter((j) => j.status === 'processing' || j.status === 'queued' || j.status === 'aguardando').length;

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
                    <span className="aval-fila-job-caso">{j.casoNome || '—'}{j.alunoNome ? ` · ${j.alunoNome}` : ''}</span>
                    <span className="aval-fila-job-time">{fmtDate(j.createdAt)}</span>
                  </div>
                  <div className="aval-fila-job-meta">
                    {evaluatorLabel(j.evaluator)} · {j.model} · {j.effort}
                    {j.status === 'completed' && j.result ? ` · nota ${j.result.notaFinal ?? '—'}${cst ? ' · ' + fmtUSD(cst.usd) : ''}` : ''}
                    {j.error ? ` · ${j.error}` : ''}
                    {j.status === 'aguardando' && j.espera ? ` · ${j.espera}` : ''}
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
    return (
      <div>
        <div className="post-session">
          <div className="page-header">
            <div className="eyebrow">Avaliação Independente</div>
            <h2>Avaliando a <span className="accent">sessão</span></h2>
            <p>Cada critério é avaliado por um nó independente, em paralelo. Pode levar alguns minutos.</p>
            <div className="ornament" />
          </div>
          <div className="card evaluating-card">
            <div className="evaluating-orb">
              <div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" />
            </div>
            <div className="evaluating-status">
              <div className="evaluating-line"><span className="dot active" /> Lendo o Bloco 1 do caso e o log</div>
              <div className="evaluating-line"><span className="dot active" /> {NOS} nós avaliando, um por critério</div>
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
    // Runs antigas não gravaram `version` — sem ela, a run é do v25, que era a
    // única que existia quando o campo não existia (ver subNotaPipeline).
    const versaoPipe = result.version || 'v25';
    const numNotas = Array.isArray(result.notasDetalhe) ? result.notasDetalhe.filter((d) => typeof d.nota === 'number').length : 0;
    const naNotas = Array.isArray(result.notasDetalhe) ? result.notasDetalhe.filter((d) => d.nota === 'NA').length : 0;
    return (
      <div>
        <div className="page-header with-action">
          <div>
            <div className="eyebrow">Avaliação Independente · {evaluatorLabel(result.evaluator)}</div>
            <h2>Resultado da <span className="accent">avaliação</span></h2>
            <p>{[result.casoNome ? `Caso: ${result.casoNome}` : '', result.alunoNome ? `Aluno: ${result.alunoNome}` : ''].filter(Boolean).join(' · ')}</p>
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
                      ? subNotaPipeline(versaoPipe, incluidos, result.partes.length)
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
                      {/* A confiança saiu da régua; no lugar dela, a etiqueta que o
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

            {/* O raciocínio dos nós vai para arquivo e sai pelo botão do topo.
                Quando não houve, o aviso explica por quê — senão o supervisor
                procura um botão que não existe. (Nas runs de v25, que não
                capturavam, o arquivo nunca existiu.) */}
            {isPipe && versaoPipe !== 'v25' && (
              <div className="card aval-reasoning">
                <div className="aval-reasoning-head">Raciocínio dos nós</div>
                {result.reasoningDisponivel
                  ? (
                    <div className="aval-reasoning-empty">
                      Guardado nesta avaliação: use <strong>Baixar raciocínio (.txt)</strong>, no topo. É o resumo que
                      o provedor entrega de cada nó (a cadeia bruta não é exposta por ninguém), com a nota e a
                      faixa ao lado. Material do supervisor — não vai para o aluno.
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

            {/* Runs ANTIGAS de avaliador de prompt único (v18-25, v16-2): o
                raciocínio vinha na própria resposta quando o provedor o
                devolvia (GLM sim; GPT via chat.completions não). Nenhuma run
                nova cai aqui — o alternador de prompt não existe mais. */}
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
              : (result.variant === 'so-nota' || /-nota$/.test(String(result.evaluator || '')))
                ? <div className="v25-feedback-empty">Esta run é de uma variante <strong>só nota</strong>, que não existe mais: os nós devolviam apenas a nota de cada critério e o sintetizador não rodava. Veja as notas por critério.</div>
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
          Corrige um log com a régua da produção (v29). Escolha o <strong>modelo</strong> e o <strong>effort</strong>,
          cole a transcrição e rode — na hora ou via <strong>batch</strong> (50% mais barato). Mostra a nota e o <strong>custo exato</strong> da run.
        </p>
        <div className="ornament" />
      </div>

      <div className="avaliacao-intro">
        <div className="aval-controls">
          <div>
            <label>Avaliador</label>
            <div className="aval-ev-fixo">v29 · pipeline ({NOS} nós)</div>
            <div className="aval-ev-hint">
              A mesma régua que corrige as sessões dos alunos. Os {NOS} nós avaliam um critério cada,
              respondendo as travas — a faixa e a nota saem por código, não do modelo —, e o
              sintetizador escreve o feedback do aluno a partir das análises, sem ver o Bloco 1.
            </div>
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
          <label htmlFor="aluno-nome">Aluno <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
          <input
            id="aluno-nome"
            type="text"
            value={alunoNome}
            onChange={(e) => setAlunoNome(e.target.value)}
            placeholder="Nome do aluno cuja sessão está sendo avaliada"
            style={{ width: '100%' }}
          />
          <small style={{ display: 'block', marginTop: 6, color: 'var(--marrs-dark)', fontSize: 12 }}>
            Obrigatório: identifica de quem é a sessão colada abaixo — sem isto, duas avaliações do mesmo caso ficam indistinguíveis no histórico.
          </small>
        </div>

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
