// Controle de acesso por funcionalidade (demandas.md §16.2) — lógica PURA.
//
// Matriz funcionalidade × perfil, editada pelo admin em Administração → Acessos.
// Três perfis: Terapeuta da Allos (therapist), Terapeuta externo (external) e
// Visitante (visitor). Admin, supervisor e avaliador não entram: o acesso deles
// vem do papel, e bloquear o admin seria um jeito de se trancar para fora.
//
// O catálogo mora AQUI e só aqui: a tela de Acessos e o cadeado do menu leem a
// lista pelo servidor, e o middleware requireFeature (index.js) usa a mesma
// lista para recusar a request — o menu é conveniência, o servidor é a trava.
//
// A matriz só RESTRINGE. Marcar uma caixa não abre o que o papel já não
// alcançava (as telas "em desenvolvimento" continuam só do admin; o visitante
// continua só com o duelo pelo link). Por isso o sistema nasce com tudo marcado
// para os três perfis e nada muda no deploy — decisão do cliente, e o oposto do
// Genus Praxis, onde o visitante nasce bloqueado.

const PERFIS = [
  { key: 'therapist', label: 'Terapeuta da Allos' },
  { key: 'external', label: 'Terapeuta externo' },
  { key: 'visitor', label: 'Visitante' },
];
const PERFIL_KEYS = PERFIS.map((p) => p.key);

const FUNCIONALIDADES = [
  { key: 'simulacao', label: 'Simulação (atendimento)', descricao: 'Atender os pacientes simulados na Página Inicial, no Treinamento e no Competitivo.' },
  { key: 'competitivo', label: 'Competitivo', descricao: 'Partidas que valem MMR e recorde 👑. Desligado, o Treinamento continua.' },
  { key: 'avaliacao', label: 'Avaliação por IA', descricao: 'Nota e feedback automáticos ao fim do atendimento. É o que mais custa: cada avaliação são várias chamadas de IA.' },
  { key: 'graficoCriterios', label: 'Notas por critério e gráfico', descricao: 'Ver as próprias notas de cada critério: o gráfico da sessão e o do perfil. As análises escritas continuam só com supervisor e admin.' },
  { key: 'duelo', label: 'Duelo', descricao: 'Criar e aceitar duelos. Duelos já aceitos podem ser terminados.' },
  { key: 'logsSociais', label: 'Logs de duelos', descricao: 'Histórico de duelos agrupado por oponente.' },
  { key: 'ranking', label: 'Ranking', descricao: 'Tabela de posições por MMR.' },
  { key: 'comunidade', label: 'Comunidade', descricao: 'Feed, discussões, comentários e votos. O link público de uma discussão continua abrindo.' },
  { key: 'objetivos', label: 'Objetivos e metas', descricao: 'Resgatar conquistas.' },
  { key: 'progressao', label: 'Progressão', descricao: 'Reatender um paciente e medir a evolução (hoje em desenvolvimento, só o admin abre).' },
  { key: 'trilha', label: 'Trilha', descricao: 'Exercícios de prática deliberada (hoje em desenvolvimento, só o admin abre).' },
  { key: 'neuro', label: 'Avaliação Neuro', descricao: 'Casos de neuroavaliação (hoje só supervisor e admin abrem).' },
  { key: 'antessala', label: 'Antessala', descricao: 'Mapa de caso antes da supervisão.' },
];
const FUNCIONALIDADE_KEYS = FUNCIONALIDADES.map((f) => f.key);

const MENSAGEM_PADRAO = 'Esta funcionalidade não está disponível para o seu perfil. Fale com o suporte da Allos se precisar dela.';
const MENSAGEM_MAX = 600;

// Matriz de um sistema novo: tudo liberado.
function matrizPadrao() {
  const m = {};
  for (const f of FUNCIONALIDADES) m[f.key] = Object.fromEntries(PERFIL_KEYS.map((p) => [p, true]));
  return m;
}

// Normaliza o que veio do banco ou do admin contra o catálogo: chave
// desconhecida sai, a que faltar entra liberada (uma funcionalidade nova de um
// deploy nunca nasce bloqueada), valor vira booleano.
function normalizarMatriz(raw) {
  const m = matrizPadrao();
  if (!raw || typeof raw !== 'object') return m;
  for (const f of FUNCIONALIDADES) {
    const linha = raw[f.key];
    if (!linha || typeof linha !== 'object') continue;
    for (const p of PERFIL_KEYS) if (p in linha) m[f.key][p] = !!linha[p];
  }
  return m;
}

function normalizarMensagem(v) {
  return String(v == null ? '' : v).trim().slice(0, MENSAGEM_MAX);
}

// O usuário pode usar a funcionalidade? Quem está fora da matriz pode sempre.
function podeUsar(matriz, user, chave) {
  const perfil = user && user.role;
  if (!PERFIL_KEYS.includes(perfil)) return true;
  const linha = normalizarMatriz(matriz)[chave];
  return linha ? !!linha[perfil] : true;
}

// Chaves bloqueadas para o usuário (o cliente desenha o cadeado nelas).
function bloqueadasPara(matriz, user) {
  return FUNCIONALIDADE_KEYS.filter((k) => !podeUsar(matriz, user, k));
}

// Funcionalidade de um atendimento, pelo contexto que o cliente manda ao chat e à avaliação.
function funcionalidadeDoContexto(context) {
  const tipo = context && context.type;
  if (tipo === 'exercise') return 'trilha';
  if (tipo === 'neuro') return 'neuro';
  if (tipo === 'freeplay') return 'simulacao';
  return null;
}

module.exports = {
  PERFIS,
  PERFIL_KEYS,
  FUNCIONALIDADES,
  FUNCIONALIDADE_KEYS,
  MENSAGEM_PADRAO,
  matrizPadrao,
  normalizarMatriz,
  normalizarMensagem,
  podeUsar,
  bloqueadasPara,
  funcionalidadeDoContexto,
};
