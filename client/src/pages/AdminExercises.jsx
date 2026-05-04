import { useState, useEffect } from 'react';
import { api } from '../api';
import { SKILL_NAMES } from '../prompts';
import Typewriter from '../components/Typewriter';

const DIFFICULTY_OPTIONS = [
  { value: 'iniciante', label: 'Iniciante' },
  { value: 'intermediario', label: 'Intermediário' },
  { value: 'avancado', label: 'Avançado' },
];

const EMPTY_FORM = {
  skillId: '1',
  title: '',
  description: '',
  difficulty: 'iniciante',
  specificInstruction: '',
  evaluatorPrompt: '',
};

function difficultyLabel(value) {
  const found = DIFFICULTY_OPTIONS.find((d) => d.value === value);
  return found ? found.label : '—';
}

export default function AdminExercises() {
  const [exercises, setExercises] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  function load() {
    setLoading(true);
    api.getExercises()
      .then(setExercises)
      .catch((err) => setError(err.message || 'Erro ao carregar fases'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError('');
    setShowModal(true);
  }

  function openEdit(exercise) {
    setForm({
      skillId: String(exercise.skillId),
      title: exercise.title || '',
      description: exercise.description || '',
      difficulty: exercise.difficulty || 'iniciante',
      specificInstruction: exercise.specificInstruction || '',
      evaluatorPrompt: exercise.evaluatorPrompt || '',
    });
    setEditingId(exercise.id);
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
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) return setFormError('O título é obrigatório.');
    setSaving(true);
    setFormError('');
    try {
      const payload = { ...form, skillId: Number(form.skillId) };
      if (editingId) await api.updateExercise(editingId, payload);
      else await api.createExercise(payload);
      closeModal();
      load();
    } catch (err) {
      setFormError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(exercise) {
    if (!window.confirm(`Excluir a fase "${exercise.title}"?`)) return;
    try {
      await api.deleteExercise(exercise.id);
      load();
    } catch (err) {
      setError(err.message || 'Erro ao excluir');
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração</div>
          <h2><Typewriter text="Fases da " /><span className="accent"><Typewriter text="Trilha" delayStart={420} /></span></h2>
          <p>Cadastre as fases da trilha de prática deliberada. Cada fase tem dois prompts: o do paciente (personagem da simulação) e o do avaliador (que dá a nota ao final).</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Nova Fase</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : exercises.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhuma fase cadastrada ainda. Clique em "Nova Fase" para começar.
        </div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="admin-table">
            <thead>
              <tr><th>Skill</th><th>Título</th><th>Dificuldade</th><th>Avaliador</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {exercises.map((ex) => (
                <tr key={ex.id}>
                  <td><span className="tag-pill">{SKILL_NAMES[ex.skillId] || `Skill ${ex.skillId}`}</span></td>
                  <td style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>{ex.title}</td>
                  <td>
                    <span className={`difficulty-pill difficulty-${ex.difficulty || 'iniciante'}`}>
                      {difficultyLabel(ex.difficulty)}
                    </span>
                  </td>
                  <td style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {ex.evaluatorPrompt ? (
                      <span style={{ color: 'var(--marrs-dark)' }}>customizado</span>
                    ) : (
                      <em style={{ fontFamily: 'var(--serif-it)' }}>padrão Allos</em>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <button className="btn btn-outline btn-sm" onClick={() => openEdit(ex)}>Editar</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(ex)}>Excluir</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal" style={{ maxWidth: 760 }}>
            <h3>{editingId ? 'Editar Fase' : 'Nova Fase'}</h3>
            <form className="admin-form" onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 2 }}>
                  <label htmlFor="skillId">Competência (Skill)</label>
                  <select id="skillId" name="skillId" value={form.skillId} onChange={handleChange} required>
                    {Object.entries(SKILL_NAMES).map(([sid, name]) => (
                      <option key={sid} value={sid}>{sid}. {name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="difficulty">Dificuldade</label>
                  <select id="difficulty" name="difficulty" value={form.difficulty} onChange={handleChange}>
                    {DIFFICULTY_OPTIONS.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label htmlFor="title">Título</label>
                <input id="title" name="title" type="text" value={form.title} onChange={handleChange} placeholder="Ex: Primeira Sessão com paciente ansioso" required />
              </div>
              <div>
                <label htmlFor="description">Descrição visível ao aluno</label>
                <input id="description" name="description" type="text" value={form.description} onChange={handleChange} placeholder="Frase curta que o aluno vê antes de iniciar" />
              </div>
              <div>
                <label htmlFor="specificInstruction">Prompt do paciente (personagem)</label>
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder="Descreva o personagem, contexto clínico e comportamentos esperados que a IA deve incorporar durante a simulação…" style={{ minHeight: 160 }} />
              </div>
              <div>
                <label htmlFor="evaluatorPrompt">
                  Prompt do avaliador <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em>
                </label>
                <textarea id="evaluatorPrompt" name="evaluatorPrompt" value={form.evaluatorPrompt} onChange={handleChange} placeholder="Como a IA deve avaliar o desempenho nesta fase específica? Defina critérios, escala de notas, o que olhar e o que ignorar. O sistema acrescenta automaticamente a exigência de [NOTA:X] no final." style={{ minHeight: 200 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  Se vazio, usa o avaliador global Allos (10 critérios da prática deliberada). A nota numérica é parseada automaticamente do formato <code style={{ color: 'var(--marrs-deep)' }}>[NOTA:X]</code> que o avaliador deve emitir.
                </small>
              </div>
              {formError && <div className="alert error">{formError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar Alterações' : 'Criar Fase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
