import { useState } from 'react';
import Typewriter from '../components/Typewriter';
import { api } from '../api';

// Suporte — canal direto do usuário com a administração. A mensagem cai no
// painel "Logs de Erro" do admin (ver POST /api/suporte), que é onde ele já
// olha todos os dias; provisório por decisão do dono, o passo natural depois é
// uma caixa de entrada própria.
//
// O código devolvido é a ponte: o usuário guarda, e o admin acha o recado exato
// pelo mesmo código — igual ao que acontece quando algo falha no app.
const MAX_MESSAGE = 1000; // espelha SUPORTE_MAX_MESSAGE no servidor

export default function Suporte({ user }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentCode, setSentCode] = useState('');
  const [error, setError] = useState('');

  const remaining = MAX_MESSAGE - message.length;
  const tooLong = remaining < 0;

  async function handleSubmit(e) {
    e.preventDefault();
    if (sending || !message.trim() || tooLong) return;
    setSending(true);
    setError('');
    try {
      const res = await api.sendSupportMessage({ subject, message });
      setSentCode(res.codigo || '');
      setSubject('');
      setMessage('');
    } catch (err) {
      setError(err.message || 'Não consegui enviar a mensagem.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="page-header">
        <div className="eyebrow">Ajuda</div>
        <h2><Typewriter text="Su" /><span className="accent"><Typewriter text="porte" delayStart={180} /></span></h2>
        <p>
          Encontrou um problema, tem uma dúvida ou uma sugestão? Escreva aqui — a mensagem vai
          direto para a administração da Allos.
        </p>
        <div className="ornament" />
      </div>

      {sentCode ? (
        <div className="card">
          <div className="alert success" style={{ marginBottom: 14 }}>
            Mensagem enviada. Obrigado!
          </div>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14, lineHeight: 1.6 }}>
            Guarde este código — é por ele que a administração encontra a sua mensagem, caso
            você precise cobrar ou complementar:
          </p>
          <code style={{
            display: 'inline-block', marginTop: 6, padding: '8px 14px', borderRadius: 8,
            background: 'var(--sand-2)', fontSize: 15, fontWeight: 600, letterSpacing: '0.02em',
          }}>
            {sentCode}
          </code>
          <div style={{ marginTop: 20 }}>
            <button type="button" className="btn btn-outline" onClick={() => setSentCode('')}>
              Enviar outra mensagem
            </button>
          </div>
        </div>
      ) : (
        <form className="card admin-form" onSubmit={handleSubmit}>
          {error && <div className="alert error">{error}</div>}

          <div>
            <label htmlFor="suporte-assunto">Assunto <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
            <input
              id="suporte-assunto"
              type="text"
              value={subject}
              maxLength={120}
              placeholder="Ex.: a avaliação não carregou"
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="suporte-mensagem">Mensagem</label>
            <textarea
              id="suporte-mensagem"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Conte o que aconteceu, com o máximo de detalhe que der: em que tela, o que você tentou fazer e, se apareceu um código de erro, qual era."
              style={{ minHeight: 180 }}
              required
            />
            <div style={{ marginTop: 6, fontSize: 12.5, color: tooLong ? 'var(--terra)' : 'var(--muted)' }}>
              {tooLong
                ? `${-remaining} ${-remaining === 1 ? 'caractere' : 'caracteres'} além do limite`
                : `${remaining} ${remaining === 1 ? 'caractere restante' : 'caracteres restantes'}`}
            </div>
          </div>

          <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>
            Vai junto quem você é ({user?.name || user?.username || 'sua conta'}) — não precisa
            se identificar na mensagem.
          </p>

          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={sending || !message.trim() || tooLong}>
              {sending ? 'Enviando…' : 'Enviar mensagem'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
