import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
// Importa cedo pra registrar o listener de `beforeinstallprompt` antes do
// Chrome disparar (habilita o botão "Instalar app" na tela inicial).
import './pwa'

// Registra o service worker em HTTPS ou localhost — os dois são "contexto
// seguro" pro navegador (é a mesma regra que o Chrome usa pra liberar SW em
// dev sem certificado). Sem isso, testar localmente ("npm run dev") nunca
// registra o SW e a assinatura de Web Push trava esperando um controller que
// nunca chega (navigator.serviceWorker.ready não resolve).
const swSecureContext = window.location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
if ('serviceWorker' in navigator && swSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.warn('[sw] Falha ao registrar service worker:', err);
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)
