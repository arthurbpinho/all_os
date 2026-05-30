import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
// Importa cedo pra registrar o listener de `beforeinstallprompt` antes do
// Chrome disparar (habilita o botão "Instalar app" na tela inicial).
import './pwa'

// Registra o service worker em produção (HTTPS). Só serve pra habilitar
// o prompt "Instalar app" no Chrome Android — não cacheia nada.
if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
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
