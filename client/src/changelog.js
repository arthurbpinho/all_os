// Notas de atualização do all_OS — exibidas no painel "Atualizações do sistema"
// (ícone de bloco de notas com exclamação, ao lado das notificações).
//
// Uma entrada por dia (mesmo que tenham sido vários commits no mesmo dia),
// sintetizada a partir do histórico do projeto. Mais recente primeiro.
// `date` em ISO (YYYY-MM-DD); `body` aceita quebras de linha (renderizado em
// pre-wrap).

export const CHANGELOG = [
  {
    date: '2026-05-20',
    title: 'Atualizações Importantes ⚠️',
    body: `Olá, pessoal! Temos novos recursos e correções implementados na plataforma hoje. Segue o resumo do que já está disponível para testes:

🔹 Calibração e Competitivo:

    Calibração de Nível: Agora são necessárias 5 sessões de terapia para calibrar e definir seu nível inicial no sistema.

    Consistência no Ranking: A nota geral e as colocações passam a exigir consistência, sendo calculadas com base no seu histórico acumulado de múltiplos atendimentos.

🔹 Duelos e Treinamento:

    Duelo Social: Novo módulo com avaliação cruzada e registro de logs.

    Competitivo vs. Treino: Divisão clara entre o sistema competitivo e o de treinamento. Os convites agora podem ser enviados tanto diretamente por WhatsApp quanto pelas notificações internas.

🔹 Simulação Clínica:

    Pacientes Dinâmicos: A dificuldade dos pacientes agora é dinâmica, ajustando-se de forma adaptativa com base nas tentativas de atendimento.

🔹 Sistema e Perfil:

    Notificações: Central de notificações ativa, incluindo o sistema de convites entre usuários.

    Segurança: Liberada a opção para alteração de senha (RECOMENDADO).

    Títulos no Perfil: Implementação inicial da exibição de títulos baseados em conquistas (recurso ainda em desenvolvimento).

Aproveitem os novos recursos e continuem enviando os feedbacks com base na prática de vocês!`,
  },
  {
    date: '2026-05-18',
    title: 'Novo motor de IA (Claude)',
    body: `As simulações de paciente e as avaliações passam a rodar nos modelos Claude (Sonnet 4.6 e Opus 4.7), com respostas mais consistentes e avaliação clínica mais densa. O avaliador foi atualizado para a versão v13.1.`,
  },
  {
    date: '2026-05-15',
    title: 'Ranking, Objetivos e avaliador reformulado',
    body: `• Ranking global de jogadores e Objetivos diários chegaram à plataforma.
• "Minhas Sessões" reorganizada (visões de aluno, professor e admin) e agora exibe a sua maior nota em cada paciente da Simulação.
• Avaliador reformulado (v9), com melhor experiência de pós-sessão e de supervisão.
• Ajustes na foto de perfil padrão.`,
  },
  {
    date: '2026-05-12',
    title: 'Backup de dados e acesso em rede local',
    body: `• Administração: exportação completa dos dados para backup/migração.
• Melhorias de acesso pela rede local, facilitando testes pelo celular.`,
  },
  {
    date: '2026-05-11',
    title: 'Servidor e segurança',
    body: `Correções no servidor (proxy reverso e CORS) e melhorias gerais de segurança.`,
  },
  {
    date: '2026-05-09',
    title: 'Novo fluxo da Simulação',
    body: `A Simulação ganhou um novo fluxo de pós-sessão, a opção de "pular sessão" (time skip) entre encontros, e critério de correção específico por personagem.`,
  },
  {
    date: '2026-05-08',
    title: 'Modo visitante, app instalável e login seguro',
    body: `• Modo visitante: dá pra experimentar a plataforma sem cadastro.
• App instalável (PWA) na tela inicial do Android e do iOS.
• Login seguro com senha (bcrypt + JWT) e gestão de contas pelo administrador.
• Sessões em andamento passam a ser salvas automaticamente (dá pra sair e voltar).
• Interface mobile aprimorada e voz no entrevistador.`,
  },
  {
    date: '2026-05-04',
    title: 'Lançamento da plataforma',
    body: `Primeira versão do all_OS — o sistema operacional da prática deliberada.`,
  },
];

// Data da atualização mais recente (pra marcar "novidades" não vistas).
export const LATEST_UPDATE = CHANGELOG.length ? CHANGELOG[0].date : null;
