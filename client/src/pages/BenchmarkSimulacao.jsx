import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import RichText from '../components/RichText';
import { downloadText } from '../logFiles';

// Benchmarking de Simulação — laboratório de CAPACIDADE do PACIENTE, com o aluno
// automatizado (supervisor/admin).
//
// Diferença das outras duas abas de laboratório:
//   · Avaliar Sessão          → mede o AVALIADOR
//   · Simulação Independente  → mede o PACIENTE, com VOCÊ digitando as falas
//   · Benchmarking (esta)     → mede o PACIENTE ao longo de um atendimento
//                               INTEIRO, com um ALUNO SIMULADO digitando
//
// Você sobe o log de um atendimento que já aconteceu; um modelo extrai dali a
// persona de quem atendeu (como fala, como conduz, o que erra) e essa persona
// reatende o mesmo caso pelo número de interações escolhido. NÃO HÁ AVALIAÇÃO:
// o produto é custo + transcrição, pra comparar preço e sustentação de cada
// modelo candidato a paciente.
//
// Escolher DOIS OU MAIS modelos monta um LOTE: mesmo caso, mesmo aluno e a MESMA
// ficha de persona para todos (extraída uma vez), rodando em fila ou em paralelo.
// É o fluxo automatizado — dispara e volta depois.
//
// A run é longa (70 interações = 140 chamadas), então tudo roda em background no
// servidor: a tela dispara, faz polling e vai mostrando a conversa crescer.

const POLL_MS = 4000;

function fmtUSD(usd, casas = 6) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0';
  return '$' + usd.toFixed(casas);
}
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}
function fmtSeg(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms';
}
function fmtDuracao(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return `${m}min ${String(s % 60).padStart(2, '0')}s`;
}
const STATUS_LABEL = {
  aguardando: 'na fila',
  processing: 'rodando',
  cancelando: 'cancelando…',
  cancelado: 'cancelada',
  completed: 'concluída',
  parcial: 'concluída com falhas',
  error: 'com erro',
};
const EM_ANDAMENTO = ['processing', 'cancelando', 'aguardando'];

export default function BenchmarkSimulacao() {
  // Catálogo + formulário
  const [opcoes, setOpcoes] = useState(null);
  const [characters, setCharacters] = useState([]);
  const [casoId, setCasoId] = useState('');
  const [pacientesSel, setPacientesSel] = useState([]);   // chaves marcadas
  const [modo, setModo] = useState('fila');
  const [interacoes, setInteracoes] = useState(10);
  const [alunoSel, setAlunoSel] = useState('');           // id do aluno ou '__outro'
  const [alunoOutro, setAlunoOutro] = useState('');
  const [log, setLog] = useState('');
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);

  // Em foco: um lote, uma run, ou nada (tela de configuração)
  const [lote, setLote] = useState(null);
  const [run, setRun] = useState(null);
  const [fila, setFila] = useState([]);
  const [lotes, setLotes] = useState([]);
  const [cancelando, setCancelando] = useState(false);
  const [baixando, setBaixando] = useState('');

  const fileInputRef = useRef(null);
  const fimRef = useRef(null);

  useEffect(() => {
    let cancelado = false;
    Promise.all([api.benchOpcoes(), api.getFreeplay()])
      .then(([cat, list]) => {
        if (cancelado) return;
        setOpcoes(cat);
        if (cat && cat.pacientes && cat.pacientes.length) setPacientesSel([cat.pacientes[0].key]);
        if (cat && cat.interacoes && cat.interacoes.length) setInteracoes(cat.interacoes[0]);
        if (cat && cat.modoPadrao) setModo(cat.modoPadrao);
        setCharacters(
          (Array.isArray(list) ? list : [])
            .map((c) => ({ id: c.id, name: c.name, age: c.age }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR')),
        );
      })
      .catch((err) => { if (!cancelado) setError(err.message || 'Erro ao carregar as opções.'); });
    return () => { cancelado = true; };
  }, []);

  const refreshHistorico = useCallback(() => {
    api.benchFila().then((l) => setFila(Array.isArray(l) ? l : [])).catch(() => {});
    api.benchLotes().then((l) => setLotes(Array.isArray(l) ? l : [])).catch(() => {});
  }, []);
  useEffect(() => { refreshHistorico(); }, [refreshHistorico]);

  // Polling de quem está em foco e ainda não terminou.
  const loteRodando = !!lote && EM_ANDAMENTO.includes(lote.status);
  const runRodando = !!run && EM_ANDAMENTO.includes(run.status);
  useEffect(() => {
    if (!loteRodando && !runRodando) return undefined;
    let vivo = true;
    const id = setInterval(() => {
      if (lote && loteRodando) {
        api.benchLote(lote.id).then((l) => {
          if (!vivo) return;
          setLote(l);
          if (!EM_ANDAMENTO.includes(l.status)) refreshHistorico();
        }).catch(() => {});
      }
      if (run && runRodando) {
        api.benchRun(run.id).then((r) => {
          if (!vivo) return;
          setRun(r);
          if (!EM_ANDAMENTO.includes(r.status)) refreshHistorico();
        }).catch(() => {});
      }
    }, POLL_MS);
    return () => { vivo = false; clearInterval(id); };
  }, [lote, run, loteRodando, runRodando, refreshHistorico]);

  useEffect(() => {
    if (runRodando) fimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [run, runRodando]);

  const pacientes = useMemo(() => (opcoes && opcoes.pacientes) || [], [opcoes]);
  const emLote = pacientesSel.length > 1;

  const alunoNome = alunoSel === '__outro'
    ? alunoOutro.trim()
    : ((opcoes && opcoes.alunos ? opcoes.alunos.find((a) => String(a.id) === String(alunoSel)) : null) || {}).name || '';

  function toggleModelo(key) {
    setPacientesSel((atual) => (atual.includes(key) ? atual.filter((k) => k !== key) : [...atual, key]));
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.name.endsWith('.txt')) { setError('Apenas arquivos .txt são aceitos.'); return; }
    const MAX = 2 * 1024 * 1024;
    if (file.size > MAX) { setError(`Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB). Máximo: 2 MB.`); return; }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => setLog(ev.target.result);
    reader.readAsText(file);
  }

  async function iniciar() {
    setError('');
    if (!log.trim()) { setError('Envie ou cole o log do atendimento que será replicado.'); return; }
    if (!casoId) { setError('Selecione o paciente que foi atendido.'); return; }
    if (!pacientesSel.length) { setError('Escolha ao menos um modelo de paciente.'); return; }
    setEnviando(true);
    try {
      const base = { log, casoId, interacoes, alunoNome };
      if (emLote) {
        const { id } = await api.benchLoteStart({ ...base, pacientes: pacientesSel, modo });
        setLote(await api.benchLote(id));
      } else {
        const { id } = await api.benchStart({ ...base, paciente: pacientesSel[0] });
        setRun(await api.benchRun(id));
      }
      refreshHistorico();
    } catch (err) {
      setError(err.message || 'Erro ao iniciar o benchmark.');
    } finally {
      setEnviando(false);
    }
  }

  async function cancelar() {
    setCancelando(true);
    try {
      if (lote) {
        await api.benchLoteCancelar(lote.id);
        setLote((l) => (l ? { ...l, status: 'cancelando' } : l));
      } else if (run) {
        await api.benchCancelar(run.id);
        setRun((r) => (r ? { ...r, status: 'cancelando' } : r));
      }
    } catch (err) {
      setError(err.message || 'Erro ao cancelar.');
    } finally {
      setCancelando(false);
    }
  }

  async function abrirRun(id) {
    setError('');
    try { setRun(await api.benchRun(id)); } catch (err) { setError(err.message || 'Erro ao abrir a run.'); }
  }
  async function abrirLote(id) {
    setError('');
    setRun(null);
    try { setLote(await api.benchLote(id)); } catch (err) { setError(err.message || 'Erro ao abrir o lote.'); }
  }
  function voltarAoInicio() {
    setRun(null);
    setLote(null);
    refreshHistorico();
  }

  async function baixar(tipo) {
    setBaixando(tipo);
    setError('');
    try {
      if (tipo === 'lote') {
        const nome = `benchmark-lote-${(lote.casoNome || 'caso').replace(/\s+/g, '_')}-${lote.interacoes}int.txt`;
        downloadText(nome, await api.benchLoteRelatorioTxt(lote.id));
        return;
      }
      const base = `${(run.casoNome || 'caso').replace(/\s+/g, '_')}-${run.interacoesPedidas}int-${(run.paciente.modelKey || '').replace(/\s+/g, '')}`;
      if (tipo === 'log') {
        downloadText(`benchmark-${base}.txt`, await api.benchLogTxt(run.id));
      } else if (tipo === 'persona') {
        const quem = (run.alunoNome || 'aluno').replace(/\s+/g, '_');
        downloadText(`persona-${quem}-${base}.txt`, await api.benchPersonaTxt(run.id));
      } else {
        downloadText(`benchmark-raciocinio-${base}.txt`, await api.benchReasoningTxt(run.id));
      }
    } catch (err) {
      setError(err.message || 'Erro ao baixar o arquivo.');
    } finally {
      setBaixando('');
    }
  }

  const erroBox = error ? (
    <div className="alert error" style={{ marginTop: 12 }}>
      {error}<button onClick={() => setError('')} className="close">×</button>
    </div>
  ) : null;

  // ── Tela de configuração ──────────────────────────────────────────────────
  if (!run && !lote) {
    const listaInteracoes = (opcoes && opcoes.interacoes) || [10, 30, 50, 70];
    const chamadas = pacientesSel.length * interacoes * 2;
    return (
      <div>
        <div className="page-header">
          <div className="eyebrow">Benchmarking de Simulação</div>
          <h2><Typewriter text="Atendimento " /><span className="accent"><Typewriter text="Replicado" delayStart={620} /></span></h2>
          <p>
            Suba o log de um atendimento que já aconteceu: a IA extrai a <strong>persona de quem atendeu</strong> e
            refaz o caso com o <strong>mesmo paciente</strong>, pelo número de interações que você escolher. Marque{' '}
            <strong>vários modelos</strong> para rodar tudo de uma vez, no mesmo caso e com a mesma persona.{' '}
            <strong>Não há avaliação</strong> aqui — nada é pontuado.
          </p>
          <div className="ornament" />
        </div>

        <div className="avaliacao-intro">
          <div className="aval-controls">
            <div>
              <label htmlFor="bench-caso">Paciente atendido <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
              <select id="bench-caso" value={casoId} onChange={(e) => setCasoId(e.target.value)} style={{ width: '100%' }}>
                <option value="">— selecione o personagem —</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.age ? `, ${c.age}` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bench-aluno">Aluno que atendeu</label>
              <select id="bench-aluno" value={alunoSel} onChange={(e) => setAlunoSel(e.target.value)} style={{ width: '100%' }}>
                <option value="">— não identificar —</option>
                {((opcoes && opcoes.alunos) || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="__outro">Outro (digitar)…</option>
              </select>
              {alunoSel === '__outro' && (
                <input
                  type="text" value={alunoOutro} onChange={(e) => setAlunoOutro(e.target.value)}
                  placeholder="Nome de quem atendeu" style={{ width: '100%', marginTop: 8 }} maxLength={80}
                />
              )}
            </div>
          </div>
          <small style={{ display: 'block', marginTop: -4, color: 'var(--marrs-dark)', fontSize: 12 }}>
            O nome só rotula a run e dá identidade à fala do aluno simulado. <strong>A persona vem do log</strong>, não
            do cadastro — o sistema não guarda perfil de estilo de ninguém.
          </small>

          <div>
            <div className="bench-label-row">
              <label style={{ margin: 0 }}>Modelos do paciente (é o que está sendo testado)</label>
              <div className="bench-label-acoes">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPacientesSel(pacientes.map((p) => p.key))}>
                  Todos
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPacientesSel([])}>
                  Limpar
                </button>
              </div>
            </div>
            <div className="bench-opt-row">
              {pacientes.map((p) => {
                const sel = pacientesSel.includes(p.key);
                return (
                  <button
                    key={p.key} type="button"
                    className={`bench-opt ${sel ? 'sel' : ''}`}
                    onClick={() => toggleModelo(p.key)}
                    aria-pressed={sel}
                  >
                    <span className="bench-opt-marca">{sel ? '✓' : ''}</span>
                    <strong>{p.label}</strong>
                    <span className="sim-provider-chip">{p.provider}</span>
                    {p.precos && (
                      <span className="bench-opt-preco">
                        ${p.precos.input} in · ${p.precos.cacheRead} cache · ${p.precos.output} out /MTok
                      </span>
                    )}
                    {p.nota && <span className="bench-opt-nota">{p.nota}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label>Interações <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(1 fala do paciente + 1 fala do aluno)</span></label>
            <div className="bench-opt-row">
              {listaInteracoes.map((n) => (
                <button
                  key={n} type="button"
                  className={`bench-chip ${interacoes === n ? 'sel' : ''}`}
                  onClick={() => setInteracoes(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {emLote && (
            <div>
              <label>Como rodar o lote</label>
              <div className="bench-opt-row">
                <button type="button" className={`bench-opt bench-opt-modo ${modo === 'fila' ? 'sel' : ''}`} onClick={() => setModo('fila')}>
                  <strong>Em fila</strong>
                  <span className="bench-opt-nota">
                    Um modelo por vez, do começo ao fim. Mais devagar, sem risco de estourar o limite de tokens por
                    minuto — e uma falha não contamina as outras.
                  </span>
                </button>
                <button type="button" className={`bench-opt bench-opt-modo ${modo === 'paralelo' ? 'sel' : ''}`} onClick={() => setModo('paralelo')}>
                  <strong>Em paralelo</strong>
                  <span className="bench-opt-nota">
                    Todos ao mesmo tempo. Termina antes, mas o <strong>aluno simulado é o mesmo modelo</strong> em todas
                    as runs, então {pacientesSel.length} runs juntas multiplicam por {pacientesSel.length} a pressão
                    sobre o limite dele.
                  </span>
                </button>
              </div>
            </div>
          )}

          <div className="bench-plano">
            <strong>{pacientesSel.length || 0}</strong> modelo{pacientesSel.length === 1 ? '' : 's'} ×{' '}
            <strong>{interacoes}</strong> interações = <strong>{chamadas}</strong> chamadas de IA com custo real
            {emLote && <> · execução <strong>{modo === 'fila' ? 'em fila' : 'em paralelo'}</strong></>}.
            {emLote && (
              <> A ficha de persona é extraída <strong>uma vez</strong> e usada por todos — é o que faz a comparação
                valer, já que todos enfrentam o mesmo aluno.
              </>
            )}
            {' '}Roda no servidor: você pode sair da tela, voltar depois e cancelar no meio (o parcial fica gravado).
          </div>

          <div>
            <label htmlFor="bench-log">Log do atendimento a replicar <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
            <textarea
              id="bench-log"
              value={log}
              onChange={(e) => setLog(e.target.value)}
              placeholder="Cole aqui a transcrição do atendimento original — é dela que sai a persona do aluno…"
              style={{ minHeight: 200, width: '100%' }}
            />
          </div>
          <div className="avaliacao-row">
            <span className="avaliacao-divider">ou</span>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>Enviar arquivo .txt</button>
            <input ref={fileInputRef} type="file" accept=".txt" onChange={handleFileUpload} style={{ display: 'none' }} />
            {log && (
              <span style={{ fontSize: 12, color: 'var(--marrs-dark)', letterSpacing: '0.08em' }}>
                {log.length.toLocaleString('pt-BR')} caracteres carregados
              </span>
            )}
          </div>

          {opcoes && opcoes.aluno && (
            <div className="sim-model-card">
              <div className="sim-model-card-head">
                <strong>Aluno simulado: {opcoes.aluno.label}</strong>
                <span className="sim-provider-chip">{opcoes.aluno.provider}</span>
                <span className="sim-model-nota">fixo — é o instrumento de medida, não o objeto medido</span>
              </div>
              <div className="sim-model-precos">
                O custo do aluno aparece no resumo e no relatório, separado do paciente. As médias por interação que
                importam para projetar produção são as do <strong>paciente</strong>.
              </div>
            </div>
          )}

          {error && <div className="alert error">{error}</div>}

          <button
            className="btn btn-primary btn-lg"
            onClick={iniciar}
            disabled={enviando || !opcoes || !casoId || !log.trim() || !pacientesSel.length}
          >
            {enviando
              ? 'Iniciando…'
              : emLote
                ? `Rodar lote (${pacientesSel.length} modelos × ${interacoes} interações)`
                : `Rodar benchmark (${interacoes} interações)`}
          </button>
        </div>

        {(lotes.length > 0 || fila.some((j) => !j.loteId)) && (
          <div className="card" style={{ marginTop: 22 }}>
            <h3 style={{ marginTop: 0 }}>Histórico</h3>
            <div className="bench-hist">
              {lotes.map((l) => (
                <button key={l.id} type="button" className="bench-hist-item" onClick={() => abrirLote(l.id)}>
                  <span className={`bench-status ${l.status}`}>{STATUS_LABEL[l.status] || l.status}</span>
                  <strong>{l.casoNome || '—'}</strong>
                  <span>lote · {(l.pacientes || []).length} modelos · {l.modo}</span>
                  <span>{l.interacoes} int.</span>
                  <span>{l.resumo && l.resumo.totais ? fmtUSD(l.resumo.totais.geral, 4) : '—'}</span>
                  <span className="bench-hist-data">{l.createdAt ? new Date(l.createdAt).toLocaleString('pt-BR') : ''}</span>
                </button>
              ))}
              {fila.filter((j) => !j.loteId).map((j) => (
                <button key={j.id} type="button" className="bench-hist-item" onClick={() => abrirRun(j.id)}>
                  <span className={`bench-status ${j.status}`}>{STATUS_LABEL[j.status] || j.status}</span>
                  <strong>{j.casoNome || '—'}</strong>
                  <span>{j.pacienteLabel}</span>
                  <span>{(j.progresso ? j.progresso.feitas : 0)}/{j.interacoesPedidas} int.</span>
                  <span>{j.resumo ? fmtUSD(j.resumo.totalUsd, 4) : '—'}</span>
                  <span className="bench-hist-data">{j.createdAt ? new Date(j.createdAt).toLocaleString('pt-BR') : ''}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Tela do LOTE ──────────────────────────────────────────────────────────
  if (lote && !run) {
    const comp = lote.resumo || { linhas: [], totais: {} };
    const t = comp.totais || {};
    const prontas = comp.linhas.filter((l) => !EM_ANDAMENTO.includes(l.status)).length;
    const pct = comp.linhas.length ? Math.round((prontas / comp.linhas.length) * 100) : 0;
    const duracao = lote.completedAt && lote.createdAt
      ? new Date(lote.completedAt) - new Date(lote.createdAt)
      : (lote.createdAt ? Date.now() - new Date(lote.createdAt) : 0);

    return (
      <div>
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div className="eyebrow">Benchmarking em lote</div>
          <h2 style={{ marginBottom: 6 }}>{lote.casoNome || 'Paciente'} <span className="accent">×</span> {comp.linhas.length} modelos</h2>
          <p style={{ marginBottom: 0 }}>
            Aluno simulado: <strong>{lote.alunoNome || 'não identificado'}</strong> em {lote.aluno.label} ·{' '}
            {lote.interacoes} interações por modelo · execução <strong>{lote.modo === 'fila' ? 'em fila' : 'em paralelo'}</strong> ·{' '}
            <span className={`bench-status ${lote.status}`}>{STATUS_LABEL[lote.status] || lote.status}</span>
          </p>
        </div>

        <div className="bench-actions">
          <button className="btn btn-outline btn-sm" onClick={voltarAoInicio}>← Novo benchmark</button>
          {loteRodando && (
            <button className="btn btn-outline btn-sm" onClick={cancelar} disabled={cancelando || lote.status === 'cancelando'}>
              {lote.status === 'cancelando' ? 'Cancelando…' : 'Cancelar lote'}
            </button>
          )}
          <button className="btn btn-outline btn-sm" onClick={() => baixar('lote')} disabled={baixando === 'lote'}>
            {baixando === 'lote' ? 'Gerando…' : 'Baixar relatório do lote (.txt)'}
          </button>
        </div>

        {lote.error && <div className="alert error" style={{ marginTop: 12 }}>{lote.error}</div>}
        {erroBox}

        {loteRodando && (
          <div className="bench-progress">
            <div className="bench-progress-bar"><span style={{ width: `${pct}%` }} /></div>
            <div className="bench-progress-txt">
              {!lote.persona
                ? 'Extraindo a persona do aluno (uma vez, para todos os modelos)…'
                : `${prontas} de ${comp.linhas.length} modelos concluídos · ${fmtDuracao(duracao)} decorridos`}
            </div>
          </div>
        )}

        {/* Comparativo: números que cada run produziu. Nada aqui julga a
            QUALIDADE da fala — essa é outra ferramenta, ainda por fazer. */}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Comparativo</h3>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: -6 }}>
            Custo, tokens e latência de cada modelo no <strong>mesmo caso</strong>, com a <strong>mesma persona</strong> de
            aluno. A ordem é a de preço de tabela, não um ranking de resultado — e nada aqui avalia a qualidade da fala.
          </p>
          <div className="bench-comp">
            <div className="bench-comp-head">
              <span>modelo</span><span>status</span><span>int.</span><span>paciente</span>
              <span>por interação</span><span>latência</span><span>tokens (in/cache/out)</span>
            </div>
            {comp.linhas.map((l) => (
              <button key={l.runId} type="button" className="bench-comp-row" onClick={() => abrirRun(l.runId)} title="Abrir a transcrição desta run">
                <span className="bench-comp-modelo">{l.label}</span>
                <span><span className={`bench-status ${l.status}`}>{STATUS_LABEL[l.status] || l.status}</span></span>
                <span>{l.interacoesFeitas}/{l.interacoesPedidas}</span>
                <span><strong>{fmtUSD(l.pacienteUsd)}</strong></span>
                <span><strong>{fmtUSD(l.custoPorInteracao)}</strong></span>
                <span>{l.latenciaMedia != null ? fmtSeg(l.latenciaMedia) : '—'}</span>
                <span>{fmtTok(l.tokens.input)}/{fmtTok(l.tokens.cacheRead)}/{fmtTok(l.tokens.output)}</span>
                {l.erro && <span className="bench-comp-erro">{l.erro}</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="sim-hud" style={{ marginTop: 18 }}>
          <div className="sim-hud-main">
            <div className="sim-hud-total">
              <span className="sim-hud-num">{fmtUSD(t.pacientes)}</span>
              <span className="sim-hud-label">somado, o lado paciente · {t.interacoesFeitas || 0} interações</span>
            </div>
            <div className="sim-hud-stats">
              <div className="sim-hud-stat" title="Aluno simulado — instrumento de medida">
                <span className="sim-hud-stat-val">{fmtUSD(t.alunos)}</span>
                <span className="sim-hud-stat-key">aluno</span>
              </div>
              <div className="sim-hud-stat" title="Chamada única, compartilhada por todos os modelos do lote">
                <span className="sim-hud-stat-val">{fmtUSD(t.persona)}</span>
                <span className="sim-hud-stat-key">persona (1×)</span>
              </div>
              <div className="sim-hud-stat">
                <span className="sim-hud-stat-val">{fmtUSD(t.geral)}</span>
                <span className="sim-hud-stat-key">total do lote</span>
              </div>
            </div>
          </div>
        </div>

        {lote.persona && (
          <div className="card" style={{ marginTop: 18 }}>
            <h3 style={{ marginTop: 0 }}>Ficha de persona do aluno</h3>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>
              Extraída uma vez por {lote.aluno.label} e usada por <strong>todos</strong> os modelos deste lote — é o que
              garante que a diferença medida seja do paciente, não do aluno.
            </p>
            <div className="bench-persona"><RichText text={lote.persona} /></div>
          </div>
        )}
      </div>
    );
  }

  // ── Tela de uma RUN (ao vivo e depois) ────────────────────────────────────
  const r = run.resumo || {};
  const p = r.paciente || {};
  const a = r.aluno || {};
  const feitas = (run.interacoes || []).length;
  const total = run.interacoesPedidas;
  const pct = total ? Math.min(100, Math.round((feitas / total) * 100)) : 0;
  const ultima = feitas ? run.interacoes[feitas - 1] : null;
  const duracao = run.completedAt && run.createdAt
    ? new Date(run.completedAt) - new Date(run.createdAt)
    : (run.createdAt ? Date.now() - new Date(run.createdAt) : 0);

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div className="eyebrow">Benchmarking de Simulação</div>
        <h2 style={{ marginBottom: 6 }}>{run.casoNome || 'Paciente'} <span className="accent">×</span> {run.paciente.label}</h2>
        <p style={{ marginBottom: 0 }}>
          Aluno simulado: <strong>{run.alunoNome || 'não identificado'}</strong> em {run.aluno.label} ·{' '}
          {run.personaCompartilhada ? 'persona do lote' : 'persona extraída do log enviado'} ·{' '}
          <span className={`bench-status ${run.status}`}>{STATUS_LABEL[run.status] || run.status}</span>
        </p>
      </div>

      <div className="bench-actions">
        {lote
          ? <button className="btn btn-outline btn-sm" onClick={() => setRun(null)}>← Voltar ao lote</button>
          : <button className="btn btn-outline btn-sm" onClick={voltarAoInicio}>← Novo benchmark</button>}
        {run.loteId && !lote && (
          <button className="btn btn-outline btn-sm" onClick={() => abrirLote(run.loteId)}>Ver o lote</button>
        )}
        {runRodando && !run.loteId && (
          <button className="btn btn-outline btn-sm" onClick={cancelar} disabled={cancelando || run.status === 'cancelando'}>
            {run.status === 'cancelando' ? 'Cancelando…' : 'Cancelar run'}
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={() => baixar('log')} disabled={!feitas || baixando === 'log'}>
          {baixando === 'log' ? 'Gerando…' : 'Baixar log (.txt)'}
        </button>
        {run.persona && (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => baixar('persona')}
            disabled={baixando === 'persona'}
            title="A ficha que define o aluno simulado, em arquivo próprio"
          >
            {baixando === 'persona' ? 'Gerando…' : 'Baixar persona (.txt)'}
          </button>
        )}
        {run.reasoningDisponivel && (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => baixar('reasoning')}
            disabled={baixando === 'reasoning'}
            title="Resumo do raciocínio dos dois lados, em arquivo separado do log"
          >
            {baixando === 'reasoning' ? 'Gerando…' : 'Baixar raciocínio (.txt)'}
          </button>
        )}
      </div>

      {run.error && <div className="alert error" style={{ marginTop: 12 }}>{run.error}</div>}
      {erroBox}

      {runRodando && (
        <div className="bench-progress">
          <div className="bench-progress-bar"><span style={{ width: `${pct}%` }} /></div>
          <div className="bench-progress-txt">
            {run.status === 'aguardando'
              ? 'Na fila do lote — começa quando o modelo anterior terminar.'
              : feitas === 0 && !run.persona
                ? 'Extraindo a persona do aluno a partir do log…'
                : `Interação ${feitas} de ${total} · ${fmtDuracao(duracao)} decorridos`}
          </div>
        </div>
      )}

      {/* Custo — o paciente em destaque, porque é o que está sendo medido */}
      <div className="sim-hud">
        <div className="sim-hud-main">
          <div className="sim-hud-total">
            <span className="sim-hud-num">{fmtUSD(p.usd)}</span>
            <span className="sim-hud-label">paciente · {feitas} {feitas === 1 ? 'interação' : 'interações'}</span>
          </div>
          <div className="sim-hud-stats">
            <div className="sim-hud-stat" title="Custo médio de UMA fala do paciente — a métrica que projeta produção">
              <span className="sim-hud-stat-val">{fmtUSD(p.mediaPorInteracao)}</span>
              <span className="sim-hud-stat-key">paciente/interação</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{ultima && ultima.paciente && ultima.paciente.custo ? fmtUSD(ultima.paciente.custo.usd) : '—'}</span>
              <span className="sim-hud-stat-key">última interação</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{p.latenciaMedia != null ? fmtSeg(p.latenciaMedia) : '—'}</span>
              <span className="sim-hud-stat-key">latência média</span>
            </div>
            <div className="sim-hud-stat" title="Aluno simulado (instrumento de medida)">
              <span className="sim-hud-stat-val">{fmtUSD(a.usd)}</span>
              <span className="sim-hud-stat-key">aluno</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{fmtUSD(r.totalUsd)}</span>
              <span className="sim-hud-stat-key">total</span>
            </div>
            <div className="sim-hud-stat">
              <span className="sim-hud-stat-val">{fmtUSD(r.mediaTotalPorInteracao)}</span>
              <span className="sim-hud-stat-key">média/interação</span>
            </div>
          </div>
        </div>
        <div className="sim-hud-tokens">
          paciente: {fmtTok(p.totais && p.totais.input)} input · {fmtTok(p.totais && p.totais.cacheRead)} cache (leitura)
          {' '}· {fmtTok(p.totais && p.totais.output)} output
          {p.totais && p.totais.reasoning ? ` (${fmtTok(p.totais.reasoning)} reasoning)` : ''}
          {'  ·  '}
          aluno: {fmtTok(a.totais && a.totais.input)} input · {fmtTok(a.totais && a.totais.cacheRead)} cache
          {' '}· {fmtTok(a.totais && a.totais.output)} output
        </div>
        {run.personaCompartilhada ? (
          <div className="sim-hud-nota">
            A <strong>extração da persona</strong> é do lote: uma chamada única, usada por todos os modelos, contabilizada
            no total do lote e não nesta run.
          </div>
        ) : a.persona && (
          <div className="sim-hud-nota">
            A <strong>extração da persona</strong> custou {fmtUSD(a.persona.usd)} numa chamada única, antes da conversa.
            É custo <strong>fixo</strong> (não cresce com o número de interações) e está incluído no total do aluno.
          </div>
        )}
      </div>

      {/* Transcrição — o mesmo formato de chat das outras abas */}
      <div className="card" style={{ marginTop: 18 }}>
        <h3 style={{ marginTop: 0 }}>Transcrição</h3>
        {!(run.transcript || []).length && (
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Nada ainda — a conversa aparece aqui conforme roda.</p>
        )}
        <div className="bench-transcript">
          {(run.transcript || []).map((t, i) => {
            const nInt = Math.floor(i / 2);
            const it = (run.interacoes || [])[nInt];
            const turno = it ? (t.ator === 'paciente' ? it.paciente : it.aluno) : null;
            return (
              <div key={i} className={`chat-message-row ${t.ator === 'paciente' ? 'assistant' : 'user'}`}>
                <div className="chat-message-author">
                  {t.ator === 'paciente' ? (run.casoNome || 'Paciente') : (run.alunoNome || 'Aluno simulado')}
                  <span className="bench-int-tag"> · interação {nInt + 1}</span>
                </div>
                <div className={`chat-message ${t.ator === 'paciente' ? 'assistant' : 'user'}`}><RichText text={t.texto} /></div>
                {turno && t.ator === 'paciente' && (
                  <div className="sim-turn-chip">
                    <strong>{turno.custo ? fmtUSD(turno.custo.usd) : 'custo n/d'}</strong>
                    <span>{turno.modelKey} · {turno.effort}</span>
                    <span>{fmtTok(turno.totais.input)} in · {fmtTok(turno.totais.cacheRead)} cache · {fmtTok(turno.totais.output)} out</span>
                    <span>{fmtSeg(turno.latenciaMs)}</span>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={fimRef} />
        </div>
      </div>

      {/* Tabela interação a interação */}
      {feitas > 0 && (
        <div className="card" style={{ marginTop: 18 }}>
          <h3 style={{ marginTop: 0 }}>Custo interação a interação</h3>
          <div className="bench-tabela">
            <div className="bench-tabela-head">
              <span>#</span><span>paciente</span><span>tokens do paciente</span><span>latência</span><span>aluno</span>
            </div>
            {run.interacoes.map((it) => (
              <div key={it.n} className="bench-tabela-row">
                <span>{it.n}</span>
                <span><strong>{it.paciente && it.paciente.custo ? fmtUSD(it.paciente.custo.usd) : '—'}</strong></span>
                <span>
                  {fmtTok(it.paciente && it.paciente.totais.input)} in ·{' '}
                  {fmtTok(it.paciente && it.paciente.totais.cacheRead)} cache ·{' '}
                  {fmtTok(it.paciente && it.paciente.totais.output)} out
                </span>
                <span>{it.paciente ? fmtSeg(it.paciente.latenciaMs) : '—'}</span>
                <span>{it.aluno && it.aluno.custo ? fmtUSD(it.aluno.custo.usd) : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ficha de persona: é o que define o aluno simulado, então fica visível */}
      {run.persona && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="bench-card-head">
            <h3 style={{ margin: 0 }}>Ficha de persona do aluno</h3>
            <button className="btn btn-outline btn-sm" onClick={() => baixar('persona')} disabled={baixando === 'persona'}>
              {baixando === 'persona' ? 'Gerando…' : 'Baixar .txt'}
            </button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>
            {run.personaCompartilhada
              ? `Extraída uma vez para o lote inteiro por ${run.aluno.label} — todos os modelos atenderam o mesmo aluno.`
              : `Extraída do log enviado por ${run.aluno.label}. É o único material que define como o aluno simulado atende.`}
          </p>
          <div className="bench-persona"><RichText text={run.persona} /></div>
        </div>
      )}
    </div>
  );
}
