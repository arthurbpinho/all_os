import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

// Destino dos links de e-mail. Atende os DOIS fluxos que mandam link — cadastro
// novo e troca de endereço — porque o token não diz de qual tipo é; quem decide
// é o servidor, e a resposta vem com `tipo`.
//
// Cadastro confirmado entra JÁ LOGADO: a pessoa acabou de provar que é dona do
// e-mail, e mandar digitar a senha de novo agora só adiciona atrito.
export default function ConfirmarEmail({ onLogin }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const [estado, setEstado] = useState(token ? 'verificando' : 'sem-token');
  const [erro, setErro] = useState('');
  const [tipo, setTipo] = useState(null);

  // Um clique = uma tentativa. O token é de uso único: sem a trava, uma segunda
  // chamada veria o link já consumido e mostraria "link inválido" num cadastro
  // que deu certo.
  const tentadoRef = useRef(false);

  // onLogin numa ref, FORA das dependências. O App passa uma arrow nova a cada
  // render, então tê-la como dependência faz o efeito reexecutar sem parar.
  const onLoginRef = useRef(onLogin);
  onLoginRef.current = onLogin;

  useEffect(() => {
    if (!token || tentadoRef.current) return;
    tentadoRef.current = true;
    // De propósito SEM flag de cancelamento no cleanup. Era exatamente isso que
    // travava a tela em "Confirmando…": o efeito reexecutava (onLogin mudava de
    // identidade), o cleanup marcava a resposta como obsoleta, a trava acima
    // impedia uma nova chamada — e o resultado que chegava era descartado. A
    // conta era criada no servidor e a tela nunca saía do estado inicial.
    // A trava por ref já garante chamada única; cancelar não protege de nada.
    api.confirmarEmail(token)
      .then((res) => {
        setTipo(res.tipo);
        setEstado('ok');
        // O api.confirmarEmail já guardou o token; isso avisa o App.
        if (res.tipo === 'cadastro' && res.user) onLoginRef.current?.(res.user);
      })
      .catch((err) => {
        setErro(err.message || 'Não foi possível confirmar.');
        setEstado('erro');
      });
  }, [token]);

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <div className="login-ornament" />

        {estado === 'verificando' && (
          <>
            <h3 style={{ marginTop: 0 }}>Confirmando…</h3>
            <p className="subtitle">Só um instante.</p>
          </>
        )}

        {estado === 'sem-token' && (
          <>
            <h3 style={{ marginTop: 0 }}>Link incompleto</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
              Este endereço não tem o código de confirmação. Abra o link direto do e-mail que enviamos —
              alguns aplicativos cortam o final de links longos.
            </p>
            <Link to="/cadastro" className="btn btn-outline">Voltar ao cadastro</Link>
          </>
        )}

        {estado === 'ok' && tipo === 'cadastro' && (
          <>
            <h3 style={{ marginTop: 0 }}>Conta confirmada</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
              Pronto — sua conta está ativa e você já está dentro.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/inicio')}>
              Começar
            </button>
          </>
        )}

        {estado === 'ok' && tipo === 'troca-email' && (
          <>
            <h3 style={{ marginTop: 0 }}>E-mail atualizado</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
              Sua conta passou a usar este endereço.
            </p>
            <Link to="/profile" className="btn btn-primary">Ir para o perfil</Link>
          </>
        )}

        {estado === 'erro' && (
          <>
            <h3 style={{ marginTop: 0 }}>Não foi possível confirmar</h3>
            <div className="alert error">{erro}</div>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              Links de confirmação valem por 48 horas e só podem ser usados uma vez.
              Se o seu venceu, refaça o cadastro — o nome de usuário que você escolheu continua livre.
            </p>
            <Link to="/cadastro" className="btn btn-outline">Refazer o cadastro</Link>
            <div className="login-or"><span>ou</span></div>
            <Link to="/login" className="btn btn-outline">Ir para o login</Link>
          </>
        )}
      </div>
    </div>
  );
}
