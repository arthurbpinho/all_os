import { Link, useNavigate } from 'react-router-dom';

// Página estática — texto puro, sem chamada à API. Fica FORA do shell logado
// (ver ROTAS_PUBLICAS em App.jsx) porque precisa ser lida por quem ainda nem
// tem conta, no momento do cadastro.
//
// Versão do texto: some com TERMOS_VERSAO no servidor (registrado no aceite do
// cadastro). Ao publicar uma revisão de conteúdo aqui, avise quem mantém o
// servidor pra incrementar a env — datas divergentes entre o que a pessoa
// aceitou e o texto atual são o tipo de coisa que a LGPD cobra saber responder.
const ATUALIZADO_EM = '27 de agosto de 2026';

export default function PoliticaPrivacidade() {
  const navigate = useNavigate();
  return (
    <div className="legal-page">
      <div className="legal-card">
        <button type="button" className="legal-back" onClick={() => navigate(-1)}>← Voltar</button>
        <div className="legal-eyebrow">Associação Allos · all_OS</div>
        <h1>Política de Privacidade</h1>
        <p className="legal-updated">Última atualização: {ATUALIZADO_EM}</p>

        <nav className="legal-nav">
          <Link to="/politica-de-privacidade" className="active">Política de Privacidade</Link>
          <Link to="/termos-de-uso">Termos de Uso</Link>
        </nav>

        <div className="legal-content">
          <div className="legal-highlight">
            <p>
              Em resumo: usamos os seus dados só para fazer o all_OS funcionar (a simulação, a
              avaliação, a comunidade) e para a pesquisa que a Associação Allos conduz a partir
              deles — nunca para vender ou repassar a terceiros fora do que está descrito aqui.
              Partes das suas conversas passam por provedores de IA (OpenAI, Anthropic e Z.AI/GLM)
              para gerar as respostas dos pacientes simulados e as avaliações. Você pode excluir
              sua conta a qualquer momento pelo Perfil; para pedir a exclusão dos seus dados
              (logs, avaliações, conversas), escreva para <strong>suporte@allos.org.br</strong>.
            </p>
          </div>

          <h2>1. Quem trata seus dados</h2>
          <p>
            O all_OS é uma plataforma da <strong>Associação Allos</strong>, usada para treino e
            supervisão de habilidades clínicas por meio de simulações de atendimento com pacientes
            gerados por Inteligência Artificial. Este documento explica quais dados coletamos,
            para que servem, com quem são compartilhados e quais direitos você tem sobre eles.
          </p>

          <h2>2. Quais dados coletamos</h2>
          <h3>2.1 Dados de cadastro e conta</h3>
          <ul>
            <li>Nome, nome de usuário, e-mail e senha (armazenada de forma criptografada, nunca em texto puro);</li>
            <li>Vínculo institucional, quando houver (curso/faculdade, professor/supervisor responsável);</li>
            <li>Foto de perfil, quando você opta por enviar uma;</li>
            <li>Preferências de comunicação (se aceita receber novidades da plataforma e/ou da Associação Allos).</li>
          </ul>

          <h3>2.2 Dados de uso da simulação</h3>
          <ul>
            <li>As conversas que você tem com os pacientes simulados (Treinamento, Competitivo, Trilha, Neuroavaliação e Duelo);</li>
            <li>As avaliações geradas por IA sobre seu atendimento, as notas por critério e o feedback recebido;</li>
            <li>Tempo de sessão, número de atendimentos, progresso na Trilha e conquistas obtidas;</li>
            <li>Mapas de caso montados na Antessala, quando você usa essa ferramenta antes da supervisão.</li>
          </ul>

          <h3>2.3 Participação na comunidade e nos fóruns</h3>
          <p>
            Mensagens, destaques de trechos de atendimento com comentários, duelos entre alunos e
            qualquer outro conteúdo que você publique nas áreas colaborativas da plataforma.
          </p>

          <h3>2.4 Dados técnicos</h3>
          <p>
            Registros de acesso (data e hora de login, dispositivo/navegador usado) para segurança
            da conta e diagnóstico de problemas.
          </p>

          <h2>3. Para que usamos seus dados</h2>
          <p>Seus dados são usados exclusivamente para:</p>
          <ul>
            <li>Fazer a plataforma funcionar: autenticação, salvar seu progresso, gerar as respostas dos pacientes simulados e as avaliações do seu desempenho;</li>
            <li>
              <strong>Pesquisa dentro da Associação Allos</strong>, tanto na área de{' '}
              <strong>tecnologia</strong> (desenvolvimento e aprimoramento de modelos de IA,
              ferramentas e software da própria plataforma) quanto na área de{' '}
              <strong>psicologia</strong> (psicologia comparada, pesquisa sobre habilidades
              clínicas, prática deliberada, métodos de supervisão e formação de terapeutas);
            </li>
            <li>Supervisão acadêmica: seu professor/supervisor vinculado acessa seus atendimentos e avaliações para orientar sua formação;</li>
            <li>Comunicação sobre a conta (confirmação de cadastro, recuperação de senha, avisos de segurança) e, se você autorizar, novidades do all_OS e/ou da Associação Allos;</li>
            <li>Segurança da plataforma: prevenção de fraude, abuso e uso indevido.</li>
          </ul>
          <p>
            Quando usados para pesquisa, seus dados são tratados prioritariamente de forma agregada
            ou anonimizada. Quando isso não for possível (por exemplo, ao analisar a trajetória de
            um mesmo aluno ao longo do tempo), o acesso fica restrito à equipe de pesquisa da
            Associação Allos.
          </p>

          <h2>4. Compartilhamento com provedores de Inteligência Artificial</h2>
          <p>
            Para que a simulação e a avaliação funcionem, parte do conteúdo que você envia à
            plataforma — mensagens da conversa com o paciente simulado, e o histórico do
            atendimento no momento da correção — é processada por provedores externos de IA
            contratados pela Associação Allos:
          </p>
          <ul>
            <li><strong>OpenAI</strong> — geração de personagens/pacientes em algumas categorias, avaliação de atendimentos, transcrição de áudio e outras funções de IA da plataforma;</li>
            <li><strong>Anthropic</strong> — geração de personagens/pacientes em algumas categorias;</li>
            <li><strong>Z.AI / GLM</strong> — geração de personagens/pacientes e reflexão assistida em algumas funções (como a Antessala).</li>
          </ul>
          <p>
            Esses provedores processam os dados enviados sob seus próprios termos e políticas de
            privacidade, atuando como operadores a serviço do all_OS — ou seja, não usam seu
            conteúdo para treinar os modelos deles fora do que seus contratos comerciais com esses
            provedores garantem. Não enviamos dados de cadastro (como senha) a esses provedores.
          </p>

          <h2>5. Com quem mais compartilhamos dados</h2>
          <ul>
            <li>Seu professor/supervisor vinculado, para fins de orientação e correção;</li>
            <li>A equipe de administração da Associação Allos, para suporte e manutenção da plataforma;</li>
            <li>Provedores de infraestrutura técnica (hospedagem e envio de e-mail transacional), estritamente para operar o serviço;</li>
            <li>Autoridades, quando exigido por lei ou ordem judicial.</li>
          </ul>
          <p>Não vendemos seus dados pessoais nem os compartilhamos com terceiros para fins de publicidade.</p>

          <h2>6. Conteúdo sensível de saúde mental</h2>
          <p>
            As simulações reproduzem quadros clínicos com fins didáticos. As conversas com
            pacientes simulados, os mapas de caso e as avaliações podem conter descrições de
            sintomas, diagnósticos fictícios e temas sensíveis (por exemplo, sofrimento psíquico,
            ideação suicida ou uso de substâncias) tratados como <strong>dado pessoal sensível de
            saúde</strong> para fins de proteção, mesmo sendo ficcionais e gerados por IA. Esse
            conteúdo recebe o mesmo cuidado de acesso restrito descrito neste documento.
          </p>

          <h2>7. Retenção dos dados</h2>
          <p>
            Mantemos seus dados enquanto sua conta estiver ativa e pelo tempo necessário para as
            finalidades descritas acima, incluindo o histórico usado em pesquisa e supervisão
            acadêmica. Alguns registros técnicos e de segurança têm prazo de retenção mais curto e
            são descartados automaticamente.
          </p>

          <h2>8. Seus direitos e como excluir seus dados</h2>
          <ul>
            <li>
              <strong>Excluir sua conta:</strong> a qualquer momento, na página do seu{' '}
              <strong>Perfil</strong>, na seção "Excluir conta". Isso encerra seu acesso
              imediatamente.
            </li>
            <li>
              <strong>Excluir seus dados</strong> (conversas, avaliações, logs e demais registros
              associados à sua conta): envie um e-mail para{' '}
              <strong>suporte@allos.org.br</strong> solicitando a exclusão. Tratamos esse pedido
              separadamente da exclusão da conta porque parte desse histórico pode compor material
              de supervisão ou pesquisa em andamento — nesse caso, você será informado sobre o que
              pode ser removido de imediato e o que segue anonimizado.
            </li>
            <li>Você também pode solicitar por e-mail a correção de dados incorretos ou uma cópia dos dados que temos sobre você.</li>
          </ul>

          <h2>9. Segurança</h2>
          <p>
            Senhas são armazenadas com hash (nunca em texto legível), sessões podem ser revogadas
            remotamente (por exemplo, ao trocar a senha) e o acesso a avaliações e conteúdo
            sensível é restrito por função (aluno, supervisor, administrador).
          </p>

          <h2>10. Alterações desta política</h2>
          <p>
            Podemos atualizar este documento para refletir mudanças na plataforma ou na
            legislação. A data no topo indica a última revisão. Mudanças relevantes serão
            comunicadas na plataforma.
          </p>

          <h2>11. Contato</h2>
          <p>
            Dúvidas sobre esta política ou sobre o tratamento dos seus dados:{' '}
            <strong>suporte@allos.org.br</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
