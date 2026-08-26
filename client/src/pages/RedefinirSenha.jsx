import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

// Mesmas regras de server/cadastro.js — aqui só como feedback ao digitar.
const REGRAS = [
  { id: 'tamanho',  label: 'Pelo menos 8 caracteres', ok: (s) => s.length >= 8 },
  { id: 'letra',    label: 'Pelo menos 1 letra',      ok: (s) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s) },
  { id: 'numero',   label: 'Pelo menos 1 número',     ok: (s) => /[0-9]/.test(s) },
  { id: 'especial', label: 'Pelo menos 1 símbolo (! @ # $ % & * -)', ok: (s) => /[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|`~]/.test(s) },
];

// Destino do link de "esqueci minha senha".
//
// Redefinir derruba TODAS as sessões da conta (é o cenário em que a senha pode
// ter sido comprometida), então no fim a pessoa entra de novo pelo login — não
// há sessão pra reaproveitar.
export default function RedefinirSenha() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const [senha, setSenha] = useState('');
  const [repetir, setRepetir] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);

  const regrasOk = REGRAS.every((r) => r.ok(senha));
  const iguais = senha.length > 0 && senha === repetir;

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      await api.redefinirSenha(token, senha);
      setPronto(true);
    } catch (err) {
      setErro(err.message || 'Não foi possível redefinir a senha.');
    } finally {
      setEnviando(false);
    }
  }

  if (!token) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-eyebrow">Associação Allos</div>
          <h1>all<span className="accent">_OS</span></h1>
          <div className="login-ornament" />
          <h3 style={{ marginTop: 0 }}>Link incompleto</h3>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
            Este endereço não tem o código de recuperação. Abra o link direto do e-mail —
            alguns aplicativos cortam o final de links longos.
          </p>
          <Link to="/esqueci-senha" className="btn btn-outline">Pedir um link novo</Link>
        </div>
      </div>
    );
  }

  if (pronto) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-eyebrow">Associação Allos</div>
          <h1>all<span className="accent">_OS</span></h1>
          <div className="login-ornament" />
          <h3 style={{ marginTop: 0 }}>Senha redefinida</h3>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
            Sua senha nova já está valendo. Por segurança, as sessões que estavam abertas
            em outros aparelhos foram encerradas.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/login')}>
            Entrar com a senha nova
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <p className="subtitle">criar uma senha nova</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="senha">Nova senha</label>
            <div className="input-com-acao">
              <input
                id="senha" type={mostrar ? 'text' : 'password'} value={senha}
                onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" required
              />
              <button type="button" className="btn-inline-acao" onClick={() => setMostrar((v) => !v)}>
                {mostrar ? 'esconder' : 'mostrar'}
              </button>
            </div>
            <ul className="regras-senha">
              {REGRAS.map((r) => {
                const ok = r.ok(senha);
                return (
                  <li key={r.id} className={senha ? (ok ? 'ok' : 'falta') : ''}>
                    <span aria-hidden="true">{senha && ok ? '✓' : '·'}</span> {r.label}
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <label htmlFor="repetir">Repita a nova senha</label>
            <input
              id="repetir" type={mostrar ? 'text' : 'password'} value={repetir}
              onChange={(e) => setRepetir(e.target.value)} autoComplete="new-password" required
            />
            {repetir && !iguais && <div className="campo-dica"><span className="dica-erro">As senhas não são iguais</span></div>}
          </div>

          {erro && <div className="alert error">{erro}</div>}

          <button type="submit" className="btn btn-primary" disabled={enviando || !regrasOk || !iguais}>
            {enviando ? 'Salvando…' : 'Salvar nova senha'}
          </button>
        </form>

        <div className="login-or"><span>ou</span></div>
        <Link to="/login" className="btn btn-outline">Voltar ao login</Link>
      </div>
    </div>
  );
}
