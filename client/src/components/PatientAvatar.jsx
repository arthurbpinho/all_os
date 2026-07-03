import { useState, useEffect } from 'react';

// Avatar do paciente. As fotos ficam em /profiles_icon/pacientes/, nomeadas pelo
// nome do personagem: "<Nome>-icon.jpg" (quadrado, recortado no rosto, p/ o
// seletor e o cabeçalho do chat) e "<Nome>-full.jpg" (imagem inteira p/ o popup).
// Geradas a partir dos PNGs originais (ver profiles_icon/pacientes/). Sem foto
// (ou erro de carregamento) → cai nas iniciais do nome.

const PAC_DIR = '/profiles_icon/pacientes/';

export function patientIconUrl(name) {
  return name ? PAC_DIR + encodeURIComponent(name) + '-icon.jpg' : null;
}
export function patientFullUrl(name) {
  return name ? PAC_DIR + encodeURIComponent(name) + '-full.jpg' : null;
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const a = parts[0] ? parts[0][0] : '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase() || '?';
}

// Quadrado estático. `iconUrl` (foto enviada pelo admin, no volume) tem prioridade;
// senão cai na foto "de fábrica" derivada do nome; senão, iniciais.
export function PatientAvatar({ name, iconUrl, size = 46, className = '' }) {
  const [failed, setFailed] = useState(false);
  const url = iconUrl || patientIconUrl(name);
  const style = { width: size, height: size };
  if (!url || failed) {
    return (
      <span
        className={`patient-avatar patient-avatar-fallback ${className}`}
        style={{ ...style, fontSize: Math.round(size * 0.4) }}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className={`patient-avatar ${className}`}
      style={style}
      src={url}
      alt={name || 'paciente'}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// Avatar clicável que abre a imagem inteira num popup (usado no chat).
export function PatientAvatarButton({ name, iconUrl, fullUrl, size = 42, className = '' }) {
  const [open, setOpen] = useState(false);
  if (!name) return null;
  return (
    <>
      <button
        type="button"
        className={`patient-avatar-btn ${className}`}
        onClick={() => setOpen(true)}
        title={`Ver foto de ${name}`}
        aria-label={`Ver foto de ${name}`}
      >
        <PatientAvatar name={name} iconUrl={iconUrl} size={size} />
      </button>
      {open && <PatientPhotoModal name={name} fullUrl={fullUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

function PatientPhotoModal({ name, fullUrl, onClose }) {
  const [imgFailed, setImgFailed] = useState(false);
  const url = fullUrl || patientFullUrl(name);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="patient-photo-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Foto de ${name}`}>
      <div className="patient-photo-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="patient-photo-close" onClick={onClose} aria-label="Fechar">×</button>
        {!imgFailed
          ? <img src={url} alt={name} onError={() => setImgFailed(true)} />
          : <div className="patient-photo-noimg">Sem foto disponível</div>}
        <div className="patient-photo-caption">{name}</div>
      </div>
    </div>
  );
}

export default PatientAvatar;
