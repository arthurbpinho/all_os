// Avaliação Independente — parsers dos avaliadores (o v18-25 tem formato próprio),
// pricing dos 3 modelos, desconto de batch, e validação de allowlist no endpoint.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const ai = require('../server/avaliacao-independente');
const { resolvePrices, buildChatBody, selectVariant, loadAssets, finalizePipeline, runAvaliacaoIndependente, buildReasoningTxt, modelEmiteResumo, isRetryableAIError, retryDelayMs, PIPELINE_VERSIONS } = require('../server/avaliacao-v25');
const { finalScoreFromCriteria } = require('../server/scoring');

describe('Avaliação Independente — parsers e pricing', () => {
  it('parser v18-25: [notas]/NA/[feedback], 15 critérios, NA fora da nota', () => {
    const text = [
      '[notas]', '1: 8', '2: 7', '3: 6', '4: 7', '5: 8', '6: 6', '7: 7', '8: 7',
      '9: 7', '10: NA', '11: 6', '12: 5', '13: NA', '14: 6', '15: 7',
      '[feedback]', 'Você conduziu bem a abertura.',
    ].join('\n');
    const r = ai.parseSingleEvalOutput('v18-25', text);
    expect(r.notasDetalhe.length).toBe(15);
    expect(r.notas['10']).toBe('NA');
    expect(r.notas['13']).toBe('NA');
    expect(r.feedback).toBe('Você conduziu bem a abertura.');
    // 13 notas finitas somam 87 → round(87 / (13×10) × 100) = 67
    expect(r.score).toBe(67);
  });

  it('parser v16-2: [notas-supervisor] JSON, 6 critérios, prosa limpa', () => {
    const text = 'Boa condução geral.\n\n[notas-supervisor]\n{"1": 8, "2": 6, "3": 7, "4": 5, "5": 6, "6": 7}';
    const r = ai.parseSingleEvalOutput('v16-2', text);
    expect(r.feedback).toBe('Boa condução geral.');
    expect(r.notasDetalhe.length).toBe(6);
    // soma 39 / 60 × 100 = 65
    expect(r.score).toBe(65);
  });

  it('finalScoreFromCriteria: NA vira NaN e sai da base', () => {
    // finitas [8,6] → 14 / 20 × 100 = 70
    expect(finalScoreFromCriteria({ 1: 8, 2: 'NA', 3: 6 })).toBe(70);
  });

  it('resolvePrices resolve os 7 modelos (mini antes de 5.4; glm; os três 5.6)', () => {
    expect(resolvePrices('gpt-5.5-2026-04-23')).toMatchObject({ input: 5, cached: 0.5, output: 30 });
    expect(resolvePrices('gpt-5.4-2026-03-05')).toMatchObject({ input: 2.5, cached: 0.25, output: 15 });
    expect(resolvePrices('gpt-5.4-mini-2026-03-17')).toMatchObject({ input: 0.75, cached: 0.075, output: 4.5 });
    expect(resolvePrices('glm-5.2')).toMatchObject({ input: 1.4, cached: 0.26, output: 4.4 });
    // Família 5.6 (docs OpenAI, ago/2026): Sol empata com o 5.5, Terra fica abaixo
    // do 5.4 e Luna é o mais barato da tabela.
    expect(resolvePrices('gpt-5.6-sol')).toMatchObject({ input: 5, cached: 0.5, output: 30 });
    expect(resolvePrices('gpt-5.6-terra')).toMatchObject({ input: 2, cached: 0.2, output: 12 });
    expect(resolvePrices('gpt-5.6-luna')).toMatchObject({ input: 0.2, cached: 0.02, output: 1.2 });
  });

  // O resolve casa por PREFIXO mais longo, então os três tiers do 5.6 precisam
  // resolver cada um no SEU preço — trocar Luna por Sol aqui erraria o custo por
  // 25×. E um 5.6 que não esteja na tabela tem de dar null: melhor a UI mostrar
  // tokens sem custo do que exibir um dólar errado.
  it('resolvePrices separa os tiers do 5.6 e não chuta tier desconhecido', () => {
    expect(resolvePrices('gpt-5.6-sol').input).toBe(5);
    expect(resolvePrices('gpt-5.6-terra').input).toBe(2);
    expect(resolvePrices('gpt-5.6-luna').input).toBe(0.2);
    expect(resolvePrices('gpt-5.6-nova')).toBeNull();
    expect(resolvePrices('gpt-5.6')).toBeNull();
  });

  it('extractReasoning: GLM reasoning_content; fallback reasoning e <think>', () => {
    expect(ai.extractReasoning({ reasoning_content: 'pensei nisso' })).toBe('pensei nisso');
    expect(ai.extractReasoning({ reasoning: 'r' })).toBe('r');
    expect(ai.extractReasoning({ content: 'a <think>oculto</think> b' })).toBe('oculto');
    expect(ai.extractReasoning({ content: 'só o texto visível' })).toBe('');
  });

  it('finalizeSingle: carrega reasoning e tira <think> do texto visível', () => {
    const text = '<think>não deveria aparecer</think>[notas]\n1: 8\n2: 6\n3: 7\n4: 5\n5: 6\n6: 7\n[feedback]\nOk.';
    const r = ai.finalizeSingle({ evaluatorId: 'v18-25', text, reasoning: 'raciocínio do GLM', usage: null, model: 'glm-5.2', effort: 'max', batch: false });
    expect(r.reasoning).toBe('raciocínio do GLM');
    expect(r.feedbackAluno).toBe('Ok.');
    expect(r.feedbackAluno).not.toMatch(/não deveria/);
  });

  it('Responses args (GPT): summary só fora do mini; extractResponsesReasoning', () => {
    const big = ai.buildSingleEvalResponsesArgs({ evaluatorId: 'v18-25', bloco1: 'b', log: 'l', model: 'gpt-5.4-2026-03-05', effort: 'medium' });
    expect(big.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(big.max_output_tokens).toBeGreaterThan(0);
    expect(String(big.instructions)).toMatch(/AVALIADOR/i);
    const mini = ai.buildSingleEvalResponsesArgs({ evaluatorId: 'v18-25', bloco1: 'b', log: 'l', model: 'gpt-5.4-mini-2026-03-17', effort: 'low' });
    expect(mini.reasoning).toEqual({ effort: 'low' }); // sem summary
    const reasoning = ai.extractResponsesReasoning({ output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'pensei A' }, { type: 'summary_text', text: 'pensei B' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'ignora' }] },
    ] });
    expect(reasoning).toBe('pensei A\n\npensei B');
  });

  it('buildSingleInstrumentacao aceita usage da Responses API', () => {
    const usage = { input_tokens: 40000, input_tokens_details: { cached_tokens: 30000 }, output_tokens: 5000, output_tokens_details: { reasoning_tokens: 3500 } };
    const inst = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, false);
    expect(inst.totais).toEqual({ input: 10000, cached: 30000, output: 5000, reasoning: 3500 });
    expect(inst.custo.usd).toBeCloseTo(0.1075, 6);
  });

  it('buildChatBody: GPT usa reasoning_effort/max_completion_tokens; GLM usa thinking/max_tokens', () => {
    const msgs = [{ role: 'developer', content: 's' }, { role: 'user', content: 'u' }];
    const gpt = buildChatBody({ provider: 'openai', model: 'gpt-5.4', messages: msgs, maxTokens: 16000, effort: 'medium' });
    expect(gpt.reasoning_effort).toBe('medium');
    expect(gpt.max_completion_tokens).toBe(16000);
    expect(gpt.thinking).toBeUndefined();
    const glm = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 16000, effort: 'max' });
    expect(glm.thinking).toEqual({ type: 'enabled' });
    expect(glm.reasoning_effort).toBe('max');
    expect(glm.max_tokens).toBe(16000);
    expect(glm.max_completion_tokens).toBeUndefined();
    const glmOff = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 16000, effort: 'disabled' });
    expect(glmOff.thinking).toEqual({ type: 'disabled' });
    expect(glmOff.reasoning_effort).toBeUndefined();
  });

  it('buildSingleInstrumentacao aplica 50% no batch', () => {
    const usage = {
      prompt_tokens: 1000, completion_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 500 },
    };
    const sync = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, false);
    const batch = ai.buildSingleInstrumentacao('gpt-5.4-2026-03-05', 'medium', usage, true);
    expect(batch.custo.usd).toBeCloseTo(sync.custo.usd / 2, 8);
    expect(batch.custo.batch).toBe(true);
  });
});

// As duas variantes do pipeline (com feedback × só nota) saem do MESMO .md do nó,
// por blocos `@variante`. O que estes testes protegem: a seleção não vaza o texto
// da outra variante, o arquivo sem marcador falha alto (em vez de rodar a
// variante errada em silêncio) e a só-nota não chama o sintetizador.
describe('Avaliação Independente — variantes do pipeline', () => {
  it('selectVariant mantém só os blocos da variante e exige marcadores', () => {
    const md = 'topo\n<!-- @variante:com-feedback -->\nCOM\n<!-- /@variante -->\n<!-- @variante:so-nota -->\nSO\n<!-- /@variante -->\nfim';
    expect(selectVariant(md, 'com-feedback')).toContain('COM');
    expect(selectVariant(md, 'com-feedback')).not.toContain('SO');
    expect(selectVariant(md, 'so-nota')).toContain('SO');
    expect(selectVariant(md, 'so-nota')).not.toContain('COM');
    // .md antigo (sem marcador) → erro claro, não a variante errada em silêncio.
    expect(() => selectVariant('sem marcador nenhum', 'so-nota')).toThrow(/@variante/);
  });

  it('loadAssets: com-feedback pede ANÁLISE/CONFIANÇA; so-nota pede só a NOTA', () => {
    const comFb = loadAssets('v25', 'com-feedback');
    const soNota = loadAssets('v25', 'so-nota');

    expect(comFb.blockA).toMatch(/ANÁLISE:/);
    expect(comFb.blockA).toMatch(/CONFIANÇA:/);
    expect(comFb.blockC).toMatch(/ANÁLISE/);

    expect(soNota.blockA).not.toMatch(/ANÁLISE:/);
    expect(soNota.blockA).not.toMatch(/CONFIANÇA:/);
    expect(soNota.blockA).toMatch(/NOTA: <inteiro/);

    // O resto (critérios, slots, sintetizador) é compartilhado.
    for (const a of [comFb, soNota]) {
      expect(a.criteria.length).toBe(14);
      expect(a.blockB).toContain('{{BLOCO_1}}');
      expect(a.blockB).toContain('{{LOG}}');
      expect(a.blockC).toContain('{{CRITÉRIO}}');
    }
    expect(() => loadAssets('v25', 'nao-existe')).toThrow(/Variante/);
    expect(() => loadAssets('v99')).toThrow(/Versão do pipeline/);
  });

  // O v28 é a versão em teste: mesmo pipeline, 15 critérios (coerência interna e
  // narrativa voltam separadas) e os mesmos marcadores de variante/cache. Se um
  // .md do v28 chegar ao volume com 14 critérios ou sem marcador, é aqui que se
  // vê — antes de alguém gastar uma run inteira pra descobrir.
  it('loadAssets v28: 15 critérios, marcadores e variantes iguais aos do v25', () => {
    const comFb = loadAssets('v28', 'com-feedback');
    const soNota = loadAssets('v28', 'so-nota');

    expect(comFb.criteria.length).toBe(15);
    expect(soNota.criteria.length).toBe(15);
    // A fusão dos dois critérios de coerência (v25 nº 7, "Confiança transmitida")
    // está desfeita: eles voltam separados, e a numeração anda um.
    expect(comFb.criteria[6].nome).toBe('Coerência interna');
    expect(comFb.criteria[7].nome).toBe('Coerência narrativa');
    expect(comFb.criteria[14].nome).toBe('Criatividade');
    expect(comFb.criteria.every((c) => c.descricao && c.linhaCurta)).toBe(true);

    expect(comFb.blockA).toMatch(/ANÁLISE:/);
    expect(comFb.blockA).toMatch(/CONFIANÇA:/);
    expect(soNota.blockA).not.toMatch(/ANÁLISE:/);
    expect(soNota.blockA).toMatch(/NOTA: <inteiro/);

    for (const a of [comFb, soNota]) {
      expect(a.blockB).toContain('{{BLOCO_1}}');
      expect(a.blockB).toContain('{{LOG}}');
      expect(a.blockC).toContain('{{CRITÉRIO}}');
      expect(a.synthVariable).toContain('{{ANALISES}}');
    }
  });

  it('registry: as 4 entradas de pipeline resolvem versão e variante', () => {
    expect(ai.isValidEvaluator('v25-nota')).toBe(true);
    expect(ai.isValidEvaluator('v28')).toBe(true);
    expect(ai.isValidEvaluator('v28-nota')).toBe(true);
    expect(ai.isPipeline('v25')).toBe(true);
    expect(ai.isPipeline('v25-nota')).toBe(true);
    expect(ai.isPipeline('v28')).toBe(true);
    expect(ai.isPipeline('v28-nota')).toBe(true);
    expect(ai.isPipeline('v18-25')).toBe(false);
    expect(ai.variantFor('v25')).toBe('com-feedback');
    expect(ai.variantFor('v25-nota')).toBe('so-nota');
    expect(ai.variantFor('v28')).toBe('com-feedback');
    expect(ai.variantFor('v28-nota')).toBe('so-nota');
    expect(ai.variantFor('v16-2')).toBe(null);
    expect(ai.versionFor('v28')).toBe('v28');
    expect(ai.versionFor('v28-nota')).toBe('v28');
    expect(ai.versionFor('v25')).toBe('v25');
    expect(ai.versionFor('v18-25')).toBe(null);
  });

  it('finalizePipeline só-nota: agrega a nota e não chama o sintetizador', async () => {
    // Nós devolvem só "NOTA: n" → sem análise, o sintetizador é pulado. Se ele
    // fosse chamado, este cliente falso estouraria.
    const openai = { chat: { completions: { create: () => { throw new Error('sintetizador não deveria rodar'); } } } };
    const nodeOutputs = Array.from({ length: 14 }, (_, i) => ({ num: i + 1, text: 'NOTA: 8', usage: null }));
    const r = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'so-nota', nodeOutputs });
    expect(r.variant).toBe('so-nota');
    expect(r.notaFinal).toBe(80); // média 8 → 80/100
    expect(r.considerados).toBe(14);
    expect(r.feedbackAluno).toBe(null);
    expect(r.corpoSintetizador).toBe(null);
    expect(r.partes.every((p) => p.incluido && p.analise === '')).toBe(true);
  });

  it('finalizePipeline com feedback: análise dos nós vira corpo do sintetizador', async () => {
    let userPrompt = '';
    const openai = {
      chat: { completions: { create: async (body) => {
        userPrompt = body.messages[1].content;
        return { choices: [{ message: { content: 'Corpo do feedback.' } }], usage: null };
      } } },
    };
    const nodeOutputs = Array.from({ length: 14 }, (_, i) => ({
      num: i + 1, text: `ANÁLISE: ok. Fez bem no critério ${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`, usage: null,
    }));
    const r = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'com-feedback', nodeOutputs });
    expect(r.notaFinal).toBe(80);
    expect(r.corpoSintetizador).toBe('Corpo do feedback.');
    expect(r.feedbackAluno).toMatch(/^Nota: 80\/100/);
    expect(userPrompt).toContain('Fez bem no critério 14.');
    expect(userPrompt).not.toMatch(/NOTA: 8/); // o sintetizador não vê números
  });
});

// A diferença de CÓDIGO entre as duas versões: no v25 um critério com CONFIANÇA
// `baixa` sai da nota e do sintetizador; no v28 a confiança é só recado ao
// supervisor ("Ela não entra no cálculo... A nota você dá de todo jeito") e todo
// critério com nota conta. Rodar o v28 com a regra do v25 baixaria a base da
// média em silêncio — daí estes testes.
describe('Avaliação Independente — confiança baixa: v25 exclui, v28 não', () => {
  // 14 nós nota 8 + 1 com nota 2 e confiança baixa.
  function nodeOutputs(n) {
    return Array.from({ length: n }, (_, i) => ({
      num: i + 1,
      text: i === n - 1
        ? `ANÁLISE: erro. Sem material no critério ${i + 1}.\nNOTA: 2\nCONFIANÇA: baixa`
        : `ANÁLISE: preciso. Fez bem no critério ${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`,
      usage: null,
    }));
  }
  function fakeOpenAI(capture) {
    return { chat: { completions: { create: async (body) => {
      capture.user = body.messages[1].content;
      return { choices: [{ message: { content: 'Corpo do feedback.' } }], usage: null };
    } } } };
  }

  it('v25: o critério `baixa` fica fora da nota e fora do sintetizador', async () => {
    const cap = {};
    const r = await finalizePipeline({
      openai: fakeOpenAI(cap), log: 'log', model: 'gpt-5.5', effort: 'medium',
      version: 'v25', variant: 'com-feedback', nodeOutputs: nodeOutputs(14),
    });
    expect(r.version).toBe('v25');
    expect(r.considerados).toBe(13);   // 14 - 1 excluído
    expect(r.notaFinal).toBe(80);      // média dos 13 que ficaram = 8
    expect(r.partes[13].incluido).toBe(false);
    expect(cap.user).not.toContain('Sem material no critério 14');
  });

  it('v28: o critério `baixa` conta na nota e vai para o sintetizador', async () => {
    const cap = {};
    const r = await finalizePipeline({
      openai: fakeOpenAI(cap), log: 'log', model: 'gpt-5.5', effort: 'medium',
      version: 'v28', variant: 'com-feedback', nodeOutputs: nodeOutputs(15),
    });
    expect(r.version).toBe('v28');
    expect(r.considerados).toBe(15);   // ninguém sai
    expect(r.notaFinal).toBe(76);      // (14×8 + 2) / 15 = 7,6 → 76
    expect(r.partes.length).toBe(15);
    expect(r.partes[14].confianca).toBe('baixa');
    expect(r.partes[14].incluido).toBe(true);
    expect(cap.user).toContain('Sem material no critério 15');
    expect(cap.user).not.toMatch(/NOTA: 8/); // o sintetizador segue sem ver números
  });

  it('v28: nó sem nota legível fica fora da conta (em qualquer versão)', async () => {
    const outs = nodeOutputs(15);
    outs[0] = { num: 1, text: 'ANÁLISE: preciso. Sem nota nenhuma aqui.', usage: null };
    const r = await finalizePipeline({
      openai: fakeOpenAI({}), log: 'log', model: 'gpt-5.5', effort: 'medium',
      version: 'v28', variant: 'com-feedback', nodeOutputs: outs,
    });
    expect(r.partes[0].incluido).toBe(false);
    expect(r.considerados).toBe(14);
  });

  // A saudação é colada por CÓDIGO no topo do feedback, e é de cada versão — não
  // do encanamento. O v28 leva só o enquadramento; o segundo parágrafo do v25 (o
  // pedido de descrever o raciocínio na caixa de estrela) não é dele. Isto já
  // escapou uma vez: ao versionar o pipeline, o v28 herdou a saudação do v25.
  it('saudação é por versão: o v28 não leva o parágrafo da caixa de estrela', async () => {
    const nodeOutputs = (n) => Array.from({ length: n }, (_, i) => ({
      num: i + 1, text: `ANÁLISE: preciso. C${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`, usage: null,
    }));
    const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Corpo do feedback.' } }], usage: null }) } } };

    const v28 = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v28', variant: 'com-feedback', nodeOutputs: nodeOutputs(15) });
    expect(v28.feedbackAluno).toMatch(/^Nota: 80\/100/);
    expect(v28.feedbackAluno).toContain('pré-correção');
    expect(v28.feedbackAluno).not.toMatch(/caixa de estrela|botão de estrela/);
    expect(v28.feedbackAluno).not.toContain('não ao que você pensou');
    expect(v28.feedbackAluno).toContain('Corpo do feedback.');

    // O v25 segue com os dois parágrafos do brief — é linha de base, não muda.
    const v25 = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'com-feedback', nodeOutputs: nodeOutputs(14) });
    expect(v25.feedbackAluno).toContain('botão de estrela');
    expect(v25.feedbackAluno).toContain('não ao que você pensou');

    // E as duas saudações são declaradas na versão, não num global compartilhado.
    expect(PIPELINE_VERSIONS.v28.saudacao).not.toBe(PIPELINE_VERSIONS.v25.saudacao);
  });

  it('evaluatorId do alternador chega ao resultado (rótulo da run)', async () => {
    const r = await finalizePipeline({
      openai: fakeOpenAI({}), log: 'log', model: 'gpt-5.5', effort: 'medium',
      version: 'v28', variant: 'so-nota', evaluatorId: 'v28-nota',
      nodeOutputs: Array.from({ length: 15 }, (_, i) => ({ num: i + 1, text: 'NOTA: 8', usage: null })),
    });
    expect(r.evaluator).toBe('v28-nota');
    expect(r.notaFinal).toBe(80);
    expect(r.feedbackAluno).toBe(null);
  });
});

// RACIOCÍNIO (v28). A cadeia bruta não existe em API nenhuma; o que dá para
// guardar é o RESUMO, e só pela Responses API — o chat.completions da OpenAI
// devolve apenas a contagem de tokens. O que estes testes protegem: o v28 usa o
// transporte que traz o resumo, o v25 NÃO muda de transporte (senão a linha de
// base de custo dele mudaria junto), o "mini" não recebe `summary` (a chamada
// falharia) e o prefixo cacheável continua sendo o mesmo em todos os nós.
describe('Avaliação Independente — captura do raciocínio (v28)', () => {
  // Cliente falso da Responses API: devolve o stream de eventos que a OpenAI
  // emite, incluindo os deltas do resumo do raciocínio.
  function fakeResponses(capture = {}) {
    capture.calls = [];
    return {
      responses: {
        create: async (args) => {
          capture.calls.push(args);
          const ehSintetizador = !args.input[0].content.includes('[CRITÉRIO]');
          const texto = ehSintetizador
            ? 'Corpo do feedback.'
            : 'ANÁLISE: preciso. Sustentou a leitura.\nNOTA: 8\nCONFIANÇA: alta';
          return (async function* () {
            yield { type: 'response.reasoning_summary_text.delta', delta: ehSintetizador ? 'Pensei no feedback.' : 'Pesei as travas F3 e F4.' };
            yield { type: 'response.output_text.delta', delta: texto };
            yield { type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 } } } };
          })();
        },
      },
      chat: { completions: { create: async () => { throw new Error('v28 com captura não deveria usar chat.completions'); } } },
    };
  }

  it('v28 roda pela Responses API, pede o resumo e guarda o raciocínio', async () => {
    const cap = {};
    const r = await runAvaliacaoIndependente({
      openai: fakeResponses(cap), bloco1: 'BLOCO1-SECRETO', log: 'T: oi',
      model: 'gpt-5.6-sol', effort: 'high', version: 'v28', variant: 'com-feedback', evaluatorId: 'v28',
    });

    expect(cap.calls.length).toBe(16); // 15 nós + sintetizador
    expect(cap.calls[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    // O prefixo cacheável continua idêntico em todos os nós (é o que a OpenAI
    // cacheia) e o Bloco 1 segue fora do que vai ao sintetizador.
    const nos = cap.calls.slice(0, 15);
    expect(new Set(nos.map((c) => c.instructions)).size).toBe(1);
    expect(nos[0].instructions).toContain('BLOCO1-SECRETO');
    expect(cap.calls[15].instructions).not.toContain('BLOCO1-SECRETO');

    // O .txt sai montado, com o resumo de cada nó e o do sintetizador.
    expect(r.reasoningTxt).toContain('Pesei as travas F3 e F4.');
    expect(r.reasoningTxt).toContain('Sintetizador');
    expect(r.reasoningTxt).toContain('Pensei no feedback.');
    expect((r.reasoningTxt.match(/nota 8\/10/g) || []).length).toBe(15);
    // E não vaza o Bloco 1 nem o feedback do aluno.
    expect(r.reasoningTxt).not.toContain('BLOCO1-SECRETO');
  });

  it('v25 não muda de transporte (segue no chat.completions, sem raciocínio)', async () => {
    let chamadasChat = 0;
    const openai = {
      chat: { completions: { create: async (body) => {
        chamadasChat++;
        const ehSintetizador = !body.messages[1].content.includes('[CRITÉRIO]');
        return {
          choices: [{ message: { content: ehSintetizador ? 'Corpo.' : 'ANÁLISE: ok. Fez.\nNOTA: 8\nCONFIANÇA: alta' } }],
          usage: null,
        };
      } } },
      responses: { create: async () => { throw new Error('v25 não deveria usar a Responses API'); } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'com-feedback',
    });
    expect(chamadasChat).toBe(15); // 14 nós + sintetizador
    expect(r.reasoningTxt).toBe('');
  });

  it('modelo "mini" não recebe summary (a chamada falharia)', async () => {
    expect(modelEmiteResumo('gpt-5.6-sol')).toBe(true);
    expect(modelEmiteResumo('gpt-5.4-mini-2026-03-17')).toBe(false);
    const cap = {};
    await runAvaliacaoIndependente({
      openai: fakeResponses(cap), bloco1: 'b', log: 'l',
      model: 'gpt-5.4-mini-2026-03-17', effort: 'low', version: 'v28', variant: 'so-nota',
    });
    expect(cap.calls[0].reasoning).toEqual({ effort: 'low' }); // sem summary
  });

  // GLM devolve o raciocínio no próprio chat.completions — de graça e sem trocar
  // de endpoint. Não faz sentido mandar o GLM para a Responses API da OpenAI.
  it('GLM: raciocínio vem do reasoning_content, no mesmo chat.completions', async () => {
    const openai = {
      chat: { completions: { create: async (body) => ({
        choices: [{ message: {
          content: body.messages[1].content.includes('[CRITÉRIO]') ? 'ANÁLISE: ok. Fez.\nNOTA: 7\nCONFIANÇA: alta' : 'Corpo.',
          reasoning_content: 'raciocínio do GLM',
        } }],
        usage: null,
      }) } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'glm-5.2', effort: 'max',
      provider: 'glm', version: 'v28', variant: 'com-feedback',
    });
    expect(r.reasoningTxt).toContain('raciocínio do GLM');
  });

  // Batch roda por /v1/chat/completions, que não devolve resumo: o .txt sai
  // vazio e o botão de baixar não aparece. Limitação do provedor, documentada.
  it('batch: sem resumo, o .txt fica vazio (nada a baixar)', async () => {
    const openai = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'Corpo.' } }], usage: null }) } } };
    const r = await finalizePipeline({
      openai, log: 'log', model: 'gpt-5.6-sol', effort: 'high', version: 'v28', variant: 'com-feedback', batch: true,
      nodeOutputs: Array.from({ length: 15 }, (_, i) => ({ num: i + 1, text: `ANÁLISE: preciso. C${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`, usage: null })),
    });
    expect(r.notaFinal).toBe(80);
    expect(r.reasoningTxt).toBe('');
  });

  it('buildReasoningTxt: vazio sem resumo; marca os nós que não devolveram', () => {
    const base = { evaluatorLabel: 'v28', version: 'v28', variant: 'com-feedback', model: 'gpt-5.6-sol', effort: 'high', notaFinal: 80 };
    expect(buildReasoningTxt({ ...base, partes: [{ num: 1, nome: 'X', reasoning: '' }], reasoningSintetizador: '' })).toBe('');
    const txt = buildReasoningTxt({
      ...base,
      partes: [
        { num: 1, nome: 'Precisão lexical', nota: 8, confianca: 'alta', incluido: true, reasoning: 'pensei A' },
        { num: 2, nome: 'Antifragilidade', nota: null, confianca: null, incluido: false, reasoning: '' },
      ],
      reasoningSintetizador: '',
    });
    expect(txt).toContain('1 · Precisão lexical');
    expect(txt).toContain('pensei A');
    expect(txt).toContain('Sem resumo de raciocínio em 1 nó(s): 2.');
  });
});

// Rate limit (429) do pipeline. O contador de TPM da OpenAI reserva o
// max_completion_tokens de cada chamada (~20k por nó), então o fan-out estoura o
// teto da organização e volta 429 com "try again in Xs". O que estes testes
// protegem: o 429 é retentado (não vira erro do job), a espera respeita o que o
// provedor pede e request inválido (400) NÃO é retentado.
describe('Avaliação Independente — retry de rate limit (pipeline)', () => {
  it('classifica o que vale retentar', () => {
    expect(isRetryableAIError({ status: 429 })).toBe(true);
    expect(isRetryableAIError({ status: 503 })).toBe(true);
    expect(isRetryableAIError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableAIError({ status: 400 })).toBe(false);
    expect(isRetryableAIError({ status: 401 })).toBe(false);
  });

  it('espera o Retry-After do provedor (header ou mensagem), com teto de 60s', () => {
    // header em segundos
    expect(retryDelayMs({ status: 429, headers: { 'retry-after': '6' } }, 0)).toBeGreaterThanOrEqual(7500);
    // header em ms vence o em segundos
    expect(retryDelayMs({ status: 429, headers: { 'retry-after-ms': '2000' } }, 0)).toBeLessThan(4000);
    // sem header: lê o "try again in 6.116s" da mensagem da OpenAI
    const msg = { status: 429, message: 'Rate limit reached ... Please try again in 6.116s.' };
    expect(retryDelayMs(msg, 0)).toBeGreaterThanOrEqual(7645);
    expect(retryDelayMs(msg, 0)).toBeLessThan(9000);
    // sem pista nenhuma: backoff exponencial, nunca acima de 60s
    expect(retryDelayMs({ status: 500 }, 0)).toBeLessThan(4000);
    expect(retryDelayMs({ status: 500 }, 10)).toBeLessThanOrEqual(60000);
  });

  it('finalizePipeline: 429 no sintetizador é retentado e a avaliação conclui', async () => {
    let calls = 0;
    const openai = {
      chat: { completions: { create: async () => {
        calls++;
        if (calls === 1) {
          const e = new Error('Rate limit reached ... Please try again in 0.01s.');
          e.status = 429;
          e.headers = { 'retry-after-ms': '5' };
          throw e;
        }
        return { choices: [{ message: { content: 'Corpo do feedback.' } }], usage: null };
      } } },
    };
    const nodeOutputs = Array.from({ length: 14 }, (_, i) => ({
      num: i + 1, text: `ANÁLISE: ok. Critério ${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`, usage: null,
    }));
    const r = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'com-feedback', nodeOutputs });
    expect(calls).toBe(2);
    expect(r.corpoSintetizador).toBe('Corpo do feedback.');
  });

  it('finalizePipeline: 400 (request inválido) sobe na hora, sem retentar', async () => {
    let calls = 0;
    const openai = {
      chat: { completions: { create: async () => {
        calls++;
        const e = new Error('Invalid value for reasoning_effort');
        e.status = 400;
        throw e;
      } } },
    };
    const nodeOutputs = Array.from({ length: 14 }, (_, i) => ({
      num: i + 1, text: `ANÁLISE: ok. Critério ${i + 1}.\nNOTA: 8\nCONFIANÇA: alta`, usage: null,
    }));
    await expect(finalizePipeline({ openai, log: 'log', model: 'gpt-5.5', effort: 'medium', version: 'v25', variant: 'com-feedback', nodeOutputs }))
      .rejects.toThrow(/reasoning_effort/);
    expect(calls).toBe(1);
  });
});

describe('Avaliação Independente — endpoint', () => {
  beforeEach(() => resetData());

  // O .txt do raciocínio mora em arquivo no volume, servido por rota própria
  // (não vai no payload do resultado, que é polido a cada segundo). O que este
  // teste protege é o acesso: quem não é supervisor/admin não chega, e run
  // inexistente ou sem raciocínio dá 404 em vez de vazar caminho.
  it('download do raciocínio: 403 para aluno, 404 quando não existe', async () => {
    const aluno = await loginAs('aluno');
    const negado = await request(app).get('/api/avaliacao-independente/av25-1-aaaaaa/reasoning').set(authHeader(aluno));
    expect(negado.status).toBe(403);

    const sup = await loginAs('prof');
    const inexistente = await request(app).get('/api/avaliacao-independente/av25-1-aaaaaa/reasoning').set(authHeader(sup));
    expect(inexistente.status).toBe(404);

    // Id fora do formato gerado por nós não vira caminho de arquivo.
    const traversal = await request(app).get('/api/avaliacao-independente/..%2F..%2Fetc%2Fpasswd/reasoning').set(authHeader(sup));
    expect([400, 404]).toContain(traversal.status);
  });

  it('valida avaliador/modelo/effort (400)', async () => {
    const t = await loginAs('prof'); // supervisor
    const base = { log: 'x', casoId: 'fp-test-1' };
    const bad1 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'nope' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'v25', model: 'bad' });
    expect(bad2.status).toBe(400);
    const bad3 = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'v25', model: 'gpt-5.5', effort: 'ultra' });
    expect(bad3.status).toBe(400);
    // As 4 entradas de pipeline (v28/v25, com feedback e só nota) passam pela
    // validação de avaliador — o 400 que sobra é o do caso de teste sem Bloco 1.
    for (const evaluator of ['v28', 'v28-nota', 'v25', 'v25-nota']) {
      const ok = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator, model: 'gpt-5.5', effort: 'medium' });
      expect(ok.body.error).toMatch(/Bloco 1/i);
    }
  });

  // GPT 5.6 Sol: entrou só neste laboratório, com dois degraus de reasoning acima
  // do 5.5. O que este teste protege é o ALLOWLIST de effort/batch, então olhamos
  // a MENSAGEM e não o status: o personagem de teste não tem Bloco 1, então todo
  // caminho válido termina em 400 ali — o que importa é que não seja o 400 de
  // "effort inválido"/"batch não disponível", provando que passou por eles.
  it('GPT 5.6 Sol: aceita xhigh/max, recusa none e não empresta effort ao 5.5', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', evaluator: 'v25' };

    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
        .send({ ...base, model: 'gpt-5.6-sol', effort });
      expect(res.body.error).toMatch(/Bloco 1/i); // passou do allowlist
    }

    // Batch é suportado — não pode cair no 400 de "provedor sem Batch API".
    const batch = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, model: 'gpt-5.6-sol', effort: 'high', batch: true });
    expect(batch.body.error).toMatch(/Bloco 1/i);

    // 'none' fica fora de propósito: avaliador sem raciocínio oculto vaza o Bloco 1.
    const none = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, model: 'gpt-5.6-sol', effort: 'none' });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/effort inválido/i);

    // Os degraus novos são só do 5.6 — o 5.5 continua em low/medium/high.
    const emprestado = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, model: 'gpt-5.5', effort: 'max' });
    expect(emprestado.status).toBe(400);
    expect(emprestado.body.error).toMatch(/effort inválido/i);

    // Terra e Luna entraram no mesmo laboratório, com a mesma escada de effort.
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna']) {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
          .send({ ...base, model, effort });
        expect(res.body.error).toMatch(/Bloco 1/i);
      }
      const none = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
        .send({ ...base, model, effort: 'none' });
      expect(none.body.error).toMatch(/effort inválido/i);
    }

    // Tier que não existe continua barrado, com a lista montada do AVAL_MODELOS.
    const inexistente = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, model: 'gpt-5.6-nova', effort: 'high' });
    expect(inexistente.status).toBe(400);
    expect(inexistente.body.error).toMatch(/gpt-5\.6-sol/);
    expect(inexistente.body.error).toMatch(/gpt-5\.6-luna/);
  });

  it('GLM: effort medium é inválido; batch é bloqueado', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', evaluator: 'v25', model: 'glm-5.2' };
    const effErr = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, effort: 'medium' });
    expect(effErr.status).toBe(400);
    expect(effErr.body.error).toMatch(/effort inválido/i);
    const batchErr = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, effort: 'max', batch: true });
    expect(batchErr.status).toBe(400);
    expect(batchErr.body.error).toMatch(/batch/i);
  });

  it('fila: supervisor vê (lista); aluno é barrado (403)', async () => {
    const sup = await loginAs('prof');
    const okr = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(sup));
    expect(okr.status).toBe(200);
    expect(Array.isArray(okr.body)).toBe(true);
    const aluno = await loginAs('aluno');
    const den = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(aluno));
    expect(den.status).toBe(403);
  });
});
