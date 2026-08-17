import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

// Administração → Prompts. Edita os .md que vivem no volume persistente
// (avaliador, critérios, sintetizador, entrevistador) direto pelo navegador.
//
// Por que esta tela existe: os prompts saíram do git (são dados sensíveis), e
// com isso o deploy deixou de levá-los — a única forma de atualizá-los em
// produção era um script de linha de comando. Aqui é o mesmo endpoint, com
// interface.
//
// O que o servidor garante em cada gravação (ver server/prompt-files.js):
//   · valida o rascunho no MESMO parser da produção (arquivos com contrato);
//   · guarda a versão anterior, com botão de restaurar.
// Por isso a tela mostra "verificado" e o histórico — as duas travas que
// substituem o que o git dava.

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtSize(n) {
  const v = Number(n) || 0;
  return v >= 1024 ? (v / 1024).toFixed(1).replace('.0', '') + ' KB' : v + ' B';
}
// Nome do arquivo e pasta, para a lista não virar um monte de caminho longo.
function splitPath(p) {
  const i = String(p).lastIndexOf('/');
  return i === -1 ? { dir: '', nome: p } : { dir: p.slice(0, i), nome: p.slice(i + 1) };
}

export default function AdminPrompts() {
  const [files, setFiles] = useState([]);
  const [sel, setSel] = useState('');       // caminho do arquivo aberto
  const [meta, setMeta] = useState(null);   // { updatedAt, validado, versoes }
  const [original, setOriginal] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [carregandoArquivo, setCarregandoArquivo] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');   // sucesso / estado
  const [vendoVersao, setVendoVersao] = useState(null); // id da versão em pré-visualização

  const sujo = draft !== original;

  useEffect(() => {
    api.adminListPrompts()
      .then((r) => setFiles(r.files || []))
      .catch((e) => setErro(e.message || 'Erro ao listar os prompts.'))
      .finally(() => setLoading(false));
  }, []);

  const abrir = useCallback(async (p, { force = false } = {}) => {
    if (!force && sujo && !window.confirm('Há alterações não salvas neste arquivo. Descartar?')) return;
    setCarregandoArquivo(true);
    setErro(''); setAviso(''); setVendoVersao(null);
    try {
      const r = await api.adminGetPrompt(p);
      setSel(p);
      setOriginal(r.content);
      setDraft(r.content);
      setMeta({ updatedAt: r.updatedAt, validado: r.validado, versoes: r.versoes || [] });
    } catch (e) {
      setErro(e.message || 'Erro ao abrir o arquivo.');
    } finally {
      setCarregandoArquivo(false);
    }
  }, [sujo]);

  async function salvar() {
    if (!sel || !sujo || salvando) return;
    setSalvando(true); setErro(''); setAviso('');
    try {
      const r = await api.adminSavePrompt(sel, draft);
      setOriginal(draft);
      setVendoVersao(null);
      setMeta((m) => ({ ...(m || {}), updatedAt: new Date().toISOString(), versoes: r.versoes || (m && m.versoes) || [] }));
      setAviso(r.validado
        ? 'Salvo e verificado — o conteúdo passou no parser que a produção usa. A versão anterior ficou no histórico.'
        : 'Salvo. A versão anterior ficou no histórico.');
      setFiles((fs) => fs.map((f) => (f.path === sel ? { ...f, updatedAt: new Date().toISOString(), size: draft.length } : f)));
    } catch (e) {
      // Erro de validação vem com a mensagem do parser (ex.: qual marcador sumiu).
      setErro(e.message || 'Erro ao salvar.');
    } finally {
      setSalvando(false);
    }
  }

  // Pré-visualiza uma versão antiga no editor, sem gravar: vira um rascunho que
  // o admin pode salvar (aí vale como edição normal) ou descartar.
  async function verVersao(id) {
    setErro(''); setAviso('');
    try {
      const r = await api.adminGetPromptVersion(sel, id);
      setDraft(r.content);
      setVendoVersao(id);
      setAviso('Pré-visualizando uma versão do histórico. Nada foi gravado — use "Salvar" para adotá-la ou "Descartar" para voltar.');
    } catch (e) {
      setErro(e.message || 'Erro ao ler a versão.');
    }
  }

  async function restaurar(id) {
    if (!window.confirm('Restaurar esta versão? A versão atual vai para o histórico antes da troca.')) return;
    setSalvando(true); setErro(''); setAviso('');
    try {
      const r = await api.adminRestorePromptVersion(sel, id);
      setOriginal(r.content);
      setDraft(r.content);
      setVendoVersao(null);
      setMeta((m) => ({ ...(m || {}), updatedAt: new Date().toISOString(), versoes: r.versoes || [] }));
      setAviso('Versão restaurada. A que estava no ar foi para o histórico.');
    } catch (e) {
      setErro(e.message || 'Erro ao restaurar.');
    } finally {
      setSalvando(false);
    }
  }

  function descartar() {
    setDraft(original);
    setVendoVersao(null);
    setErro(''); setAviso('');
  }

  const versoes = (meta && meta.versoes) || [];

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Arquivos de prompt</div>
          <h2><Typewriter text="Pro" /><span className="accent"><Typewriter text="mpts" delayStart={180} /></span></h2>
          <p>
            Os prompts do avaliador e do entrevistador vivem no volume do servidor, fora do repositório —
            editar aqui muda o comportamento <strong>em produção, na hora</strong>. Cada gravação guarda a versão anterior.
          </p>
        </div>
        {sel && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline btn-sm" onClick={descartar} disabled={!sujo || salvando}>Descartar</button>
            <button className="btn btn-primary btn-sm" onClick={salvar} disabled={!sujo || salvando}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        )}
      </div>

      <div className="alert" style={{ background: 'var(--cream-2)', border: '1px solid var(--line)' }}>
        Conteúdo sensível: estes arquivos trazem critérios de nota e referências de correção. Evite abrir esta tela em
        apresentações ou compartilhamento de tela.
      </div>

      {erro && <div className="alert error">{erro}</div>}
      {aviso && <div className="alert success">{aviso}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando os arquivos…</span>
        </div>
      ) : (
        <div className="prompts-layout">
          <div className="card prompts-list">
            <h3 style={{ marginTop: 0 }}>Arquivos</h3>
            {files.length === 0 && <div style={{ color: 'var(--ink-soft)', fontSize: 13 }}>Nenhum .md no volume.</div>}
            {files.map((f) => {
              const { dir, nome } = splitPath(f.path);
              return (
                <button
                  key={f.path}
                  className={`prompts-file ${sel === f.path ? 'active' : ''}`}
                  onClick={() => abrir(f.path)}
                  title={f.path}
                >
                  <span className="prompts-file-name">{nome}</span>
                  {dir && <span className="prompts-file-dir">{dir}</span>}
                  <span className="prompts-file-meta">
                    {fmtSize(f.size)} · {fmtDate(f.updatedAt)}
                    {f.validado && <span className="prompts-badge" title="O servidor confere este arquivo no parser da produção antes de gravar">verificado</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="prompts-editor">
            {!sel ? (
              <div className="card" style={{ color: 'var(--ink-soft)' }}>
                Escolha um arquivo à esquerda para editar.
              </div>
            ) : carregandoArquivo ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <span className="spinner" /> <span style={{ marginLeft: 12 }}>Abrindo…</span>
              </div>
            ) : (
              <>
                <div className="card">
                  <div className="prompts-editor-head">
                    <code style={{ fontSize: 12.5 }}>{sel}</code>
                    <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                      {meta && meta.validado
                        ? 'Gravação verificada: se um marcador ou slot obrigatório sumir, o salvamento é recusado.'
                        : 'Sem contrato automático — este arquivo é gravado como está.'}
                      {sujo && <strong style={{ color: 'var(--marrs, inherit)' }}> · alterações não salvas</strong>}
                      {vendoVersao && <strong> · pré-visualizando versão de {fmtDate(versoes.find((v) => v.id === vendoVersao)?.createdAt)}</strong>}
                    </span>
                  </div>
                  <textarea
                    className="prompts-textarea"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                  />
                </div>

                <div className="card">
                  <h3 style={{ marginTop: 0 }}>Histórico</h3>
                  {versoes.length === 0 ? (
                    <div style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                      Nenhuma versão guardada ainda — a primeira aparece no próximo salvamento.
                    </div>
                  ) : (
                    <div className="prompts-versions">
                      {versoes.map((v) => (
                        <div key={v.id} className="prompts-version">
                          <span>{fmtDate(v.createdAt)} · {fmtSize(v.size)}</span>
                          <span style={{ display: 'flex', gap: 6 }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => verVersao(v.id)} disabled={salvando}>Ver</button>
                            <button className="btn btn-outline btn-sm" onClick={() => restaurar(v.id)} disabled={salvando}>Restaurar</button>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
