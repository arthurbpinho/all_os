import { useState } from 'react';
import { copyText, downloadText } from '../logFiles';

// Botões de COPIAR e BAIXAR para um log de sessão e/ou sua avaliação.
// `items` vem de makeLogItems(): cada item é { key, label, build, filename },
// onde build() devolve o texto (preguiçoso — só roda no clique). Quando há
// avaliação, aparecem três grupos: Log / Avaliação / Tudo; sem avaliação, só Log.
//
// `inline` deixa os grupos em linha (pra cabeçalhos); o padrão empilha um grupo
// por linha (pra telas de pós-sessão e visor de logs). `size` = classe btn-*.
const IconCopy = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 5, verticalAlign: '-2px' }}>
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ marginRight: 5, verticalAlign: '-2px' }}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const IconDownload = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 5, verticalAlign: '-2px' }}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export default function LogActions({ items, inline = false, size = 'sm', showLabels = true }) {
  const [copiedKey, setCopiedKey] = useState(null);
  if (!items || items.length === 0) return null;
  const btnCls = `btn btn-outline btn-${size}`;

  async function handleCopy(key, build) {
    try {
      await copyText(build());
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      // silêncio — copiar é best-effort (pode falhar sem HTTPS)
    }
  }

  return (
    <div className={`log-actions ${inline ? 'inline' : ''}`}>
      {items.map((it) => (
        <div className="log-actions-group" key={it.key}>
          {showLabels && items.length > 1 && <span className="log-actions-label">{it.label}</span>}
          <button
            type="button"
            className={btnCls}
            title={`Copiar ${it.label.toLowerCase()}`}
            onClick={(e) => { e.stopPropagation(); handleCopy(it.key, it.build); }}
          >
            {copiedKey === it.key ? <><IconCheck />Copiado</> : <><IconCopy />Copiar{items.length === 1 ? ` ${it.label.toLowerCase()}` : ''}</>}
          </button>
          <button
            type="button"
            className={btnCls}
            title={`Baixar ${it.label.toLowerCase()} (.txt)`}
            onClick={(e) => { e.stopPropagation(); downloadText(it.filename, it.build()); }}
          >
            <IconDownload />Baixar{items.length === 1 ? ` ${it.label.toLowerCase()}` : ''}
          </button>
        </div>
      ))}
    </div>
  );
}
