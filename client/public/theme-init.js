// Aplica o modo escuro salvo ANTES do primeiro paint, pra tela não piscar clara.
//
// Precisa ser um arquivo externo (e não um <script> inline no index.html) por
// causa do CSP: a política do servidor é `script-src 'self'`, sem
// 'unsafe-inline'. Manter isso como arquivo é o que permite o CSP ser estrito.
// Carregado de forma síncrona no <head> — sem defer/async — pra rodar antes do
// render.
(function () {
  try {
    if (localStorage.getItem('allos_theme') === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) { /* localStorage indisponível */ }
})();
