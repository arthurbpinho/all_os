import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { playNotificationChime } from '../sound';
import {
  isPushSupported, getPermission, alreadyAsked, subscribeToPush,
  ensurePushSubscription, getExistingSubscription,
} from '../push';

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
    case 'admin_notice': return '📢';
    case 'evaluation_queued': return '⏳';
    case 'evaluation_ready': return '📋';
    case 'comunidade_reply': return '💬';
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
          Novo exercício: <strong>{n.title}</strong>
          {n.assignedByName ? <> · de {n.assignedByName}</> : null}
        </>
      );
    case 'sidequest_completed':
      return (
        <>
          Exercício concluído: <strong>{n.title}</strong>
          {n.rewardTitleLabel ? <> · título <em>{n.rewardTitleLabel}</em></> : null}
        </>
      );
    case 'admin_notice':
      return (
        <>
          {n.title && n.title !== 'Aviso' ? <strong>{n.title}</strong> : <strong>Aviso</strong>}
          {' · '}{n.message}
        </>
      );
    case 'evaluation_queued':
    case 'evaluation_ready':
      return n.message;
    case 'comunidade_reply':
      return (
        <>
          <strong>{n.fromName}</strong> comentou em “{n.title}”.
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
  // Oferece "ativar notificações push" quando o navegador suporta e ESTE
  // dispositivo ainda não tem assinatura ativa. A condição olha a assinatura,
  // não só a permissão: antes ela era `permission === 'default'`, o que fazia o
  // botão desaparecer no instante em que a permissão era concedida — inclusive
  // quando a assinatura não tinha sido criada, que é justamente o estado
  // quebrado em que o push nunca chega.
  //   'denied'  → fica quieto (o navegador não reabre o prompt nativo).
  //   'granted' → só aparece se faltar assinatura (e aí o reconcile abaixo já
  //               costuma resolver antes, sem o botão).
  //   'default' → aparece uma vez, governado por alreadyAsked().
  const [pushOffer, setPushOffer] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  // Assinado neste aparelho? Governa o botão de push de teste (só admin).
  const [pushAssinado, setPushAssinado] = useState(false);
  const [pushTeste, setPushTeste] = useState('');

  useEffect(() => {
    let cancelado = false;
    (async () => {
      if (!isPushSupported()) return;
      // Reconcilia primeiro: quem já concedeu a permissão fica assinado aqui,
      // sem prompt e sem UI. É o que conserta o dispositivo cuja assinatura
      // nunca chegou ao servidor (ou chegou e foi perdida).
      if (getPermission() === 'granted') await ensurePushSubscription();
      if (cancelado) return;

      const permissao = getPermission();
      if (permissao === 'denied') return;
      const assinado = !!(await getExistingSubscription());
      if (cancelado) return;
      setPushAssinado(assinado);
      setPushOffer(!assinado && (permissao === 'granted' || !alreadyAsked()));
    })();
    return () => { cancelado = true; };
  }, []);

  async function handleEnablePush() {
    setPushBusy(true);
    try {
      const sub = await subscribeToPush();
      // Some com a oferta só se assinou de verdade. Falhou? O botão fica, que é
      // a única pista visível de que ainda não está ativo.
      if (sub) { setPushOffer(false); setPushAssinado(true); }
    } catch {
      // best-effort — permissão negada ou falha de rede não deve travar o sino
    } finally {
      setPushBusy(false);
    }
  }

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
      navigate('/progressao');
    } else if (n.type === 'evaluation_ready') {
      navigate('/logs');
    } else if (n.type === 'comunidade_reply') {
      navigate(`/comunidade/discussao/${n.discussionId}`);
    }
  }

  // Push de teste: o servidor envia de verdade e responde o que aconteceu. É a
  // única forma de saber que o push está de pé sem esperar um evento real —
  // que é como este recurso ficou meses quebrado sem ninguém notar.
  async function testarPush() {
    setPushTeste('enviando…');
    try {
      const r = await api.testPush();
      setPushTeste(r.failed
        ? `falhou em ${r.failed} de ${r.devices} aparelho(s) — código ${r.failureStatuses.join(', ')}`
        : `enviado para ${r.sent} aparelho(s)`);
    } catch (e) {
      setPushTeste(e.message || 'não foi possível enviar');
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
          {pushOffer && (
            <div className="notif-push-offer">
              <span>🔔 Ativar notificações push neste dispositivo?</span>
              <button className="notif-markall" onClick={handleEnablePush} disabled={pushBusy}>
                {pushBusy ? 'Ativando…' : 'Ativar'}
              </button>
            </div>
          )}
          {user?.role === 'admin' && pushAssinado && (
            <div className="notif-push-offer">
              <span>{pushTeste ? `Push: ${pushTeste}` : 'Push ativo neste aparelho.'}</span>
              <button className="notif-markall" onClick={testarPush}>testar</button>
            </div>
          )}
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
