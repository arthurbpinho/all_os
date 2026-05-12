// Confirma que os filtros de segurança aplicados nas listagens funcionam.
// Estes testes existem pra evitar regressão dos vazamentos encontrados no pentest:
// visitor não pode ver diagnosis/specificInstruction/evaluatorPrompt.

const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

describe('listings — filtros de campos sensíveis', () => {
  beforeEach(() => resetData());

  describe('/api/neuro', () => {
    it('admin vê tudo (diagnosis + specificInstruction)', async () => {
      const token = await loginAs('admin');
      const res = await request(app).get('/api/neuro').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body[0].diagnosis).toBe('DIAGNOSTICO_SECRETO_NAO_VAZAR');
      expect(res.body[0].specificInstruction).toContain('NEURO_PROMPT_SECRETO');
    });

    it('visitor NÃO vê diagnosis nem specificInstruction', async () => {
      const token = await loginVisitor();
      const res = await request(app).get('/api/neuro').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body[0].diagnosis).toBeUndefined();
      expect(res.body[0].specificInstruction).toBeUndefined();
      // Campos públicos continuam
      expect(res.body[0].name).toBe('Beatriz Test');
    });

    it('aluno NÃO vê diagnosis nem specificInstruction (defesa em profundidade)', async () => {
      const token = await loginAs('aluno');
      const res = await request(app).get('/api/neuro').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body[0].diagnosis).toBeUndefined();
      expect(res.body[0].specificInstruction).toBeUndefined();
    });
  });

  describe('/api/freeplay', () => {
    it('visitor NÃO vê specificInstruction', async () => {
      const token = await loginVisitor();
      const res = await request(app).get('/api/freeplay').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(res.body[0].specificInstruction).toBeUndefined();
      expect(res.body[0].name).toBe('Sofia Test');
    });
  });

  describe('/api/exercises', () => {
    it('aluno NÃO vê specificInstruction nem evaluatorPrompt — mas vê hasCustomEvaluator', async () => {
      const token = await loginAs('aluno');
      const res = await request(app).get('/api/exercises').set(authHeader(token));
      expect(res.status).toBe(200);
      const ex1 = res.body.find((e) => e.id === 'ex-test-1');
      expect(ex1.specificInstruction).toBeUndefined();
      expect(ex1.evaluatorPrompt).toBeUndefined();
      expect(ex1.hasCustomEvaluator).toBe(true);  // ex-test-1 tem evaluatorPrompt
      expect(ex1.title).toBe('Test Exercise');

      const ex2 = res.body.find((e) => e.id === 'ex-test-2');
      expect(ex2.hasCustomEvaluator).toBe(false); // ex-test-2 não tem
    });

    it('admin vê tudo', async () => {
      const token = await loginAs('admin');
      const res = await request(app).get('/api/exercises').set(authHeader(token));
      const ex1 = res.body.find((e) => e.id === 'ex-test-1');
      expect(ex1.specificInstruction).toContain('PROMPT_SECRETO');
      expect(ex1.evaluatorPrompt).toContain('EVAL_PROMPT');
    });
  });

  describe('/api/entrevistador-prompt', () => {
    it('visitor recebe 403 (era acessível antes — vazamento)', async () => {
      const token = await loginVisitor();
      const res = await request(app).get('/api/entrevistador-prompt').set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('aluno recebe 403', async () => {
      const token = await loginAs('aluno');
      const res = await request(app).get('/api/entrevistador-prompt').set(authHeader(token));
      expect(res.status).toBe(403);
    });

    it('admin recebe 200 (se arquivo existir) ou 404 (se não)', async () => {
      const token = await loginAs('admin');
      const res = await request(app).get('/api/entrevistador-prompt').set(authHeader(token));
      // Em test env, o arquivo physically existe no repo, então 200 esperado.
      // Se ele não existir, ainda assim a checagem de role passou — não dá 403.
      expect([200, 404]).toContain(res.status);
    });
  });
});
