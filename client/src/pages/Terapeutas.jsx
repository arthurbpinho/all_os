import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function Terapeutas({ user }) {
  const [students, setStudents] = useState([]);
  const [bank, setBank] = useState([]);
  const [selected, setSelected] = useState(null); // therapist object
  const [studentSq, setStudentSq] = useState(null); // { active, completed }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Form do banco de sidequests
  const [showBankForm, setShowBankForm] = useState(false);
  const [sqTitle, setSqTitle] = useState('');
  const [sqDesc, setSqDesc] = useState('');
  const [sqReward, setSqReward] = useState('');
  const [assignChoice, setAssignChoice] = useState('');

  const navigate = useNavigate();

  const loadBase = useCallback(() => {
    setLoading(true);
    Promise.all([api.getMyStudents(), api.getSidequestBank()])
      .then(([studs, bk]) => {
        setStudents(studs || []);
        setBank(bk || []);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar dados.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadBase(); }, [loadBase]);

  const loadStudentSq = useCallback((userId) => {
    setStudentSq(null);
    api.getStudentSidequests(userId)
      .then(setStudentSq)
      .catch((err) => setError(err.message || 'Erro ao carregar sidequests do aluno.'));
  }, []);

  function selectStudent(s) {
    setSelected(s);
    setAssignChoice('');
    setError('');
    loadStudentSq(s.id);
  }

  async function createSidequest(e) {
    e.preventDefault();
    if (!sqTitle.trim() || !sqDesc.trim() || !sqReward.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.createSidequest({ title: sqTitle.trim(), description: sqDesc.trim(), rewardTitle: sqReward.trim() });
      setSqTitle(''); setSqDesc(''); setSqReward('');
      setShowBankForm(false);
      const bk = await api.getSidequestBank();
      setBank(bk || []);
    } catch (err) {
      setError(err.message || 'Erro ao criar sidequest.');
    } finally {
      setBusy(false);
    }
  }

  async function removeSidequest(id) {
    setBusy(true);
    setError('');
    try {
      await api.deleteSidequest(id);
      const bk = await api.getSidequestBank();
      setBank(bk || []);
    } catch (err) {
      setError(err.message || 'Erro ao remover sidequest.');
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!selected || !assignChoice) return;
    setBusy(true);
    setError('');
    try {
      await api.assignSidequest(selected.id, assignChoice);
      setAssignChoice('');
      loadStudentSq(selected.id);
    } catch (err) {
      setError(err.message || 'Erro ao atribuir sidequest.');
    } finally {
      setBusy(false);
    }
  }

  async function unassign() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api.unassignSidequest(selected.id);
      loadStudentSq(selected.id);
    } catch (err) {
      setError(err.message || 'Erro ao remover sidequest ativa.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div className="eyebrow">Acompanhamento</div>
        <h2><Typewriter text="Tera" /><span className="accent"><Typewriter text="peutas" delayStart={160} /></span></h2>
        <p>
          {user?.role === 'admin'
            ? 'Todos os terapeutas da plataforma. Acompanhe logs, supervisão de IA e atribua sidequests.'
            : 'Seus terapeutas vinculados. Acompanhe logs, supervisão de IA e atribua sidequests.'}
        </p>
        <div className="ornament" />
      </div>

      {error && <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>}

      {/* --- Banco de Exercícios --- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Banco de Exercícios</h3>
          <button className="btn btn-outline btn-sm" onClick={() => setShowBankForm((v) => !v)}>
            {showBankForm ? 'Cancelar' : '+ Nova sidequest'}
          </button>
        </div>
        <p className="section-sub" style={{ marginTop: 6 }}>
          Missões clínicas reutilizáveis. Ao atribuir uma a um terapeuta, ela vira o objetivo principal do
          Treinamento dele; ao ser cumprida, ele desbloqueia o título de recompensa.
        </p>

        {showBankForm && (
          <form onSubmit={createSidequest} className="sidequest-form">
            <label>
              <span>Título da sidequest</span>
              <input value={sqTitle} onChange={(e) => setSqTitle(e.target.value)} maxLength={120}
                placeholder="Ex: Sustentar o silêncio" required />
            </label>
            <label>
              <span>Descrição (o que o aluno deve fazer)</span>
              <textarea value={sqDesc} onChange={(e) => setSqDesc(e.target.value)} maxLength={2000} rows={3}
                placeholder="Ex: Em ao menos um momento, sustente um silêncio terapêutico sem preenchê-lo, deixando o paciente elaborar." required />
            </label>
            <label>
              <span>Título de recompensa (subtítulo desbloqueado ao concluir)</span>
              <input value={sqReward} onChange={(e) => setSqReward(e.target.value)} maxLength={120}
                placeholder="Ex: Mestre do Silêncio" required />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Criar</button>
            </div>
          </form>
        )}

        {bank.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', marginTop: 12 }}>Nenhuma sidequest no banco ainda.</p>
        ) : (
          <div className="sidequest-bank-list">
            {bank.map((sq) => (
              <div key={sq.id} className="sidequest-bank-item">
                <div style={{ flex: 1 }}>
                  <div className="sidequest-bank-title">{sq.title}</div>
                  <div className="sidequest-bank-desc">{sq.description}</div>
                  <div className="sidequest-bank-reward">Recompensa: <strong>{sq.rewardTitleLabel}</strong></div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => removeSidequest(sq.id)} disabled={busy}
                  title="Remover do banco" style={{ color: 'var(--terra)' }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- Lista de terapeutas + detalhe --- */}
      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span>
        </div>
      ) : students.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Nenhum terapeuta {user?.role === 'admin' ? 'cadastrado' : 'vinculado a você'} ainda.
        </div>
      ) : (
        <div className="terapeutas-layout">
          <div className="terapeutas-list">
            {students.map((s) => (
              <button
                key={s.id}
                className={`terapeuta-item ${selected?.id === s.id ? 'active' : ''}`}
                onClick={() => selectStudent(s)}
              >
                <span className="terapeuta-avatar">
                  {s.profilePhoto ? <img src={s.profilePhoto} alt={s.name} /> : (s.name || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="terapeuta-name">{s.name || s.username}</span>
              </button>
            ))}
          </div>

          <div className="terapeutas-detail">
            {!selected ? (
              <div className="card" style={{ color: 'var(--ink-soft)' }}>
                Selecione um terapeuta para ver e gerenciar suas sidequests.
              </div>
            ) : (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ margin: 0 }}>{selected.name || selected.username}</h3>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-outline btn-sm" onClick={() => navigate('/supervisor')}>Ver logs</button>
                    <button className="btn btn-outline btn-sm" onClick={() => navigate('/avaliacao')}>Supervisão de IA</button>
                  </div>
                </div>

                <h4 className="section-heading" style={{ marginTop: 18 }}>Exercício ativo</h4>
                {studentSq === null ? (
                  <p style={{ color: 'var(--ink-soft)' }}><span className="spinner" /> Carregando…</p>
                ) : studentSq.active ? (
                  <div className="sidequest-active-card">
                    <div className="sidequest-banner-label">✦ Ativa</div>
                    <div className="sidequest-banner-title">{studentSq.active.title}</div>
                    <div className="sidequest-banner-desc">{studentSq.active.description}</div>
                    <div className="sidequest-bank-reward" style={{ marginTop: 6 }}>
                      Recompensa: <strong>{studentSq.active.rewardTitleLabel}</strong>
                    </div>
                    <div className="sidequest-bank-desc" style={{ marginTop: 6, fontStyle: 'italic' }}>
                      Enquanto esta sidequest estiver ativa, a missão diária do aluno fica pausada — é uma missão por vez.
                    </div>
                    <button className="btn btn-ghost btn-sm" onClick={unassign} disabled={busy}
                      style={{ color: 'var(--terra)', marginTop: 8 }}>Remover sidequest ativa</button>
                  </div>
                ) : (
                  <p style={{ color: 'var(--ink-soft)' }}>
                    Nenhuma sidequest ativa — o aluno está com a <strong>missão diária</strong> no lugar. Atribuir uma
                    sidequest abaixo pausa a missão diária dele.
                  </p>
                )}

                <div className="sidequest-assign-row">
                  <select value={assignChoice} onChange={(e) => setAssignChoice(e.target.value)} disabled={busy || bank.length === 0}>
                    <option value="">{bank.length === 0 ? 'Banco vazio — crie uma sidequest' : 'Escolha uma sidequest…'}</option>
                    {bank.map((sq) => (
                      <option key={sq.id} value={sq.id}>{sq.title}</option>
                    ))}
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={assign} disabled={busy || !assignChoice}>
                    {studentSq?.active ? 'Substituir ativa' : 'Atribuir'}
                  </button>
                </div>

                <h4 className="section-heading" style={{ marginTop: 22 }}>Exercícios concluídos</h4>
                {studentSq && studentSq.completed && studentSq.completed.length > 0 ? (
                  <div className="sidequest-completed-list">
                    {studentSq.completed.map((c, i) => (
                      <div key={i} className="sidequest-completed-item">
                        <div className="sidequest-bank-title">✦ {c.title}</div>
                        <div className="sidequest-bank-reward">
                          Título: <strong>{c.rewardTitleLabel}</strong> · {formatDate(c.completedAt)}
                        </div>
                        {c.justification && <div className="sidequest-bank-desc" style={{ marginTop: 4 }}>{c.justification}</div>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: 'var(--ink-soft)' }}>Nenhuma sidequest concluída ainda.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
