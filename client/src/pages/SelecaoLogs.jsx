import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import LogActions from '../components/LogActions';
import { makeLogItems, evalSection, downloadText } from '../logFiles';
import RichText from '../components/RichText';

const SORT_OPTIONS = [
  { value: 'recent', label: 'Mais recentes' },
  { value: 'oldest', label: 'Mais antigos' },
  { value: 'score-desc', label: 'Nota: mais alta' },
  { value: 'score-asc', label: 'Nota: mais baixa' },
];
const STATUS_FILTERS = [
  { value: 'all', label: 'Todos os status' },
  { value: 'ativo', label: 'Ativo' },
  { value: 'rejeitado', label: 'Rejeitado' },
  { value: 'pending', label: 'Em avaliação (lote)' },
  { value: 'erro', label: 'Erro' },
];

function sortLogs(list, sortBy) {
  const arr = [...list];
  const score = (l) => (Number.isFinite(l.score) ? l.score : null);
  if (sortBy === 'score-desc' || sortBy === 'score-asc') {
    const dir = sortBy === 'score-desc' ? -1 : 1;
    arr.sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1; // sem nota sempre por último
      if (sb == null) return -1;
      return dir * (sa - sb);
    });
  } else {
    const dir = sortBy === 'oldest' ? 1 : -1;
    arr.sort((a, b) => dir * (new Date(a.timestamp || 0) - new Date(b.timestamp || 0)));
  }
  return arr;
}

function filterLogs(list, statusFilter, search) {
  const q = search.trim().toLowerCase();
  return list.filter((l) => {
    if (statusFilter !== 'all' && l.status !== statusFilter) return false;
    if (!q) return true;
    const c = l.candidate || {};
    const hay = [c.nome, c.email, c.whatsapp, c.faculdade, l.characterName].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// CSV: legível por humano (abre em Excel/Sheets) e igualmente fácil de somar/
// filtrar por máquina (aqui ou pelo Claude) — mais direto que JSON pra uma
// tabela simples, e mais estruturado que .txt. Aspas duplicadas escapam campo;
// campo com vírgula/aspas/quebra de linha vai entre aspas.
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildSummaryCsv(list) {
  const header = ['Nome completo', 'Paciente (caso)', 'Nota final', 'Status', 'Data/hora (ISO)'];
  const rows = list.map((l) => {
    const c = l.candidate || {};
    return [
      c.nome || '',
      l.characterName || '',
      l.score == null ? '' : l.score,
      STATUS_LABEL[l.status] || l.status || '',
      l.timestamp || '',
    ].map(csvField).join(',');
  });
  // BOM no início: Excel só reconhece acentos em UTF-8 sem BOM como Latin-1.
  return '\uFEFF' + [header.map(csvField).join(','), ...rows].join('\r\n');
}

// Rótulos dos 6 critérios do avaliador (avaliacao/avaliador-processo-seletivo-v1.md,
// bloco [notas-supervisor], chaves "1".."6") — pra virar coluna própria no CSV
// completo em vez do JSON crú de criteriaScores.
const CRITERIA_LABELS = {
  1: 'Construção linguística',
  2: 'Relação terapêutica',
  3: 'Confiança transmitida',
  4: 'Priorização',
  5: 'Aprofundamento',
  6: 'Flexibilidade e criatividade',
};

// CSV completo pra análise de dados externa: uma linha por candidato/avaliação,
// com todos os campos estruturados (sem a transcrição, que é texto livre e não
// tabular — essa segue disponível por log individual via LogActions).
function buildFullCsv(list) {
  const header = [
    'Nome completo', 'E-mail', 'WhatsApp', 'Faculdade', 'Período',
    'Paciente (caso)', 'Sessões', 'Duração (s)',
    'Status', 'Nota final (0-100)',
    ...Object.values(CRITERIA_LABELS).map((l) => `Critério: ${l}`),
    'Avaliação (texto)', 'Data/hora (ISO)', 'Expira em (ISO)',
  ];
  const rows = list.map((l) => {
    const c = l.candidate || {};
    const crit = l.criteriaScores || {};
    return [
      c.nome || '', c.email || '', c.whatsapp || '', c.faculdade || '', c.periodo || '',
      l.characterName || '', l.sessionCount || 1, Math.round(Number(l.durationSeconds) || 0),
      STATUS_LABEL[l.status] || l.status || '', l.score == null ? '' : l.score,
      ...Object.keys(CRITERIA_LABELS).map((k) => (crit[k] == null ? '' : crit[k])),
      l.evaluation || '', l.timestamp || '', l.expiresAt || '',
    ].map(csvField).join(',');
  });
  return '\uFEFF' + [header.map(csvField).join(','), ...rows].join('\r\n');
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDuration(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const m = Math.floor(s / 60);
  return m >= 1 ? `${m} min` : `${s}s`;
}
function daysUntil(iso) {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return null;
  return Math.max(0, Math.ceil((d - Date.now()) / (24 * 60 * 60 * 1000)));
}

const STATUS_LABEL = { ativo: 'Ativo', rejeitado: 'Rejeitado', pending: 'Em avaliação (lote)', erro: 'Erro' };

function transcriptText(log) {
  const rows = [];
  let last = null;
  for (const m of (log.messages || [])) {
    const s = Number.isFinite(m.session) && m.session >= 1 ? Math.floor(m.session) : 1;
    if (s !== last) { rows.push(`═══════ SESSÃO ${s} ═══════`); last = s; }
    const author = m.role === 'user' ? 'Candidato' : (log.characterName || 'Paciente');
    const star = m.highlighted ? ' ★' : '';
    const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
    rows.push(`[${author}${star}]\n${m.content}${comment}`);
  }
  return rows.join('\n\n---\n\n');
}

function buildStrings(log) {
  const c = log.candidate || {};
  const transcript = transcriptText(log);
  const logStr = [
    'PROCESSO SELETIVO — LOG DO ATENDIMENTO',
    '',
    `Candidato: ${c.nome || '—'}`,
    `E-mail: ${c.email || '—'}`,
    `WhatsApp: ${c.whatsapp || '—'}`,
    `Faculdade: ${c.faculdade || '—'}`,
    `Período: ${c.periodo || '—'}`,
    `Caso: ${log.characterName || '—'}`,
    `Data: ${fmtDate(log.timestamp)}`,
    '',
    transcript || '(sem mensagens)',
  ].join('\n');

  const hasEval = (log.status === 'ativo' || log.status === 'rejeitado') || log.score != null;
  const reasoning = (log.reasoning || '').trim();
  const evalBody = hasEval
    ? [
        `Nota final: ${log.score == null ? '—' : `${log.score}/100`}`,
        `Status: ${STATUS_LABEL[log.status] || log.status}`,
        '',
        (log.evaluation || '').trim() || '(sem texto de avaliação)',
        ...(reasoning ? ['', '─── RACIOCÍNIO DO AVALIADOR ───', '', reasoning] : []),
      ].join('\n')
    : '';

  return { logStr, evalBody, hasEval };
}

export default function SelecaoLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [tab, setTab] = useState('log'); // log | eval
  const [sortBy, setSortBy] = useState('recent');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  const visibleLogs = useMemo(
    () => sortLogs(filterLogs(logs, statusFilter, search), sortBy),
    [logs, statusFilter, search, sortBy],
  );

  function load() {
    setLoading(true);
    api.selecaoLogs()
      .then((list) => setLogs(Array.isArray(list) ? list : []))
      .catch((err) => setError(err.message || 'Erro ao carregar os logs.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function downloadSummary() {
    const csv = buildSummaryCsv(visibleLogs);
    const date = new Date().toISOString().slice(0, 10);
    downloadText(`sumario-processo-seletivo-${date}.csv`, csv, 'text/csv;charset=utf-8');
  }

  function downloadFull() {
    const csv = buildFullCsv(visibleLogs);
    const date = new Date().toISOString().slice(0, 10);
    downloadText(`processo-seletivo-completo-${date}.csv`, csv, 'text/csv;charset=utf-8');
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Processo Seletivo · Logs</div>
          <h2>
            <Typewriter text="Logs de " />
            <span className="accent"><Typewriter text="Avaliações" delayStart={360} /></span>
          </h2>
          <p>Cada avaliação de candidato, com dados, transcrição, nota e feedback. Os logs completos expiram em 15 dias.</p>
        </div>
        <button className="btn btn-outline" onClick={load} disabled={loading}>Atualizar</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {!loading && logs.length > 0 && (
        <div className="card selecao-logs-filters">
          <div className="aval-controls">
            <div>
              <label htmlFor="selecao-search">Buscar</label>
              <input
                id="selecao-search"
                type="text"
                placeholder="Nome, e-mail, faculdade, caso…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label htmlFor="selecao-status">Status</label>
              <select id="selecao-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: '100%' }}>
                {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="selecao-sort">Ordenar por</label>
              <select id="selecao-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: '100%' }}>
                {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="selecao-logs-count-row">
            <span className="selecao-logs-count">{visibleLogs.length} de {logs.length} avaliações</span>
            <button
              className="btn btn-outline btn-sm"
              onClick={downloadSummary}
              disabled={visibleLogs.length === 0}
              title="Nome completo + paciente atendido + nota final, em .csv (abre no Excel/Sheets e é fácil de processar)"
            >
              Baixar sumário (.csv)
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={downloadFull}
              disabled={visibleLogs.length === 0}
              title="Todos os dados estruturados (candidato, caso, duração, status, nota, cada critério da avaliação e o texto da avaliação) em .csv, uma linha por avaliação — pronto pra importar numa ferramenta de análise de dados. Não inclui a transcrição da sessão."
            >
              Exportar tudo (.csv)
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma avaliação de candidato registrada ainda.
        </div>
      ) : visibleLogs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma avaliação encontrada com esse filtro.
        </div>
      ) : (
        visibleLogs.map((log) => {
          const c = log.candidate || {};
          const reasoning = (log.reasoning || '').trim();
          const { logStr, evalBody, hasEval } = buildStrings(log);
          const items = makeLogItems({
            baseName: c.nome || 'candidato',
            getLog: () => logStr,
            getEval: hasEval ? () => `Candidato: ${c.nome || '—'}\nCaso: ${log.characterName || '—'}${evalSection(evalBody)}` : null,
            getBoth: hasEval ? () => `${logStr}${evalSection(evalBody)}` : null,
          });
          const isOpen = openId === log.id;
          const expDays = daysUntil(log.expiresAt);
          return (
            <div className="selecao-log-card" key={log.id}>
              <div className="selecao-log-head">
                <span className="selecao-log-name">{c.nome || 'Candidato'}</span>
                <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className={`selecao-badge ${log.status}`}>{STATUS_LABEL[log.status] || log.status}</span>
                  <strong style={{ color: 'var(--marrs-deep)' }}>{log.score == null ? '—' : `${log.score}/100`}</strong>
                </span>
              </div>
              <div className="selecao-log-meta">
                <span>✉ {c.email || '—'}</span>
                <span>📱 {c.whatsapp || '—'}</span>
                <span>🎓 {c.faculdade || '—'}{c.periodo ? ` · ${c.periodo}` : ''}</span>
                <span>🧑 {log.characterName || '—'}</span>
                <span>🗓 {log.sessionCount || 1} {(log.sessionCount || 1) === 1 ? 'sessão' : 'sessões'}</span>
                <span>🕓 {fmtDate(log.timestamp)}</span>
                <span>⏱ {fmtDuration(log.durationSeconds)}</span>
                {expDays != null && <span>expira em {expDays} {expDays === 1 ? 'dia' : 'dias'}</span>}
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => { setOpenId(isOpen ? null : log.id); setTab('log'); }}
                >
                  {isOpen ? 'Ocultar' : 'Ver'}
                </button>
                <LogActions items={items} inline size="sm" />
              </div>

              {isOpen && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className={`btn btn-sm ${tab === 'log' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('log')}>Log da sessão</button>
                    {hasEval && (
                      <button className={`btn btn-sm ${tab === 'eval' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('eval')}>Avaliação</button>
                    )}
                    {reasoning && (
                      <button className={`btn btn-sm ${tab === 'reasoning' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('reasoning')}>Raciocínio</button>
                    )}
                  </div>
                  <div className="selecao-transcript">
                    {tab === 'log'
                      ? (() => {
                          const out = [];
                          let last = null;
                          (log.messages || []).forEach((m, i) => {
                            const s = Number.isFinite(m.session) && m.session >= 1 ? Math.floor(m.session) : 1;
                            if (s !== last) { out.push(<div key={`s${i}`} className="selecao-session-divider">Sessão {s}</div>); last = s; }
                            out.push(
                              <div key={i} style={{ marginBottom: 12 }}>
                                <span className={m.role === 'user' ? 'role-user' : 'role-assistant'}>
                                  {m.highlighted ? '★ ' : ''}{m.role === 'user' ? 'Candidato' : (log.characterName || 'Paciente')}
                                </span>
                                <div><RichText text={m.content} /></div>
                                {m.highlighted && m.comment && (
                                  <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--marrs-deep)' }}>{`{${m.comment}}`}</div>
                                )}
                              </div>
                            );
                          });
                          return out;
                        })()
                      : tab === 'reasoning'
                      ? (
                        <div>
                          <div className="aval-reasoning-head" style={{ marginBottom: 10 }}>Raciocínio do avaliador</div>
                          <div className="aval-reasoning-text"><RichText text={reasoning} /></div>
                        </div>
                      )
                      : (
                        <div>
                          <div style={{ marginBottom: 10, fontWeight: 700, color: 'var(--marrs-deep)' }}>
                            Nota final: {log.score == null ? '—' : `${log.score}/100`}
                          </div>
                          {(log.evaluation || '').trim() || '(avaliação ainda em processamento ou indisponível)'}
                        </div>
                      )}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
