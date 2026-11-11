// Tags de abordagem teórica (Perfil → Identidade).
//
//   1. O que o perfil aceita: só ids do catálogo, nunca a tag inativa (Allos),
//      e "Outras / Não tenho" sozinha.
//   2. Fica salvo na conta e aparece para quem lê os logs (supervisor/admin).
//   3. NÃO chega à avaliação por IA: o material do avaliador não traz a abordagem.

const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const { ABORDAGENS } = require('../server/abordagens');
const logsRepo = require('../server/repos/logs').criarRepoLogs(db.getPool());

describe('Abordagem no perfil', () => {
  beforeEach(() => resetData());

  it('a lista do cliente é a mesma do servidor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'client/src/abordagens.js'), 'utf8');
    const bloco = src.slice(src.indexOf('export const ABORDAGENS = ['), src.indexOf('];'));
    const ids = [...bloco.matchAll(/id: '([^']+)', rotulo: '([^']+)', ativa: (true|false)/g)]
      .map((m) => ({ id: m[1], rotulo: m[2], ativa: m[3] === 'true' }));
    expect(ids).toEqual(ABORDAGENS.map(({ id, rotulo, ativa }) => ({ id, rotulo, ativa })));
    expect(ABORDAGENS).toHaveLength(14);
  });

  it('salva as tags escolhidas, na ordem do catálogo, e devolve no /me', async () => {
    const t = await loginAs('aluno');
    const r = await request(app).put('/api/users/3').set(authHeader(t)).send({ abordagens: ['tcc', 'gestalt', 'tcc'] });
    expect(r.status).toBe(200);
    expect(r.body.abordagens).toEqual(['gestalt', 'tcc']);
    const me = await request(app).get('/api/me').set(authHeader(t));
    const u = me.body.user || me.body;
    expect(u.abordagens).toEqual(['gestalt', 'tcc']);
    // Salvar o perfil sem mandar o campo não apaga as tags.
    const r2 = await request(app).put('/api/users/3').set(authHeader(t)).send({ name: 'Aluno A' });
    expect(r2.body.abordagens).toEqual(['gestalt', 'tcc']);
    // Lista vazia limpa.
    const r3 = await request(app).put('/api/users/3').set(authHeader(t)).send({ abordagens: [] });
    expect(r3.body.abordagens).toEqual([]);
  });

  it('recusa Allos (ainda inativa), id desconhecido e "Outras" junto de outra', async () => {
    const t = await loginAs('aluno');
    const put = (abordagens) => request(app).put('/api/users/3').set(authHeader(t)).send({ abordagens });
    expect((await put(['allos'])).status).toBe(400);
    expect((await put(['behaviorismo-radical'])).status).toBe(400);
    expect((await put(['outras', 'tcc'])).status).toBe(400);
    expect((await put('tcc')).status).toBe(400);
    expect((await put(['outras'])).body.abordagens).toEqual(['outras']);
  });

  it('aparece nos logs para o supervisor, sem entrar no material da avaliação', async () => {
    const ta = await loginAs('aluno');
    await request(app).put('/api/users/3').set(authHeader(ta)).send({ abordagens: ['psicanalise'] });
    await logsRepo.criar({
      id: 'log-abord-1', type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      userId: '3', userName: 'Aluno A', score: 50, evaluation: 'ok',
      messages: [{ role: 'assistant', content: 'Oi.' }, { role: 'user', content: 'Olá, como vai?' }],
    });
    const tp = await loginAs('prof');
    const l = await request(app).get('/api/logs').set(authHeader(tp));
    expect(l.body.find((x) => x.id === 'log-abord-1').userAbordagens).toEqual(['psicanalise']);

    // A reavaliação monta o material do avaliador a partir do log salvo: nada
    // da abordagem pode estar nele.
    let materiais = null;
    app.__test.definirPipelineDaReavaliacao(async (args) => {
      materiais = args.materiais;
      return { notaFinal: 60, partes: [], corpoSintetizador: 'x', feedbackAluno: 'x', instrumentacao: {} };
    });
    const ad = await loginAs('admin');
    await request(app).post('/api/logs/log-abord-1/reavaliar').set(authHeader(ad)).send({});
    await app.__test.aguardarReavaliacoes();
    expect(materiais).toBeTruthy();
    const texto = JSON.stringify(materiais);
    expect(texto).toContain('Olá, como vai?');
    expect(texto).not.toMatch(/psicanalise|Psicanálise \(Lacan/);
  });
});
