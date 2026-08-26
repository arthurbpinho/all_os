import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Typewriter from '../components/Typewriter';
import InstallAppBanner from '../components/InstallAppBanner';
import { ICONS } from '../icons';
import { PatientAvatar } from '../components/PatientAvatar';

// PÁGINA INICIAL (/inicio) — a lista de pacientes simulados é a primeira coisa
// que a pessoa vê ao entrar. A antiga tela de Início (duas "portas" grandes,
// Simulação × Treinamento) foi removida: com o app abrindo para usuários
// externos, uma tela intermediária só atrasava o que interessa — atender.
//
// O que sobrou dela vive aqui, na coluna da direita do cabeçalho: formação
// (laranja), clínica (verde, o destaque), processo seletivo e suporte. O
// Treinamento/Trilha passou para o menu lateral, em Prática.
//
// O componente segue chamado Competitive e a rota /simulacao continua
// respondendo: o identificador interno do modo é 'competitive' em log.mode, MMR
// e Duelo, e renomeá-lo migraria dados por cosmética. O que mudou é o NOME
// VISÍVEL ("Simulação" → "Página Inicial").
//
// Dois enfeites de card vivem SÓ aqui (o servidor manda ambos em /api/freeplay):
//   - record   → 👑 com a maior nota já tirada naquele paciente no Competitivo e
//                quem a tirou.
//   - featured → "Paciente em Destaque", o ÚLTIMO personagem cadastrado. Ganha
//                fundo amarelo E vai pro começo da lista, pra puxar atendimentos
//                e calibrar o TRI dele mais rápido. Puro truque visual, nenhuma
//                regra depende disso — e o reordenamento é SÓ desta tela: as
//                outras (Progressão, Duelo, admin) mantêm a ordem de cadastro.
export default function Competitive({ user }) {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  // Visitante não fecha partida competitiva (POST /api/competitive/finish barra
  // com 403). Como esta tela virou a porta de entrada dele também, o card abre a
  // sessão em modo TREINO — atende e recebe o log, sem ranking.
  const isVisitor = user?.role === 'visitor';

  useEffect(() => {
    api.getFreeplay()
      .then((chars) => {
        // Destaque primeiro; o resto mantém a ordem de cadastro que veio do
        // servidor (sort estável).
        const list = [...(chars || [])].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
        setCharacters(list);
      })
      .catch((err) => setError(err.message || 'Erro ao carregar personagens'))
      .finally(() => setLoading(false));
  }, [user]);

  return (
    <div className="inicio-page">
      <InstallAppBanner />

      <div className="inicio-hero">
        <div className="page-header inicio-hero-text">
          <div className="eyebrow">Prática · Simulação</div>
          <h2><Typewriter text="Página " /><span className="accent"><Typewriter text="Inicial" delayStart={220} /></span></h2>
          <p>
            Esse é o ambiente de desenvolvimento prático de clínica utilizado na formação da
            Associação Allos. Além de testar seus conhecimentos práticos atendendo os pacientes
            simulados, recomendamos que você conheça a nossa formação totalmente gratuita no botão
            laranja ao lado para entender mais sobre as funções da plataforma, nosso método e como
            integrar essas ferramentas no seu estudo, além de poder participar das aulas síncronas
            e eventos.
          </p>
          <p>
            Caso tenha gostado, apresente a plataforma para um colega ou professor desafiando-o
            para uma sessão simulada com um paciente da sua escolha.
          </p>
          <p>
            O que nos permite proporcionar uma formação gratuita, diversos dos nossos projetos e
            essa plataforma com uso aberto, é a clínica-escola da Associação Allos. Conheça no
            botão verde ao lado.
          </p>
          <div className="ornament" />
        </div>

        {/* Coluna da direita: os dois convites pra conhecer a Allos. Laranja =
            formação (em destaque), verde = clínica (O destaque — é o clique que
            a gente quer). Seletivo e Suporte não moram aqui: são secundários e
            ficam nas pílulas centralizadas do rodapé. */}
        <aside className="inicio-links" aria-label="Conheça a Associação Allos">
          <a
            className="inicio-cta inicio-cta--formacao"
            href="https://allos.org.br/formacao"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="inicio-cta-title">Conheça a formação gravada na nossa plataforma</span>
            <span className="inicio-cta-arrow" aria-hidden="true"><ArrowIcon /></span>
          </a>

          <a
            className="inicio-cta inicio-cta--clinica"
            href="https://allos.org.br/clinica"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="inicio-cta-title">Conheça nossa clínica</span>
            <span className="inicio-cta-arrow" aria-hidden="true"><ArrowIcon /></span>
          </a>
        </aside>
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando personagens…</span>
        </div>
      ) : characters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Nenhum personagem cadastrado ainda.
        </div>
      ) : (
        <div className="card-grid">
          {characters.map((char) => {
            const record = char.record;
            return (
              <div
                key={char.id}
                className={`character-card${char.featured ? ' featured-card' : ''}`}
                onClick={() => navigate(`/chat/freeplay/${char.id}${isVisitor ? '' : '?mode=competitive'}`)}
              >
                <div className="character-card-top">
                  <PatientAvatar name={char.name} iconUrl={char.photoIcon} size={72} className="character-card-photo" />
                  <div className="character-card-meta">
                    <div className="character-card-header">
                      <h3>{char.name}</h3>
                    </div>
                    <div className="age">{char.age} anos</div>
                  </div>
                </div>
                <p>{char.description}</p>
                <div className="difficulty-tag" title="Dificuldade atual deste personagem (1–100), ajustada pelo desempenho coletivo">
                  DIFICULDADE: <strong>{Number.isFinite(char.difficulty) ? char.difficulty : '—'}</strong>
                </div>
                {/* Paciente em Destaque: o personagem mais novo do acervo. Fundo
                    amarelo + selo pra puxar atendimentos e calibrar o TRI dele. */}
                {char.featured && (
                  <div className="featured-badge" title="Personagem recém-adicionado — atenda para ajudar a calibrar a dificuldade dele">
                    <span aria-hidden>★</span> Paciente em destaque
                  </div>
                )}
                {/* Recorde 👑: maior nota que alguém já tirou neste paciente no
                    Competitivo. Só informativo — não é clicável. */}
                {record ? (
                  <div
                    className="record-footer"
                    title={`Recorde deste paciente: ${record.score} — ${record.userName}`}
                  >
                    <CrownIcon />
                    <span className="record-avatar">
                      {record.userPhoto
                        ? <img src={record.userPhoto} alt="" />
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>}
                    </span>
                    <span className="record-score">{record.score}</span>
                    <span className="record-name">{record.userName}</span>
                  </div>
                ) : (
                  <div className="record-footer record-empty" title="Ninguém pontuou neste paciente ainda — o recorde está em aberto">
                    <CrownIcon />
                    <span className="record-name">Recorde em aberto</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <PageFooter onSuporte={() => navigate('/suporte')} />
    </div>
  );
}

// Coroa do chip de recorde. Era o emoji 👑, que vinha colorido e desenhado
// diferente em cada sistema; em SVG ela herda o verde do tema (e o cinza quando
// o recorde está em aberto), no mesmo traço dos outros ícones do app.
function CrownIcon() {
  return (
    <svg className="crown-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5l4 4 5-7 5 7 4-4-1.8 10.5H4.8L3 7.5z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

// Rodapé da Página Inicial, numa linha só e em três zonas: "Associação Allos"
// na esquerda, as ações secundárias (processo seletivo · suporte) encaixadas no
// centro e as redes na direita. Os dois Instagram são contas diferentes e por
// isso têm cor diferente — verde é a institucional (@associacaoallos), laranja é
// a da formação (@allosformacao). A cor é a mesma convenção dos botões do
// cabeçalho, então o par não fica ambíguo.
function PageFooter({ onSuporte }) {
  return (
    <footer className="inicio-footer" aria-label="Associação Allos">
      <span className="inicio-social-label">Associação Allos</span>

      <div className="inicio-footer-pills">
        <a
          className="inicio-pill"
          href="https://allos.org.br/processoseletivopsi"
          target="_blank"
          rel="noopener noreferrer"
        >
          <PersonIcon />Processo seletivo
        </a>
        <button type="button" className="inicio-pill" onClick={onSuporte}>
          {ICONS.alert}Suporte
        </button>
      </div>

      <div className="inicio-social-links">
        <a
          className="inicio-social-link inicio-social-link--youtube"
          href="https://www.youtube.com/@associacaoallos"
          target="_blank"
          rel="noopener noreferrer"
          title="Canal da Allos no YouTube"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" />
          </svg>
          <span>YouTube</span>
        </a>

        <a
          className="inicio-social-link inicio-social-link--linkedin"
          href="https://www.linkedin.com/company/associacaoallos"
          target="_blank"
          rel="noopener noreferrer"
          title="Associação Allos no LinkedIn"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM2.9 9.98h4.16V21H2.9V9.98zM9.7 9.98h3.99v1.5h.06a4.37 4.37 0 0 1 3.93-2.16c4.2 0 4.98 2.77 4.98 6.37V21h-4.16v-4.8c0-1.15-.02-2.62-1.6-2.62-1.6 0-1.85 1.25-1.85 2.54V21H9.7V9.98z" />
          </svg>
          <span>LinkedIn</span>
        </a>

        <a
          className="inicio-social-link inicio-social-link--insta-clinica"
          href="https://www.instagram.com/associacaoallos"
          target="_blank"
          rel="noopener noreferrer"
          title="@associacaoallos no Instagram"
        >
          <InstagramIcon />
          <span>@associacaoallos</span>
        </a>

        <a
          className="inicio-social-link inicio-social-link--insta-formacao"
          href="https://www.instagram.com/allosformacao/"
          target="_blank"
          rel="noopener noreferrer"
          title="@allosformacao no Instagram"
        >
          <InstagramIcon />
          <span>@allosformacao</span>
      </a>
      </div>
    </footer>
  );
}

// Pessoa — mesma silhueta (cabeça + ombros) que o app já usa nos avatares sem
// foto, no traço dos outros ícones.
function PersonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.4" />
      <circle cx="12" cy="12" r="4.1" />
      <circle cx="17.4" cy="6.6" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}
