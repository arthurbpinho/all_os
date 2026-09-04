// MOTOR DO AVALIADOR (server/avaliador-pipeline.js) + a aba "Avaliar Sessão".
//
// Este arquivo substituiu o antigo `avaliacao-independente.test.js`, que cobria
// seis réguas ao mesmo tempo (v16-2, v18-25, v25, v28, v31, v32) com um formato
// de saída para cada. Sobrou uma: o v29. O que os testes de cá protegem é o que
// o CÓDIGO promete sobre ela, e é sempre a mesma lista de riscos:
//
//   · a nota NÃO é escolhida pelo modelo — ele responde travas, o código deriva
//     faixa e nota. Se essa derivação errar, a nota da escola erra;
//   · o Bloco 1 (gabarito) não pode chegar ao sintetizador, que escreve o texto
//     que o aluno lê;
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
  _resetTPM, parseSaidaDoNo, derivarFaixa, ETIQUETA_POR_FAIXA, NOTAS_POR_FAIXA,
} = require('../server/avaliador-pipeline');

// Saída de um nó: uma linha `Fn abre` por trava, uma `Fn realizada` por faixa
// aberta (mais a da F1 quando a trava da F2 não abre), e a ANÁLISE no FIM.
// `abertas` = travas respondidas com sim.
function saidaNo({ abertas = [2, 3, 4], realizadas = {}, analise = 'Devolveu a âncora e a paciente abriu.', comAnalise = true } = {}) {
  const linhas = [];
  for (const n of [2, 3, 4, 5]) {
    const abre = abertas.includes(n);
    linhas.push(`F${n} abre: ${abre ? 'sim' : 'não'}`);
    if (abre && realizadas[n] !== false) linhas.push(`F${n} realizada: ${realizadas[n] || 'completa'}`);
  }
  if (!abertas.includes(2) && realizadas[1] !== false) linhas.push(`F1 realizada: ${realizadas[1] || 'completa'}`);
  if (comAnalise) linhas.push(`ANÁLISE: ${analise}`);
  return linhas.join('\n');
}

// O v29 captura o resumo do raciocínio, então as chamadas vão pela Responses
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

// Quinze nós devolvendo a mesma saída; o 16º (sem [CRITÉRIO]) é o sintetizador.
const responderPadrao = (saida = saidaNo()) => (user) => (user.includes('[CRITÉRIO]') ? saida : 'Corpo do feedback.');

describe('motor do avaliador — versões e prompts', () => {
  it('só existem o v29 e o modo progressão dele', () => {
    expect(PIPELINE_VERSIONS_IDS).toEqual(['v29', 'v29-progressao']);
    // As versões antigas foram removidas de verdade, não só escondidas.
    for (const morta of ['v16-2', 'v18-25', 'v25', 'v28', 'v31', 'v32']) {
      expect(PIPELINE_VERSIONS[morta]).toBeUndefined();
      expect(() => loadAssets(morta)).toThrow(/inválida/i);
    }
  });

  it('v29: 15 critérios, sem confiança, sem nota no prompt e com os slots do caso', () => {
    const a = loadAssets('v29');
    expect(a.criteria.length).toBe(15);
    expect(a.criteria[6].nome).toBe('Coerência interna');
    expect(a.criteria[14].nome).toBe('Criatividade');
    expect(a.criteria.every((c) => c.linhaCurta && c.descricao)).toBe(true);

    expect(a.blockA).toMatch(/F2 abre: <sim\|não>/);
    expect(a.blockA).toMatch(/F1 realizada: <completa\|incompleta>/);
    expect(a.blockA).not.toMatch(/CONFIAN/i);   // o campo não existe nesta régua
    expect(a.blockA).not.toMatch(/NOTA:/);      // o nó não escreve nota
    // Nenhum numeral de nota à vista, para o modelo não ter alvo.
    expect(a.blockA).not.toMatch(/\b8 \(completa\)|\b7 \(incompleta\)/);
    expect(a.blockB).toContain('{{BLOCO_1}}');
    expect(a.blockB).toContain('{{LOG}}');
    expect(a.blockC).toContain('{{CRITÉRIO}}');
    // A separação dos dois juízos é o que caracteriza esta versão: se o arquivo
    // servido for outro, esta frase não está lá e o teste acusa.
    expect(a.blockA).toMatch(/aconteceu e funcionou/);
  });

  it('o .md do prompt não traz mais blocos de variante (com-feedback / só-nota)', () => {
    const a = loadAssets('v29');
    for (const bloco of [a.blockA, a.blockB, a.blockC]) {
      expect(bloco).not.toMatch(/@variante/);
    }
  });
});

// A NOTA nasce aqui, no código: o nó responde quatro travas e a realização da
// faixa, e a tabela abaixo é a que o prompt não mostra a ele. Errar esta
// derivação é errar a nota de todo mundo, então ela é testada valor por valor.
describe('motor do avaliador — faixa e nota derivadas por código', () => {
  it('faixa = maior Fn com todas as travas abaixo abertas; nota vem dela', () => {
    const nota = (abertas, realizadas) => parseSaidaDoNo(saidaNo({ abertas, realizadas })).nota;
    expect(nota([2, 3, 4, 5], {})).toBe(10);
    expect(nota([2, 3, 4, 5], { 5: 'incompleta' })).toBe(9);
    expect(nota([2, 3, 4], {})).toBe(8);
    expect(nota([2, 3, 4], { 4: 'incompleta' })).toBe(7);
    expect(nota([2, 3], {})).toBe(6);
    expect(nota([2, 3], { 3: 'incompleta' })).toBe(5);
    expect(nota([2], {})).toBe(4);
    expect(nota([2], { 2: 'incompleta' })).toBe(3);
    expect(nota([], {})).toBe(2);                       // F1 completa
    expect(nota([], { 1: 'incompleta' })).toBe(1);      // F1 incompleta
    expect(NOTAS_POR_FAIXA).toEqual({ 1: [2, 1], 2: [4, 3], 3: [6, 5], 4: [8, 7], 5: [10, 9] });
  });

  it('7 exige F3 e F4 abertas — não há atalho para ele', () => {
    // Sem a F3, a F4 aberta não promove: a subida para na primeira fechada.
    const semF3 = parseSaidaDoNo(saidaNo({ abertas: [2, 4], realizadas: { 4: 'incompleta' } }));
    expect(semF3.faixa).toBe(2);
    expect(semF3.nota).toBe(4);
  });

  it('trava aberta acima de uma fechada é descartada, e marca inconsistência', () => {
    const r = parseSaidaDoNo(saidaNo({ abertas: [3], realizadas: { 3: 'completa', 1: 'completa' } }));
    expect(r.faixa).toBe(1);   // a F2 não abriu, então para na F1
    expect(r.nota).toBe(2);
    expect(r.inconsistente).toBe(true);
    expect(r.realizacao).toBe('completa'); // a da F1, não a da F3

    const semBuraco = parseSaidaDoNo(saidaNo({ abertas: [2, 3] }));
    expect(semBuraco.inconsistente).toBe(false);
    expect(semBuraco.faixa).toBe(3);
  });

  it('derivarFaixa: para na primeira fechada; sem travas não deriva nada', () => {
    expect(derivarFaixa({ 2: true, 3: true, 4: false, 5: true })).toEqual({ faixa: 3, inconsistente: true });
    expect(derivarFaixa({ 2: false, 3: false, 4: false, 5: false })).toEqual({ faixa: 1, inconsistente: false });
    expect(derivarFaixa({}).faixa).toBe(null);
    expect(derivarFaixa(null).faixa).toBe(null);
  });

  it('realizada ausente vale completa, inclusive na F1', () => {
    const semRealizada = parseSaidaDoNo(saidaNo({ abertas: [2, 3], realizadas: { 3: false } }));
    expect(semRealizada.faixa).toBe(3);
    expect(semRealizada.nota).toBe(6); // a par, não a ímpar
    const f1 = parseSaidaDoNo(saidaNo({ abertas: [], realizadas: { 1: false } }));
    expect(f1.nota).toBe(2);
    // Faltar a realização de uma faixa DESCARTADA não muda nada.
    const descartada = parseSaidaDoNo(saidaNo({ abertas: [3], realizadas: { 3: false, 1: 'incompleta' } }));
    expect(descartada.nota).toBe(1);
  });

  it('a etiqueta sai só da faixa (completa/incompleta não a muda)', () => {
    expect(ETIQUETA_POR_FAIXA).toEqual({ 1: 'erro', 2: 'clichê', 3: 'potente', 4: 'preciso', 5: 'excepcional' });
    expect(parseSaidaDoNo(saidaNo({ abertas: [2, 3, 4] })).etiqueta).toBe('preciso');
    expect(parseSaidaDoNo(saidaNo({ abertas: [2, 3, 4], realizadas: { 4: 'incompleta' } })).etiqueta).toBe('preciso');
    expect(parseSaidaDoNo(saidaNo({ abertas: [2] })).etiqueta).toBe('clichê');
  });

  it('nó fora de formato não vira nota: fica de fora da conta, marcado', async () => {
    const openai = fakeResponses((user) => {
      if (!user.includes('[CRITÉRIO]')) return 'Corpo.';
      return user.includes('Criatividade') ? 'não entendi o pedido' : saidaNo({ abertas: [2, 3, 4] });
    });
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    const fora = r.partes.filter((p) => !p.incluido);
    expect(fora.length).toBe(1);
    expect(fora[0].nota).toBe(null);
    expect(r.considerados).toBe(14);   // a base acompanha
    expect(r.notaFinal).toBe(80);      // média dos que contaram
  });

  it('ANÁLISE antes das travas é sinalizada, e a retentativa vem desligada', async () => {
    const foraDeOrdem = ['ANÁLISE: escrevi antes.', 'F2 abre: sim', 'F2 realizada: completa', 'F3 abre: não', 'F4 abre: não', 'F5 abre: não'].join('\n');
    expect(parseSaidaDoNo(foraDeOrdem).analiseForaDeOrdem).toBe(true);
    expect(parseSaidaDoNo(saidaNo({})).analiseForaDeOrdem).toBe(false);
    // A análise não engole as linhas de trava mesmo fora de ordem.
    expect(parseSaidaDoNo(foraDeOrdem).analise).toBe('escrevi antes.');

    // Refazer custa uma chamada inteira e não prova nada sobre a ordem do
    // RACIOCÍNIO (só sobre a do texto). A detecção fica; a retentativa, não.
    const cap = {};
    const openai = fakeResponses((user) => (user.includes('[CRITÉRIO]') ? foraDeOrdem : 'Corpo.'), cap);
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    expect(cap.calls.length).toBe(16); // 15 nós + sintetizador, sem repetição
    expect(r.instrumentacao.retentativas).toBe(0);
    expect(r.partes.every((p) => p.analiseForaDeOrdem)).toBe(true);
    expect(r.notaFinal).toBe(40); // F2 aberta e completa em todos → nota 4
  });

  // Visto em produção: numa run do modo progressão, doze dos quinze nós
  // devolveram as travas (logo, a nota) e pararam antes da ANÁLISE, que é o
  // último campo do formato. A nota não se move com isso; o SINTETIZADOR é que
  // passa a escrever o feedback do aluno com um quinto da evidência.
  it('nó que volta sem ANÁLISE é refeito uma vez, e a chamada extra entra na conta', async () => {
    const semAnalise = saidaNo({ abertas: [2, 3, 4], comAnalise: false });
    const comAnalise = saidaNo({ abertas: [2, 3, 4] });
    const vistos = new Map();
    let chamadas = 0;
    // Primeira vez que cada critério é pedido: sem análise. Na segunda, com.
    const openai = fakeResponses((user) => {
      if (!user.includes('[CRITÉRIO]')) return 'Corpo.';
      chamadas++;
      const chave = user.slice(0, 200);
      const jaVeio = vistos.get(chave) || 0;
      vistos.set(chave, jaVeio + 1);
      return jaVeio === 0 ? semAnalise : comAnalise;
    });
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    expect(chamadas).toBe(30);                      // 15 nós × 2
    expect(r.instrumentacao.retentativas).toBe(15);
    expect(r.partes.every((p) => p.analise)).toBe(true);
    expect(r.notaFinal).toBe(80);                   // a nota não mudou
  });

  it('nó que insiste em não devolver ANÁLISE conta na nota e sai do feedback', async () => {
    const openai = fakeResponses(responderPadrao(saidaNo({ abertas: [2, 3, 4], comAnalise: false })));
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    expect(r.notaFinal).toBe(80);                   // as notas contam
    expect(r.partes.every((p) => p.incluido)).toBe(true);
    // Sem nenhuma análise não há o que sintetizar: não há feedback de aluno.
    expect(r.corpoSintetizador).toBe(null);
    expect(r.feedbackAluno).toBe(null);
  });

  it('a retentativa da análise pode ser desligada por env (para medir a omissão crua)', async () => {
    const antes = process.env.AVALIACAO_V25_RETRY_ANALISE;
    process.env.AVALIACAO_V25_RETRY_ANALISE = '0';
    try {
      let chamadas = 0;
      const openai = fakeResponses((user) => {
        if (user.includes('[CRITÉRIO]')) chamadas++;
        return user.includes('[CRITÉRIO]') ? saidaNo({ abertas: [2, 3, 4], comAnalise: false }) : 'Corpo.';
      });
      const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
      expect(chamadas).toBe(15); // uma por nó, sem refazer
      expect(r.instrumentacao.retentativas).toBe(0);
    } finally {
      if (antes === undefined) delete process.env.AVALIACAO_V25_RETRY_ANALISE;
      else process.env.AVALIACAO_V25_RETRY_ANALISE = antes;
    }
  });

  it('retentativa de ORDEM ligada por env: a tentativa descartada entra na conta de custo', async () => {
    const antes = process.env.AVALIACAO_V25_RETRY_ORDEM;
    process.env.AVALIACAO_V25_RETRY_ORDEM = '1'; // lido a cada chamada
    try {
      const foraDeOrdem = ['ANÁLISE: antes.', 'F2 abre: sim', 'F2 realizada: completa', 'F3 abre: não', 'F4 abre: não', 'F5 abre: não'].join('\n');
      let chamadas = 0;
      const openai = { responses: { create: async (args) => {
        chamadas++;
        const ehCrit = args.input[0].content.includes('[CRITÉRIO]');
        return (async function* () {
          yield { type: 'response.output_text.delta', delta: ehCrit ? foraDeOrdem : 'Corpo.' };
          yield { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 100 } } };
        })();
      } } };
      const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-sol', effort: 'high', version: 'v29' });
      expect(chamadas).toBe(31);                          // 15×2 + sintetizador
      expect(r.instrumentacao.chamadas).toBe(31);         // e a conta enxerga as 31
      expect(r.instrumentacao.retentativas).toBe(15);
      expect(r.instrumentacao.totais.output).toBe(3100);  // 31 × 100
    } finally {
      if (antes === undefined) delete process.env.AVALIACAO_V25_RETRY_ORDEM;
      else process.env.AVALIACAO_V25_RETRY_ORDEM = antes;
    }
  });
});

describe('motor do avaliador — pipeline ponta a ponta', () => {
  it('nota por código, etiquetas no sintetizador e Bloco 1 fora do que ele lê', async () => {
    let userSint = '';
    const openai = fakeResponses((user) => {
      const ehCriterio = user.includes('[CRITÉRIO]');
      if (!ehCriterio) userSint = user;
      return ehCriterio ? saidaNo({ abertas: [2, 3, 4] }) : 'Corpo do feedback.';
    });
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-luna', effort: 'high',
      version: 'v29', evaluatorId: 'v29',
    });
    expect(r.notaFinal).toBe(80);
    expect(r.considerados).toBe(15);
    expect(r.partes[0].etiqueta).toBe('preciso');
    expect(r.partes[0].confianca).toBeUndefined(); // o campo saiu da régua
    // O sintetizador recebe as 15 análises com a etiqueta colada por código...
    expect((userSint.match(/\[preciso\]/g) || []).length).toBe(15);
    // ...e NÃO recebe o gabarito do caso.
    expect(userSint).not.toContain('BLOCO1-SECRETO');
    expect(r.feedbackAluno).toMatch(/^Nota: 80\/100/);
    expect(r.feedbackAluno).toContain('pré-correção');
    expect(r.feedbackAluno).not.toMatch(/caixa de estrela|botão de estrela/);
  });

  it('o prefixo cacheável é o MESMO em todos os nós (é o que a OpenAI cacheia)', async () => {
    const cap = {};
    const openai = fakeResponses(responderPadrao(), cap);
    await runAvaliacaoIndependente({ openai, bloco1: 'BLOCO1', log: 'LOG', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    const nos = cap.calls.slice(0, 15);
    expect(new Set(nos.map((c) => c.instructions)).size).toBe(1);
    expect(nos[0].instructions).toContain('BLOCO1');
    expect(nos[0].instructions).toContain('LOG');
    // Cada nó recebe um critério diferente na parte que varia.
    expect(new Set(nos.map((c) => c.input[0].content)).size).toBe(15);
  });

  it('sem nenhum critério avaliável não há nota nem feedback (nem chamada ao sintetizador)', async () => {
    const cap = {};
    const openai = fakeResponses(() => 'não entendi', cap);
    const r = await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29' });
    expect(r.notaFinal).toBe(null);
    expect(r.feedbackAluno).toBe(null);
    expect(cap.calls.length).toBe(15); // o sintetizador não rodou
  });

  it('batch: os nós vêm do lote e o sintetizador roda síncrono no coletor', async () => {
    let chamadasSint = 0;
    const openai = { chat: { completions: { create: async () => {
      chamadasSint++;
      return { choices: [{ message: { content: 'Corpo.' } }], usage: null };
    } } } };
    const r = await finalizePipeline({
      openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v29', batch: true,
      nodeOutputs: Array.from({ length: 15 }, (_, i) => ({ num: i + 1, text: saidaNo({ abertas: [2, 3, 4], analise: `C${i + 1}.` }), usage: null })),
    });
    expect(chamadasSint).toBe(1);
    expect(r.notaFinal).toBe(80);
    expect(r.corpoSintetizador).toBe('Corpo.');
    // Batch roda em /v1/chat/completions, que não devolve resumo de raciocínio.
    expect(r.reasoningTxt).toBe('');
  });
});

describe('motor do avaliador — raciocínio, custo e transporte', () => {
  it('captura ligada usa a Responses API, pede o resumo e monta o .txt', async () => {
    const cap = {};
    const openai = fakeResponses(
      responderPadrao(saidaNo({ abertas: [2, 3, 4] })),
      cap,
      (user) => (user.includes('[CRITÉRIO]') ? 'Pesei as travas F3 e F4.' : 'Pensei no feedback.'),
    );
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'BLOCO1-SECRETO', log: 'T: oi', model: 'gpt-5.6-sol', effort: 'high', version: 'v29',
    });
    expect(cap.calls[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(r.reasoningTxt).toContain('Pesei as travas F3 e F4.');
    expect(r.reasoningTxt).toContain('Sintetizador');
    expect((r.reasoningTxt.match(/nota 8\/10/g) || []).length).toBe(15);
    // O .txt é do supervisor, mas nem ele recebe o gabarito de volta.
    expect(r.reasoningTxt).not.toContain('BLOCO1-SECRETO');
  });

  it('captura desligada (produção) segue no chat.completions e não guarda raciocínio', async () => {
    let chamadasChat = 0;
    const openai = {
      chat: { completions: { create: async (body) => {
        chamadasChat++;
        const ehSint = !body.messages[1].content.includes('[CRITÉRIO]');
        return { choices: [{ message: { content: ehSint ? 'Corpo.' : saidaNo({ abertas: [2, 3, 4] }) } }], usage: null };
      } } },
      responses: { create: async () => { throw new Error('sem captura não deveria usar a Responses API'); } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'gpt-5.6-luna', effort: 'high', version: 'v29', capturarReasoning: false,
    });
    expect(chamadasChat).toBe(16);
    expect(r.reasoningTxt).toBe('');
    expect(r.notaFinal).toBe(80);
  });

  it('modelo "mini" não recebe summary (a chamada falharia)', async () => {
    expect(modelEmiteResumo('gpt-5.6-sol')).toBe(true);
    expect(modelEmiteResumo('gpt-5.4-mini-2026-03-17')).toBe(false);
    const cap = {};
    const openai = fakeResponses(responderPadrao(), cap);
    await runAvaliacaoIndependente({ openai, bloco1: 'b', log: 'l', model: 'gpt-5.4-mini-2026-03-17', effort: 'low', version: 'v29' });
    expect(cap.calls[0].reasoning).toEqual({ effort: 'low' }); // sem summary
  });

  it('GLM: raciocínio vem do reasoning_content, no mesmo chat.completions', async () => {
    const openai = {
      chat: { completions: { create: async (body) => ({
        choices: [{ message: {
          content: body.messages[1].content.includes('[CRITÉRIO]') ? saidaNo({ abertas: [2, 3] }) : 'Corpo.',
          reasoning_content: 'raciocínio do GLM',
        } }],
        usage: null,
      }) } },
    };
    const r = await runAvaliacaoIndependente({
      openai, bloco1: 'b', log: 'l', model: 'glm-5.2', effort: 'max', provider: 'glm', version: 'v29',
    });
    expect(r.reasoningTxt).toContain('raciocínio do GLM');
    expect(r.notaFinal).toBe(60);
  });

  it('buildReasoningTxt: vazio sem resumo; marca os nós que não devolveram', () => {
    const base = { evaluatorLabel: 'v29', version: 'v29', model: 'gpt-5.6-luna', effort: 'high', notaFinal: 80 };
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
    const nos = Array.from({ length: 15 }, () => ({ usage, usages: [usage] }));
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
    const nodeOutputs = Array.from({ length: 15 }, (_, i) => ({ num: i + 1, text: saidaNo({ analise: `C${i + 1}.` }), usage: null }));
    const r = await finalizePipeline({ openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v29', nodeOutputs });
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
    const nodeOutputs = Array.from({ length: 15 }, (_, i) => ({ num: i + 1, text: saidaNo({ analise: `C${i + 1}.` }), usage: null }));
    await expect(finalizePipeline({ openai, log: 'log', model: 'gpt-5.6-luna', effort: 'high', version: 'v29', nodeOutputs }))
      .rejects.toThrow(/reasoning_effort/);
    expect(calls).toBe(1);
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

  // A tela roda a régua da PRODUÇÃO. O que ela alterna é modelo e effort, e é
  // por isso que o allowlist deles é testado: um effort que o modelo não aceita
  // vira 400 da API no meio de 15 chamadas.
  it('só aceita o avaliador oficial; o modo progressão não entra por aqui', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste' };

    const inventado = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'nope' });
    expect(inventado.status).toBe(400);
    expect(inventado.body.error).toMatch(/v29/);

    // Versões removidas do app não voltam pela porta do laboratório.
    for (const morta of ['v18-25', 'v25', 'v28', 'v31', 'v32']) {
      const res = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: morta });
      expect(res.status).toBe(400);
    }

    // O modo progressão precisa de cinco materiais; esta tela recebe um log.
    const prog = await request(app).post('/api/avaliacao-independente').set(authHeader(t)).send({ ...base, evaluator: 'v29-progressao' });
    expect(prog.status).toBe(400);

    // O oficial passa da validação de avaliador — o 400 que sobra é o do
    // personagem de teste sem Bloco 1.
    const ok = await request(app).post('/api/avaliacao-independente').set(authHeader(t))
      .send({ ...base, evaluator: 'v29', model: 'gpt-5.6-luna', effort: 'high' });
    expect(ok.body.error).toMatch(/Bloco 1/i);
  });

  it('allowlist de modelo e effort (400 com a lista montada do registro)', async () => {
    const t = await loginAs('prof');
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste', evaluator: 'v29' };

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
    const base = { log: 'x', casoId: 'fp-test-1', alunoNome: 'Aluno de Teste', evaluator: 'v29', model: 'glm-5.2' };
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
    fs.writeFileSync(path.join(DATA_DIR, 'avaliacao-fila.json'), JSON.stringify([{
      id: 'avjob-espera', createdAt: new Date().toISOString(),
      userId: 'x', userName: 'Supervisor', casoNome: 'Pedro',
      evaluator: 'v29', model: 'gpt-5.6-luna', modelKey: 'gpt-5.6-luna', effort: 'high',
      status: 'aguardando', batchId: null, tentativas: 0,
      espera: 'Aguardando vaga na fila da OpenAI.',
      log: 'T: oi', bloco1: 'segredo',
    }]));
    const res = await request(app).get('/api/avaliacao-independente/fila').set(authHeader(admin));
    expect(res.status).toBe(200);
    const job = res.body.find((j) => j.id === 'avjob-espera');
    expect(job.status).toBe('aguardando');
    expect(job.espera).toMatch(/Aguardando vaga/);
    expect(job.error).toBe(null); // esperar não é falhar
    expect(JSON.stringify(job)).not.toContain('segredo');
  });
});
