// Catálogos no banco (demandas.md §20): pacientes, neuro, exercícios e
// competências da Trilha saíram dos arquivos do volume.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const { getPool } = require('../server/db');
const { criarRepoCatalogo } = require('../server/repos/catalogo');
const { criarCatalogo } = require('../server/catalogo');

beforeEach(() => resetData());

const docs = async (tipo) => (await db.query(
  'SELECT id, doc FROM catalogo_itens WHERE tipo = $1 ORDER BY ordem', [tipo],
)).rows;

describe('catálogos no banco', () => {
  it('criar, editar e excluir paciente gravam no banco, na ordem de cadastro', async () => {
    const admin = await loginAs('admin');
    const novo = await request(app).post('/api/freeplay').set(authHeader(admin)).send({ name: 'Novo', specificInstruction: 'PROMPT_NOVO' });
    expect(novo.status).toBe(200);
    expect((await docs('freeplay')).map((r) => r.doc.name)).toEqual(['Sofia Test', 'Novo']);

    const editado = await request(app).put(`/api/freeplay/${novo.body.id}`).set(authHeader(admin)).send({ name: 'Editado' });
    expect(editado.body.name).toBe('Editado');
    expect((await docs('freeplay'))[1].doc).toMatchObject({ name: 'Editado', specificInstruction: 'PROMPT_NOVO' });
    expect((await request(app).put('/api/freeplay/nao-existe').set(authHeader(admin)).send({ name: 'x' })).status).toBe(404);

    await request(app).delete(`/api/freeplay/${novo.body.id}`).set(authHeader(admin));
    expect((await docs('freeplay')).map((r) => r.id)).toEqual(['fp-test-1']);
  });

  it('exercício, competência e caso de neuro também', async () => {
    const admin = await loginAs('admin');
    const ex = await request(app).post('/api/exercises').set(authHeader(admin)).send({ title: 'Ex novo', skillId: 1 });
    expect((await docs('exercicios')).map((r) => r.id)).toContain(ex.body.id);
    const skill = await request(app).post('/api/trilha-skills').set(authHeader(admin)).send({ name: 'Escuta' });
    expect((await docs('trilha_skills'))[0].doc).toMatchObject({ id: skill.body.id, name: 'Escuta' });
    const nr = await request(app).post('/api/neuro').set(authHeader(admin)).send({ name: 'Caso neuro' });
    expect((await docs('neuro')).map((r) => r.id)).toContain(nr.body.id);
  });

  it('gravações simultâneas no mesmo catálogo não se perdem nem repetem id', async () => {
    const admin = await loginAs('admin');
    await Promise.all([1, 2, 3, 4, 5].map((n) => request(app).post('/api/trilha-skills').set(authHeader(admin)).send({ name: `C${n}` })));
    const lista = (await request(app).get('/api/trilha-skills').set(authHeader(admin))).body;
    expect(lista).toHaveLength(5);
    expect(new Set(lista.map((s) => s.id)).size).toBe(5);
  });

  it('o aluno continua recebendo só o card, sem o prompt do paciente', async () => {
    const aluno = await loginAs('aluno');
    const r = await request(app).get('/api/freeplay').set(authHeader(aluno));
    expect(r.body[0].name).toBe('Sofia Test');
    expect(JSON.stringify(r.body)).not.toContain('FP_PROMPT_SECRETO_NAO_VAZAR');
  });

  it('item sem id ou com id repetido é recusado, e a cópia em memória não muda', async () => {
    await expect(app.__test.definirCatalogo('freeplay', [{ name: 'sem id' }])).rejects.toThrow(/sem id/);
    await expect(app.__test.definirCatalogo('freeplay', [{ id: 'a' }, { id: 'a' }])).rejects.toThrow(/repetido/);
    const admin = await loginAs('admin');
    expect((await request(app).get('/api/freeplay').set(authHeader(admin))).body.map((c) => c.id)).toEqual(['fp-test-1']);
  });

  it('primeira carga no boot: do arquivo do volume, uma vez só', async () => {
    await db.query(`DELETE FROM configuracoes WHERE chave LIKE 'catalogo-%'`);
    await db.query(`DELETE FROM catalogo_itens WHERE tipo = 'neuro'`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-volume-'));
    fs.writeFileSync(path.join(dir, 'neuro-characters.json'), JSON.stringify([{ id: 'nr-vol', name: 'Do volume' }]));
    fs.writeFileSync(path.join(dir, 'freeplay-characters.json'), '{ quebrado');

    const cat = criarCatalogo(criarRepoCatalogo(getPool()));
    const semeados = await cat.semearDoVolume(dir, { exercicios: [] });
    expect(semeados.some((s) => s.startsWith('neuro'))).toBe(true);
    expect((await docs('neuro')).map((r) => r.id)).toEqual(['nr-vol']);
    // Arquivo ilegível: não semeia nem marca (fica para o próximo boot, com o erro no log).
    expect((await db.query(`SELECT 1 FROM configuracoes WHERE chave = 'catalogo-freeplay-semeado'`)).rowCount).toBe(0);
    // Catálogo que já tinha itens ganha só a marca, sem o padrão por cima.
    expect((await docs('exercicios')).length).toBe(2);

    // O admin esvaziou o catálogo: o boot seguinte não o repõe.
    await db.query(`DELETE FROM catalogo_itens WHERE tipo = 'neuro'`);
    await cat.semearDoVolume(dir, {});
    expect(await docs('neuro')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
