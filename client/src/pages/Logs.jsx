import { useState, useEffect } from 'react';
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

function LogCard({ log }) {
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
                    <strong>{roleLabel}</strong>
                    {msg.content}
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

  const title = isSupervisorView ? 'Logs de Supervisão' : 'Meus Logs';
  const subtitle = isSupervisorView
    ? 'Histórico de todas as sessões de simulação realizadas na plataforma.'
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
