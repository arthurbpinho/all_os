// Benchmark do paciente simulado — página estática atrás de senha compartilhada
// (/benchmarkpaciente). O que precisa valer: sem senha não sai relatório, com
// senha sai, e o CSP da rota libera o script inline do relatório sem afrouxar o
// CSP do resto do app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, request } = require('./helpers');

const SENHA = 'albires1'; // default de BENCHMARK_PASSWORD no server
const ARQUIVO = path.join(__dirname, '..', 'public', 'benchmark-paciente.html');

// Extrai o cookie de acesso do Set-Cookie da resposta.
function cookieDe(res) {
  const set = res.headers['set-cookie'] || [];
  const c = set.find((x) => x.startsWith('benchmark_acesso='));
  return c ? c.split(';')[0] : null;
}

describe('Benchmark do paciente (link com senha)', () => {
  it('sem senha, GET devolve o formulário e NÃO o relatório', async () => {
    const res = await request(app).get('/benchmarkpaciente');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Senha de acesso');
    // A marca do relatório não pode vazar pra quem não autenticou.
    expect(res.text).not.toContain('Qual IA atende como paciente');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });

  it('senha errada devolve 401 e não emite cookie', async () => {
    const res = await request(app)
      .post('/benchmarkpaciente')
      .type('form')
      .send({ senha: 'errada' });
    expect(res.status).toBe(401);
    expect(res.text).toContain('Senha incorreta');
    expect(cookieDe(res)).toBeNull();
  });

  it('senha vazia ou ausente não passa', async () => {
    for (const corpo of [{}, { senha: '' }, { senha: 'albires' }, { senha: 'albires12' }]) {
      const res = await request(app).post('/benchmarkpaciente').type('form').send(corpo);
      expect(res.status).toBe(401);
      expect(cookieDe(res)).toBeNull();
    }
  });

  it('senha certa emite cookie httpOnly e redireciona (PRG)', async () => {
    const res = await request(app)
      .post('/benchmarkpaciente')
      .type('form')
      .send({ senha: SENHA });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/benchmarkpaciente');
    const set = (res.headers['set-cookie'] || []).find((x) => x.startsWith('benchmark_acesso='));
    expect(set).toBeTruthy();
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    // Escopo do cookie limitado à própria rota.
    expect(set).toMatch(/Path=\/benchmarkpaciente/i);
  });

  it('com o cookie, o relatório é servido com CSP que libera seu script inline', async () => {
    if (!fs.existsSync(ARQUIVO)) return; // instância sem relatório publicado
    const login = await request(app).post('/benchmarkpaciente').type('form').send({ senha: SENHA });
    const cookie = cookieDe(login);
    const res = await request(app).get('/benchmarkpaciente').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Qual IA atende como paciente');
    expect(res.headers['cache-control']).toContain('no-store');

    // O CSP da rota tem de conter o hash de CADA script inline do arquivo —
    // senão os botões de download quebram em produção sem ninguém perceber.
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    const html = fs.readFileSync(ARQUIVO, 'utf8');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const m of inline) {
      const h = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      expect(csp).toContain(`'sha256-${h}'`);
    }
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('cookie forjado ou de outro escopo não abre o relatório', async () => {
    const jwt = require('jsonwebtoken');
    const outroEscopo = jwt.sign({ scope: 'outra-coisa' }, process.env.JWT_SECRET);
    const lixo = 'benchmark_acesso=nao-e-um-jwt';
    for (const cookie of [`benchmark_acesso=${outroEscopo}`, lixo]) {
      const res = await request(app).get('/benchmarkpaciente').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Senha de acesso');
      expect(res.text).not.toContain('Qual IA atende como paciente');
    }
  });

  it('a rota não é engolida pelo catch-all da SPA', async () => {
    const res = await request(app).get('/benchmarkpaciente');
    // Se o catch-all pegasse, viria o index.html do client (com <div id="root">).
    expect(res.text).not.toContain('id="root"');
  });
});
