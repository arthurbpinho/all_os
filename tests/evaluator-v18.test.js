// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const { finalScoreFromCriteria, comparativeScores } = require('../server/scoring');

// Saída dos avaliadores v18.25: bloco `[notas]` (15 critérios, 1–10 ou NA) NO
// INÍCIO, `[feedback]` e o corpo depois. No save o servidor extrai as notas (vão
// pra criteriaScores, escondido do aluno), calcula a nota em código e grava só o
// corpo — com a saudação na frente, que o prompt v18.25 não escreve.
describe('avaliador v18.25 — bloco [notas] + [feedback]', () => {
  beforeEach(() => resetData());

  function notas(overrides = {}) {
    const base = {};
    for (let i = 1; i <= 15; i++) base[i] = 6;
    Object.assign(base, overrides);
    return Object.entries(base).map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  const corpo = 'Você abriu bem e sustentou o silêncio quando ela hesitou.';

  async function postEval(token, evaluation, extra = {}) {
    return request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      evaluation, messages: [{ role: 'user', content: 'oi' }], ...extra,
    });
  }

  it('extrai as 15 notas, calcula a nota e grava só o corpo do feedback', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, `[notas]\n${notas()}\n[feedback]\n${corpo}`);
    expect(res.status).toBe(200);
    expect(res.body.criteriaScores['15']).toBe(6);
    expect(Object.keys(res.body.criteriaScores)).toHaveLength(15);
    expect(res.body.score).toBe(60); // 15 × 6 = 90 → 90/150 → 60
    expect(res.body.evaluation).toContain(corpo);
    // nem o marcador nem as linhas de nota sobram no texto do aluno
    expect(res.body.evaluation).not.toMatch(/\[notas\]|\[feedback\]/i);
    expect(res.body.evaluation).not.toMatch(/^\s*7:\s*6\s*$/m);
  });

  it('prefixa a saudação (o prompt v18.25 não a escreve)', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, `[notas]\n${notas()}\n[feedback]\n${corpo}`);
    expect(res.body.evaluation).toMatch(/^Trate este feedback como pré-correção/);
    expect(res.body.evaluation).toMatch(/botão de estrela/);
  });

  it('NA (critérios 10 e 13) fica fora da nota e da tabela do supervisor', async () => {
    const admin = await loginAs('admin');
    const res = await postEval(admin, `[notas]\n${notas({ 10: 'NA', 13: 'NA' })}\n[feedback]\n${corpo}`);
    expect(res.body.criteriaScores['10']).toBe('NA');
    // 13 critérios × 6 = 78, base 130 → 60 (a média não muda, a base sim)
    expect(res.body.score).toBe(60);
    // com um NA e uma nota alta, a base menor muda a conta
    const res2 = await postEval(admin, `[notas]\n${notas({ 10: 'NA', 1: 10 })}\n[feedback]\n${corpo}`);
    expect(res2.body.score).toBe(Math.round(((13 * 6 + 10) / 140) * 100));
  });

  it('aluno não recebe criteriaScores no GET; supervisor recebe', async () => {
    const aluno = await loginAs('aluno');
    await postEval(aluno, `[notas]\n${notas()}\n[feedback]\n${corpo}`);
    const meus = await request(app).get('/api/logs').set(authHeader(aluno));
    expect(meus.body[0].criteriaScores).toBeUndefined();
    expect(meus.body[0].evaluation).toContain(corpo);

    const admin = await loginAs('admin');
    const todos = await request(app).get('/api/logs').set(authHeader(admin));
    const log = todos.body.find((l) => l.userName !== 'Admin' || l.itemTitle === 'Sofia');
    expect(log.criteriaScores['1']).toBe(6);
  });

  it('bloco de resultado da missão vem DEPOIS do corpo e sai do texto do aluno', async () => {
    const aluno = await loginAs('aluno');
    const evaluation = [
      '[notas]', notas(), '[feedback]', corpo, '',
      '[sidequest-resultado]',
      '{"sidequest_completed": false, "justification": "Não chegou a sustentar o silêncio pedido."}',
    ].join('\n');
    const res = await postEval(aluno, evaluation);
    expect(res.status).toBe(200);
    expect(res.body.evaluation).toContain(corpo);
    expect(res.body.evaluation).not.toMatch(/sidequest-resultado/i);
    expect(res.body.criteriaScores['1']).toBe(6);
  });

  it('bloco de notas fora de ordem (depois do corpo) não vaza pro aluno', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, `[feedback]\n${corpo}\n\n[notas]\n${notas()}`);
    expect(res.body.evaluation).toContain(corpo);
    expect(res.body.evaluation).not.toMatch(/\[notas\]/i);
  });

  it('modelo que esquece o [feedback] não perde o corpo (só as notas saem)', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, `[notas]\n${notas()}\n\n${corpo}`);
    expect(res.body.criteriaScores['1']).toBe(6);
    expect(res.body.evaluation).toContain(corpo);
    expect(res.body.evaluation).not.toMatch(/^\s*3:\s*6\s*$/m);
  });

  it('avaliação sem nenhum marcador continua funcionando (Trilha, [NOTA:X])', async () => {
    const aluno = await loginAs('aluno');
    const res = await postEval(aluno, 'Texto solto do avaliador da Trilha.', {
      type: 'exercise', score: 80, criteriaScores: { 1: 3 },
    });
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(80);
    expect(res.body.evaluation).toBe('Texto solto do avaliador da Trilha.');
  });
});

// Retrocompatibilidade: o comparativo antigo emitia as notas como linhas de
// pares ("A1: X  A2: X …") em vez de JSON, e alguns logs têm esse formato.
describe('formato legado [notas-supervisor] em linhas de pares', () => {
  beforeEach(() => resetData());

  it('lê vários pares por linha e ignora prosa no payload', async () => {
    const admin = await loginAs('admin');
    const evaluation = [
      'Análise comparativa.',
      '',
      '[notas-supervisor]',
      'A1: 6  A2: 7  A3: 5',
      'nota: isto é prosa e não conta',
      'B1: 4  B2: 5  B3: 6',
    ].join('\n');
    const res = await request(app).post('/api/logs').set(authHeader(admin)).send({
      type: 'freeplay', itemId: 'fp-test-1', itemTitle: 'Sofia',
      evaluation, messages: [{ role: 'user', content: 'oi' }],
    });
    expect(res.body.criteriaScores).toEqual({ A1: 6, A2: 7, A3: 5, B1: 4, B2: 5, B3: 6 });
    expect(res.body.evaluation).toBe('Análise comparativa.');
  });
});

describe('scoring com a grade de 15 critérios', () => {
  it('nota final é a média × 10, com NA fora da base', () => {
    const c = {};
    for (let i = 1; i <= 15; i++) c[i] = 8;
    expect(finalScoreFromCriteria(c)).toBe(80);
    c[10] = 'NA';
    expect(finalScoreFromCriteria(c)).toBe(80); // 14 × 8 / 140
  });

  it('comparativo separa A1..A15 / B1..B15 e aponta o vencedor', () => {
    const c = {};
    for (let i = 1; i <= 15; i++) { c['A' + i] = 7; c['B' + i] = 5; }
    c.B13 = 'NA';
    const r = comparativeScores(c);
    expect(r.scoreA).toBe(70);
    expect(r.scoreB).toBe(50); // 14 critérios, base 140
    expect(r.winner).toBe('A');
    expect(Object.keys(r.criteriaA)).toHaveLength(15);
    expect(Object.keys(r.criteriaB)).toHaveLength(14);
  });
});
