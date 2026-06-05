import { useState, useEffect } from 'react';

// Alternador claro/escuro do topo. O tema é aplicado em <html data-theme="dark">
// e o CSS faz todo o resto (bloco [data-theme="dark"] em index.css).
// O index.html já aplica o tema salvo ANTES do paint (evita flash claro), então
// aqui só espelhamos o estado atual e tratamos o clique.

const THEME_KEY = 'allos_theme';
const META_DARK = '#15181b';   // = --cream do modo escuro
const META_LIGHT = '#14564E';  // = theme-color original (marrs-deep)

function getInitialTheme() {
  const applied = document.documentElement.getAttribute('data-theme');
  if (applied === 'dark') return 'dark';
  try {
    if (localStorage.getItem(THEME_KEY) === 'dark') return 'dark';
  } catch { /* localStorage indisponível */ }
  return 'light';
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  // Acompanha a cor da barra do navegador (mobile/PWA).
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? META_DARK : META_LIGHT);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  const isDark = theme === 'dark';

  function toggle() {
    const next = isDark ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  }

  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={toggle}
      title={isDark ? 'Mudar para modo claro' : 'Mudar para modo escuro'}
      aria-label={isDark ? 'Ativar modo claro' : 'Ativar modo escuro'}
      aria-pressed={isDark}
    >
      {isDark ? (
        // Está escuro → ícone de sol (clicar volta ao claro)
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        // Está claro → ícone de lua (clicar vai ao escuro)
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
