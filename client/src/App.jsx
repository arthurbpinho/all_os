import { useState, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import SkillMap from './pages/SkillMap';
import FreePlay from './pages/FreePlay';
import Competitive from './pages/Competitive';
import NeuroEval from './pages/NeuroEval';
import ChatSession from './pages/ChatSession';
import EchoSession from './pages/EchoSession';
import Logs from './pages/Logs';
import AdminExercises from './pages/AdminExercises';
import AdminTrilhaLogs from './pages/AdminTrilhaLogs';
import AdminFreeplay from './pages/AdminFreeplay';
import AdminNeuro from './pages/AdminNeuro';
import AdminEntrevistador from './pages/AdminEntrevistador';
import AdminModelos from './pages/AdminModelos';
import AdminPrompts from './pages/AdminPrompts';
import AdminErrorLogs from './pages/AdminErrorLogs';
import Avaliacao from './pages/Avaliacao'
import SimulacaoIndependente from './pages/SimulacaoIndependente'
import BenchmarkSimulacao from './pages/BenchmarkSimulacao'
import Profile from './pages/Profile';
import Missoes from './pages/Missoes';
import Ranking from './pages/Ranking';
import AdminUsers from './pages/AdminUsers';
import Duelo from './pages/Duelo';
import DuelSession from './pages/DuelSession';
import DuelAccept from './pages/DuelAccept';
import Terapeutas from './pages/Terapeutas';
import LogsSociais from './pages/LogsSociais';
import ProcessoSeletivo from './pages/ProcessoSeletivo';
import Cadastro from './pages/Cadastro';
import ConfirmarEmail from './pages/ConfirmarEmail';
import EsqueciSenha from './pages/EsqueciSenha';
import RedefinirSenha from './pages/RedefinirSenha';
import Antessala from './pages/Antessala';
import Suporte from './pages/Suporte';
import SelecaoDashboard from './pages/SelecaoDashboard';
import SelecaoLogs from './pages/SelecaoLogs';
import NotificationBell from './components/NotificationBell';
import ThemeToggle from './components/ThemeToggle';
import { api, getToken, clearAuth, onSessionExpired } from './api';
import { ICONS } from './icons';

// A tela de login virou uma ROTA em vez do portão de entrada: quem chega sem
// conta cai direto no modo visitante e chega aqui pelo botão "Entrar" do topo.
const LOGIN_PATH = '/login';

// Telas de quem ainda não tem (ou perdeu) a conta. Ficam FORA do shell do app e
// não disparam sessão de visitante: pedir um token de visitante pra alguém que
// está criando conta gastaria cota do limite por IP sem nenhum ganho — e numa
// faculdade, onde a sala toda sai pelo mesmo IP, isso importa.
const ROTAS_PUBLICAS = ['/cadastro', '/confirmar-email', '/esqueci-senha', '/redefinir-senha'];
function ehRotaPublica(pathname) {
  return ROTAS_PUBLICAS.some((r) => pathname === r || pathname.startsWith(r + '/'));
}

export default function App() {
  const [user, setUser] = useState(() => {
    // Só restaura sessão se houver token salvo. Senão, ignora cache de user.
    if (!getToken()) return null;
    const saved = localStorage.getItem('allos_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [authChecked, setAuthChecked] = useState(!getToken());
  const location = useLocation();
  const navigate = useNavigate();

  const [streak, setStreak] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Sidebar retrátil (só desktop ≥1025px — no tablet ela já é coluna de ícones
  // por CSS, e no celular é drawer). Vale entre sessões: quem encolheu não quer
  // achar tudo expandido de novo no próximo acesso.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('allos_sidebar_collapsed') === '1'; } catch { return false; }
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem('allos_sidebar_collapsed', next ? '1' : '0'); } catch { /* modo privado */ }
      return next;
    });
  };

  // Fecha drawer mobile sempre que a rota mudar
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  // Revalida token no boot (e busca user atualizado do servidor).
  useEffect(() => {
    if (!getToken()) { setAuthChecked(true); return; }
    let cancelled = false;
    api.me()
      .then((data) => {
        if (cancelled) return;
        if (data && data.user) {
          setUser(data.user);
          localStorage.setItem('allos_user', JSON.stringify(data.user));
        }
      })
      .catch(() => {
        if (cancelled) return;
        clearAuth();
        setUser(null);
      })
      .finally(() => { if (!cancelled) setAuthChecked(true); });
    return () => { cancelled = true; };
  }, []);

  // Entrada sem conta: em vez de barrar com a tela de login, o app já abre em
  // modo visitante. Quem tem conta clica em "Entrar" no topo e vai pro /login.
  //
  // O ref evita duas chamadas: o efeito roda de novo a cada mudança de rota, e
  // em dev o StrictMode monta o componente duas vezes. Sem ele, cada abertura
  // gastaria dois tokens do limite de visitante por IP.
  const visitorPedidoRef = useRef(false);
  useEffect(() => {
    if (!authChecked || user || visitorPedidoRef.current) return;
    // Nestas rotas a ausência de conta é proposital: o /login é onde a pessoa
    // vai justamente pra sair do modo visitante, e o seletivo tem auth própria.
    if (location.pathname === LOGIN_PATH) return;
    if (location.pathname.startsWith('/processo-seletivo')) return;
    if (ehRotaPublica(location.pathname)) return;

    visitorPedidoRef.current = true;
    let cancelled = false;
    api.loginVisitor()
      .then((u) => {
        if (cancelled || !u) return;
        setUser(u);
        localStorage.setItem('allos_user', JSON.stringify(u));
      })
      .catch(() => {
        // Sem sessão de visitante (rede fora, ou limite por IP estourado):
        // cai na tela de login, que é a única saída útil nesse estado.
        if (!cancelled) navigate(LOGIN_PATH);
      })
      .finally(() => { if (!cancelled) visitorPedidoRef.current = false; });
    return () => { cancelled = true; };
  }, [authChecked, user, location.pathname, navigate]);

  // Logout automático se a API sinalizar 401 em qualquer chamada.
  useEffect(() => {
    return onSessionExpired(() => {
      // Visitante com token vencido (dura 2h) é renovado em silêncio pelo efeito
      // acima — ele está só passeando, não faz sentido jogá-lo numa tela de
      // login. Sessão real expirada vai pro /login, pra ficar explícito que
      // saiu da conta em vez de virar visitante sem perceber.
      const eraVisitante = user && user.role === 'visitor';
      setUser(null);
      if (!eraVisitante) navigate(LOGIN_PATH);
    });
  }, [navigate, user]);

  useEffect(() => {
    if (!user?.id) { setStreak(null); return; }
    let cancelled = false;
    api.getGamification(user.id)
      .then((data) => { if (!cancelled) setStreak(data?.streak || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, location.pathname]);

  // `navegar: false` é o caso do ConfirmarEmail: a pessoa entra logada, mas
  // precisa ver a tela de "conta confirmada" antes de ir pro app. Navegar aqui
  // tornaria essa tela inalcançável.
  const handleLogin = (u, { navegar = true } = {}) => {
    setUser(u);
    localStorage.setItem('allos_user', JSON.stringify(u));
    // O /login é uma rota agora — depois de entrar precisa sair dela.
    if (navegar) navigate('/');
  };

  const handleUpdateUser = (updated) => {
    setUser(updated);
    localStorage.setItem('allos_user', JSON.stringify(updated));
  };

  const handleLogout = () => {
    clearAuth();
    setUser(null);
    // Vai pro /login em vez da home: sair da conta e reaparecer como visitante
    // sem aviso nenhum seria confuso. De lá dá pra voltar ao modo visitante.
    navigate(LOGIN_PATH);
  };

  if (!authChecked) {
    return null;
  }
  // Processo Seletivo: fluxo público do candidato (sem conta), FORA do shell e
  // sem tela de Login. Precisa vir ANTES do gate de auth — o candidato entra pelo
  // link, digita a senha e faz a avaliação sem nunca criar/usar uma conta.
  if (location.pathname.startsWith('/processo-seletivo')) {
    return <ProcessoSeletivo />;
  }
  // Cadastro e recuperação de conta: também fora do shell, e ANTES do gate de
  // auth. Confirmar o cadastro já loga a pessoa, então o ConfirmarEmail recebe
  // o mesmo handleLogin usado pela tela de login.
  if (ehRotaPublica(location.pathname)) {
    return (
      <Routes>
        <Route path="/cadastro" element={<Cadastro />} />
        <Route path="/confirmar-email" element={<ConfirmarEmail onLogin={(u) => handleLogin(u, { navegar: false })} />} />
        <Route path="/esqueci-senha" element={<EsqueciSenha />} />
        <Route path="/redefinir-senha" element={<RedefinirSenha />} />
      </Routes>
    );
  }
  // Tela de login: agora é uma rota, não o portão de entrada. Vale também com
  // sessão de visitante ativa — é assim que o visitante troca por uma conta real.
  if (location.pathname === LOGIN_PATH) {
    return <Login onLogin={handleLogin} visitorAtivo={!!user && user.role === 'visitor'} />;
  }
  if (!user) {
    // Sessão de visitante sendo criada pelo efeito acima. Dura um round-trip.
    return null;
  }

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  // Aluno externo usa o menu do aluno. A única diferença é não pressupor
  // vínculo com a Allos — o que muda no servidor (nasce sem supervisor), não na
  // navegação. `isTherapist` cobre os dois papéis para não ter que listar os
  // dois em cada item do menu.
  const isTherapist = user.role === 'therapist' || user.role === 'external';
  const isSupervisor = user.role === 'supervisor';
  const isAdmin = user.role === 'admin';
  const isVisitor = user.role === 'visitor';
  const isEvaluator = user.role === 'evaluator';

  return (
    <div className={`app-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {/* Cabeçalho único do app. As ações (tema, atualizações, sino, "Entrar")
          vivem DENTRO dele, e não soltas em position:fixed por cima — era isso
          que fazia elas cobrirem o logo "all_OS" no celular quando o papel do
          usuário tinha um item a mais (3 ícones no admin/supervisor, a pílula
          "Entrar" no visitante). Aqui elas são um item da mesma linha flex, então
          o cabeçalho se reorganiza sozinho, com qualquer combinação de itens.
          No desktop o cabeçalho encolhe pro canto superior direito e só as ações
          aparecem — hamburger, logo e avatar são do mobile (ver .app-topbar). */}
      <header className="app-topbar">
        <button
          className="hamburger-btn"
          onClick={() => setMobileNavOpen((v) => !v)}
          aria-label="Abrir menu"
          aria-expanded={mobileNavOpen}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="mobile-topbar-logo">all<span className="accent">_OS</span></div>
        <div className="topbar-actions">
          <ThemeToggle />
          {!isVisitor && <NotificationBell user={user} />}
          {/* Visitante entra sem conta; este é o caminho de volta pra uma real. */}
          {isVisitor && (
            <Link to={LOGIN_PATH} className="topbar-login-btn">Entrar</Link>
          )}
        </div>
        {isVisitor ? (
          <span className="mobile-topbar-avatar" aria-label="Visitante">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
          </span>
        ) : (
          <Link to="/profile" className="mobile-topbar-avatar" aria-label="Perfil">
            {user.profilePhoto
              ? <img src={user.profilePhoto} alt={user.name} />
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
            }
          </Link>
        )}
      </header>

      <div
        className={`mobile-nav-backdrop ${mobileNavOpen ? 'open' : ''}`}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />

      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-logo">
          <h1>all<span className="accent">_OS</span></h1>
          <p>Simulação Clínica</p>
          {/* Encolhe/expande a barra. A seta aponta pra onde a barra vai: "<"
              recolhe, ">" devolve (o CSS gira a mesma seta em 180°). */}
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expandir menu' : 'Encolher menu'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Expandir menu' : 'Encolher menu'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 5 8 12 15 19" />
            </svg>
          </button>
        </div>

        <nav className="sidebar-nav">
          {(isTherapist || isSupervisor || isAdmin || isVisitor) && (
            <>
              <div className="nav-section">Prática</div>
              {(isTherapist || isAdmin || isVisitor) && (
                <Link to="/inicio" className={isActive('/inicio') ? 'active' : ''} title="Início">
                  {ICONS.home}<span>Início</span>
                </Link>
              )}
              {/* Treinamento voltou pro menu porque a tela de Início que o
                  abria (as duas "portas") deixou de existir: o /inicio agora é
                  a lista de pacientes. A Trilha é o hub dos outros modos —
                  Progressão, Duelo e Antessala moram dentro dela. O visitante
                  não entra na Trilha, então cai direto na Progressão, que é o
                  que ele pode usar. */}
              {(isTherapist || isAdmin || isVisitor) && (
                <Link
                  to={isVisitor ? '/progressao' : '/skills'}
                  className={isActive('/skills') || isActive('/progressao') ? 'active' : ''}
                  title="Treinamento"
                >
                  {ICONS.skill}<span>Treinamento</span>
                </Link>
              )}
            </>
          )}

          {/* Comunidade ACIMA de Histórico. Objetivos veio da Prática (mesma
              audiência: aluno/admin — não visitante, não supervisor). O avaliador
              não participa da comunidade (só vê o Processo Seletivo). */}
          {!isVisitor && !isEvaluator && (
            <>
              <div className="nav-section">Comunidade</div>
              <Link to="/ranking" className={isActive('/ranking') ? 'active' : ''} title="Ranking">
                {ICONS.supervisor}<span>Ranking</span>
              </Link>
              {(isTherapist || isAdmin) && (
                <Link to="/missoes" className={isActive('/missoes') ? 'active' : ''} title="Objetivos">
                  {ICONS.flame}<span>Objetivos</span>
                </Link>
              )}
            </>
          )}

          {(isTherapist || isSupervisor || isVisitor || isAdmin) && (
            <>
              <div className="nav-section">Histórico</div>
              {/* "Logs de Duelo" deixou de ser item próprio — agora é uma aba
                  dentro de "Minhas Sessões". A rota /duelo/logs segue existindo. */}
              {(isTherapist || isVisitor) && (
                <Link to="/logs" className={isActive('/logs') ? 'active' : ''} title="Minhas Sessões">
                  {ICONS.log}<span>Minhas Sessões</span>
                </Link>
              )}
              {isSupervisor && (
                <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''} title="Logs dos Alunos">
                  {ICONS.supervisor}<span>Logs dos Alunos</span>
                </Link>
              )}
              {/* Antessala: o supervisor lê aqui os mapas entregues pelos alunos. */}
              {isSupervisor && (
                <Link to="/antessala" className={isActive('/antessala') ? 'active' : ''} title="Antessala">
                  {ICONS.antessala}<span>Antessala</span>
                </Link>
              )}
              {(isSupervisor || isAdmin) && (
                <Link to="/terapeutas" className={isActive('/terapeutas') ? 'active' : ''} title="Terapeutas">
                  {ICONS.social}<span>Terapeutas</span>
                </Link>
              )}
            </>
          )}

          {(isSupervisor || isAdmin) && (
            <>
              <div className="nav-section">Avaliação</div>
              <Link to="/avaliacao" className={isActive('/avaliacao') ? 'active' : ''} title="Avaliar Sessão">
                {ICONS.evaluate}<span>Avaliar Sessão</span>
              </Link>
              {/* Laboratório de custo do PACIENTE (a IA que conversa com o aluno).
                  Irmão da Avaliar Sessão, mas mede custo × qualidade da fala do
                  personagem, com o custo em tempo real e sem avaliador. */}
              <Link to="/simulacao-independente" className={isActive('/simulacao-independente') ? 'active' : ''} title="Simulação Independente">
                {ICONS.freeplay}<span>Simulação Independente</span>
              </Link>
              {/* Mesmo laboratório do paciente, com o ALUNO automatizado: sobe o log
                  de um atendimento, a IA reproduz a persona de quem atendeu e
                  refaz o caso por N interações. Mede custo e sustentação do
                  paciente num atendimento inteiro. Sem avaliação. */}
              <Link to="/benchmark-simulacao" className={isActive('/benchmark-simulacao') ? 'active' : ''} title="Benchmarking de Simulação">
                {ICONS.log}<span>Benchmarking de Simulação</span>
              </Link>
            </>
          )}

          {/* Neuroavaliação (personagens + simulação): visível a professor e admin
              por enquanto — oculta de alunos. O servidor também restringe a esses
              perfis (canUseNeuro). */}
          {(isSupervisor || isAdmin) && (
            <>
              <div className="nav-section">Neuroavaliação</div>
              <Link to="/admin/neuro" className={isActive('/admin/neuro') ? 'active' : ''} title="Personagens Neuro">
                {ICONS.characters}<span>Personagens Neuro</span>
              </Link>
              <Link to="/neuro" className={isActive('/neuro') ? 'active' : ''} title="Neuroavaliação">
                {ICONS.neuro}<span>Neuroavaliação</span>
              </Link>
            </>
          )}

          {(isEvaluator || isAdmin) && (
            <>
              <div className="nav-section">Processo Seletivo</div>
              <Link to="/selecao/dashboard" className={isActive('/selecao/dashboard') ? 'active' : ''} title="Dashboard">
                {ICONS.evaluate}<span>Dashboard</span>
              </Link>
              <Link to="/selecao/logs" className={isActive('/selecao/logs') ? 'active' : ''} title="Logs de avaliações">
                {ICONS.log}<span>Logs de avaliações</span>
              </Link>
            </>
          )}

          {isAdmin && (
            <>
              <div className="nav-section">Administração</div>
              <Link to="/admin/users" className={isActive('/admin/users') ? 'active' : ''} title="Contas">
                {ICONS.supervisor}<span>Contas</span>
              </Link>
              <Link to="/admin/exercises" className={isActive('/admin/exercises') ? 'active' : ''} title="Exercícios da Trilha">
                {ICONS.admin}<span>Exercícios da Trilha</span>
              </Link>
              <Link to="/admin/trilha-logs" className={isActive('/admin/trilha-logs') ? 'active' : ''} title="Logs da Trilha">
                {ICONS.log}<span>Logs da Trilha</span>
              </Link>
              <Link to="/admin/freeplay" className={isActive('/admin/freeplay') ? 'active' : ''} title="Personagens da Simulação">
                {ICONS.characters}<span>Personagens da Simulação</span>
              </Link>
              <Link to="/admin/entrevistador" className={isActive('/admin/entrevistador') ? 'active' : ''} title="Entrevistador">
                {ICONS.supervisor}<span>Entrevistador</span>
              </Link>
              {/* Qual IA avalia e qual interpreta o paciente, por modo do app. */}
              <Link to="/admin/modelos" className={isActive('/admin/modelos') ? 'active' : ''} title="Modelos de IA">
                {ICONS.evaluate}<span>Modelos de IA</span>
              </Link>
              {/* Os .md do avaliador/entrevistador vivem no volume, fora do
                  git — este é o único caminho de edição pela interface. */}
              <Link to="/admin/prompts" className={isActive('/admin/prompts') ? 'active' : ''} title="Prompts">
                {ICONS.log}<span>Prompts</span>
              </Link>
              <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''} title="Todos os Logs">
                {ICONS.log}<span>Todos os Logs</span>
              </Link>
              {/* Erros que os usuários encontraram. Eles só recebem um código;
                  o detalhe (mensagem real, stack, quem, onde) fica aqui. */}
              <Link to="/admin/erros" className={isActive('/admin/erros') ? 'active' : ''} title="Logs de Erro">
                {ICONS.alert}<span>Logs de Erro</span>
              </Link>
            </>
          )}
        </nav>

        <div className="sidebar-user">
          {isVisitor ? (
            <div className="profile-mini" style={{ cursor: 'default' }}>
              <span className="profile-mini-avatar">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
              </span>
              <div className="profile-mini-info">
                <div className="profile-mini-name">Modo visitante</div>
                <div className="profile-mini-role">versão de teste</div>
              </div>
            </div>
          ) : (
            <Link to="/profile" className="profile-mini" title="Editar perfil">
              <span className={`profile-mini-avatar ${streak?.isAlive ? 'with-streak' : ''}`}>
                {user.profilePhoto
                  ? <img src={user.profilePhoto} alt={user.name} />
                  : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
                }
              </span>
              <div className="profile-mini-info">
                <div className="profile-mini-name">{user.name}</div>
                {user.titleLabel && (
                  <div className={`player-title tier-${user.titleTier || 'bronze'}`} style={{ marginTop: 2 }}>
                    {user.titleLabel}
                  </div>
                )}
                <div className="profile-mini-role">
                  {streak?.isAlive
                    ? `${streak.current} ${streak.current === 1 ? 'semana consecutiva' : 'semanas consecutivas'}`
                    : (user.role === 'therapist' ? 'Terapeuta' : user.role === 'external' ? 'Aluno Externo' : user.role === 'supervisor' ? 'Supervisor' : user.role === 'evaluator' ? 'Avaliador' : 'Administrador')}
                </div>
              </div>
            </Link>
          )}
          <button onClick={handleLogout} className="btn btn-ghost btn-sm" title="Sair">
            {ICONS.exit}
          </button>
        </div>
      </aside>

      <main className="main-content">
        {/* Deixa explícito o que a pessoa está usando. Sem isso ela pode achar
            que o app é limitado, quando na verdade só não entrou numa conta.
            Fica no fluxo do conteúdo (e não fixo no topo) porque a sidebar é
            position:fixed — uma faixa fixa exigiria realinhar três breakpoints. */}
        {isVisitor && (
          <div className="visitor-banner">
            <span className="visitor-banner-tag">Modo visitante</span>
            <span className="visitor-banner-text">versão de teste com funcionalidades limitadas</span>
            <Link to={LOGIN_PATH} className="visitor-banner-link">Entrar na minha conta</Link>
          </div>
        )}
        <Routes>
          <Route path="/skills" element={<SkillMap user={user} />} />
          <Route path="/chat/exercise/:id" element={<ChatSession user={user} />} />
          <Route path="/chat/freeplay/:id" element={<EchoSession user={user} sessionType="freeplay" />} />
          <Route path="/chat/neuro/:id" element={<EchoSession user={user} sessionType="neuro" />} />
          {/* Nomes visíveis mudaram (Competitivo → Simulação → Página Inicial,
              Treinamento → Progressão) e as rotas acompanharam. As antigas
              seguem respondendo porque estão em links compartilhados,
              notificações antigas e no histórico do navegador de quem já usa o
              app. A Página Inicial é a antiga Simulação: mesma tela, agora em
              /inicio — a tela de "portas" que ficava aí foi removida. */}
          <Route path="/inicio" element={<Competitive user={user} />} />
          <Route path="/simulacao" element={<Navigate to="/inicio" replace />} />
          <Route path="/competitivo" element={<Navigate to="/inicio" replace />} />
          <Route path="/progressao" element={<FreePlay user={user} />} />
          <Route path="/freeplay" element={<Navigate to="/progressao" replace />} />
          <Route path="/duelo" element={<Duelo user={user} />} />
          <Route path="/duelo/logs" element={<LogsSociais user={user} />} />
          <Route path="/duelo/sessao/:id" element={<DuelSession user={user} />} />
          <Route path="/duelo/aceitar/:id" element={<DuelAccept user={user} />} />
          <Route path="/duelo/convite/:token" element={<DuelAccept user={user} />} />
          {/* Aba de progressão separada morreu há tempos — hoje a progressão é o
              próprio modo (reatender o mesmo paciente). */}
          <Route path="/progression" element={<Navigate to="/progressao" replace />} />
          <Route path="/terapeutas" element={<Terapeutas user={user} />} />
          <Route path="/antessala" element={<Antessala user={user} />} />
          <Route path="/neuro" element={<NeuroEval user={user} />} />
          <Route path="/logs" element={<Logs user={user} userId={user.id} />} />
          <Route path="/supervisor" element={<Logs user={user} />} />
          <Route path="/avaliacao" element={<Avaliacao user={user} />} />
          <Route path="/simulacao-independente" element={<SimulacaoIndependente user={user} />} />
          <Route path="/benchmark-simulacao" element={<BenchmarkSimulacao />} />
          <Route path="/suporte" element={<Suporte user={user} />} />
          <Route path="/profile" element={<Profile user={user} onUpdate={handleUpdateUser} />} />
          <Route path="/missoes" element={<Missoes user={user} />} />
          <Route path="/ranking" element={<Ranking user={user} />} />
          <Route path="/selecao/dashboard" element={<SelecaoDashboard user={user} />} />
          <Route path="/selecao/logs" element={<SelecaoLogs user={user} />} />
          <Route path="/admin/users" element={<AdminUsers user={user} />} />
          <Route path="/admin/exercises" element={<AdminExercises />} />
          <Route path="/admin/trilha-logs" element={<AdminTrilhaLogs />} />
          <Route path="/admin/freeplay" element={<AdminFreeplay />} />
          <Route path="/admin/neuro" element={<AdminNeuro />} />
          <Route path="/admin/entrevistador" element={<AdminEntrevistador user={user} />} />
          <Route path="/admin/modelos" element={<AdminModelos />} />
          <Route path="/admin/prompts" element={<AdminPrompts />} />
          <Route path="/admin/erros" element={<AdminErrorLogs />} />
          <Route path="*" element={<Navigate to={defaultRoute(user)} />} />
        </Routes>
      </main>
    </div>
  );
}

function defaultRoute(user) {
  if (user.role === 'supervisor') return '/supervisor';
  if (user.role === 'admin') return '/admin/users';
  if (user.role === 'evaluator') return '/selecao/dashboard';
  // Aluno e visitante: caem na Página Inicial (/inicio) — a lista de pacientes.
  return '/inicio';
}
