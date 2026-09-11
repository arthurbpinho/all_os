// Administração → Prompts: as duas travas que substituem o que o git dava para
// esses .md (que saíram do versionamento): VALIDAÇÃO antes de gravar e BACKUP
// da versão anterior, com restauração. Mais o controle de acesso (admin-only),
// a invalidação do cache de prompts do pipeline e a EXCLUSÃO — que existe para
// limpar o que ficou preso no volume quando um modo saiu do app, e cuja trava
// é não deixar sair um .md que a produção lê.
//
// Caminhos: o PROMPTS_DIR do teste é semeado da pasta avaliacao/ do repo, onde
// cada versão do pipeline mora na pasta do nome dela (ver `dir` em
// PIPELINE_VERSIONS).
const { app, request, resetData, loginAs, authHeader } = require('./helpers');
const fs = require('fs');
const path = require('path');
const { PROMPTS_DIR } = require('../server/paths');
const promptFiles = require('../server/prompt-files');
const pipeline = require('../server/avaliador-pipeline');

const MONTADO = 'avaliacao/v34/prompt-no-v34-montado.md';
const CRITERIOS = 'avaliacao/v34/criterios-no-v34.md';
const MISSAO = 'avaliacao/v34-progressao/missao-v34-progressao.md';
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
    expect(arq.body.content).toContain('## [METACOMANDO]');

    for (const quem of ['prof', 'aluno']) {
      const t = await loginAs(quem);
      expect((await request(app).get('/api/admin/prompts').set(authHeader(t))).status).toBe(403);
      expect((await request(app).get(url(MONTADO)).set(authHeader(t))).status).toBe(403);
    }
  });

  it('recusa a gravação que quebra o contrato do arquivo, sem tocar no disco', async () => {
    const admin = await loginAs('admin');
    const antes = fs.readFileSync(absOf(MONTADO), 'utf8');

    // Some com um marcador de CACHE BREAKPOINT (o caso que o Ctrl+V errado
    // produz): sem ele o parser não sabe onde termina o bloco do caso.
    const quebrado = antes.replace('<!-- ===== CACHE BREAKPOINT B', '<!-- (removido)');
    const res = await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: quebrado });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/BREAKPOINT/);
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

  it('salvar invalida o cache de prompts do pipeline (sem restart)', async () => {
    const admin = await loginAs('admin');
    const original = fs.readFileSync(absOf(MONTADO), 'utf8');
    pipeline.loadAssets('v34'); // memoiza

    const marca = 'MARCA-DE-CACHE-XYZ';
    const editado = original.replace('## [METACOMANDO]', '## [METACOMANDO]\n\n' + marca);
    await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: editado });

    expect(pipeline.loadAssets('v34').blockA).toContain(marca);
    fs.writeFileSync(absOf(MONTADO), original, 'utf8');
    pipeline.clearAssetsCache();
  });

  // O modo progressão tem contrato PRÓPRIO: cinco slots no bloco do caso, três
  // slots extras no sintetizador e o .md do nó da missão. O validador tem de
  // conferir cada versão pelo contrato dela, senão um arquivo trocado entre as
  // pastas passaria batido.
  it('valida os .md do modo progressão pelo contrato da versão', async () => {
    const admin = await loginAs('admin');
    const lista = await request(app).get('/api/admin/prompts').set(authHeader(admin));
    expect(lista.body.files.find((f) => f.path === MISSAO).validado).toBe(true);

    // O prompt do nó do modo padrão não serve no lugar do da progressão: faltam
    // os slots dos materiais que só existem lá.
    const montadoPadrao = fs.readFileSync(absOf(MONTADO), 'utf8');
    const trocado = promptFiles.validatePromptContent(
      'avaliacao/v34-progressao/prompt-no-v34-progressao-montado.md', montadoPadrao,
    );
    expect(trocado.ok).toBe(false);
    expect(trocado.error).toMatch(/\{\{ATENDIMENTO_1\}\}/);

    // E o do nó da missão precisa da missão e do log.
    const missao = fs.readFileSync(absOf(MISSAO), 'utf8');
    expect(promptFiles.validatePromptContent(MISSAO, missao).ok).toBe(true);
    const semMissao = missao.replace(/\{\{MISSAO\}\}/g, 'sem slot');
    expect(promptFiles.validatePromptContent(MISSAO, semMissao).ok).toBe(false);
  });

  // Sem isto não havia como levar um prompt NOVO para produção: os .md saíram do
  // git e o volume só é semeado no primeiro boot, o que obrigava a rodar script
  // de terminal a cada versão nova de avaliador. As duas intenções são separadas:
  // sem a flag é EDIÇÃO (caminho inexistente → 404, para um erro de digitação não
  // virar arquivo órfão); com `criar:true` é CRIAÇÃO (caminho existente → 409,
  // para um caminho novo não apagar um prompt que está no ar).
  it('cria arquivo novo só com criar:true; edição e criação não se confundem', async () => {
    const admin = await loginAs('admin');
    const novo = 'avaliacao/v34/rascunho-de-teste.md';
    expect(fs.existsSync(absOf(novo))).toBe(false);

    const semFlag = await request(app).put(url(novo)).set(authHeader(admin)).send({ content: 'texto' });
    expect(semFlag.status).toBe(404);
    expect(fs.existsSync(absOf(novo))).toBe(false);

    const criado = await request(app).put(url(novo)).set(authHeader(admin)).send({ content: 'texto', criar: true });
    expect(criado.status).toBe(200);
    expect(criado.body.criado).toBe(true);
    expect(fs.readFileSync(absOf(novo), 'utf8')).toBe('texto');

    // Criar de novo no mesmo caminho NÃO sobrescreve o que já está lá.
    const dedup = await request(app).put(url(novo)).set(authHeader(admin)).send({ content: 'outro', criar: true });
    expect(dedup.status).toBe(409);
    expect(fs.readFileSync(absOf(novo), 'utf8')).toBe('texto');

    // O mesmo vale para um prompt de verdade: criar por cima do que está no ar é recusado
    // antes de qualquer escrita.
    const porCima = await request(app).put(url(MONTADO)).set(authHeader(admin)).send({ content: 'x', criar: true });
    expect(porCima.status).toBe(409);

    // Editar (sem a flag) segue funcionando no arquivo que passou a existir.
    const editado = await request(app).put(url(novo)).set(authHeader(admin)).send({ content: 'texto v2' });
    expect(editado.status).toBe(200);
    expect(editado.body.criado).toBe(false);
    expect(fs.readFileSync(absOf(novo), 'utf8')).toBe('texto v2');

    fs.unlinkSync(absOf(novo));
  });

  // Onde um arquivo novo pode nascer. O volume é do app: um caminho digitado
  // errado no painel tem de morrer na rota, não virar .md solto que ninguém lê.
  it('criação recusa caminho fora da política (raiz, profundidade, nome)', async () => {
    const admin = await loginAs('admin');
    const recusados = [
      ['outra-pasta/arquivo.md', /avaliacao/i],       // fora das raízes conhecidas
      ['solto.md', /partes/i],                        // sem pasta
      ['avaliacao/a/b/c/fundo.md', /partes/i],        // fundo demais
      ['avaliacao/.oculto.md', /ponto/i],             // segmento começando com ponto
    ];
    for (const [caminho, mensagem] of recusados) {
      const res = await request(app).put(url(caminho)).set(authHeader(admin)).send({ content: 'x', criar: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(mensagem);
      expect(fs.existsSync(absOf(caminho))).toBe(false);
    }
    // Traversal continua barrado antes de tudo (resolvePromptPath).
    expect(promptFiles.validateNewPromptPath('avaliacao/../../fora.md').ok).toBe(false);
    expect(promptFiles.validateNewPromptPath('avaliacao/v34/criterios-no-v34.md').ok).toBe(true);
  });

  // Criar não é um atalho para gravar qualquer coisa: se o caminho tem contrato
  // conhecido, o conteúdo passa pelo mesmo parser da produção.
  it('criação valida o conteúdo quando o caminho tem contrato', async () => {
    const admin = await loginAs('admin');
    const caminho = 'avaliacao/v340/criterios-no-v340.md'; // sem validador (número alto de propósito: nenhuma versão real vai ocupá-lo)
    const semContrato = await request(app).put(url(caminho)).set(authHeader(admin)).send({ content: 'texto livre', criar: true });
    expect(semContrato.status).toBe(200);
    expect(semContrato.body.validado).toBe(false);
    fs.unlinkSync(absOf(caminho));

    // Já um caminho COM contrato é conferido na criação. Todos os caminhos com
    // contrato existem no volume semeado, então tiramos um de lado por um
    // instante — é a única forma de exercitar a CRIAÇÃO de um arquivo que tem
    // parser (criar por cima de arquivo existente é 409, testado acima).
    const guardado = fs.readFileSync(absOf(MISSAO), 'utf8');
    fs.unlinkSync(absOf(MISSAO));
    try {
      const quebrado = await request(app).put(url(MISSAO)).set(authHeader(admin)).send({ content: 'nada de missão aqui', criar: true });
      expect(quebrado.status).toBe(400);
      expect(quebrado.body.error).toMatch(/METACOMANDO|CACHE BREAKPOINT/);
      expect(fs.existsSync(absOf(MISSAO))).toBe(false);

      const ok = await request(app).put(url(MISSAO)).set(authHeader(admin)).send({ content: guardado, criar: true });
      expect(ok.status).toBe(200);
      expect(ok.body.validado).toBe(true);
    } finally {
      fs.writeFileSync(absOf(MISSAO), guardado, 'utf8');
    }
  });

  it('caminho fora do PROMPTS_DIR ou fora de .md é recusado', async () => {
    const admin = await loginAs('admin');
    expect(promptFiles.resolvePromptPath('../../etc/passwd.md')).toBe(null);
    expect(promptFiles.resolvePromptPath('avaliacao/qualquer.txt')).toBe(null);
    const fora = await request(app).get('/api/admin/prompt-versions?path=' + encodeURIComponent('../fora.md')).set(authHeader(admin));
    expect(fora.status).toBe(400);
  });

  // Os validadores saem de PIPELINE_VERSIONS: uma versão nova do pipeline entra
  // na tabela sozinha, sem ninguém editar o prompt-files.js. O que este teste
  // protege é justamente isso — se a derivação quebrar, os .md da versão nova
  // passariam a ser gravados sem conferência nenhuma pelo painel.
  it('os .md de toda ENTRADA do pipeline nascem com contrato', () => {
    const daVersao = [
      ...['prompt-no-v34-montado.md', 'criterios-no-v34.md', 'sintetizador-v34.md'].map((f) => `avaliacao/v34/${f}`),
      // A progressão tem um quarto: o nó da missão, que é uma chamada à parte.
      ...['prompt-no-v34-progressao-montado.md', 'sintetizador-v34-progressao.md', 'missao-v34-progressao.md']
        .map((f) => `avaliacao/v34-progressao/${f}`),
      ...['prompt-no-v34-duelo-montado.md', 'sintetizador-v34-duelo.md'].map((f) => `avaliacao/v34-duelo/${f}`),
    ];
    for (const caminho of daVersao) {
      expect(promptFiles.hasValidator(caminho)).toBe(true);
      const atual = fs.readFileSync(absOf(caminho), 'utf8');
      const ok = promptFiles.validatePromptContent(caminho, atual);
      expect(ok.ok).toBe(true);
      expect(ok.validado).toBe(true);
      // E um Ctrl+V que quebre o contrato é recusado na hora, não na primeira
      // avaliação que rodar depois.
      expect(promptFiles.validatePromptContent(caminho, 'colei outra coisa aqui').ok).toBe(false);
    }

    // Progressão e duelo LEEM os critérios do v34 (`criteriosDe`), então não têm
    // .md de critérios próprio — e registrar um validador para um caminho que não
    // existe no volume seria oferecer ao admin um arquivo fantasma.
    expect(promptFiles.hasValidator('avaliacao/v34-progressao/criterios-no-v34.md')).toBe(false);
    expect(promptFiles.hasValidator('avaliacao/v34-duelo/criterios-no-v34.md')).toBe(false);

    // E os contratos são POR ENTRADA: cada prompt do nó exige os slots do caso da
    // versão dele, e cada sintetizador os slots de log dela. Trocar um pelo outro
    // é recusado — o do v34 não tem {{ATENDIMENTO_1}}, e o do duelo não tem
    // {{LOG}} sozinho.
    const montadoV34 = fs.readFileSync(absOf('avaliacao/v34/prompt-no-v34-montado.md'), 'utf8');
    expect(promptFiles.validatePromptContent('avaliacao/v34-progressao/prompt-no-v34-progressao-montado.md', montadoV34).error)
      .toMatch(/\{\{ATENDIMENTO_1\}\}/);
    expect(promptFiles.validatePromptContent('avaliacao/v34-duelo/prompt-no-v34-duelo-montado.md', montadoV34).error)
      .toMatch(/\{\{ALUNO_A\}\}|\{\{LOG_A\}\}/);
    const sintV34 = fs.readFileSync(absOf('avaliacao/v34/sintetizador-v34.md'), 'utf8');
    expect(promptFiles.validatePromptContent('avaliacao/v34-duelo/sintetizador-v34-duelo.md', sintV34).error)
      .toMatch(/\{\{ALUNO_A\}\}|\{\{LOG_A\}\}/);
  });

  // --- EXCLUSÃO ------------------------------------------------------------
  //
  // O volume é persistente e o deploy não leva prompts: quando um modo sai do
  // app, os .md dele ficam lá para sempre. A exclusão é a saída para isso, e o
  // risco dela é o oposto — apagar um .md que a produção lê quebra a avaliação
  // de todo mundo, e ele não vem no git para repor.
  it('a lista marca quem está EM USO e quem é órfão', async () => {
    const admin = await loginAs('admin');
    const lista = await request(app).get('/api/admin/prompts').set(authHeader(admin));
    // Os .md das três entradas do pipeline, o de Neuro e o do entrevistador.
    for (const emUso of promptFiles.promptsEmUso()) {
      const item = lista.body.files.find((f) => f.path === emUso);
      expect(item, `${emUso} deveria estar no volume`).toBeTruthy();
      expect(item.emUso, `${emUso} deveria estar marcado em uso`).toBe(true);
    }
    // E um arquivo qualquer que ninguém lê é órfão. O nome muda por teste de
    // propósito: prompt-backups/ é um DIRETÓRIO e sobrevive ao resetData (que só
    // apaga arquivos no topo do DATA_DIR), então reusar o caminho faria um teste
    // ler o backup deixado pelo outro.
    const orfao = 'avaliacao/v34/orfao-da-listagem.md';
    await request(app).put(url(orfao)).set(authHeader(admin)).send({ content: 'sobrou de alguma coisa', criar: true });
    const lista2 = await request(app).get('/api/admin/prompts').set(authHeader(admin));
    expect(lista2.body.files.find((f) => f.path === orfao).emUso).toBe(false);
    await request(app).delete(url(orfao)).set(authHeader(admin));
  });

  it('exclui órfão (com backup), e RECUSA o que está em uso', async () => {
    const admin = await loginAs('admin');
    const orfao = 'avaliacao/v34/orfao-da-exclusao.md';
    await request(app).put(url(orfao)).set(authHeader(admin)).send({ content: 'conteúdo que vai sumir', criar: true });
    expect(fs.existsSync(absOf(orfao))).toBe(true);

    const del = await request(app).delete(url(orfao)).set(authHeader(admin));
    expect(del.status).toBe(200);
    expect(fs.existsSync(absOf(orfao))).toBe(false);
    // Saiu do volume, mas o conteúdo continua recuperável pelo histórico — é o
    // que torna a exclusão reversível sem o git.
    const versoes = await request(app).get('/api/admin/prompt-versions?path=' + encodeURIComponent(orfao)).set(authHeader(admin));
    expect(versoes.body.versoes.length).toBeGreaterThan(0);
    const conteudo = promptFiles.readBackup(orfao, versoes.body.versoes[0].id);
    expect(conteudo).toBe('conteúdo que vai sumir');

    // O que a produção lê não sai — nem o prompt do nó, nem os critérios, nem o
    // sintetizador, nem o de Neuro, nem o do entrevistador.
    for (const vivo of promptFiles.promptsEmUso()) {
      const r = await request(app).delete(url(vivo)).set(authHeader(admin));
      expect(r.status, `${vivo} não podia ser excluído`).toBe(409);
      expect(r.body.error).toMatch(/EM USO/i);
      expect(fs.existsSync(absOf(vivo)), `${vivo} continua no volume`).toBe(true);
    }
  });

  it('excluir é admin-only, e arquivo inexistente dá 400', async () => {
    const admin = await loginAs('admin');
    const orfao = 'avaliacao/v34/orfao-do-acesso.md';
    await request(app).put(url(orfao)).set(authHeader(admin)).send({ content: 'x', criar: true });

    for (const quem of ['prof', 'aluno']) {
      const t = await loginAs(quem);
      const r = await request(app).delete(url(orfao)).set(authHeader(t));
      expect(r.status).toBe(403);
    }
    expect(fs.existsSync(absOf(orfao))).toBe(true);

    expect((await request(app).delete(url('avaliacao/v34/nao-existe.md')).set(authHeader(admin))).status).toBe(400);
    // Traversal continua barrado aqui como no resto das rotas de prompt.
    const fora = await request(app).delete('/api/admin/prompts/' + encodeURIComponent('../fora.md')).set(authHeader(admin));
    expect(fora.status).toBe(400);
  });

  // A lista de "em uso" é DERIVADA do código (PIPELINE_VERSIONS + Neuro +
  // entrevistador), e o que a torna confiável é ela apontar para arquivos que
  // existem: um caminho errado ali não daria erro nenhum — só deixaria o .md
  // de verdade excluível e protegeria um fantasma.
  it('todo prompt marcado como EM USO existe mesmo no volume', () => {
    const emUso = promptFiles.promptsEmUso();
    expect(emUso.length).toBeGreaterThanOrEqual(10);
    for (const rel of emUso) {
      expect(fs.existsSync(absOf(rel)), `${rel} está na lista de em-uso mas não existe`).toBe(true);
    }
    // E os três intocáveis por pedido do dono continuam protegidos.
    expect(promptFiles.isPromptEmUso('entrevistador/promptentrevistador.md')).toBe(true);
    expect(promptFiles.isPromptEmUso('avaliacao/avaliador 18/avaliador-v18-25-neuro.md')).toBe(true);
  });

  it('validador: arquivo sem contrato passa; conteúdo vazio nunca', () => {
    expect(promptFiles.validatePromptContent('entrevistador/qualquer.md', 'texto livre').ok).toBe(true);
    expect(promptFiles.validatePromptContent('entrevistador/qualquer.md', 'texto livre').validado).toBe(false);
    expect(promptFiles.validatePromptContent(MONTADO, '   ').ok).toBe(false);
    // criterios-no-v34.md: o contrato é ter os 8 critérios parseáveis.
    const criterios = fs.readFileSync(absOf(CRITERIOS), 'utf8');
    expect(promptFiles.validatePromptContent(CRITERIOS, criterios).ok).toBe(true);
    const truncado = criterios.slice(0, Math.floor(criterios.length / 3));
    expect(promptFiles.validatePromptContent(CRITERIOS, truncado).ok).toBe(false);
  });
});
