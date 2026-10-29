// Simulação Independente — laboratório de PRICING do PACIENTE (supervisor/admin).
//
// Irmão da Avaliação Independente, mas do outro lado da mesa: aqui o que roda é
// a IA que CONVERSA com o aluno (o personagem), não o avaliador. O objetivo é
// custo × qualidade: você conversa com o personagem trocando MODELO e EFFORT e vê
// o custo REAL (tokens × preço) turno a turno, em tempo real — sem avaliador.
//
// ISOLADO: só LÊ o prompt do personagem (mesmo buildFreeplayPrompt da produção).
// Não grava log, não pontua, não mexe em gamificação. Nada daqui altera o
// /api/chat de produção.
//
// Por que uma tabela de preços PRÓPRIA (e não a do avaliador):
//   1. resolvePrices() do avaliacao-v25 dá override por env (AVALIACAO_V25_PRICE_*),
//      que é do laboratório do avaliador — se o dono setar aquilo, o custo daqui
//      sairia errado;
//   2. aqui a tabela tem a coluna de ESCRITA de cache (1,25× o input), que a de
//      lá não modela.
//
// Só OpenAI desde 2026-10 (Anthropic e GLM saíram do app). O paciente "não pensa"
// com reasoning_effort: 'none' (o que a produção usa no gpt-5.4-mini).

// Teto de tokens por resposta do personagem. A produção usa 1500 + folga pro
// canal de raciocínio; mantemos o mesmo teto pra o custo ser comparável.
const SIM_MAX_TOKENS = Number(process.env.SIM_INDEP_MAX_TOKENS || 1500);
const SIM_REASONING_HEADROOM = 2000;

// Modelos do alternador. `id` é o id pinado que vai à API; `efforts` são só os
// valores que aquele modelo ACEITA (o primeiro é o default e o mais barato).
// A lista de opções é a definida pelo dono (jul/2026): mini sem raciocínio (o de
// produção), 5.4 e 5.5 em medium/high, mais a família 5.6.
const SIM_MODELOS = {
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini-2026-03-17', provider: 'openai', label: 'GPT 5.4 mini',
    efforts: ['none'], nota: 'modelo do paciente em produção hoje (sem raciocínio)',
  },
  // Família 5.6 (lançada 09/07/2026), os dois tiers ABAIXO do flagship. O Sol não
  // entra aqui de propósito: paciente é alto volume e resposta direta, então o
  // topo de linha não é candidato — o interesse é o contrário, descer de preço.
  // 'none' primeiro porque é a configuração comparável à de produção (personagem
  // responde direto); medium/high ficam pra testar um paciente mais nuançado,
  // igual ao que o 5.4/5.5 já oferecem aqui.
  'gpt-5.6-luna': {
    id: 'gpt-5.6-luna', provider: 'openai', label: 'GPT 5.6 Luna',
    efforts: ['none', 'medium', 'high'],
    nota: 'mais barato que o mini de produção ($0,20 vs $0,75 input)',
  },
  'gpt-5.6-terra': {
    id: 'gpt-5.6-terra', provider: 'openai', label: 'GPT 5.6 Terra',
    efforts: ['none', 'medium', 'high'],
  },
  'gpt-5.4': {
    id: 'gpt-5.4-2026-03-05', provider: 'openai', label: 'GPT 5.4',
    efforts: ['medium', 'high'],
  },
  'gpt-5.5': {
    id: 'gpt-5.5-2026-04-23', provider: 'openai', label: 'GPT 5.5',
    efforts: ['medium', 'high'],
  },
};

// Preços em USD por 1 MILHÃO de tokens, em quatro colunas:
//   cacheRead  = ler um prefixo já cacheado (0,1× do input)
//   cacheWrite = GRAVAR o prefixo no cache, a 1,25× o input (conferido em
//                developers.openai.com/api/docs/pricing, ago/2026 — a tabela de
//                lá tem coluna própria de cache write). A OpenAI não separa esses
//                tokens no usage (vêm dentro do input), então normalizeSimUsage
//                deixa cacheWrite em 0 e o preço da coluna fica inerte. Consequência: o custo OpenAI mostrado
//                aqui é um PISO, subestimado em até 25% sobre a parcela de prefixo
//                NOVO (só o 1º turno de cada conversa; do 2º em diante é leitura,
//                que é medida certo). O erro é igual em todos os modelos OpenAI,
//                então a comparação entre eles segue justa. O preço já está certo
//                na tabela pra valer sozinho se um dia a OpenAI reportar o campo.
// Modelo fora da tabela → custo null (a tela mostra tokens, nunca um dólar errado).
const SIM_PRICES = {
  // OpenAI (docs, jul/2026) — mesmas referências da Avaliação Independente.
  'gpt-5.5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, cacheWrite: 0.9375, output: 4.5 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15 },
  // Família 5.6 (docs OpenAI, conferido ago/2026). Tier padrão (<272K tokens/req);
  // acima disso a OpenAI dobra o input e faz 1,5× o output, mas um turno de
  // paciente fica muito longe desse limite.
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
};

function isValidSimModel(key) {
  return Object.prototype.hasOwnProperty.call(SIM_MODELOS, key);
}
function simModelInfo(key) {
  return SIM_MODELOS[key] || null;
}
// Catálogo enxuto pra UI: rótulo, provedor, efforts válidos e preços.
function simCatalogo() {
  return Object.entries(SIM_MODELOS).map(([key, m]) => ({
    key, label: m.label, provider: m.provider, efforts: m.efforts,
    nota: m.nota || '', precos: SIM_PRICES[key] || null,
  }));
}
function resolveSimPrices(modelKey) {
  return SIM_PRICES[modelKey] || null;
}

// ── Montagem da chamada ─────────────────────────────────────────────────────

// Normaliza os turnos vindos do cliente: só user/assistant com conteúdo, e
// colapsa turnos consecutivos do mesmo papel.
function normalizeTurns(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content || '');
    if (!content) continue;
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += '\n\n' + content;
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

// /v1/chat/completions. O system vai como 'developer' (papel de instrução dos
// reasoning models) — mesmo formato do /api/chat de produção, então o prompt
// caching automático da OpenAI pega o prefixo igual.
function buildSimChatBody({ model, effort, systemPrompt, turns }) {
  const cap = SIM_MAX_TOKENS + (effort === 'none' ? 0 : SIM_REASONING_HEADROOM);
  return {
    model,
    messages: [{ role: 'developer', content: systemPrompt }, ...turns],
    max_completion_tokens: cap,
    reasoning_effort: effort, // 'none' | 'low' | 'medium' | 'high'
  };
}

// Texto da resposta.
function extractSimText(provider, resp) {
  const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
  const c = (msg && msg.content) || '';
  // Defesa: um <think> embutido no content fica fora do que o aluno lê.
  return String(c).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ── Custo ───────────────────────────────────────────────────────────────────
// Normaliza o `usage` num shape único:
//   input      = tokens de entrada cobrados a preço cheio (JÁ sem os de cache)
//   cacheRead  = tokens lidos do cache
//   cacheWrite = tokens gravados no cache (a OpenAI não reporta: fica 0)
//   output     = tokens gerados (inclui reasoning, que é cobrado como saída)
//   reasoning  = quanto do output foi raciocínio (informativo)
function normalizeSimUsage(provider, usage) {
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  if (!usage) return zero;
  // chat.completions
  const promptTotal = usage.prompt_tokens != null ? usage.prompt_tokens : (usage.input_tokens || 0);
  const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const completion = usage.completion_tokens != null ? usage.completion_tokens : (usage.output_tokens || 0);
  const total = usage.total_tokens != null ? usage.total_tokens : 0;
  // completion_tokens pode sub-reportar o raciocínio; usa total-prompt como piso
  // da saída (mesma correção da Avaliação Independente).
  const output = Math.max(completion, total > promptTotal ? total - promptTotal : 0);
  const reasoning = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
  return { input: Math.max(0, promptTotal - cacheRead), cacheRead, cacheWrite: 0, output, reasoning };
}

// Custo em USD de um conjunto de totais (um turno ou a conversa somada).
function computeSimCost(modelKey, totais) {
  const p = resolveSimPrices(modelKey);
  if (!p) return null;
  const componentes = {
    input: (totais.input * p.input) / 1e6,
    cacheRead: (totais.cacheRead * p.cacheRead) / 1e6,
    cacheWrite: (totais.cacheWrite * p.cacheWrite) / 1e6,
    output: (totais.output * p.output) / 1e6,
  };
  const usd = componentes.input + componentes.cacheRead + componentes.cacheWrite + componentes.output;
  return { usd, moeda: 'USD', componentes, precosPorMTok: p };
}

function somaTotais(a, b) {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

module.exports = {
  SIM_MODELOS,
  SIM_PRICES,
  SIM_MAX_TOKENS,
  isValidSimModel,
  simModelInfo,
  simCatalogo,
  resolveSimPrices,
  normalizeTurns,
  buildSimChatBody,
  extractSimText,
  normalizeSimUsage,
  computeSimCost,
  somaTotais,
};
