// Comunidade: discussões, comentários, votos, enquetes e moderação.
//
// O que este arquivo garante:
//   1. quem pode escrever (membro sim, visitante não, banido não);
//   2. o link da discussão abre SEM sessão nenhuma — é o botão compartilhar;
//   3. voto, enquete e o momento em que o resultado é revelado;
//   4. comentário aninhado em UM nível só, e o que sobra quando ele é apagado;
//   5. o selo do autor por papel, incluindo o "publicar como Associação Allos";
//   6. moderação: excluir de qualquer um, banir por dias e purgar publicações.
const { app, request, resetData, loginAs, loginVisitor, authHeader, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');
const comunidade = require('../server/comunidade');

function escreverUsuarios(extra = []) {
  const p = path.join(DATA_DIR, 'users.json');
  const users = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.writeFileSync(p, JSON.stringify([...users, ...extra], null, 2));
}

// A suite base não tem 'evaluator' nem 'external'; a Comunidade trata os dois
// de forma diferente (selo Recruiter vs. sem selo), então precisam existir.
const HASH = require('bcryptjs').hashSync('testpass1234', 4);
function conta(id, username, name, role) {
  return { id, username, name, role, teacherId: null, passwordHash: HASH,
    gender: '', email: '', profilePhoto: '', updateAllOS: false, updateAllos: false };
}

async function criarDiscussao(token, body) {
  return request(app).post('/api/comunidade').set(authHeader(token)).send(body);
}

beforeEach(() => {
  resetData();
  escreverUsuarios([
    conta('6', 'recruta', 'Rita Recruta', 'evaluator'),
    conta('7', 'externo', 'Edu Externo', 'external'),
  ]);
});

describe('permissão de escrita', () => {
  test('aluno cria discussão; visitante não', async () => {
    const aluno = await loginAs('aluno');
    const ok = await criarDiscussao(aluno, { title: 'Como vocês conduzem a primeira sessão?', body: 'Queria trocar ideia sobre o setting inicial.' });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('1');
    expect(ok.body.author).toMatchObject({ kind: 'member', name: 'Aluno A' });

    const visitante = await loginVisitor();
    const negado = await criarDiscussao(visitante, { title: 'Oi gente', body: 'Testando' });
    expect(negado.status).toBe(403);
    expect(negado.body.error).toMatch(/Crie uma conta/);
  });

  test('feed diz ao visitante por que ele não pode postar', async () => {
    const visitante = await loginVisitor();
    const res = await request(app).get('/api/comunidade').set(authHeader(visitante));
    expect(res.status).toBe(200);
    expect(res.body.canPost).toBe(false);
    expect(res.body.blockedReason).toMatch(/Crie uma conta/);
  });

  test('discussão sem corpo e sem enquete é recusada', async () => {
    const aluno = await loginAs('aluno');
    const res = await criarDiscussao(aluno, { title: 'Só o título' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conteúdo|enquete/i);
  });
});

describe('link público da discussão', () => {
  test('abre sem token nenhum, com banner de leitura e sem botões', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Supervisão em grupo', body: 'Alguém já fez?' });

    const res = await request(app).get('/api/comunidade/1'); // sem Authorization
    expect(res.status).toBe(200);
    expect(res.body.anonymous).toBe(true);
    expect(res.body.canPost).toBe(false);
    expect(res.body.canModerate).toBe(false);
    expect(res.body.discussion.title).toBe('Supervisão em grupo');
    expect(res.body.discussion.myVote).toBe(0);
  });

  test('leitor anônimo não recebe o id da conta de quem escreveu', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Uma discussão', body: 'texto' });
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(aluno)).send({ body: 'comentei' });

    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.author.userId).toBeNull();
    expect(anon.body.discussion.comments[0].author.userId).toBeNull();
    // Quem tem sessão continua recebendo — é o que liga o botão "excluir".
    const logado = await request(app).get('/api/comunidade/1').set(authHeader(aluno));
    expect(logado.body.discussion.author.userId).toBe('3');
  });

  test('enquete gigante é recusada sem ser processada opção por opção', async () => {
    const aluno = await loginAs('aluno');
    const r = await criarDiscussao(aluno, {
      title: 'Enquete absurda',
      poll: { options: Array.from({ length: 50000 }, (_, i) => `opção ${i}`) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no máximo/);
  });

  test('token inválido não derruba a leitura pública', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Título qualquer', body: 'Corpo qualquer' });
    const res = await request(app).get('/api/comunidade/1').set(authHeader('lixo.nao.e.jwt'));
    expect(res.status).toBe(200);
    expect(res.body.anonymous).toBe(true);
  });

  test('o FEED continua exigindo sessão', async () => {
    const res = await request(app).get('/api/comunidade');
    expect(res.status).toBe(401);
  });
});

describe('votos', () => {
  test('upvote, troca para downvote e desfaz', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, { title: 'Enquadre e faltas', body: 'Como vocês cobram?' });
    const votante = await loginAs('aluno2');
    const url = '/api/comunidade/1/vote';

    let r = await request(app).post(url).set(authHeader(votante)).send({ value: 1 });
    expect(r.body).toEqual({ score: 1, myVote: 1 });
    r = await request(app).post(url).set(authHeader(votante)).send({ value: -1 });
    expect(r.body).toEqual({ score: -1, myVote: -1 });
    r = await request(app).post(url).set(authHeader(votante)).send({ value: 0 });
    expect(r.body).toEqual({ score: 0, myVote: 0 });
  });

  test('valor fora de {-1,0,1} é recusado em vez de virar 0', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Título', body: 'Corpo' });
    const r = await request(app).post('/api/comunidade/1/vote').set(authHeader(aluno)).send({ value: 7 });
    expect(r.status).toBe(400);
  });
});

describe('enquete', () => {
  const ENQUETE = {
    title: 'Melhor horário para o grupo de estudos?',
    poll: { options: ['Terça 19h', 'Quinta 19h', 'Sábado 10h'] },
  };

  test('só revela o resultado depois de votar', async () => {
    const autor = await loginAs('aluno');
    const criada = await criarDiscussao(autor, ENQUETE);
    expect(criada.status).toBe(200);
    expect(criada.body.hasPoll).toBe(true);

    const outro = await loginAs('aluno2');
    let ver = await request(app).get('/api/comunidade/1').set(authHeader(outro));
    expect(ver.body.discussion.poll.revealed).toBe(false);
    expect(ver.body.discussion.poll.options[0].count).toBeUndefined();

    const votou = await request(app).post('/api/comunidade/1/poll').set(authHeader(outro)).send({ optionId: 'o2' });
    expect(votou.status).toBe(200);
    expect(votou.body.poll.revealed).toBe(true);
    expect(votou.body.poll.myVote).toBe('o2');
    expect(votou.body.poll.options.find((o) => o.id === 'o2').percent).toBe(100);
  });

  test('quem não pode votar já vê o resultado (não tem como votar depois)', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, ENQUETE);
    await request(app).post('/api/comunidade/1/poll').set(authHeader(autor)).send({ optionId: 'o1' });

    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.poll.revealed).toBe(true);
    expect(anon.body.discussion.poll.total).toBe(1);
  });

  test('voto é trocável e não soma duas vezes', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, ENQUETE);
    await request(app).post('/api/comunidade/1/poll').set(authHeader(autor)).send({ optionId: 'o1' });
    const r = await request(app).post('/api/comunidade/1/poll').set(authHeader(autor)).send({ optionId: 'o3' });
    expect(r.body.poll.total).toBe(1);
    expect(r.body.poll.myVote).toBe('o3');
  });

  test('opção inexistente é recusada; enquete com 1 opção também', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, ENQUETE);
    const r = await request(app).post('/api/comunidade/1/poll').set(authHeader(autor)).send({ optionId: 'o99' });
    expect(r.status).toBe(400);

    const curta = await criarDiscussao(autor, { title: 'Enquete torta', poll: { options: ['única'] } });
    expect(curta.status).toBe(400);
  });

  // --- Múltipla escolha ---

  const MULTI = {
    title: 'Quais temas você quer nos próximos encontros?',
    poll: { options: ['Avaliação', 'Laudo', 'Reabilitação'], multi: true },
  };

  test('opção única é o padrão; múltipla escolha só quando o autor pede', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, ENQUETE);
    const unica = await request(app).get('/api/comunidade/1').set(authHeader(autor));
    expect(unica.body.discussion.poll.multi).toBe(false);

    await criarDiscussao(autor, MULTI);
    const varias = await request(app).get('/api/comunidade/2').set(authHeader(autor));
    expect(varias.body.discussion.poll.multi).toBe(true);
  });

  test('na múltipla escolha os cliques acumulam e o clique repetido desmarca', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, MULTI);
    const votar = (token, optionId) => request(app).post('/api/comunidade/1/poll')
      .set(authHeader(token)).send({ optionId });

    await votar(autor, 'o1');
    const duas = await votar(autor, 'o3');
    expect(duas.body.poll.myVotes).toEqual(['o1', 'o3']);
    // Uma pessoa, dois votos: `total` conta PESSOAS, então as duas opções
    // marcadas ficam com 100% cada e a soma passa de 100 de propósito.
    expect(duas.body.poll.total).toBe(1);
    expect(duas.body.poll.options.find((o) => o.id === 'o1').percent).toBe(100);
    expect(duas.body.poll.options.find((o) => o.id === 'o3').percent).toBe(100);
    // Na múltipla escolha não existe "o" voto — quem lê usa myVotes.
    expect(duas.body.poll.myVote).toBeNull();

    const desmarcou = await votar(autor, 'o1');
    expect(desmarcou.body.poll.myVotes).toEqual(['o3']);
    expect(desmarcou.body.poll.total).toBe(1);
  });

  test('desmarcar a última opção devolve a pessoa ao estado de quem não votou', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, MULTI);
    const votar = (optionId) => request(app).post('/api/comunidade/1/poll')
      .set(authHeader(autor)).send({ optionId });

    await votar('o2');
    const zerou = await votar('o2');
    expect(zerou.body.poll.myVotes).toEqual([]);
    expect(zerou.body.poll.total).toBe(0);
    expect(zerou.body.poll.revealed).toBe(false);
    expect(zerou.body.poll.options[0].count).toBeUndefined();
  });

  test('percentual da múltipla escolha é sobre pessoas, não sobre marcações', async () => {
    const autor = await loginAs('aluno');
    const outro = await loginAs('aluno2');
    await criarDiscussao(autor, MULTI);
    const votar = (token, optionId) => request(app).post('/api/comunidade/1/poll')
      .set(authHeader(token)).send({ optionId });

    await votar(autor, 'o1');
    await votar(autor, 'o2');
    const r = await votar(outro, 'o1');
    expect(r.body.poll.total).toBe(2);
    expect(r.body.poll.options.find((o) => o.id === 'o1').count).toBe(2);
    expect(r.body.poll.options.find((o) => o.id === 'o1').percent).toBe(100);
    expect(r.body.poll.options.find((o) => o.id === 'o2').percent).toBe(50);
    expect(r.body.poll.options.find((o) => o.id === 'o3').percent).toBe(0);
  });

  // Enquetes criadas antes da múltipla escolha existir gravaram o voto como
  // string ("o2"); o arquivo em produção tem esses registros e não é migrado.
  test('voto gravado no formato antigo (string) continua sendo lido', async () => {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, ENQUETE);
    const p = path.join(DATA_DIR, 'comunidade.json');
    const store = JSON.parse(fs.readFileSync(p, 'utf-8'));
    store.discussions[0].poll.votes = { 'algum-id': 'o2' };
    delete store.discussions[0].poll.multi;
    fs.writeFileSync(p, JSON.stringify(store, null, 2));

    const ver = await request(app).get('/api/comunidade/1');
    expect(ver.body.discussion.poll.total).toBe(1);
    expect(ver.body.discussion.poll.multi).toBe(false);
    expect(ver.body.discussion.poll.options.find((o) => o.id === 'o2').count).toBe(1);
  });
});

describe('comentários', () => {
  async function comDiscussao() {
    const autor = await loginAs('aluno');
    await criarDiscussao(autor, { title: 'Transferência no início', body: 'Como vocês manejam?' });
    return autor;
  }

  test('responder a uma resposta reancora na raiz (um nível só)', async () => {
    const autor = await comDiscussao();
    const outro = await loginAs('aluno2');
    const url = '/api/comunidade/1/comentarios';

    const raiz = await request(app).post(url).set(authHeader(outro)).send({ body: 'Costumo nomear cedo.' });
    expect(raiz.status).toBe(200);
    const raizId = raiz.body.comments[0].id;

    const resposta = await request(app).post(url).set(authHeader(autor)).send({ body: 'Cedo demais não assusta?', parentId: raizId });
    const respostaId = resposta.body.comments[0].replies[0].id;

    // Responder à RESPOSTA: continua pendurado na mesma raiz.
    const neta = await request(app).post(url).set(authHeader(outro)).send({ body: 'Depende do vínculo.', parentId: respostaId });
    expect(neta.body.comments).toHaveLength(1);
    expect(neta.body.comments[0].replies).toHaveLength(2);
    expect(neta.body.comments[0].replies.every((r) => !r.replies)).toBe(true);
  });

  test('raízes ordenam por voto; respostas ficam cronológicas', async () => {
    const autor = await comDiscussao();
    const outro = await loginAs('aluno2');
    const url = '/api/comunidade/1/comentarios';
    const a = await request(app).post(url).set(authHeader(autor)).send({ body: 'primeiro' });
    const idA = a.body.comments[0].id;
    await request(app).post(url).set(authHeader(outro)).send({ body: 'segundo' });

    // "segundo" recebe um upvote e deve passar "primeiro".
    const lista = await request(app).get('/api/comunidade/1').set(authHeader(autor));
    const idB = lista.body.discussion.comments.find((c) => c.body === 'segundo').id;
    await request(app).post(`/api/comunidade/1/comentarios/${idB}/vote`).set(authHeader(autor)).send({ value: 1 });

    const depois = await request(app).get('/api/comunidade/1').set(authHeader(autor));
    expect(depois.body.discussion.comments.map((c) => c.body)).toEqual(['segundo', 'primeiro']);
    expect(depois.body.discussion.comments[1].id).toBe(idA);
  });

  test('apagar comentário com resposta vira lápide; sem resposta some da tela', async () => {
    const autor = await comDiscussao();
    const outro = await loginAs('aluno2');
    const url = '/api/comunidade/1/comentarios';

    const raiz = await request(app).post(url).set(authHeader(outro)).send({ body: 'com resposta' });
    const raizId = raiz.body.comments[0].id;
    await request(app).post(url).set(authHeader(autor)).send({ body: 'a resposta', parentId: raizId });
    const solto = await request(app).post(url).set(authHeader(outro)).send({ body: 'sem resposta' });
    const soltoId = solto.body.comments.find((c) => c.body === 'sem resposta').id;

    await request(app).delete(`/api/comunidade/1/comentarios/${raizId}`).set(authHeader(outro)).expect(200);
    await request(app).delete(`/api/comunidade/1/comentarios/${soltoId}`).set(authHeader(outro)).expect(200);

    const res = await request(app).get('/api/comunidade/1').set(authHeader(autor));
    const raizes = res.body.discussion.comments;
    expect(raizes).toHaveLength(1);
    expect(raizes[0].deleted).toBe(true);
    expect(raizes[0].body).toBe('');
    expect(raizes[0].author).toBeNull();
    expect(raizes[0].replies[0].body).toBe('a resposta');
  });

  test('ninguém apaga comentário de outro (a não ser o admin)', async () => {
    const autor = await comDiscussao();
    const outro = await loginAs('aluno2');
    const c = await request(app).post('/api/comunidade/1/comentarios').set(authHeader(outro)).send({ body: 'meu texto' });
    const cid = c.body.comments[0].id;

    await request(app).delete(`/api/comunidade/1/comentarios/${cid}`).set(authHeader(autor)).expect(403);
    const admin = await loginAs('admin');
    await request(app).delete(`/api/comunidade/1/comentarios/${cid}`).set(authHeader(admin)).expect(200);
  });

  test('comentar avisa o dono da discussão, e não a si mesmo', async () => {
    const autor = await comDiscussao();
    const outro = await loginAs('aluno2');
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(outro)).send({ body: 'oi' });
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(autor)).send({ body: 'eu mesmo' });

    const doAutor = await request(app).get('/api/notifications').set(authHeader(autor));
    const relevantes = doAutor.body.items.filter((n) => n.type === 'comunidade_reply');
    expect(relevantes).toHaveLength(1);
    expect(relevantes[0].discussionId).toBe('1');

    const doOutro = await request(app).get('/api/notifications').set(authHeader(outro));
    expect(doOutro.body.items.filter((n) => n.type === 'comunidade_reply')).toHaveLength(0);
  });
});

describe('fixar discussão', () => {
  async function tresPosts() {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Primeira', body: 'texto da primeira' });
    await criarDiscussao(aluno, { title: 'Segunda', body: 'texto da segunda' });
    await criarDiscussao(aluno, { title: 'Terceira', body: 'texto da terceira' });
    return aluno;
  }
  const fixar = (token, id, pinned = true) => request(app)
    .post(`/api/comunidade/${id}/pin`).set(authHeader(token)).send({ pinned });
  const feed = (token, sort) => request(app)
    .get(`/api/comunidade${sort ? `?sort=${sort}` : ''}`).set(authHeader(token));

  test('só admin fixa', async () => {
    const aluno = await tresPosts();
    expect((await fixar(aluno, '1')).status).toBe(403);
    const prof = await loginAs('prof');
    expect((await fixar(prof, '1')).status).toBe(403);
    const admin = await loginAs('admin');
    expect((await fixar(admin, '1')).status).toBe(200);
  });

  test('em "Recentes" a fixada sobe ao topo, mesmo sendo a mais antiga', async () => {
    const aluno = await tresPosts();
    // Sem fixar: ordem é a cronológica invertida.
    let r = await feed(aluno);
    expect(r.body.discussions.map((d) => d.title)).toEqual(['Terceira', 'Segunda', 'Primeira']);

    const admin = await loginAs('admin');
    await fixar(admin, '1'); // "Primeira", a mais antiga
    r = await feed(aluno);
    expect(r.body.discussions.map((d) => d.title)).toEqual(['Primeira', 'Terceira', 'Segunda']);
    expect(r.body.discussions[0].pinned).toBe(true);
    expect(r.body.discussions[1].pinned).toBe(false);
  });

  // O ponto do recurso: "Em alta" é um placar da comunidade, e fixar não
  // planta nada no topo dele.
  test('em "Em alta" fixar NÃO muda a ordem', async () => {
    const aluno = await tresPosts();
    const outro = await loginAs('aluno2');
    // Dá voto pra "Terceira" ficar em alta; "Primeira" (que vamos fixar) não
    // tem voto nenhum.
    await request(app).post('/api/comunidade/3/vote').set(authHeader(outro)).send({ value: 1 });

    const antes = (await feed(aluno, 'top')).body.discussions.map((d) => d.title);
    const admin = await loginAs('admin');
    await fixar(admin, '1');
    const depois = (await feed(aluno, 'top')).body.discussions.map((d) => d.title);
    expect(depois).toEqual(antes);
    expect(depois[0]).toBe('Terceira');
    // O selo continua vindo (é propriedade do post), só não reordena.
    expect(depois.indexOf('Primeira')).toBeGreaterThan(0);
    const primeira = (await feed(aluno, 'top')).body.discussions.find((d) => d.title === 'Primeira');
    expect(primeira.pinned).toBe(true);
  });

  test('desfixar devolve a ordem cronológica', async () => {
    const aluno = await tresPosts();
    const admin = await loginAs('admin');
    await fixar(admin, '1');
    await fixar(admin, '1', false);
    const r = await feed(aluno);
    expect(r.body.discussions.map((d) => d.title)).toEqual(['Terceira', 'Segunda', 'Primeira']);
    expect(r.body.discussions.every((d) => d.pinned === false)).toBe(true);
  });

  test('entre várias fixadas, a fixada mais recentemente fica em cima', async () => {
    const aluno = await tresPosts();
    const admin = await loginAs('admin');
    await fixar(admin, '1');
    await new Promise((r) => setTimeout(r, 5)); // pinnedAt tem resolução de ms
    await fixar(admin, '2');
    const r = await feed(aluno);
    expect(r.body.discussions.map((d) => d.title)).toEqual(['Segunda', 'Primeira', 'Terceira']);
  });

  test('a discussão avulsa (e o link público) diz se está fixada', async () => {
    await tresPosts();
    const admin = await loginAs('admin');
    await fixar(admin, '1');
    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.pinned).toBe(true);
    const outra = await request(app).get('/api/comunidade/2');
    expect(outra.body.discussion.pinned).toBe(false);
  });

  test('fixar discussão que não existe é 404', async () => {
    const admin = await loginAs('admin');
    expect((await fixar(admin, '999')).status).toBe(404);
  });

  test('o feed diz ao admin que ele pode moderar (governa o botão)', async () => {
    await tresPosts();
    const admin = await loginAs('admin');
    expect((await feed(admin)).body.canModerate).toBe(true);
    const aluno = await loginAs('aluno');
    expect((await feed(aluno)).body.canModerate).toBe(false);
  });
});

describe('editar discussão (admin)', () => {
  async function umPost(extra = {}) {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Título original', body: 'Texto original.', ...extra });
    return aluno;
  }
  const editar = (token, id, body) => request(app)
    .put(`/api/comunidade/${id}`).set(authHeader(token)).send(body);

  test('só admin edita — nem o próprio autor', async () => {
    const aluno = await umPost();
    expect((await editar(aluno, '1', { title: 'Novo título', body: 'Novo texto.' })).status).toBe(403);
    const prof = await loginAs('prof');
    expect((await editar(prof, '1', { title: 'Novo título', body: 'Novo texto.' })).status).toBe(403);
    const admin = await loginAs('admin');
    expect((await editar(admin, '1', { title: 'Novo título', body: 'Novo texto.' })).status).toBe(200);
  });

  test('salva título e texto e marca como editado', async () => {
    await umPost();
    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'Título corrigido', body: 'Texto corrigido.' });
    expect(r.body.title).toBe('Título corrigido');
    expect(r.body.body).toBe('Texto corrigido.');
    expect(typeof r.body.editedAt).toBe('string');

    // A marca chega ao feed e ao link público — a edição não é silenciosa.
    const feed = await request(app).get('/api/comunidade').set(authHeader(admin));
    expect(feed.body.discussions[0].editedAt).toBeTruthy();
    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.editedAt).toBeTruthy();
  });

  test('editar NÃO troca o autor da discussão', async () => {
    await umPost();
    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'Mexido pelo admin', body: 'Texto novo.' });
    // Continua assinada por quem escreveu: editar é correção, não apropriação.
    expect(r.body.author.name).toBe('Aluno A');
    expect(r.body.author.kind).toBe('member');
  });

  test('salvar sem mudar nada não marca como editado', async () => {
    await umPost();
    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'Título original', body: 'Texto original.' });
    expect(r.status).toBe(200);
    expect(r.body.editedAt).toBeNull();
  });

  test('título curto é recusado', async () => {
    await umPost();
    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'ab', body: 'Texto qualquer.' });
    expect(r.status).toBe(400);
  });

  test('sem enquete, texto vazio é recusado; com enquete, é aceito', async () => {
    await umPost();
    const admin = await loginAs('admin');
    expect((await editar(admin, '1', { title: 'Título bom', body: '' })).status).toBe(400);

    // Discussão 2: só enquete, sem corpo — editar pode deixar o corpo vazio.
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Qual horário?', poll: { options: ['Terça', 'Quinta'] } });
    const r = await editar(admin, '2', { title: 'Qual horário mesmo?', body: '' });
    expect(r.status).toBe(200);
    expect(r.body.title).toBe('Qual horário mesmo?');
  });

  test('a enquete e os votos sobrevivem intactos à edição', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Qual horário?', poll: { options: ['Terça', 'Quinta'] } });
    await request(app).post('/api/comunidade/1/poll').set(authHeader(aluno)).send({ optionId: 'o1' });

    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'Qual horário afinal?', body: 'Contexto novo.' });
    expect(r.body.poll.options.map((o) => o.text)).toEqual(['Terça', 'Quinta']);
    expect(r.body.poll.total).toBe(1);
  });

  test('comentários e votos da discussão sobrevivem à edição', async () => {
    const aluno = await umPost();
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(aluno)).send({ body: 'um comentário' });
    await request(app).post('/api/comunidade/1/vote').set(authHeader(aluno)).send({ value: 1 });

    const admin = await loginAs('admin');
    const r = await editar(admin, '1', { title: 'Outro título', body: 'Outro texto.' });
    expect(r.body.comments).toHaveLength(1);
    expect(r.body.score).toBe(1);
  });

  test('editar discussão inexistente é 404', async () => {
    const admin = await loginAs('admin');
    expect((await editar(admin, '999', { title: 'Qualquer', body: 'Coisa.' })).status).toBe(404);
  });
});

describe('selo do autor', () => {
  test('cada papel recebe o seu kind e subtítulo', async () => {
    const casos = [
      ['prof', 'supervisor', 'Supervisor da Allos'],
      ['recruta', 'recruiter', 'Recruiter da Allos'],
      ['externo', 'external', ''],
      ['aluno', 'member', ''],
    ];
    for (const [username, kind, subtitle] of casos) {
      const token = await loginAs(username);
      const r = await criarDiscussao(token, { title: `Post de ${username}`, body: 'conteúdo' });
      expect(r.status).toBe(200);
      expect(r.body.author.kind).toBe(kind);
      expect(r.body.author.subtitle).toBe(subtitle);
    }
  });

  // A etiqueta que aparece ao passar o mouse no avatar/nome usa `roleLabel`, não
  // o `kind`: o kind é visual e agrupa (admin e aluno da Allos são os dois
  // `member`), então só ele não distinguiria os dois na etiqueta.
  test('roleLabel distingue papéis que o kind agrupa', async () => {
    const casos = [
      ['admin', 'member', 'Administrador'],
      ['aluno', 'member', 'Aluno da Allos'],
      ['prof', 'supervisor', 'Supervisor da Allos'],
      ['recruta', 'recruiter', 'Recruiter da Allos'],
      ['externo', 'external', 'Aluno Externo'],
    ];
    for (const [username, kind, roleLabel] of casos) {
      const token = await loginAs(username);
      const r = await criarDiscussao(token, { title: `Post de ${username}`, body: 'conteúdo' });
      expect(r.status).toBe(200);
      expect(r.body.author.kind).toBe(kind);
      expect(r.body.author.roleLabel).toBe(roleLabel);
    }
  });

  test('publicação institucional etiqueta a Associação, não o papel de quem digitou', async () => {
    const admin = await loginAs('admin');
    const inst = await criarDiscussao(admin, { title: 'Aviso', body: 'Comunicado.', asInstitution: true });
    expect(inst.body.author.roleLabel).toBe('Associação Allos');
  });

  test('a etiqueta chega no comentário e no link público da discussão', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Uma dúvida', body: 'conteúdo' });
    const prof = await loginAs('prof');
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(prof))
      .send({ body: 'respondendo' }).expect(200);

    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.author.roleLabel).toBe('Aluno da Allos');
    expect(anon.body.discussion.comments[0].author.roleLabel).toBe('Supervisor da Allos');
  });

  test('admin escolhe publicar como Associação Allos ou como pessoa', async () => {
    const admin = await loginAs('admin');
    const inst = await criarDiscussao(admin, { title: 'Aviso institucional', body: 'Comunicado.', asInstitution: true });
    expect(inst.body.author).toMatchObject({ kind: 'allos', name: 'Associação Allos' });
    // Publicação institucional não entrega qual admin escreveu.
    expect(inst.body.author.userId).toBeNull();

    const pessoal = await criarDiscussao(admin, { title: 'Papo solto', body: 'Como pessoa mesmo.' });
    expect(pessoal.body.author).toMatchObject({ kind: 'member', name: 'Admin' });
  });

  test('não-admin não consegue se passar pela Associação Allos', async () => {
    const aluno = await loginAs('aluno');
    const r = await criarDiscussao(aluno, { title: 'Tentativa', body: 'texto', asInstitution: true });
    expect(r.body.author.kind).toBe('member');
    expect(r.body.author.name).toBe('Aluno A');
  });

  test('excluir a conta apaga a identidade de quem escreveu', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Escrito por alguém que sai', body: 'o texto fica' });
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(aluno)).send({ body: 'comentário dele' });

    await request(app).delete('/api/me').set(authHeader(aluno))
      .send({ password: 'testpass1234' }).expect(200);

    const res = await request(app).get('/api/comunidade/1');
    // O conteúdo continua legível; a pessoa, não identificável.
    expect(res.body.discussion.title).toBe('Escrito por alguém que sai');
    expect(res.body.discussion.author.name).toBe('Conta removida');
    expect(res.body.discussion.author.photo).toBeNull();
    expect(res.body.discussion.author.userId).toBeNull();
    expect(res.body.discussion.comments[0].author.name).toBe('Conta removida');
    // E nome/foto nunca chegaram sequer ao arquivo em disco.
    const bruto = fs.readFileSync(path.join(DATA_DIR, 'comunidade.json'), 'utf-8');
    expect(bruto).not.toContain('Aluno A');
  });

  test('o selo acompanha o papel ATUAL da conta', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Escrito como aluno', body: 'texto' });
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/users/3').set(authHeader(admin))
      .send({ role: 'supervisor' }).expect(200);

    const res = await request(app).get('/api/comunidade/1');
    expect(res.body.discussion.author.kind).toBe('supervisor');
  });
});

describe('moderação', () => {
  test('admin exclui discussão de qualquer um; o autor exclui a própria', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Uma', body: 'texto' });
    await criarDiscussao(aluno, { title: 'Duas', body: 'texto' });

    const outro = await loginAs('aluno2');
    await request(app).delete('/api/comunidade/1').set(authHeader(outro)).expect(403);
    await request(app).delete('/api/comunidade/1').set(authHeader(aluno)).expect(200);

    const admin = await loginAs('admin');
    await request(app).delete('/api/comunidade/2').set(authHeader(admin)).expect(200);
    const feed = await request(app).get('/api/comunidade').set(authHeader(admin));
    expect(feed.body.discussions).toHaveLength(0);
  });

  test('banimento bloqueia a escrita mas não a leitura, e expira sozinho', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Antes do ban', body: 'texto' });
    const admin = await loginAs('admin');

    const ban = await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin))
      .send({ userId: '3', days: 7, reason: 'spam' });
    expect(ban.status).toBe(200);

    const bloqueado = await criarDiscussao(aluno, { title: 'Durante o ban', body: 'texto' });
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.body.error).toMatch(/suspensa até/);
    await request(app).post('/api/comunidade/1/vote').set(authHeader(aluno)).send({ value: 1 }).expect(403);

    const leitura = await request(app).get('/api/comunidade/1').set(authHeader(aluno));
    expect(leitura.status).toBe(200);
    expect(leitura.body.canPost).toBe(false);

    // Ban vencido simplesmente para de valer — sem rotina de limpeza.
    const cfgPath = path.join(DATA_DIR, 'comunidade-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.bans['3'].until = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const liberado = await criarDiscussao(aluno, { title: 'Depois do ban', body: 'texto' });
    expect(liberado.status).toBe(200);
  });

  test('desbanir devolve a escrita', async () => {
    const aluno = await loginAs('aluno');
    const admin = await loginAs('admin');
    await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin)).send({ userId: '3', days: 30 });
    await request(app).delete('/api/admin/comunidade/ban/3').set(authHeader(admin)).expect(200);
    const r = await criarDiscussao(aluno, { title: 'Voltei', body: 'texto' });
    expect(r.status).toBe(200);
  });

  test('banir com purge apaga tudo do usuário; comentário vira lápide', async () => {
    const aluno = await loginAs('aluno');
    const outro = await loginAs('aluno2');
    await criarDiscussao(aluno, { title: 'Spam 1', body: 'compre já' });
    await criarDiscussao(outro, { title: 'Legítima', body: 'conteúdo real' });
    await request(app).post('/api/comunidade/2/comentarios').set(authHeader(aluno)).send({ body: 'spam no comentário' });

    const admin = await loginAs('admin');
    const r = await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin))
      .send({ userId: '3', days: 30, purge: true });
    expect(r.body.removidos).toBe(2);

    const feed = await request(app).get('/api/comunidade').set(authHeader(admin));
    expect(feed.body.discussions.map((d) => d.title)).toEqual(['Legítima']);
    const detalhe = await request(app).get('/api/comunidade/2').set(authHeader(admin));
    expect(detalhe.body.discussion.comments).toHaveLength(0);
  });

  test('purga seletiva apaga só as discussões escolhidas', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Fica', body: 'texto' });
    await criarDiscussao(aluno, { title: 'Sai', body: 'texto' });
    const admin = await loginAs('admin');
    const r = await request(app).post('/api/admin/comunidade/purgar').set(authHeader(admin))
      .send({ userId: '3', discussionIds: ['2'] });
    expect(r.body.removidos).toBe(1);
    const feed = await request(app).get('/api/comunidade').set(authHeader(admin));
    expect(feed.body.discussions.map((d) => d.title)).toEqual(['Fica']);
  });

  test('não dá pra banir administrador', async () => {
    const admin = await loginAs('admin');
    const r = await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin)).send({ userId: '1', days: 5 });
    expect(r.status).toBe(400);
  });

  test('duração de ban precisa ser um número de dias válido', async () => {
    const admin = await loginAs('admin');
    for (const days of [0, -3, 99999, 'muitos']) {
      const r = await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin)).send({ userId: '3', days });
      expect(r.status).toBe(400);
    }
  });

  test('o painel do admin é fechado para os outros papéis', async () => {
    for (const username of ['aluno', 'prof', 'recruta', 'externo']) {
      const token = await loginAs(username);
      await request(app).get('/api/admin/comunidade').set(authHeader(token)).expect(403);
      await request(app).post('/api/admin/comunidade/ban').set(authHeader(token))
        .send({ userId: '5', days: 3 }).expect(403);
    }
  });

  test('painel lista autores com contagem e ban vigente', async () => {
    const aluno = await loginAs('aluno');
    await criarDiscussao(aluno, { title: 'Uma', body: 'texto' });
    await request(app).post('/api/comunidade/1/comentarios').set(authHeader(aluno)).send({ body: 'me respondendo' });
    const admin = await loginAs('admin');
    await request(app).post('/api/admin/comunidade/ban').set(authHeader(admin)).send({ userId: '3', days: 2, reason: 'flood' });

    const res = await request(app).get('/api/admin/comunidade').set(authHeader(admin));
    const autor = res.body.autores.find((a) => a.id === '3');
    expect(autor).toMatchObject({ name: 'Aluno A', discussions: 1, comments: 1 });
    expect(autor.ban.reason).toBe('flood');
    expect(res.body.bans).toHaveLength(1);
  });

});

describe('projeções puras (server/comunidade.js)', () => {
  test('score ignora valores estranhos no mapa de votos', () => {
    expect(comunidade.score({ a: 1, b: -1, c: 1, d: 'x', e: 0 })).toBe(1);
  });

  test('feed "top" prioriza a janela de 7 dias antes do placar', () => {
    const hoje = new Date().toISOString();
    const antigo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const lista = [
      { id: 'velha', createdAt: antigo, votes: { a: 1, b: 1, c: 1 } },
      { id: 'nova', createdAt: hoje, votes: { a: 1 } },
    ];
    expect(comunidade.ordenarFeed(lista, 'top').map((d) => d.id)).toEqual(['nova', 'velha']);
    expect(comunidade.ordenarFeed(lista, 'recent').map((d) => d.id)).toEqual(['nova', 'velha']);
  });
});
