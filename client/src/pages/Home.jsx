import { useNavigate } from 'react-router-dom';
import { ICONS } from '../icons';
import InstallAppBanner from '../components/InstallAppBanner';

// Homepage (pós-login). O layout segue o mockup em .manuais/Simulação.svg:
//
//   ┌── Simulação ──┬── Treinamento ──┐   duas portas grandes, lado a lado
//   └───────────────┴─────────────────┘
//            Cursos · Processo Seletivo     dois cartões menores
//        Suporte ····················· Clínica   rodapé
//
// A ideia por trás: a SIMULAÇÃO é o modo base (é em torno dela que o app foi
// desenhado) e ganhou peso visual próprio; TREINAMENTO é a Trilha, e todo o
// resto — Progressão, Duelo, Desafio, Antessala — passou a viver lá dentro, como
// competências. Nada foi removido: é reorganização de interface, com o objetivo
// declarado de puxar mais gente para a Simulação.
//
// As explicações longas de cada modo saíram daqui e foram para onde o modo mora:
// os cartões da Trilha (ver MODE_GROUPS em SkillMap.jsx) e o cabeçalho de cada
// página. Aqui fica só a frase que ajuda a escolher entre as duas portas.

// VISITANTE não entra na Trilha (só quem tem conta), então a porta "Treinamento"
// leva ele direto à Progressão, que é o que ele pode usar. Sem isso o visitante
// ficaria sem nenhuma porta aberta: a Simulação também exige cadastro.
function trilhaRouteFor(user) {
  return user?.role === 'visitor' ? '/progressao' : '/skills';
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

export default function Home({ user }) {
  const navigate = useNavigate();
  const isVisitor = user?.role === 'visitor';

  return (
    <div className="home-page">
      <InstallAppBanner />
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

      {/* As duas portas. A Simulação é a primeira de propósito. */}
      <div className="home-doors">
        <button
          type="button"
          className="home-door home-door--simulacao"
          onClick={() => navigate('/simulacao')}
          disabled={isVisitor}
          title={isVisitor ? 'A Simulação vale ranking — precisa de uma conta' : 'Abrir a Simulação'}
        >
          <span className="home-door-icon" aria-hidden="true">{ICONS.trophy}</span>
          <span className="home-door-name">Simulação</span>
          <span className="home-door-desc">
            {isVisitor
              ? 'Atender valendo ranking, medindo sua evolução contra a comunidade. Disponível para quem tem conta.'
              : 'Atenda pacientes simulados valendo ranking. É o modo principal: cada atendimento gera nota e move o seu MMR.'}
          </span>
          <span className="home-door-go" aria-hidden="true"><ArrowIcon /></span>
        </button>

        <button
          type="button"
          className="home-door home-door--treinamento"
          onClick={() => navigate(trilhaRouteFor(user))}
        >
          <span className="home-door-icon" aria-hidden="true">{ICONS.skill}</span>
          <span className="home-door-name">Treinamento</span>
          <span className="home-door-desc">
            {isVisitor
              ? 'Pratique sem valer nota: escolha um paciente simulado e conduza o atendimento.'
              : 'A trilha de exercícios e todos os modos de prática livre: Progressão, Duelo, Desafio e a Antessala.'}
          </span>
          <span className="home-door-go" aria-hidden="true"><ArrowIcon /></span>
        </button>
      </div>

      {/* Cursos e Processo Seletivo: fora do app, no site da Allos. */}
      <div className="home-cards">
        <a
          className="home-card home-card--cursos"
          href="https://allos.org.br/formacao"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="home-card-label">Cursos</span>
          <span className="home-card-title">Conheça a formação gravada na nossa plataforma</span>
        </a>
        <a
          className="home-card home-card--seletivo"
          href="https://allos.org.br/processoseletivopsi"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="home-card-label">Processo Seletivo</span>
          <span className="home-card-title">Participe do nosso processo seletivo na Allos</span>
        </a>
      </div>

      {/* Rodapé: Suporte à esquerda, Clínica à direita. */}
      <div className="home-footer">
        <button type="button" className="home-footer-link" onClick={() => navigate('/suporte')}>
          {ICONS.alert}
          <span>Suporte</span>
        </button>
        <a
          className="home-footer-link home-footer-link--clinica"
          href="https://allos.org.br/clinica"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>Conheça nossa clínica</span>
          <ArrowIcon />
        </a>
      </div>
    </div>
  );
}
