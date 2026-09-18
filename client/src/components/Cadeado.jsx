// Cadeado das funcionalidades bloqueadas em Administração → Acessos.
//
// O item continua no menu, com o cadeado: clicar abre o aviso em vez de entrar.
// Quem chega pelo endereço direto vê a TelaBloqueada. (O servidor recusa do mesmo
// jeito — isto aqui é só o que a pessoa enxerga.)
import { Link } from 'react-router-dom';

export function IconeCadeado({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function ModalCadeado({ mensagem, onClose }) {
  if (!mensagem) return null;
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }} role="dialog" aria-modal="true">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconeCadeado size={18} /> Funcionalidade bloqueada</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
          {mensagem}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Entendi</button>
        </div>
      </div>
    </div>
  );
}

// Item do menu que respeita o cadeado.
export function NavFuncionalidade({ to, icon, label, ativo, bloqueada, onBloqueada }) {
  if (bloqueada) {
    return (
      <a
        href={to}
        className="nav-bloqueada"
        title={`${label} (bloqueado)`}
        aria-disabled="true"
        onClick={(e) => { e.preventDefault(); onBloqueada(); }}
        style={{ opacity: 0.55 }}
      >
        {icon}<span>{label}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex' }}><IconeCadeado /></span>
      </a>
    );
  }
  return (
    <Link to={to} className={ativo ? 'active' : ''} title={label}>
      {icon}<span>{label}</span>
    </Link>
  );
}

export function TelaBloqueada({ mensagem }) {
  return (
    <div className="card" style={{ maxWidth: 560, margin: '48px auto', textAlign: 'center' }}>
      <div style={{ display: 'inline-flex', color: 'var(--ink-soft)', marginBottom: 8 }}><IconeCadeado size={28} /></div>
      <h3 style={{ marginBottom: 8 }}>Funcionalidade bloqueada</h3>
      <p style={{ color: 'var(--ink-soft)', lineHeight: 1.55 }}>{mensagem}</p>
      <Link to="/" className="btn btn-ghost" style={{ marginTop: 12 }}>Voltar</Link>
    </div>
  );
}
