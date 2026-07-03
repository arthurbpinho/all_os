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

  const link = `${window.location.origin}/processo-seletivo`;

  useEffect(() => {
    setLoading(true);
    setError('');
    api.selecaoDashboard(range)
      .then(setData)
      .catch((err) => setError(err.message || 'Erro ao carregar a dashboard.'))
      .finally(() => setLoading(false));
  }, [range]);

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
          <p>Candidatos ativos (nota ≥ {data?.threshold ?? 40}), rejeitados e média das notas no período.</p>
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
        </>
      )}
    </div>
  );
}
