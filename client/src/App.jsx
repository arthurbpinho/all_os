import { useState, useEffect } from 'react';
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
import AdminFreeplay from './pages/AdminFreeplay';
import AdminNeuro from './pages/AdminNeuro';
import AdminEntrevistador from './pages/AdminEntrevistador';
import Avaliacao from './pages/Avaliacao'
import Profile from './pages/Profile';
import Missoes from './pages/Missoes';
import Ranking from './pages/Ranking';
import AdminUsers from './pages/AdminUsers';
import Duelo from './pages/Duelo';
import DuelSession from './pages/DuelSession';
import DuelAccept from './pages/DuelAccept';
import LogsSociais from './pages/LogsSociais';
import NotificationBell from './components/NotificationBell';
import { api, getToken, clearAuth, onSessionExpired } from './api';

const ICONS = {
  skill: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" />
      <path d="M7 7l3 3M17 7l-3 3M7 17l3-3M17 17l-3-3" />
    </svg>
  ),
  freeplay: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  neuro: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44A2.5 2.5 0 0 1 2 17.5 2.5 2.5 0 0 1 4.06 15 2.5 2.5 0 0 1 4 13a2.5 2.5 0 0 1 1.02-2A2.5 2.5 0 0 1 7 6.54V4.5A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44A2.5 2.5 0 0 0 22 17.5a2.5 2.5 0 0 0-2.06-2.5A2.5 2.5 0 0 0 20 13a2.5 2.5 0 0 0-1.02-2A2.5 2.5 0 0 0 17 6.54V4.5A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  ),
  log: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
  supervisor: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  evaluate: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  admin: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  characters: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 11h-6M19 8v6" />
    </svg>
  ),
  exit: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
  flame: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  trophy: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M6 4h12v5a6 6 0 0 1-12 0z" />
      <line x1="12" y1="15" x2="12" y2="19" />
      <path d="M8 21h8M9 21a3 3 0 0 1 6 0" />
    </svg>
  ),
  duel: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
      <line x1="13" y1="19" x2="19" y2="13" />
      <line x1="16" y1="16" x2="20" y2="20" />
      <line x1="19" y1="21" x2="21" y2="19" />
      <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
      <line x1="5" y1="14" x2="9" y2="18" />
      <line x1="7" y1="17" x2="4" y2="20" />
      <line x1="3" y1="19" x2="5" y2="21" />
    </svg>
  ),
  social: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
};

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

  // Logout automático se a API sinalizar 401 em qualquer chamada.
  useEffect(() => {
    return onSessionExpired(() => {
      setUser(null);
      navigate('/');
    });
  }, [navigate]);

  useEffect(() => {
    if (!user?.id) { setStreak(null); return; }
    let cancelled = false;
    api.getGamification(user.id)
      .then((data) => { if (!cancelled) setStreak(data?.streak || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, location.pathname]);

  const handleLogin = (u) => {
    setUser(u);
    localStorage.setItem('allos_user', JSON.stringify(u));
  };

  const handleUpdateUser = (updated) => {
    setUser(updated);
    localStorage.setItem('allos_user', JSON.stringify(updated));
  };

  const handleLogout = () => {
    clearAuth();
    setUser(null);
    navigate('/');
  };

  if (!authChecked) {
    return null;
  }
  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  const isTherapist = user.role === 'therapist';
  const isSupervisor = user.role === 'supervisor';
  const isAdmin = user.role === 'admin';
  const isVisitor = user.role === 'visitor';

  return (
    <div className="app-layout">
      {!isVisitor && <NotificationBell user={user} />}
      <header className="mobile-topbar">
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

      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="sidebar-logo">
          <h1>all<span className="accent">_OS</span></h1>
          <p>Simulação Clínica</p>
        </div>

        <nav className="sidebar-nav">
          {(isTherapist || isAdmin || isVisitor) && (
            <>
              <div className="nav-section">Prática</div>
              {/* Trilha de Competências oculta por enquanto — só admin acessa via menu.
                  Será reaberta pra alunos/professores em iteração futura. */}
              {isAdmin && (
                <Link to="/skills" className={isActive('/skills') ? 'active' : ''}>
                  {ICONS.skill}<span>Trilha de Competências</span>
                </Link>
              )}
              <Link to="/freeplay" className={isActive('/freeplay') ? 'active' : ''}>
                {ICONS.freeplay}<span>Simulação</span>
              </Link>
              {/* Competitivo: mesmos personagens da Simulação, mas ranqueado (MMR).
                  Visitante não pontua (id efêmero), então não vê a aba. */}
              {!isVisitor && (
                <Link to="/competitivo" className={isActive('/competitivo') ? 'active' : ''}>
                  {ICONS.trophy}<span>Competitivo</span>
                </Link>
              )}
              {/* Duelo: avaliação comparada entre dois alunos (mesmo paciente).
                  Visitante não inicia duelos (recebe só via link). */}
              {(isTherapist || isAdmin) && (
                <Link to="/duelo" className={isActive('/duelo') ? 'active' : ''}>
                  {ICONS.duel}<span>Duelo</span>
                </Link>
              )}
              {/* Neuroavaliação oculta nesta versão — só admin acessa via menu.
                  Será reaberta pra alunos/professores quando estiver pronta. */}
              {isAdmin && (
                <Link to="/neuro" className={isActive('/neuro') ? 'active' : ''}>
                  {ICONS.neuro}<span>Neuroavaliação</span>
                </Link>
              )}
              {!isVisitor && (
                <Link to="/missoes" className={isActive('/missoes') ? 'active' : ''}>
                  {ICONS.flame}<span>Objetivos</span>
                </Link>
              )}
            </>
          )}

          {(isTherapist || isSupervisor || isVisitor || isAdmin) && (
            <>
              <div className="nav-section">Histórico</div>
              {(isTherapist || isVisitor) && (
                <Link to="/logs" className={isActive('/logs') ? 'active' : ''}>
                  {ICONS.log}<span>Minhas Sessões</span>
                </Link>
              )}
              {(isTherapist || isAdmin) && (
                <Link to="/duelo/logs" className={isActive('/duelo/logs') ? 'active' : ''}>
                  {ICONS.social}<span>Logs Sociais</span>
                </Link>
              )}
              {isSupervisor && (
                <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''}>
                  {ICONS.supervisor}<span>Logs dos Alunos</span>
                </Link>
              )}
            </>
          )}

          {!isVisitor && (
            <>
              <div className="nav-section">Comunidade</div>
              <Link to="/ranking" className={isActive('/ranking') ? 'active' : ''}>
                {ICONS.supervisor}<span>Ranking</span>
              </Link>
            </>
          )}

          {(isSupervisor || isAdmin) && (
            <>
              <div className="nav-section">Avaliação</div>
              <Link to="/avaliacao" className={isActive('/avaliacao') ? 'active' : ''}>
                {ICONS.evaluate}<span>Avaliar Sessão</span>
              </Link>
            </>
          )}

          {isAdmin && (
            <>
              <div className="nav-section">Administração</div>
              <Link to="/admin/users" className={isActive('/admin/users') ? 'active' : ''}>
                {ICONS.supervisor}<span>Contas</span>
              </Link>
              <Link to="/admin/exercises" className={isActive('/admin/exercises') ? 'active' : ''}>
                {ICONS.admin}<span>Exercícios da Trilha</span>
              </Link>
              <Link to="/admin/freeplay" className={isActive('/admin/freeplay') ? 'active' : ''}>
                {ICONS.characters}<span>Personagens da Simulação</span>
              </Link>
              <Link to="/admin/neuro" className={isActive('/admin/neuro') ? 'active' : ''}>
                {ICONS.characters}<span>Personagens Neuro</span>
              </Link>
              <Link to="/admin/entrevistador" className={isActive('/admin/entrevistador') ? 'active' : ''}>
                {ICONS.supervisor}<span>Entrevistador</span>
              </Link>
              <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''}>
                {ICONS.log}<span>Todos os Logs</span>
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
                <div className="profile-mini-name">Visitante</div>
                <div className="profile-mini-role">sessão temporária</div>
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
                    ? `${streak.current} ${streak.current === 1 ? 'dia consecutivo' : 'dias consecutivos'}`
                    : (user.role === 'therapist' ? 'Terapeuta' : user.role === 'supervisor' ? 'Supervisor' : 'Administrador')}
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
        <Routes>
          <Route path="/skills" element={<SkillMap user={user} />} />
          <Route path="/chat/exercise/:id" element={<ChatSession user={user} />} />
          <Route path="/chat/freeplay/:id" element={<EchoSession user={user} sessionType="freeplay" />} />
          <Route path="/chat/neuro/:id" element={<EchoSession user={user} sessionType="neuro" />} />
          <Route path="/freeplay" element={<FreePlay user={user} />} />
          <Route path="/competitivo" element={<Competitive user={user} />} />
          <Route path="/duelo" element={<Duelo user={user} />} />
          <Route path="/duelo/logs" element={<LogsSociais user={user} />} />
          <Route path="/duelo/sessao/:id" element={<DuelSession user={user} />} />
          <Route path="/duelo/aceitar/:id" element={<DuelAccept user={user} />} />
          <Route path="/duelo/convite/:token" element={<DuelAccept user={user} />} />
          <Route path="/neuro" element={<NeuroEval user={user} />} />
          <Route path="/logs" element={<Logs user={user} userId={user.id} />} />
          <Route path="/supervisor" element={<Logs user={user} />} />
          <Route path="/avaliacao" element={<Avaliacao user={user} />} />
          <Route path="/profile" element={<Profile user={user} onUpdate={handleUpdateUser} />} />
          <Route path="/missoes" element={<Missoes user={user} />} />
          <Route path="/ranking" element={<Ranking user={user} />} />
          <Route path="/admin/users" element={<AdminUsers user={user} />} />
          <Route path="/admin/exercises" element={<AdminExercises />} />
          <Route path="/admin/freeplay" element={<AdminFreeplay />} />
          <Route path="/admin/neuro" element={<AdminNeuro />} />
          <Route path="/admin/entrevistador" element={<AdminEntrevistador user={user} />} />
          <Route path="*" element={<Navigate to={defaultRoute(user)} />} />
        </Routes>
      </main>
    </div>
  );
}

function defaultRoute(user) {
  if (user.role === 'supervisor') return '/supervisor';
  if (user.role === 'admin') return '/admin/users';
  // Aluno e visitante: caem direto na Simulação (Trilha está oculta nesta versão).
  return '/freeplay';
}
