import { useState, useEffect } from 'react';
import { api } from '../api';
import { formatarEspera } from '../sessionQuota';

// Aviso da cota diária de sessões do Aluno Externo.
//
// Aparece quando ele tenta abrir uma sessão além da cota de 24h. O contador do
// dia fica na Página Inicial (SessionQuotaBanner); aqui vai a explicação e a
// contagem regressiva até a próxima sessão voltar.
//
// Usado pelas três telas que abrem atendimento (EchoSession, ChatSession e
// DuelSession); o texto vem do servidor (server/session-quota.js), pra mensagem
// não sair de sincronia com a regra.
export default function SessionQuotaModal({ message, onClose }) {
  const [resetAt, setResetAt] = useState(null);
  const [agora, setAgora] = useState(Date.now());

  // O horário da próxima sessão é o mesmo pra qualquer paciente, então basta
  // consultar a cota sem contexto quando o aviso abre.
  useEffect(() => {
    if (!message) return undefined;
    let cancelado = false;
    api.sessionQuota()
      .then((c) => { if (!cancelado) setResetAt(c && c.resetAt); })
      .catch(() => {});
    const t = setInterval(() => setAgora(Date.now()), 15000);
    return () => { cancelado = true; clearInterval(t); };
  }, [message]);

  if (!message) return null;
  const espera = formatarEspera(resetAt, agora);
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <h3>Limite diário de sessões</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: -4, marginBottom: espera ? 10 : 18, lineHeight: 1.55 }}>
          {message}
        </p>
        {espera && (
          <p style={{ fontSize: 14, marginTop: 0, marginBottom: 18 }}>
            Próxima sessão disponível em <strong>{espera}</strong>.
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Entendi</button>
        </div>
      </div>
    </div>
  );
}
