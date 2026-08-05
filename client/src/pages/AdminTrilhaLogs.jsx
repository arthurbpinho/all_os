import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Logs da Trilha (admin) — foco em CUSTO: cada exercício pode ter até 3 IAs
// envolvidas (personagem, avaliador opcional, esquema visual opcional). O
// objetivo é comparar o custo × qualidade das opções (mini/GLM/5.4/5.5/Claude)
// com dados reais de uso, não estimativa.

const SORT_OPTIONS = [
  { value: 'recent', label: 'Mais recentes' },
  { value: 'oldest', label: 'Mais antigos' },
  { value: 'cost-desc', label: 'Custo: mais caro' },
  { value: 'cost-asc', label: 'Custo: mais barato' },
  { value: 'score-desc', label: 'Nota: mais alta' },
  { value: 'score-asc', label: 'Nota: mais baixa' },
];

const DIFFICULTY_LABEL = { iniciante: 'Iniciante', intermediario: 'Intermediário', avancado: 'Avançado' };

// Tira a data de pin do id (ex.: 'gpt-5.4-mini-2026-03-17' → 'gpt-5.4-mini') —
// GLM/Claude não têm sufixo de data, então o replace não altera nada neles.
function shortModel(m) {
  return String(m || '—').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function fmtUsd(v) {
  if (v == null) return '—';
  if (v === 0) return '$0';
  return `$${v.toFixed(5)}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const m = Math.floor(s / 60);
  return m >= 1 ? `${m} min` : `${s}s`;
}

function totalCostOf(log) {
  return log.cost && Number.isFinite(log.cost.totalUsd) ? log.cost.totalUsd : null;
}

function sortLogs(list, sortBy) {
  const arr = [...list];
  if (sortBy === 'cost-desc' || sortBy === 'cost-asc') {
    const dir = sortBy === 'cost-desc' ? -1 : 1;
    arr.sort((a, b) => {
      const ca = totalCostOf(a), cb = totalCostOf(b);
      if (ca == null && cb == null) return 0;
      if (ca == null) return 1;
      if (cb == null) return -1;
      return dir * (ca - cb);
    });
  } else if (sortBy === 'score-desc' || sortBy === 'score-asc') {
    const dir = sortBy === 'score-desc' ? -1 : 1;
    arr.sort((a, b) => {
      const sa = Number.isFinite(a.score) ? a.score : null;
      const sb = Number.isFinite(b.score) ? b.score : null;
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return dir * (sa - sb);
    });
  } else {
    const dir = sortBy === 'oldest' ? 1 : -1;
    arr.sort((a, b) => dir * (new Date(a.timestamp || 0) - new Date(b.timestamp || 0)));
  }
  return arr;
}

function filterLogs(list, search) {
  const q = search.trim().toLowerCase();
  if (!q) return list;
  return list.filter((l) => {
    const hay = [l.userName, l.itemTitle].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// Agrupa um componente de custo (chat/evaluator/imageSchema) por MODELO, pra
// comparar cost-benefit entre as opções — é o objetivo principal da tela.
function groupByModel(list, key) {
  const map = new Map();
  for (const log of list) {
    const part = log.cost && log.cost[key];
    if (!part) continue;
    const model = shortModel(part.model);
    const cur = map.get(model) || { model, count: 0, totalUsd: 0, unpriced: 0 };
    cur.count += 1;
    if (Number.isFinite(part.usd)) cur.totalUsd += part.usd;
    else cur.unpriced += 1;
    map.set(model, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function ModelBreakdownCard({ title, rows }) {
  if (!rows.length) return null;
  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div style={{ fontWeight: 700, color: 'var(--marrs-deep)', marginBottom: 10, fontSize: 14 }}>{title}</div>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--ink-soft)', textAlign: 'left' }}>
            <th style={{ paddingBottom: 6 }}>Modelo</th>
            <th style={{ paddingBottom: 6 }}>Usos</th>
            <th style={{ paddingBottom: 6 }}>Custo total</th>
            <th style={{ paddingBottom: 6 }}>Média/uso</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 0', fontWeight: 600 }}>{r.model}</td>
              <td style={{ padding: '6px 0' }}>{r.count}{r.unpriced ? ` (${r.unpriced} sem preço)` : ''}</td>
              <td style={{ padding: '6px 0', color: 'var(--marrs-deep)', fontWeight: 600 }}>{fmtUsd(r.totalUsd)}</td>
              <td style={{ padding: '6px 0' }}>{fmtUsd(r.totalUsd / r.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Célula compacta de um componente de custo (modelo + $) — "—" quando o
// exercício não tinha esse componente habilitado (ex.: sem avaliador).
function CostCell({ part }) {
  if (!part) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const usage = part.usage || {};
  const title = `Tokens: ${usage.input || 0} in · ${usage.cacheRead || 0} cache · ${usage.output || 0} out`;
  return (
    <span title={title}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-soft)' }}>{shortModel(part.model)}</span>
      <span style={{ fontWeight: 600 }}>{fmtUsd(part.usd)}</span>
    </span>
  );
}

export default function AdminTrilhaLogs() {
  const [logs, setLogs] = useState([]);
  const [skillsById, setSkillsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('recent');
  const [viewing, setViewing] = useState(null); // log sendo inspecionado no modal

  function load() {
    setLoading(true);
    Promise.all([api.getLogs(), api.getTrilhaSkills().catch(() => [])])
      .then(([allLogs, skills]) => {
        setLogs((Array.isArray(allLogs) ? allLogs : []).filter((l) => l && l.type === 'exercise'));
        setSkillsById(Object.fromEntries((skills || []).map((s) => [s.id, s])));
      })
      .catch((err) => setError(err.message || 'Erro ao carregar os logs.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  const visibleLogs = useMemo(() => sortLogs(filterLogs(logs, search), sortBy), [logs, search, sortBy]);

  const chatBreakdown = useMemo(() => groupByModel(visibleLogs, 'chat'), [visibleLogs]);
  const evalBreakdown = useMemo(() => groupByModel(visibleLogs, 'evaluator'), [visibleLogs]);
  const imageBreakdown = useMemo(() => groupByModel(visibleLogs, 'imageSchema'), [visibleLogs]);

  const grandTotal = useMemo(
    () => visibleLogs.reduce((sum, l) => sum + (totalCostOf(l) || 0), 0),
    [visibleLogs],
  );
  const pricedCount = useMemo(() => visibleLogs.filter((l) => totalCostOf(l) != null).length, [visibleLogs]);

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração</div>
          <h2><Typewriter text="Logs da " /><span className="accent"><Typewriter text="Trilha" delayStart={360} /></span></h2>
          <p>Cada sessão de exercício, com o custo real de cada IA envolvida (personagem, avaliador e esquema visual) — compare o custo × benefício entre os modelos.</p>
        </div>
        <button className="btn btn-outline" onClick={load} disabled={loading}>Atualizar</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {!loading && logs.length > 0 && (
        <>
          <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '16px 18px', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Custo total (filtro atual)</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--marrs-deep)' }}>{fmtUsd(grandTotal)}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Sessões com custo calculado</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{pricedCount} de {visibleLogs.length}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Custo médio por sessão</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{pricedCount ? fmtUsd(grandTotal / pricedCount) : '—'}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginBottom: 20 }}>
            <ModelBreakdownCard title="Personagem (IA do exercício)" rows={chatBreakdown} />
            <ModelBreakdownCard title="Avaliador" rows={evalBreakdown} />
            <ModelBreakdownCard title="Esquema visual" rows={imageBreakdown} />
          </div>

          <div className="card" style={{ padding: '14px 18px', marginBottom: 16 }}>
            <div className="aval-controls">
              <div>
                <label htmlFor="trilha-logs-search">Buscar</label>
                <input
                  id="trilha-logs-search" type="text" placeholder="Aluno, exercício…"
                  value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%' }}
                />
              </div>
              <div>
                <label htmlFor="trilha-logs-sort">Ordenar por</label>
                <select id="trilha-logs-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: '100%' }}>
                  {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-soft)' }}>{visibleLogs.length} de {logs.length} sessões</div>
          </div>
        </>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma sessão de exercício registrada ainda.
        </div>
      ) : visibleLogs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma sessão encontrada com esse filtro.
        </div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Aluno</th>
                <th>Exercício</th>
                <th>Nota</th>
                <th>Personagem</th>
                <th>Avaliador</th>
                <th>Esquema</th>
                <th>Total</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.map((log) => (
                <tr key={log.id}>
                  <td style={{ fontSize: 13, color: 'var(--ink-soft)', whiteSpace: 'nowrap' }}>{fmtDate(log.timestamp)}</td>
                  <td style={{ fontWeight: 500 }}>{log.userName || '—'}</td>
                  <td>
                    <div style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>{log.itemTitle || '—'}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                      {skillsById[log.skillId]?.name || ''}{log.difficulty ? ` · ${DIFFICULTY_LABEL[log.difficulty] || log.difficulty}` : ''}
                    </div>
                  </td>
                  <td>{log.score == null ? <span style={{ color: 'var(--muted)' }}>—</span> : `${log.score}%`}</td>
                  <td><CostCell part={log.cost && log.cost.chat} /></td>
                  <td><CostCell part={log.cost && log.cost.evaluator} /></td>
                  <td><CostCell part={log.cost && log.cost.imageSchema} /></td>
                  <td style={{ fontWeight: 700, color: 'var(--marrs-deep)' }}>{fmtUsd(totalCostOf(log))}</td>
                  <td>
                    <button className="btn btn-outline btn-sm" onClick={() => setViewing(log)}>Ver</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewing && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div className="modal" style={{ maxWidth: 720, maxHeight: '85vh', overflow: 'auto' }}>
            <h3>{viewing.itemTitle || 'Sessão'}</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: -8 }}>
              {viewing.userName || '—'} · {fmtDate(viewing.timestamp)} · {fmtDuration(viewing.durationSeconds)}
              {viewing.score != null && <> · Nota: {viewing.score}%</>}
            </p>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '12px 0', fontSize: 13 }}>
              <div><strong>Personagem:</strong> <CostCell part={viewing.cost && viewing.cost.chat} /></div>
              <div><strong>Avaliador:</strong> <CostCell part={viewing.cost && viewing.cost.evaluator} /></div>
              <div><strong>Esquema:</strong> <CostCell part={viewing.cost && viewing.cost.imageSchema} /></div>
              <div><strong>Total:</strong> {fmtUsd(totalCostOf(viewing))}</div>
            </div>

            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Transcrição</div>
              <div style={{ maxHeight: 260, overflow: 'auto', fontSize: 13, lineHeight: 1.6 }}>
                {(viewing.messages || []).map((m, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <span style={{ fontWeight: 600, color: m.role === 'user' ? 'var(--marrs-deep)' : 'var(--terra)' }}>
                      {m.role === 'user' ? (viewing.userName || 'Aluno') : (viewing.itemTitle || 'Personagem')}
                    </span>
                    <div>{m.content}</div>
                  </div>
                ))}
              </div>
            </div>

            {viewing.evaluation && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Avaliação</div>
                <div style={{ maxHeight: 220, overflow: 'auto', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {viewing.evaluation
                    .replace(/\[NOTA:[^\]]+\]\s*/g, '')
                    .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[notas-supervisor\][\s\S]*$/i, '')
                    .trim()}
                </div>
              </div>
            )}

            {viewing.imageSchema && (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Esquema visual</div>
                {/* Mesma regra de segurança do ChatSession: SVG só via <img>
                    (blob URL), nunca injetado no DOM. */}
                <img
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(viewing.imageSchema)}`}
                  alt="Esquema visual da sessão"
                  style={{ maxWidth: '100%', height: 'auto', display: 'block', margin: '0 auto', background: 'var(--cream-2)', borderRadius: 'var(--radius-lg)', padding: 12 }}
                />
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setViewing(null)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
