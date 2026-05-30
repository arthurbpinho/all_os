// Estado de instalação do PWA (botão "Instalar app" na tela inicial).
//
// O Chrome/Android dispara `beforeinstallprompt` UMA vez, e cedo — muitas vezes
// antes de qualquer componente React montar. Por isso capturamos o evento aqui,
// no nível do módulo (importado já no main.jsx), guardamos o prompt diferido e
// avisamos quem estiver inscrito. Assim o banner funciona mesmo que monte depois.
//
// iOS/Safari não suporta `beforeinstallprompt` nem instalação programática — lá
// o caminho é manual (Compartilhar → Adicionar à Tela de Início), então o banner
// detecta iOS e mostra instruções em vez do botão nativo.

let deferredPrompt = null;
const listeners = new Set();

function emit() {
  for (const cb of listeners) cb(deferredPrompt);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // suprime o mini-infobar automático; usamos nosso botão
    deferredPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

// Prompt nativo disponível agora? (null se ainda não disparou ou já foi usado)
export function getInstallPrompt() {
  return deferredPrompt;
}

// Inscreve um callback para mudanças de disponibilidade. Retorna o unsubscribe.
export function onInstallChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Dispara o diálogo nativo de instalação. Retorna 'accepted' | 'dismissed' | null.
export async function promptInstall() {
  if (!deferredPrompt) return null;
  deferredPrompt.prompt();
  let outcome = null;
  try {
    const choice = await deferredPrompt.userChoice;
    outcome = choice && choice.outcome;
  } catch {
    outcome = null;
  }
  // O prompt diferido só pode ser usado uma vez.
  deferredPrompt = null;
  emit();
  return outcome;
}

// Já está rodando como app instalado (standalone)? Então não há o que instalar.
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

// iOS (iPhone/iPad), onde a instalação é manual via Safari.
export function isIOS() {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent || '';
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS recente se apresenta como Mac com touch — cobre esse caso também.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return (iOSDevice || iPadOS) && !window.MSStream;
}
