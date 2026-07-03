import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import ScoreBadge from '../components/ScoreBadge';
import LogActions from '../components/LogActions';
import CriteriaTable, { V15_CRITERIA, NEURO_CRITERIA } from '../components/CriteriaTable';
import { makeLogItems, downloadText } from '../logFiles';
import LogsSociais from './LogsSociais';

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

const LOG_TTL_DAYS_FALLBACK = 30;

// Data de expiração do log: usa expiresAt vindo do servidor; se ausente
// (logs antigos), deriva do timestamp + 30 dias.
function logExpiresAt(log) {
  if (log.expiresAt) return new Date(log.expiresAt);
  const base = new Date(log.timestamp || log.createdAt || 0);
  if (isNaN(base)) return null;
  return new Date(base.getTime() + LOG_TTL_DAYS_FALLBACK * 86400000);
}

function daysUntilExpiry(log) {
  const exp = logExpiresAt(log);
  if (!exp) return null;
  return Math.ceil((exp.getTime() - Date.now()) / 86400000);
}

function ExpiryNote({ log, style }) {
  const exp = logExpiresAt(log);
  if (!exp) return null;
  const days = daysUntilExpiry(log);
  const soon = days != null && days <= 7;
  return (
    <span
      title="Após esta data o log é removido automaticamente"
      style={{ fontSize: 12, color: soon ? 'var(--terra)' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, ...style }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 2" /></svg>
      expira {exp.toLocaleDateString('pt-BR')}{soon && days >= 0 ? ` · ${days}d` : ''}
    </span>
  );
}

// Monta os textos de um log salvo: logStr (só transcrição), evalStr (avaliação +
// notas por critério, quando houver) e bothStr (tudo). hasEval indica se há
// avaliação/critérios pra oferecer os botões de "Avaliação"/"Tudo".
//
// Header MINIMAL por decisão de produto: log limpo só com Terapeuta + Caso.
// A nota numérica vive APENAS na seção de avaliação (prefixo "Nota final: X"),
// nunca no header — o log cru fica sem score quando exportado isolado.
function buildLogStrings(log) {
  const messages = Array.isArray(log.messages) ? log.messages : [];
  const header = [
    `Terapeuta: ${log.userName || '—'}`,
    `Caso: ${log.itemTitle || log.title || '—'}`,
  ].join('\n');

  const transcript = messages
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
    })
    .join('\n\n---\n\n');

  // Avaliação prefixada pela nota geral — único lugar onde o score aparece.
  // Sem evaluation, não criamos seção mesmo que haja score (mantém o
  // comportamento original de hasEval = !!evalPart || !!criteriaPart).
  const scoreLine = log.score != null ? `Nota final: ${log.score}\n\n` : '';
  const evalPart = log.evaluation
    ? `\n\n===========================\nAVALIAÇÃO DA IA\n===========================\n\n${scoreLine}${log.evaluation}`
    : '';

  // Notas por critério (só nos downloads de supervisor/admin — o aluno nem
  // recebe criteriaScores do servidor).
  let criteriaPart = '';
  if (log.criteriaScores && typeof log.criteriaScores === 'object') {
    const critLabels = log.type === 'neuro' ? NEURO_CRITERIA : V15_CRITERIA;
    const rows = Object.entries(log.criteriaScores)
      .filter(([, v]) => Number.isFinite(Number(v)))
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${critLabels[k] || `Critério ${k}`}: ${Number(v)}/10`);
    if (rows.length) {
      criteriaPart = `\n\n===========================\nNOTAS POR CRITÉRIO (supervisor)\n===========================\n\n${rows.join('\n')}`;
    }
  }

  return {
    logStr: `${header}\n\n---\n\n${transcript}`,
    evalStr: `${header}${evalPart}${criteriaPart}`,
    bothStr: `${header}\n\n---\n\n${transcript}${evalPart}${criteriaPart}`,
    hasEval: !!evalPart || !!criteriaPart,
  };
}

// Itens (copiar/baixar log / avaliação / tudo) pro <LogActions> de um log salvo.
function logItemsFor(log) {
  const base = `${sanitizeFilename(log.userName)}-${sanitizeFilename(log.itemTitle)}`;
  const hasEval = !!(log.evaluation || (log.criteriaScores && Object.keys(log.criteriaScores).length));
  return makeLogItems({
    baseName: base,
    getLog: () => buildLogStrings(log).logStr,
    getEval: hasEval ? () => buildLogStrings(log).evalStr : null,
    getBoth: hasEval ? () => buildLogStrings(log).bothStr : null,
  });
}

function downloadLogAsText(log) {
  const stamp = (log.timestamp || log.createdAt || new Date().toISOString()).slice(0, 10);
  downloadText(`log-${sanitizeFilename(log.userName)}-${sanitizeFilename(log.itemTitle)}-${stamp}.txt`, buildLogStrings(log).bothStr);
}

// Resumo (Neuroavaliação) da bateria de testes que o aluno escolheu, recomputado
// server-side vs. o gabarito. Mostrado no log para o supervisor/admin/aluno.
function NeuroTestsLogSummary({ data }) {
  if (!data) return null;
  const abbrs = (list) => (list || []).map((t) => t.abbr).join(', ') || '—';
  const just = data.justifications || {};
  const justEntries = (data.selected || []).filter((t) => (just[t.id] || '').trim());
  return (
    <div className="neuro-log-summary">
      <div className="neuro-log-summary-head">
        🧪 Bateria de testes indicada pelo aluno · nota dos testes <strong>{typeof data.accuracy === 'number' ? `${data.accuracy}%` : 'N/A'}</strong>
      </div>
      <div className="neuro-log-summary-row"><span>Indicados:</span> {abbrs(data.selected)}</div>
      <div className="neuro-log-summary-row"><span>Recomendados:</span> {abbrs(data.recommended)}</div>
      {data.missing && data.missing.length > 0 && (
        <div className="neuro-log-summary-row miss"><span>Não aplicados:</span> {abbrs(data.missing)}</div>
      )}
      {data.extra && data.extra.length > 0 && (
        <div className="neuro-log-summary-row extra"><span>Extras:</span> {abbrs(data.extra)}</div>
      )}
      {justEntries.length > 0 && (
        <div className="neuro-log-summary-results">
          <div className="neuro-log-summary-results-title">Justificativas do aluno</div>
          <ul>
            {justEntries.map((t) => (
              <li key={t.id}><strong>{t.abbr}</strong>: {just[t.id].trim()}</li>
            ))}
          </ul>
        </div>
      )}
      {data.results && data.results.length > 0 && (
        <div className="neuro-log-summary-results">
          <div className="neuro-log-summary-results-title">Resultados do paciente</div>
          <ul>
            {data.results.map((r) => (
              <li key={r.id}><strong>{r.abbr}</strong>: {r.result}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LogCard({ log, showDownload }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState('log');
  const messages = Array.isArray(log.messages) ? log.messages : [];
  const evaluation = (log.evaluation || '').trim();

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
        <ExpiryNote log={log} />
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
          {/* Toggle Log / Avaliação — supervisor e admin precisam ver a avaliação
              da IA de cada sessão, não só a transcrição. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ color: 'var(--muted)', fontSize: 12, marginRight: 2 }}>Visualizar</span>
            <button
              type="button"
              className={`btn ${tab === 'log' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTab('log')}
              style={{ padding: '4px 12px', fontSize: 12.5 }}
            >
              Log da sessão
            </button>
            <button
              type="button"
              className={`btn ${tab === 'evaluation' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTab('evaluation')}
              disabled={!evaluation}
              title={evaluation ? 'Ver a avaliação da IA desta sessão' : 'Esta sessão não tem avaliação registrada'}
              style={{ padding: '4px 12px', fontSize: 12.5 }}
            >
              Avaliação {evaluation ? '' : '(sem registro)'}
            </button>
          </div>

          {showDownload && (
            <div style={{ marginBottom: 14 }}>
              <LogActions items={logItemsFor(log)} inline />
            </div>
          )}

          {tab === 'log' && log.neuroTests && <NeuroTestsLogSummary data={log.neuroTests} />}

          {tab === 'evaluation' ? (
            evaluation || log.criteriaScores ? (
              <div>
                <CriteriaTable criteriaScores={log.criteriaScores} labels={log.type === 'neuro' ? NEURO_CRITERIA : V15_CRITERIA} />
                {evaluation && (
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
                    {evaluation}
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: 'var(--muted)', fontSize: 14, fontStyle: 'italic' }}>
                Esta sessão não tem avaliação registrada.
              </p>
            )
          ) : messages.length === 0 ? (
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
            title="Baixar todos os logs deste terapeuta (cada arquivo inclui transcrição + avaliação)"
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

// Visão do aluno: navegação em 3 níveis — Pacientes → Datas → Log/Avaliação.
// Antes era lista flat de cards onde a avaliação ficava invisível (LogCard
// dependia de evaluationStartIdx, que o novo fluxo de salvamento não popula).
function StudentSessionsView({ logs }) {
  const [selectedPatientKey, setSelectedPatientKey] = useState(null);
  const [selectedLogId, setSelectedLogId] = useState(null);
  const [tab, setTab] = useState('log');

  // Agrupa logs por paciente (itemId é a chave estável; itemTitle é o nome).
  const patients = useMemo(() => {
    const map = new Map();
    for (const log of logs) {
      const key = log.itemId || log.itemTitle || '__sem-paciente';
      if (!map.has(key)) {
        map.set(key, { key, name: log.itemTitle || 'Sem nome', type: log.type, logs: [] });
      }
      map.get(key).logs.push(log);
    }
    const arr = Array.from(map.values()).map((p) => {
      const sortedLogs = p.logs.slice().sort(
        (a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0)
      );
      const lastTs = new Date(sortedLogs[0]?.timestamp || sortedLogs[0]?.createdAt || 0).getTime();
      return { ...p, logs: sortedLogs, lastTs };
    });
    arr.sort((a, b) => b.lastTs - a.lastTs);
    return arr;
  }, [logs]);

  const selectedPatient = patients.find((p) => p.key === selectedPatientKey) || null;
  const selectedLog = selectedPatient?.logs.find((l) => l.id === selectedLogId) || null;

  // Nível 3: log ou avaliação
  if (selectedLog) {
    return (
      <SessionDetail
        patient={selectedPatient}
        log={selectedLog}
        tab={tab}
        onTab={setTab}
        onBack={() => { setSelectedLogId(null); setTab('log'); }}
      />
    );
  }

  // Nível 2: datas do paciente
  if (selectedPatient) {
    return (
      <PatientSessionList
        patient={selectedPatient}
        onSelect={(logId) => { setSelectedLogId(logId); setTab('log'); }}
        onBack={() => setSelectedPatientKey(null)}
      />
    );
  }

  // Nível 1: lista de pacientes
  if (patients.length === 0) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
        Você ainda não atendeu nenhum paciente.
      </div>
    );
  }

  return (
    <div>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, letterSpacing: '0.05em' }}>
        {patients.length} {patients.length === 1 ? 'paciente atendido' : 'pacientes atendidos'}
      </p>
      <div className="card-grid">
        {patients.map((p) => {
          const sessoes = p.logs.length;
          return (
            <div
              key={p.key}
              className="character-card"
              onClick={() => setSelectedPatientKey(p.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedPatientKey(p.key); }}
              style={{ cursor: 'pointer' }}
            >
              <div className="character-card-header">
                <h3>{p.name}</h3>
                <span className="tag">{TYPE_LABELS[p.type] || p.type || '—'}</span>
              </div>
              <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 6 }}>
                {sessoes} {sessoes === 1 ? 'sessão' : 'sessões'}
                {p.lastTs ? ` · última em ${formatDate(new Date(p.lastTs).toISOString())}` : ''}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BackButton({ children, onClick }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={onClick}
      style={{ marginBottom: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {children}
    </button>
  );
}

function PatientSessionList({ patient, onSelect, onBack }) {
  return (
    <div>
      <BackButton onClick={onBack}>Voltar para pacientes</BackButton>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>
          {TYPE_LABELS[patient.type] || patient.type || 'Sessão'}
        </div>
        <h3 style={{ margin: 0, fontSize: 22 }}>{patient.name}</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: 6 }}>
          {patient.logs.length} {patient.logs.length === 1 ? 'sessão registrada' : 'sessões registradas'}. Escolha uma data para ver o log ou a avaliação.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {patient.logs.map((log) => {
          const dur = log.durationSeconds || 0;
          const mins = Math.floor(dur / 60).toString().padStart(2, '0');
          const secs = (dur % 60).toString().padStart(2, '0');
          return (
            <div
              key={log.id}
              className="card tight"
              onClick={() => onSelect(log.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(log.id); }}
              style={{
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '14px 18px',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {formatDate(log.timestamp || log.createdAt)}
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>
                    {dur > 0 ? `Duração ${mins}:${secs}` : 'sem duração registrada'}
                    {' · '}
                    {(log.messages || []).filter((m) => !m.isSystem).length} mensagens
                  </span>
                  <ExpiryNote log={log} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <ScoreBadge score={log.score} />
                <span style={{ fontSize: 12, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  abrir →
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionDetail({ patient, log, tab, onTab, onBack }) {
  const messages = Array.isArray(log.messages) ? log.messages.filter((m) => !m.isSystem) : [];
  const evaluation = (log.evaluation || '').trim();

  return (
    <div>
      <BackButton onClick={onBack}>Voltar para sessões de {patient?.name || 'paciente'}</BackButton>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>
          {patient?.name || log.itemTitle}
        </div>
        <h3 style={{ margin: 0, fontSize: 22 }}>
          Sessão de {formatDate(log.timestamp || log.createdAt)}
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, color: 'var(--muted)', fontSize: 13 }}>
          <span>{TYPE_LABELS[log.type] || log.type}</span>
          <ScoreBadge score={log.score} />
          <ExpiryNote log={log} />
        </div>
        <div style={{ marginTop: 12 }}>
          <LogActions items={logItemsFor(log)} inline />
        </div>
      </div>

      <div className="card tight" style={{ marginBottom: 16, padding: '10px 14px' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)', fontSize: 13, marginRight: 4 }}>Visualizar</span>
          <button
            type="button"
            className={`btn ${tab === 'log' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onTab('log')}
            style={{ padding: '6px 14px', fontSize: 13 }}
          >
            Log da sessão
          </button>
          <button
            type="button"
            className={`btn ${tab === 'evaluation' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => onTab('evaluation')}
            style={{ padding: '6px 14px', fontSize: 13 }}
            disabled={!evaluation}
            title={evaluation ? 'Ver a avaliação da IA desta sessão' : 'Esta sessão não tem avaliação registrada'}
          >
            Avaliação {evaluation ? '' : '(sem registro)'}
          </button>
        </div>
      </div>

      {tab === 'log' && (
        <div className="card tight">
          {messages.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 14, fontStyle: 'italic' }}>
              Nenhuma mensagem registrada nesta sessão.
            </p>
          ) : (
            messages.map((msg, i) => {
              const isUser = msg.role === 'user';
              return (
                <div key={i} className={`msg ${isUser ? 'user' : 'assistant'}`}>
                  <strong>{isUser ? 'Terapeuta' : 'Paciente'}{msg.highlighted ? ' ★' : ''}</strong>
                  {msg.content}
                  {msg.highlighted && msg.comment && (
                    <div className="log-comment" style={{ marginTop: 6, fontStyle: 'italic' }}>
                      {`{${msg.comment}}`}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'evaluation' && (
        <div className="card tight">
          {evaluation || log.criteriaScores ? (
            <div>
              <CriteriaTable criteriaScores={log.criteriaScores} labels={log.type === 'neuro' ? NEURO_CRITERIA : V15_CRITERIA} />
              {evaluation && (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6 }}>
                  {evaluation}
                </div>
              )}
            </div>
          ) : (
            <p style={{ color: 'var(--muted)', fontSize: 14, fontStyle: 'italic' }}>
              Esta sessão não tem avaliação registrada.
            </p>
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
  const [ttlDays, setTtlDays] = useState(LOG_TTL_DAYS_FALLBACK);
  // Aba dentro de "Minhas Sessões": sessões (Trilha/Simulação/Neuro) ou duelos.
  // "Logs de Duelo" deixou de ser item de menu próprio e virou esta aba.
  const [view, setView] = useState('sessions');

  const isSupervisorView = !userId;

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getLogs(userId)
      .then(setLogs)
      .catch((err) => setError(err.message || 'Erro ao carregar logs'))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    api.getLogsPolicy()
      .then((p) => { if (p && p.ttlDays) setTtlDays(p.ttlDays); })
      .catch(() => {});
  }, []);

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

  const title = isSupervisorView ? 'Logs de Supervisão' : 'Minhas Sessões';
  const subtitle = isSupervisorView
    ? 'Histórico das sessões dos seus terapeutas, agrupado por nome. Baixe o log individual ou todos de uma vez.'
    : 'Pacientes que você atendeu. Clique em um para ver as datas e abrir o log ou a avaliação de cada sessão.';

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">{isSupervisorView ? 'Supervisão' : 'Histórico Pessoal'}</div>
        <h2><Typewriter text={title} /></h2>
        <p>{subtitle}</p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}</div>}

      {/* Aba Sessões / Duelos — só na visão do aluno ("Minhas Sessões"). */}
      {!isSupervisorView && (
        <div className="logs-tabs">
          <button
            type="button"
            className={`btn ${view === 'sessions' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setView('sessions')}
          >
            Minhas sessões
          </button>
          <button
            type="button"
            className={`btn ${view === 'duels' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setView('duels')}
          >
            Duelos
          </button>
        </div>
      )}

      {(isSupervisorView || view === 'sessions') && (
        <div className="log-expiry-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Os logs expiram automaticamente após <strong>{ttlDays} dias</strong> e são removidos para manter o desempenho da plataforma.
            A data de expiração aparece em cada sessão — <strong>baixe os logs que quiser guardar</strong> antes disso.
          </span>
        </div>
      )}

      {!isSupervisorView && view === 'duels' ? (
        <LogsSociais user={user} embedded />
      ) : loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando sessões…</span>
        </div>
      ) : isSupervisorView ? (
        logs.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
            Nenhuma sessão registrada na plataforma ainda.
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16, letterSpacing: '0.05em' }}>
              {grouped.length} {grouped.length === 1 ? 'terapeuta' : 'terapeutas'} · {logs.length} {logs.length === 1 ? 'caso' : 'casos'} no total
            </p>
            {grouped.map((g, i) => (
              <TherapistGroup key={i} therapistName={g.name} logs={g.logs} />
            ))}
          </div>
        )
      ) : (
        <StudentSessionsView logs={logs} />
      )}
    </div>
  );
}
