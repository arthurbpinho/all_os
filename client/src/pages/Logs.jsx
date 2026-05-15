import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';

const TYPE_LABELS = {
  exercise: 'Trilha',
  freeplay: 'Simulação',
  neuro: 'Neuroavaliação',
};

function formatDate(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sanitizeFilename(name) {
  return (name || 'log')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function downloadLogAsText(log) {
  const messages = Array.isArray(log.messages) ? log.messages : [];
  const header = [
    `Tipo: ${TYPE_LABELS[log.type] || log.type || '—'}`,
    `Caso: ${log.itemTitle || log.title || '—'}`,
    `Terapeuta: ${log.userName || '—'}`,
    `Data: ${formatDate(log.timestamp || log.createdAt)}`,
    log.durationSeconds
      ? `Duração: ${Math.floor(log.durationSeconds / 60).toString().padStart(2, '0')}:${(log.durationSeconds % 60).toString().padStart(2, '0')}`
      : null,
    log.score != null ? `Nota: ${log.score}` : null,
  ].filter(Boolean).join('\n');

  const lines = messages
    .filter((m) => !m.isSystem)
    .map((m, i) => {
      const isUser = m.role === 'user';
      const isEvaluation = log.evaluationStartIdx != null && i >= log.evaluationStartIdx;
      const author = isEvaluation
        ? (isUser ? log.userName || 'Terapeuta' : 'all_OS · Avaliador')
        : (isUser ? log.userName || 'Terapeuta' : log.itemTitle || 'Paciente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    });

  const evalSection = log.evaluation
    ? `\n\n===========================\nAVALIAÇÃO DA IA\n===========================\n\n${log.evaluation}`
    : '';

  const body = `${header}\n\n---\n\n${lines.join('\n\n---\n\n')}${evalSection}`;
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = (log.timestamp || log.createdAt || new Date().toISOString()).slice(0, 10);
  a.href = url;
  a.download = `log-${sanitizeFilename(log.userName)}-${sanitizeFilename(log.itemTitle)}-${stamp}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function LogCard({ log, showDownload }) {
  const [expanded, setExpanded] = useState(false);
  const messages = Array.isArray(log.messages) ? log.messages : [];

  return (
    <div
      className={`log-card ${expanded ? 'expanded' : ''}`}
      data-type={log.type}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="log-meta">
        <span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
          {formatDate(log.timestamp || log.createdAt)}
        </span>
        {log.userName && (
          <span>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            {log.userName}
          </span>
        )}
        {log.type && <span style={{ fontWeight: 500 }}>{TYPE_LABELS[log.type] || log.type}</span>}
        <span>{messages.filter((m) => !m.isSystem).length} {messages.filter((m) => !m.isSystem).length === 1 ? 'mensagem' : 'mensagens'}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h4>{log.itemTitle || log.title || 'Sessão sem título'}</h4>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <ScoreBadge score={log.score} />
          {showDownload && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={(e) => { e.stopPropagation(); downloadLogAsText(log); }}
              title="Baixar log desta sessão"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Baixar
            </button>
          )}
          <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {expanded ? 'ocultar' : 'expandir'}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="log-detail" onClick={(e) => e.stopPropagation()}>
          {messages.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14, fontStyle: 'italic' }}>Nenhuma mensagem registrada.</p>
          ) : (
            messages.map((msg, i) => {
              if (msg.isSystem) return null;
              const isUser = msg.role === 'user';
              const showSeparator = log.evaluationStartIdx != null && i === log.evaluationStartIdx;
              const isEvaluation = log.evaluationStartIdx != null && i >= log.evaluationStartIdx;
              const roleLabel = isEvaluation
                ? (isUser ? 'Terapeuta' : 'all_OS · Avaliador')
                : (isUser ? 'Terapeuta' : 'Paciente');
              return (
                <div key={i}>
                  {showSeparator && (
                    <div style={{
                      textAlign: 'center', padding: '10px 0', margin: '10px 0',
                      borderTop: '1px solid var(--terra)',
                      borderBottom: '1px solid var(--terra)',
                      background: 'var(--terra-tint)',
                    }}>
                      <span style={{ fontSize: 11, color: 'var(--terra)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.2em' }}>
                        Avaliação da Sessão
                      </span>
                    </div>
                  )}
                  <div className={`msg ${isUser ? 'user' : 'assistant'}`}>
                    <strong>{roleLabel}{msg.highlighted ? ' ★' : ''}</strong>
                    {msg.content}
                    {msg.highlighted && msg.comment && (
                      <div className="log-comment" style={{ marginTop: 6, fontStyle: 'italic' }}>
                        {`{${msg.comment}}`}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function TherapistGroup({ therapistName, logs }) {
  const [open, setOpen] = useState(true);
  const total = logs.length;
  // Última atividade do terapeuta — informação rápida pro supervisor.
  const lastTs = logs.reduce((acc, l) => {
    const t = new Date(l.timestamp || l.createdAt || 0).getTime();
    return Number.isFinite(t) && t > acc ? t : acc;
  }, 0);

  function downloadAll(e) {
    e.stopPropagation();
    // Baixa cada log do terapeuta como arquivo individual.
    logs.forEach((log) => downloadLogAsText(log));
  }

  return (
    <div className="therapist-group" style={{ marginBottom: 24 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', cursor: 'pointer',
          borderBottom: '1px solid var(--terra)',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>
            {therapistName || 'Terapeuta sem nome'}
          </h3>
          <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.08em' }}>
            {total} {total === 1 ? 'caso' : 'casos'}
            {lastTs ? ` · última atividade ${formatDate(new Date(lastTs).toISOString())}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={downloadAll}
            title="Baixar todos os logs deste terapeuta"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            Baixar todos
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {open ? 'ocultar' : 'expandir'}
          </span>
        </div>
      </div>

      {open && logs.map((log, i) => (
        <LogCard key={log.id || i} log={log} showDownload />
      ))}
    </div>
  );
}

export default function Logs({ user, userId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const isSupervisorView = !userId;

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getLogs(userId)
      .then(setLogs)
      .catch((err) => setError(err.message || 'Erro ao carregar logs'))
      .finally(() => setLoading(false));
  }, [userId]);

  // Agrupamento por terapeuta — só no view de supervisor (admin/professor sem filtro).
  // Dentro de cada grupo, ordena por data desc; entre grupos, ordena por última atividade desc.
  const grouped = useMemo(() => {
    if (!isSupervisorView) return null;
    const byUser = new Map();
    for (const log of logs) {
      const key = log.userId || log.userName || '__sem-id';
      if (!byUser.has(key)) byUser.set(key, { name: log.userName || 'Terapeuta sem nome', logs: [] });
      byUser.get(key).logs.push(log);
    }
    const groups = Array.from(byUser.values()).map((g) => ({
      ...g,
      logs: g.logs.slice().sort((a, b) =>
        new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0)
      ),
    }));
    groups.sort((a, b) => {
      const ta = new Date(a.logs[0]?.timestamp || a.logs[0]?.createdAt || 0).getTime();
      const tb = new Date(b.logs[0]?.timestamp || b.logs[0]?.createdAt || 0).getTime();
      return tb - ta;
    });
    return groups;
  }, [logs, isSupervisorView]);

  const title = isSupervisorView ? 'Logs de Supervisão' : 'Meus Logs';
  const subtitle = isSupervisorView
    ? 'Histórico das sessões dos seus terapeutas, agrupado por nome. Baixe o log individual ou todos de uma vez.'
    : 'Histórico das suas sessões de simulação e avaliações.';

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">{isSupervisorView ? 'Supervisão' : 'Histórico Pessoal'}</div>
        <h2><Typewriter text={title} /></h2>
        <p>{subtitle}</p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando logs…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          {isSupervisorView ? 'Nenhuma sessão registrada na plataforma ainda.' : 'Você ainda não realizou nenhuma sessão.'}
        </div>
      ) : isSupervisorView ? (
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, letterSpacing: '0.05em' }}>
            {grouped.length} {grouped.length === 1 ? 'terapeuta' : 'terapeutas'} · {logs.length} {logs.length === 1 ? 'caso' : 'casos'} no total
          </p>
          {grouped.map((g, i) => (
            <TherapistGroup key={i} therapistName={g.name} logs={g.logs} />
          ))}
        </div>
      ) : (
        <div>
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, letterSpacing: '0.05em' }}>
            {logs.length} {logs.length === 1 ? 'sessão registrada' : 'sessões registradas'}
          </p>
          {logs.slice().reverse().map((log, i) => (
            <LogCard key={log.id || i} log={log} />
          ))}
        </div>
      )}
    </div>
  );
}
