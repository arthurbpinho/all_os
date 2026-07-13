// Antessala (pré-supervisão) — CRUD, congelamento na entrega, escopo do
// supervisor por teacherId e travas de permissão. A camada de reflexão roda em
// modo demo (sem chave de IA), então só verificamos o 503 gracioso.

const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

const sampleDoc = () => ({
  titulo: 'O peso invisível',
  business: 'Ajudar a paciente a distinguir o que ela quer do que esperam dela.',
  fatos: [
    { id: 'f1', texto: 'A mãe controla as decisões', centralidade: 5 },
    { id: 'f2', texto: 'Vergonha ao falar de si', centralidade: 4 },
  ],
  relacoes: [{ id: 'r1', origem: 'f1', destino: 'f2', descricao: 'alimenta' }],
  variacoes: [{ id: 'v1', fatoId: 'f1', texto: 'Investigar a infância' }],
  pitfalls: [{ id: 'p1', variacaoId: 'v1', texto: 'Perder o presente de vista', flagged: false }],
  conceitos: [{ id: 'c1', fatoId: 'f1', texto: 'Complexo materno', tipo: 'Jung' }],
  direcoes: [{ id: 'd1', texto: 'Manter o vínculo estável' }],
});

describe('Antessala — pré-supervisão', () => {
  beforeEach(() => resetData());

  it('aluno cria, lê, edita e o mapa persiste', async () => {
    const token = await loginAs('aluno');
    const create = await request(app).post('/api/antessala').set(authHeader(token)).send(sampleDoc());
    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();
    expect(create.body.status).toBe('draft');
    expect(create.body.ownerName).toBe('Aluno A');
    const id = create.body.id;

    const list = await request(app).get('/api/antessala').set(authHeader(token));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].titulo).toBe('O peso invisível');
    expect(list.body[0].fatosCount).toBe(2);

    const upd = await request(app).put(`/api/antessala/${id}`).set(authHeader(token))
      .send({ ...sampleDoc(), titulo: 'Novo título' });
    expect(upd.status).toBe(200);
    expect(upd.body.titulo).toBe('Novo título');

    const get = await request(app).get(`/api/antessala/${id}`).set(authHeader(token));
    expect(get.status).toBe(200);
    expect(get.body.fatos.length).toBe(2);
    expect(get.body.variacoes.length).toBe(1);
  });

  it('descarta referências órfãs na sanitização', async () => {
    const token = await loginAs('aluno');
    const bad = {
      titulo: 'x',
      fatos: [{ id: 'f1', texto: 'a', centralidade: 9 }], // centralidade fora da faixa → clamp 5
      variacoes: [
        { id: 'v1', fatoId: 'f1', texto: 'ok' },
        { id: 'v2', fatoId: 'inexistente', texto: 'orfã' }, // deve sumir
      ],
      relacoes: [{ id: 'r1', origem: 'f1', destino: 'zzz', descricao: 'x' }], // destino inválido → some
    };
    const create = await request(app).post('/api/antessala').set(authHeader(token)).send(bad);
    expect(create.status).toBe(201);
    expect(create.body.fatos[0].centralidade).toBe(5);
    expect(create.body.variacoes.length).toBe(1);
    expect(create.body.relacoes.length).toBe(0);
  });

  it('entregar congela: PUT vira 409 e delete pelo dono vira 409', async () => {
    const token = await loginAs('aluno');
    const create = await request(app).post('/api/antessala').set(authHeader(token)).send(sampleDoc());
    const id = create.body.id;

    const deliver = await request(app).post(`/api/antessala/${id}/deliver`).set(authHeader(token)).send({});
    expect(deliver.status).toBe(200);
    expect(deliver.body.status).toBe('delivered');
    expect(deliver.body.deliveredAt).toBeTruthy();

    const upd = await request(app).put(`/api/antessala/${id}`).set(authHeader(token)).send(sampleDoc());
    expect(upd.status).toBe(409);

    const del = await request(app).delete(`/api/antessala/${id}`).set(authHeader(token));
    expect(del.status).toBe(409);

    // Entregar de novo é idempotente.
    const deliver2 = await request(app).post(`/api/antessala/${id}/deliver`).set(authHeader(token)).send({});
    expect(deliver2.status).toBe(200);
  });

  it('supervisor só vê mapas ENTREGUES dos seus alunos', async () => {
    const alunoTok = await loginAs('aluno');   // teacherId '2' (prof)
    const aluno2Tok = await loginAs('aluno2');  // teacherId '4' (prof2)

    const c1 = await request(app).post('/api/antessala').set(authHeader(alunoTok)).send(sampleDoc());
    const c2 = await request(app).post('/api/antessala').set(authHeader(aluno2Tok)).send(sampleDoc());

    const profTok = await loginAs('prof');
    // Antes de entregar: prof não vê nada.
    let sup = await request(app).get('/api/antessala/supervisor').set(authHeader(profTok));
    expect(sup.status).toBe(200);
    expect(sup.body.length).toBe(0);

    // Aluno do prof entrega; aluno2 (de prof2) também.
    await request(app).post(`/api/antessala/${c1.body.id}/deliver`).set(authHeader(alunoTok)).send({});
    await request(app).post(`/api/antessala/${c2.body.id}/deliver`).set(authHeader(aluno2Tok)).send({});

    sup = await request(app).get('/api/antessala/supervisor').set(authHeader(profTok));
    expect(sup.body.length).toBe(1);
    expect(sup.body[0].ownerName).toBe('Aluno A');

    // prof pode abrir o entregue do seu aluno...
    const ok = await request(app).get(`/api/antessala/${c1.body.id}`).set(authHeader(profTok));
    expect(ok.status).toBe(200);
    // ...mas não o do aluno de outro professor.
    const nope = await request(app).get(`/api/antessala/${c2.body.id}`).set(authHeader(profTok));
    expect(nope.status).toBe(403);
  });

  it('admin vê todos os entregues e pode excluir', async () => {
    const alunoTok = await loginAs('aluno');
    const c = await request(app).post('/api/antessala').set(authHeader(alunoTok)).send(sampleDoc());
    await request(app).post(`/api/antessala/${c.body.id}/deliver`).set(authHeader(alunoTok)).send({});

    const adminTok = await loginAs('admin');
    const sup = await request(app).get('/api/antessala/supervisor').set(authHeader(adminTok));
    expect(sup.body.length).toBe(1);
    // Admin pode excluir até um entregue.
    const del = await request(app).delete(`/api/antessala/${c.body.id}`).set(authHeader(adminTok));
    expect(del.status).toBe(200);
  });

  it('nega escrita a supervisor e a visitante', async () => {
    const profTok = await loginAs('prof');
    const asSup = await request(app).post('/api/antessala').set(authHeader(profTok)).send(sampleDoc());
    expect(asSup.status).toBe(403);

    const visTok = await loginVisitor();
    const asVis = await request(app).post('/api/antessala').set(authHeader(visTok)).send(sampleDoc());
    expect(asVis.status).toBe(403);

    // Aluno não vê a lista do supervisor.
    const alunoTok = await loginAs('aluno');
    const asAluno = await request(app).get('/api/antessala/supervisor').set(authHeader(alunoTok));
    expect(asAluno.status).toBe(403);
  });

  it('um aluno não abre nem edita o mapa de outro', async () => {
    const alunoTok = await loginAs('aluno');
    const c = await request(app).post('/api/antessala').set(authHeader(alunoTok)).send(sampleDoc());

    const aluno2Tok = await loginAs('aluno2');
    const get = await request(app).get(`/api/antessala/${c.body.id}`).set(authHeader(aluno2Tok));
    expect(get.status).toBe(403);
    const put = await request(app).put(`/api/antessala/${c.body.id}`).set(authHeader(aluno2Tok)).send(sampleDoc());
    expect(put.status).toBe(403);
  });

  it('reflect valida step e responde 503 sem IA configurada (modo demo)', async () => {
    const token = await loginAs('aluno');
    const bad = await request(app).post('/api/antessala/reflect').set(authHeader(token)).send({ step: 9, doc: sampleDoc() });
    expect(bad.status).toBe(400);

    const ok = await request(app).post('/api/antessala/reflect').set(authHeader(token)).send({ step: 4, doc: sampleDoc() });
    expect(ok.status).toBe(503); // sem ANTHROPIC/OPENAI key no ambiente de teste
  });
});
