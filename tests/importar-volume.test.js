// Importação do volume do sistema em arquivos para o banco
// (server/importar-volume.js), com um volume de exemplo que tem os defeitos de
// dado real: conta excluída ainda referenciada, aluno antes do professor, nome
// repetido só na caixa, log de tipo que não existe mais.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('importação do volume', () => {
  const { importarVolume, relatorioEmTexto } = require('../server/importar-volume');
  const { criarRepoContas } = require('../server/repos/contas');
  const { criarRepoLogs } = require('../server/repos/logs');
  const { criarRepoMmr } = require('../server/repos/mmr');
  const { criarRepoNotificacoes } = require('../server/repos/notificacoes');
  const { criarRepoComunidade } = require('../server/repos/comunidade');
  const { criarRepoSidequests } = require('../server/repos/sidequests');

  let db;
  let dir;

  const escrever = (arquivo, conteudo) => fs.writeFileSync(path.join(dir, arquivo), JSON.stringify(conteudo));

  beforeEach(async () => {
    db = await criarPoolIsolado();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-volume-'));

    escrever('users.json', [
      // Aluno ANTES do professor dele.
      { id: '7', username: 'aluna', name: 'Aluna Sete', role: 'therapist', teacherId: '2', passwordHash: '$2a$04$hash', email: 'Aluna@Exemplo.invalid', emailVerified: true, activeTitle: 'maratonista', criadoEm: '2026-03-01T10:00:00.000Z' },
      { id: '1', username: 'admin', name: 'Admin', role: 'admin', passwordHash: '$2a$04$hash' },
      { id: '2', username: 'prof', name: 'Professora', role: 'supervisor', passwordHash: '$2a$04$hash' },
      // Mesmo nome, só a caixa muda.
      { id: '8', username: 'PROF', name: 'Outra', role: 'external', passwordHash: '$2a$04$hash', email: 'aluna@exemplo.invalid' },
      { id: 'lixo', username: 'x', role: 'therapist' },
    ]);
    escrever('counters.json', { __meta: { lastUserId: 20 }, 7: { micUses: 4 } });
    escrever('logs.json', [
      { id: 'log-1', userId: '7', userName: 'Aluna', type: 'freeplay', mode: 'competitive', itemId: 'fp-1', itemTitle: 'Sofia', score: 72, timestamp: '2026-09-01T10:00:00.000Z', messages: [{ role: 'user', content: 'Oi' }, { role: 'assistant', content: 'Olá' }] },
      // Conta 9 foi excluída do users.json, mas o log dela ficou.
      { id: 'log-2', userId: '9', userName: 'Saiu', type: 'exercise', itemId: 'ex-1', timestamp: '2026-09-02T10:00:00.000Z', messages: [] },
      { id: 'log-3', userId: 'visitor-abc123', type: 'freeplay', itemId: 'fp-1', messages: [] },
      { id: 'log-4', userId: '7', type: 'tipo-que-nao-existe', messages: [] },
    ]);
    escrever('progress.json', { 7: { 'ex-1': { melhor: 80 } } });
    escrever('mmr.json', {
      players: { 7: { P: 61, n: 12, W: [] }, 9: { P: 40, n: 5, W: [] } },
      characters: { 'fp-1': { D: 55, n_D: 7, alpha: null, beta: null, history: [] } },
      anonPlayers: { selecao: { P: 48, n: 30, W: [] } },
      charSources: { 'fp-1': { competitivo: 7 } },
    });
    escrever('notifications.json', { 7: [
      { id: 'n-nova', type: 'admin_notice', message: 'mais recente', read: false, createdAt: '2026-09-10T10:00:00.000Z' },
      { id: 'n-velha', type: 'evaluation_ready', refId: 'log:log-1', read: true, createdAt: '2026-09-01T10:00:00.000Z' },
    ] });
    escrever('comunidade.json', { nextId: 6, discussions: [
      { id: '3', title: 'Transferência', authorId: '7', createdAt: '2026-08-01T10:00:00.000Z', votes: {}, comments: [] },
    ] });
    escrever('settings.json', { selecaoPassword: 'senha-de-producao', aiModels: { competitivo: { evaluator: 'gpt-5.5' } } });
    escrever('sidequests.json', {
      bank: [{ id: 'sq-1', title: 'Silêncio', rewardTitleId: 'qt-sq-1', createdAt: '2026-05-01T10:00:00.000Z' }],
      active: { 7: { sidequestId: 'sq-1', title: 'Silêncio', assignedAt: '2026-09-05T10:00:00.000Z' } },
      completed: { 7: [{ sidequestId: 'sq-0', rewardTitleId: 'qt-sq-0', completedAt: '2026-08-01T10:00:00.000Z' }] },
    });
    escrever('selection-logs.json', [{ id: 'sellog-1', sessionId: 'sel-1', timestamp: new Date().toISOString(), candidate: { whatsapp: '(11) 91234-5678' }, status: 'ativo', score: 70 }]);
    escrever('selection-stats.json', [{ timestamp: '2026-07-01T10:00:00.000Z', score: 70, status: 'ativo' }]);
    escrever('achievements.json', { 7: { primeira_sessao: '2026-04-01T10:00:00.000Z' } });
    escrever('freeplay-characters.json', [
      { id: 'fp-1', name: 'Sofia', specificInstruction: 'prompt' },
      { id: 'fp-2', name: 'Roberto' },
      { name: 'sem id' },
      { id: 'fp-1', name: 'repetido' },
    ]);
    escrever('trilha-skills.json', [{ id: 1, name: 'Hermenêutica', order: 1 }]);
  });

  it('importa os catálogos na ordem, com a marca de semeado, e pula item sem id ou repetido', async () => {
    const r = await importarVolume({ pool: db.pool, dir });
    const { rows } = await db.pool.query(`SELECT tipo, id, doc->>'name' AS nome FROM catalogo_itens ORDER BY tipo, ordem`);
    expect(rows).toEqual([
      { tipo: 'freeplay', id: 'fp-1', nome: 'Sofia' },
      { tipo: 'freeplay', id: 'fp-2', nome: 'Roberto' },
      { tipo: 'trilha_skills', id: '1', nome: 'Hermenêutica' },
    ]);
    expect(r.arquivos['freeplay-characters.json']).toMatchObject({ importados: 2, ignorados: 2 });
    const marcas = (await db.pool.query(`SELECT chave FROM configuracoes WHERE chave LIKE 'catalogo-%' ORDER BY chave`)).rows.map((x) => x.chave);
    expect(marcas).toEqual(['catalogo-freeplay-semeado', 'catalogo-trilha_skills-semeado']);
  });

  afterEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await db.descartar();
  });

  it('importa as contas com professor, lápide, renomeação e sequência de ids', async () => {
    const r = await importarVolume({ pool: db.pool, dir });
    const contas = criarRepoContas(db.pool);

    const aluna = await contas.porUsername('aluna');
    expect(aluna).toMatchObject({ id: '7', teacherId: '2', teacherName: 'Professora', email: 'aluna@exemplo.invalid', emailVerified: true, activeTitle: 'maratonista' });
    expect(aluna.criadoEm).toBe('2026-03-01T10:00:00.000Z');

    // O nome repetido só na caixa entrou renomeado, e o e-mail repetido ficou na primeira conta.
    const outra = await contas.porId('8');
    expect(outra.username).toBe('PROF-8');
    expect(outra.email).toBe('');
    expect(r.avisos.join('\n')).toMatch(/PROF-8/);

    // Conta 9 não existe mais: virou lápide, invisível para o app, e o log dela entrou.
    expect(r.lapides).toEqual(['9']);
    expect(await contas.porId('9')).toBeNull();

    // O próximo id não reaproveita nada até o último já emitido (20).
    const nova = await contas.criar({ username: 'nova', name: 'Nova Conta', role: 'therapist', passwordHash: 'h' });
    expect(nova.id).toBe('21');

    expect(r.arquivos['users.json']).toMatchObject({ importados: 4, ignorados: 1 });
    expect(relatorioEmTexto(r)).toMatch(/users\.json/);
  });

  it('importa logs com mensagens e pula o que o banco não aceita, dizendo por quê', async () => {
    const r = await importarVolume({ pool: db.pool, dir });
    const logs = criarRepoLogs(db.pool);

    const [log] = await logs.listarDoDono('7');
    expect(log).toMatchObject({ id: 'log-1', score: 72, mode: 'competitive' });
    expect(log.messages.map((m) => m.content)).toEqual(['Oi', 'Olá']);
    expect(await logs.listarDoDono('visitor-abc123')).toHaveLength(1);

    expect(r.arquivos['logs.json']).toMatchObject({ importados: 3, ignorados: 1 });
    expect(r.arquivos['logs.json'].motivos[0]).toMatch(/log-4/);
  });

  it('MMR, notificações na ordem do sino, Comunidade com os mesmos ids, sidequests e configurações', async () => {
    await importarVolume({ pool: db.pool, dir });

    const mmr = await criarRepoMmr(db.pool).snapshot();
    expect(mmr.players['7']).toEqual({ P: 61, n: 12, W: [] });
    expect(mmr.characters['fp-1'].D).toBe(55);
    expect(mmr.charSources).toEqual({ 'fp-1': { competitivo: 7 } });

    const sino = await criarRepoNotificacoes(db.pool).doUsuario('7');
    expect(sino.map((n) => [n.id, n.read])).toEqual([['n-nova', false], ['n-velha', true]]);
    expect(sino[1].refId).toBe('log:log-1');

    const comunidade = criarRepoComunidade(db.pool);
    expect((await comunidade.porId('3')).title).toBe('Transferência');
    // A próxima discussão continua a numeração do sistema antigo (nextId 6).
    const nova = await comunidade.criar((id) => ({ id, title: 'nova', authorId: '7', createdAt: new Date().toISOString(), votes: {}, comments: [] }));
    expect(nova.id).toBe('6');

    const sq = criarRepoSidequests(db.pool);
    await sq.semearBancoUmaVez([{ id: 'sq-semente', title: 'não deve entrar' }]);
    await sq.carregar();
    expect(sq.ler().bank.map((s) => s.id)).toEqual(['sq-1']);
    expect(sq.ler().active['7'].title).toBe('Silêncio');
    expect(sq.ler().completed['7']).toHaveLength(1);

    const { rows: [config] } = await db.pool.query(`SELECT valor FROM configuracoes WHERE chave = 'settings'`);
    expect(config.valor.selecaoPassword).toBe('senha-de-producao');

    const { rows: [sel] } = await db.pool.query('SELECT whatsapp, status FROM selecao_logs');
    expect(sel).toEqual({ whatsapp: '11912345678', status: 'ativo' });
  });

  it('recusa banco com dados; --limpar apaga e importa de novo', async () => {
    await importarVolume({ pool: db.pool, dir });
    await expect(importarVolume({ pool: db.pool, dir })).rejects.toThrow(/já tem dados/);

    const r = await importarVolume({ pool: db.pool, dir, limpar: true });
    expect(r.arquivos['users.json'].importados).toBe(4);
  });

  it('arquivo corrompido para a importação em vez de seguir perdendo dado', async () => {
    fs.writeFileSync(path.join(dir, 'logs.json'), '[{"id": ');
    await expect(importarVolume({ pool: db.pool, dir })).rejects.toThrow(/logs\.json não é um JSON válido/);
  });
});
