// Repositório de prompts (server/repos/prompts.js) contra o Postgres de teste.
//
// Os prompts são o ativo que não pode ser perdido (demandas.md §9): o que se
// prova aqui é que nenhuma gravação passa sem guardar a anterior, que o
// histórico não muda depois de gravado, e que o critério é identificado pelo nome.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de prompts', () => {
  const { criarRepoPrompts } = require('../server/repos/prompts');

  let db;
  let prompts;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    prompts = criarRepoPrompts(db.pool);
  });

  afterEach(() => db.descartar());

  const CAMINHO = 'avaliacao/v34/sintetizador-v34.md';

  it('cria só o que não existe e grava só o que existe', async () => {
    expect(await prompts.gravar(CAMINHO, 'x', 'admin')).toBeNull();
    expect(await prompts.criar(CAMINHO, 'v1', 'admin')).toMatchObject({ atualizadoEm: expect.any(String) });
    expect(await prompts.criar(CAMINHO, 'outro', 'admin')).toBeNull();

    expect((await prompts.todos()).map((p) => [p.caminho, p.conteudo])).toEqual([[CAMINHO, 'v1']]);
  });

  it('toda gravação guarda a versão anterior, e dá para ler cada uma', async () => {
    await prompts.criar(CAMINHO, 'v1', 'admin');
    const g1 = await prompts.gravar(CAMINHO, 'v2', 'admin');
    await prompts.gravar(CAMINHO, 'v3', 'outro', { motivo: 'restauracao' });

    const versoes = await prompts.versoes(CAMINHO);
    expect(versoes.map((v) => v.motivo)).toEqual(['restauracao', 'edicao']);
    expect(versoes[1].id).toBe(g1.versaoAnterior);
    expect(await prompts.versao(CAMINHO, g1.versaoAnterior)).toBe('v1');
    expect(await prompts.versao(CAMINHO, versoes[0].id)).toBe('v2');
    // A versão é conferida contra o caminho: id de outro arquivo não serve.
    expect(await prompts.versao('entrevistador/outro.md', g1.versaoAnterior)).toBeNull();
  });

  it('gravações simultâneas guardam cada conteúdo que esteve no ar', async () => {
    await prompts.criar(CAMINHO, 'v0', 'admin');

    await Promise.all(['a', 'b', 'c'].map((c) => prompts.gravar(CAMINHO, c, 'admin')));

    const guardados = await Promise.all((await prompts.versoes(CAMINHO)).map((v) => prompts.versao(CAMINHO, v.id)));
    const final = (await prompts.todos())[0].conteudo;
    // Nenhuma versão se perdeu: v0 + as três gravações = o que está no ar + três guardadas.
    expect([...guardados, final].sort()).toEqual(['a', 'b', 'c', 'v0']);
  });

  it('o histórico é somente-inserção: nem UPDATE nem DELETE passam', async () => {
    await prompts.criar(CAMINHO, 'v1', 'admin');
    await prompts.gravar(CAMINHO, 'v2', 'admin');

    await expect(db.pool.query(`UPDATE prompt_versoes SET conteudo = 'adulterado'`)).rejects.toThrow(/somente-inserção/);
    await expect(db.pool.query('DELETE FROM prompt_versoes')).rejects.toThrow(/somente-inserção/);
    expect((await prompts.versoes(CAMINHO)).length).toBe(1);
  });

  it('excluir guarda o conteúdo no histórico, que sobrevive à exclusão', async () => {
    await prompts.criar(CAMINHO, 'vai sumir', 'admin');

    const r = await prompts.excluir(CAMINHO, 'admin');

    expect(await prompts.todos()).toEqual([]);
    expect(await prompts.versao(CAMINHO, r.versaoAnterior)).toBe('vai sumir');
    expect(await prompts.excluir(CAMINHO, 'admin')).toBeNull();
  });

  it('a semeadura só insere o que falta, e o primeiro de um caminho repetido fica', async () => {
    await prompts.criar(CAMINHO, 'editado pelo painel', 'admin');

    const n = await prompts.importarFaltantes([
      { caminho: CAMINHO, conteudo: 'do volume' },
      { caminho: 'entrevistador/promptentrevistador.md', conteudo: 'do volume' },
      { caminho: 'entrevistador/promptentrevistador.md', conteudo: 'da cópia local' },
    ]);

    expect(n).toBe(1);
    expect(Object.fromEntries((await prompts.todos()).map((p) => [p.caminho, p.conteudo]))).toEqual({
      [CAMINHO]: 'editado pelo painel',
      'entrevistador/promptentrevistador.md': 'do volume',
    });
  });

  describe('critérios identificados pelo nome', () => {
    const CRITERIOS = 'avaliacao/v34/criterios-no-v34.md';
    const grade = (...nomes) => nomes.map((nome) => ({ nome, linhaCurta: `mede ${nome}`, descricao: `## · ${nome}` }));

    it('mesmo nome mantém o critério; nome novo cria; nome que sai fica inativo', async () => {
      await prompts.criar(CRITERIOS, 'md', 'admin', { criterios: { regua: 'v34', lista: grade('Comunicação', 'Vínculo') } });
      const antes = await prompts.criteriosDa('v34');

      // Vínculo mudou só de texto (e de caixa); Escuta é novo; Comunicação saiu.
      await prompts.gravar(CRITERIOS, 'md2', 'admin', {
        criterios: { regua: 'v34', lista: [{ nome: 'vínculo', linhaCurta: 'outra redação', descricao: 'novo texto' }, ...grade('Escuta')] },
      });
      const depois = await prompts.criteriosDa('v34');

      const porNome = (lista, nome) => lista.find((c) => c.nome.toLowerCase() === nome.toLowerCase());
      expect(porNome(depois, 'Vínculo').id).toBe(porNome(antes, 'Vínculo').id);
      expect(porNome(depois, 'Vínculo')).toMatchObject({ ordem: 1, linhaCurta: 'outra redação', ativo: true });
      expect(porNome(depois, 'Escuta')).toMatchObject({ ordem: 2, ativo: true });
      expect(porNome(depois, 'Comunicação')).toMatchObject({ id: porNome(antes, 'Comunicação').id, ativo: false });

      // E se o critério volta com o mesmo nome, é o mesmo de antes.
      await prompts.derivarCriterios('v34', grade('Comunicação'));
      expect(porNome(await prompts.criteriosDa('v34'), 'Comunicação')).toMatchObject({ id: porNome(antes, 'Comunicação').id, ativo: true });
    });

    it('prompt e critérios gravam juntos: se a grade falha, o prompt não muda', async () => {
      await prompts.criar(CRITERIOS, 'md', 'admin', { criterios: { regua: 'v34', lista: grade('Comunicação') } });

      // Um critério sem nome viola o NOT NULL no meio da transação.
      await expect(prompts.gravar(CRITERIOS, 'md novo', 'admin', {
        criterios: { regua: 'v34', lista: [{ nome: null }] },
      })).rejects.toThrow();

      expect((await prompts.todos())[0].conteudo).toBe('md');
      expect(await prompts.versoes(CRITERIOS)).toEqual([]);
      expect((await prompts.criteriosDa('v34')).map((c) => [c.nome, c.ativo])).toEqual([['Comunicação', true]]);
    });
  });
});
