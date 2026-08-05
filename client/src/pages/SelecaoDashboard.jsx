import { useEffect, useState } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

const RANGES = [
  { v: 'day', label: 'Dia' },
  { v: 'week', label: 'Semana' },
  { v: 'month', label: 'Mês' },
  { v: 'year', label: 'Ano' },
];

export default function SelecaoDashboard() {
  const [range, setRange] = useState('month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // TRI é CUMULATIVA: não entra no efeito do `range`, porque a dificuldade se
  // acumula atendimento a atendimento — recortar por data mostraria um número
  // diferente do que o engine está de fato usando.
  const [tri, setTri] = useState(null);

  const link = `${window.location.origin}/processo-seletivo`;

  useEffect(() => {
    setLoading(true);
    setError('');
    api.selecaoDashboard(range)
      .then(setData)
      .catch((err) => setError(err.message || 'Erro ao carregar a dashboard.'))
      .finally(() => setLoading(false));
  }, [range]);

  useEffect(() => {
    api.triPersonagens().then(setTri).catch(() => setTri(null));
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // best-effort
    }
  }

  return (
    <div>
      <div className="page-header with-action">
        <div>
          <div className="eyebrow">Processo Seletivo · Dashboard</div>
          <h2>
            <Typewriter text="Visão " />
            <span className="accent"><Typewriter text="Geral" delayStart={360} /></span>
          </h2>
          <p>Candidatos ativos (nota ≥ {data?.threshold ?? 55}), rejeitados e média das notas no período.</p>
        </div>
        <button className="btn btn-outline" onClick={copyLink} title="Copiar o link para enviar aos candidatos">
          {copied ? '✓ Link copiado' : 'Copiar link do processo seletivo'}
        </button>
      </div>

      <div className="selecao-range">
        {RANGES.map((r) => (
          <button
            key={r.v}
            className={`btn btn-sm ${range === r.v ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setRange(r.v)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <div className="alert error" style={{ marginTop: 16 }}>{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, marginTop: 16 }}>
          <span className="spinner" /> <span style={{ marginLeft: 12 }}>Carregando…</span>
        </div>
      ) : (
        <>
          <div className="selecao-stats">
            <div className="selecao-stat active">
              <div className="selecao-stat-label">Candidatos ativos</div>
              <div className="selecao-stat-value">{data?.activeCount ?? 0}</div>
            </div>
            <div className="selecao-stat rejected">
              <div className="selecao-stat-label">Candidatos rejeitados</div>
              <div className="selecao-stat-value">{data?.rejectedCount ?? 0}</div>
            </div>
            <div className="selecao-stat">
              <div className="selecao-stat-label">Média de nota</div>
              <div className="selecao-stat-value">{data?.avgScore == null ? '—' : `${data.avgScore}`}</div>
            </div>
            <div className="selecao-stat">
              <div className="selecao-stat-label">Total avaliados</div>
              <div className="selecao-stat-value">{data?.total ?? 0}</div>
            </div>
          </div>

          <p style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic', marginTop: 4 }}>
            Os números vêm do histórico anônimo (sem dados pessoais), que permanece mesmo após os logs
            completos expirarem em 15 dias.
          </p>

          {tri && <TriPanel tri={tri} />}
        </>
      )}
    </div>
  );
}

const POOL_LABEL = { selecao: 'Processo seletivo', visitante: 'Visitantes' };
const FONTE_LABEL = { competitivo: 'competitivo', selecao: 'seletivo', visitante: 'visitantes' };

// Dificuldade estimada de cada personagem. O número é ÚNICO e vem de todas as
// fontes juntas — competitivo, processo seletivo e visitantes. É o que faz o
// sistema ser justo: cada respondente é pesado pelo próprio nível, então quem
// joga bem e quem joga mal convergem para a mesma estimativa de dificuldade.
function TriPanel({ tri }) {
  const comDado = tri.characters.filter((c) => c.n > 0);
  const semDado = tri.characters.filter((c) => c.n === 0);
  const escala = tri.max - tri.min;
  const populacoesAtivas = (tri.populacoes || []).filter((p) => p.n > 0);

  return (
    <div className="tri-panel">
      <div className="tri-head">
        <h3>Dificuldade dos personagens</h3>
        <span className="tri-sub">
          {tri.totalAtendimentos} atendimento{tri.totalAtendimentos === 1 ? '' : 's'} avaliado{tri.totalAtendimentos === 1 ? '' : 's'}
          {' · '}escala {tri.min}–{tri.max}, começa em {tri.baseline}
        </span>
      </div>

      {comDado.length === 0 ? (
        <p className="tri-vazio">
          Ainda não há atendimento avaliado. Todos os personagens começam em {tri.baseline} e
          passam a se diferenciar conforme as pessoas vão atendendo — no competitivo, no
          processo seletivo e (quando ativo) no modo visitante.
        </p>
      ) : (
        <>
          <div className="tri-list">
            {comDado.map((c) => {
              // Posição na barra: 0% = mais fácil possível, 100% = mais difícil.
              const pct = Math.max(0, Math.min(100, ((c.difficulty - tri.min) / escala) * 100));
              const acimaDaBase = c.difficulty > tri.baseline;
              return (
                <div className="tri-row" key={c.id}>
                  <div className="tri-nome">
                    {c.name}
                    {!c.madura && (
                      <span className="tri-provisorio" title={`Estimativa firme a partir de ${tri.maturaEm} atendimentos`}>
                        provisório
                      </span>
                    )}
                  </div>
                  <div className="tri-barra">
                    {/* Marca da baseline: o olho precisa de referência pra ler
                        "mais difícil que o ponto de partida". */}
                    <span
                      className="tri-baseline"
                      style={{ left: `${((tri.baseline - tri.min) / escala) * 100}%` }}
                    />
                    <span
                      className={`tri-preenchimento ${acimaDaBase ? 'dificil' : 'facil'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="tri-num">
                    <strong>{c.difficulty}</strong>
                    <span className="tri-meta" title={fontesTitulo(c.fontes)}>
                      {c.n} atend. · média {c.avgScore == null ? '—' : c.avgScore}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="tri-legenda">
            Acima de {tri.baseline} = mais difícil que o ponto de partida; abaixo = mais fácil.
            A estimativa junta <strong>competitivo, processo seletivo e visitantes</strong>: cada
            atendimento é pesado pelo nível de quem atendeu, então grupos mais e menos preparados
            levam à mesma <em>ordem</em> de dificuldade. Use os números para comparar os casos
            entre si, não como medida absoluta. Marcados como <em>provisório</em> os que ainda têm
            menos de {tri.maturaEm} atendimentos.
          </p>

          {populacoesAtivas.length > 0 && (
            <div className="tri-populacoes">
              <span className="tri-populacoes-titulo">Nível estimado de cada grupo</span>
              {populacoesAtivas.map((p) => (
                <span className="tri-populacao" key={p.pool}>
                  {POOL_LABEL[p.pool] || p.pool}:{' '}
                  {p.calibrando
                    ? <em>calibrando ({p.n}/3)</em>
                    : <strong>{p.rating}</strong>}
                  <span className="tri-populacao-peso"> · peso {p.peso}×</span>
                </span>
              ))}
              <span className="tri-populacoes-nota">
                Grupos sem conta entram valendo {tri.ratingInicial} e o nível vai se ajustando ao
                desempenho real. É isso que impede que um grupo mais numeroso ou menos preparado
                puxe a dificuldade dos personagens para cima.
              </span>
            </div>
          )}
        </>
      )}

      {semDado.length > 0 && (
        <p className="tri-semdado">
          Sem atendimento ainda: {semDado.map((c) => c.name).join(', ')}.
        </p>
      )}
    </div>
  );
}

// Tooltip com a origem dos atendimentos daquele personagem.
function fontesTitulo(fontes) {
  const partes = Object.entries(fontes || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${FONTE_LABEL[k] || k}`);
  return partes.length ? `Origem: ${partes.join(', ')}` : undefined;
}
