// Poll do job de avaliação em Batch da Trilha (exercício com avaliador OpenAI
// — mini/5.4/5.5). A submissão em si depende de rede (OPENAI_API_KEY vazio no
// ambiente de teste), então este teste cobre só o endpoint de poll
// (GET /api/trilha/evaluate-batch/:jobId), escrevendo o job direto no
// DATA_DIR — mesmo padrão de outros testes que manipulam JSON de arquivo.
const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, authHeader, DATA_DIR } = require('./helpers');

function writeQueue(jobs) {
  fs.writeFileSync(path.join(DATA_DIR, 'trilha-eval-queue.json'), JSON.stringify(jobs, null, 2));
}

describe('Trilha — poll do job de avaliação em Batch', () => {
  beforeEach(() => resetData());

  it('404 quando o job não existe', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).get('/api/trilha/evaluate-batch/inexistente').set(authHeader(token));
    expect(res.status).toBe(404);
  });

  it('403 quando o job é de outro usuário', async () => {
    const dono = await loginAs('aluno');
    writeQueue([{ id: 'job-1', userId: 'algum-outro-id', status: 'processing' }]);
    const res = await request(app).get('/api/trilha/evaluate-batch/job-1').set(authHeader(dono));
    expect(res.status).toBe(403);
  });

  it('status processing enquanto o batch não termina', async () => {
    const token = await loginAs('aluno');
    const me = await request(app).get('/api/me').set(authHeader(token));
    writeQueue([{ id: 'job-2', userId: me.body.user.id, status: 'processing' }]);
    const res = await request(app).get('/api/trilha/evaluate-batch/job-2').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'processing' });
  });

  it('status completed devolve content + usage', async () => {
    const token = await loginAs('aluno');
    const me = await request(app).get('/api/me').set(authHeader(token));
    writeQueue([{
      id: 'job-3', userId: me.body.user.id, status: 'completed',
      result: { content: '[NOTA:80]\n\nBom trabalho.', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 } },
    }]);
    const res = await request(app).get('/api/trilha/evaluate-batch/job-3').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.content).toBe('[NOTA:80]\n\nBom trabalho.');
    expect(res.body.usage).toEqual({ input: 100, cacheRead: 0, cacheWrite: 0, output: 50 });
  });

  it('status error devolve a mensagem de erro', async () => {
    const token = await loginAs('aluno');
    const me = await request(app).get('/api/me').set(authHeader(token));
    writeQueue([{ id: 'job-4', userId: me.body.user.id, status: 'error', error: 'batch failed' }]);
    const res = await request(app).get('/api/trilha/evaluate-batch/job-4').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'error', error: 'batch failed' });
  });
});
