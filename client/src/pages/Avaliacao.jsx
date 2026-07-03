import { useState, useRef, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { useWakeLock } from '../useWakeLock';

// Avaliação Independente v25 (AvaliAllos) — TESTE. O supervisor joga um log,
// seleciona o caso (que dá o Bloco 1) e recebe o pipeline completo: 14 nós (um
// por critério, ANÁLISE / NOTA / CONFIANÇA) + agregador (nota 0–100) +
// sintetizador (corpo do feedback do aluno). Duas visões: a do supervisor (as
// partes e a nota) e o feedback do aluno (texto montado). Mostra o modelo usado
// e o CUSTO EXATO da run (calculado dos tokens que as 15 chamadas devolveram ×
// preço do modelo — é sobre esses tokens que a OpenAI cobra). Isolado do v16.2.

function confLabel(c) {
  if (c === 'alta') return 'confiança alta';
  if (c === 'média' || c === 'media') return 'confiança média';
  if (c === 'baixa') return 'confiança baixa';
  return 'sem confiança';
}

// Custo em dólar: valores pequenos (centavos de centavo), então 4 casas e sem
// arredondar pra zero.
function fmtUSD(usd) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  return '$' + usd.toFixed(4);
}

// Tokens compactos: 12.3k, 950, etc.
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}


export default function Avaliacao({ user }) {
  const [transcript, setTranscript] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [view, setView] = useState('supervisor'); // 'supervisor' | 'aluno'
  const fileInputRef = useRef(null);

  // Mantém a tela ativa enquanto roda (14 nós GPT + sintetizador levam alguns segundos).
  useWakeLock(loading);

  // Casos disponíveis (personagens FreePlay). Só precisamos de id+nome; o Bloco 1
  // (evaluationCriteria) é resolvido server-side a partir do casoId.
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
      .catch(() => { /* dropdown vazio se falhar */ });
    return () => { cancelled = true; };
  }, []);

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

  async function handleStart() {
    if (!selectedCharacterId) { setError('Selecione o caso correspondente (necessário para o Bloco 1).'); return; }
    if (!transcript.trim()) { setError('Cole ou envie a transcrição da sessão.'); return; }
    setError('');
    setLoading(true);
    setResult(null);
    try {
      const data = await api.avaliacaoIndependente(transcript, selectedCharacterId);
      setResult(data);
    } catch (err) {
      setError(err.message || 'Erro ao rodar a avaliação.');
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setTranscript('');
    setSelectedCharacterId('');
    setResult(null);
    setView('supervisor');
    setError('');
    setLoading(false);
  }

  // ── Tela de carregamento (rodando os 14 nós) ──
  if (loading) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Avaliação Independente · v25</div>
          <h2>Avaliando os <span className="accent">14 critérios</span></h2>
          <p>Cada critério é avaliado por um nó independente, em paralelo. Pode levar alguns segundos.</p>
          <div className="ornament" />
        </div>
        <div className="card evaluating-card">
          <div className="evaluating-orb">
            <div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" />
          </div>
          <div className="evaluating-status">
            <div className="evaluating-line"><span className="dot active" /> Lendo o Bloco 1 do caso e o log</div>
            <div className="evaluating-line"><span className="dot active" /> 14 nós avaliando, um por critério</div>
            <div className="evaluating-line"><span className="dot active" /> Agregando a nota final</div>
            <div className="evaluating-line"><span className="dot pulse" /> Sintetizando o feedback do aluno</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Tela de resultado (as partes, o todo e o feedback do aluno) ──
  if (result) {
    const incluidos = result.partes.filter((p) => p.incluido).length;
    const inst = result.instrumentacao;
    return (
      <div>
        <div className="page-header with-action">
          <div>
            <div className="eyebrow">Avaliação Independente · v25</div>
            <h2>Resultado da <span className="accent">avaliação</span></h2>
            <p>{result.casoNome ? `Caso: ${result.casoNome} · ` : ''}pipeline completo: as 14 partes, a nota final e o feedback redigido do aluno.</p>
          </div>
          <button className="btn btn-outline" onClick={handleReset}>Nova avaliação</button>
        </div>

        {/* Modelo + custo EXATO da run (dos tokens que as 15 chamadas devolveram) */}
        {inst && inst.model && (
          <div className="v25-modelbar">
            Modelo: <strong>{inst.model}</strong>
            {inst.effort ? <> · effort: <strong>{inst.effort}</strong></> : null}
            {inst.custo
              ? <> · custo: <strong>{fmtUSD(inst.custo.usd)}</strong></>
              : (inst.totais ? <> · custo: <strong title="Modelo sem preço na tabela — mostrando só tokens">n/d</strong></> : null)}
            {inst.totais && (
              <span className="v25-modelbar-tok">
                {' '}· {fmtTok(inst.totais.input)} in · {fmtTok(inst.totais.cached)} cache · {fmtTok(inst.totais.output)} out
                {inst.totais.reasoning ? ` (${fmtTok(inst.totais.reasoning)} reasoning)` : ''}
              </span>
            )}
          </div>
        )}

        {/* Alternador de visão */}
        <div className="v25-viewtabs">
          <button className={`v25-viewtab ${view === 'supervisor' ? 'active' : ''}`} onClick={() => setView('supervisor')}>Visão do supervisor</button>
          <button className={`v25-viewtab ${view === 'aluno' ? 'active' : ''}`} onClick={() => setView('aluno')}>Feedback do aluno</button>
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
                  {result.notaFinal != null
                    ? `Agregada de ${incluidos} de 14 critérios (os de confiança baixa ficaram fora).`
                    : 'Não avaliável: sem critérios com confiança suficiente para uma nota.'}
                </div>
              </div>
            </div>

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
          </>
        ) : (
          <div className="card v25-feedback">
            {result.feedbackAluno
              ? <div className="v25-feedback-text">{result.feedbackAluno}</div>
              : <div className="v25-feedback-empty">Caso não avaliável: nenhum critério teve confiança suficiente, então não há feedback de aluno a montar. Veja as partes na visão do supervisor.</div>}
          </div>
        )}
      </div>
    );
  }

  // ── Tela inicial (entrada) ──
  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Avaliação Independente · v25</div>
        <h2><Typewriter text="Avaliar uma " /><span className="accent"><Typewriter text="Sessão" delayStart={520} /></span></h2>
        <p>
          Selecione o caso, cole a transcrição completa da sessão e receba o pipeline completo: os{' '}
          <strong>14 critérios</strong> (cada um com análise, nota e confiança, avaliados por nós independentes),
          a <strong>nota final de 0 a 100</strong> e o <strong>feedback redigido do aluno</strong>. É um teste —
          roda em paralelo ao avaliador atual.
        </p>
        <div className="ornament" />
      </div>

      <div className="avaliacao-intro">
        <div>
          <label htmlFor="character-select">Caso correspondente <em style={{ color: 'var(--danger)', fontStyle: 'normal' }}>*</em></label>
          <select
            id="character-select"
            value={selectedCharacterId}
            onChange={(e) => setSelectedCharacterId(e.target.value)}
            style={{ width: '100%' }}
          >
            <option value="">— selecione o caso —</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.age ? `, ${c.age}` : ''}</option>
            ))}
          </select>
          <small style={{ display: 'block', marginTop: 6, color: 'var(--marrs-dark)', fontSize: 12 }}>
            Obrigatório: o avaliador v25 usa o Bloco 1 (gabarito) do caso como referência. O caso precisa ter o Bloco 1 configurado.
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
          <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>Enviar arquivo .txt</button>
          <input ref={fileInputRef} type="file" accept=".txt" onChange={handleFileUpload} style={{ display: 'none' }} />
          {transcript && (
            <span style={{ fontSize: 12, color: 'var(--marrs-dark)', letterSpacing: '0.08em' }}>
              {transcript.length.toLocaleString('pt-BR')} caracteres carregados
            </span>
          )}
        </div>

        {error && <div className="alert error">{error}</div>}

        <button className="btn btn-primary btn-lg" onClick={handleStart}>Iniciar Avaliação</button>
      </div>
    </div>
  );
}
