// REAVALIAÇÃO de log e ESTRELAS depois da avaliação (migração 018).
//
//   1. Só supervisor e admin reavaliam — o supervisor, só os logs dos alunos
//      dele. A avaliação anterior fica guardada na reavaliação.
//   2. Aluno (e equipe) pode mudar estrelas e comentários de um log já avaliado,
//      nunca o texto das falas, e só nas falas do terapeuta.
//   3. O aluno PEDE a reavaliação; ela só roda quando supervisor/admin aprova.
//   4. MMR: reavaliar uma partida que já contou não mexe no MMR; um Competitivo
//      cuja avaliação falhou conta agora.
//
// O pipeline em si é trocado por um falso (a suíte roda sem chave de API).

const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const logsRepo = require('../server/repos/logs').criarRepoLogs(db.getPool());

function resultadoFake(notaFinal) {
  const partes = [];
  for (let i = 1; i <= 3; i++) {
    partes.push({
      num: i, nome: `Critério ${i}`, linhaCurta: `linha ${i}`, analise: `análise ${i}`, nota: 8, notas: null,
      qualidades: { integridade: 'plena', autoria: 'plena', potencia: 'plena', calibracao: 'plena', excepcionalidade: 'ausente' },
      qualidadesFaltantes: null, analiseForaDeOrdem: false, incluido: true,
    });
  }
  return {
    evaluator: 'v34', version: 'v34', notaFinal, considerados: 3, partes, comparativo: null,
    corpoSintetizador: `Avaliação refeita, nota ${notaFinal}.`,
    feedbackAluno: `Nota: ${notaFinal}/100\n\ncorpo`,
    instrumentacao: { model: 'fake', effort: 'high', totais: {}, custo: null, chamadas: 3 },
    missao: null,
  };
}

let chamadas = [];
function pipelineFake(nota = 88) {
  chamadas = [];
  app.__test.definirPipelineDaReavaliacao(async (args) => {
    chamadas.push(args);
    return resultadoFake(nota);
  });
}

async function criarLog(extra = {}) {
  const id = `log${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await logsRepo.criar({
    id, type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
    userId: '3', userName: 'Aluno A', score: 40, evaluation: 'Avaliação original.',
    messages: [
      { role: 'assistant', content: 'Oi, doutor.' },
      { role: 'user', content: 'Como você chegou até aqui?' },
      { role: 'assistant', content: 'Minha mãe me trouxe.' },
      { role: 'user', content: 'E o que você acha disso?' },
    ],
    ...extra,
  });
  return id;
}

describe('Reavaliação de log', () => {
  beforeEach(async () => { await resetData(); pipelineFake(); });

  it('supervisor do aluno reavalia: a nota nova entra no log e a anterior fica guardada', async () => {
    const id = await criarLog();
    const t = await loginAs('prof');
    const r = await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({ motivo: 'IA alucinou' });
    expect(r.status).toBe(202);
    expect(r.body.reavaliacao.status).toBe('em_andamento');
    await app.__test.aguardarReavaliacoes();

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].materiais).toBeTruthy();

    const g = await request(app).get(`/api/logs/${id}`).set(authHeader(t));
    expect(g.status).toBe(200);
    expect(g.body.score).toBe(88);
    expect(g.body.evalVersion).toBe('v34');
    expect(g.body.reavaliacao).toMatchObject({ status: 'concluida', notaAnterior: 40, notaNova: 88, motivo: 'IA alucinou' });
    expect(g.body.reavaliacao.avaliacaoAnterior.evaluation).toBe('Avaliação original.');

    // O aluno vê o resultado, mas não a avaliação anterior inteira.
    const ta = await loginAs('aluno');
    const ga = await request(app).get(`/api/logs/${id}`).set(authHeader(ta));
    expect(ga.body.score).toBe(88);
    expect(ga.body.reavaliacao.status).toBe('concluida');
    expect(ga.body.reavaliacao.avaliacaoAnterior).toBeUndefined();
  });

  it('aluno não reavalia; supervisor de outro aluno também não', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(ta)).send({})).status).toBe(403);
    const tp2 = await loginAs('prof2');
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(tp2)).send({})).status).toBe(404);
    const t = await loginAs('admin');
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({})).status).toBe(202);
    await app.__test.aguardarReavaliacoes();
  });

  it('recusa Trilha e log ainda pendente na fila', async () => {
    const trilha = await criarLog({ type: 'exercise', itemId: 'ex-test-1' });
    const pendente = await criarLog({ mode: 'competitive', score: null, evaluation: '', evaluationPending: true });
    const t = await loginAs('admin');
    expect((await request(app).post(`/api/logs/${trilha}/reavaliar`).set(authHeader(t)).send({})).status).toBe(409);
    expect((await request(app).post(`/api/logs/${pendente}/reavaliar`).set(authHeader(t)).send({})).status).toBe(409);
    expect(chamadas).toHaveLength(0);
  });

  it('falha do pipeline: o log fica como estava e a reavaliação registra o erro', async () => {
    app.__test.definirPipelineDaReavaliacao(async () => { throw new Error('rate limit'); });
    const id = await criarLog();
    const t = await loginAs('prof');
    await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({});
    await app.__test.aguardarReavaliacoes();
    const g = await request(app).get(`/api/logs/${id}`).set(authHeader(t));
    expect(g.body.score).toBe(40);
    expect(g.body.evaluation).toBe('Avaliação original.');
    expect(g.body.reavaliacao).toMatchObject({ status: 'falhou' });
    expect(g.body.reavaliacao.erro).toContain('rate limit');
    // E dá para tentar de novo.
    pipelineFake(70);
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({})).status).toBe(202);
    await app.__test.aguardarReavaliacoes();
    expect((await request(app).get(`/api/logs/${id}`).set(authHeader(t))).body.score).toBe(70);
  });

  it('não roda duas reavaliações do mesmo log ao mesmo tempo', async () => {
    let soltar;
    app.__test.definirPipelineDaReavaliacao(() => new Promise((ok) => { soltar = () => ok(resultadoFake(77)); }));
    const id = await criarLog();
    const t = await loginAs('admin');
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({})).status).toBe(202);
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({})).status).toBe(409);
    // Estrelas também ficam travadas enquanto roda.
    const ta = await loginAs('aluno');
    const e = await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(ta))
      .send({ marcacoes: [{ posicao: 2, highlighted: true, comment: 'x' }] });
    expect(e.status).toBe(409);
    soltar();
    await app.__test.aguardarReavaliacoes();
  });

  it('Competitivo já contado: a reavaliação não mexe no MMR', async () => {
    const id = await criarLog({ mode: 'competitive', score: 50, mmrBefore: 1000, mmrAfter: 1010, mmrDelta: { total: { before: 1000, after: 1010 } } });
    const t = await loginAs('admin');
    await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({});
    await app.__test.aguardarReavaliacoes();
    const g = await request(app).get(`/api/logs/${id}`).set(authHeader(t));
    expect(g.body.score).toBe(88);
    expect(g.body.mmrBefore).toBe(1000);
    expect(g.body.mmrAfter).toBe(1010);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM mmr_players');
    expect(rows[0].n).toBe(0);
  });

  it('Competitivo cuja avaliação falhou: a reavaliação aplica o MMR', async () => {
    const id = await criarLog({ mode: 'competitive', score: null, evaluation: '', evalError: 'sem resultado no batch' });
    const t = await loginAs('admin');
    await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(t)).send({});
    await app.__test.aguardarReavaliacoes();
    const g = await request(app).get(`/api/logs/${id}`).set(authHeader(t));
    expect(g.body.score).toBe(88);
    expect(g.body.evalError).toBeUndefined();
    expect(g.body.mmrDelta).toBeTruthy();
  });
});

describe('Estrelas depois da avaliação e pedido de reavaliação', () => {
  beforeEach(async () => { await resetData(); pipelineFake(91); });

  it('aluno acrescenta estrela e comentário sem mudar o texto das falas', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    const r = await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(ta)).send({
      marcacoes: [{ posicao: 2, highlighted: true, comment: 'Pergunta aberta de propósito.', content: 'TEXTO TROCADO' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.messages[1]).toMatchObject({ role: 'user', content: 'Como você chegou até aqui?', highlighted: true, comment: 'Pergunta aberta de propósito.' });
    expect(r.body.estrelasEditadasEm).toBeTruthy();
    // A avaliação não mudou: mudar estrela não reavalia.
    expect(r.body.score).toBe(40);
    expect(chamadas).toHaveLength(0);
  });

  it('não aceita estrela em fala do paciente nem em log de outro aluno', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    const pac = await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(ta))
      .send({ marcacoes: [{ posicao: 1, highlighted: true, comment: '' }] });
    expect(pac.status).toBe(400);
    const outro = await loginAs('aluno2');
    const o = await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(outro))
      .send({ marcacoes: [{ posicao: 2, highlighted: true, comment: '' }] });
    expect(o.status).toBe(404);
  });

  it('supervisor do aluno também edita as estrelas', async () => {
    const id = await criarLog();
    const t = await loginAs('prof');
    const r = await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(t))
      .send({ marcacoes: [{ posicao: 4, highlighted: true, comment: 'boa' }] });
    expect(r.status).toBe(200);
    expect(r.body.messages[3].highlighted).toBe(true);
  });

  it('aluno pede, supervisor é avisado e aprova; a reavaliação usa as estrelas novas', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    await request(app).put(`/api/logs/${id}/estrelas`).set(authHeader(ta))
      .send({ marcacoes: [{ posicao: 2, highlighted: true, comment: 'JUSTIFICATIVA_NOVA' }] });
    const p = await request(app).post(`/api/logs/${id}/reavaliacao/solicitar`).set(authHeader(ta)).send({ motivo: 'Acrescentei estrelas' });
    expect(p.status).toBe(200);
    expect(p.body.reavaliacao).toMatchObject({ status: 'solicitada', motivo: 'Acrescentei estrelas' });
    expect(chamadas).toHaveLength(0);

    // Pedido duplicado é recusado.
    expect((await request(app).post(`/api/logs/${id}/reavaliacao/solicitar`).set(authHeader(ta)).send({})).status).toBe(409);
    // O aluno não aprova o próprio pedido.
    expect((await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(ta)).send({})).status).toBe(403);

    const tp = await loginAs('prof');
    const notifs = await request(app).get('/api/notifications').set(authHeader(tp));
    const lista = Array.isArray(notifs.body) ? notifs.body : (notifs.body.items || notifs.body.notifications || []);
    expect(lista.some((n) => n.type === 'reevaluation_requested' && n.logId === id)).toBe(true);

    const a = await request(app).post(`/api/logs/${id}/reavaliar`).set(authHeader(tp)).send({});
    expect(a.status).toBe(202);
    await app.__test.aguardarReavaliacoes();
    expect(chamadas).toHaveLength(1);
    expect(JSON.stringify(chamadas[0].materiais)).toContain('JUSTIFICATIVA_NOVA');

    const g = await request(app).get(`/api/logs/${id}`).set(authHeader(ta));
    expect(g.body.score).toBe(91);
    expect(g.body.reavaliacao).toMatchObject({ status: 'concluida', motivo: 'Acrescentei estrelas', solicitadoPorNome: 'Aluno A', decididoPorNome: 'Professor A' });
  });

  it('supervisor recusa o pedido; o aluno pode pedir de novo', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    await request(app).post(`/api/logs/${id}/reavaliacao/solicitar`).set(authHeader(ta)).send({});
    const tp = await loginAs('prof');
    const r = await request(app).post(`/api/logs/${id}/reavaliacao/recusar`).set(authHeader(tp)).send({});
    expect(r.status).toBe(200);
    expect(r.body.reavaliacao.status).toBe('recusada');
    expect((await request(app).post(`/api/logs/${id}/reavaliacao/recusar`).set(authHeader(tp)).send({})).status).toBe(409);
    expect(chamadas).toHaveLength(0);
    expect((await request(app).post(`/api/logs/${id}/reavaliacao/solicitar`).set(authHeader(ta)).send({})).status).toBe(200);
  });

  it('a listagem do supervisor traz o pedido aberto', async () => {
    const id = await criarLog();
    const ta = await loginAs('aluno');
    await request(app).post(`/api/logs/${id}/reavaliacao/solicitar`).set(authHeader(ta)).send({ motivo: 'm' });
    const tp = await loginAs('prof');
    const l = await request(app).get('/api/logs').set(authHeader(tp));
    const log = l.body.find((x) => x.id === id);
    expect(log.reavaliacao).toMatchObject({ status: 'solicitada', motivo: 'm' });
  });
});
