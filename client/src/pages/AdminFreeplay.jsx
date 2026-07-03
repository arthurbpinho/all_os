import { useState, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { extractBloco1 } from '../utils/bloco1';
import PatientPhotoCropper from '../components/PatientPhotoCropper';
import { patientIconUrl } from '../components/PatientAvatar';

const EMPTY_FORM = { name: '', age: '', description: '', assistantId: '', specificInstruction: '', evaluationCriteria: '' };

export default function AdminFreeplay() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  // Feedback transitório do botão "Copiar Bloco 1" (some sozinho em 1.6s).
  const [copyStatus, setCopyStatus] = useState(''); // '' | 'ok' | 'fail'
  // Foto do paciente (vai pra arquivo no volume, não pro JSON do personagem):
  // photoData = { iconDataUrl, fullDataUrl } pendente; photoCleared = remover;
  // currentPhotoUrl = foto atual mostrada ao abrir a edição.
  const [photoData, setPhotoData] = useState(null);
  const [photoCleared, setPhotoCleared] = useState(false);
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState(null);

  function load() {
    setLoading(true);
    api.getFreeplay()
      .then(setCharacters)
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function resetPhoto() { setPhotoData(null); setPhotoCleared(false); setCurrentPhotoUrl(null); }

  function openCreate() { setForm(EMPTY_FORM); setEditingId(null); setFormError(''); resetPhoto(); setShowModal(true); }

  function openEdit(c) {
    setForm({
      name: c.name || '',
      age: c.age != null ? String(c.age) : '',
      description: c.description || '',
      assistantId: c.assistantId || '',
      specificInstruction: c.specificInstruction || '',
      evaluationCriteria: c.evaluationCriteria || '',
    });
    setEditingId(c.id); setFormError(''); setShowModal(true);
    // Foto atual: a enviada pelo admin (photoIcon) ou a "de fábrica" pelo nome.
    setPhotoData(null); setPhotoCleared(false);
    setCurrentPhotoUrl(c.photoIcon || patientIconUrl(c.name));
  }

  function closeModal() { setShowModal(false); setEditingId(null); setForm(EMPTY_FORM); setFormError(''); resetPhoto(); }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  function generateBloco1() {
    const extracted = extractBloco1(form.specificInstruction);
    if (!extracted) {
      setFormError('Não encontrei "## [II. IDENTIDADE]" no prompt do personagem. O Bloco 1 só pode ser gerado a partir de um prompt com a estrutura padrão (seções II a V).');
      return;
    }
    if (form.evaluationCriteria.trim() && !window.confirm('O critério de correção atual será substituído pelo Bloco 1 extraído do prompt. Continuar?')) {
      return;
    }
    setFormError('');
    setForm((prev) => ({ ...prev, evaluationCriteria: extracted }));
  }

  // Copia o conteúdo atual do Bloco 1 pro clipboard, pra editar em um editor
  // externo. Usa navigator.clipboard (HTTPS/localhost); fallback via textarea
  // temporária + document.execCommand quando a API moderna não tá disponível.
  async function copyBloco1() {
    const text = form.evaluationCriteria || '';
    if (!text.trim()) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand falhou');
      }
      setCopyStatus('ok');
    } catch {
      setCopyStatus('fail');
    }
    setTimeout(() => setCopyStatus(''), 1600);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) return setFormError('O nome é obrigatório.');
    setSaving(true); setFormError('');
    try {
      const payload = { ...form, age: form.age !== '' ? Number(form.age) : null };
      let charId = editingId;
      if (editingId) await api.updateFreeplay(editingId, payload);
      else { const created = await api.createFreeplay(payload); charId = created.id; }
      // Foto vai separada (arquivo no volume), depois que o personagem tem id.
      if (photoData) await api.setFreeplayPhoto(charId, { icon: photoData.iconDataUrl, full: photoData.fullDataUrl });
      else if (photoCleared) await api.setFreeplayPhoto(charId, { clear: true });
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
      await api.deleteFreeplay(c.id);
      load();
    } catch (err) {
      setError(err.message || 'Erro ao excluir');
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Simulação</div>
          <h2><Typewriter text="Personagens da " /><span className="accent"><Typewriter text="Simulação" delayStart={620} /></span></h2>
          <p>Cadastre os pacientes simulados que aparecerão na biblioteca de Simulação para os alunos.</p>
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
        <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr><th>Nome</th><th>Idade</th><th>Dificuldade</th><th>Descrição</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {characters.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>{c.name}</td>
                  <td>{c.age != null ? `${c.age} anos` : '—'}</td>
                  <td title={`Dificuldade do MMR (1–100) · ${c.competitiveMatches || 0} partida(s) competitiva(s)`}>
                    <strong>{Number.isFinite(c.difficulty) ? c.difficulty : '—'}</strong>
                  </td>
                  <td style={{ color: 'var(--ink-soft)', maxWidth: 380 }}>
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
                  <input id="name" name="name" value={form.name} onChange={handleChange} placeholder="Ex: Ana Luiza" required />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="age">Idade</label>
                  <input id="age" name="age" type="number" min="1" max="120" value={form.age} onChange={handleChange} placeholder="34" />
                </div>
              </div>
              <div>
                <label>Foto do paciente <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></label>
                <PatientPhotoCropper
                  currentUrl={photoCleared ? null : currentPhotoUrl}
                  onChange={(d) => { setPhotoData(d); setPhotoCleared(false); }}
                  onClear={() => { setPhotoData(null); setPhotoCleared(true); }}
                />
              </div>
              <div>
                <label htmlFor="description">Descrição visível</label>
                <input id="description" name="description" value={form.description} onChange={handleChange} placeholder="Apresentação curta para o aluno" />
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
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder="História, traços de personalidade, queixa, forma de se expressar… (usado quando não há Assistant ID)" style={{ minHeight: 180 }} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                  <label htmlFor="evaluationCriteria" style={{ marginBottom: 0 }}>
                    Critério de correção <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(gabarito do avaliador)</em>
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {copyStatus === 'ok' && <span style={{ fontSize: 12, color: 'var(--success, #14a37f)' }}>Copiado ✓</span>}
                    {copyStatus === 'fail' && <span style={{ fontSize: 12, color: 'var(--terra)' }}>Falha ao copiar</span>}
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={copyBloco1}
                      disabled={!form.evaluationCriteria.trim()}
                      title="Copia o Bloco 1 atual para a área de transferência (útil para editar em um editor externo)"
                    >
                      Copiar Bloco 1
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={generateBloco1}
                      disabled={!form.specificInstruction.trim()}
                      title="Copia as seções II a V do prompt do personagem para este campo"
                    >
                      Gerar Bloco 1
                    </button>
                  </div>
                </div>
                <textarea id="evaluationCriteria" name="evaluationCriteria" value={form.evaluationCriteria} onChange={handleChange} placeholder="Hipóteses corretas, sintomas que o aluno deve identificar, condutas esperadas, red flags… (não aparece para o aluno; vai apenas para o avaliador junto com o log)" style={{ minHeight: 160 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  Texto descritivo (não imperativo). Enviado ao avaliador como Bloco 1 do caso, junto com o log da sessão. <strong>Gerar Bloco 1</strong> extrai automaticamente as seções II a V do prompt acima.
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
