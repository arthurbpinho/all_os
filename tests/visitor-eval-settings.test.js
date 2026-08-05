// Configuração da "Avaliação para visitantes" (Gestão de Contas) — liga/
// desliga + escolha do MODELO (GLM 5.2 high ou GPT-5.5 high) que roda essa
// avaliação (ver VISITOR_EVAL_MODELS em server/index.js).

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

describe('Configurações — avaliação para visitantes (/api/settings, /api/admin/settings)', () => {
  beforeEach(() => resetData());

  it('GET /api/settings exige autenticação', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('defaults: desligada, modelo glm-5.2', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/settings').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.visitorEvaluationEnabled).toBe(false);
    expect(res.body.visitorEvaluationModel).toBe('glm-5.2');
  });

  it('PUT /api/admin/settings é admin-only', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/admin/settings').set(authHeader(token)).send({ visitorEvaluationEnabled: true });
    expect(res.status).toBe(403);
  });

  it('admin liga a avaliação e troca o modelo pra gpt-5.5; reflete em GET /api/settings', async () => {
    const admin = await loginAs('admin');
    const put = await request(app).put('/api/admin/settings').set(authHeader(admin)).send({
      visitorEvaluationEnabled: true, visitorEvaluationModel: 'gpt-5.5',
    });
    expect(put.status).toBe(200);
    expect(put.body.visitorEvaluationEnabled).toBe(true);
    expect(put.body.visitorEvaluationModel).toBe('gpt-5.5');

    const token = await loginAs('aluno');
    const res = await request(app).get('/api/settings').set(authHeader(token));
    expect(res.body.visitorEvaluationEnabled).toBe(true);
    expect(res.body.visitorEvaluationModel).toBe('gpt-5.5');
  });

  it('modelo inválido cai no default (glm-5.2), sem quebrar', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).put('/api/admin/settings').set(authHeader(admin)).send({
      visitorEvaluationModel: 'dall-e-mega',
    });
    expect(res.status).toBe(200);
    expect(res.body.visitorEvaluationModel).toBe('glm-5.2');
  });

  it('atualizar só o modelo não derruba o toggle já ligado', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/settings').set(authHeader(admin)).send({ visitorEvaluationEnabled: true });

    const put = await request(app).put('/api/admin/settings').set(authHeader(admin)).send({ visitorEvaluationModel: 'gpt-5.5' });
    expect(put.body.visitorEvaluationEnabled).toBe(true);
    expect(put.body.visitorEvaluationModel).toBe('gpt-5.5');
  });
});
