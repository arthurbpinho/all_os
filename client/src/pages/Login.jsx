import { useState } from 'react';
import { api } from '../api';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await api.login(username, password);
      onLogin(user);
    } catch (err) {
      setError(err.message || 'Credenciais inválidas');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-eyebrow">Associação Allos</div>
        <h1>all<span className="accent">_OS</span></h1>
        <p className="subtitle">o sistema operacional da prática deliberada</p>
        <div className="login-ornament" />

        <form onSubmit={handleSubmit}>
          <div>
            <label htmlFor="username">Usuário</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="seu usuário"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="sua senha"
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div className="alert error">{error}</div>}

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        <div className="credentials">
          <div className="label">Credenciais de teste</div>
          <p><code>aluno</code> / <code>aluno123</code> · Terapeuta</p>
          <p><code>supervisor</code> / <code>super123</code> · Supervisor</p>
          <p><code>admin</code> / <code>admin123</code> · Administrador</p>
        </div>
      </div>
    </div>
  );
}
