import { useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import SkillMap from './pages/SkillMap';
import FreePlay from './pages/FreePlay';
import NeuroEval from './pages/NeuroEval';
import ChatSession from './pages/ChatSession';
import EchoSession from './pages/EchoSession';
import Logs from './pages/Logs';
import AdminExercises from './pages/AdminExercises';
import AdminFreeplay from './pages/AdminFreeplay';
import AdminNeuro from './pages/AdminNeuro';
import Avaliacao from './pages/Avaliacao'
import Profile from './pages/Profile';

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
};

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('allos_user');
    return saved ? JSON.parse(saved) : null;
  });
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogin = (u) => {
    setUser(u);
    localStorage.setItem('allos_user', JSON.stringify(u));
  };

  const handleUpdateUser = (updated) => {
    setUser(updated);
    localStorage.setItem('allos_user', JSON.stringify(updated));
  };

  const handleLogout = () => {
    setUser(null);
    localStorage.removeItem('allos_user');
    navigate('/login');
  };

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  const isTherapist = user.role === 'therapist';
  const isSupervisor = user.role === 'supervisor';
  const isAdmin = user.role === 'admin';

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h1>all<span className="accent">_OS</span></h1>
          <p>Simulação Clínica</p>
        </div>

        <nav className="sidebar-nav">
          {(isTherapist || isAdmin) && (
            <>
              <div className="nav-section">Prática</div>
              <Link to="/skills" className={isActive('/skills') ? 'active' : ''}>
                {ICONS.skill}<span>Trilha de Skills</span>
              </Link>
              <Link to="/freeplay" className={isActive('/freeplay') ? 'active' : ''}>
                {ICONS.freeplay}<span>FreePlay</span>
              </Link>
              <Link to="/neuro" className={isActive('/neuro') ? 'active' : ''}>
                {ICONS.neuro}<span>Neuroavaliação</span>
              </Link>
            </>
          )}

          {(isTherapist || isSupervisor) && (
            <>
              <div className="nav-section">Histórico</div>
              {isTherapist && (
                <Link to="/logs" className={isActive('/logs') ? 'active' : ''}>
                  {ICONS.log}<span>Meus Logs</span>
                </Link>
              )}
              {isSupervisor && (
                <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''}>
                  {ICONS.supervisor}<span>Logs dos Alunos</span>
                </Link>
              )}
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
              <Link to="/admin/exercises" className={isActive('/admin/exercises') ? 'active' : ''}>
                {ICONS.admin}<span>Fases da Trilha</span>
              </Link>
              <Link to="/admin/freeplay" className={isActive('/admin/freeplay') ? 'active' : ''}>
                {ICONS.characters}<span>Personagens FreePlay</span>
              </Link>
              <Link to="/admin/neuro" className={isActive('/admin/neuro') ? 'active' : ''}>
                {ICONS.characters}<span>Personagens Neuro</span>
              </Link>
              <Link to="/supervisor" className={isActive('/supervisor') ? 'active' : ''}>
                {ICONS.log}<span>Todos os Logs</span>
              </Link>
            </>
          )}
        </nav>

        <div className="sidebar-user">
          <Link to="/profile" className="profile-mini" title="Editar perfil">
            <span className="profile-mini-avatar">
              {user.profilePhoto
                ? <img src={user.profilePhoto} alt={user.name} />
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
              }
            </span>
            <div className="profile-mini-info">
              <div className="profile-mini-name">{user.name}</div>
              <div className="profile-mini-role">{user.role === 'therapist' ? 'Terapeuta' : user.role === 'supervisor' ? 'Supervisor' : 'Administrador'}</div>
            </div>
          </Link>
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
          <Route path="/neuro" element={<NeuroEval user={user} />} />
          <Route path="/logs" element={<Logs user={user} userId={user.id} />} />
          <Route path="/supervisor" element={<Logs user={user} />} />
          <Route path="/avaliacao" element={<Avaliacao user={user} />} />
          <Route path="/profile" element={<Profile user={user} onUpdate={handleUpdateUser} />} />
          <Route path="/admin/exercises" element={<AdminExercises />} />
          <Route path="/admin/freeplay" element={<AdminFreeplay />} />
          <Route path="/admin/neuro" element={<AdminNeuro />} />
          <Route path="*" element={<Navigate to={defaultRoute(user)} />} />
        </Routes>
      </main>
    </div>
  );
}

function defaultRoute(user) {
  if (user.role === 'supervisor') return '/supervisor';
  if (user.role === 'admin') return '/admin/exercises';
  return '/skills';
}
