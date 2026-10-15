import { useState, useEffect } from 'react';
import { api } from '../api';
import { formatarEspera } from '../sessionQuota';
import SessionQuotaModal from './SessionQuotaModal';

// O pedido de feedback abre sozinho uma vez por aba (sessionStorage), não a
// cada volta à Página Inicial. Depois disso fica o botão no aviso.
const FEEDBACK_ABERTO_KEY = 'allos_quota_feedback_aberto';

// Aviso da cota diária de sessões na Página Inicial — só para quem tem cota
// (o Aluno Externo; nos outros papéis o servidor responde enabled:false e o
// aviso não aparece). Mostra quantas sessões restam e, esgotada a cota, a
// contagem regressiva até a próxima voltar (janela deslizante de 24h, regra em
// server/session-quota.js). Esgotada a cota, enquanto o aluno não tiver dado
// o feedback anônimo da plataforma, abre o aviso com o formulário.
export default function SessionQuotaBanner() {
  const [cota, setCota] = useState(null);
  const [agora, setAgora] = useState(Date.now());
  const [modalAberto, setModalAberto] = useState(false);

  useEffect(() => {
    let cancelado = false;
    api.sessionQuota()
      .then((c) => { if (!cancelado) setCota(c); })
      .catch(() => {}); // falhou o GET → sem aviso; nada aqui é essencial
    return () => { cancelado = true; };
  }, []);

  // Relógio da contagem regressiva — só roda com a cota esgotada. Quando o
  // horário passa, consulta de novo: a sessão que voltou aparece no contador.
  const esgotada = !!(cota && cota.enabled && cota.blocked);
  useEffect(() => {
    if (!esgotada) return undefined;
    const t = setInterval(() => {
      const n = Date.now();
      setAgora(n);
      if (cota.resetAt && Date.parse(cota.resetAt) <= n) {
        api.sessionQuota().then(setCota).catch(() => {});
      }
    }, 15000);
    return () => clearInterval(t);
  }, [esgotada, cota]);

  const pedirFeedback = esgotada && !!cota.feedbackPendente;
  useEffect(() => {
    if (!pedirFeedback) return;
    try {
      if (sessionStorage.getItem(FEEDBACK_ABERTO_KEY) === '1') return;
      sessionStorage.setItem(FEEDBACK_ABERTO_KEY, '1');
    } catch {}
    setModalAberto(true);
  }, [pedirFeedback]);

  if (!cota || !cota.enabled) return null;

  const espera = esgotada ? formatarEspera(cota.resetAt, agora) : '';

  return (
    <>
    <div className={`quota-banner ${esgotada ? 'quota-banner--esgotada' : ''}`} role="status">
      <div className="quota-banner-contador" aria-hidden="true">
        <strong>{cota.remaining}</strong>
        <span>de {cota.limit}</span>
      </div>
      <div className="quota-banner-text">
        <strong>Sessões disponíveis hoje: {cota.remaining} de {cota.limit}</strong>
        <span>
          Alunos internos da Allos têm acesso ilimitado. Por questões de custo operacional, alunos
          externos têm direito a {cota.limit} sessões a cada 24h.
        </span>
        {esgotada && espera && (
          <span className="quota-banner-espera">
            Próxima sessão disponível em <strong>{espera}</strong>.
          </span>
        )}
      </div>
      {pedirFeedback && (
        <button type="button" className="quota-banner-btn" onClick={() => setModalAberto(true)}>
          Deixar feedback
        </button>
      )}
    </div>
    <SessionQuotaModal
      message={modalAberto ? cota.message : ''}
      onClose={() => setModalAberto(false)}
      onFeedbackSent={() => setCota((c) => ({ ...c, feedbackPendente: false }))}
    />
    </>
  );
}
