// Configuração da "Avaliação para visitantes": liga/desliga a avaliação de quem
// entra como visitante (palestras, eventos). É a única chave que sobrou aqui —
// a escolha de MODELO do visitante saiu em 2026-09, quando ele entrou no
// avaliador oficial junto com os outros modos; trocá-lo é escolher na categoria
// "Visitante" em Administração → Modelos de IA. O GET informa, por conveniência,
// qual modelo está avaliando o visitante agora.

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

describe('Configurações — avaliação para visitantes (/api/settings, /api/admin/settings)', () => {
  beforeEach(() => resetData());

  it('GET /api/settings exige autenticação', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('defaults: desligada, e o modelo relatado é o avaliador oficial da categoria', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/settings').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.visitorEvaluationEnabled).toBe(false);
    // Visitante também é avaliado pelo oficial (v29 em Luna high) quando o
    // interruptor está ligado.
    expect(res.body.avaliadorModelo).toBe('gpt-5.6-luna');
  });

  it('PUT /api/admin/settings é admin-only', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/admin/settings').set(authHeader(token)).send({ visitorEvaluationEnabled: true });
    expect(res.status).toBe(403);
  });

  it('admin liga a avaliação e o GET reflete o toggle', async () => {
    const admin = await loginAs('admin');
    const put = await request(app).put('/api/admin/settings').set(authHeader(admin)).send({ visitorEvaluationEnabled: true });
    expect(put.status).toBe(200);
    expect(put.body.visitorEvaluationEnabled).toBe(true);

    const token = await loginAs('aluno');
    const res = await request(app).get('/api/settings').set(authHeader(token));
    expect(res.body.visitorEvaluationEnabled).toBe(true);
    expect(res.body.avaliadorModelo).toBe('gpt-5.6-luna');
  });

  // Cliente antigo em cache pode continuar mandando a chave de modelo que saiu.
  // Ela é ignorada — e, o que importa, não derruba o toggle nem estoura a rota.
  it('chave de modelo que saiu do contrato é ignorada, sem quebrar o toggle', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/settings').set(authHeader(admin)).send({ visitorEvaluationEnabled: true });
    const put = await request(app).put('/api/admin/settings').set(authHeader(admin)).send({ visitorEvaluationModel: 'gpt-5.5' });
    expect(put.status).toBe(200);
    expect(put.body.visitorEvaluationEnabled).toBe(true);
    expect(put.body.visitorEvaluationModel).toBeUndefined();
  });
});
