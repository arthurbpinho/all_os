// Modelos de IA por CATEGORIA do app — o que a tela Administração → "Modelos de
// IA" edita. Cada categoria tem duas funções configuráveis:
//   avaliador → quem corrige a sessão e emite as notas
//   paciente  → quem interpreta o personagem na conversa
//
// Por que um registro e não as consts soltas de sempre: os modelos já eram
// env-overridáveis, mas trocar exigia editar o .env + o painel do Railway e
// redeployar. Aqui o admin troca em runtime — a escolha vive em settings.json
// (volume persistente) e o resolve acontece A CADA CHAMADA, nunca no boot, então
// a próxima avaliação/mensagem já usa o modelo novo sem reiniciar.
//
// O QUE NÃO ENTRA AQUI (de propósito):
//   - TRILHA. Lá a escolha é POR EXERCÍCIO (TRILHA_EXERCISE_MODELS e
//     TRILHA_CHAT_MODELS em index.js, editadas no editor de exercícios). É
//     controle próprio e nada desta tela toca nele — nem como default.
//   - Laboratórios (Avaliação Independente, Simulação Independente, v25): têm
//     seletor de modelo/effort próprio, isolado da produção.
//   - Entrevistador e Antessala: não são avaliador nem paciente simulado.

// --- Presets do AVALIADOR ---------------------------------------------------
// Três opções fixas (decisão do dono), todas em effort 'high': a avaliação é a
// parte densa do app e é onde a qualidade importa.
//
// `batch` = o provedor expõe Batch API (50% de desconto, janela de até 24h). A
// z.ai NÃO expõe, então GLM é batch:false. Isso não impede escolher GLM em
// lugar nenhum: nas categorias que normalmente vão de batch (Competitivo,
// Processo Seletivo) a avaliação passa a rodar SÍNCRONA em background — mesma
// UX (quem finaliza já vê só o agradecimento; a nota entra no log quando
// chegar), só que mais rápido e sem o desconto.
const EVALUATOR_PRESETS = {
  // Família 5.6 (ago/2026): Sol é o topo (mesmo preço do 5.5) e Luna é o tier
  // barato — 25× abaixo do Sol por token. Ambos em high pelo mesmo motivo dos
  // outros: avaliar é a parte densa.
  'gpt-5.6-sol': {
    label: 'GPT 5.6 Sol high',
    model: 'gpt-5.6-sol', provider: 'openai', effort: 'high', batch: true,
  },
  'gpt-5.6-luna': {
    label: 'GPT 5.6 Luna high',
    model: 'gpt-5.6-luna', provider: 'openai', effort: 'high', batch: true,
  },
  'gpt-5.5': {
    label: 'GPT 5.5 high',
    model: 'gpt-5.5-2026-04-23', provider: 'openai', effort: 'high', batch: true,
  },
  'glm-5.2': {
    label: 'GLM 5.2 high',
    model: 'glm-5.2', provider: 'glm', effort: 'high', batch: false,
    nota: 'z.ai não tem Batch API — roda síncrono (sem o desconto de 50%)',
  },
};

// --- Presets do PACIENTE SIMULADO ------------------------------------------
// O personagem responde DIRETO, sem raciocínio, nas opções OpenAI/Anthropic —
// paciente que "pensa" antes de falar soa artificial e atrasa o turno. Cada
// provedor desliga o raciocínio de um jeito diferente:
//   OpenAI    → reasoning_effort: 'none'
//   Anthropic → thinking: { type: 'disabled' }  (effort 'disabled' aqui)
//   GLM       → só existe na lista em 'high' (a opção pedida pelo dono), então
//               esse é o único preset de paciente COM raciocínio: mais nuançado,
//               porém mais lento e com o reasoning cobrado como saída.
const PATIENT_PRESETS = {
  // Sol e Luna entram COM raciocínio (high), a pedido do dono — são, junto do
  // GLM, as únicas opções de paciente que pensam antes de falar. Custam mais
  // tempo de turno; a comparação de naturalidade é o ponto.
  'gpt-5.6-sol': {
    label: 'GPT 5.6 Sol high',
    model: 'gpt-5.6-sol', provider: 'openai', effort: 'high',
    nota: 'paciente com raciocínio — turno mais lento',
  },
  'gpt-5.6-luna': {
    label: 'GPT 5.6 Luna high',
    model: 'gpt-5.6-luna', provider: 'openai', effort: 'high',
    nota: 'paciente com raciocínio, no tier mais barato da tabela',
  },
  'gpt-5.4-mini': {
    label: 'GPT 5.4 mini',
    model: 'gpt-5.4-mini-2026-03-17', provider: 'openai', effort: 'none',
    nota: 'paciente padrão de produção — mais rápido e mais barato',
  },
  'glm-5.2': {
    label: 'GLM 5.2 high',
    model: 'glm-5.2', provider: 'glm', effort: 'high',
    nota: 'único preset de paciente com raciocínio — mais lento',
  },
  'gpt-5.4': {
    label: 'GPT 5.4 effort none',
    model: 'gpt-5.4-2026-03-05', provider: 'openai', effort: 'none',
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5 effort none',
    model: 'claude-sonnet-5', provider: 'anthropic', effort: 'disabled',
  },
};

// --- Categorias -------------------------------------------------------------
// `batchCapable` = a categoria PODE avaliar em batch, ou seja, ninguém está
// esperando a nota na tela. Só é verdade onde quem finalizou a sessão já sai
// sem nota nenhuma (Competitivo: "nota em até 24h"; Seletivo: o candidato nunca
// vê nota). Nas outras a nota volta na mesma requisição, então batch está fora
// de questão por construção — não é preferência.
//
// `patient: false` = categoria que não tem paciente simulado (a aba Avaliar
// Sessão corrige um log que já existe).
const AI_CATEGORIES = [
  {
    key: 'treinamento',
    label: 'Treinamento e Progressão',
    descricao: 'Simulação em modo treino, incluindo reatendimento (progressão), sidequests e missão diária. Maior volume do app.',
    patient: true, batchCapable: false,
  },
  {
    key: 'competitivo',
    label: 'Competitivo',
    descricao: 'Simulação que vale MMR e ranking. O aluno finaliza sem ver nota ("em até 24h"), então a avaliação pode ir de batch.',
    patient: true, batchCapable: true,
  },
  {
    key: 'seletivo',
    label: 'Processo Seletivo',
    descricao: 'Avaliação de candidatos externos pelo link fixo. O candidato nunca vê nota nem feedback — avaliação sempre assíncrona.',
    patient: true, batchCapable: true,
  },
  {
    key: 'visitante',
    label: 'Visitante',
    descricao: 'Sessões de quem entra como visitante (palestras/eventos). Só avalia enquanto o botão acima estiver ligado.',
    patient: true, batchCapable: false,
  },
  {
    key: 'duelo',
    label: 'Duelo',
    descricao: 'Avaliação comparativa entre dois alunos no mesmo personagem. O resultado aparece ao final do duelo.',
    patient: true, batchCapable: false,
  },
  {
    key: 'desafio',
    label: 'Modo Desafio',
    descricao: 'Titular × desafiante. Saída opaca (sem nota na tela), mas o resultado sai na hora.',
    patient: true, batchCapable: false,
  },
  {
    key: 'neuro',
    label: 'Neuroavaliação',
    descricao: 'Bateria de testes neuropsicológicos. Sessão única e mais delimitada que o processo clínico completo.',
    patient: true, batchCapable: false,
  },
  {
    key: 'avaliacaoManual',
    label: 'Avaliar Sessão (supervisor)',
    descricao: 'Correção manual de um log já existente, na aba Avaliar Sessão. Não tem paciente simulado.',
    patient: false, batchCapable: false,
  },
];

const CATEGORY_BY_KEY = Object.fromEntries(AI_CATEGORIES.map((c) => [c.key, c]));

function isCategory(key) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_BY_KEY, String(key));
}
// Categorias que têm paciente simulado.
function isPatientCategory(key) {
  return isCategory(key) && CATEGORY_BY_KEY[String(key)].patient === true;
}

// Categorias que o CLIENTE pode declarar em /api/chat (context.category).
// Deliberadamente menor que isPatientCategory: são só os modos que um usuário
// logado de fato inicia sozinho na interface. Ficam de fora, de propósito:
//   - 'seletivo'  → o candidato tem rota própria (/api/selecao/chat) e nem token
//                   normal tem; aceitar aqui deixaria um aluno rodar o paciente
//                   (possivelmente caro) do Seletivo nos treinos dele;
//   - 'visitante' → derivado do ROLE no servidor, não é dica;
//   - 'neuro'     → derivado do context.type no servidor;
//   - 'avaliacaoManual' → não tem paciente.
const CLIENT_PATIENT_CATEGORIES = new Set(['treinamento', 'competitivo', 'duelo', 'desafio']);
function isClientPatientCategory(key) {
  return CLIENT_PATIENT_CATEGORIES.has(String(key));
}
function isEvaluatorPreset(key) {
  return Object.prototype.hasOwnProperty.call(EVALUATOR_PRESETS, String(key));
}
function isPatientPreset(key) {
  return Object.prototype.hasOwnProperty.call(PATIENT_PRESETS, String(key));
}

// Escolhas do admin dentro de settings.json, saneadas: descarta categoria
// desconhecida e preset inválido em vez de deixar entrar lixo no resolve.
function readCategoryChoices(settings) {
  const raw = (settings && settings.aiModels) || {};
  const out = {};
  for (const [cat, val] of Object.entries(raw)) {
    if (!isCategory(cat) || !val || typeof val !== 'object') continue;
    const entry = {};
    if (isEvaluatorPreset(val.evaluator)) entry.evaluator = val.evaluator;
    if (isPatientPreset(val.patient) && CATEGORY_BY_KEY[cat].patient) entry.patient = val.patient;
    if (Object.keys(entry).length) out[cat] = entry;
  }
  return out;
}

// PADRÃO GLOBAL (settings.aiModelsGlobal): uma escolha que vale para TODAS as
// categorias de uma vez, para o dono não ter de trocar oito categorias à mão
// quando quer experimentar um modelo novo no app inteiro. Precedência:
//   escolha da categoria  >  padrão global  >  padrão do sistema (env/código)
// Ou seja, o global não atropela quem tem escolha própria — e limpar a escolha
// de uma categoria a devolve ao global, não direto ao padrão do sistema.
// A Trilha continua fora (escolha por exercício), como o resto desta tela.
function readGlobalChoice(settings) {
  const raw = (settings && settings.aiModelsGlobal) || {};
  const out = {};
  if (isEvaluatorPreset(raw.evaluator)) out.evaluator = raw.evaluator;
  if (isPatientPreset(raw.patient)) out.patient = raw.patient;
  return out;
}

// Grava/limpa o padrão global. `null`/'' limpa aquele campo.
function applyGlobalChoice(settings, { evaluator, patient } = {}) {
  const atual = readGlobalChoice(settings);
  if (evaluator !== undefined) {
    if (evaluator === null || evaluator === '') delete atual.evaluator;
    else if (!isEvaluatorPreset(evaluator)) return { ok: false, error: 'Modelo de avaliador inválido.' };
    else atual.evaluator = evaluator;
  }
  if (patient !== undefined) {
    if (patient === null || patient === '') delete atual.patient;
    else if (!isPatientPreset(patient)) return { ok: false, error: 'Modelo de paciente inválido.' };
    else atual.patient = patient;
  }
  return { ok: true, aiModelsGlobal: atual };
}

// Aplica uma escolha do admin sobre o mapa atual, devolvendo o mapa novo.
// `null`/'' em qualquer campo LIMPA a escolha (volta ao padrão do sistema).
function applyCategoryChoice(settings, categoria, { evaluator, patient } = {}) {
  const atual = readCategoryChoices(settings);
  if (!isCategory(categoria)) return { ok: false, error: 'Categoria inválida.' };
  const cat = CATEGORY_BY_KEY[categoria];
  const entry = { ...(atual[categoria] || {}) };

  if (evaluator !== undefined) {
    if (evaluator === null || evaluator === '') delete entry.evaluator;
    else if (!isEvaluatorPreset(evaluator)) return { ok: false, error: 'Modelo de avaliador inválido.' };
    else entry.evaluator = evaluator;
  }
  if (patient !== undefined) {
    if (!cat.patient) return { ok: false, error: `A categoria "${cat.label}" não tem paciente simulado.` };
    if (patient === null || patient === '') delete entry.patient;
    else if (!isPatientPreset(patient)) return { ok: false, error: 'Modelo de paciente inválido.' };
    else entry.patient = patient;
  }

  if (Object.keys(entry).length) atual[categoria] = entry;
  else delete atual[categoria];
  return { ok: true, aiModels: atual };
}

// Resolve o spec que vai rodar, na ordem: escolha da categoria → padrão global
// → `fallback` (as consts de env/código de sempre). O fallback é o que vale
// quando ninguém escolheu nada — assim ligar esta tela não muda comportamento
// nenhum até alguém mexer.
//
// Devolve, além do spec: `preset` (chave do preset equivalente, pra UI casar o
// select) e `fonte` ('admin' | 'global' | 'padrao' — sem acento: o front compara
// com a string crua, então nada de caractere que dependa de encoding no caminho).
function resolveSpec({ presets, choice, global, fallback, batchCapable }) {
  const escolhido = [[choice, 'admin'], [global, 'global']]
    .find(([k]) => k && Object.prototype.hasOwnProperty.call(presets, k));
  if (escolhido) {
    const [key, fonte] = escolhido;
    const p = presets[key];
    return {
      preset: key, label: p.label, model: p.model, provider: p.provider, effort: p.effort,
      batch: !!batchCapable && p.batch === true,
      fonte,
    };
  }
  // Sem escolha: usa o fallback como está. O preset "equivalente" é só rótulo
  // pra UI — casa pelo prefixo do id do modelo, então sobrevive a troca de pin.
  const equivalente = Object.keys(presets).find((k) => String(fallback.model || '').startsWith(k)) || null;
  return {
    preset: equivalente,
    label: equivalente ? presets[equivalente].label : String(fallback.model || ''),
    model: fallback.model, provider: fallback.provider, effort: fallback.effort,
    // Só OpenAI expõe Batch API entre os provedores em uso.
    batch: !!batchCapable && fallback.provider === 'openai',
    fonte: 'padrao',
  };
}

function resolveEvaluator(categoria, settings, fallback) {
  const cat = CATEGORY_BY_KEY[String(categoria)];
  if (!cat) throw new Error(`Categoria de IA desconhecida: ${categoria}`);
  const choices = readCategoryChoices(settings);
  return resolveSpec({
    presets: EVALUATOR_PRESETS,
    choice: choices[cat.key] && choices[cat.key].evaluator,
    global: readGlobalChoice(settings).evaluator,
    fallback,
    batchCapable: cat.batchCapable,
  });
}

function resolvePatient(categoria, settings, fallback) {
  const cat = CATEGORY_BY_KEY[String(categoria)];
  if (!cat) throw new Error(`Categoria de IA desconhecida: ${categoria}`);
  if (!cat.patient) throw new Error(`Categoria sem paciente simulado: ${categoria}`);
  const choices = readCategoryChoices(settings);
  // Paciente nunca vai de batch (é conversa ao vivo) — batchCapable false.
  return resolveSpec({
    presets: PATIENT_PRESETS,
    choice: choices[cat.key] && choices[cat.key].patient,
    global: readGlobalChoice(settings).patient,
    fallback,
    batchCapable: false,
  });
}

// Catálogo pra tela do admin: as opções + o que cada categoria está rodando
// AGORA (spec efetivo, já com o padrão aplicado quando não há escolha).
function catalogo({ settings, fallbacks }) {
  const global = readGlobalChoice(settings);
  return {
    // Padrão global: as chaves escolhidas (ou '' quando não há) + o rótulo, pra
    // a tela mostrar "seguindo o padrão global (X)" nas categorias sem escolha.
    padraoGlobal: {
      evaluator: global.evaluator || '',
      patient: global.patient || '',
      evaluatorLabel: global.evaluator ? EVALUATOR_PRESETS[global.evaluator].label : '',
      patientLabel: global.patient ? PATIENT_PRESETS[global.patient].label : '',
    },
    avaliadorOpcoes: Object.entries(EVALUATOR_PRESETS).map(([key, p]) => ({
      key, label: p.label, provider: p.provider, effort: p.effort, batch: p.batch, nota: p.nota || '',
    })),
    pacienteOpcoes: Object.entries(PATIENT_PRESETS).map(([key, p]) => ({
      key, label: p.label, provider: p.provider, effort: p.effort, nota: p.nota || '',
    })),
    categorias: AI_CATEGORIES.map((cat) => ({
      key: cat.key,
      label: cat.label,
      descricao: cat.descricao,
      batchCapable: cat.batchCapable,
      temPaciente: cat.patient,
      avaliador: resolveEvaluator(cat.key, settings, fallbacks[cat.key].evaluator),
      paciente: cat.patient ? resolvePatient(cat.key, settings, fallbacks[cat.key].patient) : null,
    })),
  };
}

module.exports = {
  EVALUATOR_PRESETS,
  PATIENT_PRESETS,
  AI_CATEGORIES,
  isCategory,
  isPatientCategory,
  isClientPatientCategory,
  isEvaluatorPreset,
  isPatientPreset,
  readCategoryChoices,
  applyCategoryChoice,
  readGlobalChoice,
  applyGlobalChoice,
  resolveEvaluator,
  resolvePatient,
  catalogo,
};
