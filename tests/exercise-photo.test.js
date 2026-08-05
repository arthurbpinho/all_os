// Avatar da IA de cada exercício da Trilha ("a bolinha" no chat) — mesmo
// esquema da foto de paciente (PUT .../:id/photo grava bytes no volume,
// clear:true remove). Admin-only; aluno só lê o resultado (photoIcon/photoFull
// não são gabarito, então publicExercise() não os esconde).

const { app, request, resetData, loginAs, authHeader } = require('./helpers');

const ICON_DATA_URL = 'data:image/jpeg;base64,' + Buffer.from('icone-fake').toString('base64');
const FULL_DATA_URL = 'data:image/jpeg;base64,' + Buffer.from('imagem-completa-fake').toString('base64');

describe('Avatar do exercício (/api/exercises/:id/photo)', () => {
  beforeEach(() => resetData());

  it('exige autenticação e papel admin', async () => {
    const anon = await request(app).put('/api/exercises/ex-test-1/photo').send({ icon: ICON_DATA_URL, full: FULL_DATA_URL });
    expect(anon.status).toBe(401);

    const alunoToken = await loginAs('aluno');
    const res = await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(alunoToken)).send({ icon: ICON_DATA_URL, full: FULL_DATA_URL });
    expect(res.status).toBe(403);
  });

  it('404 para exercício inexistente', async () => {
    const token = await loginAs('admin');
    const res = await request(app).put('/api/exercises/nao-existe/photo').set(authHeader(token)).send({ icon: ICON_DATA_URL, full: FULL_DATA_URL });
    expect(res.status).toBe(404);
  });

  it('rejeita payload que não é uma data URL de imagem', async () => {
    const token = await loginAs('admin');
    const res = await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(token)).send({ icon: 'não é imagem', full: FULL_DATA_URL });
    expect(res.status).toBe(400);
  });

  it('admin grava a foto e ela aparece na listagem (inclusive pro aluno)', async () => {
    const token = await loginAs('admin');
    const put = await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(token)).send({ icon: ICON_DATA_URL, full: FULL_DATA_URL });
    expect(put.status).toBe(200);
    expect(put.body.photoIcon).toMatch(/^\/exercise-photos\/ex-test-1-icon\.jpg\?v=\d+$/);
    expect(put.body.photoFull).toMatch(/^\/exercise-photos\/ex-test-1-full\.jpg\?v=\d+$/);

    const alunoToken = await loginAs('aluno');
    const list = await request(app).get('/api/exercises').set(authHeader(alunoToken));
    const found = list.body.find((e) => e.id === 'ex-test-1');
    expect(found.photoIcon).toBe(put.body.photoIcon);
    expect(found.photoFull).toBe(put.body.photoFull);
    // Gabarito do exercício continua oculto do aluno — a foto não é segredo.
    expect(found.specificInstruction).toBeUndefined();
  });

  it('clear:true remove a foto', async () => {
    const token = await loginAs('admin');
    await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(token)).send({ icon: ICON_DATA_URL, full: FULL_DATA_URL });

    const cleared = await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(token)).send({ clear: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.photoIcon).toBeUndefined();
    expect(cleared.body.photoFull).toBeUndefined();
  });

  it('imagem grande demais (>6MB) é rejeitada com 413', async () => {
    const token = await loginAs('admin');
    const big = 'data:image/jpeg;base64,' + Buffer.alloc(7 * 1024 * 1024, 1).toString('base64');
    const res = await request(app).put('/api/exercises/ex-test-1/photo').set(authHeader(token)).send({ icon: big, full: FULL_DATA_URL });
    expect(res.status).toBe(413);
  });
});
