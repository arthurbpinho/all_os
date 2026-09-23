// Critérios da régua do avaliador oficial (demandas.md §16.6), dentro de
// Administração → Prompts.
//
// Adicionar e editar sem abrir o .md: o servidor monta o arquivo, valida no
// parser da produção e grava com a versão anterior no histórico, como qualquer
// edição desta tela. O nome identifica o critério — um novo começa sem notas, e
// ao editar é preciso dizer se o histórico fica (as notas antigas seguem na
// média do perfil) ou recomeça.
import { useEffect, useState } from 'react';
import { api } from '../api';

const VAZIO = { nome: '', linhaCurta: '', descricao: '' };

function fmtData(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('pt-BR');
}

export default function AdminCriterios({ onGravado }) {
  const [dados, setDados] = useState(null);
  const [aberto, setAberto] = useState(false);
  const [editando, setEditando] = useState(null); // null | 'novo' | num
  const [form, setForm] = useState(VAZIO);
  const [historico, setHistorico] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [removendo, setRemovendo] = useState(null); // num aguardando confirmação

  useEffect(() => {
    api.adminGetCriterios().then(setDados).catch((e) => setErro(e.message || 'Não foi possível carregar os critérios.'));
  }, []);

  function abrirNovo() {
    setEditando('novo'); setForm(VAZIO); setHistorico(''); setErro(''); setAviso('');
  }

  function abrirEdicao(c) {
    setEditando(c.num);
    setForm({ nome: c.nome, linhaCurta: c.linhaCurta, descricao: c.descricao });
    setHistorico(''); setErro(''); setAviso('');
  }

  async function salvar(e) {
    e.preventDefault();
    setErro(''); setAviso('');
    if (editando !== 'novo' && !historico) { setErro('Escolha o que acontece com o histórico deste critério.'); return; }
    setSalvando(true);
    try {
      const d = editando === 'novo'
        ? await api.adminAddCriterio(form)
        : await api.adminEditCriterio(editando, { ...form, historico });
      setDados(d);
      setAviso(editando === 'novo'
        ? `Critério "${form.nome}" adicionado. Ele começa sem notas e entra nas próximas avaliações.`
        : `Critério "${form.nome}" salvo.`);
      setEditando(null);
      if (onGravado) onGravado();
    } catch (err) {
      setErro(err.message || 'Não foi possível salvar o critério.');
    } finally {
      setSalvando(false);
    }
  }

  // Desativa: o critério sai da régua e das próximas avaliações, mas as notas
  // já dadas continuam no gráfico do perfil (a linha fica no banco com
  // ativo = false). Repor com o mesmo nome traz o histórico de volta.
  async function remover(c) {
    setErro(''); setAviso(''); setSalvando(true);
    try {
      const d = await api.adminRemoveCriterio(c.num);
      setDados(d);
      setAviso(`Critério "${c.nome}" desativado. As notas já dadas continuam no histórico; os próximos atendimentos são avaliados sem ele.`);
      setRemovendo(null);
      if (onGravado) onGravado();
    } catch (err) {
      setErro(err.message || 'Não foi possível desativar o critério.');
    } finally {
      setSalvando(false);
    }
  }

  const criterios = (dados && dados.criterios) || [];
  const cheio = dados && criterios.length >= dados.limites.max;
  const noMinimo = dados && criterios.length <= dados.limites.min;
  const atual = typeof editando === 'number' ? criterios.find((c) => c.num === editando) : null;
  const renomeando = atual && form.nome.trim().toLowerCase() !== atual.nome.toLowerCase();

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0 }}>Critérios da régua</h3>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
            {dados ? `${criterios.length} critérios em ${dados.caminho} · de ${dados.limites.min} a ${dados.limites.max}` : 'Carregando…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setAberto((v) => !v)}>
            {aberto ? 'Recolher' : 'Ver critérios'}
          </button>
          <button
            type="button" className="btn btn-primary btn-sm"
            onClick={() => { setAberto(true); abrirNovo(); }}
            disabled={!dados || cheio || salvando}
            title={cheio ? 'A régua já está no máximo de critérios' : ''}
          >
            Adicionar critério
          </button>
        </div>
      </div>

      {aviso && <div className="alert success" style={{ marginTop: 12 }}>{aviso}</div>}
      {erro && !editando && <div className="alert error" style={{ marginTop: 12 }}>{erro}</div>}

      {aberto && dados && (
        <div style={{ marginTop: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.5, marginTop: 0 }}>
            Cada critério é um nó do avaliador: uma chamada de IA a mais por sessão avaliada. Nenhum prompt deve
            escrever a quantidade de critérios à mão: onde precisar dela, use <code>{'{{N_CRITERIOS}}'}</code>,{' '}
            <code>{'{{N_CRITERIOS_EXTENSO}}'}</code> ou <code>{'{{LISTA_CRITERIOS}}'}</code>, que o código preenche
            com a régua atual.
          </p>
          {dados.avisos && dados.avisos.length > 0 && (
            <div className="alert warn" style={{ fontSize: 13, lineHeight: 1.5 }}>
              <strong>Estes trechos escrevem a quantidade à mão</strong> e ficam errados quando a régua muda. Troque
              pelos slots em Prompts:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {dados.avisos.map((a) => (
                  <li key={`${a.caminho}:${a.linha}`}><code>{a.caminho}</code>, linha {a.linha}: “{a.trecho}”</li>
                ))}
              </ul>
            </div>
          )}

          {editando && (
            <form onSubmit={salvar} className="card" style={{ background: 'var(--cream-2)', marginBottom: 14, display: 'grid', gap: 10 }}>
              <strong>{editando === 'novo' ? 'Novo critério' : `Editar critério ${editando}`}</strong>
              <div>
                <label>Nome</label>
                <input value={form.nome} maxLength={dados.max.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
              </div>
              <div>
                <label>Linha curta</label>
                <input value={form.linhaCurta} maxLength={dados.max.linhaCurta} onChange={(e) => setForm({ ...form, linhaCurta: e.target.value })} placeholder="o que o critério recorta, numa frase" />
              </div>
              <div>
                <label>Descrição (o que o nó lê para avaliar)</label>
                <textarea rows={8} value={form.descricao} maxLength={dados.max.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 13 }} />
              </div>
              {editando !== 'novo' && (
                <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                  <legend style={{ fontSize: 13, padding: '0 6px' }}>E o histórico deste critério?</legend>
                  <label style={{ display: 'flex', gap: 8, fontWeight: 400, alignItems: 'flex-start' }}>
                    <input type="radio" name="historico" style={{ width: 'auto', marginTop: 3 }} checked={historico === 'manter'} onChange={() => setHistorico('manter')} />
                    <span><strong>Manter.</strong> As notas antigas continuam na média do perfil{renomeando ? `, e as dadas como "${atual.nome}" passam a contar como "${form.nome.trim()}"` : ''}. Para ajustes de texto que não mudam o que se mede.</span>
                  </label>
                  <label style={{ display: 'flex', gap: 8, fontWeight: 400, alignItems: 'flex-start', marginTop: 6 }}>
                    <input type="radio" name="historico" style={{ width: 'auto', marginTop: 3 }} checked={historico === 'zerar'} onChange={() => setHistorico('zerar')} />
                    <span><strong>Zerar.</strong> A média do perfil recomeça a partir de agora. Para quando o critério passou a medir outra coisa.</span>
                  </label>
                </fieldset>
              )}
              {erro && <div className="alert error">{erro}</div>}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => { setEditando(null); setErro(''); }} disabled={salvando}>Cancelar</button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar critério'}</button>
              </div>
            </form>
          )}

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <tbody>
              {criterios.map((c) => (
                <tr key={c.num} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 6px', width: 28, color: 'var(--muted)' }}>{c.num}</td>
                  <td style={{ padding: '8px 6px' }}>
                    <div style={{ fontWeight: 600 }}>{c.nome}</div>
                    <div style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{c.linhaCurta}</div>
                    {(c.nomesAnteriores.length > 0 || c.historicoDesde) && (
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {c.nomesAnteriores.length > 0 && `antes: ${c.nomesAnteriores.join(', ')}`}
                        {c.nomesAnteriores.length > 0 && c.historicoDesde && ' · '}
                        {c.historicoDesde && `histórico desde ${fmtData(c.historicoDesde)}`}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {removendo === c.num ? (
                      <>
                        <span style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginRight: 8 }}>
                          Desativar “{c.nome}”?
                        </span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemovendo(null)} disabled={salvando}>Não</button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => remover(c)} disabled={salvando}>
                          {salvando ? 'Desativando…' : 'Sim, desativar'}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => abrirEdicao(c)} disabled={salvando}>Editar</button>
                        <button
                          type="button" className="btn btn-ghost btn-sm"
                          onClick={() => { setRemovendo(c.num); setErro(''); setAviso(''); }}
                          disabled={salvando || noMinimo}
                          title={noMinimo ? `A régua precisa de pelo menos ${dados.limites.min} critérios.` : 'Sai da régua; as notas já dadas continuam no histórico'}
                        >
                          Desativar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
