// Controle de acesso por funcionalidade (demandas.md §16.2): matriz editada em
// Administração → Acessos, travando no SERVIDOR — o cadeado do menu é só a
// conveniência.
const { app, request, resetData, loginAs, loginVisitor, authHeader, db } = require('./helpers');
const acessos = require('../server/acessos');

async function bloquear(admin, chave, perfis) {
  const matriz = acessos.matrizPadrao();
  for (const p of perfis) matriz[chave][p] = false;
  const r = await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ matriz });
  expect(r.status).toBe(200);
  return r;
}

// Aluno externo de teste: vira o 'aluno2' em external (sem professor).
async function loginExterno() {
  await db.query(`UPDATE users SET role = 'external', teacher_id = NULL WHERE id = 5`);
  return loginAs('aluno2');
}

beforeEach(() => resetData());

describe('matriz de acessos', () => {
  it('nasce com tudo liberado para os três perfis, e nada muda no deploy', async () => {
    const admin = await loginAs('admin');
    const r = await request(app).get('/api/admin/acessos').set(authHeader(admin));
    expect(r.status).toBe(200);
    expect(r.body.perfis.map((p) => p.key)).toEqual(['therapist', 'external', 'visitor']);
    for (const f of r.body.funcionalidades) {
      expect(r.body.matriz[f.key]).toEqual({ therapist: true, external: true, visitor: true });
    }
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/acessos').set(authHeader(aluno))).body.bloqueadas).toEqual([]);
  });

  it('só o admin lê e grava a matriz', async () => {
    for (const quem of ['prof', 'aluno']) {
      const t = await loginAs(quem);
      expect((await request(app).get('/api/admin/acessos').set(authHeader(t))).status).toBe(403);
      expect((await request(app).put('/api/admin/acessos').set(authHeader(t)).send({ matriz: {} })).status).toBe(403);
    }
  });

  it('bloquear para o externo trava a rota dele, com a mensagem do cadeado, e não a do terapeuta da Allos', async () => {
    const admin = await loginAs('admin');
    await bloquear(admin, 'ranking', ['external']);
    await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({ mensagemCadeado: 'Só para alunos da formação.' });

    const externo = await loginExterno();
    const barrado = await request(app).get('/api/ranking').set(authHeader(externo));
    expect(barrado.status).toBe(403);
    expect(barrado.body).toEqual({ error: 'Só para alunos da formação.', funcionalidadeBloqueada: 'ranking' });
    expect((await request(app).get('/api/acessos').set(authHeader(externo))).body.bloqueadas).toEqual(['ranking']);

    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/ranking').set(authHeader(aluno))).status).toBe(200);
    // Admin e supervisor não são governados pela matriz.
    expect((await request(app).get('/api/ranking').set(authHeader(admin))).status).toBe(200);
  });

  it('atendimento bloqueado trava o chat e a avaliação daquele tipo, no servidor', async () => {
    const admin = await loginAs('admin');
    await bloquear(admin, 'simulacao', ['therapist']);
    const aluno = await loginAs('aluno');

    const chat = await request(app).post('/api/chat').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'Iniciar' }], context: { type: 'freeplay', itemId: 'fp-test-1' } });
    expect(chat.status).toBe(403);
    expect(chat.body.funcionalidadeBloqueada).toBe('simulacao');

    const avaliar = await request(app).post('/api/evaluate').set(authHeader(aluno))
      .send({ messages: [], context: { type: 'freeplay', mode: 'training', itemId: 'fp-test-1' } });
    expect(avaliar.status).toBe(403);
  });

  it('Avaliação por IA desligada barra /api/evaluate mesmo com a Simulação ligada', async () => {
    const admin = await loginAs('admin');
    await bloquear(admin, 'avaliacao', ['therapist']);
    const aluno = await loginAs('aluno');
    const r = await request(app).post('/api/evaluate').set(authHeader(aluno))
      .send({ messages: [], context: { type: 'freeplay', mode: 'training', itemId: 'fp-test-1' } });
    expect(r.status).toBe(403);
    expect(r.body.funcionalidadeBloqueada).toBe('avaliacao');
    // O chat (atender) continua.
    expect((await request(app).post('/api/chat').set(authHeader(aluno))
      .send({ messages: [{ role: 'user', content: 'Iniciar' }], context: { type: 'freeplay', itemId: 'fp-test-1' } })).status).toBe(200);
  });

  it('Comunidade bloqueada fecha o feed e a escrita, mas o link público da discussão continua abrindo', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    await request(app).post('/api/comunidade').set(authHeader(aluno)).send({ title: 'Antes', body: 'texto' }).expect(200);
    await bloquear(admin, 'comunidade', ['therapist']);

    expect((await request(app).get('/api/comunidade').set(authHeader(aluno))).status).toBe(403);
    expect((await request(app).post('/api/comunidade').set(authHeader(aluno)).send({ title: 'Depois', body: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/comunidade/1')).status).toBe(200);
  });

  it('duelo bloqueado para o visitante: não aceita o convite pelo link', async () => {
    const admin = await loginAs('admin');
    const aluno = await loginAs('aluno');
    const duelo = await request(app).post('/api/duel').set(authHeader(aluno)).send({ characterId: 'fp-test-1', inviteMethod: 'whatsapp' });
    await bloquear(admin, 'duelo', ['visitor']);

    const visitante = await loginVisitor();
    const r = await request(app).post(`/api/duel/by-token/${duelo.body.token}/accept`).set(authHeader(visitante));
    expect(r.status).toBe(403);
    // Para o terapeuta da Allos, criar duelo segue liberado.
    expect((await request(app).post('/api/duel').set(authHeader(aluno)).send({ characterId: 'fp-test-1', inviteMethod: 'whatsapp' })).status).toBe(200);
  });

  it('matriz vinda do cliente é normalizada contra o catálogo', async () => {
    const admin = await loginAs('admin');
    const r = await request(app).put('/api/admin/acessos').set(authHeader(admin)).send({
      matriz: { ranking: { external: 0, papelInventado: false }, funcionalidadeInventada: { therapist: false } },
      mensagemCadeado: 'x'.repeat(2000),
    });
    expect(r.body.matriz.ranking).toEqual({ therapist: true, external: false, visitor: true });
    expect(r.body.matriz.funcionalidadeInventada).toBeUndefined();
    expect(r.body.mensagemCadeado).toHaveLength(600);
  });
});
