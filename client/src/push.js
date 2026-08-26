// Web Push — assina o navegador (celular ou PC) pra receber notificação do
// sistema operacional, com som, mesmo com o app fechado/em background. Reusa
// o MESMO sistema de notificação in-app do sino (server/index.js,
// pushNotification/upsertEvaluationNotification): não existe uma trilha de
// push separada, é o mesmo evento disparando os dois canais.
//
// Fluxo: pede permissão do navegador → assina no Push Manager do SW com a
// chave pública VAPID do servidor → manda a assinatura pro servidor guardar
// (POST /api/push/subscribe). O servidor só sabe endpoint+chaves; quem decide
// SE e QUANDO notificar continua sendo o server, como já era pro sino.

import { api } from './api';

const PERMISSION_ASKED_KEY = 'allos_push_asked';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// Suporte real: precisa de SW + Push API + Notification API. iOS só suporta
// a partir de quando instalado como PWA (standalone) — fora disso, nem
// oferecemos o botão (ficaria pedindo permissão pra algo que sempre falha).
export function isPushSupported() {
  if (typeof window === 'undefined') return false;
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!hasApis) return false;
  const ua = window.navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function getPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

// Já perguntou antes nesse dispositivo? Evita reoferecer o botão toda hora
// pra quem já disse não uma vez (o navegador nem reabriria o prompt nativo
// depois de 'denied', mas isso governa o NOSSO botão/banner).
export function alreadyAsked() {
  try { return localStorage.getItem(PERMISSION_ASKED_KEY) === '1'; } catch { return false; }
}
function markAsked() {
  try { localStorage.setItem(PERMISSION_ASKED_KEY, '1'); } catch {}
}

// Assinatura ATUAL deste navegador, se houver (sem pedir permissão).
export async function getExistingSubscription() {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// Pede permissão (se preciso) e assina. Retorna a subscription ou null se o
// usuário recusou / algo falhou. Idempotente: se já existe assinatura válida
// pra este navegador, só garante que o servidor tem o registro (re-POST barato).
export async function subscribeToPush() {
  if (!isPushSupported()) return null;
  markAsked();

  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const { key } = await api.getVapidPublicKey();
  if (!key) return null; // servidor sem VAPID configurado — nada a fazer

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  await api.subscribePush(sub.toJSON());
  return sub;
}

// Cancela a assinatura deste navegador (local + servidor). Usado num toggle
// "desativar notificações push" — não existe ainda na UI, fica pronta pra quando.
export async function unsubscribeFromPush() {
  const sub = await getExistingSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try { await sub.unsubscribe(); } catch {}
  try { await api.unsubscribePush(endpoint); } catch {}
}
