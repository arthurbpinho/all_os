import { useState, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

const EMPTY_FORM = { name: '', age: '', description: '', diagnosis: '', assistantId: '', specificInstruction: '', evaluationCriteria: '' };

export default function AdminNeuro() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  function load() {
    setLoading(true);
    api.getNeuro()
      .then(setCharacters)
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function openCreate() { setForm(EMPTY_FORM); setEditingId(null); setFormError(''); setShowModal(true); }

  function openEdit(c) {
    setForm({
      name: c.name || '',
      age: c.age != null ? String(c.age) : '',
      description: c.description || '',
      diagnosis: c.diagnosis || '',
      assistantId: c.assistantId || '',
      specificInstruction: c.specificInstruction || '',
      evaluationCriteria: c.evaluationCriteria || '',
    });
    setEditingId(c.id); setFormError(''); setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditingId(null); setForm(EMPTY_FORM); setFormError(''); }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setFormError('O nome é obrigatório.');
    setSaving(true); setFormError('');
    try {
      const payload = { ...form, age: form.age !== '' ? Number(form.age) : null };
      if (editingId) await api.updateNeuro(editingId, payload);
      else await api.createNeuro(payload);
      closeModal();
      load();
    } catch (err) {
      setFormError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c) {
    if (!window.confirm(`Excluir o personagem "${c.name}"?`)) return;
    try {
      await api.deleteNeuro(c.id);
      load();
    } catch (err) {
      setError(err.message || 'Erro ao excluir');
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Neuroavaliação</div>
          <h2><Typewriter text="Personagens com " /><span className="accent"><Typewriter text="Diagnóstico" delayStart={620} /></span></h2>
          <p>Cadastre os personagens cujo diagnóstico fica oculto durante a simulação. O campo <em>diagnóstico</em> é interno — não aparece para o aluno.</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ Novo Personagem</button>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : characters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhum personagem cadastrado ainda.
        </div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="admin-table">
            <thead>
              <tr><th>Nome</th><th>Idade</th><th>Diagnóstico (interno)</th><th>Descrição</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {characters.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>{c.name}</td>
                  <td>{c.age != null ? `${c.age} anos` : '—'}</td>
                  <td>{c.diagnosis ? <span className="tag-pill">{c.diagnosis}</span> : '—'}</td>
                  <td style={{ color: 'var(--ink-soft)', maxWidth: 320 }}>
                    <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.description}</span>
                  </td>
                  <td>
                    <div className="actions">
                      <button className="btn btn-outline btn-sm" onClick={() => openEdit(c)}>Editar</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(c)}>Excluir</button>
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
          <div className="modal">
            <h3>{editingId ? 'Editar Personagem' : 'Novo Personagem'}</h3>
            <form className="admin-form" onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 2 }}>
                  <label htmlFor="name">Nome</label>
                  <input id="name" name="name" value={form.name} onChange={handleChange} placeholder="Ex: Roberto Silva" required />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="age">Idade</label>
                  <input id="age" name="age" type="number" min="1" max="120" value={form.age} onChange={handleChange} placeholder="42" />
                </div>
              </div>
              <div>
                <label htmlFor="diagnosis">Diagnóstico interno (oculto do aluno)</label>
                <input id="diagnosis" name="diagnosis" value={form.diagnosis} onChange={handleChange} placeholder="Ex: TDAH tipo combinado" />
              </div>
              <div>
                <label htmlFor="description">Descrição visível</label>
                <input id="description" name="description" value={form.description} onChange={handleChange} placeholder="Apresentação geral que o aluno enxerga" />
              </div>
              <div>
                <label htmlFor="assistantId">OpenAI Assistant ID <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
                <input id="assistantId" name="assistantId" value={form.assistantId} onChange={handleChange} placeholder="asst_xxxxxxxxxxxxxxxxxxxxxxxxxx" />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  Cole apenas o ID começando com <code style={{ color: 'var(--marrs-deep)' }}>asst_</code> (até 64 caracteres). Se vazio, usa a instrução abaixo via chat completion.
                </small>
              </div>
              <div>
                <label htmlFor="specificInstruction">Instrução específica (prompt da IA)</label>
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder="Manifestações clínicas, comportamento, pistas a oferecer e o que esconder… (usado quando não há Assistant ID)" style={{ minHeight: 200 }} />
              </div>
              <div>
                <label htmlFor="evaluationCriteria">Critério de correção <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(gabarito do avaliador)</em></label>
                <textarea id="evaluationCriteria" name="evaluationCriteria" value={form.evaluationCriteria} onChange={handleChange} placeholder="Diagnóstico correto, sintomas-chave que o aluno deve identificar, hipóteses diferenciais aceitáveis, condutas esperadas, red flags… (não aparece para o aluno; vai apenas para o avaliador junto com o log)" style={{ minHeight: 180 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  Texto descritivo (não imperativo). Será enviado ao avaliador como referência para julgar o desempenho do aluno na sessão.
                </small>
              </div>
              {formError && <div className="alert error">{formError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar Alterações' : 'Criar Personagem'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
