// Benchmarking de Simulação — laboratório do PACIENTE com aluno automatizado.
//
// O que é fácil de errar em silêncio aqui, e por isso está coberto:
//   · os presets (modelo + effort colados) e a lista de interações — se um deles
//     mudar sem querer, as runs deixam de ser comparáveis com as anteriores;
//   · a normalização de usage, que agora tem de aceitar DOIS transportes
//     (chat.completions e Responses API) na mesma run;
//   · a condição de captura do raciocínio, que é "só se for de graça";
//   · a troca de papéis no histórico — para cada lado, 'assistant' é a própria
//     fala, e inverter isso faria o modelo conversar consigo mesmo;
//   · a aritmética do resumo (paciente + aluno tem de fechar no total);
//   · o raciocínio NUNCA sair dentro do log normal (pedido explícito do dono);
//   · o gate de acesso e a validação antes de gastar chamada.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const bench = require('../server/benchmark-simulacao');

function turno(overrides = {}) {
  return {
    totais: { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200, reasoning: 50 },
    custo: { usd: 0.001, moeda: 'USD' },
    latenciaMs: 2000,
    reasoning: '',
    ...overrides,
  };
}

describe('Benchmarking de Simulação — presets', () => {
  it('os pacientes em teste são exatamente os três combos definidos pelo dono', () => {
    const cat = bench.benchCatalogo();
    expect(cat.pacientes.map((p) => `${p.modelKey}:${p.effort}`)).toEqual([
      'gpt-5.6-luna:high',
      'gpt-5.6-terra:high',
      'gpt-5.4-mini:none',
      'glm-5.2:high',
    ]);
    // Cada preset resolve id pinado, provedor e preço a partir do registro da
    // Simulação Independente (fonte única de preço do paciente).
    for (const p of cat.pacientes) {
      expect(p.model).toBeTruthy();
      expect(['openai', 'glm']).toContain(p.provider);
      expect(p.precos).toHaveProperty('input');
    }
  });

  it('o aluno simulado é FIXO em gpt-5.6-luna high (instrumento de medida)', () => {
    const a = bench.alunoPreset();
    expect(a.modelKey).toBe('gpt-5.6-luna');
    expect(a.effort).toBe('high');
    expect(a.provider).toBe('openai');
    expect(a.precos).toHaveProperty('output');
  });

  it('as opções de interações são 10/30/50/70 e nada mais', () => {
    expect(bench.BENCH_INTERACOES).toEqual([10, 30, 50, 70]);
    for (const n of [10, 30, 50, 70]) expect(bench.isValidInteracoes(n)).toBe(true);
    for (const n of [0, 1, 20, 71, 100, NaN, null]) expect(bench.isValidInteracoes(n)).toBe(false);
  });

  it('preset inexistente devolve null (o endpoint responde 400, não roda)', () => {
    expect(bench.patientPreset('gpt-5.6-sol-high')).toBe(null);
    expect(bench.patientPreset('')).toBe(null);
    expect(bench.isValidPatientKey('claude-sonnet-5')).toBe(false);
  });

  it('teto de tokens dá folga de raciocínio só quando o modelo vai pensar', () => {
    expect(bench.tetoTokens('none')).toBe(bench.BENCH_MAX_VISIBLE);
    expect(bench.tetoTokens('disabled')).toBe(bench.BENCH_MAX_VISIBLE);
    expect(bench.tetoTokens('high')).toBeGreaterThan(bench.BENCH_MAX_VISIBLE);
  });
});

describe('Benchmarking de Simulação — lote (vários modelos de uma vez)', () => {
  it('normalizePacientes deduplica, valida e devolve na ordem do catálogo', () => {
    const keys = (l) => (bench.normalizePacientes(l) || []).map((p) => p.key);
    // Ordem do catálogo (que é a de preço), não a ordem em que foram pedidos: a
    // tabela comparativa sai legível sem ninguém reordenar nada.
    expect(keys(['glm-5.2-high', 'gpt-5.6-luna-high'])).toEqual(['gpt-5.6-luna-high', 'glm-5.2-high']);
    expect(keys(['gpt-5.4-mini', 'gpt-5.4-mini'])).toEqual(['gpt-5.4-mini']);
    expect(keys(Object.keys(bench.BENCH_PACIENTES))).toHaveLength(4);
    // Uma chave inválida invalida o LOTE INTEIRO — melhor 400 do que rodar 3 dos
    // 4 modelos pedidos em silêncio.
    expect(bench.normalizePacientes(['gpt-5.4-mini', 'gpt-9'])).toBe(null);
    expect(bench.normalizePacientes([])).toBe(null);
    expect(bench.normalizePacientes(null)).toBe(null);
    expect(bench.normalizePacientes('gpt-5.4-mini')).toBe(null);
  });

  it('os modos são fila (padrão) e paralelo', () => {
    expect(bench.BENCH_MODOS).toEqual(['fila', 'paralelo']);
    expect(bench.BENCH_MODO_PADRAO).toBe('fila');
    expect(bench.isValidModo('fila')).toBe(true);
    expect(bench.isValidModo('paralelo')).toBe(true);
    expect(bench.isValidModo('turbo')).toBe(false);
  });

  const runDoLote = (key, usd, n = 10) => ({
    id: 'bench-1-' + key.slice(0, 8).padEnd(8, '0').replace(/[^0-9a-f]/g, 'a'),
    paciente: bench.patientPreset(key),
    status: 'completed',
    interacoesPedidas: 10,
    interacoes: new Array(n).fill({}),
    resumo: {
      paciente: { usd, mediaPorInteracao: usd / n, latenciaMedia: 3000, totais: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20, reasoning: 5 } },
      aluno: { usd: 0.02 },
    },
  });

  it('resumoComparativo: uma linha por modelo e a persona somada UMA vez', () => {
    const comp = bench.resumoComparativo({
      runs: [runDoLote('gpt-5.6-luna-high', 0.01), runDoLote('gpt-5.4-mini', 0.03)],
      personaTurno: { custo: { usd: 0.009 } },
    });
    expect(comp.linhas).toHaveLength(2);
    expect(comp.linhas[0].custoPorInteracao).toBeCloseTo(0.001, 10);
    expect(comp.totais.pacientes).toBeCloseTo(0.04, 10);
    expect(comp.totais.alunos).toBeCloseTo(0.04, 10);
    // A extração é do LOTE: entra uma vez, não uma por modelo.
    expect(comp.totais.persona).toBeCloseTo(0.009, 10);
    expect(comp.totais.geral).toBeCloseTo(0.089, 10);
    expect(comp.totais.interacoesFeitas).toBe(20);
  });

  it('resumoComparativo aguenta run que falhou no meio e lote sem persona', () => {
    const meio = runDoLote('glm-5.2-high', 0.005, 3);
    meio.status = 'error';
    meio.error = 'fala vazia duas vezes';
    const comp = bench.resumoComparativo({ runs: [meio], personaTurno: null });
    expect(comp.linhas[0].status).toBe('error');
    expect(comp.linhas[0].erro).toMatch(/vazia/);
    expect(comp.linhas[0].interacoesFeitas).toBe(3);   // o que rodou continua contado
    expect(comp.totais.persona).toBe(null);
    expect(comp.totais.geral).toBeCloseTo(0.025, 10);
  });

  it('o relatório do lote traz a tabela, o custo da persona e os ids das runs — sem transcrição', () => {
    const runs = [runDoLote('gpt-5.6-luna-high', 0.01), runDoLote('gpt-5.4-mini', 0.03)];
    const lote = {
      id: 'blote-1-aabbccdd', createdAt: '2026-08-19T12:00:00.000Z', userName: 'Admin',
      status: 'completed', casoNome: 'Enzo', alunoNome: 'Alan', aluno: bench.alunoPreset(),
      interacoes: 10, modo: 'fila', persona: 'COMO FALA\nFrases curtas.',
      personaTurno: { custo: { usd: 0.009 }, totais: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 } },
    };
    const txt = bench.buildLoteRelatorioTxt({ lote, runs });
    expect(txt).toContain('RELATÓRIO DO LOTE');
    expect(txt).toContain('GPT 5.6 Luna · high');
    expect(txt).toContain('GPT 5.4 mini · none');
    expect(txt).toContain('Modelos no lote: 2');
    expect(txt).toContain('FILA (um modelo por vez)');
    expect(txt).toContain('A MESMA ficha de persona foi usada em todos os modelos');
    expect(txt).toContain('Extração de persona (uma vez, do lote):  $0.009000');
    expect(txt).toContain('COMO FALA');
    expect(txt).toContain(runs[0].id);
    // Deixa explícito que os números não julgam qualidade — essa ferramenta é
    // outra, e o dono a quer depois.
    expect(txt).toMatch(/nada aqui julga a QUALIDADE/i);
  });

  it('o log de uma run em lote diz que a persona foi compartilhada', () => {
    const base = {
      id: 'bench-1-aabbccdd', createdAt: '2026-08-19T12:00:00.000Z', userName: 'Admin',
      status: 'completed', casoNome: 'Enzo', alunoNome: 'Alan', interacoesPedidas: 10,
      paciente: bench.patientPreset('gpt-5.4-mini'), aluno: bench.alunoPreset(),
      persona: 'FICHA', transcript: [], interacoes: [],
      loteId: 'blote-1-aabbccdd', personaCompartilhada: true,
      resumo: bench.resumoDeCustos({ interacoes: [], pacienteModelKey: 'gpt-5.4-mini', alunoModelKey: 'gpt-5.6-luna', personaTurno: null }),
    };
    const txt = bench.buildBenchLogTxt(base);
    expect(txt).toContain('compartilhada pelo lote');
    expect(txt).toContain('Lote: blote-1-aabbccdd');
  });
});

describe('Benchmarking de Simulação — usage nos dois transportes', () => {
  it('chat.completions: input desconta o cache, reasoning sai do output', () => {
    expect(bench.normalizeBenchUsage('openai', {
      prompt_tokens: 5000,
      prompt_tokens_details: { cached_tokens: 4000 },
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 5300,
    })).toEqual({ input: 1000, cacheRead: 4000, cacheWrite: 0, output: 300, reasoning: 120 });
  });

  it('Responses API: os campos têm outro nome e precisam dar o MESMO resultado', () => {
    // É o transporte usado quando queremos o resumo do raciocínio. Somar o shape
    // errado aqui daria custo silenciosamente subestimado.
    expect(bench.normalizeBenchUsage('openai', {
      input_tokens: 5000,
      input_tokens_details: { cached_tokens: 4000 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 5300,
    })).toEqual({ input: 1000, cacheRead: 4000, cacheWrite: 0, output: 300, reasoning: 120 });
  });

  it('GLM: usa total-prompt como piso da saída (o thinking é sub-reportado)', () => {
    const t = bench.normalizeBenchUsage('glm', { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2900 });
    expect(t.output).toBe(900);
    // O piso é SÓ do GLM: aplicá-lo na OpenAI inventaria tokens que ela não cobrou.
    expect(bench.normalizeBenchUsage('openai', { prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2900 }).output).toBe(50);
  });

  it('usage ausente não vira NaN no custo', () => {
    expect(bench.normalizeBenchUsage('openai', null)).toEqual(bench.zeroTotais());
  });
});

describe('Benchmarking de Simulação — captura do raciocínio (só se for grátis)', () => {
  it('luna high captura; mini none e effort desligado não', () => {
    expect(bench.capturaResumo({ provider: 'openai', model: 'gpt-5.6-luna', effort: 'high' })).toBe(true);
    // effort none = não há raciocínio nenhum pra resumir.
    expect(bench.capturaResumo({ provider: 'openai', model: 'gpt-5.6-luna', effort: 'none' })).toBe(false);
    // "mini" não tem sumarizador: pedir summary faz a chamada FALHAR.
    expect(bench.capturaResumo({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', effort: 'high' })).toBe(false);
    expect(bench.capturaResumo({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', effort: 'none' })).toBe(false);
  });

  it('GLM captura sem trocar de transporte (reasoning_content vem no chat)', () => {
    expect(bench.capturaResumo({ provider: 'glm', model: 'glm-5.2', effort: 'high' })).toBe(true);
    expect(bench.capturaResumo({ provider: 'glm', model: 'glm-5.2', effort: 'disabled' })).toBe(false);
  });

  it('os três presets do laboratório resolvem captura sem lançar', () => {
    const esperado = {
      'gpt-5.6-luna-high': true, 'gpt-5.6-terra-high': true, 'gpt-5.4-mini': false, 'glm-5.2-high': true,
    };
    for (const [key, valor] of Object.entries(esperado)) {
      expect(bench.capturaResumo(bench.patientPreset(key))).toBe(valor);
    }
  });
});

describe('Benchmarking de Simulação — histórico visto dos dois lados', () => {
  const transcript = [
    { ator: 'paciente', texto: 'Não sei por onde começar.' },
    { ator: 'aluno', texto: 'Comece por onde quiser.' },
    { ator: 'paciente', texto: 'Foi na semana passada…' },
  ];

  it('paciente: ele é o assistant e a conversa abre com o "Iniciar" oculto', () => {
    expect(bench.historyForPatient(transcript)).toEqual([
      { role: 'user', content: bench.KICKOFF },
      { role: 'assistant', content: 'Não sei por onde começar.' },
      { role: 'user', content: 'Comece por onde quiser.' },
      { role: 'assistant', content: 'Foi na semana passada…' },
    ]);
  });

  it('aluno: os papéis se invertem e não há kickoff (quem abre é o paciente)', () => {
    expect(bench.historyForAluno(transcript)).toEqual([
      { role: 'user', content: 'Não sei por onde começar.' },
      { role: 'assistant', content: 'Comece por onde quiser.' },
      { role: 'user', content: 'Foi na semana passada…' },
    ]);
  });

  it('transcrição vazia: o paciente ainda recebe o disparo; o aluno, nada', () => {
    expect(bench.historyForPatient([])).toEqual([{ role: 'user', content: bench.KICKOFF }]);
    expect(bench.historyForAluno([])).toEqual([]);
  });
});

describe('Benchmarking de Simulação — prompt do aluno simulado', () => {
  const prompt = bench.buildAlunoSystemPrompt({
    personaTexto: 'COMO FALA\nFrases curtas.', alunoNome: 'Alan', casoNome: 'Enzo',
  });

  it('carrega a ficha, nomeia os dois e proíbe encerrar a sessão', () => {
    expect(prompt).toContain('Alan');
    expect(prompt).toContain('Enzo');
    expect(prompt).toContain('COMO FALA\nFrases curtas.');
    expect(prompt).toMatch(/não encerre a sessão/i);
    // O ponto principal: reproduzir a pessoa do log, não um terapeuta melhor.
    expect(prompt).toMatch(/limites e vícios/i);
  });

  it('NÃO menciona o número de interações (senão as runs deixam de ser comparáveis)', () => {
    // Se o aluno soubesse que a sessão tem 10 falas, ele apressaria o fechamento
    // e os 10 primeiros turnos de uma run de 70 não valeriam como uma run de 10.
    for (const n of bench.BENCH_INTERACOES) expect(prompt).not.toContain(String(n));
  });

  it('apresenta a ficha como BASE, não como roteiro (anti-caricatura)', () => {
    // Regressão do caso do Batman: uma analogia usada uma vez no log original
    // virou assinatura do aluno simulado, presente em quase toda intervenção.
    expect(prompt).toMatch(/não é roteiro/i);
    expect(prompt).toMatch(/tendência não é obrigação/i);
    expect(prompt).toMatch(/repetir o mesmo tipo de recurso em falas seguidas está errado/i);
    expect(prompt).toMatch(/você varia/i);
  });

  it('sem ficha o prompt ainda é válido (não vira "undefined")', () => {
    const p = bench.buildAlunoSystemPrompt({ personaTexto: '', alunoNome: '', casoNome: '' });
    expect(p).not.toContain('undefined');
    expect(p).toContain('ficha indisponível');
  });
});

describe('Benchmarking de Simulação — prompt de extração da persona', () => {
  const instrucao = bench.PERSONA_INSTRUCTION;

  it('manda descrever a FORMA e proíbe o conteúdo daquela sessão', () => {
    // A ficha vai ser usada em outra sessão: citar a metáfora/exemplo/tema
    // específico do log faz o simulador tratá-lo como assinatura obrigatória.
    expect(instrucao).toMatch(/NUNCA O CONTEÚDO DAQUELA SESSÃO/i);
    expect(instrucao).toMatch(/nomeie a CLASSE dele e a FREQUÊNCIA, não a instância/i);
    expect(instrucao).toMatch(/caricatura/i);
    expect(instrucao).toMatch(/nada de citação literal/i);
  });

  it('exige DOSAGEM em toda tendência (traço sem dosagem é lido como "sempre")', () => {
    expect(instrucao).toMatch(/dosagem explícita/i);
    expect(instrucao).toMatch(/RECURSOS E DOSAGEM/);
  });

  it('mantém a exigência de descrever os limites (não idealizar o aluno)', () => {
    expect(instrucao).toMatch(/DESCREVA A PESSOA REAL, COM OS LIMITES DELA/i);
    expect(instrucao).toMatch(/melhor do que o da transcrição é uma ficha ERRADA/i);
    expect(instrucao).toMatch(/NÃO avalia/);
  });

  it('as seis seções da ficha estão todas no formato pedido', () => {
    for (const secao of ['COMO FALA', 'COMO CONDUZ', 'RECURSOS E DOSAGEM', 'ATENÇÃO CLÍNICA', 'LIMITES E VÍCIOS', 'ABERTURA E FECHAMENTO']) {
      expect(instrucao).toContain(secao);
    }
    // Teto de tamanho por seção: ficha detalhista demais vira roteiro.
    expect(instrucao).toMatch(/2 a 4 frases/);
  });

  it('o input carrega quem atendeu, quem foi atendido e o log', () => {
    const input = bench.buildPersonaInput({ log: 'LOG_AQUI', alunoNome: 'Alan', casoNome: 'Enzo' });
    expect(input).toContain('Alan');
    expect(input).toContain('Enzo');
    expect(input).toContain('LOG_AQUI');
    // Sem nome não vira "undefined" nem promete um nome que não existe.
    const anon = bench.buildPersonaInput({ log: 'LOG_AQUI', alunoNome: '', casoNome: '' });
    expect(anon).not.toContain('undefined');
    expect(anon).toContain('não está nomeada');
  });
});

describe('Benchmarking de Simulação — resumo de custos', () => {
  const interacoes = [
    { n: 1, paciente: turno({ custo: { usd: 0.002 } }), aluno: turno({ custo: { usd: 0.004 } }) },
    { n: 2, paciente: turno({ custo: { usd: 0.003 } }), aluno: turno({ custo: { usd: 0.005 } }) },
  ];
  const personaTurno = turno({ custo: { usd: 0.01 }, latenciaMs: 9000 });

  it('separa paciente e aluno, e a persona entra no lado do aluno', () => {
    const r = bench.resumoDeCustos({
      interacoes, pacienteModelKey: 'gpt-5.6-luna', alunoModelKey: 'gpt-5.6-luna', personaTurno,
    });
    expect(r.paciente.usd).toBeCloseTo(0.005, 10);
    expect(r.aluno.usd).toBeCloseTo(0.009 + 0.01, 10); // turnos + extração de persona
    expect(r.aluno.persona.usd).toBeCloseTo(0.01, 10);
    expect(r.totalUsd).toBeCloseTo(0.024, 10);
  });

  it('as médias FECHAM: paciente/interação + aluno/interação = média total', () => {
    const r = bench.resumoDeCustos({
      interacoes, pacienteModelKey: 'gpt-5.6-luna', alunoModelKey: 'gpt-5.6-luna', personaTurno,
    });
    expect(r.paciente.mediaPorInteracao).toBeCloseTo(0.0025, 10);
    expect(r.mediaTotalPorInteracao).toBeCloseTo(0.012, 10);
    expect(r.paciente.mediaPorInteracao + r.aluno.mediaPorInteracao).toBeCloseTo(r.mediaTotalPorInteracao, 10);
  });

  it('turno sem preço na tabela não vira dólar errado', () => {
    const r = bench.resumoDeCustos({
      interacoes: [{ n: 1, paciente: turno({ custo: null }), aluno: turno({ custo: { usd: 0.001 } }) }],
      pacienteModelKey: 'x', alunoModelKey: 'gpt-5.6-luna', personaTurno: null,
    });
    expect(r.paciente.usd).toBe(null);
    expect(r.totalUsd).toBe(null); // não inventa total com metade dos números
  });

  it('run vazia (falhou na persona) não divide por zero', () => {
    const r = bench.resumoDeCustos({ interacoes: [], pacienteModelKey: 'a', alunoModelKey: 'b', personaTurno: null });
    expect(r.paciente.mediaPorInteracao).toBe(null);
    expect(r.mediaTotalPorInteracao).toBe(null);
  });
});

describe('Benchmarking de Simulação — arquivos de saída', () => {
  const run = {
    id: 'bench-1-aabbccdd',
    createdAt: '2026-08-19T12:00:00.000Z',
    userName: 'Admin',
    status: 'completed',
    casoNome: 'Enzo',
    alunoNome: 'Alan',
    interacoesPedidas: 10,
    paciente: { key: 'gpt-5.6-luna-high', modelKey: 'gpt-5.6-luna', model: 'gpt-5.6-luna', provider: 'openai', effort: 'high', label: 'GPT 5.6 Luna · high' },
    aluno: { modelKey: 'gpt-5.6-luna', model: 'gpt-5.6-luna', provider: 'openai', effort: 'high', label: 'GPT 5.6 Luna · high' },
    persona: 'COMO FALA\nFrases curtas.',
    personaTurno: turno({ reasoning: 'RACIOCINIO_DA_PERSONA' }),
    transcript: [
      { ator: 'paciente', texto: 'Não sei por onde começar.' },
      { ator: 'aluno', texto: 'Comece por onde quiser.' },
    ],
    interacoes: [{
      n: 1,
      paciente: turno({ custo: { usd: 0.002 }, reasoning: 'RACIOCINIO_DO_PACIENTE' }),
      aluno: turno({ custo: { usd: 0.004 }, reasoning: 'RACIOCINIO_DO_ALUNO' }),
    }],
  };
  run.resumo = bench.resumoDeCustos({
    interacoes: run.interacoes, pacienteModelKey: 'gpt-5.6-luna', alunoModelKey: 'gpt-5.6-luna', personaTurno: run.personaTurno,
  });

  it('o log traz os quatro valores pedidos, a IA de cada lado e a transcrição', () => {
    const txt = bench.buildBenchLogTxt(run);
    expect(txt).toContain('Valor gasto pelo PACIENTE: $0.002000');
    expect(txt).toContain('Valor gasto pelo ALUNO:');
    expect(txt).toContain('Valor gasto TOTAL:');
    expect(txt).toContain('Valor MÉDIO por interação:');
    expect(txt).toContain('GPT 5.6 Luna · high');
    expect(txt).toContain('effort high');
    expect(txt).toContain('Comece por onde quiser.');
    expect(txt).toContain('Interações pedidas: 10 · realizadas: 1');
  });

  it('o log NUNCA carrega o raciocínio dentro dele (ele tem arquivo próprio)', () => {
    const txt = bench.buildBenchLogTxt(run);
    expect(txt).not.toContain('RACIOCINIO_DO_PACIENTE');
    expect(txt).not.toContain('RACIOCINIO_DO_ALUNO');
    expect(txt).not.toContain('RACIOCINIO_DA_PERSONA');
  });

  it('o arquivo de raciocínio separa paciente, aluno e a extração de persona', () => {
    const txt = bench.buildBenchReasoningTxt(run);
    expect(txt).toContain('INTERAÇÃO 1');
    expect(txt).toContain('RACIOCINIO_DO_PACIENTE');
    expect(txt).toContain('RACIOCINIO_DO_ALUNO');
    expect(txt).toContain('RACIOCINIO_DA_PERSONA');
    // A ordem importa: cada lado embaixo do próprio rótulo.
    expect(txt.indexOf('--- PACIENTE')).toBeLessThan(txt.indexOf('RACIOCINIO_DO_PACIENTE'));
    expect(txt.indexOf('--- ALUNO SIMULADO')).toBeLessThan(txt.indexOf('RACIOCINIO_DO_ALUNO'));
  });

  it('a ficha de persona tem arquivo próprio, com cabeçalho e custo da extração', () => {
    const txt = bench.buildBenchPersonaTxt(run);
    expect(txt).toContain('FICHA DE PERSONA DO ALUNO');
    expect(txt).toContain('Alan');
    expect(txt).toContain('Enzo');
    expect(txt).toContain('COMO FALA\nFrases curtas.');
    expect(txt).toContain('Custo da extração: $0.001000');
    // Nem aqui o raciocínio vaza: ele só existe no arquivo dele.
    expect(txt).not.toContain('RACIOCINIO_DA_PERSONA');
  });

  it('sem ficha gerada o arquivo de persona é vazio (o botão nem aparece)', () => {
    expect(bench.buildBenchPersonaTxt({ ...run, persona: '' })).toBe('');
    expect(bench.buildBenchPersonaTxt({ ...run, persona: '   ' })).toBe('');
  });

  it('sem raciocínio nenhum o arquivo é vazio (o botão nem aparece)', () => {
    const semRaciocinio = {
      ...run,
      personaTurno: turno(),
      interacoes: [{ n: 1, paciente: turno(), aluno: turno() }],
    };
    expect(bench.buildBenchReasoningTxt(semRaciocinio)).toBe('');
  });
});

describe('Benchmarking de Simulação — endpoints', () => {
  beforeEach(() => resetData());

  it('é restrito a supervisor/admin', async () => {
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/benchmark-simulacao/opcoes').set(authHeader(aluno))).status).toBe(403);
    expect((await request(app).post('/api/benchmark-simulacao').set(authHeader(aluno)).send({})).status).toBe(403);
    expect((await request(app).get('/api/benchmark-simulacao/fila').set(authHeader(aluno))).status).toBe(403);
    await request(app).get('/api/benchmark-simulacao/opcoes').expect(401);
  });

  it('/opcoes entrega pacientes, interações, o aluno fixo e os alunos cadastrados', async () => {
    const token = await loginAs('prof');
    const res = await request(app).get('/api/benchmark-simulacao/opcoes').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.pacientes).toHaveLength(4);
    expect(res.body.interacoes).toEqual([10, 30, 50, 70]);
    expect(res.body.aluno.modelKey).toBe('gpt-5.6-luna');
    expect(Array.isArray(res.body.alunos)).toBe(true);
    // Só terapeutas entram na lista de "quem atendeu".
    expect(res.body.alunos.every((a) => a.id && a.name)).toBe(true);
  });

  it('valida tudo ANTES de gastar chamada', async () => {
    const token = await loginAs('admin');
    const log = 'TERAPEUTA: Como você está?\nPACIENTE: Cansado.\n'.repeat(20); // > 200 chars
    const base = { log, casoId: 'fp-test-1', paciente: 'gpt-5.4-mini', interacoes: 10 };
    const post = (body) => request(app).post('/api/benchmark-simulacao').set(authHeader(token)).send(body);

    expect((await post({ ...base, log: '' })).status).toBe(400);
    expect((await post({ ...base, log: 'curto demais' })).status).toBe(400); // não dá persona
    expect((await post({ ...base, casoId: '' })).status).toBe(400);
    expect((await post({ ...base, paciente: 'gpt-5.5-high' })).status).toBe(400);
    expect((await post({ ...base, paciente: 'claude-sonnet-5' })).status).toBe(400); // fora deste lab
    expect((await post({ ...base, interacoes: 20 })).status).toBe(400);
    expect((await post({ ...base, interacoes: 0 })).status).toBe(400);
    expect((await post({ ...base, casoId: 'nao-existe' })).status).toBe(404);
  });

  it('o lote valida a lista de modelos, o modo e as interações antes de gastar', async () => {
    const token = await loginAs('admin');
    const log = 'TERAPEUTA: Como você está?\nPACIENTE: Cansado.\n'.repeat(20);
    const base = { log, casoId: 'fp-test-1', pacientes: ['gpt-5.4-mini'], interacoes: 10 };
    const post = (body) => request(app).post('/api/benchmark-simulacao/lote').set(authHeader(token)).send(body);

    expect((await post({ ...base, pacientes: [] })).status).toBe(400);
    expect((await post({ ...base, pacientes: ['gpt-5.4-mini', 'gpt-9'] })).status).toBe(400);
    expect((await post({ ...base, pacientes: 'gpt-5.4-mini' })).status).toBe(400);
    expect((await post({ ...base, modo: 'turbo' })).status).toBe(400);
    expect((await post({ ...base, interacoes: 20 })).status).toBe(400);
    expect((await post({ ...base, log: 'curto' })).status).toBe(400);
    expect((await post({ ...base, casoId: 'nao-existe' })).status).toBe(404);
  });

  it('o lote é restrito a supervisor/admin, como o resto da aba', async () => {
    const aluno = await loginAs('aluno');
    expect((await request(app).post('/api/benchmark-simulacao/lote').set(authHeader(aluno)).send({})).status).toBe(403);
    expect((await request(app).get('/api/benchmark-simulacao/lotes').set(authHeader(aluno))).status).toBe(403);
    await request(app).get('/api/benchmark-simulacao/lotes').expect(401);
  });

  it('lote inexistente é 404 (e o id não vira caminho de arquivo)', async () => {
    const token = await loginAs('admin');
    for (const url of [
      '/api/benchmark-simulacao/lote/blote-1-aabbccdd',
      '/api/benchmark-simulacao/lote/blote-1-aabbccdd/relatorio',
      '/api/benchmark-simulacao/lote/..%2F..%2Fusers',
    ]) {
      expect((await request(app).get(url).set(authHeader(token))).status).toBe(404);
    }
  });

  it('sem chave do provedor responde 503 e não vaza o prompt do personagem', async () => {
    const token = await loginAs('admin');
    const log = 'TERAPEUTA: Como você está?\nPACIENTE: Cansado.\n'.repeat(20);
    const res = await request(app).post('/api/benchmark-simulacao')
      .set(authHeader(token))
      .send({ log, casoId: 'fp-test-1', paciente: 'glm-5.2-high', interacoes: 10 });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('FP_PROMPT_SECRETO');
  });

  it('run inexistente é 404 nas rotas de leitura (e o id não vira caminho)', async () => {
    const token = await loginAs('admin');
    for (const url of [
      '/api/benchmark-simulacao/bench-1-aabbccdd',
      '/api/benchmark-simulacao/bench-1-aabbccdd/log',
      '/api/benchmark-simulacao/bench-1-aabbccdd/reasoning',
      '/api/benchmark-simulacao/bench-1-aabbccdd/persona',
      '/api/benchmark-simulacao/..%2F..%2Fusers',
    ]) {
      expect((await request(app).get(url).set(authHeader(token))).status).toBe(404);
    }
  });

  it('a fila responde vazia sem quebrar antes da primeira run', async () => {
    const token = await loginAs('prof');
    const res = await request(app).get('/api/benchmark-simulacao/fila').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
