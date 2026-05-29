// Notas de atualização do all_OS — exibidas no painel "Atualizações do sistema"
// (ícone de bloco de notas com exclamação, ao lado das notificações).
//
// Uma entrada por dia (mesmo que tenham sido vários commits no mesmo dia),
// sintetizada a partir do histórico do projeto. Mais recente primeiro.
// `date` em ISO (YYYY-MM-DD); `body` aceita quebras de linha (renderizado em
// pre-wrap).

export const CHANGELOG = [
  {
    date: '2026-05-29',
    title: 'Homepage, conquistas reformuladas, missão diária e mais',
    body: `🔹 Nova tela inicial (Início):
• Uma homepage com o slogan do all_OS, a sua missão diária e a seção "Quatro formas de praticar" (Treinamento, Modo Desafio, Competitivo e Duelo). A tela de login ficou limpa.

🔹 Objetivos e Metas reformulados:
• As conquistas agora são RESGATÁVEIS: quando você cumpre o requisito, aparece o botão "Resgatar". Conquistas com meta numérica ganharam barra de progresso, e elas estão separadas por dificuldade (bronze, prata e ouro).
• Só conquistas de OURO podem virar título de perfil.
• Várias conquistas novas (ranqueadas, duelos, coroas, foto de perfil, microfone…) e ajustes nas existentes.

🔹 Missão diária:
• Além da sidequest do seu supervisor, todo dia entra uma missão diária (rotaciona à meia-noite) que vale recompensa. As duas coexistem — uma não anula a outra.

🔹 Competitivo — calibração mais curta:
• A calibração caiu de 5 para 3 partidas. O seu MMR aparece a partir da 4ª partida competitiva; quem já fez 3+ partidas passa a ter o MMR visível.

🔹 Limite de tempo nas sessões:
• Toda sessão tem limite de 200 minutos. O cronômetro só corre enquanto você está no chat — sair do app, trocar de aba ou bloquear a tela pausa a contagem.

🔹 Correções no celular:
• O painel de Atualizações parou de vazar para fora da tela, e o botão de editar personagem no admin passou a funcionar no modo retrato.`,
  },
  {
    date: '2026-05-28',
    title: 'Avaliação de volta no Treinamento + correções',
    body: `Resumo do que entrou hoje:

🔹 Avaliação sempre presente:
• O Treinamento voltou a receber avaliação ao final de cada atendimento — e a progressão de cada paciente também. Agora SEMPRE tem feedback, não importa o modo da sessão.
• A nota do Treinamento conta para a sua evolução naquele paciente, mas não entra no Competitivo (o ranking continua valendo só pelo Competitivo).

🔹 Modo Desafio (👑):
• Quem reivindica um paciente (o primeiro a assumir, quando ninguém é Titular) agora também recebe a avaliação do próprio atendimento — antes ficava só com o log.
• A nota do Modo Desafio nunca aparece: o que vale é o resultado (assumir ou não a posição) e a análise em texto.

🔹 Atualizações no celular:
• Corrigido o painel de Atualizações, que estava mal formatado e cortando parte da tela no celular.`,
  },
  {
    date: '2026-05-26',
    title: 'Modo Desafio e logs mais limpos',
    body: `🔹 Modo Desafio (👑):
• Dispute a "titularidade" de um paciente. Quando ninguém é Titular, você reivindica a posição; havendo um Titular, você o desafia e a IA decide quem fica com a coroa.
• O título 👑 do paciente aparece no seu perfil enquanto você for o Titular.

🔹 Logs mais limpos:
• O log exportado ficou enxuto: o cabeçalho foi reduzido e a nota geral aparece apenas dentro da seção "Avaliação da IA".`,
  },
  {
    date: '2026-05-25',
    title: 'Progressão e Side Quests no Treinamento',
    body: `🔹 Treinamento (antes "Simulação Livre"):
• A Simulação Livre virou Treinamento, e a progressão passou a acontecer dentro dele: ao reatender um paciente, a avaliação leva em conta o atendimento anterior e o seu feedback, acompanhando a sua evolução no caso.

🔹 Side Quests:
• Objetivos especiais atribuídos pelo seu supervisor. Quando uma está ativa, ela vira o objetivo principal do atendimento; ao cumpri-la, você ganha um título de recompensa.

🔹 Aba "Terapeutas" (supervisores e admin):
• Banco de side quests, atribuição aos alunos e histórico — com atalhos para os logs e para avaliar a sessão.`,
  },
  {
    date: '2026-05-20',
    title: 'Atualizações Importantes ⚠️',
    body: `Olá, pessoal! Temos novos recursos e correções implementados na plataforma hoje. Segue o resumo do que já está disponível para testes:

🔹 Calibração e Competitivo:
• Calibração de Nível: agora são necessárias 5 sessões de terapia para calibrar e definir seu nível inicial no sistema.
• Consistência no Ranking: a nota geral e as colocações passam a exigir consistência, sendo calculadas com base no seu histórico acumulado de múltiplos atendimentos.

🔹 Duelos e Treinamento:
• Duelo Social: novo módulo com avaliação cruzada e registro de logs.
• Competitivo vs. Treino: divisão clara entre o sistema competitivo e o de treinamento. Os convites agora podem ser enviados tanto por WhatsApp quanto pelas notificações internas.

🔹 Simulação Clínica:
• Pacientes Dinâmicos: a dificuldade dos pacientes agora é dinâmica, ajustando-se de forma adaptativa com base nas tentativas de atendimento.

🔹 Sistema e Perfil:
• Notificações: central de notificações ativa, incluindo o sistema de convites entre usuários.
• Segurança: liberada a opção para alteração de senha (RECOMENDADO).
• Títulos no Perfil: exibição inicial de títulos baseados em conquistas.

🔹 Logs Sociais e Duelos (correções):
• Cancelar convite: agora dá pra cancelar um convite de duelo que ainda não foi aceito. Duelos em andamento ou concluídos não podem ser excluídos.
• Baixar o log: nos duelos concluídos, dá pra baixar o log completo (avaliação cruzada + notas + as duas sessões). Cada pessoa só acessa os próprios duelos, e tudo é apagado automaticamente 30 dias após a criação.
• Layout no celular: corrigida a formatação do painel de Atualizações/Notificações e da lista de Logs Sociais.

🔹 Avaliação e Logs (correções):
• Avaliação na nuvem: corrigido o erro que deixava a avaliação "sem resposta" em sessões mais longas — a análise agora chega de forma contínua, sem travar.
• Avaliador correto: a avaliação de sessão voltou a usar o avaliador certo (v15).
• Copiar e baixar logs: em todos os lugares com log, agora dá pra copiar ou baixar separadamente o log, a avaliação, ou os dois juntos.

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
