// Competências da Trilha (etiquetas dos exercícios) — CRUD admin-only, com
// bloqueio de exclusão quando algum exercício ainda usa a competência. Também
// cobre o campo evaluatorModel (modelo do avaliador escolhido por exercício).

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

describe('Trilha — competências (/api/trilha-skills)', () => {
  beforeEach(() => resetData());

  it('exige autenticação', async () => {
    const res = await request(app).get('/api/trilha-skills');
    expect(res.status).toBe(401);
  });

  it('aluno pode listar, mas não pode criar/editar/excluir', async () => {
    const token = await loginAs('aluno');
    const list = await request(app).get('/api/trilha-skills').set(authHeader(token));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);

    const create = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Nova' });
    expect(create.status).toBe(403);
  });

  it('admin cria competências com id/order auto-incrementados', async () => {
    const token = await loginAs('admin');
    const r1 = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Escuta', color: '#112233' });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ id: 1, name: 'Escuta', color: '#112233', order: 1 });

    const r2 = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Ética' });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(2);
    expect(r2.body.order).toBe(2);
    // cor inválida/ausente cai no fallback
    expect(r2.body.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('rejeita nome vazio na criação', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('admin renomeia e recolore; cor inválida cai no fallback', async () => {
    const token = await loginAs('admin');
    const created = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Original' });
    const id = created.body.id;

    const renamed = await request(app).put(`/api/trilha-skills/${id}`).set(authHeader(token)).send({ name: 'Renomeada' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renomeada');

    const recolored = await request(app).put(`/api/trilha-skills/${id}`).set(authHeader(token)).send({ color: 'não-é-cor' });
    expect(recolored.status).toBe(200);
    expect(recolored.body.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(recolored.body.color).not.toBe('não-é-cor');
  });

  it('bloqueia exclusão enquanto algum exercício usa a competência (409)', async () => {
    const token = await loginAs('admin');
    // defaultExercises() tem ex-test-1 com skillId:1 — a 1ª competência criada
    // aqui também recebe id:1 (auto-incremento a partir de uma lista vazia).
    const created = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Em uso' });
    expect(created.body.id).toBe(1);

    const del = await request(app).delete(`/api/trilha-skills/${created.body.id}`).set(authHeader(token));
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/exerc[íi]cio/i);

    // permanece na listagem
    const list = await request(app).get('/api/trilha-skills').set(authHeader(token));
    expect(list.body.find((s) => s.id === created.body.id)).toBeTruthy();
  });

  it('permite excluir competência sem exercícios associados', async () => {
    const token = await loginAs('admin');
    // id:1 e id:2 colidem com skillId dos exercícios seed; a 3ª fica livre.
    await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'A' });
    await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'B' });
    const livre = await request(app).post('/api/trilha-skills').set(authHeader(token)).send({ name: 'Livre' });
    expect(livre.body.id).toBe(3);

    const del = await request(app).delete(`/api/trilha-skills/${livre.body.id}`).set(authHeader(token));
    expect(del.status).toBe(200);

    const list = await request(app).get('/api/trilha-skills').set(authHeader(token));
    expect(list.body.find((s) => s.id === 3)).toBeUndefined();
  });
});

describe('Exercícios — evaluatorModel (modelo do avaliador por exercício)', () => {
  beforeEach(() => resetData());

  it('defaults pro mini quando ausente ou inválido na criação', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Sem modelo', skillId: 1, specificInstruction: 'x',
    });
    expect(res.body.evaluatorModel).toBe('gpt-5.4-mini');

    const res2 = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Modelo inválido', skillId: 1, specificInstruction: 'x', evaluatorModel: 'llama-mega',
    });
    expect(res2.body.evaluatorModel).toBe('gpt-5.4-mini');
  });

  it('aceita gpt-5.4, glm-5.2, gpt-5.5 e claude-sonnet-5 na criação/edição', async () => {
    const token = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Com GLM', skillId: 1, specificInstruction: 'x', evaluatorModel: 'glm-5.2',
    });
    expect(created.body.evaluatorModel).toBe('glm-5.2');

    const updated = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      evaluatorModel: 'gpt-5.5',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.evaluatorModel).toBe('gpt-5.5');

    const toHeavy = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      evaluatorModel: 'gpt-5.4',
    });
    expect(toHeavy.body.evaluatorModel).toBe('gpt-5.4');

    const toClaude = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      evaluatorModel: 'claude-sonnet-5',
    });
    expect(toClaude.body.evaluatorModel).toBe('claude-sonnet-5');

    const badUpdate = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      evaluatorModel: 'bogus',
    });
    expect(badUpdate.body.evaluatorModel).toBe('gpt-5.4-mini');
  });
});

describe('Exercícios — chatModel (IA que interpreta o papel do exercício)', () => {
  beforeEach(() => resetData());

  it('defaults pro mini quando ausente ou inválido na criação', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Sem modelo de chat', skillId: 1, specificInstruction: 'x',
    });
    expect(res.body.chatModel).toBe('gpt-5.4-mini');

    const res2 = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Modelo inválido', skillId: 1, specificInstruction: 'x', chatModel: 'llama-mega',
    });
    expect(res2.body.chatModel).toBe('gpt-5.4-mini');
  });

  it('aceita glm-5.2 e gpt-5.5 na criação/edição, independente do evaluatorModel', async () => {
    const token = await loginAs('admin');
    const created = await request(app).post('/api/exercises').set(authHeader(token)).send({
      title: 'Personagem em GLM', skillId: 1, specificInstruction: 'x',
      chatModel: 'glm-5.2', evaluatorModel: 'gpt-5.5',
    });
    expect(created.body.chatModel).toBe('glm-5.2');
    expect(created.body.evaluatorModel).toBe('gpt-5.5'); // os dois campos são independentes

    const updated = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      chatModel: 'gpt-5.5',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.chatModel).toBe('gpt-5.5');
    expect(updated.body.evaluatorModel).toBe('gpt-5.5'); // não mexeu no que não foi enviado

    const badUpdate = await request(app).put(`/api/exercises/${created.body.id}`).set(authHeader(token)).send({
      chatModel: 'bogus',
    });
    expect(badUpdate.body.chatModel).toBe('gpt-5.4-mini');
  });
});

describe('Avaliador da Trilha é OPCIONAL — sem fallback pro avaliador padrão', () => {
  beforeEach(() => resetData());

  // getOpenAI() só retorna null (modo demonstração) quando OPENAI_API_KEY está
  // vazia — helpers.js zera a env pra suite nunca bater na rede de verdade.
  // Aqui setamos uma chave FALSA só pra passar por esse gate: o 400 "sem
  // avaliador" é devolvido ANTES de qualquer chamada de rede, então não há
  // risco de a suite tentar acessar a OpenAI de verdade.
  const withDummyOpenAIKey = async (fn) => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-dummy-nao-e-uma-chave-real';
    try {
      await fn();
    } finally {
      process.env.OPENAI_API_KEY = prev;
    }
  };

  // Só testamos o caminho NEGATIVO (sem evaluatorPrompt → 400 antes de
  // qualquer chamada de IA). O caminho positivo (com evaluatorPrompt) seguiria
  // adiante pra uma chamada de rede de verdade — a suite deliberadamente nunca
  // faz isso (ver comentário sobre modo demo em helpers.js).
  it('exercício SEM evaluatorPrompt: /api/evaluate recusa com 400 (não cai em avaliador padrão)', async () => {
    await withDummyOpenAIKey(async () => {
      const token = await loginAs('aluno');
      const res = await request(app).post('/api/evaluate').set(authHeader(token)).send({
        messages: [{ role: 'user', content: 'Sessão de teste' }],
        context: { type: 'exercise', itemId: 'ex-test-2' }, // sem evaluatorPrompt (ver helpers.js)
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/não tem avaliador configurado/i);
    });
  });
});
