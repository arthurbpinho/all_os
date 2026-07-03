import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

const ROLE_LABELS = {
  admin: 'Administrador',
  supervisor: 'Professor',
  therapist: 'Aluno',
  visitor: 'Visitante',
};

function fbDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function stars(n) {
  const s = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
  return '★'.repeat(s) + '☆'.repeat(5 - s);
}

const EMPTY_FORM = {
  username: '',
  name: '',
  password: '',
  role: 'therapist',
  teacherId: '',
  email: '',
};

export default function AdminUsers({ user: currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState('');
  const [exporting, setExporting] = useState(false);
  // Toggle de avaliação para visitantes (eventos/palestras). Default off.
  const [visitorEval, setVisitorEval] = useState(false);
  const [visitorEvalSaving, setVisitorEvalSaving] = useState(false);
  const [visitorEvalError, setVisitorEvalError] = useState('');
  // Feedback dos usuários (estrelas + mensagem coletadas ao fim das sessões).
  const [feedback, setFeedback] = useState([]);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [feedbackError, setFeedbackError] = useState('');
  // Enviar aviso (notificação) e publicar atualização do sistema.
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeMsg, setNoticeMsg] = useState('');
  const [noticeSending, setNoticeSending] = useState(false);
  const [noticeResult, setNoticeResult] = useState('');
  const [noticeError, setNoticeError] = useState('');
  const [updTitle, setUpdTitle] = useState('');
  const [updBody, setUpdBody] = useState('');
  const [updSending, setUpdSending] = useState(false);
  const [updResult, setUpdResult] = useState('');
  const [updError, setUpdError] = useState('');

  useEffect(() => {
    api.getSettings()
      .then((s) => setVisitorEval(!!s.visitorEvaluationEnabled))
      .catch(() => { /* mantém off se falhar */ });
  }, []);

  async function toggleVisitorEval() {
    if (visitorEvalSaving) return;
    const next = !visitorEval;
    setVisitorEvalSaving(true);
    setVisitorEvalError('');
    try {
      const s = await api.adminUpdateSettings({ visitorEvaluationEnabled: next });
      setVisitorEval(!!s.visitorEvaluationEnabled);
    } catch (err) {
      setVisitorEvalError(err.message || 'Erro ao salvar configuração.');
    } finally {
      setVisitorEvalSaving(false);
    }
  }

  useEffect(() => {
    api.getAdminFeedback()
      .then((list) => setFeedback(Array.isArray(list) ? list : []))
      .catch((err) => setFeedbackError(err.message || 'Erro ao carregar o feedback.'))
      .finally(() => setFeedbackLoading(false));
  }, []);

  async function sendNotice(e) {
    e.preventDefault();
    if (!noticeMsg.trim()) { setNoticeError('Escreva a mensagem do aviso.'); return; }
    setNoticeSending(true); setNoticeError(''); setNoticeResult('');
    try {
      const r = await api.adminSendNotification({ title: noticeTitle.trim(), message: noticeMsg.trim() });
      setNoticeResult(`Aviso enviado para ${r.count} usuário(s).`);
      setNoticeTitle(''); setNoticeMsg('');
      setTimeout(() => setNoticeResult(''), 5000);
    } catch (err) {
      setNoticeError(err.message || 'Erro ao enviar o aviso.');
    } finally {
      setNoticeSending(false);
    }
  }

  async function sendUpdate(e) {
    e.preventDefault();
    if (!updBody.trim()) { setUpdError('Escreva o conteúdo da atualização.'); return; }
    setUpdSending(true); setUpdError(''); setUpdResult('');
    try {
      await api.adminSendUpdate({ title: updTitle.trim(), body: updBody.trim() });
      setUpdResult('Atualização publicada no painel de Atualizações.');
      setUpdTitle(''); setUpdBody('');
      setTimeout(() => setUpdResult(''), 5000);
    } catch (err) {
      setUpdError(err.message || 'Erro ao publicar a atualização.');
    } finally {
      setUpdSending(false);
    }
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setError('');
    try {
      const { blob, filename } = await api.adminExportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Erro ao exportar: ' + err.message);
    } finally {
      setExporting(false);
    }
  }

  function load() {
    setLoading(true);
    api.adminListUsers()
      .then(setUsers)
      .catch((err) => setError(err.message || 'Erro ao carregar usuários'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const teachers = useMemo(() => users.filter((u) => u.role === 'supervisor'), [users]);
  const teacherById = useMemo(() => {
    const m = {};
    for (const t of teachers) m[t.id] = t;
    return m;
  }, [teachers]);

  const filteredUsers = useMemo(() => {
    if (filterRole === 'all') return users;
    return users.filter((u) => u.role === filterRole);
  }, [users, filterRole]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError('');
    setShowModal(true);
  }

  function openEdit(u) {
    setForm({
      username: u.username || '',
      name: u.name || '',
      password: '',
      role: u.role,
      teacherId: u.teacherId || '',
      email: u.email || '',
    });
    setEditingId(u.id);
    setFormError('');
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
  }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => {
      const next = { ...prev, [name]: value };
      // Se mudar role para algo diferente de aluno, limpa teacherId
      if (name === 'role' && value !== 'therapist') next.teacherId = '';
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');

    if (!form.username.trim()) return setFormError('Usuário é obrigatório.');
    if (!form.name.trim()) return setFormError('Nome é obrigatório.');
    if (!editingId && !form.password) return setFormError('Senha é obrigatória.');
    if (form.password && form.password.length < 6) return setFormError('Senha deve ter ao menos 6 caracteres.');
    if (form.role === 'therapist' && !form.teacherId) {
      return setFormError('Aluno precisa estar vinculado a um professor.');
    }

    setSaving(true);
    try {
      const payload = {
        username: form.username.trim(),
        name: form.name.trim(),
        role: form.role,
        teacherId: form.role === 'therapist' ? form.teacherId : null,
        email: form.email.trim(),
      };
      if (form.password) payload.password = form.password;

      if (editingId) await api.adminUpdateUser(editingId, payload);
      else await api.adminCreateUser(payload);
      closeModal();
      load();
    } catch (err) {
      setFormError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(u) {
    if (u.id === currentUser.id) {
      setError('Você não pode excluir a própria conta.');
      return;
    }
    if (!window.confirm(`Excluir ${ROLE_LABELS[u.role]} "${u.name}" (${u.username})?`)) return;
    try {
      await api.adminDeleteUser(u.id);
      load();
    } catch (err) {
      setError(err.message || 'Erro ao excluir');
    }
  }

  function openResetPassword(u) {
    setResetTarget(u);
    setResetPassword('');
    setResetError('');
    setResetSuccess('');
  }
  function closeResetPassword() {
    setResetTarget(null);
    setResetPassword('');
    setResetError('');
    setResetSuccess('');
    setResetSaving(false);
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setResetError('');
    setResetSuccess('');
    if (!resetPassword || resetPassword.length < 6) {
      setResetError('Senha deve ter ao menos 6 caracteres.');
      return;
    }
    setResetSaving(true);
    try {
      await api.adminResetPassword(resetTarget.id, resetPassword);
      setResetSuccess(`Senha redefinida com sucesso para ${resetTarget.username}.`);
      setTimeout(() => closeResetPassword(), 1500);
    } catch (err) {
      setResetError(err.message || 'Erro ao redefinir senha.');
    } finally {
      setResetSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Contas</div>
          <h2>
            <Typewriter text="Gestão de " />
            <span className="accent"><Typewriter text="Contas" delayStart={420} /></span>
          </h2>
          <p>Crie alunos e professores, vincule cada aluno a um professor responsável e gerencie senhas.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-outline"
            onClick={handleExport}
            disabled={exporting}
            title="Baixa um JSON com todos os dados do servidor (users, exercises, freeplay, neuro, logs, progress, achievements, active-sessions). Útil pra backup ou migração."
          >
            {exporting ? 'Baixando…' : 'Exportar dados (backup)'}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>+ Nova Conta</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 620 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Avaliação para visitantes
            <span style={{
              marginLeft: 10, fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
              background: visitorEval ? 'var(--success, #1f8a4c)' : 'var(--sand, #e7e2d8)',
              color: visitorEval ? '#fff' : 'var(--ink-soft)',
            }}>
              {visitorEval ? 'LIGADA' : 'DESLIGADA'}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
            Quando ligada, visitantes recebem avaliação da IA (gpt-5.4, da Simulação Livre) ao
            final da sessão — para demonstrações em palestras/eventos. Desligada no dia a dia.
          </p>
          {visitorEvalError && <div className="alert error" style={{ marginTop: 8, marginBottom: 0 }}>{visitorEvalError}</div>}
        </div>
        <button
          className={`btn ${visitorEval ? 'btn-outline' : 'btn-primary'}`}
          onClick={toggleVisitorEval}
          disabled={visitorEvalSaving}
          title={visitorEval ? 'Desligar avaliação para visitantes' : 'Ligar avaliação para visitantes'}
        >
          {visitorEvalSaving ? 'Salvando…' : (visitorEval ? 'Desligar' : 'Ligar')}
        </button>
      </div>

      {/* Feedback dos usuários — avaliações que os usuários/visitantes deixam ao
          fim da sessão (estrelas + mensagem). É outra coisa que o toggle acima. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 10 }}>
          Feedback dos usuários
          <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--sand)', color: 'var(--ink-soft)' }}>
            {feedback.length}
          </span>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
          Notas (0–5) e mensagens enviadas pelos usuários e visitantes ao final das sessões.
        </p>
        {feedbackError && <div className="alert error" style={{ marginBottom: 0 }}>{feedbackError}</div>}
        {feedbackLoading ? (
          <div style={{ color: 'var(--ink-soft)', fontSize: 14 }}><span className="spinner" /> <span style={{ marginLeft: 10 }}>Carregando…</span></div>
        ) : feedback.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontSize: 14, fontStyle: 'italic' }}>Nenhum feedback recebido ainda.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 380, overflowY: 'auto' }}>
            {feedback.map((f) => (
              <div key={f.id} className="card tight" style={{ padding: '10px 14px', background: 'var(--cream-2)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    {f.stars > 0 && <span style={{ color: '#E8A33C', letterSpacing: 1 }} title={`${f.stars}/5`}>{stars(f.stars)}</span>}
                    <strong style={{ color: 'var(--marrs-deep)' }}>{f.userName || 'Anônimo'}</strong>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{ROLE_LABELS[f.role] || f.role || '—'}</span>
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fbDate(f.timestamp)}</span>
                </div>
                {f.message && <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{f.message}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Enviar aviso (notificação) ou publicar atualização do sistema — os dois
          ícones do topo direito da tela (sino e bloco de notas). */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Enviar aviso ou atualização</div>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
          O <strong>aviso</strong> cai no sino de notificações de todos os usuários. A <strong>atualização</strong> entra
          no painel "Atualizações do sistema" (o bloco de notas ao lado do sino).
        </p>
        <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <form className="admin-form" onSubmit={sendNotice}>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--marrs-deep)' }}>📢 Aviso (notificação)</div>
            <div>
              <label htmlFor="noticeTitle">Título <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
              <input id="noticeTitle" type="text" value={noticeTitle} onChange={(e) => setNoticeTitle(e.target.value)} placeholder="Ex: Manutenção programada" maxLength={120} />
            </div>
            <div>
              <label htmlFor="noticeMsg">Mensagem</label>
              <textarea id="noticeMsg" value={noticeMsg} onChange={(e) => setNoticeMsg(e.target.value)} placeholder="Texto do aviso que aparece na notificação…" maxLength={500} style={{ minHeight: 90 }} />
            </div>
            {noticeError && <div className="alert error">{noticeError}</div>}
            {noticeResult && <div className="alert" style={{ background: 'var(--olive-tint, #eef6ee)', color: 'var(--success, #1A7A6D)' }}>{noticeResult}</div>}
            <div><button type="submit" className="btn btn-primary" disabled={noticeSending}>{noticeSending ? 'Enviando…' : 'Enviar aviso'}</button></div>
          </form>

          <form className="admin-form" onSubmit={sendUpdate}>
            <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--marrs-deep)' }}>📝 Atualização do sistema</div>
            <div>
              <label htmlFor="updTitle">Título <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
              <input id="updTitle" type="text" value={updTitle} onChange={(e) => setUpdTitle(e.target.value)} placeholder="Ex: Novidades da semana" maxLength={120} />
            </div>
            <div>
              <label htmlFor="updBody">Conteúdo</label>
              <textarea id="updBody" value={updBody} onChange={(e) => setUpdBody(e.target.value)} placeholder="Descreva a atualização… (quebras de linha são preservadas)" maxLength={4000} style={{ minHeight: 90 }} />
            </div>
            {updError && <div className="alert error">{updError}</div>}
            {updResult && <div className="alert" style={{ background: 'var(--olive-tint, #eef6ee)', color: 'var(--success, #1A7A6D)' }}>{updResult}</div>}
            <div><button type="submit" className="btn btn-primary" disabled={updSending}>{updSending ? 'Publicando…' : 'Publicar atualização'}</button></div>
          </form>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { v: 'all',        label: `Todos (${users.length})` },
          { v: 'admin',      label: `Administradores (${users.filter(u => u.role === 'admin').length})` },
          { v: 'supervisor', label: `Professores (${users.filter(u => u.role === 'supervisor').length})` },
          { v: 'therapist',  label: `Alunos (${users.filter(u => u.role === 'therapist').length})` },
        ].map((opt) => (
          <button
            key={opt.v}
            className={`btn btn-sm ${filterRole === opt.v ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setFilterRole(opt.v)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma conta nesta categoria.
        </div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Usuário</th>
                <th>Função</th>
                <th>Vínculo</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((u) => {
                const isCurrent = u.id === currentUser.id;
                const teacher = u.teacherId ? teacherById[u.teacherId] : null;
                return (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>
                      {u.name}
                      {isCurrent && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                          (você)
                        </span>
                      )}
                    </td>
                    <td><code>{u.username}</code></td>
                    <td>{ROLE_LABELS[u.role] || u.role}</td>
                    <td style={{ color: 'var(--ink-soft)' }}>
                      {u.role === 'therapist'
                        ? (teacher ? `Professor: ${teacher.name}` : <span style={{ color: 'var(--danger, #c44)' }}>sem professor</span>)
                        : u.role === 'supervisor'
                          ? `${users.filter(s => s.teacherId === u.id).length} aluno(s)`
                          : '—'}
                    </td>
                    <td>
                      <div className="actions">
                        <button className="btn btn-outline btn-sm" onClick={() => openEdit(u)}>Editar</button>
                        <button className="btn btn-outline btn-sm" onClick={() => openResetPassword(u)}>Senha</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u)} disabled={isCurrent}>
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal">
            <h3>{editingId ? 'Editar Conta' : 'Nova Conta'}</h3>
            <form className="admin-form" onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="username">Usuário</label>
                  <input
                    id="username"
                    name="username"
                    value={form.username}
                    onChange={handleChange}
                    placeholder="ex: ana.silva"
                    autoComplete="off"
                    required
                  />
                  <small style={{ display: 'block', marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                    3 a 32 caracteres · letras, números, ponto, _ e -
                  </small>
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="role">Função</label>
                  <select id="role" name="role" value={form.role} onChange={handleChange}>
                    <option value="therapist">Aluno</option>
                    <option value="supervisor">Professor</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="name">Nome completo</label>
                <input
                  id="name"
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  placeholder="Ex: Ana Silva"
                  required
                />
              </div>

              <div>
                <label htmlFor="email">E-mail <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="ana@exemplo.com"
                />
              </div>

              {form.role === 'therapist' && (
                <div>
                  <label htmlFor="teacherId">Professor responsável</label>
                  <select id="teacherId" name="teacherId" value={form.teacherId} onChange={handleChange} required>
                    <option value="">— selecione —</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>{t.name} ({t.username})</option>
                    ))}
                  </select>
                  {teachers.length === 0 && (
                    <small style={{ display: 'block', marginTop: 4, color: 'var(--danger, #c44)', fontSize: 12 }}>
                      Cadastre um professor antes de criar alunos.
                    </small>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="password">
                  {editingId ? 'Nova senha' : 'Senha'}
                  {editingId && <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}> (deixe em branco para manter a atual)</em>}
                </label>
                <input
                  id="password"
                  name="password"
                  type="text"
                  value={form.password}
                  onChange={handleChange}
                  placeholder={editingId ? '••••••' : 'Senha inicial (mínimo 6)'}
                  autoComplete="new-password"
                />
              </div>

              {formError && <div className="alert error">{formError}</div>}

              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar Alterações' : 'Criar Conta'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resetTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeResetPassword(); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Redefinir senha</h3>
            <p style={{ color: 'var(--ink-soft)', marginTop: -8, marginBottom: 16 }}>
              Definir nova senha para <strong>{resetTarget.name}</strong> (<code>{resetTarget.username}</code>).
            </p>
            <form className="admin-form" onSubmit={handleResetPassword}>
              <div>
                <label htmlFor="newPwd">Nova senha</label>
                <input
                  id="newPwd"
                  type="text"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  autoComplete="new-password"
                  autoFocus
                />
              </div>
              {resetError && <div className="alert error">{resetError}</div>}
              {resetSuccess && <div className="alert" style={{ background: 'var(--olive-tint, #efe)', color: 'var(--olive-deep, #363)' }}>{resetSuccess}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeResetPassword} disabled={resetSaving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={resetSaving || !!resetSuccess}>
                  {resetSaving ? 'Salvando…' : 'Redefinir senha'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
