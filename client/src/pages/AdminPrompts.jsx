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
// Duas formas de trazer conteúdo de fora, para não sobrar nada pro terminal:
//   · "Novo arquivo" cria um .md que ainda não existe no volume (é o caso de uma
//     VERSÃO nova de avaliador, cujos arquivos o deploy não leva);
//   · "Carregar .md" lê um arquivo do computador e joga no editor — vale tanto
//     no arquivo novo quanto na edição de um que já está no ar.
// Em ambos o conteúdo passa pelo editor antes de gravar: o admin vê o que vai
// subir, e a gravação continua sendo a mesma (validação + backup).
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
  // Modo "arquivo novo": o editor da direita vira um formulário de criação, com
  // o caminho em aberto. `null` = desligado.
  const [novo, setNovo] = useState(null); // { path, content }

  const sujo = draft !== original;

  useEffect(() => {
    api.adminListPrompts()
      .then((r) => setFiles(r.files || []))
      .catch((e) => setErro(e.message || 'Erro ao listar os prompts.'))
      .finally(() => setLoading(false));
  }, []);

  const abrir = useCallback(async (p, { force = false } = {}) => {
    if (!force && sujo && !window.confirm('Há alterações não salvas neste arquivo. Descartar?')) return;
    // Sair do formulário de criação pela lista também pede confirmação — o texto
    // que está lá só existe no navegador, nada dele foi gravado ainda.
    if (novo && (novo.path || novo.content) && !window.confirm('Descartar o arquivo novo que você estava montando?')) return;
    setNovo(null);
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
  }, [sujo, novo]);

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

  // Abre o formulário de criação. Sugere como pasta a do arquivo aberto (quem
  // cria o segundo .md de uma versão nova quase sempre quer a mesma pasta).
  function abrirNovo() {
    if (sujo && !window.confirm('Há alterações não salvas neste arquivo. Descartar?')) return;
    const { dir } = sel ? splitPath(sel) : { dir: '' };
    setNovo({ path: dir ? dir + '/' : '', content: '' });
    setSel(''); setMeta(null); setOriginal(''); setDraft('');
    setErro(''); setAviso(''); setVendoVersao(null);
  }

  function fecharNovo() {
    if (novo && (novo.content || novo.path) && !window.confirm('Descartar este arquivo novo?')) return;
    setNovo(null);
    setErro(''); setAviso('');
  }

  // Lê um .md do computador para dentro do editor. Não grava nada: o conteúdo
  // vira rascunho e ainda passa pelo "Salvar"/"Criar" — que é onde o servidor
  // valida. No modo criação, completa o caminho com o nome do arquivo escolhido
  // quando o campo ainda está só com a pasta.
  async function carregarDoDisco(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // permite escolher o MESMO arquivo de novo depois
    if (!file) return;
    setErro(''); setAviso('');
    try {
      const texto = await file.text();
      if (novo) {
        setNovo((n) => ({
          path: !n.path || n.path.endsWith('/') ? (n.path || '') + file.name : n.path,
          content: texto,
        }));
        setAviso(`"${file.name}" carregado no editor. Confira e clique em Criar.`);
      } else {
        setDraft(texto);
        setVendoVersao(null);
        setAviso(`"${file.name}" carregado no editor, ainda NÃO salvo. Confira e clique em Salvar.`);
      }
    } catch {
      setErro('Não consegui ler esse arquivo. Ele precisa ser um .md de texto.');
    }
  }

  // Cria o arquivo no volume. O servidor recusa caminho fora de avaliacao/ e
  // entrevistador/, caminho que já existe (409) e conteúdo que não passa no
  // parser — as mensagens dele são o que aparece aqui.
  async function criar() {
    if (!novo || salvando) return;
    const caminho = novo.path.trim();
    if (!caminho) { setErro('Escreva o caminho do arquivo (ex.: avaliacao/v28/criterios-no-v28.md).'); return; }
    if (!novo.content.trim()) { setErro('O arquivo está vazio — carregue um .md ou cole o conteúdo.'); return; }
    setSalvando(true); setErro(''); setAviso('');
    try {
      const r = await api.adminSavePrompt(caminho, novo.content, { criar: true });
      const lista = await api.adminListPrompts();
      setFiles(lista.files || []);
      setNovo(null);
      setSel(caminho);
      setOriginal(novo.content);
      setDraft(novo.content);
      setMeta({ updatedAt: new Date().toISOString(), validado: r.validado, versoes: r.versoes || [] });
      setAviso(r.validado
        ? 'Arquivo criado e verificado — o conteúdo passou no parser que a produção usa.'
        : 'Arquivo criado. Este caminho não tem contrato automático, então foi gravado como está.');
    } catch (e) {
      setErro(e.message || 'Erro ao criar o arquivo.');
    } finally {
      setSalvando(false);
    }
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
        <div style={{ display: 'flex', gap: 8 }}>
          {!novo && <button className="btn btn-outline btn-sm" onClick={abrirNovo} disabled={salvando}>Novo arquivo</button>}
          {sel && !novo && (
            <>
              <button className="btn btn-outline btn-sm" onClick={descartar} disabled={!sujo || salvando}>Descartar</button>
              <button className="btn btn-primary btn-sm" onClick={salvar} disabled={!sujo || salvando}>
                {salvando ? 'Salvando…' : 'Salvar'}
              </button>
            </>
          )}
        </div>
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
            {novo ? (
              <div className="card">
                <div className="prompts-editor-head">
                  <strong style={{ fontSize: 14 }}>Arquivo novo</strong>
                  <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                    Para levar ao volume um .md que o deploy não carrega — os arquivos de uma versão nova de
                    avaliador, por exemplo. Só dentro de <code>avaliacao/</code> ou <code>entrevistador/</code>,
                    e o caminho tem de ser inédito: se já existir um arquivo ali, a criação é recusada em vez
                    de sobrescrever.
                  </span>
                </div>

                <label htmlFor="novo-path">Caminho no volume</label>
                <input
                  id="novo-path"
                  value={novo.path}
                  onChange={(e) => setNovo((n) => ({ ...n, path: e.target.value }))}
                  placeholder="avaliacao/v28/criterios-no-v28.md"
                  spellCheck={false}
                  style={{ width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}
                />

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
                  <label className="btn btn-outline btn-sm" style={{ margin: 0, cursor: 'pointer' }}>
                    Carregar .md do computador
                    <input type="file" accept=".md,text/markdown,text/plain" onChange={carregarDoDisco} style={{ display: 'none' }} />
                  </label>
                  <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                    ou cole o conteúdo abaixo. Nada é gravado até você clicar em Criar.
                  </span>
                </div>

                <textarea
                  className="prompts-textarea"
                  value={novo.content}
                  onChange={(e) => setNovo((n) => ({ ...n, content: e.target.value }))}
                  placeholder="Conteúdo do .md"
                  spellCheck={false}
                />

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="btn btn-outline btn-sm" onClick={fecharNovo} disabled={salvando}>Cancelar</button>
                  <button className="btn btn-primary btn-sm" onClick={criar} disabled={salvando}>
                    {salvando ? 'Criando…' : 'Criar arquivo'}
                  </button>
                </div>
              </div>
            ) : !sel ? (
              <div className="card" style={{ color: 'var(--ink-soft)' }}>
                Escolha um arquivo à esquerda para editar, ou use <strong>Novo arquivo</strong> para subir um .md
                que ainda não está no volume.
              </div>
            ) : carregandoArquivo ? (
              <div className="card" style={{ textAlign: 'center', padding: 40 }}>
                <span className="spinner" /> <span style={{ marginLeft: 12 }}>Abrindo…</span>
              </div>
            ) : (
              <>
                <div className="card">
                  <div className="prompts-editor-head">
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <code style={{ fontSize: 12.5 }}>{sel}</code>
                      <label className="btn btn-ghost btn-sm" style={{ margin: 0, cursor: 'pointer' }} title="Substitui o texto do editor pelo conteúdo de um .md do computador (não grava — você ainda revisa e salva)">
                        Carregar .md do computador
                        <input type="file" accept=".md,text/markdown,text/plain" onChange={carregarDoDisco} style={{ display: 'none' }} />
                      </label>
                    </div>
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
