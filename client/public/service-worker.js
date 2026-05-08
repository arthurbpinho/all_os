// Service worker mínimo — passthrough sem cache.
// Existe apenas para satisfazer o requisito de "site instalável" do Chrome
// (que precisa de um SW com fetch handler para disparar beforeinstallprompt).
//
// Não cacheia nada porque o app depende de chamadas dinâmicas (auth, IA,
// logs, etc.) e cache off-line introduziria mais complexidade do que valor.

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
