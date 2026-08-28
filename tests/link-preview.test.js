// Preview de link da discussão (Open Graph).
//
// O robô que monta o preview (WhatsApp, Telegram, Slack, Facebook) NÃO executa
// JavaScript: ele lê o HTML como o servidor entregou. Como o app é uma SPA que
// serve o MESMO index.html em toda rota, o link de discussão mostrava o título
// genérico da home. Estes testes travam o comportamento da rota que corrige
// isso — inclusive o escape, que é a parte com consequência de segurança.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'client', 'dist', 'index.html');
const temBuild = fs.existsSync(DIST);
const d = temBuild ? describe : describe.skip;

async function criar(token, body) {
  const r = await request(app).post('/api/comunidade').set(authHeader(token)).send(body);
  expect(r.status).toBe(200);
  return r.body.id;
}

d('preview do link da discussão', () => {
  beforeEach(() => resetData());

  it('usa o título da discussão e a descrição de convite', async () => {
    const aluno = await loginAs('aluno');
    const id = await criar(aluno, { title: 'Como conduzir a primeira sessão', body: 'Texto do post.' });

    const r = await request(app).get(`/comunidade/discussao/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/html/);
    expect(r.text).toContain('<title>Como conduzir a primeira sessão</title>');
    expect(r.text).toContain('<meta property="og:title" content="Como conduzir a primeira sessão" />');
    expect(r.text).toContain('Participe da discussão. Visualize como visitante ou comente como aluno.');
    // Discussão é conteúdo, não a home.
    expect(r.text).toContain('<meta property="og:type" content="article" />');
    // O host vem da requisição (atrás do Cloudflare, do próprio domínio), então
    // aqui só o caminho é estável.
    expect(r.text).toMatch(new RegExp(`<meta property="og:url" content="https?://[^"]*/comunidade/discussao/${id}" />`));
  });

  it('NÃO expõe o corpo da discussão no preview', async () => {
    const aluno = await loginAs('aluno');
    const id = await criar(aluno, {
      title: 'Dúvida de caso',
      body: 'Paciente de 34 anos com histórico que não deve vazar em preview.',
    });
    const r = await request(app).get(`/comunidade/discussao/${id}`);
    expect(r.text).not.toContain('34 anos');
    expect(r.text).not.toContain('não deve vazar');
  });

  // O título é escrito por usuário e vai para dentro de atributos HTML da
  // própria página. Sem escape, é injeção de markup.
  it('escapa o título: aspas, sinais de tag e & não viram markup', async () => {
    const aluno = await loginAs('aluno');
    const id = await criar(aluno, {
      title: 'Aspas " e <script>alert(1)</script> & fim',
      body: 'Corpo qualquer.',
    });
    const r = await request(app).get(`/comunidade/discussao/${id}`);
    expect(r.text).not.toContain('<script>alert(1)</script>');
    expect(r.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.text).toContain('&quot;');
    expect(r.text).toContain('&amp; fim');
    // O atributo content não pode ter sido fechado antes da hora.
    expect(r.text).not.toMatch(/content="Aspas " /);
  });

  it('título gigante é cortado (preview truncado feio é pior que curto)', async () => {
    const aluno = await loginAs('aluno');
    const longo = 'Palavra '.repeat(40).trim(); // ~319 chars
    const id = await criar(aluno, { title: longo, body: 'Corpo qualquer.' });
    const r = await request(app).get(`/comunidade/discussao/${id}`);
    const m = r.text.match(/<meta property="og:title" content="([^"]*)"/);
    expect(m).toBeTruthy();
    expect(m[1].length).toBeLessThanOrEqual(100);
  });

  it('discussão inexistente cai no preview genérico, sem quebrar o link', async () => {
    const r = await request(app).get('/comunidade/discussao/9999');
    expect(r.status).toBe(200);
    expect(r.text).toContain('all_OS · Plataforma de Simulação Clínica');
    expect(r.text).toContain('<meta property="og:type" content="website" />');
  });

  it('não exige sessão nenhuma — é o link que se compartilha', async () => {
    const aluno = await loginAs('aluno');
    const id = await criar(aluno, { title: 'Discussão pública', body: 'Texto do post.' });
    // Sem Authorization.
    const r = await request(app).get(`/comunidade/discussao/${id}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>Discussão pública</title>');
  });

  it('as outras rotas continuam com o preview genérico', async () => {
    for (const rota of ['/', '/comunidade', '/inicio']) {
      const r = await request(app).get(rota);
      expect(r.text).toContain('<title>all_OS · Plataforma de Simulação Clínica</title>');
    }
  });

  it('o título editado pelo admin aparece no preview', async () => {
    const aluno = await loginAs('aluno');
    const id = await criar(aluno, { title: 'Título antigo', body: 'Texto do post.' });
    const admin = await loginAs('admin');
    await request(app).put(`/api/comunidade/${id}`).set(authHeader(admin))
      .send({ title: 'Título corrigido', body: 'Texto do post.' }).expect(200);

    const r = await request(app).get(`/comunidade/discussao/${id}`);
    expect(r.text).toContain('<title>Título corrigido</title>');
  });
});
