// Prompts que se ajustam à quantidade de critérios e semeadura que atualiza
// (demandas.md §20).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resetData, db } = require('./helpers');
const { getPool } = require('../server/db');
const { criarRepoPrompts } = require('../server/repos/prompts');
const aval = require('../server/avaliador-pipeline');
const md = require('../server/criterios-md');

beforeEach(() => resetData());

// prompt_versoes é somente-inserção: cada teste usa um caminho próprio.
const caminho = () => `avaliacao/teste-semente-${crypto.randomBytes(4).toString('hex')}/a.md`;

describe('semeadura de prompts', () => {
  const repo = () => criarRepoPrompts(getPool());
  const conteudo = async (c) => (await db.query('SELECT conteudo FROM prompt_arquivos WHERE caminho = $1', [c])).rows[0].conteudo;

  it('insere o que falta e não mexe no que já é igual', async () => {
    const c = caminho();
    expect((await repo().semear([{ caminho: c, conteudo: 'v1' }])).inseridos).toBe(1);
    const de_novo = await repo().semear([{ caminho: c, conteudo: 'v1' }]);
    expect(de_novo).toEqual({ inseridos: 0, atualizados: [], preservados: [] });
  });

  it('semente nova sobre prompt que ninguém editou: atualiza, com a versão velha no histórico', async () => {
    const c = caminho();
    await repo().semear([{ caminho: c, conteudo: 'texto antigo' }]);
    const r = await repo().semear([{ caminho: c, conteudo: 'texto novo' }]);
    expect(r.atualizados).toEqual([c]);
    expect(await conteudo(c)).toBe('texto novo');
    const { rows } = await db.query('SELECT conteudo, motivo FROM prompt_versoes WHERE caminho = $1', [c]);
    expect(rows).toEqual([{ conteudo: 'texto antigo', motivo: 'semente' }]);
  });

  it('prompt editado pelo admin nunca é sobrescrito pela semente', async () => {
    const c = caminho();
    await repo().semear([{ caminho: c, conteudo: 'semente 1' }]);
    await repo().gravar(c, 'editado no painel', 'admin');
    const r = await repo().semear([{ caminho: c, conteudo: 'semente 2' }]);
    expect(r.preservados).toEqual([c]);
    expect(await conteudo(c)).toBe('editado no painel');
  });

  it('caminho repetido nas fontes: a primeira (o volume) vence', async () => {
    const c = caminho();
    await repo().semear([{ caminho: c, conteudo: 'do volume' }, { caminho: c, conteudo: 'do repo' }]);
    expect(await conteudo(c)).toBe('do volume');
  });
});

describe('slots da régua', () => {
  const criterios = [
    { num: 1, nome: 'Alfa', linhaCurta: 'mede alfa' },
    { num: 2, nome: 'Beta', linhaCurta: 'mede beta' },
    { num: 3, nome: 'Gama', linhaCurta: 'mede gama' },
  ];

  it('preenche quantidade em algarismo, por extenso e a lista', () => {
    const t = aval.preencherSlotsDaRegua('São {{N_CRITERIOS}} ({{N_CRITERIOS_EXTENSO}}):\n{{LISTA_CRITERIOS}}', criterios);
    expect(t).toBe('São 3 (três):\n1. Alfa: mede alfa\n2. Beta: mede beta\n3. Gama: mede gama');
    expect(aval.preencherSlotsDaRegua('sem slot', criterios)).toBe('sem slot');
  });

  it('os parsers aceitam os slots da régua e continuam recusando slot inventado', () => {
    const sint = (extra) => `## [METACOMANDO]\nregras\n<!-- CACHE BREAKPOINT -->\n{{LOG}}\n{{ANALISES}}\n${extra}`;
    expect(() => aval.parseSintetizador(sint('Os {{N_CRITERIOS}} critérios: {{LISTA_CRITERIOS}}'))).not.toThrow();
    expect(() => aval.parseSintetizador(sint('{{INVENTADO}}'))).toThrow(/INVENTADO/);
  });

  it('o aviso do painel acha a quantidade escrita à mão, fora dos títulos', () => {
    const achados = md.citacoesDeQuantidadeFixa([
      { caminho: 'a.md', conteudo: '# Os 8 critérios\nRoda depois dos oito nós.\nUsa {{N_CRITERIOS}} critérios.' },
    ]);
    expect(achados).toEqual([{ caminho: 'a.md', linha: 2, trecho: 'oito nós' }]);
  });

  // Os .md da semente não estão no git (conteúdo sensível); quando existem na
  // máquina, nenhum deles pode voltar a escrever a quantidade à mão.
  it('os prompts de semente do v34 não escrevem a quantidade de critérios à mão', () => {
    const raiz = path.join(__dirname, '..', 'avaliacao');
    if (!fs.existsSync(raiz)) return;
    const prompts = [];
    for (const cfg of Object.values(aval.PIPELINE_VERSIONS)) {
      const dir = path.join(raiz, cfg.dir);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        prompts.push({ caminho: `${cfg.dir}/${f}`, conteudo: fs.readFileSync(path.join(dir, f), 'utf-8') });
      }
    }
    expect(md.citacoesDeQuantidadeFixa(prompts)).toEqual([]);
  });
});
