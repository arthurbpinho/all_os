import { useEffect, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import LogActions from '../components/LogActions';
import { makeLogItems, evalSection } from '../logFiles';

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
  const evalBody = hasEval
    ? [
        `Nota final: ${log.score == null ? '—' : `${log.score}/100`}`,
        `Status: ${STATUS_LABEL[log.status] || log.status}`,
        '',
        (log.evaluation || '').trim() || '(sem texto de avaliação)',
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

  function load() {
    setLoading(true);
    api.selecaoLogs()
      .then((list) => setLogs(Array.isArray(list) ? list : []))
      .catch((err) => setError(err.message || 'Erro ao carregar os logs.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

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

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma avaliação de candidato registrada ainda.
        </div>
      ) : (
        logs.map((log) => {
          const c = log.candidate || {};
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
                                <div>{m.content}</div>
                                {m.highlighted && m.comment && (
                                  <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--marrs-deep)' }}>{`{${m.comment}}`}</div>
                                )}
                              </div>
                            );
                          });
                          return out;
                        })()
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
