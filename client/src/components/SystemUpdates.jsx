import { useState, useEffect, useRef } from 'react';
import { CHANGELOG, LATEST_UPDATE } from '../changelog';

// Painel "Atualizações do sistema" — ícone de bloco de notas com exclamação, à
// esquerda do sino de notificações. Mostra as notas de versão (uma por dia).
// Um ponto de "novidade" aparece até o usuário abrir a atualização mais recente
// (rastreado em localStorage, por dispositivo — conteúdo é público/estático).
const SEEN_KEY = 'allos_updates_seen';

function formatDate(iso) {
  try {
    return new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function SystemUpdates() {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
  });
  const panelRef = useRef(null);

  const hasNew = LATEST_UPDATE && seen !== LATEST_UPDATE;

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next && LATEST_UPDATE) {
        try { localStorage.setItem(SEEN_KEY, LATEST_UPDATE); } catch {}
        setSeen(LATEST_UPDATE);
      }
      return next;
    });
  }

  return (
    <div className="sys-updates" ref={panelRef}>
      <button
        className="sys-updates-btn"
        onClick={toggle}
        aria-label="Atualizações do sistema"
        title="Atualizações do sistema"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="14 3 14 9 20 9" />
          <line x1="11" y1="12.5" x2="11" y2="15.5" />
          <line x1="11" y1="18" x2="11" y2="18" />
        </svg>
        {hasNew && <span className="sys-updates-dot" aria-label="Há novidades" />}
      </button>

      {open && (
        <div className="sys-updates-panel">
          <div className="sys-updates-header">Atualizações do sistema</div>
          <div className="sys-updates-list">
            {CHANGELOG.map((entry) => (
              <div key={entry.date} className="sys-update-item">
                <div className="sys-update-date">{formatDate(entry.date)}</div>
                {entry.title && <div className="sys-update-title">{entry.title}</div>}
                <div className="sys-update-body">{entry.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
