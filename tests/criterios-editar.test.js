// "Adicionar critério" e editar critério (demandas.md §16.6): o critério é
// identificado pelo nome; o novo começa do zero; ao editar, o admin escolhe
// manter ou zerar o histórico.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const promptFiles = require('../server/prompt-files');
const { parseCriteria } = require('../server/avaliador-pipeline');
const md = require('../server/criterios-md');
const cp = require('../server/criterios-perfil');

// Régua de mentira, com a mesma anatomia do arquivo real.
const REGUA_FAKE = `# Régua de teste · Os 3 critérios

## Como usar

Um critério por nó.

---

## 1 · Alfa

Descrição de alfa,
em duas linhas.

## 2 · Beta

Descrição de beta.

## 3 · Gama

Descrição de gama.

---

## Linha curta de cada critério

Colada pelo código.

1. **Alfa**: o que alfa mede.
2. **Beta**: o que beta mede.
3. **Gama**: o que gama mede.
`;

const novo = { nome: 'Delta', linhaCurta: 'o que delta mede.', descricao: 'Descrição de delta.\n\nCom parágrafo.' };

describe('criterios-md (puro)', () => {
  it('adiciona no fim, sem mexer nos outros, e atualiza a contagem do título', () => {
    const r = md.adicionarCriterio(REGUA_FAKE, novo);
    expect(r.ok).toBe(true);
    expect(r.num).toBe(4);
    const antes = parseCriteria(REGUA_FAKE);
    const depois = parseCriteria(r.raw);
    expect(depois).toHaveLength(4);
    expect(depois.slice(0, 3)).toEqual(antes);
    expect(depois[3]).toMatchObject({ num: 4, nome: 'Delta', linhaCurta: 'o que delta mede' });
    expect(md.lerCriterios(r.raw)[3].corpo).toBe('Descrição de delta.\n\nCom parágrafo.');
    expect(r.raw).toContain('# Régua de teste · Os 4 critérios');
  });

  it('recusa nome repetido (sem caixa), campos que quebrariam o arquivo e régua cheia', () => {
    expect(md.adicionarCriterio(REGUA_FAKE, { ...novo, nome: 'BETA' }).erro).toMatch(/Já existe/);
    expect(md.adicionarCriterio(REGUA_FAKE, { ...novo, nome: 'Com **negrito**' }).ok).toBe(false);
    expect(md.adicionarCriterio(REGUA_FAKE, { ...novo, descricao: 'texto\n## 9 · Intruso\nmais' }).erro).toMatch(/não pode ter linhas/);
    expect(md.adicionarCriterio(REGUA_FAKE, { ...novo, linhaCurta: '' }).ok).toBe(false);
    let cheio = REGUA_FAKE;
    for (let i = 4; i <= md.LIMITES.max; i++) cheio = md.adicionarCriterio(cheio, { ...novo, nome: `C${i}` }).raw;
    expect(parseCriteria(cheio)).toHaveLength(md.LIMITES.max);
    expect(md.adicionarCriterio(cheio, { ...novo, nome: 'Um a mais' }).erro).toMatch(/máximo/);
  });

  it('edita um critério pelo número, trocando bloco e linha curta', () => {
    const r = md.editarCriterio(REGUA_FAKE, 2, { nome: 'Beta nova', linhaCurta: 'agora mede outra coisa', descricao: 'Nova descrição.' });
    expect(r.ok).toBe(true);
    expect(r.anterior).toEqual({ nome: 'Beta', linhaCurta: 'o que beta mede' });
    const lidos = md.lerCriterios(r.raw);
    expect(lidos.map((c) => c.nome)).toEqual(['Alfa', 'Beta nova', 'Gama']);
    expect(lidos[1]).toMatchObject({ linhaCurta: 'agora mede outra coisa', corpo: 'Nova descrição.' });
    expect(lidos[0].corpo).toBe('Descrição de alfa,\nem duas linhas.');
    expect(md.editarCriterio(REGUA_FAKE, 9, novo).naoExiste).toBe(true);
    expect(md.editarCriterio(REGUA_FAKE, 2, { ...novo, nome: 'gama' }).erro).toMatch(/Já existe/);
  });
});

describe('gráfico do perfil com critérios renomeados e zerados (puro)', () => {
  const log = (timestamp, notas, nomes) => ({ type: 'freeplay', mode: 'training', timestamp, criteriaScores: notas, criteriaNames: nomes });

  it('"manter": o nome antigo soma no novo; "zerar": notas de antes não contam', () => {
    const logs = [
      log('2026-09-01T00:00:00Z', { 1: 4, 2: 6 }, { 1: 'Beta', 2: 'Gama' }),
      log('2026-09-10T00:00:00Z', { 1: 8, 2: 10 }, { 1: 'Beta nova', 2: 'Gama' }),
    ];
    const r = cp.mediasPorCriterio(logs, {
      apelidos: { beta: 'Beta nova' },
      desde: { gama: '2026-09-05T00:00:00Z' },
    });
    expect(r.criterios).toEqual([
      { nome: 'Beta nova', media: 6, n: 2 },
      { nome: 'Gama', media: 10, n: 1 },
    ]);
  });
});

describe('rotas de critérios', () => {
  let original;
  beforeEach(async () => {
    await resetData();
    original = promptFiles.lerPrompt(md.CAMINHO);
  });
  afterEach(async () => {
    if (original != null && promptFiles.lerPrompt(md.CAMINHO) !== original) {
      await promptFiles.salvarPrompt(md.CAMINHO, original, { autor: 'teste' });
    }
  });

  it('só o admin', async () => {
    const prof = await loginAs('prof');
    expect((await request(app).get('/api/admin/criterios').set(authHeader(prof))).status).toBe(403);
    expect((await request(app).post('/api/admin/criterios').set(authHeader(prof)).send(novo)).status).toBe(403);
  });

  it('adicionar grava o arquivo (com histórico de versão) e cria a linha do critério', async () => {
    const admin = await loginAs('admin');
    const antes = await request(app).get('/api/admin/criterios').set(authHeader(admin));
    expect(antes.status).toBe(200);
    const n = antes.body.criterios.length;

    const r = await request(app).post('/api/admin/criterios').set(authHeader(admin)).send({ ...novo, nome: 'Critério de teste' });
    expect(r.status).toBe(200);
    expect(r.body.criterios).toHaveLength(n + 1);
    expect(r.body.criterios[n]).toMatchObject({ nome: 'Critério de teste', historicoDesde: null, nomesAnteriores: [] });
    expect(parseCriteria(promptFiles.lerPrompt(md.CAMINHO))).toHaveLength(n + 1);
    const { rows } = await db.query(`SELECT ativo FROM criterios WHERE regua = 'v34' AND nome = 'Critério de teste'`);
    expect(rows).toEqual([{ ativo: true }]);
    expect((await promptFiles.listBackups(md.CAMINHO)).length).toBeGreaterThan(0);

    const repetido = await request(app).post('/api/admin/criterios').set(authHeader(admin)).send({ ...novo, nome: 'critério DE teste' });
    expect(repetido.status).toBe(400);
  });

  it('editar exige a escolha do histórico; "manter" leva o nome antigo, "zerar" marca o recomeço', async () => {
    const admin = await loginAs('admin');
    const add = await request(app).post('/api/admin/criterios').set(authHeader(admin)).send({ ...novo, nome: 'Provisório' });
    const num = add.body.num;

    const semEscolha = await request(app).put(`/api/admin/criterios/${num}`).set(authHeader(admin)).send({ ...novo, nome: 'Definitivo' });
    expect(semEscolha.status).toBe(400);

    const manter = await request(app).put(`/api/admin/criterios/${num}`).set(authHeader(admin)).send({ ...novo, nome: 'Definitivo', historico: 'manter' });
    expect(manter.status).toBe(200);
    expect(manter.body.criterios.find((c) => c.num === num)).toMatchObject({ nome: 'Definitivo', nomesAnteriores: ['Provisório'], historicoDesde: null });

    const zerar = await request(app).put(`/api/admin/criterios/${num}`).set(authHeader(admin)).send({ ...novo, nome: 'Definitivo', descricao: 'Outra régua.', historico: 'zerar' });
    expect(zerar.status).toBe(200);
    const c = zerar.body.criterios.find((x) => x.num === num);
    expect(c.nomesAnteriores).toEqual([]);
    expect(c.historicoDesde).toBeTruthy();

    expect((await request(app).put('/api/admin/criterios/99').set(authHeader(admin)).send({ ...novo, historico: 'manter' })).status).toBe(404);
  });
});
