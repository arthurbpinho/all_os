// Notas por critério para o aluno e gráfico do perfil (demandas.md §16.3 e §18):
// o aluno vê os próprios NÚMEROS por critério; as análises escritas continuam só
// de supervisor e admin. Critério é identificado pelo nome.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const acessos = require('../server/acessos');
const cp = require('../server/criterios-perfil');

beforeEach(() => resetData());

describe('mediasPorCriterio (puro)', () => {
  const log = (over) => ({ type: 'freeplay', mode: 'training', timestamp: '2026-09-01T00:00:00Z', ...over });

  it('junta pelo nome (sem caixa), não pelo número, e respeita os modos', () => {
    const logs = [
      log({ criteriaScores: { 1: 6, 2: 8 }, criteriaNames: { 1: 'Vínculo', 2: 'Escuta' } }),
      // Critério novo entrou na posição 1: o "Vínculo" agora é o 2.
      log({ timestamp: '2026-09-02T00:00:00Z', criteriaScores: { 1: 4, 2: 8 }, criteriaNames: { 1: 'Silêncio', 2: 'vínculo' } }),
      log({ mode: 'competitive', criteriaScores: { 1: 10 }, criteriaNames: { 1: 'Escuta' } }),
      log({ type: 'neuro', criteriaScores: { 1: 1 }, criteriaNames: { 1: 'Escuta' } }),
    ];
    const r = cp.mediasPorCriterio(logs, { modos: ['treinamento', 'competitivo'] });
    expect(r.sessoes).toBe(3);
    expect(r.criterios).toEqual([
      { nome: 'Silêncio', media: 4, n: 1 },
      { nome: 'vínculo', media: 7, n: 2 },
      { nome: 'Escuta', media: 9, n: 2 },
    ]);
    expect(cp.mediasPorCriterio(logs, { modos: ['treinamento'] }).criterios.find((c) => c.nome === 'Escuta').n).toBe(1);
  });

  it('log antigo sem nomes usa os nomes da régua; sem régua, fica de fora', () => {
    const logs = [
      log({ criteriaScores: { 1: 5 }, evalVersion: 'v34' }),
      log({ criteriaScores: { 1: 9 } }),
    ];
    const r = cp.mediasPorCriterio(logs, { nomesDaRegua: (v) => (v === 'v34' ? { 1: 'Vínculo' } : null) });
    expect(r).toEqual({ criterios: [{ nome: 'Vínculo', media: 5, n: 1 }], sessoes: 1 });
  });
});

async function inserirLog(id, userId, over = {}) {
  await db.query(
    `INSERT INTO logs (id, user_id, type, mode, item_id, criteria_scores, criteria_names, eval_parts_id)
     VALUES ($1, $2, 'freeplay', $3, 'fp-test-1', $4, $5, 'av-1-abcd')`,
    [id, userId, over.mode || 'training', JSON.stringify(over.notas || { 1: 6, 2: 8 }),
      JSON.stringify(over.nomes || { 1: 'Vínculo', 2: 'Escuta' })],
  );
}

describe('notas por critério do aluno', () => {
  it('o aluno recebe as notas e os nomes, nunca a chave das análises', async () => {
    await inserirLog('log-a', 3);
    const aluno = await loginAs('aluno');
    const r = await request(app).get('/api/logs').set(authHeader(aluno));
    expect(r.body[0].criteriaScores).toEqual({ 1: 6, 2: 8 });
    expect(r.body[0].criteriaNames).toEqual({ 1: 'Vínculo', 2: 'Escuta' });
    expect(r.body[0]).not.toHaveProperty('evalPartsId');
  });

  it('com "Notas por critério e gráfico" bloqueado, o aluno volta a não receber os números', async () => {
    await inserirLog('log-a', 3);
    const admin = await loginAs('admin');
    const matriz = acessos.matrizPadrao();
    matriz.graficoCriterios.therapist = false;
    await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ matriz });

    const aluno = await loginAs('aluno');
    const r = await request(app).get('/api/logs').set(authHeader(aluno));
    expect(r.body[0]).not.toHaveProperty('criteriaScores');
    expect(r.body[0]).not.toHaveProperty('criteriaNames');
    expect((await request(app).get('/api/me/criterios').set(authHeader(aluno))).status).toBe(403);
    // Supervisor não é afetado pela matriz.
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/logs?userId=3').set(authHeader(prof))).body[0].criteriaScores).toEqual({ 1: 6, 2: 8 });
  });
});

describe('GET /api/me/criterios', () => {
  it('média por critério dos modos escolhidos em Acessos', async () => {
    await inserirLog('log-a', 3, { notas: { 1: 6, 2: 8 } });
    await inserirLog('log-b', 3, { notas: { 1: 8, 2: 4 } });
    await inserirLog('log-c', 3, { mode: 'competitive', notas: { 1: 10, 2: 10 } });
    await inserirLog('log-d', 5, { notas: { 1: 0, 2: 0 } });

    const aluno = await loginAs('aluno');
    const padrao = await request(app).get('/api/me/criterios').set(authHeader(aluno));
    expect(padrao.status).toBe(200);
    expect(padrao.body.sessoes).toBe(3);
    expect(padrao.body.criterios.find((c) => c.nome === 'Vínculo').media).toBe(8);
    expect(padrao.body.modos.map((m) => m.key)).toEqual(['treinamento', 'competitivo']);

    const admin = await loginAs('admin');
    const salvo = await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ modosPerfilCriterios: ['treinamento', 'lixo'] });
    expect(salvo.body.modosPerfilCriterios).toEqual(['treinamento']);
    const soTreino = await request(app).get('/api/me/criterios').set(authHeader(aluno));
    expect(soTreino.body.sessoes).toBe(2);
    expect(soTreino.body.criterios.find((c) => c.nome === 'Escuta').media).toBe(6);
  });

  it('supervisor vê o de quem acompanha; aluno não vê o de outro', async () => {
    await inserirLog('log-a', 3);
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/me/criterios?userId=3').set(authHeader(prof))).body.sessoes).toBe(1);
    const aluno2 = await loginAs('aluno2');
    expect((await request(app).get('/api/me/criterios?userId=3').set(authHeader(aluno2))).status).toBe(403);
  });
});

// O gráfico da SESSÃO (tela pós-atendimento) é desenhado com o que o próprio
// salvamento do log devolve — por isso a resposta do POST segue a mesma regra de
// sigilo do GET.
describe('POST /api/logs — notas da sessão que acabou de terminar', () => {
  const salvar = (token) => request(app).post('/api/logs').set(authHeader(token)).send({
    type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
    durationSeconds: 30, messages: [{ role: 'user', content: 'oi' }],
    criteriaScores: { 1: 6, 2: 8 }, score: 70,
  });

  it('o aluno recebe as notas por critério, mas nunca a chave das análises', async () => {
    const aluno = await loginAs('aluno');
    const r = await salvar(aluno);
    expect(r.status).toBe(200);
    expect(r.body.criteriaScores).toEqual({ 1: 6, 2: 8 });
    expect(r.body.evalPartsId).toBeNull();
  });

  it('com "Notas por critério e gráfico" bloqueado, a resposta vem sem elas', async () => {
    const admin = await loginAs('admin');
    const matriz = acessos.matrizPadrao();
    matriz.graficoCriterios.therapist = false;
    await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ matriz });

    const aluno = await loginAs('aluno');
    const r = await salvar(aluno);
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('criteriaScores');
    expect(r.body).not.toHaveProperty('criteriaNames');
  });

  it('supervisor e admin continuam recebendo tudo', async () => {
    const prof = await loginAs('prof');
    const r = await salvar(prof);
    expect(r.body.criteriaScores).toEqual({ 1: 6, 2: 8 });
  });
});

// O gráfico da AVALIAÇÃO mostra sempre os critérios da régua atual (demandas.md
// §27): renomeou em "Critérios da régua", muda no gráfico de toda sessão.
describe('criteriosDoLog (puro)', () => {
  const regua = [
    { id: '10', nome: 'Comunicação', ordem: 1, linhaCurta: 'clareza do que se diz' },
    { id: '11', nome: 'Intensidade', ordem: 2, linhaCurta: 'dose da intervenção' },
    { id: '12', nome: 'Priorização', ordem: 3, linhaCurta: 'o que vem primeiro' },
  ];

  it('log sem nomes gravados: posição da régua, com nome e descrição atuais', () => {
    expect(cp.criteriosDoLog({ criteriaScores: { 2: 5, 1: 7 } }, { regua })).toEqual([
      { num: '1', id: '10', nome: 'Comunicação', linhaCurta: 'clareza do que se diz', nota: 7 },
      { num: '2', id: '11', nome: 'Intensidade', linhaCurta: 'dose da intervenção', nota: 5 },
    ]);
  });

  it('log com nomes: o nome identifica o critério, mesmo noutra posição, e sai na ordem da régua', () => {
    const r = cp.criteriosDoLog({ criteriaScores: { 1: 9, 2: 4 }, criteriaNames: { 1: 'priorização', 2: 'Comunicação' } }, { regua });
    expect(r.map((c) => [c.num, c.nome, c.nota])).toEqual([['2', 'Comunicação', 4], ['1', 'Priorização', 9]]);
  });

  it('renomeado com "manter histórico" chega pelo apelido; o que saiu da régua não aparece', () => {
    const log = { criteriaScores: { 1: 8, 2: 6 }, criteriaNames: { 1: 'Precisão lexical', 2: 'Removido' } };
    const r = cp.criteriosDoLog(log, { regua, apelidos: { 'precisão lexical': 'Comunicação' } });
    expect(r).toEqual([{ num: '1', id: '10', nome: 'Comunicação', linhaCurta: 'clareza do que se diz', nota: 8 }]);
  });

  it('sem régua no banco (neuro, avaliador antigo) ou sem notas: null', () => {
    expect(cp.criteriosDoLog({ criteriaScores: { 1: 5 } }, { regua: [] })).toBeNull();
    expect(cp.criteriosDoLog({}, { regua })).toBeNull();
  });
});

describe('GET /api/logs — critérios pela régua atual', () => {
  async function regua() {
    // resetData não limpa a tabela de critérios: a régua de teste recomeça aqui.
    await db.query(`DELETE FROM criterios WHERE regua = 'teste-regua'`);
    const { rows } = await db.query(
      `INSERT INTO criterios (regua, nome, ordem, linha_curta) VALUES
         ('teste-regua', 'Comunicação', 1, 'clareza do que se diz'),
         ('teste-regua', 'Intensidade', 2, 'dose da intervenção')
       RETURNING id::text, nome`,
    );
    return Object.fromEntries(rows.map((r) => [r.nome, r.id]));
  }
  async function log(id, nomes) {
    await db.query(
      `INSERT INTO logs (id, user_id, type, mode, item_id, eval_version, criteria_scores, criteria_names)
       VALUES ($1, 3, 'freeplay', 'training', 'fp-test-1', 'teste-regua', '{"1": 7, "2": 5}', $2)`,
      [id, nomes ? JSON.stringify(nomes) : null],
    );
  }

  it('o aluno recebe os nomes atuais; renomear com "manter histórico" ou desativar muda o gráfico', async () => {
    const ids = await regua();
    await log('log-sem-nomes', null);
    await log('log-com-nomes', { 1: 'Comunicação', 2: 'Intensidade' });
    const aluno = await loginAs('aluno');
    const ver = async () => Object.fromEntries((await request(app).get('/api/logs').set(authHeader(aluno))).body
      .map((l) => [l.id, (l.criterios || []).map((c) => `${c.nome}=${c.nota}`)]));

    expect(await ver()).toEqual({
      'log-sem-nomes': ['Comunicação=7', 'Intensidade=5'],
      'log-com-nomes': ['Comunicação=7', 'Intensidade=5'],
    });

    await db.query(`UPDATE criterios SET nome = 'Clareza', nomes_anteriores = '{Comunicação}' WHERE id = $1`, [ids['Comunicação']]);
    await db.query(`UPDATE criterios SET ativo = false WHERE id = $1`, [ids['Intensidade']]);
    expect(await ver()).toEqual({
      'log-sem-nomes': ['Clareza=7'],
      'log-com-nomes': ['Clareza=7'],
    });

    const nomes = (await request(app).get('/api/criterios/nomes').set(authHeader(aluno))).body.nomes;
    expect(nomes[ids['Comunicação']]).toBe('Clareza');
    expect(nomes[ids['Intensidade']]).toBe('Intensidade');
  });

  it('com "Notas por critério e gráfico" bloqueado, o aluno não recebe os critérios', async () => {
    await regua();
    await log('log-a', null);
    const admin = await loginAs('admin');
    const matriz = acessos.matrizPadrao();
    matriz.graficoCriterios.therapist = false;
    await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ matriz });
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/logs').set(authHeader(aluno))).body[0]).not.toHaveProperty('criterios');
    // A equipe continua recebendo.
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/logs?userId=3').set(authHeader(prof))).body[0].criterios).toHaveLength(2);
  });
});
