// Simulação Independente — laboratório de pricing do PACIENTE.
// Cobre o que é fácil de errar em silêncio: a normalização do `usage` (três
// provedores, três shapes), o cálculo de custo (a Anthropic cobra ESCRITA de
// cache mais caro que input) e a montagem da chamada por provedor (não pensar,
// e cache_control explícito só na Anthropic). Mais o gate de acesso do endpoint.
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

  it('normalizeSimUsage (GLM): usa total-prompt como piso da saída (thinking sub-reportado)', () => {
    const t = sim.normalizeSimUsage('glm', {
      prompt_tokens: 2000, completion_tokens: 50, total_tokens: 2900,
    });
    expect(t.output).toBe(900); // 2900 - 2000 vence os 50 reportados
    expect(t.input).toBe(2000);
  });

  it('normalizeSimUsage (Anthropic): separa leitura e escrita de cache', () => {
    const t = sim.normalizeSimUsage('anthropic', {
      input_tokens: 120,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 900,
      output_tokens: 200,
    });
    expect(t).toEqual({ input: 120, cacheRead: 900, cacheWrite: 3000, output: 200, reasoning: 0 });
  });

  it('computeSimCost soma os 4 componentes com os preços do modelo', () => {
    // gpt-5.4-mini: 0.75 input / 0.075 cacheRead / 4.5 output por MTok.
    const c = sim.computeSimCost('gpt-5.4-mini', {
      input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6, reasoning: 0,
    });
    expect(c.usd).toBeCloseTo(0.75 + 0.075 + 4.5, 10);
    expect(c.componentes.cacheWrite).toBe(0);
  });

  it('computeSimCost cobra a ESCRITA de cache da Anthropic acima do input', () => {
    const p = sim.resolveSimPrices('claude-sonnet-5');
    expect(p.cacheWrite).toBeGreaterThan(p.input);       // 1,25× — prêmio de gravação
    expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 10);  // leitura a 0,1×
    const c = sim.computeSimCost('claude-sonnet-5', {
      input: 0, cacheRead: 0, cacheWrite: 1e6, output: 0, reasoning: 0,
    });
    expect(c.usd).toBeCloseTo(p.cacheWrite, 10);
  });

  it('computeSimCost devolve null para modelo sem preço (nunca um dólar errado)', () => {
    expect(sim.computeSimCost('modelo-inexistente', sim.normalizeSimUsage('openai', null))).toBe(null);
  });

  it('normalizeTurns colapsa turnos consecutivos do mesmo papel (Anthropic exige alternância)', () => {
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
  });

  it('buildSimChatBody: GLM usa thinking disabled/enabled + max_tokens', () => {
    const off = sim.buildSimChatBody({
      provider: 'glm', model: 'glm-5.2', effort: 'disabled',
      systemPrompt: 'P', turns: [{ role: 'user', content: 'Iniciar' }],
    });
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.reasoning_effort).toBeUndefined();
    expect(off.max_tokens).toBe(sim.SIM_MAX_TOKENS);

    const on = sim.buildSimChatBody({
      provider: 'glm', model: 'glm-5.2', effort: 'high',
      systemPrompt: 'P', turns: [{ role: 'user', content: 'Iniciar' }],
    });
    expect(on.thinking).toEqual({ type: 'enabled' });
    expect(on.reasoning_effort).toBe('high');
    expect(on.max_tokens).toBeGreaterThan(sim.SIM_MAX_TOKENS); // folga pro raciocínio
  });

  it('buildSimAnthropicArgs: cache_control no system e no último turno; thinking disabled', () => {
    const args = sim.buildSimAnthropicArgs({
      model: 'claude-sonnet-5', effort: 'disabled', systemPrompt: 'P',
      turns: [
        { role: 'user', content: 'Iniciar' },
        { role: 'assistant', content: 'oi' },
        { role: 'user', content: 'como vai?' },
      ],
    });
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args.output_config).toBeUndefined();
    // só o último turno leva breakpoint (padrão multi-turno)
    expect(typeof args.messages[0].content).toBe('string');
    expect(args.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('buildSimAnthropicArgs: effort liga adaptive; thinking:omit não manda nada', () => {
    const adaptativo = sim.buildSimAnthropicArgs({
      model: 'claude-sonnet-5', effort: 'low', systemPrompt: 'P',
      turns: [{ role: 'user', content: 'Iniciar' }],
    });
    expect(adaptativo.thinking).toEqual({ type: 'adaptive' });
    expect(adaptativo.output_config).toEqual({ effort: 'low' });

    // 'omit' existe para modelos Anthropic PRÉ-4.6 (não aceitam effort e já não
    // pensam sem o campo). Nenhum do alternador usa hoje; fica pronto para quando
    // o dono ciclar um modelo antigo pra dentro do teste.
    const antigo = sim.buildSimAnthropicArgs({
      model: 'claude-haiku-4-5', effort: 'disabled', systemPrompt: 'P',
      turns: [{ role: 'user', content: 'Iniciar' }], thinking: 'omit',
    });
    expect(antigo.thinking).toBeUndefined();
    expect(antigo.output_config).toBeUndefined();
    expect(antigo.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('extractSimText: junta blocos de texto (Anthropic) e tira <think> (GLM)', () => {
    expect(sim.extractSimText('anthropic', {
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Oi. ' }, { type: 'text', text: 'Tudo bem?' }],
    })).toBe('Oi. Tudo bem?');
    expect(sim.extractSimText('glm', {
      choices: [{ message: { content: '<think>plano</think>Oi, doutor.' } }],
    })).toBe('Oi, doutor.');
  });

  it('catálogo: as opções são exatamente as definidas pelo dono, todas com preço', () => {
    const cat = sim.simCatalogo();
    expect(cat.map((m) => `${m.key}:${m.efforts.join(',')}`)).toEqual([
      'gpt-5.4-mini:none',
      'gpt-5.4:medium,high',
      'gpt-5.5:medium,high',
      'glm-5.2:high',
      'claude-sonnet-5:disabled',
    ]);
    for (const m of cat) {
      expect(m.precos, `preço faltando para ${m.key}`).toBeTruthy();
      expect(['openai', 'glm', 'anthropic']).toContain(m.provider);
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
    // effort que existe em outro modelo, mas não neste
    expect((await post({ ...base, model: 'claude-sonnet-5', effort: 'medium' })).status).toBe(400);
    expect((await post({ ...base, model: 'glm-5.2', effort: 'disabled' })).status).toBe(400);
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
      .send({ casoId: 'fp-test-1', model: 'claude-sonnet-5', effort: 'disabled', messages: [{ role: 'user', content: 'Iniciar' }] });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('FP_PROMPT_SECRETO');
  });
});
