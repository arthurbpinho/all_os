// Aviso da cota diária de sessões do Aluno Externo.
//
// Aparece só quando ele tenta abrir a 4ª sessão em 24h — não há contador nem
// indicativo antes disso, de propósito: quem faz 1 ou 2 sessões por dia nunca
// precisa saber que existe um limite.
//
// Usado pelas três telas que abrem atendimento (EchoSession, ChatSession e
// DuelSession); o texto vem do servidor (server/session-quota.js), pra mensagem
// não sair de sincronia com a regra.
export default function SessionQuotaModal({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <h3>Limite diário de sessões</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: 18, lineHeight: 1.55 }}>
          {message}
        </p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Entendi</button>
        </div>
      </div>
    </div>
  );
}
