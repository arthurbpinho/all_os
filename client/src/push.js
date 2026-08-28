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

// Caminho inverso: a chave com que a assinatura EXISTENTE foi criada, em
// base64url, pra comparar com a chave atual do servidor. Se o par VAPID for
// trocado, a assinatura antiga continua "válida" para o navegador mas todo
// envio morre com 403 (VapidPkHashMismatch) — que não é 404/410, então o
// servidor nem a descarta. Sem esta comparação, o push fica quebrado para
// sempre naquele dispositivo, e em silêncio.
function chaveDaAssinatura(sub) {
  const raw = sub && sub.options && sub.options.applicationServerKey;
  if (!raw) return null;
  try {
    const bytes = new Uint8Array(raw);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return null;
  }
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

// Assina de fato (a permissão já tem de estar concedida) e registra no
// servidor. Idempotente: reaproveita a assinatura que o navegador já tem, mas
// só se ela foi criada com a chave VAPID ATUAL — senão descarta e assina de
// novo.
async function assinarERegistrar() {
  const { key } = await api.getVapidPublicKey();
  if (!key) return null; // servidor sem VAPID configurado — nada a fazer

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && chaveDaAssinatura(sub) !== key) {
    try { await sub.unsubscribe(); } catch { /* segue e tenta assinar de novo */ }
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }
  // Sempre re-POSTa, mesmo reaproveitando a assinatura: é a única forma de o
  // servidor recuperar um registro que ele perdeu (volume novo, DATA_DIR
  // trocado). O endpoint deduplica por endpoint, então repetir é barato.
  await api.subscribePush(sub.toJSON());
  return sub;
}

// Garante a assinatura de quem JÁ concedeu a permissão — sem prompt, sem
// gesto, sem UI. Chamada no boot do app.
//
// Por que isto existe: permissão concedida e assinatura criada são coisas
// DIFERENTES, e o app tratava as duas como uma. O único caminho que chamava
// `pushManager.subscribe()` era o botão "Ativar" do sino, que só aparecia
// quando `Notification.permission === 'default'`. Ou seja: no instante em que
// a pessoa concedia a permissão, o botão desaparecia — e se a assinatura não
// tivesse sido criada e registrada naquela única passagem (falha de rede, SW
// ainda não pronto, chave VAPID trocada depois, servidor que perdeu o
// arquivo), nada no app tentava de novo. O navegador ficava com a permissão
// ligada, o servidor sem nenhum endpoint, e todo push era descartado em
// silêncio pela guarda `if (!subs.length) return` do servidor.
export async function ensurePushSubscription() {
  if (!isPushSupported()) return null;
  if (getPermission() !== 'granted') return null; // nunca pede permissão daqui
  try {
    return await assinarERegistrar();
  } catch {
    // Best-effort: nenhuma falha aqui pode atrapalhar o boot do app.
    return null;
  }
}

// Pede permissão (se preciso) e assina. Retorna a subscription ou null se o
// usuário recusou / algo falhou. É o caminho do botão "Ativar".
export async function subscribeToPush() {
  if (!isPushSupported()) return null;

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
    // Marca só DEPOIS de o prompt nativo ter aparecido de fato. Antes isto
    // acontecia na primeira linha da função: qualquer falha posterior (ou o
    // próprio sucesso) gravava "já perguntei" e escondia o botão para sempre
    // naquele dispositivo, sem ter assinado nada.
    markAsked();
  }
  if (permission !== 'granted') return null;

  return assinarERegistrar();
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
