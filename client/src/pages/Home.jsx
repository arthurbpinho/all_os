import { ICONS } from '../icons';

// Homepage (pós-login): o "como jogar" de cada modo no topo, depois os banners
// de processo seletivo e formação. A missão diária vive só no Treinamento
// (FreePlay), não aqui. Os ícones dos modos são os mesmos do menu lateral.
// A ordem dos modos segue a progressão natural do aluno (treina → disputa a
// referência do caso → ranqueado → PvP). Trilha de Competências e
// Neuroavaliação ficam de fora de propósito (ainda ocultas nesta versão).
const FAQ_ITEMS = [
  {
    icon: ICONS.freeplay,
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
    icon: ICONS.crown,
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
    icon: ICONS.trophy,
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
    icon: ICONS.duel,
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

export default function Home() {
  return (
    <div className="home-page">
      <div className="home-topbar">
        <a
          className="home-youtube"
          href="https://www.youtube.com/@associacaoallos"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Canal da Allos no YouTube"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" />
          </svg>
          <span>YouTube</span>
        </a>
      </div>

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

      <div className="home-promos">
        <a
          className="home-promo home-promo--seletivo"
          href="https://allos.org.br/processoseletivopsi"
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="home-promo-label">Processo seletivo</div>
          <div className="home-promo-title">Participe do nosso processo seletivo na Allos</div>
        </a>
        <a
          className="home-promo home-promo--formacao"
          href="https://allos.org.br/formacao"
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="home-promo-label">Formação</div>
          <div className="home-promo-title">Conheça a formação gravada na nossa plataforma</div>
        </a>
      </div>
    </div>
  );
}
