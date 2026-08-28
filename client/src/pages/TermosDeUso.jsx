import { Link, useNavigate } from 'react-router-dom';

// Ver PoliticaPrivacidade.jsx pro raciocínio de layout/rota — os dois
// documentos seguem o mesmo padrão e se referenciam um ao outro.
const ATUALIZADO_EM = '27 de agosto de 2026';

export default function TermosDeUso() {
  const navigate = useNavigate();
  return (
    <div className="legal-page">
      <div className="legal-card">
        <button type="button" className="legal-back" onClick={() => navigate(-1)}>← Voltar</button>
        <div className="legal-eyebrow">Associação Allos · all_OS</div>
        <h1>Termos de Uso</h1>
        <p className="legal-updated">Última atualização: {ATUALIZADO_EM}</p>

        <nav className="legal-nav">
          <Link to="/politica-de-privacidade">Política de Privacidade</Link>
          <Link to="/termos-de-uso" className="active">Termos de Uso</Link>
        </nav>

        <div className="legal-content">
          <div className="legal-highlight">
            <p>
              Em resumo: ao usar o all_OS você está ciente e concorda que (1) os "pacientes"
              atendidos na simulação são personagens gerados por Inteligência Artificial, não
              pessoas reais; (2) seus atendimentos e sessões são avaliados por Inteligência
              Artificial, com participação de supervisores humanos; e (3) o conteúdo dessas
              simulações pode abordar temas sensíveis de saúde mental de forma ficcional. Se você
              não concorda com algum desses pontos, não deve usar a plataforma.
            </p>
          </div>

          <h2>1. Sobre a plataforma</h2>
          <p>
            O all_OS é uma plataforma de treino clínico da <strong>Associação Allos</strong> voltada
            a estudantes e profissionais de psicologia. Ela simula atendimentos com pacientes
            fictícios para prática deliberada de habilidades clínicas, com avaliação e supervisão
            do desempenho.
          </p>

          <h2>2. Aceite</h2>
          <p>
            Ao criar uma conta, você declara ter lido e concordado com estes Termos de Uso e com a{' '}
            <Link to="/politica-de-privacidade">Política de Privacidade</Link>. Se você é vinculado
            a uma instituição parceira da Associação Allos, o uso da plataforma também pode estar
            sujeito às regras dessa instituição.
          </p>

          <h2>3. Os pacientes simulados são Inteligência Artificial</h2>
          <p>
            Todo personagem atendido no all_OS — nas simulações de Treinamento, Competitivo,
            Trilha, Neuroavaliação e Duelo — é gerado e conduzido por modelos de Inteligência
            Artificial (fornecidos por OpenAI, Anthropic e/ou Z.AI/GLM, a depender do modo e da
            configuração vigente). Não há, em nenhuma hipótese, uma pessoa real do outro lado da
            conversa representando o "paciente". Diagnósticos, histórias e reações desses
            personagens são fictícios, construídos para fins didáticos, e não substituem
            treinamento clínico supervisionado com pacientes reais nem qualquer forma de
            atendimento em saúde.
          </p>

          <h2>4. Consentimento com a avaliação por Inteligência Artificial</h2>
          <p>
            Ao usar o all_OS, você consente que seus atendimentos, respostas e sessões sejam
            <strong> avaliados por sistemas de Inteligência Artificial</strong>, que geram notas,
            feedback e análises sobre seu desempenho. Essas avaliações são uma ferramenta de apoio
            à sua formação e podem ser revistas por um supervisor humano, mas a primeira camada de
            correção — inclusive em modos competitivos, duelos e testes — é feita por IA. Você
            entende que, como qualquer sistema automatizado, essas avaliações podem conter
            imprecisões, e que o julgamento final sobre sua formação continua sendo humano
            (professores, supervisores e a própria Associação Allos).
          </p>

          <h2>5. Conteúdo sensível de saúde mental</h2>
          <p>
            Para cumprir sua função didática, as simulações podem reproduzir quadros clínicos
            realistas, incluindo temas sensíveis como sofrimento psíquico intenso, ideação ou
            comportamento suicida, automutilação, abuso, uso de substâncias e outros conteúdos que
            podem ser desconfortáveis. Todo esse conteúdo é <strong>ficcional</strong>, gerado por
            IA para fins de treino. Ao usar a plataforma, você reconhece essa natureza do material
            e consente em ter contato com ele. Se em algum momento um tema o afetar
            emocionalmente, recomendamos interromper a sessão e, se necessário, buscar apoio junto
            à sua instituição ou a um profissional de saúde mental.
          </p>

          <h2>6. Comunidade e fóruns de discussão</h2>
          <p>
            Ao participar de áreas colaborativas (comunidade, destaques comentados, duelos e
            demais espaços de troca entre alunos), você concorda em:
          </p>
          <ul>
            <li>Manter um tom respeitoso com colegas, supervisores e a equipe da Associação Allos;</li>
            <li>Não publicar conteúdo ofensivo, discriminatório, ilegal ou que viole direitos de terceiros;</li>
            <li>Não compartilhar dados de pacientes reais — todo o conteúdo trocado deve se referir aos personagens simulados da plataforma;</li>
            <li>Entender que suas contribuições nessas áreas também podem ser usadas para os fins de pesquisa descritos na Política de Privacidade.</li>
          </ul>

          <h2>7. Uso adequado da conta</h2>
          <ul>
            <li>Sua conta é pessoal e intransferível; você é responsável por manter sua senha em sigilo;</li>
            <li>Não é permitido criar múltiplas contas para burlar limites de uso da plataforma;</li>
            <li>Não é permitido usar a plataforma para extrair, replicar ou treinar outros sistemas de IA a partir dos prompts, personagens ou material pedagógico do all_OS;</li>
            <li>A Associação Allos pode suspender ou encerrar contas em caso de uso indevido, fraude ou violação destes Termos.</li>
          </ul>

          <h2>8. Propriedade intelectual</h2>
          <p>
            Os personagens, exercícios, prompts, critérios de avaliação e demais materiais
            pedagógicos do all_OS são de propriedade da Associação Allos e não podem ser
            reproduzidos ou redistribuídos sem autorização. As conversas que você gera durante o
            uso da plataforma podem ser usadas pela Associação Allos nos termos da Política de
            Privacidade (avaliação, supervisão e pesquisa).
          </p>

          <h2>9. Limitação de responsabilidade</h2>
          <p>
            O all_OS é uma ferramenta de treino e não substitui supervisão clínica formal,
            avaliação psicológica profissional ou qualquer serviço de saúde. A Associação Allos não
            se responsabiliza por decisões tomadas exclusivamente com base em avaliações
            automatizadas da plataforma, nem por eventuais indisponibilidades, erros ou
            imprecisões geradas pelos modelos de IA utilizados.
          </p>

          <h2>10. Exclusão de conta e de dados</h2>
          <p>
            Você pode excluir sua conta a qualquer momento na página do seu <strong>Perfil</strong>.
            Para solicitar a exclusão dos seus dados (conversas, avaliações e demais registros
            associados à conta), envie um e-mail para <strong>suporte@allos.org.br</strong>. Mais
            detalhes na <Link to="/politica-de-privacidade">Política de Privacidade</Link>.
          </p>

          <h2>11. Alterações destes Termos</h2>
          <p>
            Podemos atualizar estes Termos para refletir mudanças na plataforma ou na legislação. A
            data no topo indica a última revisão, e a versão aceita por você fica registrada no
            momento do cadastro. Mudanças relevantes serão comunicadas na plataforma.
          </p>

          <h2>12. Contato</h2>
          <p>
            Dúvidas sobre estes Termos: <strong>suporte@allos.org.br</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
