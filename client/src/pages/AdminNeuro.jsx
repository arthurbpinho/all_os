import { useState, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import { extractBloco1, extractApendice } from '../utils/bloco1';
import NeuroTestSelector from '../components/NeuroTestSelector';

const EMPTY_FORM = { name: '', age: '', description: '', diagnosis: '', assistantId: '', specificInstruction: '', evaluationCriteria: '', evaluationAppendix: '', recommendedTests: [], testResults: {} };

export default function AdminNeuro() {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [testCatalog, setTestCatalog] = useState([]);

  function load() {
    setLoading(true);
    api.getNeuro()
      .then(setCharacters)
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // Catálogo de testes neuropsicológicos (fixo, cacheado no client).
  useEffect(() => {
    api.getNeuroTests()
      .then((cat) => setTestCatalog(Array.isArray(cat) ? cat : []))
      .catch(() => { /* silencioso — a seção de testes só fica indisponível */ });
  }, []);

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
      evaluationAppendix: c.evaluationAppendix || '',
      recommendedTests: Array.isArray(c.recommendedTests) ? c.recommendedTests : [],
      testResults: c.testResults && typeof c.testResults === 'object' ? { ...c.testResults } : {},
    });
    setEditingId(c.id); setFormError(''); setShowModal(true);
  }

  // Seleção de testes recomendados (gabarito). Ao desmarcar um teste, descarta o
  // resultado associado pra não sobrar resultado órfão no payload.
  function handleTestsChange(ids) {
    setForm((prev) => {
      const keep = new Set(ids);
      const testResults = {};
      for (const [k, v] of Object.entries(prev.testResults || {})) {
        if (keep.has(k)) testResults[k] = v;
      }
      return { ...prev, recommendedTests: ids, testResults };
    });
  }

  function handleTestResultChange(testId, value) {
    setForm((prev) => ({ ...prev, testResults: { ...prev.testResults, [testId]: value } }));
  }

  function closeModal() { setShowModal(false); setEditingId(null); setForm(EMPTY_FORM); setFormError(''); }

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  // Extrai, do prompt do personagem, o Bloco 1 (seções II–V) e o Apêndice
  // (seção "## Apêndice"), preenchendo os dois campos de gabarito de uma vez.
  function generateBloco1() {
    const bloco = extractBloco1(form.specificInstruction);
    const apendice = extractApendice(form.specificInstruction);
    if (!bloco && !apendice) {
      setFormError('Não encontrei "## [II. IDENTIDADE]" nem "## Apêndice" no prompt. O Bloco 1 (seções II–V) e o Apêndice são extraídos de um prompt de neuro no formato padrão (persona I–V + "## Apêndice").');
      return;
    }
    const willReplace = (bloco && form.evaluationCriteria.trim()) || (apendice && form.evaluationAppendix.trim());
    if (willReplace && !window.confirm('O Bloco 1 e/ou o Apêndice atuais serão substituídos pelo que foi extraído do prompt. Continuar?')) {
      return;
    }
    setFormError('');
    setForm((prev) => ({
      ...prev,
      evaluationCriteria: bloco || prev.evaluationCriteria,
      evaluationAppendix: apendice || prev.evaluationAppendix,
    }));
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
          <p>Exercício de <strong>anamnese neuropsicológica de sessão única</strong>: o aluno acolhe, entrevista, formula a hipótese diagnóstica e indica os testes. O prompt tem a <strong>persona (I–V)</strong> que o paciente encarna e um <strong>“## Apêndice”</strong> (gabarito). O gabarito do avaliador é <strong>Bloco 1 + Apêndice</strong> — tudo interno, oculto do aluno.</p>
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
                <label htmlFor="specificInstruction">Prompt do personagem (persona + apêndice)</label>
                <textarea id="specificInstruction" name="specificInstruction" value={form.specificInstruction} onChange={handleChange} placeholder={'Prompt de neuro no formato padrão: sessão única de anamnese.\n\n[I. CONTENÇÃO] · [II. IDENTIDADE] · [III. VOZ E COMPORTAMENTO] · [IV. ARCO DA SESSÃO] · [V. ABERTURA E FATOS DA VIDA]\n\n## Apêndice — referência para quem desenha a avaliação (fora do personagem)\nHipótese diagnóstica esperada, diferenciais, bateria sugerida, racional clínico…'} style={{ minHeight: 240 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  Cole o prompt completo. A <strong>persona (seções I–V)</strong> é o que o paciente encarna no chat. A seção <strong>“## Apêndice”</strong> é o gabarito para o avaliador e é <strong>removida automaticamente</strong> do prompt do paciente — não vaza para a simulação.
                </small>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                  <label htmlFor="evaluationCriteria" style={{ marginBottom: 0 }}>
                    Bloco 1 — estrutura do caso <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(gabarito do avaliador)</em>
                  </label>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={generateBloco1}
                    disabled={!form.specificInstruction.trim()}
                    title="Extrai as seções II–V (Bloco 1) e a seção Apêndice do prompt acima"
                  >
                    Gerar Bloco 1 + Apêndice
                  </button>
                </div>
                <textarea id="evaluationCriteria" name="evaluationCriteria" value={form.evaluationCriteria} onChange={handleChange} placeholder="Seções II–V do prompt: quem é o paciente, sintomatologia, camadas da anamnese, voz e comportamento. (Não aparece para o aluno; vai ao avaliador junto com o log.)" style={{ minHeight: 160 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  As seções <strong>II–V</strong> do prompt (a estrutura do caso). <strong>Gerar Bloco 1 + Apêndice</strong> preenche este campo e o Apêndice abaixo de uma vez.
                </small>
              </div>

              <div>
                <label htmlFor="evaluationAppendix">
                  Apêndice — gabarito neuropsicológico <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(fora do personagem)</em>
                </label>
                <textarea id="evaluationAppendix" name="evaluationAppendix" value={form.evaluationAppendix} onChange={handleChange} placeholder="Hipótese diagnóstica esperada, diagnósticos diferenciais a descartar, bateria de testes sugerida e racional clínico. (Seção “## Apêndice” do prompt.)" style={{ minHeight: 160 }} />
                <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
                  A seção <strong>“## Apêndice”</strong> do prompt — o gabarito de diagnóstico e conduta. Vai ao avaliador <strong>junto do Bloco 1</strong> (Bloco 1 + Apêndice), nunca ao aluno nem ao paciente.
                </small>
              </div>

              <div className="neuro-tests-admin">
                <label style={{ marginBottom: 4 }}>
                  Testes neuropsicológicos recomendados <em style={{ color: 'var(--muted)', fontStyle: 'italic' }}>(gabarito — oculto do aluno)</em>
                </label>
                <small style={{ display: 'block', marginBottom: 10, color: 'var(--muted)', fontSize: 12 }}>
                  Marque a bateria que o aluno deveria aplicar e preencha o resultado de cada teste. O aluno só vê isso depois de comitar a própria seleção. A adequação da bateria escolhida entra no cálculo da nota.
                </small>
                {testCatalog.length === 0 ? (
                  <div className="alert" style={{ fontSize: 13 }}>Catálogo de testes indisponível no momento.</div>
                ) : (
                  <NeuroTestSelector
                    catalog={testCatalog}
                    selected={form.recommendedTests}
                    onChange={handleTestsChange}
                    renderResult={(t) => (
                      <input
                        type="text"
                        value={form.testResults[t.id] || ''}
                        onChange={(e) => handleTestResultChange(t.id, e.target.value)}
                        placeholder={`Resultado de ${t.abbr} (ex: Escore 22, moderado)`}
                      />
                    )}
                  />
                )}
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
