// Painel de Logs de Erro (admin).
//
// Contrapartida da mudança no servidor: o usuário passou a receber só
// "😵‍💫 Algo deu errado (código err-xyz)" em vez do erro cru do provedor de IA
// — que vazava modelo, estado de cota, ids de request e caminhos de disco.
// O detalhe todo veio parar aqui, e o código é a ponte: o aluno manda o código,
// o admin acha a entrada exata pela busca.
//
// O painel também recebe as MENSAGENS DE SUPORTE (página /suporte): o usuário
// escreve para a administração e o recado cai aqui, com origem
// 'suporte/mensagem'. Não é falha, então vem marcado como "suporte" e conta
// separado nas estatísticas do topo — o admin precisa distinguir de bate-pronto
// o que quebrou do que alguém pediu. Provisório por decisão do dono; o passo
// natural é uma caixa de entrada própria.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}

// "há 3 min" ajuda mais que a data absoluta quando o aluno acabou de reclamar.
function fmtRelative(iso) {
  const t = new Date(iso || 0).getTime();
  if (!Number.isFinite(t) || t === 0) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'agora há pouco';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

// Origem das mensagens da página /suporte (ver POST /api/suporte no servidor).
const SUPORTE_WHERE = 'suporte/mensagem';
const isSuporte = (e) => !!e && e.where === SUPORTE_WHERE;

const PAPEL_LABEL = {
  admin: 'admin',
  supervisor: 'supervisor',
  therapist: 'aluno',
  visitor: 'visitante',
  candidate: 'candidato',
  evaluator: 'avaliador',
};

export default function AdminErrorLogs() {
  const [errors, setErrors] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erroTela, setErroTela] = useState('');
  const [busca, setBusca] = useState('');
  const [ondeFiltro, setOndeFiltro] = useState('all');
  const [aberto, setAberto] = useState(null); // id da entrada expandida
  const [limpando, setLimpando] = useState(false);

  async function load() {
    setLoading(true);
    setErroTela('');
    try {
      const res = await api.adminErrorLogs();
      setErrors(res.errors || []);
      setMeta(res.meta || null);
    } catch (e) {
      setErroTela(e.message || 'Não consegui carregar os logs de erro.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  // Lista de origens para o filtro, com a contagem de cada uma — é o que
  // responde "o que está quebrando mais" sem precisar ler entrada por entrada.
  const origens = useMemo(() => {
    const contagem = new Map();
    for (const e of errors) contagem.set(e.where, (contagem.get(e.where) || 0) + 1);
    return [...contagem.entries()].sort((a, b) => b[1] - a[1]);
  }, [errors]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return errors.filter((e) => {
      if (ondeFiltro !== 'all' && e.where !== ondeFiltro) return false;
      if (!q) return true;
      const ator = e.actor || {};
      const alvo = [e.id, e.where, e.message, e.name, e.path, ator.username, ator.id, e.ip,
        e.extra && e.extra.assunto, e.extra && e.extra.autor]
        .filter(Boolean).join(' ').toLowerCase();
      return alvo.includes(q);
    });
  }, [errors, busca, ondeFiltro]);

  const ultimas24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return errors.filter((e) => new Date(e.timestamp || 0).getTime() >= cutoff).length;
  }, [errors]);

  // Recados de suporte contam à parte: são o que pede RESPOSTA, não conserto.
  const suporteCount = useMemo(() => errors.filter(isSuporte).length, [errors]);

  async function limpar() {
    if (!window.confirm(`Apagar as ${errors.length} entradas do painel? Isso não afeta o app, só o histórico de erros.`)) return;
    setLimpando(true);
    try {
      await api.adminClearErrorLogs();
      await load();
    } catch (e) {
      setErroTela(e.message || 'Não consegui limpar.');
    } finally {
      setLimpando(false);
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Administração · Diagnóstico</div>
          <h2>
            <Typewriter text="Logs de " />
            <span className="accent"><Typewriter text="Erro" delayStart={360} /></span>
          </h2>
          <p>
            O que os usuários veem é só uma mensagem genérica com um código. O erro real —
            mensagem, stack, quem, onde e quando — fica aqui, junto das mensagens que
            chegam pela página de Suporte.
            {meta && ` Guarda as últimas ${meta.max} ocorrências por até ${meta.ttlDays} dias.`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={load} disabled={loading}>Atualizar</button>
          {errors.length > 0 && (
            <button className="btn btn-ghost" onClick={limpar} disabled={limpando}
              style={{ color: 'var(--terra)' }}>Limpar</button>
          )}
        </div>
      </div>

      {erroTela && <div className="alert error">{erroTela}</div>}

      {!loading && errors.length === 0 && (
        <div className="card errlog-empty">
          <div className="errlog-empty-icon">✓</div>
          <div>
            <strong>Nada registrado.</strong>
            <p style={{ margin: '4px 0 0', color: 'var(--ink-soft)' }}>
              É o estado saudável. Quando algo falhar pra um usuário — ou quando alguém
              escrever pelo Suporte — aparece aqui na hora.
            </p>
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <>
          <div className="errlog-stats card">
            <div className="errlog-stat">
              <div className="errlog-stat-num">{errors.length}</div>
              <div className="errlog-stat-key">registrados</div>
            </div>
            <div className="errlog-stat">
              <div className="errlog-stat-num" style={{ color: ultimas24h > 0 ? 'var(--terra)' : undefined }}>
                {ultimas24h}
              </div>
              <div className="errlog-stat-key">nas últimas 24h</div>
            </div>
            <div className="errlog-stat">
              <div className="errlog-stat-num">{origens.length}</div>
              <div className="errlog-stat-key">origens distintas</div>
            </div>
            <div className="errlog-stat">
              <div className="errlog-stat-num" style={{ color: suporteCount > 0 ? 'var(--marrs-deep)' : undefined }}>
                {suporteCount}
              </div>
              <div className="errlog-stat-key">{suporteCount === 1 ? 'recado de suporte' : 'recados de suporte'}</div>
            </div>
          </div>

          <div className="card errlog-filters">
            <div className="aval-controls">
              <div>
                <label htmlFor="errlog-busca">Buscar</label>
                <input
                  id="errlog-busca"
                  type="text"
                  placeholder="Código (err-…), mensagem, usuário, rota…"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="errlog-onde">Origem</label>
                <select id="errlog-onde" value={ondeFiltro} onChange={(e) => setOndeFiltro(e.target.value)}>
                  <option value="all">Todas ({errors.length})</option>
                  {origens.map(([onde, n]) => (
                    <option key={onde} value={onde}>{onde} ({n})</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {visiveis.length === 0 && (
            <p style={{ color: 'var(--ink-soft)' }}>Nenhuma entrada bate com o filtro.</p>
          )}

          {visiveis.map((e) => {
            const ator = e.actor || {};
            const expandido = aberto === e.id;
            return (
              <div className={`errlog-card ${isSuporte(e) ? 'is-suporte' : ''}`} key={e.id}>
                <div
                  className="errlog-head"
                  onClick={() => setAberto(expandido ? null : e.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setAberto(expandido ? null : e.id); } }}
                >
                  <div className="errlog-head-main">
                    <span className={`errlog-where ${isSuporte(e) ? 'suporte' : ''}`}>
                      {isSuporte(e) ? 'suporte' : e.where}
                    </span>
                    <span className="errlog-msg">
                      {isSuporte(e) && e.extra && e.extra.assunto ? `${e.extra.assunto} — ` : ''}
                      {e.message}
                    </span>
                  </div>
                  <div className="errlog-head-side">
                    <span className="errlog-when" title={fmtDate(e.timestamp)}>{fmtRelative(e.timestamp)}</span>
                    <span className="errlog-caret">{expandido ? '▾' : '▸'}</span>
                  </div>
                </div>

                <div className="errlog-meta">
                  <code className="errlog-code">{e.id}</code>
                  <span>{PAPEL_LABEL[ator.role] || ator.role || '—'}{ator.username ? ` · ${ator.username}` : ''}</span>
                  {e.method && e.path && <span>{e.method} {e.path}</span>}
                  {e.status != null && <span>HTTP {e.status}</span>}
                  <span>{fmtDate(e.timestamp)}</span>
                </div>

                {expandido && (
                  <div className="errlog-detail">
                    {e.name && (
                      <div className="errlog-detail-row">
                        <span className="errlog-detail-key">Tipo</span>
                        <span>{e.name}</span>
                      </div>
                    )}
                    {e.ip && (
                      <div className="errlog-detail-row">
                        <span className="errlog-detail-key">IP</span>
                        <span>{e.ip}</span>
                      </div>
                    )}
                    {ator.id && (
                      <div className="errlog-detail-row">
                        <span className="errlog-detail-key">ID do usuário</span>
                        <span>{ator.id}</span>
                      </div>
                    )}
                    {e.extra && Object.keys(e.extra).length > 0 && (
                      <div className="errlog-detail-row">
                        <span className="errlog-detail-key">Contexto</span>
                        <span>
                          {Object.entries(e.extra)
                            .filter(([, v]) => v != null && v !== '')
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(' · ') || '—'}
                        </span>
                      </div>
                    )}
                    {e.stack && (
                      <>
                        <div className="errlog-detail-key" style={{ marginTop: 10 }}>Stack</div>
                        <pre className="errlog-stack">{e.stack}</pre>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
