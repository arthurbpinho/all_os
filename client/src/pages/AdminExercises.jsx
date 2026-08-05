import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import PatientPhotoCropper from '../components/PatientPhotoCropper';

const DIFFICULTY_OPTIONS = [
  { value: 'iniciante', label: 'Iniciante' },
  { value: 'intermediario', label: 'Intermediário' },
  { value: 'avancado', label: 'Avançado' },
];

// As opções fixas de modelo do AVALIADOR (por exercício). Espelha
// TRILHA_EXERCISE_MODELS no servidor — mudar lá exige mudar aqui também.
const EVALUATOR_MODEL_OPTIONS = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini (padrão — barato, alto volume)' },
  { value: 'gpt-5.4', label: 'GPT-5.4 (high)' },
  { value: 'glm-5.2', label: 'GLM 5.2 (high)' },
  { value: 'gpt-5.5', label: 'GPT-5.5 (high — melhor qualidade)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (high)' },
];
const EVALUATOR_MODEL_DEFAULT = 'gpt-5.4-mini';

// As opções fixas de modelo do EXERCÍCIO em si (a IA que interpreta o papel —
// paciente, colega etc.). Espelha TRILHA_CHAT_MODELS no servidor. GLM, GPT-5.4
// e Claude Sonnet 5 rodam com raciocínio ligado ("high") — personagem mais
// lento, porém mais nuançado; mini e 5.5 respondem direto, sem "pensar".
const CHAT_MODEL_OPTIONS = [
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini (padrão)' },
  { value: 'gpt-5.4', label: 'GPT-5.4 (high)' },
  { value: 'glm-5.2', label: 'GLM 5.2 (high)' },
  { value: 'gpt-5.5', label: 'GPT-5.5 (melhor qualidade)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (high)' },
];
const CHAT_MODEL_DEFAULT = 'gpt-5.4-mini';

// As 2 opções de modelo do ESQUEMA VISUAL (SVG opcional ao final do
// exercício). Espelha TRILHA_IMAGE_MODELS no servidor. Não é geração de
// imagem "de pixel" — é o modelo escrevendo um SVG, que o navegador renderiza.
const IMAGE_SCHEMA_MODEL_OPTIONS = [
  { value: 'gpt-5.4', label: 'GPT-5.4 (high)' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (high)' },
];
const IMAGE_SCHEMA_MODEL_DEFAULT = 'gpt-5.4';

const DEFAULT_SKILL_COLOR = '#5C8A82';

const EMPTY_FORM = {
  skillId: '',
  title: '',
  description: '',
  difficulty: 'iniciante',
  specificInstruction: '',
  chatModel: CHAT_MODEL_DEFAULT,
  evaluatorPrompt: '',
  evaluatorModel: EVALUATOR_MODEL_DEFAULT,
  imageSchemaEnabled: false,
  imageSchemaPrompt: '',
  imageSchemaModel: IMAGE_SCHEMA_MODEL_DEFAULT,
};

function difficultyLabel(value) {
  const found = DIFFICULTY_OPTIONS.find((d) => d.value === value);
  return found ? found.label : '—';
}

function modelLabel(options, value) {
  const found = options.find((m) => m.value === value);
  return found ? found.label.split(' (')[0] : value;
}

export default function AdminExercises() {
  const [exercises, setExercises] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [showSkillsModal, setShowSkillsModal] = useState(false);
  const [skillsError, setSkillsError] = useState('');
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillColor, setNewSkillColor] = useState(DEFAULT_SKILL_COLOR);
  const [savingSkill, setSavingSkill] = useState(false);
  const skillColorTimers = useRef({});

  const specFileRef = useRef(null);
  const evalFileRef = useRef(null);

  // Avatar da IA do exercício ("a bolinha" no chat) — mesmo esquema da foto de
  // paciente: photoData = { iconDataUrl, fullDataUrl } pendente de salvar;
  // photoCleared = remover; currentPhotoUrl = foto atual ao abrir a edição.
  const [photoData, setPhotoData] = useState(null);
  const [photoCleared, setPhotoCleared] = useState(false);
  const [currentPhotoUrl, setCurrentPhotoUrl] = useState(null);
  function resetPhoto() { setPhotoData(null); setPhotoCleared(false); setCurrentPhotoUrl(null); }

  const skillsById = Object.fromEntries(skills.map((s) => [s.id, s]));

  function load() {
    setLoading(true);
    Promise.all([api.getExercises(), api.getTrilhaSkills()])
      .then(([exList, skillList]) => {
        setExercises(exList || []);
        setSkills(skillList || []);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar exercícios'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  function openCreate() {
    setForm({ ...EMPTY_FORM, skillId: skills[0] ? String(skills[0].id) : '' });
    setEditingId(null);
    setFormError('');
    resetPhoto();
    setShowModal(true);
  }

  function openEdit(exercise) {
    setForm({
      skillId: String(exercise.skillId),
      title: exercise.title || '',
      description: exercise.description || '',
      difficulty: exercise.difficulty || 'iniciante',
      specificInstruction: exercise.specificInstruction || '',
      chatModel: exercise.chatModel || CHAT_MODEL_DEFAULT,
      evaluatorPrompt: exercise.evaluatorPrompt || '',
      evaluatorModel: exercise.evaluatorModel || EVALUATOR_MODEL_DEFAULT,
      imageSchemaEnabled: !!exercise.imageSchemaEnabled,
      imageSchemaPrompt: exercise.imageSchemaPrompt || '',
      imageSchemaModel: exercise.imageSchemaModel || IMAGE_SCHEMA_MODEL_DEFAULT,
    });
    setEditingId(exercise.id);
    setFormError('');
    setPhotoData(null);
    setPhotoCleared(false);
    setCurrentPhotoUrl(exercise.photoIcon || null);
    setShowModal(true);
  }

  function closeModal() {
    setShowModal(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    resetPhoto();
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  }

  // Importa um .md local direto pro campo de prompt (exercício ou avaliador) —
  // lido no navegador, sem passar pelo servidor.
  function handleImportMd(fieldName, file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm((prev) => ({ ...prev, [fieldName]: String(reader.result || '') }));
    reader.readAsText(file);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) return setFormError('O título é obrigatório.');
    if (!form.skillId) return setFormError('Escolha uma competência.');
    setSaving(true);
    setFormError('');
    try {
      const payload = { ...form, skillId: Number(form.skillId) };
      let exerciseId = editingId;
      if (editingId) await api.updateExercise(editingId, payload);
      else { const created = await api.createExercise(payload); exerciseId = created.id; }
      // Avatar vai separado (arquivo no volume), depois que o exercício tem id.
      if (photoData) await api.setExercisePhoto(exerciseId, { icon: photoData.iconDataUrl, full: photoData.fullDataUrl });
      else if (photoCleared) await api.setExercisePhoto(exerciseId, { clear: true });
      closeModal();
      load();
    } catch (err) {
      setFormError(err.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(exercise) {
    if (!window.confirm(`Excluir o exercício "${exercise.title}"?`)) return;
    try {
      await api.deleteExercise(exercise.id);
      load();
    } catch (err) {
      setError(err.message || 'Erro ao excluir');
    }
  }

  // ---- Competências (skills) ----
  function openSkillsModal() {
    setSkillsError('');
    setNewSkillName('');
    setNewSkillColor(DEFAULT_SKILL_COLOR);
    setShowSkillsModal(true);
  }

  function handleSkillNameChange(id, name) {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  }

  async function handleSkillNameBlur(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) { load(); return; }
    try {
      const updated = await api.updateTrilhaSkill(id, { name: trimmed });
      setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
    } catch (err) {
      setSkillsError(err.message || 'Erro ao renomear competência');
      load();
    }
  }

  function handleSkillColorChange(id, color) {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, color } : s)));
    clearTimeout(skillColorTimers.current[id]);
    skillColorTimers.current[id] = setTimeout(async () => {
      try {
        const updated = await api.updateTrilhaSkill(id, { color });
        setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
      } catch (err) {
        setSkillsError(err.message || 'Erro ao recolorir competência');
      }
    }, 400);
  }

  async function handleAddSkill(e) {
    e.preventDefault();
    if (!newSkillName.trim()) return;
    setSavingSkill(true);
    setSkillsError('');
    try {
      const created = await api.createTrilhaSkill({ name: newSkillName.trim(), color: newSkillColor });
      setSkills((prev) => [...prev, created]);
      setNewSkillName('');
      setNewSkillColor(DEFAULT_SKILL_COLOR);
    } catch (err) {
      setSkillsError(err.message || 'Erro ao criar competência');
    } finally {
      setSavingSkill(false);
    }
  }

  async function handleDeleteSkill(skill) {
    if (!window.confirm(`Excluir a competência "${skill.name}"?`)) return;
    setSkillsError('');
    try {
      await api.deleteTrilhaSkill(skill.id);
      setSkills((prev) => prev.filter((s) => s.id !== skill.id));
    } catch (err) {
      setSkillsError(err.message || 'Erro ao excluir competência');
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração</div>
          <h2><Typewriter text="Exercícios da " /><span className="accent"><Typewriter text="Trilha" delayStart={420} /></span></h2>
          <p>Cadastre os exercícios da trilha de prática deliberada. Cada exercício tem o prompt do exercício (o papel que a IA incorpora — nem sempre um paciente) e, opcionalmente, um prompt de avaliador: sem ele, a sessão só finaliza, sem nota.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-outline" onClick={openSkillsModal}>Gerenciar competências</button>
          <button className="btn btn-primary" onClick={openCreate}>+ Novo Exercício</button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : exercises.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--ink-soft)' }}>
          Nenhum exercício cadastrado ainda. Clique em "Novo Exercício" para começar.
        </div>
      ) : (
        <div className="card tight" style={{ padding: 0, overflow: 'auto' }}>
          <table className="admin-table">
            <thead>
              <tr><th>Competência</th><th>Título</th><th>Dificuldade</th><th>IA do exercício</th><th>Avaliador</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {exercises.map((ex) => (
                <tr key={ex.id}>
                  <td><span className="tag-pill">{skillsById[ex.skillId]?.name || `Competência ${ex.skillId}`}</span></td>
                  <td style={{ fontWeight: 500, color: 'var(--marrs-deep)' }}>{ex.title}</td>
                  <td>
                    <span className={`difficulty-pill difficulty-${ex.difficulty || 'iniciante'}`}>
                      {difficultyLabel(ex.difficulty)}
                    </span>
                  </td>
                  <td style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {modelLabel(CHAT_MODEL_OPTIONS, ex.chatModel || CHAT_MODEL_DEFAULT)}
                  </td>
                  <td style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {ex.evaluatorPrompt ? (
                      <span style={{ color: 'var(--marrs-dark)' }}>{modelLabel(EVALUATOR_MODEL_OPTIONS, ex.evaluatorModel || EVALUATOR_MODEL_DEFAULT)}</span>
                    ) : (
                      <em style={{ fontFamily: 'var(--serif-it)' }}>sem avaliador — só finaliza</em>
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
            <h3>{editingId ? 'Editar Exercício' : 'Novo Exercício'}</h3>
            <form className="admin-form" onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 14 }}>
                <div style={{ flex: 2 }}>
                  <label htmlFor="skillId">Competência</label>
                  <select id="skillId" name="skillId" value={form.skillId} onChange={handleChange} required>
                    <option value="" disabled>Selecione…</option>
                    {skills.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
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
                <label style={{ marginBottom: 6, display: 'block' }}>
                  Avatar da IA <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(a bolinha no chat do exercício)</em>
                </label>
                <PatientPhotoCropper
                  currentUrl={photoCleared ? null : currentPhotoUrl}
                  onChange={(d) => { setPhotoData(d); setPhotoCleared(false); }}
                  onClear={() => { setPhotoData(null); setPhotoCleared(true); }}
                />
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
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <label htmlFor="specificInstruction" style={{ margin: 0 }}>Prompt do exercício (papel que a IA incorpora)</label>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => specFileRef.current?.click()}>Importar .md</button>
                  <input
                    ref={specFileRef} type="file" accept=".md,text/markdown" style={{ display: 'none' }}
                    onChange={(e) => { handleImportMd('specificInstruction', e.target.files[0]); e.target.value = ''; }}
                  />
                </div>
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder="Descreva o papel que a IA deve incorporar durante o exercício — um paciente simulado, um colega, uma situação de escrita etc. — e os comportamentos esperados…" style={{ minHeight: 160 }} />
              </div>
              <div>
                <label htmlFor="chatModel">Modelo do exercício (IA que interpreta o papel)</label>
                <select id="chatModel" name="chatModel" value={form.chatModel} onChange={handleChange}>
                  {CHAT_MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <label htmlFor="evaluatorPrompt" style={{ margin: 0 }}>
                    Prompt do avaliador <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em>
                  </label>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => evalFileRef.current?.click()}>Importar .md</button>
                  <input
                    ref={evalFileRef} type="file" accept=".md,text/markdown" style={{ display: 'none' }}
                    onChange={(e) => { handleImportMd('evaluatorPrompt', e.target.files[0]); e.target.value = ''; }}
                  />
                </div>
                <textarea id="evaluatorPrompt" name="evaluatorPrompt" value={form.evaluatorPrompt} onChange={handleChange} placeholder="Como a IA deve avaliar o desempenho neste exercício específico? Defina critérios, escala de notas, o que olhar e o que ignorar. O sistema acrescenta automaticamente a exigência de [NOTA:X] no final." style={{ minHeight: 200 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  {form.evaluatorPrompt.trim()
                    ? <>A nota é uma <strong>porcentagem de 0 a 100</strong> (o aluno passa de fase com <strong>75%</strong>) e é lida automaticamente do formato <code style={{ color: 'var(--marrs-deep)' }}>[NOTA:X]</code> que o avaliador emite no fim — o sistema acrescenta essa exigência ao seu prompt.</>
                    : <><strong>Se vazio, este exercício não terá avaliação</strong> — o aluno só finaliza a sessão (sem nota), e ela conta como concluída na trilha.</>}
                </small>
              </div>
              {form.evaluatorPrompt.trim() && (
                <div>
                  <label htmlFor="evaluatorModel">Modelo do avaliador</label>
                  <select id="evaluatorModel" name="evaluatorModel" value={form.evaluatorModel} onChange={handleChange}>
                    {EVALUATOR_MODEL_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" name="imageSchemaEnabled" checked={form.imageSchemaEnabled} onChange={handleChange} style={{ width: 'auto' }} />
                  <span>Gerar esquema visual ao final do exercício <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(opcional)</em></span>
                </label>
                <small style={{ display: 'block', marginTop: 4, color: 'var(--muted)', fontSize: 12 }}>
                  Ao finalizar, a IA escreve um diagrama (SVG) que sintetiza o exercício, a partir da transcrição. Não é uma foto — é um esquema/diagrama vetorial.
                </small>
              </div>
              {form.imageSchemaEnabled && (
                <>
                  <div>
                    <label htmlFor="imageSchemaPrompt">Observação (o que o esquema deve representar)</label>
                    <textarea
                      id="imageSchemaPrompt" name="imageSchemaPrompt" value={form.imageSchemaPrompt} onChange={handleChange}
                      placeholder="Ex: Desenhe um genograma com as relações familiares mencionadas. Ou: um mapa da queixa principal aos objetivos combinados na sessão."
                      style={{ minHeight: 100 }}
                    />
                  </div>
                  <div>
                    <label htmlFor="imageSchemaModel">Modelo do esquema visual</label>
                    <select id="imageSchemaModel" name="imageSchemaModel" value={form.imageSchemaModel} onChange={handleChange}>
                      {IMAGE_SCHEMA_MODEL_OPTIONS.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              {formError && <div className="alert error">{formError}</div>}
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={closeModal} disabled={saving}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar Alterações' : 'Criar Exercício'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSkillsModal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSkillsModal(false); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Competências da Trilha</h3>
            <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginTop: -8 }}>
              Etiquetas que agrupam os exercícios em "lanes" no mapa da Trilha. Renomeie, recolorir ou exclua (bloqueado enquanto houver exercícios usando a competência).
            </p>
            {skillsError && <div className="alert error">{skillsError}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {skills.map((s) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="color" value={s.color || DEFAULT_SKILL_COLOR}
                    onChange={(e) => handleSkillColorChange(s.id, e.target.value)}
                    style={{ width: 36, height: 32, padding: 0, border: '1px solid var(--line)', borderRadius: 6, flexShrink: 0 }}
                    title="Cor da competência"
                  />
                  <input
                    type="text" value={s.name}
                    onChange={(e) => handleSkillNameChange(s.id, e.target.value)}
                    onBlur={(e) => handleSkillNameBlur(s.id, e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDeleteSkill(s)}>Excluir</button>
                </div>
              ))}
              {skills.length === 0 && (
                <div style={{ color: 'var(--ink-soft)', fontSize: 13 }}>Nenhuma competência cadastrada ainda.</div>
              )}
            </div>
            <form onSubmit={handleAddSkill} style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
              <input
                type="color" value={newSkillColor} onChange={(e) => setNewSkillColor(e.target.value)}
                style={{ width: 36, height: 32, padding: 0, border: '1px solid var(--line)', borderRadius: 6, flexShrink: 0 }}
                title="Cor da nova competência"
              />
              <input
                type="text" value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)}
                placeholder="Nova competência…" style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={savingSkill || !newSkillName.trim()}>
                {savingSkill ? 'Adicionando…' : '+ Adicionar'}
              </button>
            </form>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setShowSkillsModal(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
