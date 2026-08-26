import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Turnstile from '../components/Turnstile';

// Cadastro de Aluno Externo — o único papel que nasce sem admin.
//
// A conta NÃO é criada aqui: o envio cria uma pendência e manda um link por
// e-mail. Enquanto o link não é clicado, não existe usuário nenhum. É por isso
// que a tela termina em "confira seu e-mail" e não em "bem-vindo".

// Espelha server/cadastro.js. Duplicado de propósito: aqui é feedback enquanto a
// pessoa digita, lá é a regra que vale. O servidor recusa de novo o que passar.
const REGRAS_SENHA = [
  { id: 'tamanho',  label: 'Pelo menos 8 caracteres',   ok: (s) => s.length >= 8 },
  { id: 'letra',    label: 'Pelo menos 1 letra',        ok: (s) => /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(s) },
  { id: 'numero',   label: 'Pelo menos 1 número',       ok: (s) => /[0-9]/.test(s) },
  { id: 'especial', label: 'Pelo menos 1 símbolo (! @ # $ % & * -)', ok: (s) => /[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|`~]/.test(s) },
];

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// Termos de uso e política de privacidade viram link só quando as URLs estão
// configuradas no servidor (envs TERMOS_URL / PRIVACIDADE_URL). Sem elas, o
// texto aparece sublinhado mas inerte — um link para uma página inexistente é
// pior que nenhum, porque o aceite passa a apontar para lugar nenhum.
function Legal({ url, children }) {
  if (!url) return <span className="legal-pendente" title="Documento em preparação">{children}</span>;
  return <a href={url} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export default function Cadastro() {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({
    username: '', name: '', email: '', password: '',
    origem: '', origemDetalhe: '',
    aceiteTermos: false, newsletterAllOS: false, newsletterAllos: false,
  });
  const [mostrarSenha, setMostrarSenha] = useState(false);
  const [captcha, setCaptcha] = useState(null);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);      // cadastro aceito; aguardando o e-mail
  const [reenviado, setReenviado] = useState(false);
  // null = não checado ainda | true/false = disponível
  const [dispUser, setDispUser] = useState({ estado: 'idle', motivo: null });

  useEffect(() => {
    api.config().then(setCfg).catch(() => setCfg({ cadastroAberto: true, origens: [], turnstileSiteKey: '' }));
  }, []);

  const set = (campo) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [campo]: v }));
  };

  // Disponibilidade do nome de usuário, com espera de 500ms pra não disparar uma
  // request por tecla (e não queimar o limite da rota).
  const debounceRef = useRef(null);
  useEffect(() => {
    const u = form.username.trim();
    clearTimeout(debounceRef.current);
    if (!u) { setDispUser({ estado: 'idle', motivo: null }); return; }
    if (!USERNAME_RE.test(u)) { setDispUser({ estado: 'invalido', motivo: 'formato' }); return; }
    setDispUser({ estado: 'checando', motivo: null });
    debounceRef.current = setTimeout(() => {
      api.cadastroDisponibilidade(u)
        .then((r) => setDispUser({ estado: r.disponivel ? 'livre' : 'ocupado', motivo: r.motivo }))
        .catch(() => setDispUser({ estado: 'idle', motivo: null }));
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [form.username]);

  const origemDef = (cfg?.origens || []).find((o) => o.id === form.origem);
  const senhaOk = REGRAS_SENHA.every((r) => r.ok(form.password));
  const senhaTemUsername = form.username.trim().length >= 3
    && form.password.toLowerCase().includes(form.username.trim().toLowerCase());
  const nomeOk = form.name.trim().includes(' ') && form.name.trim().length >= 2;
  const podeEnviar = !enviando
    && dispUser.estado === 'livre'
    && nomeOk
    && form.email.trim().includes('@')
    && senhaOk && !senhaTemUsername
    && form.aceiteTermos
    && (!origemDef?.detalhe || form.origemDetalhe.trim())
    && (!cfg?.turnstileSiteKey || captcha);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    setEnviando(true);
    try {
      await api.cadastrar({ ...form, turnstileToken: captcha });
      setPronto(true);
    } catch (err) {
      setErro(err.message || 'Não foi possível concluir o cadastro.');
      // Token do Turnstile é de uso único: depois de um envio, mesmo recusado,
      // ele não serve mais. Sem limpar, a segunda tentativa falharia no captcha.
      setCaptcha(null);
    } finally {
      setEnviando(false);
    }
  }

  async function handleReenviar() {
    try {
      await api.cadastroReenviar(form.email);
      setReenviado(true);
    } catch (err) {
      setErro(err.message || 'Não foi possível reenviar.');
    }
  }

  if (cfg && cfg.cadastroAberto === false) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-eyebrow">Associação Allos</div>
          <h1>all<span className="accent">_OS</span></h1>
          <div className="login-ornament" />
          <h3 style={{ marginTop: 0 }}>Cadastro fechado no momento</h3>
          <p className="subtitle" style={{ marginBottom: 20 }}>
            Os novos cadastros estão temporariamente suspensos. Tente novamente mais tarde.
          </p>
          <Link to="/login" className="btn btn-outline">Voltar ao login</Link>
        </div>
      </div>
    );
  }

  // Tela de "confira seu e-mail". O ponto importante aqui é não prometer que a
  // conta existe — ela só passa a existir quando a pessoa clicar no link.
  if (pronto) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-eyebrow">Associação Allos</div>
          <h1>all<span className="accent">_OS</span></h1>
          <div className="login-ornament" />
          <h3 style={{ marginTop: 0 }}>Confira seu e-mail</h3>
          <p style={{ color: 'var(--ink-soft)', fontSize: 14.5, lineHeight: 1.65 }}>
            Mandamos um link de confirmação para <strong>{form.email}</strong>. Ele vale por{' '}
            <strong>48 horas</strong> — sua conta é criada quando você clicar nele.
          </p>
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, marginTop: -4 }}>
            Não chegou? Confira a caixa de spam ou lixo eletrônico.
          </p>
          {erro && <div className="alert error">{erro}</div>}
          {reenviado
            ? <div className="alert" style={{ marginBottom: 12 }}>Link reenviado.</div>
            : <button type="button" className="btn btn-outline" onClick={handleReenviar}>Reenviar o link</button>}
          <div className="login-or"><span>ou</span></div>
          <Link to="/login" className="btn btn-outline">Ir para o login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card login-card-wide">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <p className="subtitle">criar conta de aluno externo</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username">Nome de usuário *</label>
            <input
              id="username" type="text" value={form.username} onChange={set('username')}
              placeholder="como você aparece na plataforma"
              autoComplete="username" autoCapitalize="none" spellCheck="false" required
            />
            <div className="campo-dica">
              {dispUser.estado === 'checando' && <span className="dica-neutra">Verificando…</span>}
              {dispUser.estado === 'livre' && <span className="dica-ok">Disponível</span>}
              {dispUser.estado === 'invalido' && <span className="dica-erro">3 a 32 caracteres: letras, números, ponto, hífen e sublinhado</span>}
              {dispUser.estado === 'ocupado' && (
                <span className="dica-erro">
                  {dispUser.motivo === 'reservado' ? 'Este nome é reservado — escolha outro' : 'Já está em uso'}
                </span>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="name">Nome e sobrenome *</label>
            <input
              id="name" type="text" value={form.name} onChange={set('name')}
              placeholder="seu nome completo" autoComplete="name" required
            />
          </div>

          <div>
            <label htmlFor="email">E-mail *</label>
            <input
              id="email" type="email" value={form.email} onChange={set('email')}
              placeholder="voce@exemplo.com" autoComplete="email" autoCapitalize="none" spellCheck="false" required
            />
            <div className="campo-dica">
              <span className="dica-neutra">Use um e-mail real: a confirmação do cadastro vai para ele.</span>
            </div>
          </div>

          <div>
            <label htmlFor="origem">Como conheceu a plataforma</label>
            <select id="origem" value={form.origem} onChange={(e) => setForm((f) => ({ ...f, origem: e.target.value, origemDetalhe: '' }))}>
              <option value="">Prefiro não dizer</option>
              {(cfg?.origens || []).map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>

          {origemDef?.detalhe && (
            <div>
              <label htmlFor="origemDetalhe">{origemDef.detalheLabel} *</label>
              <input
                id="origemDetalhe" type="text" value={form.origemDetalhe} onChange={set('origemDetalhe')}
                maxLength={120} required
              />
            </div>
          )}

          <div>
            <label htmlFor="password">Senha *</label>
            <div className="input-com-acao">
              <input
                id="password" type={mostrarSenha ? 'text' : 'password'}
                value={form.password} onChange={set('password')}
                autoComplete="new-password" required
              />
              <button
                type="button" className="btn-inline-acao"
                onClick={() => setMostrarSenha((v) => !v)}
                aria-label={mostrarSenha ? 'Esconder senha' : 'Mostrar senha'}
              >
                {mostrarSenha ? 'esconder' : 'mostrar'}
              </button>
            </div>
            <ul className="regras-senha">
              {REGRAS_SENHA.map((r) => {
                const ok = r.ok(form.password);
                return (
                  <li key={r.id} className={form.password ? (ok ? 'ok' : 'falta') : ''}>
                    <span aria-hidden="true">{form.password && ok ? '✓' : '·'}</span> {r.label}
                  </li>
                );
              })}
              <li className={senhaTemUsername ? 'falta' : (form.password && form.username ? 'ok' : '')}>
                <span aria-hidden="true">{form.password && form.username && !senhaTemUsername ? '✓' : '·'}</span> Não pode conter seu nome de usuário
              </li>
            </ul>
          </div>

          <div className="consentimentos">
            <label className="check-linha">
              <input type="checkbox" checked={form.aceiteTermos} onChange={set('aceiteTermos')} required />
              <span>
                Estou de acordo com os <Legal url={cfg?.termosUrl}>termos de uso</Legal>{' '}
                e a <Legal url={cfg?.privacidadeUrl}>política de privacidade</Legal> da plataforma. *
              </span>
            </label>
            <label className="check-linha">
              <input type="checkbox" checked={form.newsletterAllOS} onChange={set('newsletterAllOS')} />
              <span>Quero receber notícias e atualizações do all_OS no meu e-mail.</span>
            </label>
            <label className="check-linha">
              <input type="checkbox" checked={form.newsletterAllos} onChange={set('newsletterAllos')} />
              <span>Quero receber notícias de eventos e novidades da Associação Allos no meu e-mail.</span>
            </label>
          </div>

          {cfg?.turnstileSiteKey && (
            <Turnstile siteKey={cfg.turnstileSiteKey} acao="cadastro" onToken={setCaptcha} />
          )}

          {erro && <div className="alert error">{erro}</div>}

          <button type="submit" className="btn btn-primary" disabled={!podeEnviar}>
            {enviando ? 'Enviando…' : 'Criar minha conta'}
          </button>
        </form>

        <div className="login-or"><span>ou</span></div>
        <Link to="/login" className="btn btn-outline">Já tenho conta — entrar</Link>
      </div>
    </div>
  );
}
