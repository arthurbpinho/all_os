// Simulação Independente — laboratório de pricing do PACIENTE.
// Cobre o que é fácil de errar em silêncio: a normalização do `usage`, o
// cálculo de custo e a montagem da chamada (não pensar). Mais o gate de acesso
// do endpoint. Só OpenAI desde 2026-10 (Anthropic e GLM saíram do app).
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const sim = require('../server/simulacao-independente');

describe('Simulação Independente — usage, custo e montagem', () => {
  it('normalizeSimUsage (OpenAI): input desconta o cache, reasoning sai do output', () => {
    const t = sim.normalizeSimUsage('openai', {
      prompt_tokens: 5000,
      prompt_tokens_details: { cached_tokens: 4000 },
      completion_tokens: 300,
      completion_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 5300,
    });
    expect(t).toEqual({ input: 1000, cacheRead: 4000, cacheWrite: 0, output: 300, reasoning: 120 });
  });

  it('normalizeSimUsage: usa total-prompt como piso da saída (raciocínio sub-reportado)', () => {
    const t = sim.normalizeSimUsage('openai', {
      prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2900,
    });
    expect(t.output).toBe(900); // 2900 - 2000 vence os 50 reportados
    expect(t.input).toBe(2000);
  });

  it('computeSimCost soma os 4 componentes com os preços do modelo', () => {
    // gpt-5.4-mini: 0.75 input / 0.075 cacheRead / 4.5 output por MTok.
    const c = sim.computeSimCost('gpt-5.4-mini', {
      input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6, reasoning: 0,
    });
    expect(c.usd).toBeCloseTo(0.75 + 0.075 + 4.5, 10);
    expect(c.componentes.cacheWrite).toBe(0);
  });

  it('computeSimCost devolve null para modelo sem preço (nunca um dólar errado)', () => {
    expect(sim.computeSimCost('modelo-inexistente', sim.normalizeSimUsage('openai', null))).toBe(null);
  });

  // Família 5.6 no laboratório do paciente: Terra e Luna (o Sol não entra — o
  // interesse aqui é descer de preço, não subir). Os números são os da doc oficial
  // da OpenAI, ago/2026; um blog agregador publicou outros valores que não batem.
  it('preços do 5.6: Terra abaixo do 5.4 e Luna abaixo do mini de produção', () => {
    const terra = sim.resolveSimPrices('gpt-5.6-terra');
    const luna = sim.resolveSimPrices('gpt-5.6-luna');
    expect(terra).toEqual({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 });
    expect(luna).toEqual({ input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 });

    // O ponto do teste: Luna é mais barato que o paciente de produção nas DUAS
    // pontas — é o que justifica testá-lo como substituto do mini.
    const mini = sim.resolveSimPrices('gpt-5.4-mini');
    expect(luna.input).toBeLessThan(mini.input);
    expect(luna.output).toBeLessThan(mini.output);
    // E Terra fica abaixo do 5.4 cheio.
    expect(terra.input).toBeLessThan(sim.resolveSimPrices('gpt-5.4').input);
    expect(terra.output).toBeLessThan(sim.resolveSimPrices('gpt-5.4').output);
  });

  // cacheWrite a 1,25× o input vale pra OpenAI também (docs, ago/2026) — a tabela
  // registra o preço certo mesmo o usage da OpenAI não separando esses tokens
  // hoje, pra o cálculo já ficar correto se um dia passar a separar.
  it('cacheWrite é 1,25× o input em todos os modelos OpenAI da tabela', () => {
    for (const key of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const p = sim.resolveSimPrices(key);
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10);
      expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 10);
    }
  });

  // Paciente tem de poder rodar SEM raciocínio (é como produção roda): se 'none'
  // sair da lista, o laboratório deixa de comparar maçã com maçã.
  it('Terra e Luna oferecem effort none (comparável ao paciente de produção)', () => {
    for (const key of ['gpt-5.6-terra', 'gpt-5.6-luna']) {
      const m = sim.simModelInfo(key);
      expect(m).toBeTruthy();
      expect(m.provider).toBe('openai');
      expect(m.efforts).toContain('none');
      expect(m.efforts[0]).toBe('none'); // default do seletor
    }
    expect(sim.simModelInfo('gpt-5.6-sol')).toBeNull(); // flagship fora deste lab
  });

  it('normalizeTurns colapsa turnos consecutivos do mesmo papel', () => {
    const turns = sim.normalizeTurns([
      { role: 'user', content: 'oi' },
      { role: 'user', content: 'tudo bem?' },
      { role: 'system', content: 'ignorado' },
      { role: 'assistant', content: 'oi' },
      { role: 'assistant', content: '' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'oi\n\ntudo bem?' },
      { role: 'assistant', content: 'oi' },
    ]);
  });

  it('buildSimChatBody: OpenAI usa reasoning_effort + max_completion_tokens; effort none não pede folga', () => {
    const body = sim.buildSimChatBody({
      provider: 'openai', model: 'gpt-5.4-mini-x', effort: 'none',
      systemPrompt: 'PERSONAGEM', turns: [{ role: 'user', content: 'Iniciar' }],
    });
    expect(body.reasoning_effort).toBe('none');
    expect(body.max_completion_tokens).toBe(sim.SIM_MAX_TOKENS);
    expect(body.messages[0]).toEqual({ role: 'developer', content: 'PERSONAGEM' });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  it('buildSimChatBody: com raciocínio, o teto ganha folga', () => {
    const body = sim.buildSimChatBody({
      provider: 'openai', model: 'gpt-5.6-luna', effort: 'high',
      systemPrompt: 'P', turns: [{ role: 'user', content: 'Iniciar' }],
    });
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBeGreaterThan(sim.SIM_MAX_TOKENS);
  });

  it('extractSimText: tira um <think> embutido do texto do personagem', () => {
    expect(sim.extractSimText('openai', {
      choices: [{ message: { content: '<think>plano</think>Oi, doutor.' } }],
    })).toBe('Oi, doutor.');
  });

  it('catálogo: as opções são exatamente as definidas pelo dono, todas com preço', () => {
    const cat = sim.simCatalogo();
    expect(cat.map((m) => `${m.key}:${m.efforts.join(',')}`)).toEqual([
      'gpt-5.4-mini:none',
      'gpt-5.6-luna:none,medium,high',
      'gpt-5.6-terra:none,medium,high',
      'gpt-5.4:medium,high',
      'gpt-5.5:medium,high',
    ]);
    for (const m of cat) {
      expect(m.precos, `preço faltando para ${m.key}`).toBeTruthy();
      expect(m.provider).toBe('openai');
    }
  });
});

describe('Simulação Independente — endpoint', () => {
  beforeEach(() => resetData());

  it('é restrito a supervisor/admin', async () => {
    const aluno = await loginAs('aluno');
    const r1 = await request(app).get('/api/simulacao-independente/modelos').set(authHeader(aluno));
    expect(r1.status).toBe(403);
    const r2 = await request(app).post('/api/simulacao-independente/chat')
      .set(authHeader(aluno))
      .send({ casoId: 'fp-test-1', model: 'gpt-5.4-mini', effort: 'none', messages: [{ role: 'user', content: 'Iniciar' }] });
    expect(r2.status).toBe(403);
    await request(app).get('/api/simulacao-independente/modelos').expect(401);
  });

  it('supervisor lê o catálogo de modelos com preços', async () => {
    const token = await loginAs('prof');
    const res = await request(app).get('/api/simulacao-independente/modelos').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.modelos)).toBe(true);
    expect(res.body.modelos[0]).toHaveProperty('precos.input');
  });

  it('valida modelo, effort e mensagens antes de gastar qualquer chamada', async () => {
    const token = await loginAs('admin');
    const base = { casoId: 'fp-test-1', messages: [{ role: 'user', content: 'Iniciar' }] };
    const post = (body) => request(app).post('/api/simulacao-independente/chat').set(authHeader(token)).send(body);

    expect((await post({ ...base, model: 'gpt-9', effort: 'none' })).status).toBe(400);
    // tier de 5.6 que não existe / que não entrou neste laboratório
    expect((await post({ ...base, model: 'gpt-5.6-nova', effort: 'none' })).status).toBe(400);
    expect((await post({ ...base, model: 'gpt-5.6-sol', effort: 'none' })).status).toBe(400);
    // effort que existe em outro modelo, mas não neste
    expect((await post({ ...base, model: 'gpt-5.4-mini', effort: 'medium' })).status).toBe(400);
    expect((await post({ ...base, model: 'gpt-5.6-luna', effort: 'xhigh' })).status).toBe(400);
    // GLM e Claude saíram do laboratório
    expect((await post({ ...base, model: 'claude-sonnet-5', effort: 'disabled' })).status).toBe(400);
    expect((await post({ ...base, model: 'glm-5.2', effort: 'high' })).status).toBe(400);
    expect((await post({ ...base, model: 'gpt-5.4-mini', effort: 'none', messages: [] })).status).toBe(400);
    expect((await post({ ...base, model: 'gpt-5.4-mini', effort: 'none', casoId: '' })).status).toBe(400);
    // conversa tem de começar pelo terapeuta
    expect((await post({ ...base, model: 'gpt-5.4-mini', effort: 'none', messages: [{ role: 'assistant', content: 'oi' }] })).status).toBe(400);
    // personagem inexistente
    expect((await post({ ...base, model: 'gpt-5.4-mini', effort: 'none', casoId: 'nao-existe' })).status).toBe(404);
  });

  it('sem a chave do provedor responde 503 (e não vaza o prompt do personagem)', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/simulacao-independente/chat')
      .set(authHeader(token))
      .send({ casoId: 'fp-test-1', model: 'gpt-5.4-mini', effort: 'none', messages: [{ role: 'user', content: 'Iniciar' }] });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('FP_PROMPT_SECRETO');
  });
});
