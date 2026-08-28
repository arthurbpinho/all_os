// Pool de fotos padrão (Administração → Contas).
//
// O que este arquivo garante:
//   1. o CRUD da pool: sobe, lista, remove, respeita o teto de 10 e sanitiza o id;
//   2. quem não tem foto própria recebe uma foto da pool — e sempre a MESMA;
//   3. quem tem foto própria fica intocado (a pool não sobrescreve ninguém);
//   4. o visitante, que nunca vai ter foto, também entra na rotação;
//   5. a foto da pool NÃO vaza para o campo que o Perfil grava de volta;
//   6. as telas de leitura (ranking, comunidade) já saem com a foto resolvida.
const { app, request, resetData, loginAs, loginVisitor, authHeader, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');
const avatarPool = require('../server/avatar-pool');

// PNG minúsculo: o servidor não decodifica imagem, só grava os bytes.
const PNG = 'data:image/png;base64,' + Buffer.from('x'.repeat(40)).toString('base64');

async function subir(admin, n = 1) {
  let r;
  for (let i = 0; i < n; i++) {
    r = await request(app).post('/api/admin/avatar-pool').set(authHeader(admin)).send({ image: PNG });
    expect(r.status).toBe(200);
  }
  return r.body.photos;
}

beforeEach(() => resetData());

describe('CRUD da pool', () => {
  test('sobe, lista e remove', async () => {
    const admin = await loginAs('admin');
    const vazia = await request(app).get('/api/admin/avatar-pool').set(authHeader(admin));
    expect(vazia.body.photos).toEqual([]);
    expect(vazia.body.max).toBe(avatarPool.MAX_FOTOS);

    const fotos = await subir(admin, 2);
    expect(fotos).toHaveLength(2);
    // Os bytes vão pro volume (DATA_DIR), não pro repo.
    expect(fs.existsSync(path.join(DATA_DIR, 'avatar-pool', `${fotos[0].id}.jpg`))).toBe(true);
    expect(fotos[0].url).toBe(`/avatar-pool/${fotos[0].id}.jpg`);

    const removeu = await request(app).delete(`/api/admin/avatar-pool/${fotos[0].id}`).set(authHeader(admin));
    expect(removeu.status).toBe(200);
    expect(removeu.body.photos).toHaveLength(1);
    expect(fs.existsSync(path.join(DATA_DIR, 'avatar-pool', `${fotos[0].id}.jpg`))).toBe(false);
  });

  test('teto de 10 fotos', async () => {
    const admin = await loginAs('admin');
    await subir(admin, avatarPool.MAX_FOTOS);
    const cheio = await request(app).post('/api/admin/avatar-pool').set(authHeader(admin)).send({ image: PNG });
    expect(cheio.status).toBe(400);
    expect(cheio.body.error).toMatch(/máximo/i);
  });

  test('id da URL é sanitizado (não dá unlink fora da pasta)', async () => {
    const admin = await loginAs('admin');
    const travessia = await request(app).delete('/api/admin/avatar-pool/..%2F..%2Fusers').set(authHeader(admin));
    expect(travessia.status).toBe(400);
    expect(fs.existsSync(path.join(DATA_DIR, 'users.json'))).toBe(true);
  });

  test('só admin mexe na pool', async () => {
    const aluno = await loginAs('aluno');
    const post = await request(app).post('/api/admin/avatar-pool').set(authHeader(aluno)).send({ image: PNG });
    expect(post.status).toBe(403);
    const get = await request(app).get('/api/admin/avatar-pool').set(authHeader(aluno));
    expect(get.status).toBe(403);
  });

  test('imagem que não é data URL de imagem é recusada', async () => {
    const admin = await loginAs('admin');
    const r = await request(app).post('/api/admin/avatar-pool').set(authHeader(admin))
      .send({ image: 'https://exemplo.com/foto.jpg' });
    expect(r.status).toBe(400);
  });
});

describe('quem recebe a foto padrão', () => {
  test('sem pool, ninguém ganha defaultPhoto (a tela cai na silhueta)', async () => {
    const aluno = await loginAs('aluno');
    const me = await request(app).get('/api/me').set(authHeader(aluno));
    expect(me.body.user.defaultPhoto).toBeUndefined();
  });

  test('quem não tem foto própria recebe uma da pool, sempre a mesma', async () => {
    const admin = await loginAs('admin');
    const fotos = await subir(admin, 3);
    const urls = fotos.map((f) => f.url);

    const aluno = await loginAs('aluno');
    const primeira = await request(app).get('/api/me').set(authHeader(aluno));
    expect(urls).toContain(primeira.body.user.defaultPhoto);

    // Estável: a mesma conta cai sempre na mesma imagem. Um sorteio por
    // requisição trocaria o rosto entre uma tela e outra.
    const segunda = await request(app).get('/api/me').set(authHeader(aluno));
    expect(segunda.body.user.defaultPhoto).toBe(primeira.body.user.defaultPhoto);
  });

  test('a pool NÃO sobrescreve profilePhoto (é o que o Perfil grava de volta)', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 2);
    const aluno = await loginAs('aluno');
    const me = await request(app).get('/api/me').set(authHeader(aluno));
    // O campo gravado na conta sai intocado — vazio segue vazio. É ele que o
    // Perfil manda de volta no PUT, e uma URL da pool ali viraria foto própria.
    expect(me.body.user.profilePhoto).toBe('');
    expect(me.body.user.defaultPhoto).toMatch(/^\/avatar-pool\//);
  });

  // Caso real da base: a migração one-shot padronizou TODA conta em
  // isaacdeterno.jpeg, então "ainda não colocou foto" na prática é essa foto.
  test('a foto de fábrica (Isaac) conta como "sem foto própria"', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 3);
    const aluno = await loginAs('aluno');
    const eu = await request(app).get('/api/me').set(authHeader(aluno));
    await request(app).put(`/api/users/${eu.body.user.id}`).set(authHeader(aluno))
      .send({ profilePhoto: '/profiles_icon/isaacdeterno.jpeg' }).expect(200);

    const depois = await request(app).get('/api/me').set(authHeader(aluno));
    expect(depois.body.user.profilePhoto).toBe('/profiles_icon/isaacdeterno.jpeg');
    expect(depois.body.user.defaultPhoto).toMatch(/^\/avatar-pool\//);
  });

  test('quem subiu a própria foto sai da rotação', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 3);
    const aluno = await loginAs('aluno');
    const eu = await request(app).get('/api/me').set(authHeader(aluno));
    await request(app).put(`/api/users/${eu.body.user.id}`).set(authHeader(aluno))
      .send({ profilePhoto: '/patient-photos/minha.jpg' }).expect(200);

    const depois = await request(app).get('/api/me').set(authHeader(aluno));
    expect(depois.body.user.profilePhoto).toBe('/patient-photos/minha.jpg');
    expect(depois.body.user.defaultPhoto).toBeUndefined();
  });

  test('visitante entra na rotação (nunca vai ter foto própria)', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 2);
    const visitante = await loginVisitor();
    const me = await request(app).get('/api/me').set(authHeader(visitante));
    expect(me.body.user.role).toBe('visitor');
    expect(me.body.user.defaultPhoto).toMatch(/^\/avatar-pool\//);
  });

  test('esvaziar a pool devolve todo mundo à silhueta', async () => {
    const admin = await loginAs('admin');
    const fotos = await subir(admin, 1);
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/me').set(authHeader(aluno))).body.user.defaultPhoto)
      .toMatch(/^\/avatar-pool\//);

    await request(app).delete(`/api/admin/avatar-pool/${fotos[0].id}`).set(authHeader(admin)).expect(200);
    // O cache da pool é invalidado pelo mtime do arquivo: a remoção precisa
    // valer já na requisição seguinte.
    expect((await request(app).get('/api/me').set(authHeader(aluno))).body.user.defaultPhoto)
      .toBeUndefined();
  });
});

describe('telas de leitura já saem com a foto resolvida', () => {
  test('a Comunidade mostra a foto da pool no autor sem foto própria', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 2);
    const aluno = await loginAs('aluno');
    await request(app).post('/api/comunidade').set(authHeader(aluno))
      .send({ title: 'Uma dúvida de caso', body: 'texto do post' }).expect(200);

    const feed = await request(app).get('/api/comunidade').set(authHeader(aluno));
    expect(feed.body.discussions[0].author.photo).toMatch(/^\/avatar-pool\//);
  });

  test('o link público da discussão também traz a foto resolvida', async () => {
    const admin = await loginAs('admin');
    await subir(admin, 2);
    const aluno = await loginAs('aluno');
    await request(app).post('/api/comunidade').set(authHeader(aluno))
      .send({ title: 'Uma dúvida de caso', body: 'texto do post' }).expect(200);

    const anon = await request(app).get('/api/comunidade/1');
    expect(anon.body.discussion.author.photo).toMatch(/^\/avatar-pool\//);
  });
});

describe('escolha da foto (server/avatar-pool.js)', () => {
  const pool = [1, 2, 3].map((i) => ({ id: `p${i}`, url: `/avatar-pool/p${i}.jpg` }));

  test('pool vazia ou chave vazia devolve null', () => {
    expect(avatarPool.escolherFoto([], '7')).toBeNull();
    expect(avatarPool.escolherFoto(pool, '')).toBeNull();
    expect(avatarPool.escolherFoto(null, '7')).toBeNull();
  });

  test('a escolha é estável e sempre cai dentro da pool', () => {
    const urls = pool.map((p) => p.url);
    for (const chave of ['1', '42', 'visitor-a1b2c3']) {
      const escolha = avatarPool.escolherFoto(pool, chave);
      expect(urls).toContain(escolha);
      expect(avatarPool.escolherFoto(pool, chave)).toBe(escolha);
    }
  });

  test('espalha as pessoas: 60 ids não caem todos na mesma foto', () => {
    const usadas = new Set();
    for (let i = 1; i <= 60; i++) usadas.add(avatarPool.escolherFoto(pool, String(i)));
    expect(usadas.size).toBe(pool.length);
  });

  test('item torto no JSON não derruba a leitura', () => {
    expect(avatarPool.normalizarPool([{ id: 'p1', url: '/a.jpg' }, { id: 'p2' }, null, 'x']))
      .toEqual([{ id: 'p1', url: '/a.jpg' }]);
    expect(avatarPool.normalizarPool({ nao: 'array' })).toEqual([]);
    // O teto vale na leitura também: um JSON editado à mão com 20 itens não
    // faz o app servir 20.
    const muitos = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, url: `/p${i}.jpg` }));
    expect(avatarPool.normalizarPool(muitos)).toHaveLength(avatarPool.MAX_FOTOS);
  });
});
