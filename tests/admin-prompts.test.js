// Administração → Prompts: as duas travas que substituem o que o git dava para
// esses .md (que saíram do versionamento): VALIDAÇÃO antes de gravar e BACKUP
// da versão anterior, com restauração. Mais o controle de acesso (admin-only) e
// a invalidação do cache de prompts do v25.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR } = require('../server/paths');
const promptFiles = require('../server/prompt-files');
const v25 = require('../server/avaliacao-v25');

const MONTADO = 'avaliacao/nova avaliacao/prompt-no-v25-montado.md';
const url = (p) => '/api/admin/prompts/' + p.split('/').map(encodeURIComponent).join('/');
const absOf = (p) => path.join(PROMPTS_DIR, p);

describe('Administração — editor de prompts', () => {
  beforeEach(() => resetData());

  it('lista e lê os .md do volume (admin); supervisor e aluno são barrados', async () => {
    const admin = await loginAs('admin');
    const lista = await request(app).get('/api/admin/prompts').set(authHeader(admin));
    expect(lista.status).toBe(200);
    expect(lista.body.paths).toContain(MONTADO); // formato antigo preservado
    const item = lista.body.files.find((f) => f.path === MONTADO);
    expect(item.validado).toBe(true); // arquivo com contrato conferido

    const arq = await request(app).get(url(MONTADO)).set(authHeader(admin));
    expect(arq.status).toBe(200);
    expect(arq.body.content).toContain('@variante:so-nota');

    for (const quem of ['prof', 'aluno']) {
      const t = await loginAs(quem);
      expect((await request(app).get('/api/admin/prompts').set(authHeader(t))).status).toBe(403);
      expect((await request(app).get(url(MONTADO)).set(authHeader(t))).status).toBe(403);
    }
  });

  it('recusa a gravação que quebra o contrato do arquivo, sem tocar no disco', async () => {
    const admin = await loginAs('admin');
    const antes = fs.readFileSync(absOf(MONTADO), 'utf8');

    // Some com os blocos @variante (o caso que o Ctrl+V errado produz).
    const quebrado = antes.replace(/<!--\s*@variante:[a-z-]+\s*-->/g, '');
    const res = await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: quebrado });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/@variante/);
    expect(fs.readFileSync(absOf(MONTADO), 'utf8')).toBe(antes); // intocado

    // Slot obrigatório removido também é recusado (global: o primeiro
    // `{{CRITÉRIO}}` do arquivo está na seção "Como usar", não no bloco C).
    const semSlot = antes.replace(/\{\{CRITÉRIO\}\}/g, 'sem slot');
    const res2 = await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: semSlot });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toMatch(/\{\{CRITÉRIO\}\}/);
    expect(fs.readFileSync(absOf(MONTADO), 'utf8')).toBe(antes);
  });

  it('grava o que passa na validação, guarda a versão anterior e restaura', async () => {
    const admin = await loginAs('admin');
    const original = fs.readFileSync(absOf(MONTADO), 'utf8');
    const editado = original + '\n\n<!-- edição de teste -->\n';

    const salvo = await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: editado });
    expect(salvo.status).toBe(200);
    expect(salvo.body.validado).toBe(true);
    expect(fs.readFileSync(absOf(MONTADO), 'utf8')).toBe(editado);
    expect(salvo.body.versoes.length).toBe(1); // a versão anterior foi guardada

    const versaoId = salvo.body.versoes[0].id;
    const versao = await request(app).get(`/api/admin/prompt-versions/${versaoId}?path=${encodeURIComponent(MONTADO)}`).set(authHeader(admin));
    expect(versao.body.content).toBe(original);

    const restaurado = await request(app).post(`/api/admin/prompt-versions/${versaoId}/restaurar`).set(authHeader(admin)).send({ path: MONTADO });
    expect(restaurado.status).toBe(200);
    expect(fs.readFileSync(absOf(MONTADO), 'utf8')).toBe(original);
    // Restaurar também guarda o que estava no ar: dá pra voltar da restauração.
    expect(restaurado.body.versoes.length).toBe(2);
  });

  it('salvar invalida o cache de prompts do v25 (sem restart)', async () => {
    const admin = await loginAs('admin');
    const original = fs.readFileSync(absOf(MONTADO), 'utf8');
    v25.loadAssets('so-nota'); // memoiza

    const marca = 'MARCA-DE-CACHE-XYZ';
    const editado = original.replace('## [METACOMANDO]', '## [METACOMANDO]\n\n' + marca);
    await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: editado });

    expect(v25.loadAssets('so-nota').blockA).toContain(marca);
    fs.writeFileSync(absOf(MONTADO), original, 'utf8');
    v25.clearAssetsCache();
  });

  it('caminho fora do PROMPTS_DIR ou fora de .md é recusado', async () => {
    const admin = await loginAs('admin');
    expect(promptFiles.resolvePromptPath('../../etc/passwd.md')).toBe(null);
    expect(promptFiles.resolvePromptPath('avaliacao/qualquer.txt')).toBe(null);
    const fora = await request(app).get('/api/admin/prompt-versions?path=' + encodeURIComponent('../fora.md')).set(authHeader(admin));
    expect(fora.status).toBe(400);
  });

  it('validador: arquivo sem contrato passa; conteúdo vazio nunca', () => {
    expect(promptFiles.validatePromptContent('entrevistador/qualquer.md', 'texto livre').ok).toBe(true);
    expect(promptFiles.validatePromptContent('entrevistador/qualquer.md', 'texto livre').validado).toBe(false);
    expect(promptFiles.validatePromptContent(MONTADO, '   ').ok).toBe(false);
    // criterios-no-v25.md: o contrato é ter os 14 critérios parseáveis.
    const criterios = fs.readFileSync(absOf('avaliacao/nova avaliacao/criterios-no-v25.md'), 'utf8');
    expect(promptFiles.validatePromptContent('avaliacao/nova avaliacao/criterios-no-v25.md', criterios).ok).toBe(true);
    const truncado = criterios.slice(0, Math.floor(criterios.length / 3));
    expect(promptFiles.validatePromptContent('avaliacao/nova avaliacao/criterios-no-v25.md', truncado).ok).toBe(false);
  });
});
