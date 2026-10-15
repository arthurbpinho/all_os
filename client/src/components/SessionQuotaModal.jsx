import { useState, useEffect } from 'react';
import { api } from '../api';
import { formatarEspera } from '../sessionQuota';
import FeedbackForm from './FeedbackForm';

// Aviso da cota diária de sessões do Aluno Externo.
//
// Aparece quando ele tenta abrir uma sessão além da cota de 24h (e na Página
// Inicial, quando ela já está esgotada — ver SessionQuotaBanner). O contador
// do dia fica na Página Inicial; aqui vai a explicação, a contagem regressiva
// até a próxima sessão voltar e, enquanto ele não tiver dado o feedback
// anônimo da plataforma, o formulário dele — depois do primeiro, não volta.
//
// Usado pelas três telas que abrem atendimento (EchoSession, ChatSession e
// DuelSession) e pela Página Inicial; o texto vem do servidor
// (server/session-quota.js), pra mensagem não sair de sincronia com a regra.
export default function SessionQuotaModal({ message, onClose, onFeedbackSent }) {
  const [cota, setCota] = useState(null);
  const [agora, setAgora] = useState(Date.now());
  // null = não respondeu ainda; 'ok' = enviado; 'erro' = o envio falhou.
  const [feedback, setFeedback] = useState(null);

  // O horário da próxima sessão é o mesmo pra qualquer paciente, então basta
  // consultar a cota sem contexto quando o aviso abre.
  useEffect(() => {
    if (!message) return undefined;
    let cancelado = false;
    setFeedback(null);
    api.sessionQuota()
      .then((c) => { if (!cancelado) setCota(c); })
      .catch(() => {});
    const t = setInterval(() => setAgora(Date.now()), 15000);
    return () => { cancelado = true; clearInterval(t); };
  }, [message]);

  if (!message) return null;
  const espera = formatarEspera(cota && cota.resetAt, agora);
  const pedirFeedback = !!(cota && cota.feedbackPendente) && !feedback;

  function feedbackConcluido(ok) {
    setFeedback(ok ? 'ok' : 'erro');
    if (ok && onFeedbackSent) onFeedbackSent();
  }

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

        {pedirFeedback ? (
          <div className="quota-feedback">
            <strong>Gostou da plataforma?</strong>
            <p>Conte o que achou. O feedback é anônimo e ajuda a Allos a manter a plataforma aberta.</p>
            <FeedbackForm onDone={feedbackConcluido} onSkip={onClose} sendLabel="Enviar feedback anônimo" />
          </div>
        ) : (
          <>
            {feedback === 'ok' && (
              <div className="alert" style={{ marginBottom: 16 }}>Obrigado pelo feedback!</div>
            )}
            {feedback === 'erro' && (
              <div className="alert error" style={{ marginBottom: 16 }}>Não foi possível enviar o feedback agora. Tente de novo mais tarde.</div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>Entendi</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
