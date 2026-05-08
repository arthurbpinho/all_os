import { useEffect, useRef, useState } from 'react';

const OUTPUT_SIZE = 320;
const STAGE_SIZE = 280;

export default function PhotoCropper({ onCrop, onCancel, initialImage }) {
  const [image, setImage] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const dragStartRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (initialImage) loadImageFromSrc(initialImage);
  }, [initialImage]);

  function loadImageFromSrc(src) {
    const img = new Image();
    img.onload = () => {
      setImage(img);
      const minSide = Math.min(img.width, img.height);
      const baseScale = STAGE_SIZE / minSide;
      setScale(baseScale);
      setOffset({ x: 0, y: 0 });
    };
    img.onerror = () => setError('Não foi possível carregar a imagem.');
    img.src = src;
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setError('Use um PNG ou JPG.');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => loadImageFromSrc(reader.result);
    reader.readAsDataURL(file);
  }

  function handleMouseDown(e) {
    if (!image) return;
    setDragging(true);
    dragStartRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }
  function handleMouseMove(e) {
    if (!dragging || !dragStartRef.current) return;
    setOffset({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  }
  function handleMouseUp() {
    setDragging(false);
    dragStartRef.current = null;
  }

  function handleTouchStart(e) {
    if (!image) return;
    const t = e.touches[0];
    setDragging(true);
    dragStartRef.current = { x: t.clientX - offset.x, y: t.clientY - offset.y };
  }
  function handleTouchMove(e) {
    if (!dragging || !dragStartRef.current) return;
    const t = e.touches[0];
    setOffset({
      x: t.clientX - dragStartRef.current.x,
      y: t.clientY - dragStartRef.current.y,
    });
  }

  function buildCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    // Mapear o que está visível no stage (STAGE_SIZE x STAGE_SIZE) para o output
    const ratio = OUTPUT_SIZE / STAGE_SIZE;
    const drawW = image.width * scale * ratio;
    const drawH = image.height * scale * ratio;
    const cx = OUTPUT_SIZE / 2 + offset.x * ratio;
    const cy = OUTPUT_SIZE / 2 + offset.y * ratio;
    ctx.drawImage(image, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    return canvas;
  }

  function handleSave() {
    if (!image) return;
    const canvas = buildCanvas();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    onCrop(dataUrl);
  }

  return (
    <div className="cropper">
      {!image && (
        <div className="cropper-empty">
          <p>Selecione uma imagem (PNG ou JPG) para usar como foto de perfil.</p>
          <button type="button" className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            Escolher arquivo
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {image && (
        <>
          <div
            className="cropper-stage"
            style={{ width: STAGE_SIZE, height: STAGE_SIZE }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleMouseUp}
          >
            <img
              src={image.src}
              alt="preview"
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${scale})`,
                transformOrigin: 'center center',
                userSelect: 'none',
                pointerEvents: 'none',
                maxWidth: 'none',
              }}
            />
            <div className="cropper-mask" />
          </div>

          <div className="cropper-controls">
            <label className="cropper-zoom-label">Zoom</label>
            <input
              type="range"
              min="0.1"
              max="3"
              step="0.01"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={() => fileInputRef.current?.click()}>
              Trocar imagem
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFile}
              style={{ display: 'none' }}
            />
          </div>
        </>
      )}

      {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}

      <div className="cropper-actions">
        {onCancel && (
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!image}>
          Usar esta foto
        </button>
      </div>
    </div>
  );
}
