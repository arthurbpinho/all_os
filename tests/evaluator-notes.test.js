// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');

// Bloco [notas-supervisor] do avaliador v15: extraído no save (vai pra
// criteriaScores + tira do texto), escondido do aluno, visível p/ supervisor/admin.
describe('bloco [notas-supervisor] do avaliador (v15)', () => {
  beforeEach(() => resetData());

  const evalJson = `**Nota: 53/100**

Boa condução no geral, com escuta presente.

**Pontos para revisar com seu supervisor:**

Vale revisar o manejo do afeto difícil.

---
[notas-supervisor]
{"1":4.33,"2":5.25,"3":5.5,"4":4.75,"5":5,"6":5.5}`;

  async function postEval(token, evaluation, extra = {}) {
    return request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia', score: 53,
      evaluation, messages: [{ role: 'user', content: 'oi' }], ...extra,
    });
  }

  it('extrai criteriaScores e remove o bloco do texto salvo', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, evalJson);
    expect(res.status).toBe(200);
    // resposta do POST (pro próprio aluno) já não traz o bloco no texto
    expect(res.body.evaluation).not.toMatch(/notas-supervisor/i);
    expect(res.body.evaluation).toContain('Boa condução');
    // criteriaScores foi extraído (a resposta do POST não é filtrada por papel)
    expect(res.body.criteriaScores).toEqual({ '1': 4.33, '2': 5.25, '3': 5.5, '4': 4.75, '5': 5, '6': 5.5 });
  });

  it('aluno NÃO recebe criteriaScores no GET /api/logs (e o texto vem limpo)', async () => {
    const aluno = await loginAs('aluno');
    await postEval(aluno, evalJson);
    const res = await request(app).get('/api/logs').set(authHeader(aluno));
    const log = res.body[0];
    expect(log).toBeTruthy();
    expect(log.criteriaScores).toBeUndefined();          // escondido do aluno
    expect(log.evaluation).not.toMatch(/notas-supervisor/i);
    expect(log.evaluation).toContain('Boa condução');
  });

  it('supervisor do aluno recebe criteriaScores', async () => {
    const aluno = await loginAs('aluno');
    const prof = await loginAs('prof'); // teacherId do aluno '3' é '2' (prof)
    await postEval(aluno, evalJson);
    const res = await request(app).get('/api/logs').set(authHeader(prof));
    const log = res.body.find((l) => l.userId === '3');
    expect(log).toBeTruthy();
    expect(log.criteriaScores).toEqual({ '1': 4.33, '2': 5.25, '3': 5.5, '4': 4.75, '5': 5, '6': 5.5 });
  });

  it('admin recebe criteriaScores', async () => {
    const aluno = await loginAs('aluno');
    const admin = await loginAs('admin');
    await postEval(aluno, evalJson);
    const res = await request(app).get('/api/logs').set(authHeader(admin));
    const log = res.body.find((l) => l.userId === '3');
    expect(log.criteriaScores).toMatchObject({ '1': 4.33, '6': 5.5 });
  });

  it('retrocompat: aceita o bloco antigo em Base64 de linhas N:nota', async () => {
    const aluno = await loginAs('aluno');
    const prof = await loginAs('prof');
    const b64 = Buffer.from('1:4\n2:5\n3:6\n4:5\n5:5\n6:5', 'utf-8').toString('base64');
    const evalB64 = `**Nota: 50/100**\n\ntexto da análise\n\n---\n[notas-supervisor]\n${b64}`;
    await postEval(aluno, evalB64, { score: 50 });
    const res = await request(app).get('/api/logs').set(authHeader(prof));
    const log = res.body.find((l) => l.userId === '3');
    expect(log.criteriaScores).toEqual({ '1': 4, '2': 5, '3': 6, '4': 5, '5': 5, '6': 5 });
    expect(log.evaluation).not.toMatch(/notas-supervisor/i);
    expect(log.evaluation).toContain('texto da análise');
  });

  it('avaliação sem bloco não quebra (criteriaScores fica null)', async () => {
    const aluno = await loginAs('aluno');
    const prof = await loginAs('prof');
    await postEval(aluno, '**Nota: 70/100**\n\nSó a prosa, sem bloco.');
    const res = await request(app).get('/api/logs').set(authHeader(prof));
    const log = res.body.find((l) => l.userId === '3');
    expect(log.criteriaScores).toBeNull();
    expect(log.evaluation).toContain('Só a prosa');
  });
});
