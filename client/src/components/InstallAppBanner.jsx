import { useState, useEffect } from 'react';
import { getInstallPrompt, onInstallChange, promptInstall, isStandalone, isIOS } from '../pwa';

// Banner "Instalar o all_OS no celular" na tela inicial (pós-login). Aparece só
// quando faz sentido: navegador suporta instalar (tem prompt nativo) OU é iOS
// (instalação manual). Some quando já está instalado (standalone), quando o
// usuário dispensa, ou quando a instalação conclui. A dispensa é lembrada em
// localStorage pra não insistir.
const DISMISS_KEY = 'allos_install_dismissed';

export default function InstallAppBanner() {
  const [prompt, setPrompt] = useState(getInstallPrompt());
  const [iosHelp, setIosHelp] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => onInstallChange(setPrompt), []);

  // Rodando como app instalado, ou já dispensado → nada a mostrar.
  if (isStandalone() || dismissed) return null;

  const ios = isIOS();
  // Sem prompt nativo e não é iOS → este navegador não instala; some.
  if (!prompt && !ios) return null;

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
  }

  async function handleInstall() {
    if (ios) {
      setIosHelp((v) => !v); // mostra/esconde instruções do Safari
      return;
    }
    const outcome = await promptInstall();
    if (outcome === 'accepted') dismiss();
  }

  return (
    <div className="install-banner">
      <span className="install-banner-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="2" width="12" height="20" rx="2.5" />
          <path d="M11 18h2" />
        </svg>
      </span>
      <div className="install-banner-text">
        <strong>Instalar o all_OS no celular</strong>
        <span>Acesso rápido pela tela inicial, em tela cheia.</span>
        {ios && iosHelp && (
          <span className="install-banner-ios">
            No Safari, toque em <strong>Compartilhar</strong> e depois em{' '}
            <strong>Adicionar à Tela de Início</strong>.
          </span>
        )}
      </div>
      <button type="button" className="install-banner-btn" onClick={handleInstall}>
        {ios ? 'Como instalar' : 'Instalar'}
      </button>
      <button
        type="button"
        className="install-banner-close"
        onClick={dismiss}
        aria-label="Dispensar"
        title="Dispensar"
      >
        ×
      </button>
    </div>
  );
}
