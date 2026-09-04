// Benchmarking de Simulação — laboratório de CAPACIDADE DE PROCESSAMENTO do
// PACIENTE (supervisor/admin).
//
// Terceiro laboratório da casa, e o único que roda SOZINHO:
//   · Avaliação Independente  → mede o AVALIADOR (uma chamada, custo no fim)
//   · Simulação Independente  → mede o PACIENTE com VOCÊ digitando (custo ao vivo)
//   · Benchmarking (este)     → mede o PACIENTE com um ALUNO SIMULADO digitando
//
// A pergunta que ele responde: quanto custa, e quão bem se sustenta, cada modelo
// candidato a paciente ao longo de um atendimento INTEIRO — não de dois ou três
// turnos digitados à mão. Para isso o lado do aluno é automatizado: você sobe o
// log de um atendimento que JÁ aconteceu, um primeiro modelo extrai dali a
// PERSONA de quem atendeu (como fala, como conduz, o que erra) e essa persona
// reatende o MESMO caso, do jeito daquela pessoa, pelo número de interações que
// você pedir.
//
// 1 interação = 1 fala do paciente + 1 fala do aluno. O paciente fala primeiro
// (igual à produção, disparado por um "Iniciar" oculto).
//
// NÃO HÁ AVALIAÇÃO AQUI. Nada é pontuado, nada entra em log de sessão, nada mexe
// em gamificação. O produto é o custo e a transcrição.
//
// O que é FIXO e por quê:
//   · O aluno simulado roda sempre em gpt-5.6-luna high (escolha do dono). Ele é
//     o instrumento de medida, não o objeto medido — se ele variasse, as runs
//     não seriam comparáveis entre si.
//   · O paciente tem 3 presets (modelo + effort juntos, sem seletor livre de
//     effort): luna high, mini none, GLM high. É a lista do dono.
//
// Preços, normalização de usage e montagem de corpo do chat.completions vêm da
// Simulação Independente (server/simulacao-independente.js) DE PROPÓSITO: as
// duas abas medem a mesma coisa (o paciente), e duas tabelas de preço iriam
// divergir no primeiro reajuste.
const sim = require('./simulacao-independente');
const { isRetryableAIError, retryDelayMs, modelEmiteResumo } = require('./avaliador-pipeline');

// Teto de tokens da fala visível. O mesmo da Simulação Independente, pra o custo
// por turno ser comparável entre as duas abas.
const BENCH_MAX_VISIBLE = Number(process.env.BENCH_SIM_MAX_TOKENS || sim.SIM_MAX_TOKENS);
// Folga pro canal de raciocínio. Maior que a da Simulação Independente (2000)
// porque aqui o effort é `high` nos dois lados: o teto é reasoning + saída, e
// estourá-lo faz o modelo pensar tudo e devolver content VAZIO — a falha mais
// chata de diagnosticar. Só paga o que gerar, então a folga é grátis.
const BENCH_REASONING_HEADROOM = Number(process.env.BENCH_SIM_REASONING_HEADROOM || 6000);
// Teto da extração de persona: é uma leitura longa (o log inteiro) com saída de
// meia página, em effort high.
const BENCH_PERSONA_MAX_TOKENS = Number(process.env.BENCH_SIM_PERSONA_MAX_TOKENS || 12000);

// Quantas interações a run pode ter. Lista fechada (decisão do dono): a tela é
// de botões, não de campo livre, e o servidor valida contra ela.
const BENCH_INTERACOES = [10, 30, 50, 70];

// Como um LOTE roda os modelos escolhidos.
//   fila     = um modelo por vez, do começo ao fim, depois o próximo. Mais lento,
//              mas nenhum risco de estourar TPM — e uma run não derruba a outra.
//   paralelo = todos ao mesmo tempo. Rápido, porém o lado do ALUNO é o MESMO
//              modelo em todas as runs (luna high), então N runs simultâneas
//              multiplicam por N a pressão sobre o TPM daquele modelo. Com 429 o
//              retry segura, mas em lote grande a fila é a aposta segura.
const BENCH_MODOS = ['fila', 'paralelo'];
const BENCH_MODO_PADRAO = 'fila';

function isValidModo(modo) {
  return BENCH_MODOS.includes(modo);
}

// O ALUNO simulado. Fixo — ver comentário do topo.
const BENCH_ALUNO = {
  modelKey: 'gpt-5.6-luna',
  effort: 'high',
  label: 'GPT 5.6 Luna · high',
};

// Os PACIENTES em teste. `modelKey` aponta pro registro da Simulação
// Independente (id pinado, provider e preços saem de lá); o effort vem colado no
// preset porque o dono definiu as três combinações, não seis.
const BENCH_PACIENTES = {
  'gpt-5.6-luna-high': { modelKey: 'gpt-5.6-luna', effort: 'high', nota: 'candidato mais barato ($0,20 input) COM raciocínio' },
  'gpt-5.6-terra-high': { modelKey: 'gpt-5.6-terra', effort: 'high', nota: 'tier acima do Luna ($2 input); mesma família, mais fôlego' },
  'gpt-5.4-mini': { modelKey: 'gpt-5.4-mini', effort: 'none', nota: 'o paciente de produção hoje (sem raciocínio)' },
  'glm-5.2-high': { modelKey: 'glm-5.2', effort: 'high', nota: 'z.ai; devolve o raciocínio no próprio chat.completions' },
};

// Resolve um preset de paciente no que a chamada precisa: id pinado, provider,
// effort e preços. Devolve null pra chave fora da lista (o endpoint responde 400).
function patientPreset(key) {
  const preset = Object.prototype.hasOwnProperty.call(BENCH_PACIENTES, key) ? BENCH_PACIENTES[key] : null;
  if (!preset) return null;
  const info = sim.simModelInfo(preset.modelKey);
  if (!info) return null; // preset apontando pra modelo que saiu do registro
  return {
    key,
    modelKey: preset.modelKey,
    model: info.id,
    provider: info.provider,
    effort: preset.effort,
    label: `${info.label} · ${preset.effort}`,
    nota: preset.nota || '',
    precos: sim.resolveSimPrices(preset.modelKey),
  };
}

// O aluno resolvido do mesmo jeito (ele também é uma chamada com custo — o custo
// não vai pro HUD ao vivo, mas entra no relatório).
function alunoPreset() {
  const info = sim.simModelInfo(BENCH_ALUNO.modelKey);
  return {
    modelKey: BENCH_ALUNO.modelKey,
    model: info ? info.id : BENCH_ALUNO.modelKey,
    provider: info ? info.provider : 'openai',
    effort: BENCH_ALUNO.effort,
    label: BENCH_ALUNO.label,
    precos: sim.resolveSimPrices(BENCH_ALUNO.modelKey),
  };
}

function isValidPatientKey(key) {
  return patientPreset(key) !== null;
}

// Lista de pacientes de um lote → presets, sem repetição e na ordem do catálogo
// (a ordem do catálogo é a do preço, então a tabela comparativa sai legível sem
// precisar reordenar). Devolve null se qualquer chave for inválida: melhor 400 na
// cara do que um lote que roda 3 dos 4 modelos pedidos em silêncio.
function normalizePacientes(lista) {
  if (!Array.isArray(lista) || !lista.length) return null;
  const pedidas = new Set();
  for (const k of lista) {
    if (!isValidPatientKey(k)) return null;
    pedidas.add(k);
  }
  return Object.keys(BENCH_PACIENTES).filter((k) => pedidas.has(k)).map((k) => patientPreset(k));
}
function isValidInteracoes(n) {
  return BENCH_INTERACOES.includes(Number(n));
}

// Catálogo pra tela: pacientes disponíveis, opções de interações e quem é o aluno.
function benchCatalogo() {
  return {
    pacientes: Object.keys(BENCH_PACIENTES).map((k) => patientPreset(k)).filter(Boolean),
    interacoes: BENCH_INTERACOES,
    aluno: alunoPreset(),
    modos: BENCH_MODOS,
    modoPadrao: BENCH_MODO_PADRAO,
    maxTokens: BENCH_MAX_VISIBLE,
  };
}

// Teto de tokens de uma chamada: visível + folga de raciocínio quando o modelo
// vai pensar. Com effort 'none'/'disabled' não há canal de raciocínio pra pagar.
function tetoTokens(effort) {
  return BENCH_MAX_VISIBLE + (effort === 'none' || effort === 'disabled' ? 0 : BENCH_REASONING_HEADROOM);
}

// ── Prompts do laboratório ──────────────────────────────────────────────────
// Ficam em CÓDIGO (como o da Antessala), não no volume de prompts: são
// instrumento de medida, não conteúdo pedagógico que o dono edita pela tela.

// Extração da persona. Roda UMA vez por run, no modelo do aluno, e o texto que
// sai daqui vira o miolo do system prompt do aluno simulado.
//
// Duas coisas que o prompt tem de segurar, aprendidas na prática:
//
// 1. Reproduzir os LIMITES. A tentação natural do modelo é descrever um
//    terapeuta melhor do que o do log — e aí o benchmark passaria a medir o
//    paciente contra um aluno idealizado, que não é quem usa o app.
//
// 2. NÃO CARICATURAR. A ficha descreve a FORMA de atender, não o conteúdo
//    daquela sessão. Na primeira versão, um log em que o terapeuta usou uma
//    analogia com o Batman gerou uma ficha que nomeava a analogia; o aluno
//    simulado passou a citar Batman em praticamente toda intervenção. O que a
//    ficha precisa registrar é a CLASSE do recurso ("recorre a analogias da
//    cultura pop") e a DOSAGEM ("uma ou duas vezes na sessão") — nunca o exemplo
//    específico, que o simulador trata como assinatura obrigatória.
const PERSONA_INSTRUCTION = `Você é um analista de estilo clínico. Vai ler a transcrição de UM atendimento psicológico simulado e descrever, em ficha, COMO a pessoa que ocupou a cadeira de terapeuta atende — para que outro leitor consiga atender no lugar dela, em outra sessão, sem nunca ter lido esta transcrição.

Você NÃO avalia, NÃO dá nota, NÃO ensina e NÃO sugere melhorias. Você descreve o que está lá.

## AS DUAS REGRAS QUE DEFINEM UMA FICHA BOA

REGRA 1 — DESCREVA A PESSOA REAL, COM OS LIMITES DELA.
Se as intervenções são curtas e genéricas, diga isso. Se ela interpreta cedo, aconselha, tranquiliza, repete a mesma pergunta, ignora um afeto, usa jargão fora de hora, perde o fio — registre. Uma ficha que descreve um terapeuta melhor do que o da transcrição é uma ficha ERRADA.

REGRA 2 — DESCREVA A FORMA, NUNCA O CONTEÚDO DAQUELA SESSÃO.
A ficha vai ser usada em OUTRA sessão, sobre o mesmo caso mas com outras falas. Então:
- NÃO cite frases, exemplos, metáforas, analogias, personagens, filmes, músicas, nomes próprios nem temas específicos que apareceram na transcrição.
- Quando um recurso aparecer, nomeie a CLASSE dele e a FREQUÊNCIA, não a instância. Escreva "recorre a analogias da cultura pop, umas duas vezes na sessão" — jamais "usa a metáfora do Batman". A instância vira assinatura obrigatória na mão de quem lê, e o resultado é uma caricatura que repete o mesmo truque em toda fala.
- Toda tendência vem com dosagem explícita: uma vez, raramente, às vezes, com frequência, quase sempre. Traço sem dosagem é lido como "sempre".
- Nada de citação literal. Se precisar dar ideia do registro, parafraseie em termos genéricos.

## FORMATO

Responda EXATAMENTE nestas seções, em português do Brasil, sem preâmbulo e sem comentário final. Cada seção em 2 a 4 frases — ficha longa e detalhista é ficha que vira roteiro.

COMO FALA
Registro (formal/coloquial), extensão típica das falas (uma linha? um parágrafo?), nível de vocabulário técnico, proporção entre perguntar e afirmar.

COMO CONDUZ
O que ela faz com o que o paciente traz: pergunta, devolve, interpreta, orienta, tranquiliza, cala. Ritmo (aprofunda ou passa adiante?). O que faz quando o paciente desvia, se emociona ou fica em silêncio.

RECURSOS E DOSAGEM
Que tipos de recurso ela usa — analogia, exemplo do cotidiano, psicoeducação, resumo do que ouviu, silêncio, humor, autorrevelação — e com que frequência cada um aparece. Sem nomear o recurso concreto que ela usou; só a classe e a dosagem.

ATENÇÃO CLÍNICA
Que TIPO de material ela persegue (afeto? comportamento? história? relação? sintoma?), que tipo de hipótese parece sustentar e que tipo de material ela deixa passar sem tocar. Em termos gerais, não pelo assunto da sessão.

LIMITES E VÍCIOS
Os erros e tiques recorrentes, com honestidade e com dosagem. Se não houver nenhum digno de nota, escreva "nenhum evidente".

ABERTURA E FECHAMENTO
Como ela começa uma fala e como a encerra.`;

function buildPersonaInput({ log, alunoNome, casoNome }) {
  const quem = (alunoNome || '').trim();
  const caso = (casoNome || '').trim();
  return `${quem ? `A pessoa na cadeira de terapeuta chama-se ${quem}.` : 'A pessoa na cadeira de terapeuta não está nomeada na transcrição.'}${caso ? ` O paciente simulado é ${caso}.` : ''}

TRANSCRIÇÃO DO ATENDIMENTO
---
${log}
---`;
}

// System prompt do ALUNO simulado. Recebe a ficha de persona e conduz o
// atendimento.
//
// Decisão de design: o número de interações NÃO entra aqui. Se entrasse, o aluno
// de uma run de 10 se comportaria diferente do de uma run de 70 (encerraria o
// atendimento cedo, apressaria o fechamento) e as runs deixariam de ser
// comparáveis — os 10 primeiros turnos de uma run de 70 devem valer como uma run
// de 10. Em troca, o prompt proíbe encerrar por conta própria: o corte é do
// contador, não do modelo.
//
// A ficha é apresentada como BASE DE PERSONALIDADE, não como roteiro. Sem essa
// insistência o modelo trata cada traço listado como obrigação a cumprir em toda
// fala, e o aluno simulado vira uma caricatura de si mesmo (ver o comentário da
// PERSONA_INSTRUCTION sobre o caso do Batman).
function buildAlunoSystemPrompt({ personaTexto, alunoNome, casoNome }) {
  const quem = (alunoNome || '').trim() || 'o(a) estudante descrito(a) abaixo';
  const caso = (casoNome || '').trim();
  return `Você é ${quem}, estudante de psicologia, atendendo${caso ? ` ${caso}` : ' um paciente'} numa sessão de terapia. Você ocupa a cadeira do TERAPEUTA. A ficha abaixo é a BASE da sua personalidade clínica.

COMO USAR A FICHA
- Ela descreve seu jeito GERAL de atender: seu registro, seu ritmo, seu nível técnico, suas tendências. Não é roteiro, não é lista de tarefas e não é assinatura a estampar em cada fala.
- Cada fala sua nasce do que o paciente acabou de dizer, AGORA. A ficha diz como você reage; o paciente diz a quê.
- Tendência não é obrigação. Um recurso descrito como ocasional aparece ocasionalmente — talvez uma vez na sessão inteira, talvez nenhuma. Repetir o mesmo tipo de recurso em falas seguidas está errado, mesmo que ele esteja na ficha.
- Você varia. Duas falas suas nunca têm a mesma estrutura, a mesma abertura ou o mesmo movimento. Uma pessoa real repete o próprio estilo sem repetir a própria forma.

REGRAS
- Escreva APENAS a sua próxima fala ao paciente. Nada de narração, rubrica, aspas, rótulo ("Terapeuta:"), descrição de gesto ou comentário sobre a técnica.
- Mantenha o nível descrito, INCLUSIVE os limites e vícios: se a ficha diz que suas falas são curtas e pouco técnicas, elas continuam curtas e pouco técnicas. Você não deve atender melhor do que a ficha atende — um atendimento mais competente do que o descrito é uma resposta errada.
- Não encerre a sessão por conta própria e não se despeça: conduza sempre como se houvesse mais tempo à frente.
- Você não é uma IA e nunca fala como assistente. Não quebre o papel em nenhuma hipótese, mesmo que o paciente pergunte.

FICHA DE COMO VOCÊ ATENDE
${(personaTexto || '').trim() || '(ficha indisponível — atenda como um estudante de psicologia mediano, com falas curtas)'}`;
}

// ── Histórico: a MESMA conversa vista dos dois lados ────────────────────────
// A transcrição canônica é uma lista de { ator: 'paciente'|'aluno', texto }.
// Cada modelo precisa dela com os papéis do SEU ponto de vista, porque para
// ambos 'assistant' é a própria fala.

// Visão do PACIENTE: ele é o assistant; o aluno é o user. O primeiro user é o
// "Iniciar" oculto — mesmo disparo da produção, então o paciente abre a conversa.
const KICKOFF = 'Iniciar';
function historyForPatient(transcript) {
  const turns = [{ role: 'user', content: KICKOFF }];
  for (const t of transcript) {
    if (!t || !t.texto) continue;
    turns.push({ role: t.ator === 'paciente' ? 'assistant' : 'user', content: t.texto });
  }
  return sim.normalizeTurns(turns);
}

// Visão do ALUNO: ele é o assistant; o paciente é o user. Sem kickoff — quem
// abre a conversa é o paciente, e a primeira coisa que o aluno vê é essa fala.
function historyForAluno(transcript) {
  const turns = [];
  for (const t of transcript) {
    if (!t || !t.texto) continue;
    turns.push({ role: t.ator === 'aluno' ? 'assistant' : 'user', content: t.texto });
  }
  return sim.normalizeTurns(turns);
}

// ── Usage ───────────────────────────────────────────────────────────────────
// Dois transportes convivem numa run (ver runBenchTurn no index.js): a Responses
// API, quando queremos o resumo do raciocínio, e o chat.completions no resto. Os
// campos de usage têm nomes diferentes, e somar os shapes errados dá custo
// silenciosamente errado — por isso um normalizador que aceita os dois.
//   chat.completions → prompt_tokens / prompt_tokens_details.cached_tokens /
//                      completion_tokens / completion_tokens_details.reasoning_tokens
//   responses        → input_tokens  / input_tokens_details.cached_tokens /
//                      output_tokens / output_tokens_details.reasoning_tokens
function normalizeBenchUsage(provider, usage) {
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  if (!usage) return zero;
  const promptTotal = usage.prompt_tokens != null ? usage.prompt_tokens : (usage.input_tokens || 0);
  const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
  const completion = usage.completion_tokens != null ? usage.completion_tokens : (usage.output_tokens || 0);
  const total = usage.total_tokens != null ? usage.total_tokens : 0;
  // GOTCHA GLM (herdado da Simulação Independente): o completion_tokens
  // sub-reporta o thinking, então total-prompt vira o piso da saída.
  const output = provider === 'glm'
    ? Math.max(completion, total > promptTotal ? total - promptTotal : 0)
    : completion;
  const reasoning = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)
    || (usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens) || 0;
  return { input: Math.max(0, promptTotal - cacheRead), cacheRead, cacheWrite: 0, output, reasoning };
}

function zeroTotais() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

// Retry com o mesmo critério do avaliador (429/5xx/timeout, respeitando
// Retry-After). Uma run de 70 interações são 140 chamadas em sequência: sem
// retry, um único 429 no meio joga fora meia hora de execução.
const BENCH_MAX_RETRIES = Number(process.env.BENCH_SIM_MAX_RETRIES || 3);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function withBenchRetry(rotulo, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= BENCH_MAX_RETRIES || !isRetryableAIError(e)) throw e;
      const wait = retryDelayMs(e, attempt);
      console.warn(`[bench-retry] ${rotulo}: ${e.status || e.code || e.name} — nova tentativa em ${Math.round(wait / 100) / 10}s (${attempt + 1}/${BENCH_MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

// Este modelo/effort consegue devolver RESUMO de raciocínio de graça?
//   OpenAI: só pela Responses API (`summary:'auto'`), e só em modelo com
//     sumarizador (o mini não tem). Com effort 'none' não há raciocínio nenhum.
//   GLM: manda `reasoning_content` no próprio chat.completions, sem trocar
//     transporte e sem custo.
// "De graça" é a condição que o dono pôs: o resumo é janela para token de
// raciocínio que JÁ foi cobrado como saída, pedido ou não — não há linha nova na
// fatura por pedi-lo. Se um dia a OpenAI passar a cobrar o sumarizador, ele
// aparece no `usage` desta mesma instrumentação e a conta acusa.
function capturaResumo({ provider, model, effort }) {
  if (effort === 'none' || effort === 'disabled') return false;
  if (provider === 'openai') return modelEmiteResumo(model);
  if (provider === 'glm') return true;
  return false;
}

// ── Agregação de custos ─────────────────────────────────────────────────────
// `interacoes` é a lista de { n, paciente: turno, aluno: turno }, onde cada turno
// tem { totais, custo, latenciaMs, ... }.
function resumoDeCustos({ interacoes, pacienteModelKey, alunoModelKey, personaTurno }) {
  const somar = (lado) => {
    let totais = zeroTotais();
    let usd = 0;
    let semPreco = false;
    let latencia = 0;
    let n = 0;
    for (const it of interacoes) {
      const t = it[lado];
      if (!t) continue;
      n += 1;
      totais = sim.somaTotais(totais, t.totais || zeroTotais());
      latencia += t.latenciaMs || 0;
      if (t.custo && Number.isFinite(t.custo.usd)) usd += t.custo.usd;
      else semPreco = true;
    }
    return { n, totais, usd: semPreco && usd === 0 ? null : usd, semPreco, latenciaMs: latencia };
  };

  const paciente = somar('paciente');
  const aluno = somar('aluno');
  // A extração de persona é UMA chamada, no modelo do aluno, antes da conversa.
  // Entra no lado do aluno no total (foi gasta pra fazer o aluno existir) mas
  // fica destacada, porque não é custo por interação e não escala com N.
  const persona = personaTurno
    ? { totais: personaTurno.totais, usd: personaTurno.custo ? personaTurno.custo.usd : null, latenciaMs: personaTurno.latenciaMs || 0 }
    : null;

  const personaUsd = persona && Number.isFinite(persona.usd) ? persona.usd : 0;
  const alunoUsd = aluno.usd != null ? aluno.usd + personaUsd : null;
  const totalUsd = paciente.usd != null && alunoUsd != null ? paciente.usd + alunoUsd : null;
  const nInt = interacoes.length;

  return {
    interacoes: nInt,
    paciente: {
      modelKey: pacienteModelKey,
      ...paciente,
      // A MÉTRICA da aba: quanto custa um turno de paciente neste modelo. É a
      // única que serve pra projetar produção (custo × volume de atendimentos).
      mediaPorInteracao: paciente.usd != null && nInt ? paciente.usd / nInt : null,
      latenciaMedia: nInt ? paciente.latenciaMs / nInt : null,
    },
    aluno: {
      modelKey: alunoModelKey,
      ...aluno,
      usd: alunoUsd,
      persona,
      // Amortiza a extração de persona nas interações, pra as três médias
      // (paciente + aluno = total) fecharem. A linha da persona continua
      // destacada porque ela é custo FIXO: não cresce com N.
      mediaPorInteracao: alunoUsd != null && nInt ? alunoUsd / nInt : null,
      latenciaMedia: nInt ? aluno.latenciaMs / nInt : null,
    },
    totalUsd,
    mediaTotalPorInteracao: totalUsd != null && nInt ? totalUsd / nInt : null,
  };
}

// ── Arquivos de saída ───────────────────────────────────────────────────────
function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return 'n/d';
  return '$' + v.toFixed(6);
}
function fmtTok(n) {
  return String(Number(n) || 0);
}

// LOG COMPLETO (.txt): cabeçalho com quem rodou o quê, resumo de custos, tabela
// interação a interação e a transcrição inteira. SEM raciocínio — ele tem
// arquivo próprio (pedido explícito do dono: o log normal não carrega o
// raciocínio).
function buildBenchLogTxt(run) {
  const L = [];
  const r = run.resumo || {};
  const p = r.paciente || {};
  const a = r.aluno || {};

  L.push('BENCHMARKING DE SIMULAÇÃO — LOG DO ATENDIMENTO');
  L.push('='.repeat(60));
  L.push(`Run: ${run.id}`);
  L.push(`Rodado em: ${run.createdAt ? new Date(run.createdAt).toLocaleString('pt-BR') : '—'}`);
  L.push(`Por: ${run.userName || '—'}`);
  L.push(`Status: ${run.status}${run.error ? ` (${run.error})` : ''}`);
  L.push('');
  L.push(`Paciente simulado: ${run.casoNome || '—'}`);
  L.push(`Aluno simulado: ${run.alunoNome || '(não identificado)'} — persona extraída do log enviado`);
  if (run.loteId) L.push(`Lote: ${run.loteId} (ficha de persona compartilhada com os outros modelos do lote)`);
  L.push(`Interações pedidas: ${run.interacoesPedidas} · realizadas: ${(run.interacoes || []).length}`);
  L.push('');
  L.push('— IA DE CADA LADO —');
  L.push(`Paciente (em teste): ${run.paciente.label} · modelo ${run.paciente.model} · effort ${run.paciente.effort} · provedor ${run.paciente.provider}`);
  L.push(`Aluno (instrumento):  ${run.aluno.label} · modelo ${run.aluno.model} · effort ${run.aluno.effort} · provedor ${run.aluno.provider}`);
  L.push('');
  L.push('— CUSTOS —');
  L.push(`Valor gasto pelo PACIENTE: ${fmtUSD(p.usd)}`);
  // Em lote a extração de persona é UMA para todos os modelos (mesma ficha =
  // mesmo aluno enfrentando todos), então ela é contabilizada no lote, não aqui.
  const notaPersona = run.personaCompartilhada
    ? ' (a extração de persona foi compartilhada pelo lote e está contabilizada nele)'
    : (a.persona ? ` (inclui ${fmtUSD(a.persona.usd)} da extração de persona, chamada única)` : '');
  L.push(`Valor gasto pelo ALUNO:    ${fmtUSD(a.usd)}${notaPersona}`);
  L.push(`Valor gasto TOTAL:         ${fmtUSD(r.totalUsd)}`);
  L.push(`Valor MÉDIO por interação: ${fmtUSD(r.mediaTotalPorInteracao)} (paciente ${fmtUSD(p.mediaPorInteracao)} + aluno ${fmtUSD(a.mediaPorInteracao)})`);
  L.push('');
  L.push('Tokens do paciente: '
    + `${fmtTok(p.totais && p.totais.input)} input · ${fmtTok(p.totais && p.totais.cacheRead)} cache (leitura) · `
    + `${fmtTok(p.totais && p.totais.output)} output (${fmtTok(p.totais && p.totais.reasoning)} reasoning)`);
  L.push('Tokens do aluno:    '
    + `${fmtTok(a.totais && a.totais.input)} input · ${fmtTok(a.totais && a.totais.cacheRead)} cache (leitura) · `
    + `${fmtTok(a.totais && a.totais.output)} output (${fmtTok(a.totais && a.totais.reasoning)} reasoning)`);
  L.push(`Latência média por fala do paciente: ${p.latenciaMedia != null ? Math.round(p.latenciaMedia) + 'ms' : 'n/d'}`);
  L.push('');
  L.push('— INTERAÇÃO A INTERAÇÃO (custo do paciente) —');
  for (const it of run.interacoes || []) {
    const tp = it.paciente || {};
    const ta = it.aluno || {};
    L.push(
      `#${String(it.n).padStart(2, '0')} paciente ${fmtUSD(tp.custo ? tp.custo.usd : null)} `
      + `(${fmtTok(tp.totais && tp.totais.input)} in · ${fmtTok(tp.totais && tp.totais.cacheRead)} cache · ${fmtTok(tp.totais && tp.totais.output)} out · ${tp.latenciaMs || 0}ms)`
      + `   |   aluno ${fmtUSD(ta.custo ? ta.custo.usd : null)} (${ta.latenciaMs || 0}ms)`,
    );
  }
  L.push('');
  L.push('— TRANSCRIÇÃO —');
  L.push('');
  for (const t of run.transcript || []) {
    L.push(`${t.ator === 'paciente' ? (run.casoNome || 'PACIENTE').toUpperCase() : (run.alunoNome || 'ALUNO').toUpperCase()}: ${t.texto}`);
    L.push('');
  }
  L.push('— FICHA DE PERSONA DO ALUNO (gerada a partir do log enviado) —');
  L.push('');
  L.push((run.persona || '').trim() || '(não gerada)');
  L.push('');
  L.push('Sem avaliação: esta aba não pontua atendimento. O produto é custo e transcrição.');
  return L.join('\n');
}

// FICHA DE PERSONA (.txt) — terceiro arquivo baixável. A ficha também aparece
// dentro do log completo (no fim) e na tela, mas em arquivo próprio ela serve pra
// o que o dono faz com ela: comparar a persona extraída de logs diferentes, ou
// reler antes de julgar se o aluno simulado ficou fiel.
function buildBenchPersonaTxt(run) {
  const ficha = (run.persona || '').trim();
  if (!ficha) return '';
  const L = [];
  L.push('BENCHMARKING DE SIMULAÇÃO — FICHA DE PERSONA DO ALUNO');
  L.push('='.repeat(60));
  L.push(`Run: ${run.id} · ${run.createdAt ? new Date(run.createdAt).toLocaleString('pt-BR') : '—'}`);
  L.push(`Aluno: ${run.alunoNome || '(não identificado)'}`);
  L.push(`Paciente do caso: ${run.casoNome || '—'}`);
  L.push(`Extraída por: ${run.aluno.label} · modelo ${run.aluno.model}`);
  if (run.personaTurno) {
    const t = run.personaTurno;
    L.push(
      `Custo da extração: ${t.custo ? '$' + t.custo.usd.toFixed(6) : 'n/d'} · `
      + `${fmtTok(t.totais && t.totais.input)} input · ${fmtTok(t.totais && t.totais.cacheRead)} cache · `
      + `${fmtTok(t.totais && t.totais.output)} output · ${t.latenciaMs || 0}ms`,
    );
  }
  L.push('');
  L.push('O que é este arquivo: a descrição de COMO a pessoa do log atende, gerada a');
  L.push('partir da transcrição enviada. É o único material que definiu o aluno');
  L.push('simulado desta run — ele descreve forma (registro, ritmo, recursos e');
  L.push('dosagem, limites), não o conteúdo daquela sessão.');
  L.push('');
  L.push('-'.repeat(60));
  L.push('');
  L.push(ficha);
  return L.join('\n');
}

// RACIOCÍNIO (.txt) — arquivo SEPARADO, com o resumo do raciocínio de cada lado
// separado por interação. Só existe quando algum lado devolveu resumo de graça
// (ver capturaResumo). Vazio → o endpoint responde 404 e o botão não aparece.
// Algum lado guardou resumo de raciocínio? Separado do builder porque a tela faz
// polling a cada poucos segundos, e montar o .txt inteiro (70 interações) só pra
// decidir se o botão aparece seria desperdício.
function temReasoning(run) {
  return (run.interacoes || []).some((it) => (it.paciente && it.paciente.reasoning) || (it.aluno && it.aluno.reasoning))
    || !!(run.personaTurno && run.personaTurno.reasoning);
}

function buildBenchReasoningTxt(run) {
  if (!temReasoning(run)) return '';

  const L = [];
  L.push('BENCHMARKING DE SIMULAÇÃO — RESUMO DO RACIOCÍNIO');
  L.push('='.repeat(60));
  L.push(`Run: ${run.id} · ${run.createdAt ? new Date(run.createdAt).toLocaleString('pt-BR') : '—'}`);
  L.push(`Paciente: ${run.casoNome || '—'} · ${run.paciente.label}`);
  L.push(`Aluno: ${run.alunoNome || '(não identificado)'} · ${run.aluno.label}`);
  L.push('');
  L.push('O que é este arquivo: o RESUMO do raciocínio que cada modelo produziu antes');
  L.push('de falar — não a cadeia bruta, que nenhum provedor expõe. Os tokens de');
  L.push('raciocínio já são cobrados como saída, pedido ou não o resumo: este arquivo');
  L.push('não adicionou custo à run. Modelo com effort "none" não pensa e por isso não');
  L.push('aparece aqui; modelo "mini" não tem sumarizador.');
  L.push('');
  if (run.personaTurno && run.personaTurno.reasoning) {
    L.push('#'.repeat(60));
    L.push('EXTRAÇÃO DA PERSONA DO ALUNO (chamada única, antes da conversa)');
    L.push('#'.repeat(60));
    L.push('');
    L.push(run.personaTurno.reasoning.trim());
    L.push('');
  }
  for (const it of run.interacoes || []) {
    L.push('#'.repeat(60));
    L.push(`INTERAÇÃO ${it.n}`);
    L.push('#'.repeat(60));
    L.push('');
    L.push(`--- PACIENTE (${run.paciente.label}) ---`);
    L.push('');
    L.push((it.paciente && it.paciente.reasoning ? it.paciente.reasoning.trim() : '(sem resumo de raciocínio)'));
    L.push('');
    L.push(`--- ALUNO SIMULADO (${run.aluno.label}) ---`);
    L.push('');
    L.push((it.aluno && it.aluno.reasoning ? it.aluno.reasoning.trim() : '(sem resumo de raciocínio)'));
    L.push('');
  }
  return L.join('\n');
}

// ── Lote: uma linha por modelo ──────────────────────────────────────────────
// Agregação MECÂNICA dos números que cada run já produziu — custo, tokens,
// latência. Não julga qualidade de fala: isso é o sistema de comparação que o
// dono quer construir DEPOIS, e inventá-lo aqui seria decidir por ele.
//
// A ordem das linhas é a do catálogo (que é a ordem de preço de tabela), não um
// ranking do resultado: quem lê decide o que olhar.
function resumoComparativo({ runs, personaTurno }) {
  const linhas = (runs || []).map((r) => {
    const resumo = r.resumo || {};
    const p = resumo.paciente || {};
    const a = resumo.aluno || {};
    return {
      runId: r.id,
      pacienteKey: r.paciente ? r.paciente.key : null,
      label: r.paciente ? r.paciente.label : '—',
      provider: r.paciente ? r.paciente.provider : null,
      status: r.status,
      erro: r.error || null,
      interacoesFeitas: (r.interacoes || []).length,
      interacoesPedidas: r.interacoesPedidas,
      pacienteUsd: p.usd != null ? p.usd : null,
      custoPorInteracao: p.mediaPorInteracao != null ? p.mediaPorInteracao : null,
      latenciaMedia: p.latenciaMedia != null ? p.latenciaMedia : null,
      tokens: p.totais || zeroTotais(),
      alunoUsd: a.usd != null ? a.usd : null,
    };
  });

  const somar = (campo) => {
    let total = 0;
    let algum = false;
    for (const l of linhas) {
      if (l[campo] != null && Number.isFinite(l[campo])) { total += l[campo]; algum = true; }
    }
    return algum ? total : null;
  };
  const pacientes = somar('pacienteUsd');
  const alunos = somar('alunoUsd');
  const persona = personaTurno && personaTurno.custo ? personaTurno.custo.usd : null;
  const partes = [pacientes, alunos, persona].filter((v) => v != null);
  return {
    linhas,
    totais: {
      pacientes,
      alunos,
      persona,
      geral: partes.length ? partes.reduce((x, y) => x + y, 0) : null,
      interacoesFeitas: linhas.reduce((n, l) => n + l.interacoesFeitas, 0),
    },
  };
}

// RELATÓRIO DO LOTE (.txt): a tabela comparativa e o que cada run custou. As
// transcrições NÃO entram — cada run tem o .txt dela, e colar quatro
// transcrições de 70 interações num arquivo só o tornaria ilegível.
function buildLoteRelatorioTxt({ lote, runs }) {
  const comp = resumoComparativo({ runs, personaTurno: lote.personaTurno });
  const L = [];
  L.push('BENCHMARKING DE SIMULAÇÃO — RELATÓRIO DO LOTE');
  L.push('='.repeat(64));
  L.push(`Lote: ${lote.id}`);
  L.push(`Rodado em: ${lote.createdAt ? new Date(lote.createdAt).toLocaleString('pt-BR') : '—'}`);
  L.push(`Por: ${lote.userName || '—'}`);
  L.push(`Status: ${lote.status}${lote.error ? ` (${lote.error})` : ''}`);
  L.push('');
  L.push(`Paciente simulado: ${lote.casoNome || '—'}`);
  L.push(`Aluno simulado: ${lote.alunoNome || '(não identificado)'} · ${lote.aluno.label}`);
  L.push(`Interações por modelo: ${lote.interacoes}`);
  L.push(`Modelos no lote: ${comp.linhas.length} · execução em ${lote.modo === 'paralelo' ? 'PARALELO (todos ao mesmo tempo)' : 'FILA (um modelo por vez)'}`);
  L.push('');
  L.push('A MESMA ficha de persona foi usada em todos os modelos deste lote — é o que');
  L.push('torna a comparação válida: todos enfrentaram o mesmo aluno simulado, com a');
  L.push('mesma forma de atender. A extração dela foi uma chamada única, cobrada uma');
  L.push('vez só.');
  L.push('');
  L.push('— COMPARATIVO (números; nada aqui julga a QUALIDADE da fala) —');
  L.push('');
  const col = (v, n) => String(v).padEnd(n);
  L.push(col('MODELO', 26) + col('STATUS', 12) + col('INT.', 8) + col('PACIENTE', 12) + col('POR INT.', 12) + col('LATÊNCIA', 10) + 'TOKENS (in/cache/out)');
  L.push('-'.repeat(104));
  for (const l of comp.linhas) {
    L.push(
      col(l.label, 26)
      + col(l.status, 12)
      + col(`${l.interacoesFeitas}/${l.interacoesPedidas}`, 8)
      + col(fmtUSD(l.pacienteUsd), 12)
      + col(fmtUSD(l.custoPorInteracao), 12)
      + col(l.latenciaMedia != null ? Math.round(l.latenciaMedia) + 'ms' : 'n/d', 10)
      + `${fmtTok(l.tokens.input)}/${fmtTok(l.tokens.cacheRead)}/${fmtTok(l.tokens.output)}`,
    );
    if (l.erro) L.push(`    ↳ erro: ${l.erro}`);
  }
  L.push('');
  L.push('— CUSTO DO LOTE —');
  L.push(`Somado, o lado PACIENTE (o que se mede): ${fmtUSD(comp.totais.pacientes)}`);
  L.push(`Somado, o lado ALUNO (instrumento):      ${fmtUSD(comp.totais.alunos)}`);
  L.push(`Extração de persona (uma vez, do lote):  ${fmtUSD(comp.totais.persona)}`);
  L.push(`TOTAL DO LOTE:                          ${fmtUSD(comp.totais.geral)}`);
  L.push(`Interações realizadas no lote: ${comp.totais.interacoesFeitas}`);
  L.push('');
  L.push('— POR RUN —');
  for (const l of comp.linhas) {
    L.push(`${l.label}: ${l.runId} (log e raciocínio próprios, baixáveis na tela da run)`);
  }
  L.push('');
  L.push('— FICHA DE PERSONA USADA POR TODOS —');
  L.push('');
  L.push((lote.persona || '').trim() || '(não gerada)');
  L.push('');
  L.push('Sem avaliação: esta aba não pontua atendimento.');
  return L.join('\n');
}

module.exports = {
  BENCH_INTERACOES,
  BENCH_PACIENTES,
  BENCH_MODOS,
  BENCH_MODO_PADRAO,
  isValidModo,
  normalizePacientes,
  BENCH_ALUNO,
  BENCH_MAX_VISIBLE,
  BENCH_PERSONA_MAX_TOKENS,
  PERSONA_INSTRUCTION,
  patientPreset,
  alunoPreset,
  isValidPatientKey,
  isValidInteracoes,
  benchCatalogo,
  tetoTokens,
  buildPersonaInput,
  buildAlunoSystemPrompt,
  historyForPatient,
  historyForAluno,
  normalizeBenchUsage,
  zeroTotais,
  withBenchRetry,
  capturaResumo,
  resumoDeCustos,
  buildBenchLogTxt,
  buildBenchPersonaTxt,
  resumoComparativo,
  buildLoteRelatorioTxt,
  buildBenchReasoningTxt,
  temReasoning,
  KICKOFF,
};
