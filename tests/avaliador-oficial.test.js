// AVALIADOR OFICIAL (pipeline v29) em produção.
//
// O que este arquivo cobre — e por que cada coisa:
//
//   1. Os .md das duas versões (v29 e o modo progressão) montam: os slots que o
//      código preenche são exatamente os que o prompt usa. Um slot com nome
//      trocado não daria erro nenhum — chegaria ao modelo como `{{ASSIM}}`, e a
//      avaliação sairia sem o material.
//   2. O SIGILO: nota e feedback por CRITÉRIO são de supervisor e admin. Aluno
//      (interno, externo) e visitante têm nota total + feedback qualitativo. As
//      análises são escritas com o gabarito do caso à vista, então isto é
//      vazamento de gabarito, não preferência de UI.
//   3. A INTEGRIDADE da nota: o cliente devolve só a chave (`evalId`) da
//      avaliação, e nota/notas/texto saem do arquivo do servidor. Chave de
//      outro aluno e chave já usada são recusadas.
//   4. A MISSÃO (sidequest/desafio do dia) fechando pelo nó da missão, que é o
//      que substituiu o bloco [sidequest-resultado] do avaliador antigo.
//
// A execução do pipeline em si (as 16 chamadas) não entra aqui: a suite roda com
// as chaves de API vazias, de propósito. O que dá para testar sem rede é tudo o
// que decide o que o modelo recebe e quem vê o que volta.

const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, loginVisitor, authHeader, DATA_DIR } = require('./helpers');
const aval = require('../server/avaliador-pipeline');
const oficial = require('../server/avaliacao-oficial');

// Resultado de pipeline no formato que o finishPipeline devolve — o suficiente
// para os pedaços que este arquivo testa (nota, partes, corpo, missão).
function resultadoFake({ notaFinal = 72, comAnalise = true, missao = null, nCriterios = 15 } = {}) {
  const partes = [];
  for (let i = 1; i <= nCriterios; i++) {
    partes.push({
      num: i,
      nome: `Critério ${i}`,
      linhaCurta: `o que o critério ${i} mede`,
      analise: comAnalise ? `Análise do critério ${i}, que cita o gabarito: GABARITO_SECRETO_${i}.` : '',
      nota: 7,
      confianca: null,
      travas: { 2: true, 3: true, 4: false, 5: false },
      faixa: 3,
      realizacao: 'completa',
      etiqueta: 'potente',
      analiseForaDeOrdem: false,
      travasInconsistentes: false,
      incluido: true,
    });
  }
  return {
    evaluator: 'v29', version: 'v29', variant: null,
    notaFinal, considerados: nCriterios, partes,
    corpoSintetizador: 'Você abriu bem e sustentou o silêncio quando importava.',
    feedbackAluno: `Nota: ${notaFinal}/100\n\nsaudação\n\ncorpo`,
    instrumentacao: { model: 'gpt-5.6-luna', effort: 'high', totais: {}, custo: null, chamadas: 16 },
    missao,
  };
}

describe('avaliador oficial v29 — prompts e slots', () => {
  it('o modo padrão preenche os dois slots do caso, sem deixar slot cru', () => {
    const reqs = aval.buildPipelineNodeRequests({
      materiais: oficial.materiaisPadrao({ bloco1: 'BLOCO1_AQUI', log: 'LOG_AQUI' }),
      model: 'gpt-5.6-luna', effort: 'high', provider: 'openai', version: 'v29', variant: null,
    });
    expect(reqs.length).toBe(15);
    const developer = reqs[0].body.messages[0].content;
    expect(developer).toContain('BLOCO1_AQUI');
    expect(developer).toContain('LOG_AQUI');
    // Nenhum {{SLOT}} sobrando no prompt que vai ao modelo.
    expect(developer).not.toMatch(/\{\{[A-Z_0-9ÇÃÉÍÓÚ]+\}\}/);
    // O critério é o que varia por nó, e é a mensagem `user`.
    const users = reqs.map((r) => r.body.messages[1].content);
    expect(new Set(users).size).toBe(15);
    for (const u of users) expect(u).not.toMatch(/\{\{[A-Z_0-9ÇÃÉÍÓÚ]+\}\}/);
  });

  it('o modo progressão preenche os cinco slots e compartilha os critérios do v29', () => {
    const materiais = oficial.materiaisProgressao({
      bloco1: 'BLOCO1_AQUI',
      log: 'ATENDIMENTO_2_AQUI',
      atendimento1: 'ATENDIMENTO_1_AQUI',
      avaliacao1: 'AVALIACAO_1_AQUI',
      missao: 'MISSAO_AQUI',
    });
    const reqs = aval.buildPipelineNodeRequests({
      materiais, model: 'gpt-5.6-luna', effort: 'high', provider: 'openai',
      version: 'v29-progressao', variant: null,
    });
    expect(reqs.length).toBe(15);
    const developer = reqs[0].body.messages[0].content;
    for (const t of ['BLOCO1_AQUI', 'ATENDIMENTO_1_AQUI', 'AVALIACAO_1_AQUI', 'MISSAO_AQUI', 'ATENDIMENTO_2_AQUI']) {
      expect(developer).toContain(t);
    }
    expect(developer).not.toMatch(/\{\{[A-Z_0-9ÇÃÉÍÓÚ]+\}\}/);

    // Mesma grade do v29 (o .md dos critérios é o mesmo arquivo, lido da pasta
    // do v29 — se alguém duplicar o arquivo, este teste continua passando, mas
    // a contagem e os nomes precisam bater).
    const padrao = aval.loadAssets('v29');
    const prog = aval.loadAssets('v29-progressao');
    expect(prog.criteria.map((c) => c.nome)).toEqual(padrao.criteria.map((c) => c.nome));
  });

  it('material ausente entra com a frase de ausência, nunca com o slot cru', () => {
    const assets = aval.loadAssets('v29-progressao');
    const m = aval.normalizeMateriais(assets, {
      materiais: oficial.materiaisProgressao({ bloco1: 'B', log: 'L' }),
    });
    expect(m['{{ATENDIMENTO_1}}']).toMatch(/não houve atendimento anterior/i);
    expect(m['{{MISSAO}}']).toMatch(/não há missão ativa/i);
    expect(m['{{AVALIACAO_1}}']).toMatch(/não há avaliação anterior/i);
  });

  it('a régua e o formato de saída do modo progressão são os do prompt-raiz', () => {
    const raiz = aval.loadAssets('v29');
    const prog = aval.loadAssets('v29-progressao');
    // O bloco estático carrega régua + saída. As duas versões divergem só na
    // entrada e no sétimo princípio: as travas e as faixas têm de ser iguais.
    const soRegua = (t) => t.slice(t.indexOf('## [SISTEMA DE PONTUAÇÃO]'));
    expect(soRegua(prog.blockA)).toBe(soRegua(raiz.blockA));
  });

  it('nó da missão: sem resposta legível a missão NÃO é dada por cumprida', () => {
    expect(aval.parseSaidaMissao('CUMPRIDA: sim\nJUSTIFICATIVA: fez o que se pedia.')).toEqual({
      cumprida: true, legivel: true, justificativa: 'fez o que se pedia.',
    });
    expect(aval.parseSaidaMissao('CUMPRIDA: não\nJUSTIFICATIVA: só tangenciou.').cumprida).toBe(false);
    const ilegivel = aval.parseSaidaMissao('achei que ele foi bem');
    expect(ilegivel.cumprida).toBe(false);
    expect(ilegivel.legivel).toBe(false);
  });

  it('TODO .md de pipeline passa pelo próprio validador do painel de prompts', () => {
    // Guarda contra o erro que já aconteceu uma vez: o validador do
    // sintetizador não conhecia os slots extras do modo progressão e recusava o
    // arquivo que a produção estava lendo — o upload do prompt novo teria sido
    // rejeitado no deploy, com a avaliação já apontada para ele.
    const promptFiles = require('../server/prompt-files');
    const { PIPELINE_VERSIONS } = aval;
    const raiz = path.join(__dirname, '..');
    let conferidos = 0;
    for (const cfg of Object.values(PIPELINE_VERSIONS)) {
      for (const arquivo of [cfg.montado, cfg.sintetizador, cfg.missao, cfg.criteriosDe ? null : cfg.criterios]) {
        if (!arquivo) continue;
        const local = path.join(raiz, 'avaliacao', cfg.dir, arquivo);
        if (!fs.existsSync(local)) continue;
        const rel = `avaliacao/${cfg.dir}/${arquivo}`;
        const r = promptFiles.validatePromptContent(rel, fs.readFileSync(local, 'utf-8'));
        expect(r, `${rel}: ${r.error || ''}`).toEqual({ ok: true, validado: true });
        conferidos++;
      }
    }
    // Se a cópia local dos prompts não existir, o teste não vale nada: falha
    // em vez de passar vazio.
    expect(conferidos).toBeGreaterThanOrEqual(4);
  });

  // Os .md não vêm no git (vivem só no volume, e sobem por Administração →
  // Prompts), então um deploy pode chegar antes deles. Quem pergunta antes de
  // começar é o `versaoDisponivel`; quem responde "então avalia no modo padrão"
  // é o /api/evaluate. Sem isso, o aluno que reatendesse um caso na janela entre
  // o deploy e o upload receberia erro em vez de nota.
  it('versaoDisponivel diz se os .md da versão estão no volume', () => {
    expect(oficial.versaoDisponivel(oficial.VERSAO)).toBe(true);
    expect(oficial.versaoDisponivel(oficial.VERSAO_PROGRESSAO)).toBe(true);
    expect(oficial.versaoDisponivel('v99-que-nao-existe')).toBe(false);
  });

  it('o prompt da missão recebe missão e log, e é validado pelo painel de prompts', () => {
    const assets = aval.loadAssets('v29-progressao');
    expect(assets.missao.missaoVariable).toContain('{{MISSAO}}');
    expect(assets.missao.missaoVariable).toContain('{{LOG}}');
    // Contrato conhecido = gravação pelo painel passa pelo parser da produção.
    const promptFiles = require('../server/prompt-files');
    expect(promptFiles.hasValidator('avaliacao/v29-progressao/missao-v29-progressao.md')).toBe(true);
    expect(promptFiles.hasValidator('avaliacao/v29-progressao/prompt-no-v29-progressao-montado.md')).toBe(true);
  });
});

describe('avaliador oficial v29 — o que o aluno recebe', () => {
  it('texto do aluno = saudação + corpo, sem a linha de nota (a nota é selo na tela)', () => {
    const texto = oficial.textoDoAluno(resultadoFake(), 'v29');
    expect(texto).toContain('pré-correção');
    expect(texto).toContain('Você abriu bem');
    expect(texto).not.toMatch(/Nota:\s*\d+\/100/);
  });

  it('notas por critério saem das partes, e critério sem nota fica fora', () => {
    const r = resultadoFake();
    r.partes[3].nota = null;
    const notas = oficial.notasPorCriterio(r);
    expect(Object.keys(notas).length).toBe(14);
    expect(notas['4']).toBeUndefined();
    expect(notas['5']).toBe(7);
  });
});

describe('avaliador oficial v29 — detalhe por critério (arquivo no volume)', () => {
  beforeEach(() => resetData());

  it('grava, lê e vincula ao log; recusa dono errado e reuso', () => {
    const id = oficial.salvarDetalhe({ dono: '3', version: 'v29', result: resultadoFake(), model: 'gpt-5.6-luna', effort: 'high' });
    expect(id).toMatch(/^av-\d+-[0-9a-f]{8}$/);
    expect(oficial.lerDetalhe(id).partes.length).toBe(15);

    // Chave de outro aluno não vale — seria herdar a nota de alguém.
    expect(oficial.anexar(id, { logId: 'log-x', dono: '5' })).toBeNull();
    // Chave do dono vale uma vez...
    expect(oficial.anexar(id, { logId: 'log-x', dono: '3' })).toBeTruthy();
    // ...e só uma: reusar seria repetir uma avaliação boa em várias sessões.
    expect(oficial.anexar(id, { logId: 'log-y', dono: '3' })).toBeNull();
  });

  it('id fora do formato não vira caminho de arquivo', () => {
    expect(oficial.lerDetalhe('../../../etc/passwd')).toBeNull();
    expect(oficial.lerDetalhe('av-1-zzz')).toBeNull();
    expect(oficial.lerDetalhe('')).toBeNull();
  });

  it('poda os detalhes órfãos (avaliação cujo log nunca foi salvo) e preserva os vinculados', () => {
    const orfao = oficial.salvarDetalhe({ dono: '3', result: resultadoFake() });
    const vinculado = oficial.salvarDetalhe({ dono: '3', result: resultadoFake(), logId: 'log-1' });
    // Envelhece os dois em 8 dias; só o órfão sai.
    for (const id of [orfao, vinculado]) {
      const p = path.join(DATA_DIR, 'avaliacoes-criterios', `${id}.json`);
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      d.criadoEm = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(p, JSON.stringify(d));
    }
    oficial.podarOrfaos();
    expect(oficial.lerDetalhe(orfao)).toBeNull();
    expect(oficial.lerDetalhe(vinculado)).toBeTruthy();
  });
});

describe('avaliador oficial v29 — POST /api/logs com evalId', () => {
  beforeEach(() => resetData());

  async function salvarComEvalId({ token, evalId, over = {} }) {
    return request(app).post('/api/logs').set(authHeader(token)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      durationSeconds: 120,
      messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: '...' }],
      evalId,
      ...over,
    });
  }

  it('nota, notas por critério e texto vêm do SERVIDOR, não do body', async () => {
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({ dono: '3', version: 'v29', result: resultadoFake({ notaFinal: 72 }), model: 'gpt-5.6-luna', effort: 'high' });
    // O body tenta plantar nota 100 e um texto próprio: os dois são ignorados.
    const saved = await salvarComEvalId({ token: aluno, evalId: id, over: { score: 100, evaluation: 'nota 100, confia' } });
    expect(saved.status).toBe(200);
    expect(saved.body.score).toBe(72);
    expect(saved.body.evaluation).toContain('Você abriu bem');
    expect(saved.body.evaluation).not.toContain('confia');
    expect(saved.body.evalVersion).toBe('v29');
    expect(saved.body.criteriaScores['1']).toBe(7);
  });

  it('evalId de outro aluno é ignorado (a nota não é herdada)', async () => {
    const aluno = await loginAs('aluno'); // id 3
    const id = oficial.salvarDetalhe({ dono: '5', version: 'v29', result: resultadoFake({ notaFinal: 95 }) });
    const saved = await salvarComEvalId({ token: aluno, evalId: id, over: { score: null, evaluation: '' } });
    expect(saved.status).toBe(200);
    expect(saved.body.score).toBeNull();
    expect(saved.body.evalPartsId).toBeNull();
  });

  it('o MESMO evalId não serve para duas sessões', async () => {
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({ dono: '3', version: 'v29', result: resultadoFake({ notaFinal: 88 }) });
    const um = await salvarComEvalId({ token: aluno, evalId: id });
    const dois = await salvarComEvalId({ token: aluno, evalId: id });
    expect(um.body.score).toBe(88);
    expect(dois.body.score).toBeNull();
    expect(dois.body.evalPartsId).toBeNull();
  });
});

describe('avaliador oficial v29 — sigilo do detalhe por critério', () => {
  beforeEach(() => resetData());

  async function logComDetalhe() {
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({ dono: '3', version: 'v29', result: resultadoFake(), model: 'gpt-5.6-luna', effort: 'high' });
    const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      durationSeconds: 60, messages: [{ role: 'user', content: 'oi' }], evalId: id,
    });
    return { logId: saved.body.id, aluno };
  }

  it('o aluno recebe nota total e feedback, mas nem as notas por critério nem a chave', async () => {
    const { logId, aluno } = await logComDetalhe();
    const meus = await request(app).get('/api/logs').set(authHeader(aluno));
    const meu = meus.body.find((l) => l.id === logId);
    expect(meu.score).toBe(72);
    expect(meu.evaluation).toContain('Você abriu bem');
    expect(meu).not.toHaveProperty('criteriaScores');
    expect(meu).not.toHaveProperty('evalPartsId');
    // E nada da análise por critério (que cita o gabarito) no que ele recebe.
    expect(JSON.stringify(meu)).not.toContain('GABARITO_SECRETO');
  });

  it('GET /api/logs/:id/criterios: 403 para aluno e visitante, 200 para supervisor e admin', async () => {
    const { logId, aluno } = await logComDetalhe();

    const comoAluno = await request(app).get(`/api/logs/${logId}/criterios`).set(authHeader(aluno));
    expect(comoAluno.status).toBe(403);

    const visitor = await loginVisitor();
    expect((await request(app).get(`/api/logs/${logId}/criterios`).set(authHeader(visitor))).status).toBe(403);

    const prof = await loginAs('prof');
    const comoProf = await request(app).get(`/api/logs/${logId}/criterios`).set(authHeader(prof));
    expect(comoProf.status).toBe(200);
    expect(comoProf.body.disponivel).toBe(true);
    expect(comoProf.body.partes.length).toBe(15);
    expect(comoProf.body.partes[0].analise).toContain('GABARITO_SECRETO_1');
    expect(comoProf.body.notaFinal).toBe(72);

    const admin = await loginAs('admin');
    expect((await request(app).get(`/api/logs/${logId}/criterios`).set(authHeader(admin))).status).toBe(200);
  });

  it('log sem avaliador oficial responde "indisponível", não erro', async () => {
    const aluno = await loginAs('aluno');
    const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', durationSeconds: 30,
      messages: [{ role: 'user', content: 'oi' }],
      evaluation: '[notas]\n1: 8\n[feedback]\ntexto do avaliador antigo',
    });
    const prof = await loginAs('prof');
    const res = await request(app).get(`/api/logs/${saved.body.id}/criterios`).set(authHeader(prof));
    expect(res.status).toBe(200);
    expect(res.body.disponivel).toBe(false);
    expect(res.body.motivo).toMatch(/v29/);
  });

  it('log inexistente → 404 (para quem pode ver)', async () => {
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/logs/log-que-nao-existe/criterios').set(authHeader(prof))).status).toBe(404);
  });
});

describe('avaliador oficial v29 — missão pelo nó da missão', () => {
  beforeEach(() => resetData());

  async function atribuirSidequest() {
    const prof = await loginAs('prof');
    const sq = (await request(app).post('/api/sidequests/bank').set(authHeader(prof)).send({
      title: 'Sustentar o silêncio',
      description: 'Sustente um silêncio terapêutico sem preenchê-lo.',
      rewardTitle: 'Mestre do Silêncio',
    })).body;
    await request(app).post('/api/sidequests/assign').set(authHeader(prof)).send({ userId: '3', sidequestId: sq.id });
    return sq;
  }

  it('missão cumprida no detalhe → conclui a sidequest e concede o título', async () => {
    const sq = await atribuirSidequest();
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({
      dono: '3', version: 'v29-progressao',
      result: resultadoFake({ missao: { cumprida: true, legivel: true, justificativa: 'Sustentou por duas trocas.' } }),
    });
    const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      durationSeconds: 120, messages: [{ role: 'user', content: 'oi' }], evalId: id,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.sidequest.completed).toBe(true);
    expect(saved.body.sidequest.rewardTitleId).toBe(sq.rewardTitleId);

    const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
    expect(mine.body.active).toBeNull();
    expect(mine.body.completed.length).toBe(1);
  });

  it('missão NÃO cumprida → segue ativa, sem título', async () => {
    await atribuirSidequest();
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({
      dono: '3', version: 'v29-progressao',
      result: resultadoFake({ missao: { cumprida: false, legivel: true, justificativa: 'Preencheu o silêncio.' } }),
    });
    const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', durationSeconds: 120,
      messages: [{ role: 'user', content: 'oi' }], evalId: id,
    });
    expect(saved.body.sidequest.completed).toBe(false);

    const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
    expect(mine.body.active).toBeTruthy();
    expect(mine.body.completed.length).toBe(0);
  });

  it('avaliação sem missão (modo padrão) não fecha sidequest nenhuma', async () => {
    await atribuirSidequest();
    const aluno = await loginAs('aluno');
    const id = oficial.salvarDetalhe({ dono: '3', version: 'v29', result: resultadoFake({ missao: null }) });
    const saved = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', durationSeconds: 120,
      messages: [{ role: 'user', content: 'oi' }], evalId: id,
    });
    expect(saved.body.sidequest).toBeFalsy();
    const mine = await request(app).get('/api/me/sidequest').set(authHeader(aluno));
    expect(mine.body.active).toBeTruthy();
  });
});
