import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { playNotificationChime } from '../sound';

// Sino de notificações no canto superior direito. Faz polling das notificações
// (duelo, conquista desbloqueada, sidequest atribuída/concluída) e abre um painel
// ao clicar. Quando uma notificação NOVA não-lida chega entre dois polls, toca um
// chime suave. Visitante não recebe notificações — o componente nem é renderizado.
const POLL_MS = 20000;

function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Ícone por tipo de notificação.
function iconFor(n) {
  switch (n.type) {
    case 'duel_invite': return '⚔';
    case 'duel_result': return n.outcome === 'win' ? '★' : n.outcome === 'loss' ? '◇' : '=';
    case 'achievement_unlocked': return n.icon || '🏆';
    case 'sidequest_assigned': return '🗺';
    case 'sidequest_completed': return '✦';
    default: return '•';
  }
}

// Corpo (texto) por tipo de notificação.
function bodyFor(n) {
  switch (n.type) {
    case 'duel_invite':
      return (
        <>
          <strong>{n.fromName}</strong> te desafiou para um duelo
          {n.characterName ? <> · atender <em>{n.characterName}</em></> : null}
        </>
      );
    case 'duel_result':
      return (
        <>
          Duelo com <strong>{n.opponentName}</strong> finalizado —{' '}
          {n.outcome === 'win' ? 'você venceu!' : n.outcome === 'loss' ? 'você perdeu' : 'empate'}
          {Number.isFinite(n.yourScore) && Number.isFinite(n.theirScore) && (
            <> ({n.yourScore} × {n.theirScore})</>
          )}
          {Number.isFinite(n.mmrDelta) && (
            <> · MMR {n.mmrDelta >= 0 ? '+' : ''}{n.mmrDelta}</>
          )}
        </>
      );
    case 'achievement_unlocked':
      return (
        <>
          Conquista liberada: <strong>{n.title}</strong> · resgate em Metas
        </>
      );
    case 'sidequest_assigned':
      return (
        <>
          Nova sidequest: <strong>{n.title}</strong>
          {n.assignedByName ? <> · de {n.assignedByName}</> : null}
        </>
      );
    case 'sidequest_completed':
      return (
        <>
          Sidequest concluída: <strong>{n.title}</strong>
          {n.rewardTitleLabel ? <> · título <em>{n.rewardTitleLabel}</em></> : null}
        </>
      );
    default:
      return n.title || 'Notificação';
  }
}

export default function NotificationBell({ user }) {
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const panelRef = useRef(null);
  // IDs vistos no último poll. null = ainda não carregou (1ª vez não toca som,
  // senão tocaria pra cada notificação não-lida pré-existente).
  const seenIds = useRef(null);

  async function load() {
    try {
      const data = await api.getNotifications();
      const list = data.items || [];
      setItems(list);
      setUnread(data.unread || 0);
      // Toca o chime se surgiu alguma notificação não-lida que não existia no
      // poll anterior. Na primeira carga só registra a baseline (sem som).
      if (seenIds.current === null) {
        seenIds.current = new Set(list.map((n) => n.id));
      } else {
        const hasNew = list.some((n) => !n.read && !seenIds.current.has(n.id));
        seenIds.current = new Set(list.map((n) => n.id));
        if (hasNew) playNotificationChime();
      }
    } catch {
      // silêncio — sino é best-effort
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [user?.id]);

  // Fecha o painel ao clicar fora.
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function handleClick(n) {
    setOpen(false);
    try { await api.markNotificationRead(n.id); } catch {}
    load();
    if (n.type === 'duel_invite') {
      navigate(`/duelo/aceitar/${n.duelId}`);
    } else if (n.type === 'duel_result') {
      navigate(`/duelo/sessao/${n.duelId}`);
    } else if (n.type === 'achievement_unlocked' || n.type === 'sidequest_completed') {
      navigate('/missoes');
    } else if (n.type === 'sidequest_assigned') {
      navigate('/freeplay');
    }
  }

  async function markAll() {
    try { await api.markAllNotificationsRead(); } catch {}
    load();
  }

  return (
    <div className="notif-bell" ref={panelRef}>
      <button
        className="notif-bell-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notificações"
        title="Notificações"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel-header">
            <span>Notificações</span>
            {unread > 0 && (
              <button className="notif-markall" onClick={markAll}>marcar todas lidas</button>
            )}
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <div className="notif-empty">Nenhuma notificação ainda.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  className={`notif-item ${n.read ? '' : 'unread'}`}
                  onClick={() => handleClick(n)}
                >
                  <span className="notif-item-icon">{iconFor(n)}</span>
                  <span className="notif-item-body">
                    {bodyFor(n)}
                    <span className="notif-item-time">{timeAgo(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
