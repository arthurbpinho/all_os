import { useState, useEffect } from 'react';
import { api } from '../api';

// Detecta se o app já está rodando em modo standalone (instalado como PWA)
function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent || '';
  // iPad moderno se identifica como Mac; usa também maxTouchPoints como pista
  const iPadOS = /Mac/.test(ua) && (window.navigator.maxTouchPoints || 0) > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOS;
}

function isAndroid() {
  if (typeof window === 'undefined') return false;
  return /Android/i.test(window.navigator.userAgent || '');
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // PWA install
  const [installEvent, setInstallEvent] = useState(null);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [showAndroidInstructions, setShowAndroidInstructions] = useState(false);
  const [installed, setInstalled] = useState(isStandalone());
  const ios = isIOS();
  const android = isAndroid();

  useEffect(() => {
    function onBeforeInstall(e) {
      e.preventDefault();
      setInstallEvent(e);
    }
    function onInstalled() {
      setInstalled(true);
      setInstallEvent(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Credenciais inválidas');
    } finally {
      setLoading(false);
    }
  }

  async function handleVisitor() {
    setError('');
    setLoading(true);
    try {
      const user = await api.loginVisitor();
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Não foi possível iniciar como visitante.');
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall() {
    if (installEvent) {
      // Android / Chrome / Edge — prompt nativo
      installEvent.prompt();
      const choice = await installEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
      }
      setInstallEvent(null);
    } else if (ios) {
      // iOS Safari — não tem API; abrimos instruções
      setShowIOSInstructions(true);
    } else if (android) {
      // Android sem prompt disponível — mostra instruções manuais
      setShowAndroidInstructions(true);
    }
  }

  // Mostra o botão se não está instalado E é mobile (Android ou iOS).
  // Se o prompt nativo (Android Chrome) não disparou ainda, o botão abre instruções.
  const canShowInstall = !installed && (installEvent || ios || android);

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <p className="subtitle">o sistema operacional da prática deliberada</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username">Usuário</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="seu usuário"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="sua senha"
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div className="alert error">{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <div className="login-or">
          <span>ou</span>
        </div>

        <button
          type="button"
          className="btn btn-outline btn-visitor"
          onClick={handleVisitor}
          disabled={loading}
        >
          Entrar como visitante
        </button>

        {canShowInstall && (
          <div className="install-prompt">
            <button type="button" className="btn btn-outline btn-sm" onClick={handleInstall}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 6 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Instalar na tela inicial
            </button>
          </div>
        )}
      </div>

      <a
        className="login-join-link"
        href="https://allos.org.br/processoseletivopsi"
        target="_blank"
        rel="noopener noreferrer"
      >
        Quer sair do modo visitante e ter uma conta real na all<span className="accent">_OS</span>? Participe do processo seletivo!
      </a>

      {showAndroidInstructions && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowAndroidInstructions(false); }}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <h3>Instalar no Android</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 16 }}>
              No Chrome, abra o menu e instale o app:
            </p>
            <ol style={{ paddingLeft: 20, color: 'var(--ink)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
              <li>Toque no menu <strong>⋮</strong> (três pontos no canto superior direito).</li>
              <li>
                Escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.
              </li>
              <li>Confirme — o app abre em tela cheia, sem barra do navegador.</li>
            </ol>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic', marginBottom: 16 }}>
              Se o Chrome ainda não considera o site instalável, navegue um pouco pelo app primeiro e tente de novo em alguns segundos.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowAndroidInstructions(false)}>
                Entendi
              </button>
            </div>
          </div>
        </div>
      )}

      {showIOSInstructions && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowIOSInstructions(false); }}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <h3>Instalar no iPhone / iPad</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 16 }}>
              No Safari, siga três passos para criar o atalho:
            </p>
            <ol style={{ paddingLeft: 20, color: 'var(--ink)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
              <li>
                Toque no botão <strong>Compartilhar</strong>
                <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', margin: '0 4px' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                </span>
                na barra inferior do Safari.
              </li>
              <li>
                Role e toque em <strong>Adicionar à Tela de Início</strong>.
              </li>
              <li>
                Confirme em <strong>Adicionar</strong> — o app abre em tela cheia, sem barra do navegador.
              </li>
            </ol>
            <p style={{ color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic', marginBottom: 16 }}>
              Funciona apenas no Safari. Se estiver no Chrome do iPhone, abra esta página no Safari primeiro.
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => setShowIOSInstructions(false)}>
                Entendi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
