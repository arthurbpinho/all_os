import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Turnstile from '../components/Turnstile';

// Pedido de redefinição de senha.
//
// A tela SEMPRE mostra a mesma confirmação, exista conta ou não com aquele
// endereço. Dizer "não há conta com este e-mail" entregaria a um estranho quem
// tem conta na plataforma — e é justamente o que se quer evitar aqui.
export default function EsqueciSenha() {
  const [cfg, setCfg] = useState(null);
  const [email, setEmail] = useState('');
  const [captcha, setCaptcha] = useState(null);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setCfg({ turnstileSiteKey: '', emailAtivo: true }));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      await api.esqueciSenha(email.trim(), captcha);
      setEnviado(true);
    } catch (err) {
      setErro(err.message || 'Não foi possível enviar o pedido.');
      setCaptcha(null); // token do Turnstile é de uso único
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-eyebrow">Associação Allos</div>
          <h1>all<span className="accent">_OS</span></h1>
          <div className="login-ornament" />
          <h3 style={{ marginTop: 0 }}>Confira seu e-mail</h3>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
            Se existir uma conta com <strong>{email.trim()}</strong>, o link para criar uma senha nova
            já está a caminho. Ele vale por <strong>1 hora</strong> e só funciona uma vez.
          </p>
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, marginTop: -4 }}>
            Não chegou? Confira o spam. Se você entrou com outro endereço, tente com ele.
          </p>
          <Link to="/login" className="btn btn-outline">Voltar ao login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <p className="subtitle">recuperar acesso</p>
        <div className="login-ornament" />

        {cfg && cfg.emailAtivo === false && (
          <div className="alert error">
            O envio de e-mail não está configurado nesta instalação. Fale com a equipe da Allos
            para redefinir sua senha.
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email">E-mail da sua conta</label>
            <input
              id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@exemplo.com" autoComplete="email" autoCapitalize="none" spellCheck="false" required
            />
          </div>

          {cfg?.turnstileSiteKey && (
            <Turnstile siteKey={cfg.turnstileSiteKey} acao="reset-senha" onToken={setCaptcha} />
          )}

          {erro && <div className="alert error">{erro}</div>}

          <button
            type="submit" className="btn btn-primary"
            disabled={enviando || !email.trim() || (!!cfg?.turnstileSiteKey && !captcha)}
          >
            {enviando ? 'Enviando…' : 'Enviar link de recuperação'}
          </button>
        </form>

        <div className="login-or"><span>ou</span></div>
        <Link to="/login" className="btn btn-outline">Voltar ao login</Link>
      </div>
    </div>
  );
}
