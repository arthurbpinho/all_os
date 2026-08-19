// Benchmarking de Simulação — a RUN de verdade, com o SDK dublado.
//
// O outro arquivo (benchmark-simulacao.test.js) cobre as peças puras. Aqui roda o
// loop inteiro pelo endpoint: extração de persona → N interações → persistência →
// arquivos de saída. É o único lugar onde se verifica o que só aparece em
// execução: que cada lado recebe o SEU histórico (papéis invertidos), que a
// Responses API é usada só onde há resumo de raciocínio a colher, que o parcial
// sobrevive a uma falha no meio e que o cancelamento para o loop.
//
// O dublê é do pacote `openai` (o cliente do GLM também é ele, com outra baseURL),
// então nenhuma chamada sai para a rede.
// O dublê entra pelo require.cache do pacote `openai` ANTES de o app ser
// carregado: o servidor faz `require('openai')` dentro de getOpenAI/getGLM (lazy),
// então basta a entrada do cache já estar plantada. Feito com vi.mock, a
// interceptação não alcança o require CJS de dentro do server e a suíte iria à
// rede de verdade.
const CAMINHO_OPENAI = require.resolve('openai');

// Registro do que o dublê recebeu — é a asserção principal de vários testes.
const chamadas = { responses: [], chat: [] };
// Roteiro de respostas: cada teste ajusta antes de disparar a run.
const roteiro = {
  textoResponses: () => 'FALA_VIA_RESPONSES',
  textoChat: () => 'FALA_VIA_CHAT',
  reasoningResponses: () => 'RESUMO_RESPONSES',
  reasoningChat: () => 'RESUMO_CHAT',
  erroChat: null,
  atrasoMs: 0,
};

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

class FakeOpenAI {
  constructor(opts) {
    this.baseURL = (opts && opts.baseURL) || 'openai';
    this.responses = {
      create: async (args) => {
        chamadas.responses.push(args);
        if (roteiro.atrasoMs) await esperar(roteiro.atrasoMs);
        const texto = roteiro.textoResponses(args);
        const resumo = roteiro.reasoningResponses(args);
        // Async iterable de eventos, igual ao stream do SDK.
        return (async function* () {
          if (resumo) {
            yield { type: 'response.reasoning_summary_part.added' };
            yield { type: 'response.reasoning_summary_text.delta', delta: resumo };
          }
          yield { type: 'response.output_text.delta', delta: texto };
          yield {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 4000,
                input_tokens_details: { cached_tokens: 3000 },
                output_tokens: 300,
                output_tokens_details: { reasoning_tokens: 200 },
                total_tokens: 4300,
              },
            },
          };
        })();
      },
    };
    this.chat = {
      completions: {
        create: async (body) => {
          chamadas.chat.push(body);
          if (roteiro.atrasoMs) await esperar(roteiro.atrasoMs);
          // Permite a um teste derrubar UM modelo e ver o lote seguir com os outros.
          if (roteiro.erroChat) {
            const e = roteiro.erroChat(body);
            if (e) throw e;
          }
          const conteudo = roteiro.textoChat(body);
          const rc = roteiro.reasoningChat(body);
          return {
            choices: [{ message: { content: conteudo, ...(rc ? { reasoning_content: rc } : {}) } }],
            usage: {
              prompt_tokens: 2000,
              prompt_tokens_details: { cached_tokens: 1500 },
              completion_tokens: 120,
              completion_tokens_details: { reasoning_tokens: 40 },
              total_tokens: 2120,
            },
          };
        },
      },
    };
  }
}

require.cache[CAMINHO_OPENAI] = {
  id: CAMINHO_OPENAI, filename: CAMINHO_OPENAI, loaded: true,
  children: [], paths: [],
  exports: { OpenAI: FakeOpenAI, default: FakeOpenAI },
};

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

const LOG_ORIGINAL = [
  'TERAPEUTA: Oi, Enzo. Como você chegou aqui hoje?',
  'PACIENTE: Meio travado, pra ser sincero.',
  'TERAPEUTA: Travado como?',
  'PACIENTE: Como se eu não conseguisse decidir nada.',
].join('\n').repeat(4); // > 200 caracteres, o mínimo pra extrair persona

// Espera a run sair de 'processing'/'cancelando'.
async function aguardarFim(token, id, timeoutMs = 8000) {
  const ate = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/benchmark-simulacao/${id}`).set(authHeader(token));
    if (res.status !== 200) throw new Error(`GET run falhou: ${res.status}`);
    if (res.body.status !== 'processing' && res.body.status !== 'cancelando') return res.body;
    if (Date.now() > ate) throw new Error(`run não terminou (status ${res.body.status})`);
    await esperar(15);
  }
}

async function dispararRun(token, body) {
  const res = await request(app).post('/api/benchmark-simulacao').set(authHeader(token)).send({
    log: LOG_ORIGINAL, casoId: 'fp-test-1', interacoes: 10, alunoNome: 'Alan', ...body,
  });
  if (res.status !== 200) throw new Error(`POST falhou: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

describe('Benchmarking de Simulação — run completa', () => {
  beforeEach(() => {
    resetData();
    chamadas.responses = [];
    chamadas.chat = [];
    roteiro.textoResponses = () => 'FALA_VIA_RESPONSES';
    roteiro.textoChat = () => 'FALA_VIA_CHAT';
    roteiro.reasoningResponses = () => 'RESUMO_RESPONSES';
    roteiro.reasoningChat = () => 'RESUMO_CHAT';
    roteiro.erroChat = null;
    roteiro.atrasoMs = 0;
    process.env.OPENAI_API_KEY = 'sk-teste';
    process.env.GLM_API_KEY = 'glm-teste';
  });
  afterEach(() => {
    process.env.OPENAI_API_KEY = '';
    process.env.GLM_API_KEY = '';
  });

  it('paciente mini (chat) + aluno luna (responses): 10 interações, custo dos dois lados', async () => {
    const token = await loginAs('admin');
    const run = await aguardarFim(token, await dispararRun(token, { paciente: 'gpt-5.4-mini' }));

    expect(run.status).toBe('completed');
    expect(run.interacoes).toHaveLength(10);
    // 1 interação = 1 fala do paciente + 1 fala do aluno.
    expect(run.transcript).toHaveLength(20);
    expect(run.transcript[0].ator).toBe('paciente');
    expect(run.transcript[1].ator).toBe('aluno');

    // O paciente (mini, effort none) foi pelo chat.completions; o aluno e a
    // extração de persona, pela Responses API (é onde o resumo existe).
    expect(chamadas.chat).toHaveLength(10);
    expect(chamadas.responses).toHaveLength(11); // 10 falas do aluno + 1 persona
    expect(chamadas.chat[0].reasoning_effort).toBe('none');
    expect(chamadas.responses[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });

    // Custos: os dois lados somam, e as médias fecham.
    const r = run.resumo;
    expect(r.paciente.usd).toBeGreaterThan(0);
    expect(r.aluno.usd).toBeGreaterThan(0);
    expect(r.totalUsd).toBeCloseTo(r.paciente.usd + r.aluno.usd, 10);
    expect(r.paciente.mediaPorInteracao).toBeCloseTo(r.paciente.usd / 10, 10);
    expect(r.aluno.persona.usd).toBeGreaterThan(0); // chamada única, destacada
  });

  it('cada lado recebe o SEU histórico: para ambos, a própria fala é assistant', async () => {
    const token = await loginAs('admin');
    // Falas distinguíveis por lado, pra conferir a inversão de papéis.
    roteiro.textoChat = () => 'SOU_O_PACIENTE';
    roteiro.textoResponses = (args) => (args.instructions.startsWith('Você é um analista') ? 'FICHA' : 'SOU_O_ALUNO');
    await aguardarFim(token, await dispararRun(token, { paciente: 'gpt-5.4-mini' }));

    // Visão do paciente: abre com o "Iniciar" oculto (mesmo disparo da produção),
    // as falas dele são assistant e as do aluno, user.
    const ultimaDoPaciente = chamadas.chat[chamadas.chat.length - 1];
    expect(ultimaDoPaciente.messages[0]).toEqual({ role: 'developer', content: expect.stringContaining('FP_PROMPT_SECRETO') });
    expect(ultimaDoPaciente.messages[1]).toEqual({ role: 'user', content: 'Iniciar' });
    expect(ultimaDoPaciente.messages[2]).toEqual({ role: 'assistant', content: 'SOU_O_PACIENTE' });
    expect(ultimaDoPaciente.messages[3]).toEqual({ role: 'user', content: 'SOU_O_ALUNO' });

    // Visão do aluno: sem kickoff (quem abre é o paciente) e papéis invertidos.
    const ultimaDoAluno = chamadas.responses[chamadas.responses.length - 1];
    expect(ultimaDoAluno.input[0]).toEqual({ role: 'user', content: 'SOU_O_PACIENTE' });
    expect(ultimaDoAluno.input[1]).toEqual({ role: 'assistant', content: 'SOU_O_ALUNO' });
    // E a ficha de persona entra no system dele, não no do paciente.
    expect(ultimaDoAluno.instructions).toContain('FICHA');
    expect(ultimaDoAluno.instructions).not.toContain('FP_PROMPT_SECRETO');
  });

  it('paciente GLM high: raciocínio vem no próprio chat, sem trocar transporte', async () => {
    const token = await loginAs('admin');
    roteiro.reasoningChat = () => 'PENSANDO_COMO_PACIENTE';
    const id = await dispararRun(token, { paciente: 'glm-5.2-high' });
    const run = await aguardarFim(token, id);

    expect(run.status).toBe('completed');
    expect(chamadas.chat[0].thinking).toEqual({ type: 'enabled' });
    expect(chamadas.chat[0].max_tokens).toBeGreaterThan(1500); // folga pro raciocínio
    expect(run.reasoningDisponivel).toBe(true);

    // O raciocínio NÃO viaja no JSON da run nem no log — só no arquivo próprio.
    expect(JSON.stringify(run)).not.toContain('PENSANDO_COMO_PACIENTE');
    const log = await request(app).get(`/api/benchmark-simulacao/${id}/log`).set(authHeader(token));
    expect(log.status).toBe(200);
    expect(log.text).not.toContain('PENSANDO_COMO_PACIENTE');
    expect(log.text).toContain('Valor gasto pelo PACIENTE:');

    const rac = await request(app).get(`/api/benchmark-simulacao/${id}/reasoning`).set(authHeader(token));
    expect(rac.status).toBe(200);
    expect(rac.text).toContain('PENSANDO_COMO_PACIENTE');
    expect(rac.text).toContain('RESUMO_RESPONSES'); // o do aluno, em seção separada
  });

  it('a ficha de persona é baixável em arquivo próprio', async () => {
    const token = await loginAs('admin');
    roteiro.textoResponses = (args) => (args.instructions.startsWith('Você é um analista') ? 'FICHA_EXTRAIDA_DO_LOG' : 'SOU_O_ALUNO');
    const id = await dispararRun(token, { paciente: 'gpt-5.4-mini' });
    await aguardarFim(token, id);

    const res = await request(app).get(`/api/benchmark-simulacao/${id}/persona`).set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('FICHA DE PERSONA DO ALUNO');
    expect(res.text).toContain('FICHA_EXTRAIDA_DO_LOG');
    expect(res.text).toContain('Alan');
    expect(res.text).toContain('Custo da extração:');
    // Não é a run de outra pessoa que se baixa.
    const prof2 = await loginAs('prof2');
    expect((await request(app).get(`/api/benchmark-simulacao/${id}/persona`).set(authHeader(prof2))).status).toBe(403);
  });

  it('paciente sem raciocínio nenhum: o arquivo de raciocínio só tem o aluno', async () => {
    const token = await loginAs('admin');
    roteiro.reasoningChat = () => ''; // mini com effort none não pensa
    const id = await dispararRun(token, { paciente: 'gpt-5.4-mini' });
    await aguardarFim(token, id);
    const rac = await request(app).get(`/api/benchmark-simulacao/${id}/reasoning`).set(authHeader(token));
    expect(rac.status).toBe(200);
    expect(rac.text).toContain('(sem resumo de raciocínio)'); // lado do paciente
    expect(rac.text).toContain('RESUMO_RESPONSES');
  });

  it('fala vazia duas vezes derruba a run mas PRESERVA (e deixa baixar) o parcial', async () => {
    const token = await loginAs('admin');
    let n = 0;
    // Deixa passar as 3 primeiras falas do paciente e emudece a partir da 4ª.
    roteiro.textoChat = () => (++n <= 3 ? 'FALA_VIA_CHAT' : '');
    const id = await dispararRun(token, { paciente: 'gpt-5.4-mini' });
    const run = await aguardarFim(token, id);

    expect(run.status).toBe('error');
    expect(run.error).toMatch(/vazia duas vezes/);
    expect(run.interacoes).toHaveLength(3);       // o que rodou continua ali
    expect(run.resumo.paciente.usd).toBeGreaterThan(0); // dinheiro gasto não desaparece
    const log = await request(app).get(`/api/benchmark-simulacao/${id}/log`).set(authHeader(token));
    expect(log.status).toBe(200);
    expect(log.text).toContain('realizadas: 3');
  });

  it('cancelar para o loop e guarda o parcial', async () => {
    const token = await loginAs('admin');
    roteiro.atrasoMs = 25; // ~50ms por interação: dá pra cancelar no meio
    const id = await dispararRun(token, { paciente: 'gpt-5.4-mini' });

    // Espera a primeira interação fechar e cancela.
    const ate = Date.now() + 5000;
    for (;;) {
      const res = await request(app).get(`/api/benchmark-simulacao/${id}`).set(authHeader(token));
      if ((res.body.interacoes || []).length >= 1) break;
      if (Date.now() > ate) throw new Error('a run não avançou');
      await esperar(10);
    }
    const c = await request(app).post(`/api/benchmark-simulacao/${id}/cancelar`).set(authHeader(token));
    expect(c.status).toBe(200);

    const run = await aguardarFim(token, id);
    expect(run.status).toBe('cancelado');
    expect(run.interacoes.length).toBeGreaterThan(0);
    expect(run.interacoes.length).toBeLessThan(10);
    // Cancelar duas vezes não é erro de servidor, é 400 explícito.
    expect((await request(app).post(`/api/benchmark-simulacao/${id}/cancelar`).set(authHeader(token))).status).toBe(400);
  });

  it('uma run por pessoa de cada vez (duplo clique não vira duas runs de 70)', async () => {
    const token = await loginAs('admin');
    roteiro.atrasoMs = 20;
    const id = await dispararRun(token, { paciente: 'gpt-5.4-mini' });
    const segunda = await request(app).post('/api/benchmark-simulacao').set(authHeader(token))
      .send({ log: LOG_ORIGINAL, casoId: 'fp-test-1', paciente: 'gpt-5.4-mini', interacoes: 10 });
    expect(segunda.status).toBe(409);
    await request(app).post(`/api/benchmark-simulacao/${id}/cancelar`).set(authHeader(token));
    await aguardarFim(token, id);
  });

  it('a run de um supervisor não é visível para outro (admin vê todas)', async () => {
    const prof = await loginAs('prof');
    const id = await dispararRun(prof, { paciente: 'gpt-5.4-mini' });
    await aguardarFim(prof, id);

    const prof2 = await loginAs('prof2');
    for (const url of [`/api/benchmark-simulacao/${id}`, `/api/benchmark-simulacao/${id}/log`]) {
      expect((await request(app).get(url).set(authHeader(prof2))).status).toBe(403);
    }
    const fila2 = await request(app).get('/api/benchmark-simulacao/fila').set(authHeader(prof2));
    expect(fila2.body.find((j) => j.id === id)).toBeUndefined();

    const admin = await loginAs('admin');
    expect((await request(app).get(`/api/benchmark-simulacao/${id}`).set(authHeader(admin))).status).toBe(200);
  });
});

// Quantas vezes a EXTRAÇÃO de persona foi chamada (o prompt do analista é o que a
// identifica). Em lote tem de ser exatamente 1, não uma por modelo.
function extracoesDePersona() {
  return chamadas.responses.filter((a) => String(a.instructions || '').startsWith('Você é um analista')).length;
}

describe('Benchmarking de Simulação — LOTE', () => {
  beforeEach(() => {
    resetData();
    chamadas.responses = [];
    chamadas.chat = [];
    roteiro.textoResponses = (args) => (String(args.instructions || '').startsWith('Você é um analista') ? 'FICHA_UNICA_DO_LOTE' : 'SOU_O_ALUNO');
    roteiro.textoChat = () => 'SOU_O_PACIENTE';
    roteiro.reasoningResponses = () => 'RESUMO_RESPONSES';
    roteiro.reasoningChat = () => '';
    roteiro.erroChat = null;
    roteiro.atrasoMs = 0;
    process.env.OPENAI_API_KEY = 'sk-teste';
    process.env.GLM_API_KEY = 'glm-teste';
  });
  afterEach(() => {
    process.env.OPENAI_API_KEY = '';
    process.env.GLM_API_KEY = '';
  });

  async function dispararLote(token, body) {
    const res = await request(app).post('/api/benchmark-simulacao/lote').set(authHeader(token)).send({
      log: LOG_ORIGINAL, casoId: 'fp-test-1', interacoes: 10, alunoNome: 'Alan',
      pacientes: ['gpt-5.4-mini', 'glm-5.2-high'], modo: 'fila', ...body,
    });
    if (res.status !== 200) throw new Error(`POST lote falhou: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function aguardarLote(token, id, timeoutMs = 15000) {
    const ate = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(app).get(`/api/benchmark-simulacao/lote/${id}`).set(authHeader(token));
      if (res.status !== 200) throw new Error(`GET lote falhou: ${res.status}`);
      if (!['processing', 'cancelando'].includes(res.body.status)) return res.body;
      if (Date.now() > ate) throw new Error(`lote não terminou (status ${res.body.status})`);
      await esperar(15);
    }
  }

  it('fila: a persona é extraída UMA vez e os dois modelos rodam com ela', async () => {
    const token = await loginAs('admin');
    const { id, runIds } = await dispararLote(token);
    expect(runIds).toHaveLength(2);
    const lote = await aguardarLote(token, id);

    expect(lote.status).toBe('completed');
    // O ponto do lote: uma extração, não uma por modelo. Barato E comparável.
    expect(extracoesDePersona()).toBe(1);
    expect(lote.persona).toBe('FICHA_UNICA_DO_LOTE');

    // Cada run terminou com a MESMA ficha, marcada como compartilhada.
    for (const runId of runIds) {
      const r = (await request(app).get(`/api/benchmark-simulacao/${runId}`).set(authHeader(token))).body;
      expect(r.status).toBe('completed');
      expect(r.personaCompartilhada).toBe(true);
      expect(r.persona).toBe('FICHA_UNICA_DO_LOTE');
      expect(r.interacoes).toHaveLength(10);
      expect(r.loteId).toBe(id);
      // A extração NÃO é cobrada em cada run (senão o total do lote a contaria 2x).
      expect(r.resumo.aluno.persona).toBe(null);
    }

    // Comparativo: uma linha por modelo, com o custo do paciente de cada um.
    expect(lote.resumo.linhas.map((l) => l.pacienteKey)).toEqual(['gpt-5.4-mini', 'glm-5.2-high']);
    for (const l of lote.resumo.linhas) {
      expect(l.pacienteUsd).toBeGreaterThan(0);
      expect(l.custoPorInteracao).toBeCloseTo(l.pacienteUsd / 10, 10);
    }
    expect(lote.resumo.totais.persona).toBeGreaterThan(0);
    expect(lote.resumo.totais.interacoesFeitas).toBe(20);
  });

  it('fila: o segundo modelo só começa depois do primeiro terminar', async () => {
    const token = await loginAs('admin');
    // Cada modelo tem um dublê distinto: se rodassem juntos, as chamadas se
    // intercalariam. Em fila, todas as do mini vêm antes de todas as do GLM.
    const { id } = await dispararLote(token, { modo: 'fila' });
    await aguardarLote(token, id);
    const modelos = chamadas.chat.map((b) => b.model);
    const primeiroGlm = modelos.findIndex((m) => m === 'glm-5.2');
    const ultimoMini = modelos.lastIndexOf('gpt-5.4-mini-2026-03-17');
    expect(primeiroGlm).toBeGreaterThan(ultimoMini);
  });

  it('paralelo: as chamadas dos modelos se intercalam e o lote fecha', async () => {
    const token = await loginAs('admin');
    roteiro.atrasoMs = 5; // dá tempo de as duas runs se cruzarem
    const { id } = await dispararLote(token, { modo: 'paralelo' });
    const lote = await aguardarLote(token, id);
    expect(lote.status).toBe('completed');
    expect(lote.modo).toBe('paralelo');
    expect(extracoesDePersona()).toBe(1);
    const modelos = chamadas.chat.map((b) => b.model);
    const primeiroGlm = modelos.findIndex((m) => m === 'glm-5.2');
    const ultimoMini = modelos.lastIndexOf('gpt-5.4-mini-2026-03-17');
    expect(primeiroGlm).toBeLessThan(ultimoMini); // intercalado, não em fila
  });

  it('um modelo que falha NÃO derruba os outros (lote fica parcial)', async () => {
    const token = await loginAs('admin');
    // O GLM cai; o mini tem de terminar inteiro e continuar baixável.
    roteiro.erroChat = (body) => (body.model === 'glm-5.2' ? new Error('z.ai fora do ar') : null);
    const { id } = await dispararLote(token);
    const lote = await aguardarLote(token, id);

    expect(lote.status).toBe('parcial');
    expect(lote.error).toMatch(/1 de 2 modelo/);
    const porKey = Object.fromEntries(lote.resumo.linhas.map((l) => [l.pacienteKey, l]));
    expect(porKey['gpt-5.4-mini'].status).toBe('completed');
    expect(porKey['gpt-5.4-mini'].interacoesFeitas).toBe(10);
    expect(porKey['glm-5.2-high'].status).toBe('error');
    expect(porKey['glm-5.2-high'].erro).toMatch(/z.ai fora do ar/);
    // O relatório sai mesmo com falha parcial, e nomeia o erro.
    const rel = await request(app).get(`/api/benchmark-simulacao/lote/${id}/relatorio`).set(authHeader(token));
    expect(rel.status).toBe(200);
    expect(rel.text).toContain('z.ai fora do ar');
    expect(rel.text).toContain('GPT 5.4 mini');
  });

  it('cancelar o lote para o que roda e o que ainda não começou', async () => {
    const token = await loginAs('admin');
    roteiro.atrasoMs = 20;
    const { id, runIds } = await dispararLote(token, { modo: 'fila' });

    // Espera a primeira run avançar e cancela o lote.
    const ate = Date.now() + 6000;
    for (;;) {
      const l = (await request(app).get(`/api/benchmark-simulacao/lote/${id}`).set(authHeader(token))).body;
      if (l.resumo.totais.interacoesFeitas >= 1) break;
      if (Date.now() > ate) throw new Error('o lote não avançou');
      await esperar(10);
    }
    expect((await request(app).post(`/api/benchmark-simulacao/lote/${id}/cancelar`).set(authHeader(token))).status).toBe(200);
    const lote = await aguardarLote(token, id);
    expect(lote.status).toBe('cancelado');

    // A segunda run nem começou: fica cancelada, sem custo nenhum.
    const segunda = (await request(app).get(`/api/benchmark-simulacao/${runIds[1]}`).set(authHeader(token))).body;
    expect(segunda.status).toBe('cancelado');
    expect(segunda.interacoes).toHaveLength(0);
    // Cancelar de novo é 400 explícito, não erro de servidor.
    expect((await request(app).post(`/api/benchmark-simulacao/lote/${id}/cancelar`).set(authHeader(token))).status).toBe(400);
  });

  it('um lote em voo bloqueia outro lote E uma run isolada da mesma pessoa', async () => {
    const token = await loginAs('admin');
    roteiro.atrasoMs = 15;
    const { id } = await dispararLote(token);

    const outroLote = await request(app).post('/api/benchmark-simulacao/lote').set(authHeader(token))
      .send({ log: LOG_ORIGINAL, casoId: 'fp-test-1', pacientes: ['gpt-5.4-mini'], interacoes: 10 });
    expect(outroLote.status).toBe(409);
    const runSolta = await request(app).post('/api/benchmark-simulacao').set(authHeader(token))
      .send({ log: LOG_ORIGINAL, casoId: 'fp-test-1', paciente: 'gpt-5.4-mini', interacoes: 10 });
    expect(runSolta.status).toBe(409);

    await request(app).post(`/api/benchmark-simulacao/lote/${id}/cancelar`).set(authHeader(token));
    await aguardarLote(token, id);
  });

  it('o lote de um supervisor não é visível para outro (admin vê todos)', async () => {
    const prof = await loginAs('prof');
    const { id } = await dispararLote(prof, { pacientes: ['gpt-5.4-mini'] });
    await aguardarLote(prof, id);

    const prof2 = await loginAs('prof2');
    for (const url of [`/api/benchmark-simulacao/lote/${id}`, `/api/benchmark-simulacao/lote/${id}/relatorio`]) {
      expect((await request(app).get(url).set(authHeader(prof2))).status).toBe(403);
    }
    expect((await request(app).get('/api/benchmark-simulacao/lotes').set(authHeader(prof2))).body).toHaveLength(0);
    const admin = await loginAs('admin');
    expect((await request(app).get(`/api/benchmark-simulacao/lote/${id}`).set(authHeader(admin))).status).toBe(200);
  });
});
