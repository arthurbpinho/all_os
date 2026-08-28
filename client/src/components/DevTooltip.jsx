import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

// Balão translúcido que explica um item "em desenvolvimento".
//
// Por que portal + position:fixed em vez de um `position:absolute` dentro do
// item: a `.sidebar-nav` tem `overflow-y: auto`, e isso RECORTA também na
// horizontal — um balão absoluto ao lado do menu sumiria pela borda. O portal
// tira o balão do fluxo da barra e a posição é calculada do retângulo do
// gatilho no momento em que ele abre.
//
// Abre no hover e no foco (teclado) e também no TOQUE, porque num item
// desabilitado o toque não tem outro efeito — sem isso, no celular a explicação
// seria inalcançável, que é justamente onde ela mais faz falta.

const LARGURA = 260;

export default function DevTooltip({ text, children, className = '', abrirNoToque = false }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  const abrir = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Preferência: à direita do item. Se não couber (celular, barra larga),
    // vai para baixo, alinhado à esquerda e preso dentro da janela.
    const cabeAoLado = r.right + 12 + LARGURA <= window.innerWidth;
    setPos(cabeAoLado
      ? { top: r.top, left: r.right + 12 }
      : { top: r.bottom + 8, left: Math.max(8, Math.min(r.left, window.innerWidth - LARGURA - 8)) });
  }, []);
  const fechar = useCallback(() => setPos(null), []);

  return (
    <span
      ref={ref}
      className={`dev-trigger ${className}`}
      onMouseEnter={abrir}
      onMouseLeave={fechar}
      onFocus={abrir}
      onBlur={fechar}
      onClick={abrirNoToque ? () => (pos ? fechar() : abrir()) : undefined}
    >
      {children}
      {pos && createPortal(
        <span className="dev-tooltip" style={{ top: pos.top, left: pos.left }} role="tooltip">
          <span className="dev-tooltip-tag">Em desenvolvimento</span>
          {text}
        </span>,
        document.body
      )}
    </span>
  );
}
