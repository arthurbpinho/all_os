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
//   2. aqui entram modelos que o avaliador não usa (Anthropic), e a Anthropic cobra
//      ESCRITA de cache mais caro que input (1,25×), o que a tabela de lá não modela.
//
// Três provedores, três formas de "não pensar" (o paciente responde direto):
//   OpenAI    → reasoning_effort: 'none' (o que a produção usa no gpt-5.4-mini)
//   GLM/z.ai  → thinking: { type: 'disabled' }
//   Anthropic → thinking: { type: 'disabled' } (Sonnet 5) ou simplesmente omitir
//               (Haiku 4.5 é pré-4.6: sem o campo, não pensa; e não aceita effort)

// Teto de tokens por resposta do personagem. A produção usa 1500 + folga pro
// canal de raciocínio; mantemos o mesmo teto pra o custo ser comparável.
const SIM_MAX_TOKENS = Number(process.env.SIM_INDEP_MAX_TOKENS || 1500);
const SIM_REASONING_HEADROOM = 2000;

// Modelos do alternador. `id` é o id pinado que vai à API; `efforts` são só os
// valores que aquele modelo ACEITA (o primeiro é o default e o mais barato).
// `thinking: 'omit'` = não manda campo de raciocínio nenhum (Haiku 4.5).
// A lista de opções é a definida pelo dono (jul/2026): mini sem raciocínio (o de
// produção), 5.4 e 5.5 em medium/high, GLM em high e Sonnet 5 sem raciocínio.
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
  'glm-5.2': {
    id: 'glm-5.2', provider: 'glm', label: 'GLM 5.2 (z.ai)',
    efforts: ['high'],
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5', provider: 'anthropic', label: 'Claude Sonnet 5',
    efforts: ['disabled'], nota: 'sem raciocínio (o paciente responde direto)',
  },
};

// Preços em USD por 1 MILHÃO de tokens. Quatro colunas porque os provedores
// cobram cache de formas diferentes:
//   cacheRead  = ler um prefixo já cacheado (OpenAI 0,1× do input; Anthropic 0,1×)
//   cacheWrite = GRAVAR o prefixo no cache, a 1,25× o input na OpenAI E na
//                Anthropic (conferido em developers.openai.com/api/docs/pricing,
//                ago/2026 — a tabela de lá tem coluna própria de cache write).
//                DIFERENÇA que importa: a Anthropic REPORTA esses tokens em
//                cache_creation_input_tokens, então na Anthropic o custo sai
//                exato; a OpenAI não os separa no usage (vêm dentro do input),
//                então normalizeSimUsage deixa cacheWrite em 0 e o preço da coluna
//                fica inerte para OpenAI. Consequência: o custo OpenAI mostrado
//                aqui é um PISO, subestimado em até 25% sobre a parcela de prefixo
//                NOVO (só o 1º turno de cada conversa; do 2º em diante é leitura,
//                que é medida certo). O erro é igual em todos os modelos OpenAI,
//                então a comparação entre eles segue justa. O preço já está certo
//                na tabela pra valer sozinho se um dia a OpenAI reportar o campo.
//                GLM: não verifiquei se a z.ai cobra prêmio — mantido igual ao
//                input, como estava.
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
  // GLM-5.2 (docs.z.ai, jul/2026). Reasoning cobrado como output.
  'glm-5.2': { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  // Anthropic (docs, jul/2026). Sonnet 5 tem preço promocional de lançamento
  // ($2/$10) até 2026-08-31; usamos o promocional porque é o que está sendo
  // COBRADO hoje — depois de 31/08 troque para 3 / 0.3 / 3.75 / 15.
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
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

// ── Montagem da chamada, por provedor ───────────────────────────────────────
// As mensagens são as MESMAS nos três; só os campos de controle mudam. Assim o
// caching por prefixo continua valendo em todos.

// Normaliza os turnos vindos do cliente: só user/assistant com conteúdo, e
// colapsa turnos consecutivos do mesmo papel (a Anthropic exige alternância).
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

// OpenAI e GLM: /v1/chat/completions. O system vai como 'developer' (papel de
// instrução dos reasoning models) — mesmo formato do /api/chat de produção, então
// o prompt caching automático da OpenAI pega o prefixo igual.
function buildSimChatBody({ provider, model, effort, systemPrompt, turns, thinking }) {
  const body = {
    model,
    messages: [{ role: 'developer', content: systemPrompt }, ...turns],
  };
  const cap = SIM_MAX_TOKENS + (effort === 'none' || effort === 'disabled' ? 0 : SIM_REASONING_HEADROOM);
  if (provider === 'glm') {
    body.max_tokens = cap;
    if (effort === 'disabled') {
      body.thinking = { type: 'disabled' };
    } else {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = effort;
    }
  } else {
    body.max_completion_tokens = cap;
    body.reasoning_effort = effort; // 'none' | 'low' | 'medium' | 'high'
  }
  if (thinking === 'omit') delete body.thinking;
  return body;
}

// Anthropic: Messages API. O caching NÃO é automático — precisa de cache_control
// explícito. Dois breakpoints: (1) o system (prompt do personagem, estável) e
// (2) o último bloco da conversa (padrão multi-turno: cada turno reaproveita todo
// o prefixo anterior). Sem isso o custo da Anthropic sairia inflado e a comparação
// com a OpenAI (que cacheia sozinha) seria injusta.
function buildSimAnthropicArgs({ model, effort, systemPrompt, turns, thinking }) {
  const args = {
    model,
    max_tokens: SIM_MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: turns.map((t, i) => (
      i === turns.length - 1
        ? { role: t.role, content: [{ type: 'text', text: t.content, cache_control: { type: 'ephemeral' } }] }
        : { role: t.role, content: t.content }
    )),
  };
  // Haiku 4.5 é pré-4.6: sem campo `thinking` ele já não pensa, e não aceita
  // output_config.effort (erra). Por isso o 'omit'.
  if (thinking === 'omit') return args;
  if (effort === 'disabled') {
    args.thinking = { type: 'disabled' };
  } else {
    args.thinking = { type: 'adaptive' };
    args.output_config = { effort }; // 'low' | 'medium' | 'high'
  }
  return args;
}

// Texto da resposta, por provedor.
function extractSimText(provider, resp) {
  if (provider === 'anthropic') {
    const blocks = (resp && resp.content) || [];
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
  }
  const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
  const c = (msg && msg.content) || '';
  // GLM pode embutir o thinking no content quando ligado — fora do que o aluno lê.
  return String(c).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ── Custo ───────────────────────────────────────────────────────────────────
// Normaliza o `usage` dos três provedores num shape único:
//   input      = tokens de entrada cobrados a preço cheio (JÁ sem os de cache)
//   cacheRead  = tokens lidos do cache
//   cacheWrite = tokens gravados no cache (só Anthropic cobra prêmio)
//   output     = tokens gerados (inclui reasoning, que é cobrado como saída)
//   reasoning  = quanto do output foi raciocínio (informativo)
function normalizeSimUsage(provider, usage) {
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  if (!usage) return zero;
  if (provider === 'anthropic') {
    return {
      input: Math.max(0, usage.input_tokens || 0), // já exclui cache na Anthropic
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoning: 0, // a Anthropic não separa reasoning no usage
    };
  }
  // OpenAI / GLM (chat.completions)
  const promptTotal = usage.prompt_tokens != null ? usage.prompt_tokens : (usage.input_tokens || 0);
  const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const completion = usage.completion_tokens != null ? usage.completion_tokens : (usage.output_tokens || 0);
  const total = usage.total_tokens != null ? usage.total_tokens : 0;
  // GOTCHA GLM: o completion_tokens sub-reporta o thinking; usa total-prompt como
  // piso da saída (mesma correção da Avaliação Independente).
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
  buildSimAnthropicArgs,
  extractSimText,
  normalizeSimUsage,
  computeSimCost,
  somaTotais,
};
