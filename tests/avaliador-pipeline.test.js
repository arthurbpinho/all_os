// MOTOR DO AVALIADOR (server/avaliador-pipeline.js) + a aba "Avaliar Sessão".
//
// Este arquivo já cobriu seis réguas ao mesmo tempo (v16-2, v18-25, v25, v28,
// v31, v32), depois quatro (v29 e o modo progressão dele, v34 e v43). Sobrou
// UMA: o v34, que fechou como a régua LTS da escola, em três entradas — padrão,
// progressão e duelo. O que os testes de cá protegem é o que o CÓDIGO promete
// sobre ela, e é sempre a mesma lista de riscos:
//
//   · a nota NÃO é escolhida pelo modelo — ele escolhe cinco qualidades, e o
//     código soma. Se essa soma errar, a nota da escola erra;
//   · a leitura é POR NOME. Os cinco rótulos aceitam os mesmos três valores,
//     então posição não identifica nada: uma linha faltando deslocaria todas as
//     seguintes em silêncio e a run sairia com nota errada sem nada acusar;
//   · linha faltando é ERRO, não valor assumido. Não há default defensável;
//   · o mapa plena/parcial/ausente → 2/1/0 mora só no código. Se ele vazar para
//     o prompt, o modelo passa a ter alvo a mirar;
//   · o Bloco 1 (gabarito) não pode chegar ao sintetizador, que escreve o texto
//     que o aluno lê;
//   · no DUELO, um nó que erra o formato sobre um aluno não pode derrubar o
//     outro — e o vencedor sai da comparação das notas, nunca do modelo;
//   · rate limit e TPM não podem virar avaliação perdida;
//   · o custo medido tem de incluir toda chamada cobrada, inclusive a
//     descartada por retentativa.
const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, authHeader, DATA_DIR } = require('./helpers');
const {
  resolvePrices, buildChatBody, loadAssets, finalizePipeline, runAvaliacaoIndependente,
  buildReasoningTxt, buildInstrumentacao, modelEmiteResumo, isRetryableAIError, retryDelayMs,
  PIPELINE_VERSIONS, PIPELINE_VERSIONS_IDS, concorrenciaPorTPM, estimarTokens, reservarTPM,
  _resetTPM, PONTOS_POR_QUALIDADE, QUALIDADES_V34, SAUDACAO, ladosDe,
  parseSaidaDoNoQualidades, parseSaidaDoNoComparativa, buildPipelineNodeRequests,
} = require('../server/avaliador-pipeline');

// O v34 captura o resumo do raciocínio, então as chamadas vão pela Responses
// API. `responder(user)` devolve o texto de saída daquela chamada.
function fakeResponses(responder, capture = {}, resumo = null) {
  capture.calls = [];
  return {
    responses: {
      create: async (args) => {
        capture.calls.push(args);
        const texto = responder(args.input[0].content);
        return (async function* () {
          if (resumo) yield { type: 'response.reasoning_summary_text.delta', delta: resumo(args.input[0].content) };
          yield { type: 'response.output_text.delta', delta: texto };
          yield { type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 200 } } };
        })();
      },
    },
    chat: { completions: { create: async () => { throw new Error('com captura ligada, não deveria usar chat.completions'); } } },
  };
}

// Saída de um nó: as cinco linhas nomeadas + a ANÁLISE no fim.
function saidaQual({ v = {}, analise = 'Devolveu a âncora e a paciente abriu.', comAnalise = true, omitir = [], ordem = null } = {}) {
  const padrao = {
    Integridade: 'plena', Autoria: 'parcial', 'Potência': 'parcial',
    'Calibração': 'plena', Excepcionalidade: 'ausente',
  };
  const valores = { ...padrao, ...v };
  const nomes = (ordem || Object.keys(padrao)).filter((n) => !omitir.includes(n));
  const linhas = nomes.map((n) => `${n}: ${valores[n]}`);
  if (comAnalise) linhas.push(`ANÁLISE: ${analise}`);
  return linhas.join('\n');
}
// 2+1+1+2+0 = 6, que é a nota do nó padrão acima.
const NOTA_PADRAO_V34 = 6;

// Oito nós devolvendo a mesma saída; o nono (sem [CRITÉRIO]) é o sintetizador.
const responderPadrao = (saida = saidaQual()) => (user) => (user.includes('[CRITÉRIO]') ? saida : 'Corpo do feedback.');


describe('motor do avaliador — raciocínio, custo e transporte', () => {
  it('captura ligada usa a Responses API, pede o resumo e monta o .txt', async () => {
    const cap = {};
    const openai = fakeResponses(
      responderPadrao(saidaQual()),
      cap,
      (user) => (user.includes('[CRITÉRIO]') ? 'Pesei a Calibração contra o log.' : 'Pensei no feedback.'),
    );
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-sol', effort: 'high', version: 'v34',
    });
    expect(cap.calls[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(r.reasoningTxt).toContain('Pesei a Calibração contra o log.');
    expect(r.reasoningTxt).toContain('Sintetizador');
    expect((r.reasoningTxt.match(new RegExp(`nota ${NOTA_PADRAO_V34}\\/10`, 'g')) || []).length).toBe(8);
    // O .txt é do supervisor, mas nem ele recebe o gabarito de volta.
    expect(r.reasoningTxt).not.toContain('BLOCO1-SECRETO');
  });

  it('captura desligada (produção) segue no chat.completions e não guarda raciocínio', async () => {
    let chamadasChat = 0;
    const openai = {
      chat: { completions: { create: async (body) => {
        chamadasChat++;
        const ehSint = !body.messages[1].content.includes('[CRITÉRIO]');
        return { choices: [{ message: { content: ehSint ? 'Corpo.' : saidaQual() } }], usage: null };
      } } },
      responses: { create: async () => { throw new Error('sem captura não deveria usar a Responses API'); } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v34', capturarReasoning: false,
    });
    expect(chamadasChat).toBe(9); // oito nós + o sintetizador
    expect(r.reasoningTxt).toBe('');
    expect(r.notaFinal).toBe(NOTA_PADRAO_V34 * 10);
  });

  it('modelo "mini" não recebe summary (a chamada falharia)', async () => {
    expect(modelEmiteResumo('gpt-5.6-sol')).toBe(true);
    expect(modelEmiteResumo('gpt-5.4-mini-2026-03-17')).toBe(false);
    const cap = {};
    const openai = fakeResponses(responderPadrao(), cap);
    await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.4-mini-2026-03-17', effort: 'low', version: 'v34' });
    expect(cap.calls[0].reasoning).toEqual({ effort: 'low' }); // sem summary
  });

  it('GLM: raciocínio vem do reasoning_content, no mesmo chat.completions', async () => {
    const openai = {
      chat: { completions: { create: async (body) => ({
        choices: [{ message: {
          content: body.messages[1].content.includes('[CRITÉRIO]') ? saidaQual({ v: { Integridade: 'plena', Autoria: 'plena' } }) : 'Corpo.',
          reasoning_content: 'raciocínio do GLM',
        } }],
        usage: null,
      }) } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'glm-5.2', effort: 'max', provider: 'glm', version: 'v34',
    });
    expect(r.reasoningTxt).toContain('raciocínio do GLM');
    expect(r.notaFinal).toBe(70); // 2+2+1+2+0 por critério
  });

  it('buildReasoningTxt: vazio sem resumo; marca os nós que não devolveram', () => {
    const base = { evaluatorLabel: 'v34', version: 'v34', model: 'gpt-5.6-luna', effort: 'high', notaFinal: 80 };
    expect(buildReasoningTxt({ ...base, partes: [{ num: 1, nome: 'X', reasoning: '' }], reasoningSintetizador: '' })).toBe('');
    const txt = buildReasoningTxt({
      ...base,
      partes: [
        { num: 1, nome: 'Precisão lexical', nota: 8, incluido: true, reasoning: 'pensei A' },
        { num: 2, nome: 'Antifragilidade', nota: null, incluido: false, reasoning: '' },
      ],
      reasoningSintetizador: '',
    });
    expect(txt).toContain('1 · Precisão lexical');
    expect(txt).toContain('pensei A');
    expect(txt).toContain('Sem resumo de raciocínio em 1 nó(s): 2.');
  });

  it('resolvePrices casa pelo prefixo mais longo e não chuta tier desconhecido', () => {
    expect(resolvePrices('gpt-5.6-sol')).toMatchObject({ input: 5, cached: 0.5, output: 30 });
    expect(resolvePrices('gpt-5.6-terra')).toMatchObject({ input: 2, output: 12 });
    expect(resolvePrices('gpt-5.6-luna')).toMatchObject({ input: 0.2, output: 1.2 });
    expect(resolvePrices('gpt-5.5-2026-04-23')).toMatchObject({ input: 5, output: 30 });
    // mini vence o prefixo curto do 5.4
    expect(resolvePrices('gpt-5.4-mini-2026-03-17')).toMatchObject({ input: 0.75, output: 4.5 });
    expect(resolvePrices('gpt-5.4-2026-03-05')).toMatchObject({ input: 2.5, output: 15 });
    expect(resolvePrices('glm-5.2')).toMatchObject({ input: 1.4, output: 4.4 });
    expect(resolvePrices('modelo-que-nao-existe')).toBe(null);
  });

  it('buildChatBody: GPT usa reasoning_effort/max_completion_tokens; GLM usa thinking/max_tokens', () => {
    const msgs = [{ role: 'user', content: 'x' }];
    const gpt = buildChatBody({ provider: 'openai', model: 'gpt-5.6-luna', messages: msgs, maxTokens: 16000, effort: 'high' });
    expect(gpt.reasoning_effort).toBe('high');
    expect(gpt.max_completion_tokens).toBe(16000);
    expect(gpt.thinking).toBeUndefined();

    const glm = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 16000, effort: 'max' });
    expect(glm.thinking).toEqual({ type: 'enabled' });
    expect(glm.reasoning_effort).toBe('max');
    expect(glm.max_tokens).toBe(16000);
    const glmOff = buildChatBody({ provider: 'glm', model: 'glm-5.2', messages: msgs, maxTokens: 100, effort: 'disabled' });
    expect(glmOff.thinking).toEqual({ type: 'disabled' });
    expect(glmOff.reasoning_effort).toBeUndefined();
  });

  it('batch aplica 50% nos nós e cobra o sintetizador cheio', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } };
    const nos = Array.from({ length: 8 }, () => ({ usage, usages: [usage] }));
    const cheio = buildInstrumentacao('gpt-5.6-luna', nos, usage, 'high', false);
    const comBatch = buildInstrumentacao('gpt-5.6-luna', nos, usage, 'high', true);
    expect(comBatch.batch).toBe(true);
    expect(comBatch.custo.usd).toBeLessThan(cheio.custo.usd);
    // O sintetizador não vai no lote: o desconto não é de 50% no total.
    expect(comBatch.custo.usd).toBeGreaterThan(cheio.custo.usd * 0.5);
  });
});

// Rate limit (429) e TPM. O contador da OpenAI RESERVA o teto de saída de cada
// chamada, então o fan-out de 15 nós estoura a janela da organização. O que
// estes testes protegem: 429 é retentado (não vira avaliação perdida), a espera
// respeita o que o provedor pede, e request inválido (400) NÃO é retentado.
describe('motor do avaliador — TPM e retentativas', () => {
  it('concorrência cai quando a chamada fica pesada', () => {
    expect(concorrenciaPorTPM(12000, 4)).toBe(4);
    expect(concorrenciaPorTPM(32528, 4)).toBe(3);
    expect(concorrenciaPorTPM(500000, 4)).toBe(1); // serial, nunca zero
    // Dois lotes seguidos precisam caber no minuto, porque a janela desliza.
    for (const reserva of [12000, 20000, 32528, 50000]) {
      expect(reserva * concorrenciaPorTPM(reserva, 4) * 2).toBeLessThanOrEqual(200000);
    }
    // Sem estimativa utilizável, mantém o teto (não trava o fan-out).
    expect(concorrenciaPorTPM(0, 4)).toBe(4);
    expect(concorrenciaPorTPM(NaN, 4)).toBe(4);
  });

  it('limitador de TPM: deixa passar o que cabe e segura o que não cabe', async () => {
    const antes = process.env.AVALIACAO_V25_TPM_LIMITER;
    const antesTeto = process.env.AVALIACAO_V25_TPM;
    process.env.AVALIACAO_V25_TPM_LIMITER = '1';
    process.env.AVALIACAO_V25_TPM = '100000'; // orçamento = 85k
    _resetTPM();
    try {
      const t0 = Date.now();
      for (let i = 0; i < 4; i++) await reservarTPM(20000);
      expect(Date.now() - t0).toBeLessThan(200);

      let passou = false;
      const pendente = reservarTPM(20000).then(() => { passou = true; });
      await new Promise((r) => setTimeout(r, 120));
      expect(passou).toBe(false);

      process.env.AVALIACAO_V25_TPM_LIMITER = '0';
      const t1 = Date.now();
      await reservarTPM(999999);
      expect(Date.now() - t1).toBeLessThan(100);
      void pendente;
    } finally {
      if (antes === undefined) delete process.env.AVALIACAO_V25_TPM_LIMITER;
      else process.env.AVALIACAO_V25_TPM_LIMITER = antes;
      if (antesTeto === undefined) delete process.env.AVALIACAO_V25_TPM;
      else process.env.AVALIACAO_V25_TPM = antesTeto;
      _resetTPM();
    }
  });

  it('estimarTokens é pessimista (erra para menos concorrência)', () => {
    expect(estimarTokens('x'.repeat(3500))).toBe(1000);
    expect(estimarTokens('')).toBe(0);
    expect(estimarTokens(null)).toBe(0);
  });

  it('classifica o que vale retentar', () => {
    expect(isRetryableAIError({ status: 429 })).toBe(true);
    expect(isRetryableAIError({ status: 503 })).toBe(true);
    expect(isRetryableAIError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableAIError({ status: 400 })).toBe(false);
    expect(isRetryableAIError({ status: 401 })).toBe(false);
  });

  it('espera o Retry-After do provedor (header ou mensagem), com teto de 60s', () => {
    expect(retryDelayMs({ status: 429, headers: { 'retry-after': '6' } }, 0)).toBeGreaterThanOrEqual(7500);
    expect(retryDelayMs({ status: 429, headers: { 'retry-after-ms': '2000' } }, 0)).toBeLessThan(4000);
    const msg = { status: 429, message: 'Rate limit reached ... Please try again in 6.116s.' };
    expect(retryDelayMs(msg, 0)).toBeGreaterThanOrEqual(7645);
    expect(retryDelayMs(msg, 0)).toBeLessThan(9000);
    expect(retryDelayMs({ status: 500 }, 0)).toBeLessThan(4000);
    expect(retryDelayMs({ status: 500 }, 10)).toBeLessThanOrEqual(60000);
  });

  it('429 no sintetizador é retentado e a avaliação conclui', async () => {
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
    const nodeOutputs = Array.from({ length: 8 }, (_, i) => ({ num: i + 1, text: saidaQual({ analise: `C${i + 1}.` }), usage: null }));
    const r = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v34', nodeOutputs });
    expect(calls).toBe(2);
    expect(r.corpoSintetizador).toBe('Corpo do feedback.');
  });

  it('400 (request inválido) sobe na hora, sem retentar', async () => {
    let calls = 0;
    const openai = {
      chat: { completions: { create: async () => {
        calls++;
        const e = new Error('Invalid value for reasoning_effort');
        e.status = 400;
        throw e;
      } } },
    };
    const nodeOutputs = Array.from({ length: 8 }, (_, i) => ({ num: i + 1, text: saidaQual({ analise: `C${i + 1}.` }), usage: null }));
    await expect(finalizePipeline({ openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v34', nodeOutputs }))
      .rejects.toThrow(/reasoning_effort/);
    expect(calls).toBe(1);
  });
});

// ============================================================================
// v34 — a régua EM TESTE (só na Avaliação Independente)
// ----------------------------------------------------------------------------
// Desenho outro, e é isso que estes testes protegem. São oito critérios em vez
// de quinze, uma chamada por nó em vez de duas, e a nota do critério é a SOMA de
// cinco qualidades independentes em vez de uma tabela de faixas. Os riscos
// específicos dela:
//
//   · a leitura é POR NOME. Os cinco rótulos aceitam os mesmos três valores,
//     então posição não identifica nada: uma linha faltando deslocaria todas as
//     seguintes em silêncio e a run sairia com nota errada sem nada acusar;
//   · linha faltando é ERRO, não valor assumido. Não há default defensável;
//   · o mapa plena/parcial/ausente → 2/1/0 mora só no código. Se ele vazar para
//     o prompt, o modelo passa a ter alvo a mirar;
//   · os CINCO valores têm de ser persistidos, e não só a soma — é o que
//     permite reprocessar offline quando a ponderação mudar.
// ============================================================================

describe('v34 — prompts e critérios', () => {
  it('oito critérios, cinco qualidades no prompt e nenhum vestígio de trava ou faixa', () => {
    const a = loadAssets('v34');
    expect(a.criteria.length).toBe(8);
    expect(a.criteria[0].nome).toBe('Comunicação');
    expect(a.criteria[7].nome).toBe('Priorização');
    expect(a.criteria.every((c) => c.linhaCurta && c.descricao)).toBe(true);
    // O bloco do critério é o bloco INTEIRO do .md, não só o cabeçalho — foi
    // exatamente esse o bug do parser de cabeçalho numerado.
    expect(a.criteria.every((c) => c.descricao.length > 300)).toBe(true);

    // O formato de saída que o nó recebe.
    for (const q of ['Integridade', 'Autoria', 'Potência', 'Calibração', 'Excepcionalidade']) {
      expect(a.blockA).toContain(`${q}: <plena|parcial|ausente>`);
    }
    // A régua velha não sobrou em canto nenhum do prompt.
    expect(a.blockA).not.toMatch(/F[1-5]\s+abre/);
    expect(a.blockA).not.toMatch(/realizada/i);
    expect(a.blockA).not.toMatch(/CONFIAN/i);
    expect(a.blockA).not.toMatch(/NOTA:/);
    expect(a.blockB).toContain('{{BLOCO_1}}');
    expect(a.blockB).toContain('{{LOG}}');
    expect(a.blockC).toContain('{{CRITÉRIO}}');
  });

  // O prompt não menciona números DE PROPÓSITO: sem alvo a mirar, o modelo
  // escolhe a descrição que descreve o trabalho, e não a que soma mais. Se o
  // mapa vazar para um .md, a régua deixa de medir o que diz medir.
  it('o mapa para pontos não aparece em nenhum .md da versão', () => {
    const a = loadAssets('v34');
    for (const texto of [a.blockA, a.blockB, a.blockC, a.synthStatic, a.synthVariable, ...a.criteria.map((c) => c.descricao)]) {
      expect(texto).not.toMatch(/plena\s*[=:]\s*2|parcial\s*[=:]\s*1|ausente\s*[=:]\s*0/i);
      expect(texto).not.toMatch(/vale\s+(?:dois|um|2|1)\s+pontos?/i);
    }
    expect(PONTOS_POR_QUALIDADE).toEqual({ plena: 2, parcial: 1, ausente: 0 });
  });

  // O sintetizador conhece o significado das cinco qualidades e das três
  // posições — é ele quem decide o tom, e por isso o código não resume nada
  // antes de entregar.
  it('o sintetizador do v34 explica as cinco qualidades e não recebe nota', () => {
    const a = loadAssets('v34');
    for (const q of ['Integridade', 'Autoria', 'Potência', 'Calibração', 'Excepcionalidade']) {
      expect(a.synthStatic).toContain(q);
    }
    expect(a.synthVariable).toContain('{{LOG}}');
    expect(a.synthVariable).toContain('{{ANALISES}}');
  });
});

describe('v34 — a nota nasce da soma das cinco qualidades', () => {
  it('soma: plena vale o dobro de parcial, ausente não vale nada', () => {
    const nota = (v) => parseSaidaDoNoQualidades(saidaQual({ v })).nota;
    const todas = (valor) => Object.fromEntries(QUALIDADES_V34.map((q) => [q.rotulo, valor]));
    expect(nota(todas('plena'))).toBe(10);
    expect(nota(todas('parcial'))).toBe(5);
    expect(nota(todas('ausente'))).toBe(0);
    expect(nota({})).toBe(NOTA_PADRAO_V34); // 2+1+1+2+0
    expect(nota({ Excepcionalidade: 'plena' })).toBe(8);
  });

  // O ponto da leitura por nome: os cinco rótulos aceitam os mesmos três
  // valores, então a posição não identifica nada.
  it('lê por NOME: ordem trocada dá a mesma nota', () => {
    const direta = parseSaidaDoNoQualidades(saidaQual({}));
    const invertida = parseSaidaDoNoQualidades(saidaQual({
      ordem: ['Excepcionalidade', 'Calibração', 'Potência', 'Autoria', 'Integridade'],
    }));
    expect(invertida.nota).toBe(direta.nota);
    expect(invertida.qualidades).toEqual(direta.qualidades);
    expect(invertida.faltantes).toEqual([]);
  });

  // Aqui não há valor assumido (na régua de travas a realização ausente valia
  // `completa`, e aquilo tinha motivo). Somar quatro daria uma nota baixa
  // fingindo de avaliação; assumir um valor inventaria ponto.
  it('linha faltando é erro explícito: sem nota, e o critério sai da conta', () => {
    const r = parseSaidaDoNoQualidades(saidaQual({ omitir: ['Potência'] }));
    expect(r.nota).toBe(null);
    expect(r.faltantes).toEqual(['Potência']);
    // As que vieram continuam legíveis — o supervisor vê o que o nó chegou a dizer.
    expect(r.qualidades.integridade).toBe('plena');
    expect(parseSaidaDoNoQualidades('não entendi o pedido').faltantes).toHaveLength(5);
  });

  it('tolera acento perdido, bullet e negrito na linha', () => {
    const enfeitada = [
      '- **Integridade:** plena',
      '* Autoria : parcial',
      'Potencia: parcial',
      '**Calibracao**: plena',
      '• Excepcionalidade: ausente',
      '**ANÁLISE:** a paciente abriu.',
    ].join('\n');
    const r = parseSaidaDoNoQualidades(enfeitada);
    expect(r.nota).toBe(NOTA_PADRAO_V34);
    expect(r.faltantes).toEqual([]);
    expect(r.analise).toBe('a paciente abriu.');
  });

  it('análise antes das escolhas é sinalizada e não engole as linhas seguintes', () => {
    const fora = parseSaidaDoNoQualidades(saidaQual({ ordem: null, comAnalise: false }).split('\n').length
      ? ['ANÁLISE: escrevi antes.', saidaQual({ comAnalise: false })].join('\n')
      : '');
    expect(fora.analiseForaDeOrdem).toBe(true);
    expect(fora.analise).toBe('escrevi antes.');
    expect(fora.nota).toBe(NOTA_PADRAO_V34);
    expect(parseSaidaDoNoQualidades(saidaQual({})).analiseForaDeOrdem).toBe(false);
  });

  // A escala mudou: o piso de 1 por critério existia por causa da tabela de
  // faixas, que aqui não existe. Um atendimento sem nada vale 0, e não 10.
  it('a escala vai de 0 a 100, e não de 10 a 100', async () => {
    const zero = (valor) => async () => {
      const openai = fakeResponses(responderPadrao(saidaQual({
        v: Object.fromEntries(QUALIDADES_V34.map((q) => [q.rotulo, valor])),
      })));
      const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v34' });
      return r.notaFinal;
    };
    expect(await zero('ausente')()).toBe(0);
    expect(await zero('plena')()).toBe(100);
  });
});

describe('v34 — pipeline ponta a ponta', () => {
  it('oito nós, cinco valores guardados por critério, e nota = média × 10', async () => {
    const cap = {};
    const openai = fakeResponses(responderPadrao(saidaQual({})), cap);
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-luna', effort: 'high',
      version: 'v34', evaluatorId: 'v34',
    });
    expect(cap.calls.length).toBe(9); // 8 nós + sintetizador
    expect(r.partes.length).toBe(8);
    expect(r.considerados).toBe(8);
    expect(r.notaFinal).toBe(NOTA_PADRAO_V34 * 10);

    // Os CINCO valores, e não só a soma: é o que permite reprocessar offline se
    // a ponderação mudar.
    expect(r.partes[0].qualidades).toEqual({
      integridade: 'plena', autoria: 'parcial', potencia: 'parcial',
      calibracao: 'plena', excepcionalidade: 'ausente',
    });
    expect(r.partes[0].nota).toBe(NOTA_PADRAO_V34);
    // Nada da régua de travas sobrou nas partes: os campos não existem mais.
    for (const morto of ['faixa', 'etiqueta', 'travas', 'realizacao', 'travasInconsistentes']) {
      expect(r.partes[0][morto]).toBeUndefined();
    }
    // Modo individual: uma nota, e nenhum mapa por lado.
    expect(r.partes[0].notas).toBe(null);
    expect(r.comparativo).toBe(null);
  });

  it('o sintetizador recebe linha curta + as cinco linhas + a análise, e nenhuma etiqueta', async () => {
    let userSint = '';
    const openai = fakeResponses((user) => {
      if (!user.includes('[CRITÉRIO]')) userSint = user;
      return user.includes('[CRITÉRIO]') ? saidaQual({}) : 'Corpo do feedback.';
    });
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-luna', effort: 'high', version: 'v34',
    });
    expect(userSint).toContain('## 1 · Comunicação');
    expect(userSint).toContain('a escolha das palavras'); // a linha curta do critério 1
    expect(userSint).toContain('Integridade: plena\nAutoria: parcial\nPotência: parcial\nCalibração: plena\nExcepcionalidade: ausente\nDevolveu a âncora');
    // As cinco linhas em cada um dos oito blocos.
    expect((userSint.match(/^Excepcionalidade: ausente$/gm) || []).length).toBe(8);
    // Não existe mais etiqueta única derivada de faixa.
    expect(userSint).not.toMatch(/\[preciso\]|\[clichê\]|\[potente\]|\[excepcional\]|\[erro\]/);
    // E o gabarito do caso continua fora do que ele lê.
    expect(userSint).not.toContain('BLOCO1-SECRETO');

    // A saudação do v34 é a da versão, colada por fora junto da nota.
    expect(r.feedbackAluno).toMatch(/^Nota: 60\/100/);
    expect(r.feedbackAluno).toContain(SAUDACAO);
  });

  it('nó que insiste em não devolver as cinco linhas é refeito uma vez e depois sai da nota', async () => {
    const vistos = new Map();
    let chamadas = 0;
    // Primeira vez de cada critério: falta a Potência. Na segunda, completo.
    const openai = fakeResponses((user) => {
      if (!user.includes('[CRITÉRIO]')) return 'Corpo.';
      chamadas++;
      const chave = user.slice(0, 200);
      const jaVeio = vistos.get(chave) || 0;
      vistos.set(chave, jaVeio + 1);
      return jaVeio === 0 ? saidaQual({ omitir: ['Potência'] }) : saidaQual({});
    });
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v34' });
    expect(chamadas).toBe(16);                     // 8 nós × 2
    expect(r.instrumentacao.retentativas).toBe(8); // e a chamada extra entra na conta
    expect(r.notaFinal).toBe(NOTA_PADRAO_V34 * 10);
    expect(r.partes.every((p) => p.incluido)).toBe(true);

    // Insistindo, o critério fica de fora, marcado — e a base acompanha.
    const teimoso = fakeResponses((user) => (user.includes('[CRITÉRIO]')
      ? (user.includes('Priorização') ? saidaQual({ omitir: ['Autoria'] }) : saidaQual({}))
      : 'Corpo.'));
    const r2 = await runAvaliacaoIndependente({ openai: teimoso, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v34' });
    const fora = r2.partes.filter((p) => !p.incluido);
    expect(fora.length).toBe(1);
    expect(fora[0].nome).toBe('Priorização');
    expect(fora[0].nota).toBe(null);
    expect(fora[0].qualidadesFaltantes).toEqual(['Autoria']);
    expect(r2.considerados).toBe(7);
    // A média é dos sete que deram para ler — contar o oitavo como zero
    // transformaria um defeito de formato em nota baixa.
    expect(r2.notaFinal).toBe(NOTA_PADRAO_V34 * 10);
  });

  it('a retentativa das qualidades pode ser desligada por env (para medir a taxa crua)', async () => {
    const antes = process.env.AVALIACAO_V34_RETRY_QUALIDADES;
    process.env.AVALIACAO_V34_RETRY_QUALIDADES = '0';
    try {
      let chamadas = 0;
      const openai = fakeResponses((user) => {
        if (user.includes('[CRITÉRIO]')) chamadas++;
        return user.includes('[CRITÉRIO]') ? saidaQual({ omitir: ['Potência'] }) : 'Corpo.';
      });
      const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v34' });
      expect(chamadas).toBe(8);
      expect(r.instrumentacao.retentativas).toBe(0);
      expect(r.notaFinal).toBe(null); // nenhum critério legível
    } finally {
      if (antes === undefined) delete process.env.AVALIACAO_V34_RETRY_QUALIDADES;
      else process.env.AVALIACAO_V34_RETRY_QUALIDADES = antes;
    }
  });

  it('o resumo do raciocínio traz as cinco escolhas ao lado da nota do nó', async () => {
    const openai = fakeResponses(
      responderPadrao(saidaQual({})), {},
      (user) => (user.includes('[CRITÉRIO]') ? 'Pesei a calibração.' : 'Pensei no feedback.'),
    );
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-sol', effort: 'high', version: 'v34',
    });
    expect(r.reasoningTxt).toContain('Integridade: plena  ·  Autoria: parcial');
    expect((r.reasoningTxt.match(/nota 6\/10/g) || []).length).toBe(8);
    expect(r.reasoningTxt).not.toContain('BLOCO1-SECRETO');
  });

  it('batch: os oito nós vêm do lote e o sintetizador roda síncrono no coletor', async () => {
    let chamadasSint = 0;
    const openai = { chat: { completions: { create: async () => {
      chamadasSint++;
      return { choices: [{ message: { content: 'Corpo.' } }], usage: null };
    } } } };
    const r = await finalizePipeline({
      openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v34', batch: true,
      nodeOutputs: Array.from({ length: 8 }, (_, i) => ({ num: i + 1, text: saidaQual({ analise: `C${i + 1}.` }), usage: null })),
    });
    expect(chamadasSint).toBe(1);
    expect(r.notaFinal).toBe(NOTA_PADRAO_V34 * 10);
    expect(r.partes[3].qualidades.calibracao).toBe('plena');
  });
});

// ============================================================================
// AS TRÊS ENTRADAS DO v34
// ----------------------------------------------------------------------------
// A régua, os oito critérios e o contrato de saída do nó são os mesmos nas três.
// O que muda é o que chega ao nó, e é isso que estes testes protegem: os slots
// do caso, o nó da missão (só progressão) e o contrato comparativo (só duelo).
// ============================================================================

describe('v34 — as três entradas compartilham a régua', () => {
  it('existem as três, e as réguas antigas não voltam', () => {
    expect(PIPELINE_VERSIONS_IDS).toEqual(['v34', 'v34-progressao', 'v34-duelo']);
    for (const morta of ['v16-2', 'v18-25', 'v25', 'v28', 'v29', 'v29-progressao', 'v31', 'v32', 'v43']) {
      expect(PIPELINE_VERSIONS[morta]).toBeUndefined();
      expect(() => loadAssets(morta)).toThrow(/inválida/i);
    }
  });

  // Os critérios são LIDOS DA PASTA DO v34 nas três (`criteriosDe`). Duplicar o
  // .md faria as cópias divergirem na primeira edição pelo painel de prompts, e
  // aí as três entradas deixariam de ser a mesma régua sem nada acusar.
  it('os oito critérios são o MESMO arquivo nas três entradas', () => {
    const base = loadAssets('v34').criteria;
    for (const v of ['v34-progressao', 'v34-duelo']) {
      expect(loadAssets(v).criteria).toEqual(base);
    }
    expect(PIPELINE_VERSIONS['v34-progressao'].criteriosDe).toBe('v34');
    expect(PIPELINE_VERSIONS['v34-duelo'].criteriosDe).toBe('v34');
  });

  // As cinco qualidades, palavra por palavra, nas três. É o que garante que uma
  // nota de duelo e uma de treino medem a mesma coisa.
  it('as cinco qualidades e os três valores são os mesmos nas três', () => {
    for (const v of PIPELINE_VERSIONS_IDS) {
      const a = loadAssets(v);
      for (const q of QUALIDADES_V34) {
        expect(a.blockA).toContain(q.rotulo);
      }
      expect(a.blockA).toMatch(/plena\|parcial\|ausente/);
      // A régua velha não sobrou em canto nenhum.
      expect(a.blockA).not.toMatch(/F[1-5]\s+abre/);
      expect(a.blockA).not.toMatch(/CONFIAN/i);
      expect(a.blockA).not.toMatch(/NOTA:/);
    }
  });

  // O mapa para pontos mora só no código. Se vazar para um .md, o modelo passa a
  // ter alvo a mirar e a régua deixa de medir o que diz medir.
  it('o mapa para pontos não aparece em .md nenhum de entrada nenhuma', () => {
    for (const v of PIPELINE_VERSIONS_IDS) {
      const a = loadAssets(v);
      const textos = [a.blockA, a.blockB, a.blockC, a.synthStatic, a.synthVariable, ...a.criteria.map((c) => c.descricao)];
      if (a.missao) textos.push(a.missao.missaoStatic, a.missao.missaoVariable);
      for (const texto of textos) {
        expect(texto).not.toMatch(/plena\s*[=:]\s*2|parcial\s*[=:]\s*1|ausente\s*[=:]\s*0/i);
        expect(texto).not.toMatch(/vale\s+(?:dois|um|2|1)\s+pontos?/i);
      }
    }
  });
});

describe('v34-progressao — o reatendimento', () => {
  it('cinco slots do caso, três extras no sintetizador e o nó da missão', () => {
    const a = loadAssets('v34-progressao');
    expect(a.criteria.length).toBe(8);
    for (const slot of ['{{BLOCO_1}}', '{{ATENDIMENTO_1}}', '{{AVALIACAO_1}}', '{{MISSAO}}', '{{LOG}}']) {
      expect(a.blockB).toContain(slot);
    }
    for (const slot of ['{{LOG}}', '{{ANALISES}}', '{{ATENDIMENTO_1}}', '{{MISSAO}}', '{{MISSAO_VEREDITO}}']) {
      expect(a.synthVariable).toContain(slot);
    }
    expect(a.missao).toBeTruthy();
    expect(a.missao.missaoVariable).toContain('{{MISSAO}}');
    expect(a.missao.missaoVariable).toContain('{{LOG}}');
    // O sétimo princípio é o que existe SÓ neste modo: sem ele, a nota do
    // reatendimento é puxada para perto da anterior.
    expect(a.blockA).toMatch(/sete princípios/i);
    expect(a.blockA).toMatch(/atendimento anterior nem da missão/i);
  });

  // O nó da missão é uma chamada à parte, e é ela que decide a recompensa. Ele
  // não pontua critério nenhum, e o sintetizador recebe o veredito como FATO.
  it('o nó da missão roda junto dos oito, não pontua, e o veredito chega ao sintetizador', async () => {
    let sintUser = '';
    // O sintetizador da progressão TAMBÉM tem uma seção [MISSÃO ATIVA], então
    // quem desambigua é a seção das análises, que só ele recebe.
    const openai = fakeResponses((user) => {
      if (user.includes('[CRITÉRIO]')) return saidaQual();
      if (!user.includes('[AS ANÁLISES]')) return 'CUMPRIDA: sim\nJUSTIFICATIVA: nomeou o afeto e a paciente respondeu.';
      sintUser = user;
      return 'Corpo do feedback.';
    });
    const r = await runAvaliacaoIndependente({
      openai, version: 'v34-progressao', model: 'gpt-5.6-luna', effort: 'high',
      materiais: {
        '{{BLOCO_1}}': 'BLOCO1-SECRETO',
        '{{ATENDIMENTO_1}}': 'T: primeira vez',
        '{{AVALIACAO_1}}': 'nota anterior 60',
        '{{MISSAO}}': 'TÍTULO: nomear o afeto',
        '{{LOG}}': 'T: segunda vez',
      },
    });
    expect(r.missao).toEqual({ cumprida: true, legivel: true, justificativa: 'nomeou o afeto e a paciente respondeu.' });
    // A missão não move a nota: ela é a média dos oito critérios, como sempre.
    expect(r.notaFinal).toBe(NOTA_PADRAO_V34 * 10);
    expect(r.partes.length).toBe(8);
    // O sintetizador recebe o veredito já decidido, para não contradizer o que
    // o sistema vai registrar — e continua sem ver o Bloco 1.
    expect(sintUser).toContain('CUMPRIDA');
    expect(sintUser).toContain('T: primeira vez');
    expect(sintUser).not.toContain('BLOCO1-SECRETO');
  });

  // Sem resposta legível a missão NÃO é cumprida: a conclusão desbloqueia
  // recompensa, então o silêncio nunca pode virar um "sim" por omissão.
  it('missão ilegível não é dada por cumprida', async () => {
    const openai = fakeResponses((user) => {
      if (user.includes('[CRITÉRIO]')) return saidaQual();
      if (!user.includes('[AS ANÁLISES]')) return 'não entendi a pergunta';
      return 'Corpo.';
    });
    const r = await runAvaliacaoIndependente({
      openai, version: 'v34-progressao', model: 'gpt-5.6-luna', effort: 'high',
      materiais: { '{{BLOCO_1}}': 'b', '{{MISSAO}}': 'TÍTULO: x', '{{LOG}}': 'l' },
    });
    expect(r.missao.cumprida).toBe(false);
    expect(r.missao.legivel).toBe(false);
  });

  // Material que não existe entra com a FRASE de ausência, nunca com o slot cru:
  // uma seção em branco o modelo lê como falha nossa, e `{{ASSIM}}` ele lê como
  // texto literal.
  it('material ausente vira frase de ausência, e nenhum slot chega cru ao modelo', async () => {
    const cap = {};
    const openai = fakeResponses(responderPadrao(), cap);
    await runAvaliacaoIndependente({
      openai, version: 'v34-progressao', model: 'gpt-5.6-luna', effort: 'high',
      materiais: { '{{BLOCO_1}}': 'b', '{{LOG}}': 'l' },
    });
    const dev = cap.calls[0].instructions;
    expect(dev).toMatch(/não houve atendimento anterior/i);
    expect(dev).toMatch(/não há avaliação anterior/i);
    expect(dev).toMatch(/não há missão ativa/i);
    for (const call of cap.calls) {
      expect(`${call.instructions}${call.input[0].content}`).not.toMatch(/\{\{[A-Z]/);
    }
  });
});

describe('v34-duelo — dois alunos na mesma chamada', () => {
  it('cinco slots do caso (os dois logs), dois logs no sintetizador e saudação vazia', () => {
    const a = loadAssets('v34-duelo');
    expect(a.criteria.length).toBe(8);
    for (const slot of ['{{BLOCO_1}}', '{{ALUNO_A}}', '{{LOG_A}}', '{{ALUNO_B}}', '{{LOG_B}}']) {
      expect(a.blockB).toContain(slot);
    }
    for (const slot of ['{{LOG_A}}', '{{LOG_B}}', '{{ANALISES}}']) {
      expect(a.synthVariable).toContain(slot);
    }
    // O contrato de saída: dez linhas, cinco por aluno.
    for (const lado of ['A', 'B']) {
      for (const q of QUALIDADES_V34) {
        expect(a.blockA).toContain(`${lado} · ${q.rotulo}: <plena|parcial|ausente>`);
      }
    }
    expect(ladosDe(a.cfg)).toEqual(['A', 'B']);
    // O texto do duelo é em terceira pessoa: a saudação em segunda pessoa do
    // singular não cabe, e a versão declara isso como '' (não como ausente).
    expect(PIPELINE_VERSIONS['v34-duelo'].saudacao).toBe('');
    // O sétimo princípio deste modo é o que barra a contaminação entre os logs.
    expect(a.blockA).toMatch(/contra a régua, não contra o outro/i);
  });

  it('lê por NOME e por LADO: ordem trocada e acento perdido dão a mesma nota', () => {
    const linhas = [
      'B · Excepcionalidade: ausente',
      '- **A · Potencia**: plena',
      'A · Integridade: plena',
      'B · Calibracao: parcial',
      'A · Autoria: parcial',
      'B · Integridade: plena',
      'A · Calibração: plena',
      'B · Autoria: plena',
      'A · Excepcionalidade: ausente',
      'B · Potência: plena',
      'ANÁLISE: A recuou onde B insistiu.',
    ].join('\n');
    const r = parseSaidaDoNoComparativa(linhas);
    expect(r.notas.A).toBe(2 + 1 + 2 + 2 + 0);
    expect(r.notas.B).toBe(2 + 2 + 2 + 1 + 0);
    expect(r.faltantes).toEqual([]);
    expect(r.analise).toBe('A recuou onde B insistiu.');
  });

  // A falha que só o modo comparativo tem: um nó que erra o formato sobre um
  // aluno não pode derrubar o outro, que veio completo.
  it('linha faltando de um lado tira só AQUELE lado da conta', () => {
    const r = parseSaidaDoNoComparativa([
      'A · Integridade: plena',
      'A · Autoria: plena',
      'A · Potência: plena',
      'A · Calibração: plena',
      'A · Excepcionalidade: plena',
      'B · Integridade: plena',
      'B · Autoria: plena',
      'ANÁLISE: x.',
    ].join('\n'));
    expect(r.notas.A).toBe(10);
    expect(r.notas.B).toBe(null);       // nunca vira zero
    expect(r.faltantes).toEqual(['B · Potência', 'B · Calibração', 'B · Excepcionalidade']);
  });

  it('oito nós, duas notas, e o vencedor sai da comparação — nunca do modelo', async () => {
    let sintUser = '';
    // A ganha em todos os critérios: 10 contra 5.
    const saida = [
      ...QUALIDADES_V34.map((q) => `A · ${q.rotulo}: plena`),
      ...QUALIDADES_V34.map((q) => `B · ${q.rotulo}: parcial`),
      'ANÁLISE: A sustentou o que B largou.',
    ].join('\n');
    const openai = fakeResponses((user) => {
      if (user.includes('[CRITÉRIO]')) return saida;
      sintUser = user;
      return 'Corpo comparativo.';
    });
    const r = await runAvaliacaoIndependente({
      openai, version: 'v34-duelo', model: 'gpt-5.6-luna', effort: 'high',
      materiais: {
        '{{BLOCO_1}}': 'BLOCO1-SECRETO',
        '{{ALUNO_A}}': 'Ana', '{{LOG_A}}': 'T(Ana): oi',
        '{{ALUNO_B}}': 'Bruno', '{{LOG_B}}': 'T(Bruno): oi',
      },
    });
    expect(r.comparativo).toEqual({
      notas: { A: 100, B: 50 },
      considerados: { A: 8, B: 8 },
      vencedor: 'A',
    });
    // A nota única não existe no duelo: são duas, e elas aparecem lado a lado.
    expect(r.notaFinal).toBe(null);
    expect(r.partes.length).toBe(8);
    expect(r.partes[0].notas).toEqual({ A: 10, B: 5 });
    expect(r.partes[0].nota).toBe(null);
    expect(r.partes[0].qualidades.A.integridade).toBe('plena');
    expect(r.partes[0].qualidades.B.integridade).toBe('parcial');
    expect(r.partes[0].incluido).toEqual({ A: true, B: true });

    // O sintetizador comparativo vê os dois logs e as dez linhas por critério —
    // e continua sem ver o Bloco 1.
    expect(sintUser).toContain('T(Ana): oi');
    expect(sintUser).toContain('T(Bruno): oi');
    expect(sintUser).toContain('Aluno A —');
    expect(sintUser).toContain('Aluno B —');
    expect(sintUser).not.toContain('BLOCO1-SECRETO');

    // Sem saudação, e sem cabeçalho de nota única.
    expect(r.feedbackAluno).toContain('Aluno A: 100/100');
    expect(r.feedbackAluno).toContain('Aluno B: 50/100');
    expect(r.feedbackAluno).not.toContain(SAUDACAO);
  });

  it('empate real é empate; e sem nota de um dos lados não há vencedor', async () => {
    const empate = [
      ...QUALIDADES_V34.map((q) => `A · ${q.rotulo}: parcial`),
      ...QUALIDADES_V34.map((q) => `B · ${q.rotulo}: parcial`),
      'ANÁLISE: equivalentes.',
    ].join('\n');
    const openai = fakeResponses((user) => (user.includes('[CRITÉRIO]') ? empate : 'Corpo.'));
    const r = await runAvaliacaoIndependente({
      openai, version: 'v34-duelo', model: 'gpt-5.6-luna', effort: 'high',
      materiais: { '{{BLOCO_1}}': 'b', '{{LOG_A}}': 'a', '{{LOG_B}}': 'b' },
    });
    expect(r.comparativo.vencedor).toBe('empate');
    expect(r.comparativo.notas).toEqual({ A: 50, B: 50 });

    // Nenhum nó legível para o lado B: ele fica sem nota, e sem as duas não há
    // duelo a decidir — o caller devolve o duelo para pendente.
    const soA = [...QUALIDADES_V34.map((q) => `A · ${q.rotulo}: plena`), 'ANÁLISE: só A.'].join('\n');
    const openai2 = fakeResponses((user) => (user.includes('[CRITÉRIO]') ? soA : 'Corpo.'));
    const r2 = await runAvaliacaoIndependente({
      openai: openai2, version: 'v34-duelo', model: 'gpt-5.6-luna', effort: 'high',
      materiais: { '{{BLOCO_1}}': 'b', '{{LOG_A}}': 'a', '{{LOG_B}}': 'b' },
    });
    expect(r2.comparativo.notas).toEqual({ A: 100, B: null });
    expect(r2.comparativo.vencedor).toBe(null);
  });

  // Um critério que saiu da conta de UM lado não desequilibra a comparação: as
  // duas notas são médias normalizadas, não somas.
  it('critério fora da conta de um lado não desequilibra a comparação', async () => {
    const cheio = [
      ...QUALIDADES_V34.map((q) => `A · ${q.rotulo}: plena`),
      ...QUALIDADES_V34.map((q) => `B · ${q.rotulo}: plena`),
      'ANÁLISE: os dois no topo.',
    ].join('\n');
    // No critério 1 o nó esquece uma linha de B; nos outros sete responde tudo.
    const manco = [
      ...QUALIDADES_V34.map((q) => `A · ${q.rotulo}: plena`),
      ...QUALIDADES_V34.slice(0, 4).map((q) => `B · ${q.rotulo}: plena`),
      'ANÁLISE: faltou uma de B.',
    ].join('\n');
    // Pelo CRITÉRIO, e não por um contador: o nó que sai do formato é refeito
    // uma vez, e um contador daria a resposta boa na retentativa — o que este
    // teste quer é justamente o nó que INSISTE no formato errado.
    const openai = fakeResponses((user) => {
      if (!user.includes('[CRITÉRIO]')) return 'Corpo.';
      return user.includes('## 1 · Comunicação') ? manco : cheio;
    });
    const r = await runAvaliacaoIndependente({
      openai, version: 'v34-duelo', model: 'gpt-5.6-luna', effort: 'high',
      materiais: { '{{BLOCO_1}}': 'b', '{{LOG_A}}': 'a', '{{LOG_B}}': 'b' },
    });
    // Os dois tiram 100: A sobre oito critérios, B sobre os sete que deram.
    expect(r.comparativo.notas).toEqual({ A: 100, B: 100 });
    expect(r.comparativo.considerados).toEqual({ A: 8, B: 7 });
    expect(r.comparativo.vencedor).toBe('empate');
  });

  // O batch continua com uma requisição por CRITÉRIO nas três entradas: o
  // custom_id de um job em voo é `<job>::<num>`, e a coleta depende disso.
  it('batch: uma requisição por critério, com a chave = número, nas três entradas', () => {
    for (const version of PIPELINE_VERSIONS_IDS) {
      const reqs = buildPipelineNodeRequests({
        version, model: 'gpt-5.6-luna', effort: 'high',
        materiais: { '{{BLOCO_1}}': 'b', '{{LOG}}': 'l', '{{LOG_A}}': 'a', '{{LOG_B}}': 'b' },
      });
      expect(reqs.length).toBe(8);
      expect(reqs.map((r) => r.chave)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      expect(reqs[0].body.max_completion_tokens).toBe(16000);
    }
  });
});

describe('Avaliar Sessão (aba do supervisor) — endpoint', () => {
  beforeEach(() => resetData());

  // O .txt do raciocínio mora em arquivo no volume, servido por rota própria.
  // O que este teste protege é o acesso: quem não é supervisor/admin não chega,
  // e run inexistente dá 404 em vez de vazar caminho.
  it('download do raciocínio: 403 para aluno, 404 quando não existe', async () => {
    const aluno = await loginAs('aluno');
    const negado = await request(app).get('/api/avaliacao-independente/av25-1-aaaaaa/reasoning').set(authHeader(aluno));
    expect(negado.status).toBe(403);

    const sup = await loginAs('prof');
    const inexistente = await request(app).get('/api/avaliacao-independente/av25-1-aaaaaa/reasoning').set(authHeader(sup));
    expect(inexistente.status).toBe(404);

    const traversal = await request(app).get('/api/avaliacao-independente/..%2F..%2Fetc%2Fpasswd/reasoning').set(authHeader(sup));
    expect([400, 404]).toContain(traversal.status);
  });

  // A tela roda a régua da PRODUÇÃO e as que estiverem em teste — é comparar as
  // duas no mesmo log que diz se a nova mede melhor. O que ela alterna além
  // disso é modelo e effort, e é por isso que o allowlist deles é testado: um
  // effort que o modelo não aceita vira 400 da API no meio das oito chamadas.
  it('aceita só o avaliador oficial; progressão e duelo não entram por aqui', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste' };

    const inventado = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'nope' });
    expect(inventado.status).toBe(400);
    expect(inventado.body.error).toMatch(/v34/);

    // Versões removidas do app não voltam pela porta do laboratório.
    for (const morta of ['v18-25', 'v25', 'v28', 'v29', 'v31', 'v32', 'v43']) {
      const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: morta });
      expect(res.status).toBe(400);
    }

    // As outras ENTRADAS do v34 também não: a progressão precisa de cinco
    // materiais e o duelo de dois logs, e esta tela recebe um log colado.
    for (const entrada of ['v34-progressao', 'v34-duelo']) {
      const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: entrada });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Avaliador inválido/i);
    }

    // O oficial passa da validação de avaliador — o 400 que sobra é o do
    // personagem de teste sem Bloco 1.
    const ok = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, evaluator: 'v34', model: 'gpt-5.6-luna', effort: 'high' });
    expect(ok.body.error).toMatch(/Bloco 1/i);
  });

  it('allowlist de modelo e effort (400 com a lista montada do registro)', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste', evaluator: 'v34' };

    expect((await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, model: 'bad' })).status).toBe(400);

    // Os três tiers do 5.6 aceitam a escada inteira até 'max'...
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, model, effort });
        expect(res.body.error).toMatch(/Bloco 1/i); // passou do allowlist
      }
      // 'none' fica FORA de propósito: avaliador sem raciocínio oculto
      // externaliza o cruzamento com o Bloco 1 na prosa que o aluno lê.
      const none = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, model, effort: 'none' });
      expect(none.status).toBe(400);
      expect(none.body.error).toMatch(/effort inválido/i);
    }

    // ...e os degraus novos não são emprestados ao 5.5.
    const emprestado = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, model: 'gpt-5.5', effort: 'max' });
    expect(emprestado.status).toBe(400);
    expect(emprestado.body.error).toMatch(/effort inválido/i);

    // Tier que não existe: a mensagem lista os que existem.
    const inexistente = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, model: 'gpt-5.6-nova', effort: 'high' });
    expect(inexistente.body.error).toMatch(/gpt-5\.6-sol/);
    expect(inexistente.body.error).toMatch(/gpt-5\.6-luna/);
  });

  it('GLM: effort medium é inválido; batch é bloqueado (z.ai não tem Batch API)', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste', evaluator: 'v34', model: 'glm-5.2' };
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
    expect((await request(app).get('/api/avaliacao-independente/fila').set(authHeader(aluno))).status).toBe(403);
  });

  // Um job que ainda não entrou na Batch API (teto de tokens enfileirados cheio)
  // fica em 'aguardando' e o motivo viaja até a tela: a espera é um ESTADO
  // visível, não um erro nem um job sumido.
  it('fila: job aguardando vaga chega à tela com o motivo, sem vazar o caso', async () => {
    const admin = await loginAs('admin');
    const { db } = require('./helpers');
    const { criarRepoJobs } = require('../server/repos/jobs');
    await criarRepoJobs(db.getPool()).fila('avaliacao-fila').criar({
      id: 'avjob-espera', createdAt: new Date().toISOString(),
      userId: 'x', userName: 'Supervisor', casoNome: 'Pedro',
      evaluator: 'v34', model: 'gpt-5.6-luna', modelKey: 'gpt-5.6-luna', effort: 'high',
      status: 'aguardando', batchId: null, tentativas: 0,
      espera: 'Aguardando vaga na fila da OpenAI.',
      log: 'T: oi', bloco1: 'segredo',
    });
    const res = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(admin));
    expect(res.status).toBe(200);
    const job = res.body.find((j) => j.id === 'avjob-espera');
    expect(job.status).toBe('aguardando');
    expect(job.espera).toMatch(/Aguardando vaga/);
    expect(job.error).toBe(null); // esperar não é falhar
    expect(JSON.stringify(job)).not.toContain('segredo');
  });
});
