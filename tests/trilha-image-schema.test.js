// Esquema visual (SVG) OPCIONAL ao final do exercício da Trilha — campos
// imageSchemaEnabled/imageSchemaPrompt/imageSchemaModel no exercício, e a rota
// /api/trilha/image-schema. A suite nunca chama IA de verdade (env sem
// OPENAI_API_KEY/ANTHROPIC_API_KEY, ver helpers.js), então só cobrimos os
// gates que retornam ANTES de qualquer chamada de rede (validação, 404, 400,
// 503 de provedor indisponível) — o caminho feliz (SVG de verdade) não dá
// pra testar sem bater na rede.

const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

describe('Exercícios — imageSchema (esquema visual opcional)', () => {
  beforeEach(() => resetData());

  it('defaults: desabilitado, modelo gpt-5.4, observação vazia', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Sem esquema', skillId: 1, specificInstruction: 'x',
    });
    expect(res.body.imageSchemaEnabled).toBe(false);
    expect(res.body.imageSchemaModel).toBe('gpt-5.4');
  });

  it('aceita habilitar com observação e claude-sonnet-5; modelo inválido cai no default', async () => {
    const token = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Com esquema', skillId: 1, specificInstruction: 'x',
      imageSchemaEnabled: true, imageSchemaPrompt: 'Desenhe um genograma', imageSchemaModel: 'claude-sonnet-5',
    });
    expect(created.body.imageSchemaEnabled).toBe(true);
    expect(created.body.imageSchemaPrompt).toBe('Desenhe um genograma');
    expect(created.body.imageSchemaModel).toBe('claude-sonnet-5');

    const badModel = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      imageSchemaModel: 'dall-e-mega',
    });
    expect(badModel.body.imageSchemaModel).toBe('gpt-5.4');

    const disabled = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      imageSchemaEnabled: false,
    });
    expect(disabled.body.imageSchemaEnabled).toBe(false);
  });

  it('publicExercise: esconde imageSchemaPrompt do aluno, mas expõe hasImageSchema', async () => {
    const token = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Com esquema', skillId: 1, specificInstruction: 'x',
      imageSchemaEnabled: true, imageSchemaPrompt: 'SEGREDO_NAO_VAZAR',
    });

    const alunoToken = await loginAs('aluno');
    const list = await request(app).get('/api/exercises').set(authHeader(alunoToken));
    const ex = list.body.find((e) => e.id === created.body.id);
    expect(ex.imageSchemaPrompt).toBeUndefined();
    expect(ex.hasImageSchema).toBe(true);

    const adminList = await request(app).get('/api/exercises').set(authHeader(token));
    const exAdmin = adminList.body.find((e) => e.id === created.body.id);
    expect(exAdmin.imageSchemaPrompt).toBe('SEGREDO_NAO_VAZAR');
  });
});

describe('/api/trilha/image-schema', () => {
  beforeEach(() => resetData());

  it('exige autenticação', async () => {
    const res = await request(app).post('/api/trilha/image-schema').send({ itemId: 'x', messages: [] });
    expect(res.status).toBe(401);
  });

  it('visitante é bloqueado quando visitorEvaluationEnabled está desligado (default)', async () => {
    const token = await loginVisitor();
    const res = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: 'ex-test-1', messages: [{ role: 'user', content: 'oi' }],
    });
    expect(res.status).toBe(403);
  });

  it('rejeita sem itemId ou sem messages', async () => {
    const token = await loginAs('aluno');
    const semItem = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(semItem.status).toBe(400);

    const semMessages = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: 'ex-test-1',
    });
    expect(semMessages.status).toBe(400);
  });

  it('404 pra exercício inexistente', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: 'nao-existe', messages: [{ role: 'user', content: 'oi' }],
    });
    expect(res.status).toBe(404);
  });

  it('400 quando o exercício não tem esquema visual habilitado', async () => {
    const token = await loginAs('aluno');
    // ex-test-1/ex-test-2 (helpers.js) não têm imageSchemaEnabled.
    const res = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: 'ex-test-1', messages: [{ role: 'user', content: 'oi' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/esquema visual/i);
  });

  it('400 quando messages não tem turnos válidos', async () => {
    const adminToken = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(adminToken)).send({
      title: 'Com esquema', skillId: 1, specificInstruction: 'x', imageSchemaEnabled: true,
    });

    const token = await loginAs('aluno');
    const res = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: created.body.id, messages: [{ role: 'system', content: 'irrelevante' }],
    });
    expect(res.status).toBe(400);
  });

  it('503 quando o provedor do modelo escolhido não tem API key configurada (sem bater na rede)', async () => {
    const adminToken = await loginAs('admin');
    const gpt = await request(app).post('/api/exercises').set(authHeader(adminToken)).send({
      title: 'Esquema GPT-5.4', skillId: 1, specificInstruction: 'x',
      imageSchemaEnabled: true, imageSchemaModel: 'gpt-5.4',
    });
    const claude = await request(app).post('/api/exercises').set(authHeader(adminToken)).send({
      title: 'Esquema Claude', skillId: 1, specificInstruction: 'x',
      imageSchemaEnabled: true, imageSchemaModel: 'claude-sonnet-5',
    });

    const token = await loginAs('aluno');
    const resGpt = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: gpt.body.id, messages: [{ role: 'user', content: 'Sessão de teste' }],
    });
    expect(resGpt.status).toBe(503);
    expect(resGpt.body.error).toMatch(/OPENAI_API_KEY/);

    const resClaude = await request(app).post('/api/trilha/image-schema').set(authHeader(token)).send({
      itemId: claude.body.id, messages: [{ role: 'user', content: 'Sessão de teste' }],
    });
    expect(resClaude.status).toBe(503);
    expect(resClaude.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });
});
