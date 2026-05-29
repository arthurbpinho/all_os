import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

// Homepage (pós-login): slogan, missão diária e o "como jogar" de cada modo.
// A ordem dos modos segue a progressão natural do aluno (treina → disputa a
// referência do caso → ranqueado → PvP). Trilha de Competências e
// Neuroavaliação ficam de fora de propósito (ainda ocultas nesta versão).
const FAQ_ITEMS = [
  {
    icon: '💬',
    q: 'Treinamento',
    a: (
      <>
        <p>
          O modo base. Escolha um paciente simulado e conduza o atendimento por
          mensagens, como numa sessão real — praticando escuta, manejo do vínculo
          e ritmo de sessão. Ao encerrar, uma <strong>IA avaliadora</strong> analisa o
          atendimento e devolve um feedback, e o log fica salvo no seu histórico.
        </p>
        <p>
          Reatender um paciente que você já viu faz a avaliação comparar a sua{' '}
          <strong>evolução</strong> com a sessão anterior. E quando você tem um{' '}
          <strong>objetivo</strong> ativo, ele vira o foco do próximo treino.
        </p>
      </>
    ),
  },
  {
    icon: '👑',
    q: 'Modo Desafio',
    a: (
      <>
        <p>
          Cada paciente tem uma posição de <strong>Titular</strong> 👑 — o terapeuta
          que detém a referência daquele caso. No card do paciente, dentro do
          Treinamento:
        </p>
        <ul>
          <li>
            Se <strong>ninguém</strong> reivindicou ainda, toque na coroa para atender e
            garantir o título — você vira Titular ao final, independente da nota.
          </li>
          <li>
            Se <strong>já existe um Titular</strong>, tocar na coroa abre um desafio: você
            atende o mesmo paciente e a IA compara o seu atendimento com o dele,
            decidindo se você assume a posição.
          </li>
        </ul>
        <p>
          O resultado é apenas posicional — <em>você assume</em> ou <em>o Titular
          permanece</em>, com uma justificativa clínica. Não aparece nota numérica.
        </p>
      </>
    ),
  },
  {
    icon: '🏆',
    q: 'Competitivo',
    a: (
      <>
        <p>
          Os mesmos pacientes do Treinamento, mas valendo rating. Cada atendimento
          finalizado gera uma nota que alimenta o seu <strong>MMR</strong>, e a{' '}
          <strong>dificuldade</strong> de cada paciente se ajusta ao desempenho coletivo
          de todos os jogadores.
        </p>
        <p>
          As <strong>3 primeiras partidas</strong> são de calibração — o seu MMR fica
          oculto até lá. O ranking da comunidade é ordenado pelo MMR.
        </p>
      </>
    ),
  },
  {
    icon: '⚔️',
    q: 'Duelo',
    a: (
      <>
        <p>
          Você e outra pessoa atendem o <strong>mesmo paciente</strong>, cada um na sua
          sessão. Quando os dois terminam, um avaliador comparativo lê os dois
          atendimentos lado a lado, dá uma nota a cada um e aponta o vencedor.
        </p>
        <p>Você escolhe o paciente e como convidar o oponente:</p>
        <ul>
          <li>
            <strong>Pelo sistema</strong> — convite in-app para outro terapeuta cadastrado.
          </li>
          <li>
            <strong>Por link / WhatsApp</strong> — link aberto; quem abrir entra e atende o
            mesmo paciente, inclusive como visitante.
          </li>
        </ul>
        <p>E há dois modos de disputa:</p>
        <ul>
          <li>
            <strong>Treino</strong> — só feedback comparativo, sem ranking; dá para duelar
            até contra visitante.
          </li>
          <li>
            <strong>Competitivo</strong> — vale MMR, apenas entre jogadores cadastrados e
            fora da calibração; diferenças de nível muito grandes não contam
            (anti-smurf).
          </li>
        </ul>
      </>
    ),
  },
];

function Chevron() {
  return (
    <svg className="faq-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function Home({ user }) {
  const isVisitor = user?.role === 'visitor';
  const [daily, setDaily] = useState(null); // { mission, completed }

  useEffect(() => {
    if (isVisitor) return; // visitante não tem recompensa de missão; mostra só os modos
    let cancelled = false;
    api.getMyDailyMission()
      .then((d) => { if (!cancelled) setDaily(d && d.mission ? d : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.id, isVisitor]);

  return (
    <div className="home-page">
      <div className="page-header home-hero">
        <div className="eyebrow">Associação Allos</div>
        <h2 className="home-slogan">
          Aprenda e treine <span className="accent">competências clínicas reais</span> por
          meio de Inteligência Artificial com o método Allos.
        </h2>
        <div className="ornament" />
        <Link to="/freeplay" className="btn btn-primary home-cta">Começar a treinar</Link>
      </div>

      {daily && (
        <div className={`sidequest-banner daily-mission-banner ${daily.completed ? 'completed' : ''}`}>
          <div className="sidequest-banner-label">
            ◷ Missão diária{daily.completed ? ' · concluída hoje ✓' : ' · desafio do dia'}
          </div>
          <div className="sidequest-banner-title">{daily.mission.title}</div>
          <div className="sidequest-banner-desc">{daily.mission.description}</div>
          <div className="sidequest-banner-hint">
            {daily.completed
              ? 'Você já cumpriu o desafio de hoje. À meia-noite entra uma nova missão.'
              : 'Desafio do dia (rotaciona à meia-noite). Cumpra durante um atendimento de Treinamento para ganhar a recompensa.'}
          </div>
        </div>
      )}

      <section className="home-about" aria-label="Como jogar">
        <div className="home-about-header">
          <div className="home-about-eyebrow">Como jogar</div>
          <h3 className="home-about-title">Quatro formas de praticar</h3>
          <p className="home-about-intro">
            Toda a prática gira em torno de atender pacientes simulados por IA.
            Cada modo coloca esse atendimento sob uma luz diferente.
          </p>
        </div>
        {FAQ_ITEMS.map((item) => (
          <details key={item.q} className="faq-item">
            <summary>
              <span className="faq-q-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.q}</span>
              <Chevron />
            </summary>
            <div className="faq-a">{item.a}</div>
          </details>
        ))}
      </section>
    </div>
  );
}
