// Administração → Acessos: quem pode usar o quê (demandas.md §16.2).
//
// O catálogo de funcionalidades vem do SERVIDOR (server/acessos.js): esta tela
// não conhece nenhuma pelo nome, então uma funcionalidade nova aparece aqui sem
// mexer no cliente.
import { useEffect, useState } from 'react';
import { api } from '../api';

export default function AdminAcessos() {
  const [dados, setDados] = useState(null);
  const [matriz, setMatriz] = useState({});
  const [mensagem, setMensagem] = useState('');
  const [modos, setModos] = useState([]);
  // Pesos do TRI como TEXTO no formulário; o servidor é quem converte e saneia.
  const [pesos, setPesos] = useState({});
  // Terapeuta externo: modelo de IA e limite semanal. Os limites ficam como
  // texto no formulário ('' = sem limite) e viram número ao salvar.
  const [limites, setLimites] = useState({ modeloPaciente: '', modeloAvaliador: '', limiteUsd: '', limiteTokens: '' });
  const [uso, setUso] = useState(null);

  function aplicarLimites(l) {
    setLimites({
      modeloPaciente: (l && l.modeloPaciente) || '',
      modeloAvaliador: (l && l.modeloAvaliador) || '',
      limiteUsd: l && l.limiteUsd != null ? String(l.limiteUsd) : '',
      limiteTokens: l && l.limiteTokens != null ? String(l.limiteTokens) : '',
    });
  }

  function mudarLimite(campo, valor) {
    setOk('');
    setLimites((l) => ({ ...l, [campo]: valor }));
  }

  useEffect(() => {
    api.adminGetUsoIa().then(setUso).catch(() => setUso(null));
  }, []);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    api.adminGetAcessos()
      .then((d) => { setDados(d); setMatriz(d.matriz); setMensagem(d.mensagemCadeado || ''); setModos(d.modosPerfilCriterios || []); aplicarPesos(d.pesosTri); aplicarLimites(d.limitesExterno); })
      .catch((e) => setErro(e.message || 'Erro ao carregar os acessos.'));
  }, []);

  function aplicarPesos(p) {
    setPesos(Object.fromEntries(Object.entries(p || {}).map(([k, v]) => [k, String(v)])));
  }

  function alternar(chave, perfil) {
    setOk('');
    setMatriz((m) => ({ ...m, [chave]: { ...m[chave], [perfil]: !m[chave][perfil] } }));
  }

  async function salvar() {
    setSalvando(true); setErro(''); setOk('');
    try {
      const d = await api.adminSaveAcessos({
        matriz, mensagemCadeado: mensagem, modosPerfilCriterios: modos,
        // Manda o TEXTO: campo vazio tem de virar "usa o padrão", e Number('')
        // seria 0 — que aqui quer dizer "desligado". Quem sabe a diferença é o
        // normalizador do servidor. A troca de vírgula por ponto é defensiva:
        // <input type="number"> devolve '' para "0,5" na maioria dos
        // navegadores, mas alguns entregam a vírgula crua.
        pesosTri: Object.fromEntries(
          Object.entries(pesos).map(([k, v]) => [k, String(v).replace(',', '.')]),
        ),
        limitesExterno: {
          modeloPaciente: limites.modeloPaciente,
          modeloAvaliador: limites.modeloAvaliador,
          limiteUsd: limites.limiteUsd.trim() ? Number(limites.limiteUsd.replace(',', '.')) : null,
          limiteTokens: limites.limiteTokens.trim() ? Number(limites.limiteTokens.replace(/\D/g, '')) : null,
        },
      });
      setDados(d); setMatriz(d.matriz); setMensagem(d.mensagemCadeado || ''); setModos(d.modosPerfilCriterios || []);
      aplicarPesos(d.pesosTri);
      aplicarLimites(d.limitesExterno);
      api.adminGetUsoIa().then(setUso).catch(() => {});
      setOk('Acessos salvos. Valem na próxima vez que cada pessoa abrir o app.');
    } catch (e) {
      setErro(e.message || 'Erro ao salvar.');
    } finally {
      setSalvando(false);
    }
  }

  if (!dados) {
    return <div className="admin-page">{erro ? <div className="alert error">{erro}</div> : <p>Carregando…</p>}</div>;
  }

  return (
    <div className="admin-page">
      <div className="page-header">
        <div className="eyebrow">Administração</div>
        <h2>Acessos</h2>
      </div>

      <div className="alert warn" style={{ marginBottom: 18, lineHeight: 1.55 }}>
        <strong>Isto não é um ajuste visual.</strong> Desmarcar uma caixa desliga a funcionalidade de verdade
        para aquele perfil: o item fica com um cadeado no menu e o servidor recusa o acesso mesmo que a pessoa
        digite o endereço. Marcar uma caixa não abre o que o perfil já não alcançava (as telas em desenvolvimento
        continuam só do admin, e o visitante continua só com o duelo pelo link). Administradores, supervisores e
        avaliadores não aparecem aqui: o acesso deles vem do papel.
      </div>

      <div className="card">
        <h3 className="card-title">Quem pode usar o quê</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 6px' }}>Funcionalidade</th>
                {dados.perfis.map((p) => (
                  <th key={p.key} style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dados.funcionalidades.map((f) => (
                <tr key={f.key} style={{ borderTop: '1px solid var(--line, #e5e1d8)' }}>
                  <td style={{ padding: '10px 6px' }}>
                    <div style={{ fontWeight: 600 }}>{f.label}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.45 }}>{f.descricao}</div>
                  </td>
                  {dados.perfis.map((p) => (
                    <td key={p.key} style={{ textAlign: 'center', padding: '10px 6px' }}>
                      <input
                        type="checkbox"
                        checked={!!(matriz[f.key] && matriz[f.key][p.key])}
                        onChange={() => alternar(f.key, p.key)}
                        aria-label={`${f.label} para ${p.label}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Mensagem do cadeado</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          A mesma para todas as funcionalidades bloqueadas. Em branco, vale o texto padrão:
          <em> {dados.mensagemPadrao}</em>
        </p>
        <textarea rows={3} maxLength={600} value={mensagem} onChange={(e) => { setMensagem(e.target.value); setOk(''); }} />
      </div>

      <div className="card">
        <h3 className="card-title">Terapeuta externo: modelo de IA e limite semanal</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.5 }}>
          O limite vale para os últimos 7 dias corridos (janela deslizante): o que foi usado há mais de 7 dias
          sai da conta sozinho. Estourou, o aluno externo não atende nem recebe avaliação até voltar a caber, e
          os administradores recebem um aviso no sino. Em branco = sem limite. Se preencher os dois, vale o que
          chegar primeiro.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 14 }}>
          <div>
            <label>Paciente simulado</label>
            <select value={limites.modeloPaciente} onChange={(e) => mudarLimite('modeloPaciente', e.target.value)}>
              <option value="">Padrão da categoria (Modelos de IA)</option>
              {(dados.opcoesPaciente || []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label>Avaliador</label>
            <select value={limites.modeloAvaliador} onChange={(e) => mudarLimite('modeloAvaliador', e.target.value)}>
              <option value="">Padrão da categoria (Modelos de IA)</option>
              {(dados.opcoesAvaliador || []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label>Limite em dólares (US$ por 7 dias)</label>
            <input inputMode="decimal" placeholder="sem limite" value={limites.limiteUsd} onChange={(e) => mudarLimite('limiteUsd', e.target.value)} />
          </div>
          <div>
            <label>Limite em tokens (por 7 dias)</label>
            <input inputMode="numeric" placeholder="sem limite" value={limites.limiteTokens} onChange={(e) => mudarLimite('limiteTokens', e.target.value)} />
          </div>
        </div>

        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>
            Quantos tokens {dados.limitesExterno && dados.limitesExterno.limiteUsd ? `US$ ${dados.limitesExterno.limiteUsd}` : 'US$ 1'} compra em cada modelo
          </summary>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '8px 0' }}>
            Uma sessão mistura entrada (o histórico reenviado a cada turno, boa parte em cache e mais barata) e saída.
            Os números abaixo são os extremos: tudo entrada ou tudo saída.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr><th style={{ textAlign: 'left', padding: 6 }}>Modelo</th><th style={{ padding: 6 }}>US$/1M entrada · saída</th><th style={{ padding: 6 }}>Só entrada</th><th style={{ padding: 6 }}>Só saída</th></tr>
              </thead>
              <tbody>
                {(dados.equivalencias || []).map((e) => (
                  <tr key={e.key} style={{ borderTop: '1px solid var(--line, #e5e1d8)' }}>
                    <td style={{ padding: 6 }}>{e.label}</td>
                    <td style={{ padding: 6, textAlign: 'center' }}>{e.precoPorMTok ? `${e.precoPorMTok.entrada} · ${e.precoPorMTok.saida}` : 'sem preço'}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{e.tokensEntrada != null ? e.tokensEntrada.toLocaleString('pt-BR') : '—'}</td>
                    <td style={{ padding: 6, textAlign: 'right' }}>{e.tokensSaida != null ? e.tokensSaida.toLocaleString('pt-BR') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {uso && uso.contas && uso.contas.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13.5 }}>Uso dos terapeutas externos nos últimos 7 dias</summary>
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr><th style={{ textAlign: 'left', padding: 6 }}>Conta</th><th style={{ padding: 6 }}>US$</th><th style={{ padding: 6 }}>Tokens</th><th style={{ padding: 6 }}>Situação</th></tr>
                </thead>
                <tbody>
                  {uso.contas.map((c) => (
                    <tr key={c.userId} style={{ borderTop: '1px solid var(--line, #e5e1d8)' }}>
                      <td style={{ padding: 6 }}>{c.name} <span style={{ color: 'var(--muted)' }}>@{c.username}</span></td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.usd.toFixed(2)}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.tokens.toLocaleString('pt-BR')}</td>
                      <td style={{ padding: 6, textAlign: 'center', color: c.excedido ? 'var(--terra)' : 'var(--ink-soft)' }}>
                        {c.excedido ? 'no limite' : 'ok'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">Gráfico de critérios do perfil</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          Quais sessões entram na média de cada critério. Os critérios são somados pelo nome, então vale
          juntar só modos que usam a mesma régua.
        </p>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {(dados.modosCriterios || []).map((m) => (
            <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={modos.includes(m.key)}
                onChange={() => { setOk(''); setModos((l) => (l.includes(m.key) ? l.filter((x) => x !== m.key) : [...l, m.key])); }}
              />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Influência no TRI (dificuldade dos pacientes)</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          A dificuldade de cada paciente é medida a partir das notas obtidas. Um atendimento de
          aluno cadastrado vale <strong>1</strong>. Quem não tem conta (candidato do Processo
          Seletivo, visitante) entra com um peso menor, porque o que se conhece é o nível médio do
          grupo, e não o daquela pessoa — e porque o Seletivo tem muito mais volume e afogaria o
          sinal do Competitivo. <strong>0 desliga</strong> a influência daquela população.
        </p>
        <div style={{ display: 'grid', gap: 14 }}>
          {(dados.poolsTri || []).map((pool) => {
            const valor = pesos[pool.key] ?? '';
            const num = Number(String(valor).replace(',', '.'));
            const desligado = Number.isFinite(num) && num === 0;
            const inativo = pool.key === 'visitante' && !dados.visitanteTriLigado;
            return (
              <div key={pool.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 170 }}>
                  <label htmlFor={`peso-${pool.key}`} style={{ fontWeight: 600 }}>{pool.label}</label>
                  {inativo && (
                    <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                      sem efeito hoje: a avaliação de visitante não está ligada
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    id={`peso-${pool.key}`}
                    type="number"
                    step="0.05"
                    min={dados.pesoTriMin}
                    max={dados.pesoTriMax}
                    value={valor}
                    style={{ width: 96 }}
                    onChange={(e) => { setOk(''); setPesos((p) => ({ ...p, [pool.key]: e.target.value })); }}
                  />
                  {desligado && <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>desligado</span>}
                  {String(valor).trim() === '' && (
                    <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                      vazio: salva o padrão do sistema
                    </span>
                  )}
                </div>
                <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: 0, flex: 1 }}>
                  {pool.descricao}
                </p>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 12 }}>
          Vale já no próximo atendimento avaliado. Não recalcula as dificuldades que já foram
          medidas — muda só o quanto os próximos atendimentos pesam daqui para frente.
        </p>
      </div>

      {erro && <div className="alert error">{erro}</div>}
      {ok && <div className="alert success">{ok}</div>}
      <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando}>
        {salvando ? 'Salvando…' : 'Salvar acessos'}
      </button>
    </div>
  );
}
