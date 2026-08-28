import { useState, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';

// Etiqueta translúcida de UMA linha, que aparece ao passar o mouse (ou focar,
// ou tocar) no que ela embrulha. Na Comunidade é o papel do autor —
// "Administrador", "Aluno da Allos" — no avatar e no nome.
//
// Por que não é o DevTooltip: aquele é um balão de explicação, largura fixa de
// 260px, com um título "EM DESENVOLVIMENTO" e ancorado à direita do item do
// menu. Aqui o conteúdo é um rótulo curto que precisa ficar ACIMA e CENTRADO no
// gatilho, com a largura do próprio texto. Compartilham só o vocabulário
// visual (fundo translúcido + blur), que vive no CSS.
//
// Portal + position:fixed pelo mesmo motivo do DevTooltip: o card da discussão
// e a lista de comentários recortam o conteúdo, e uma etiqueta absoluta lá
// dentro seria cortada na borda de cima.
//
// Abre no TOQUE também: no celular não existe hover, e sem isso o rótulo seria
// inalcançável em metade dos acessos. O toque não navega para nada (não há
// perfil ainda), então não há ação concorrente para atrapalhar.
//
// `focavel` liga o acesso por teclado. Fica DESLIGADO por padrão porque a
// mesma etiqueta costuma embrulhar dois elementos irmãos (o avatar e o nome, a
// mesma informação): dois tab stops para o mesmo rótulo só atrapalham quem
// navega por teclado. Ligue no que carrega o texto. Quando ligado, a etiqueta é
// exposta como `aria-describedby` — descrição do nome, não um botão: ela não
// faz nada além de informar.
export default function HoverTag({ text, children, className = '', focavel = false }) {
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const id = useId();

  const abrir = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Centro do gatilho; o `translateX(-50%)` do CSS faz o resto. Sem espaço em
    // cima (autor no topo da tela), cai para baixo.
    const cabeAcima = r.top >= 44;
    setPos({
      top: cabeAcima ? r.top - 8 : r.bottom + 8,
      left: Math.round(r.left + r.width / 2),
      acima: cabeAcima,
    });
  }, []);
  const fechar = useCallback(() => setPos(null), []);

  if (!text) return children;

  return (
    <span
      ref={ref}
      className={`hover-tag-trigger ${className}`}
      onMouseEnter={abrir}
      onMouseLeave={fechar}
      onFocus={focavel ? abrir : undefined}
      onBlur={focavel ? fechar : undefined}
      onClick={() => (pos ? fechar() : abrir())}
      tabIndex={focavel ? 0 : undefined}
      aria-describedby={pos ? id : undefined}
    >
      {children}
      {pos && createPortal(
        <span
          id={id}
          className={`hover-tag ${pos.acima ? 'acima' : 'abaixo'}`}
          style={{ top: pos.top, left: pos.left }}
          role="tooltip"
        >{text}</span>,
        document.body
      )}
    </span>
  );
}
