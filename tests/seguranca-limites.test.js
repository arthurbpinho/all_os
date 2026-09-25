// Limites de tentativa do login e do cadastro, LIGADOS (no resto da suíte eles
// são desligados, porque a suíte faz dezenas de logins por segundo). Sem este
// arquivo, nenhum teste provava que o brute-force é contido de fato.
//
// Cada teste usa um CF-Connecting-IP próprio: é por ele que o app identifica o
// IP real atrás do Cloudflare (ver clientIp), então cada teste começa com o
// balde do limite zerado.
process.env.TESTAR_LIMITES = '1';
// O supertest conecta de 127.0.0.1: aqui ele faz o papel do Cloudflare, senão o
// CF-Connecting-IP seria ignorado (ver server/ip-real.js).
process.env.IPS_PROXY_CONFIAVEIS = '127.0.0.1,::1';
const { app, request, resetData, TEST_PASSWORD } = require('./helpers');

let ipSeq = 0;
const novoIp = () => `203.0.113.${++ipSeq}`;

beforeEach(() => resetData());

describe('limites de tentativa ligados', () => {
  it('login: 10 erros por IP em 15 min; a 11ª tentativa é barrada, até com a senha certa', async () => {
    const ip = novoIp();
    // Nomes diferentes: o atraso progressivo é por conta, e aqui o que se mede é o teto por IP.
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/api/login').set('CF-Connecting-IP', ip)
        .send({ username: `inexistente${i}`, password: 'Errada1!' });
      expect(r.status).toBe(401);
    }
    const barrada = await request(app).post('/api/login').set('CF-Connecting-IP', ip)
      .send({ username: 'aluno', password: TEST_PASSWORD });
    expect(barrada.status).toBe(429);

    // Outro IP não herda o bloqueio.
    const outroIp = await request(app).post('/api/login').set('CF-Connecting-IP', novoIp())
      .send({ username: 'aluno', password: TEST_PASSWORD });
    expect(outroIp.status).toBe(200);
  });

  it('login: acertos não contam para o teto (turma inteira atrás do mesmo IP)', async () => {
    const ip = novoIp();
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post('/api/login').set('CF-Connecting-IP', ip)
        .send({ username: i % 2 ? 'aluno' : 'aluno2', password: TEST_PASSWORD });
      expect(r.status).toBe(200);
    }
  });

  it('login: erros seguidos na MESMA conta atrasam a resposta, de qualquer IP', async () => {
    // O atraso é aplicado antes de conferir a senha, pelas falhas JÁ registradas:
    // com 3 não atrasa (typo acontece), com 4 espera 250 ms, com 5 espera 500 ms.
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/login').set('CF-Connecting-IP', novoIp())
        .send({ username: 'prof2', password: 'Errada1!' });
    }
    const inicio = Date.now();
    const sexta = await request(app).post('/api/login').set('CF-Connecting-IP', novoIp())
      .send({ username: 'PROF2', password: 'Errada1!' }); // caixa diferente conta como a mesma conta
    expect(sexta.status).toBe(401);
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(450);

    // A pessoa certa ainda entra (o atraso não é bloqueio) e o contador zera.
    expect((await request(app).post('/api/login').set('CF-Connecting-IP', novoIp())
      .send({ username: 'prof2', password: TEST_PASSWORD })).status).toBe(200);
  });

  it('cadastro: 10 por IP por hora; a 11ª é barrada antes de qualquer trabalho', async () => {
    const ip = novoIp();
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/api/cadastro').set('CF-Connecting-IP', ip).send({});
      expect(r.status).toBe(400);
    }
    const barrada = await request(app).post('/api/cadastro').set('CF-Connecting-IP', ip).send({});
    expect(barrada.status).toBe(429);
  });

  it('pedido de nova senha: 8 por IP por hora', async () => {
    const ip = novoIp();
    for (let i = 0; i < 8; i++) {
      const r = await request(app).post('/api/senha/esqueci').set('CF-Connecting-IP', ip).send({ email: `x${i}@exemplo.invalid` });
      expect(r.status).toBe(200);
    }
    const barrada = await request(app).post('/api/senha/esqueci').set('CF-Connecting-IP', ip).send({ email: 'y@exemplo.invalid' });
    expect(barrada.status).toBe(429);
  });

  it('token de visitante: 30 por IP em 15 min', async () => {
    const ip = novoIp();
    for (let i = 0; i < 30; i++) {
      expect((await request(app).post('/api/login/visitor').set('CF-Connecting-IP', ip).send({})).status).toBe(200);
    }
    expect((await request(app).post('/api/login/visitor').set('CF-Connecting-IP', ip).send({})).status).toBe(429);
  });
});
