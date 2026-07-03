import { useRef, useState, useEffect, useCallback } from 'react';

// Recortador de foto do paciente — roda 100% no navegador (canvas), porque o
// servidor não tem lib de imagem (sharp/imagemagick). O admin escolhe a foto,
// arrasta pra enquadrar o rosto e ajusta o zoom; ao aplicar, exporta:
//   - ícone quadrado 512×512 (recorte enquadrado) → seletor e avatar do chat
//   - "full" (imagem inteira, lado maior ≤1400px) → popup
// Ambos como JPEG (data URL). O pai sobe pro servidor, que só grava os bytes.

const VIEW = 260;     // lado do quadrado de pré-visualização (px)
const ICON_OUT = 512; // lado do ícone exportado
const FULL_MAX = 1400;
const ICON_Q = 0.86;
const FULL_Q = 0.85;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export default function PatientPhotoCropper({ currentUrl, onChange, onClear }) {
  const [src, setSrc] = useState(null);     // dataURL da foto escolhida
  const [img, setImg] = useState(null);     // HTMLImageElement carregado
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // top-left da imagem no viewport
  const [error, setError] = useState('');
  const dragRef = useRef(null);
  const fileRef = useRef(null);

  // Escala "cover": no zoom 1 o menor lado preenche o viewport.
  const coverScale = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = coverScale * zoom;
  const dispW = img ? img.naturalWidth * scale : 0;
  const dispH = img ? img.naturalHeight * scale : 0;

  const clampPan = useCallback((p) => ({
    x: clamp(p.x, VIEW - dispW, 0),
    y: clamp(p.y, VIEW - dispH, 0),
  }), [dispW, dispH]);

  // Ao carregar a imagem (ou trocar zoom), recentra/reclampa.
  useEffect(() => {
    if (!img) return;
    setPan((p) => clampPan(p));
  }, [img, zoom, clampPan]);

  function onPick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { setError('Selecione um arquivo de imagem.'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('Imagem muito grande (máx 20 MB).'); return; }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const im = new Image();
      im.onload = () => {
        setImg(im);
        setZoom(1);
        const cs = VIEW / Math.min(im.naturalWidth, im.naturalHeight);
        const w = im.naturalWidth * cs, h = im.naturalHeight * cs;
        setPan({ x: (VIEW - w) / 2, y: (VIEW - h) / 2 }); // centralizado
      };
      im.onerror = () => setError('Não foi possível abrir esta imagem.');
      im.src = ev.target.result;
      setSrc(ev.target.result);
    };
    reader.readAsDataURL(file);
  }

  // ── Arraste pra reposicionar ──
  function onPointerDown(e) {
    if (!img) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, pan: { ...pan } };
  }
  function onPointerMove(e) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan(clampPan({ x: dragRef.current.pan.x + dx, y: dragRef.current.pan.y + dy }));
  }
  function onPointerUp() { dragRef.current = null; }

  // ── Exporta ícone + full e entrega ao pai ──
  function apply() {
    if (!img) return;
    // Ícone: mesmo enquadramento da preview, escalado de VIEW → ICON_OUT.
    const r = ICON_OUT / VIEW;
    const ic = document.createElement('canvas');
    ic.width = ICON_OUT; ic.height = ICON_OUT;
    const ictx = ic.getContext('2d');
    ictx.imageSmoothingQuality = 'high';
    ictx.fillStyle = '#fff';
    ictx.fillRect(0, 0, ICON_OUT, ICON_OUT);
    ictx.drawImage(img, pan.x * r, pan.y * r, dispW * r, dispH * r);
    const iconDataUrl = ic.toDataURL('image/jpeg', ICON_Q);

    // Full: imagem inteira, lado maior ≤ FULL_MAX.
    const fs = Math.min(1, FULL_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const fc = document.createElement('canvas');
    fc.width = Math.round(img.naturalWidth * fs);
    fc.height = Math.round(img.naturalHeight * fs);
    const fctx = fc.getContext('2d');
    fctx.imageSmoothingQuality = 'high';
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, fc.width, fc.height);
    fctx.drawImage(img, 0, 0, fc.width, fc.height);
    const fullDataUrl = fc.toDataURL('image/jpeg', FULL_Q);

    onChange && onChange({ iconDataUrl, fullDataUrl });
  }

  // Reaplica automaticamente quando o enquadramento muda, com debounce — exportar
  // dois canvas a cada pixel de arraste travaria; espera 160ms de inatividade.
  useEffect(() => {
    if (!img) return;
    const t = setTimeout(() => apply(), 160);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom, pan]);

  return (
    <div className="ppc">
      <div className="ppc-row">
        {/* Viewport quadrado de recorte ou a foto atual */}
        {img ? (
          <div
            className="ppc-view"
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            title="Arraste para enquadrar o rosto"
          >
            <img
              className="ppc-img"
              src={src}
              alt=""
              draggable={false}
              style={{ width: dispW, height: dispH, left: pan.x, top: pan.y }}
            />
            <div className="ppc-frame" />
          </div>
        ) : currentUrl ? (
          <div className="ppc-view ppc-current" style={{ width: VIEW, height: VIEW }}>
            <img src={currentUrl} alt="foto atual" />
          </div>
        ) : (
          <div className="ppc-view ppc-empty" style={{ width: VIEW, height: VIEW }}>
            <span>Sem foto</span>
          </div>
        )}

        <div className="ppc-controls">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
            {img || currentUrl ? 'Trocar foto…' : 'Escolher foto…'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />

          {img && (
            <label className="ppc-zoom">
              Zoom
              <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
          )}

          {(img || currentUrl) && onClear && (
            <button type="button" className="ppc-remove" onClick={() => { setImg(null); setSrc(null); onClear(); }}>
              Remover foto
            </button>
          )}

          <small className="ppc-hint">
            {img
              ? 'Arraste a imagem para centralizar no rosto e ajuste o zoom. Recorte quadrado; o popup mostra a foto inteira.'
              : 'A foto aparece no seletor de pacientes (quadrada) e no chat. Quadrado recortado + imagem inteira no popup.'}
          </small>
          {error && <div className="alert error" style={{ marginTop: 6 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
