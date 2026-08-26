// Service worker — passthrough sem cache, + Web Push.
//
// Não cacheia nada porque o app depende de chamadas dinâmicas (auth, IA,
// logs, etc.) e cache off-line introduziria mais complexidade do que valor.
// O fetch handler vazio existe só pra satisfazer o requisito de "site
// instalável" do Chrome (precisa de um SW com fetch pra disparar
// beforeinstallprompt) — não filtra nem intercepta nada.

self.addEventListener('install', (event) => {
  // Ativa imediatamente sem esperar fechar abas antigas.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Passthrough: deixa o navegador fazer a request normalmente.
  // O handler precisa existir, mas pode ser vazio.
});

// Push chega aqui mesmo com o app fechado/em background — é o servidor
// (server/index.js, sendWebPushToUser) que decide título/corpo/tag; o SW só
// exibe. `tag` agrupa notificações da mesma origem (ex.: mesma avaliação: "na
// fila" → "pronta" substitui em vez de empilhar) e `renotify: true` faz o SO
// alertar (som/vibração) de novo mesmo substituindo uma notificação existente
// — sem isso, um update silencioso não tocaria som. `silent` fica de fora de
// propósito: o padrão do SO já toca som, que é o pedido ("push com som").
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'all_OS · Allos';
  const options = {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.renotify,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clique na notificação do SO: foca uma aba já aberta no app (navegando pra
// URL certa) ou abre uma nova. Mesma lógica de destino que o sino in-app usa
// (ver notificationUrl no servidor e handleClick em NotificationBell.jsx).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientsList) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) { try { await c.navigate(url); } catch {} }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
