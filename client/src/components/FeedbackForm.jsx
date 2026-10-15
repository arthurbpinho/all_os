import { useState } from 'react';
import { api } from '../api';

// Formulário de feedback da plataforma: 0–5 estrelas + mensagem opcional.
// Usado no popup do visitante (fim da sessão, EchoSession) e no aviso de cota
// esgotada do Aluno Externo (SessionQuotaModal). Quem decide se o feedback é
// anônimo é o servidor (POST /api/feedback), pelo papel de quem envia.
//
// Falha no envio não prende ninguém: chama onDone do mesmo jeito (o feedback
// é um pedido, não uma etapa obrigatória).
export default function FeedbackForm({ onDone, onSkip, skipLabel = 'Agora não', sendLabel = 'Enviar feedback' }) {
  const [stars, setStars] = useState(0);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  async function enviar() {
    if (sending) return;
    setSending(true);
    let ok = true;
    try {
      await api.submitFeedback({ stars, message: message.trim() });
    } catch (err) {
      ok = false;
      console.error('Falha ao enviar feedback:', err.message);
    } finally {
      setSending(false);
    }
    onDone(ok);
  }

  return (
    <>
      <div className="feedback-stars" role="group" aria-label="Avaliação de 0 a 5 estrelas">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className={`feedback-star ${n <= stars ? 'on' : ''}`}
            aria-label={`${n} ${n === 1 ? 'estrela' : 'estrelas'}`}
            aria-pressed={n <= stars}
            onClick={() => setStars(n === stars ? 0 : n)}
          >
            {n <= stars ? '★' : '☆'}
          </button>
        ))}
      </div>

      <textarea
        className="feedback-message"
        rows={4}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Deixe sua mensagem (opcional)…"
        maxLength={2000}
      />

      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onSkip} disabled={sending}>
          {skipLabel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={enviar}
          disabled={sending || (!stars && !message.trim())}
        >
          {sending ? 'Enviando…' : sendLabel}
        </button>
      </div>
    </>
  );
}
