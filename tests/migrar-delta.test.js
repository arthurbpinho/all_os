// Migração delta do volume antigo para um banco que já tem dados
// (server/migrar-delta.js). O banco de partida imita o que a importação de 22/09
// deixou; o volume traz o que mudou no sistema antigo depois disso — com os
// casos reais encontrados na exploração (senha trocada dos dois lados, nome que
// só difere na caixa, conquista removida, visitante, recorde maior e menor).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('migração delta do volume', () => {
  const { migrarDelta, relatorioEmTexto, CONQUISTAS } = require('../server/migrar-delta');

  let db;
  let dir;
  const escrever = (arquivo, conteudo) => fs.writeFileSync(path.join(dir, arquivo), JSON.stringify(conteudo));
  const q = async (sql, params) => (await db.pool.query(sql, params)).rows;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-delta-'));

    // --- O banco depois da importação de 22/09 ---
    await q(`INSERT INTO users (id, username, name, role, password_hash, token_version, email, criado_em) VALUES
      (1, 'admin', 'Admin', 'admin', 'hash-admin-NOVO', 1, NULL, '2026-09-22T00:00:00Z'),
      (2, 'prof', 'Professora', 'supervisor', 'hash-prof', 0, 'prof@exemplo.invalid', '2026-09-22T00:00:00Z'),
      (3, 'aluna', 'Aluna', 'therapist', 'hash-aluna-velho', 0, 'aluna@exemplo.invalid', '2026-09-22T00:00:00Z'),
      (4, 'Joao-4', 'João', 'external', 'hash-joao', 0, NULL, '2026-09-22T00:00:00Z')`);
    await q(`SELECT setval(pg_get_serial_sequence('users', 'id'), 4)`);
    await q(`INSERT INTO contadores_usuario (user_id, mic_uses) VALUES (3, 10)`);
    await q(`INSERT INTO criterios (regua, nome, ordem) VALUES ('v34', 'Comunicação', 1), ('v34', 'Intensidade', 2)`);
    await q(`INSERT INTO catalogo_itens (tipo, id, ordem, doc) VALUES
      ('freeplay', 'fp-1', 1, '{"id":"fp-1","name":"Sofia","photoIcon":"/patient-photos/fp-1-icon.jpg?v=1"}'),
      ('freeplay', 'fp-2', 2, '{"id":"fp-2","name":"Bia"}')`);
    await q(`INSERT INTO character_records (character_id, score, user_id, user_name, at) VALUES
      ('fp-1', 21, 1, 'Admin', '2026-09-04T00:00:00Z'), ('fp-2', 90, 3, 'Aluna', '2026-09-05T00:00:00Z')`);
    await q(`INSERT INTO configuracoes (chave, valor) VALUES
      ('settings', '{"selecaoPassword":"velha","selecaoPasswordUpdatedAt":"2026-09-21T00:00:00.000Z","visitorEvaluationEnabled":true}')`);
    await q(`INSERT INTO conquistas_resgatadas (user_id, conquista_id, resgatada_em) VALUES (3, 'first_session', '2026-01-01T00:00:00Z')`);
    await q(`INSERT INTO conquistas_vistas (user_id, conquistas) VALUES (1, '{novo_no_app}')`);
    await q(`INSERT INTO mmr_characters (character_id, estado) VALUES ('fp-2', '{"criterios":{"1":{"D":61,"n_D":3,"beta":1,"historico":[]}}}')`);

    // --- O volume antigo hoje ---
    escrever('users.json', [
      // Admin: senha trocada no sistema NOVO (token_version do banco é maior).
      { id: '1', username: 'admin', name: 'Admin', role: 'admin', passwordHash: 'hash-admin-VELHO', tokenVersion: 0, email: '' },
      { id: '2', username: 'prof', name: 'Professora', role: 'supervisor', passwordHash: 'hash-prof', tokenVersion: 0, email: 'prof@exemplo.invalid' },
      // Aluna: trocou a senha e a foto no sistema antigo.
      { id: '3', username: 'aluna', name: 'Aluna', role: 'therapist', teacherId: '2', passwordHash: 'hash-aluna-NOVO', tokenVersion: 2, email: 'Aluna@Exemplo.invalid', emailVerified: true, profilePhoto: 'data:image/jpeg;base64,AAAA' },
      // A importação de 22/09 renomeou para Joao-4: o nome do banco fica.
      { id: '4', username: 'Joao', name: 'João', role: 'external', passwordHash: 'hash-joao', tokenVersion: 0, email: '' },
      // Novas.
      { id: '5', username: 'nova', name: 'Nova', role: 'external', passwordHash: 'hash-nova', email: 'nova@exemplo.invalid', emailVerified: true, consentimento: { termos: { aceito: true, em: '2026-10-01T10:00:00.000Z', versao: '1' } }, origem: { canal: 'instagram', detalhe: '' }, criadoEm: '2026-10-01T10:00:00.000Z' },
      { id: '6', username: 'ADMIN', name: 'Outra', role: 'external', passwordHash: 'h', email: 'PROF@exemplo.invalid' },
      { id: '7', username: 'semdata', name: 'Sem Data', role: 'therapist', teacherId: '2', passwordHash: 'h' },
      { id: 'lixo', username: 'x', role: 'therapist' },
    ]);
    escrever('counters.json', { __meta: { lastUserId: 9 }, 3: { micUses: 4 }, 5: { micUses: 7 } });
    escrever('freeplay-characters.json', [
      { id: 'fp-1', name: 'Sofia', photoIcon: '/patient-photos/fp-1-icon.jpg?v=2' },
      { id: 'fp-2', name: 'Bia' },
      { id: 'fp-3', name: 'Nova paciente' },
    ]);
    escrever('character-records.json', {
      'fp-1': { score: 68, userId: '5', userName: 'Nova', at: '2026-10-02T00:00:00.000Z' },
      'fp-2': { score: 80, userId: '3', userName: 'Aluna', at: '2026-09-05T00:00:00.000Z' },
      'fp-3': { score: 74, userId: '7', userName: 'Sem Data', at: '2026-10-10T00:00:00.000Z' },
      'fp-sumiu': { score: 99, userId: '3', userName: 'Aluna' },
    });
    escrever('settings.json', { selecaoPassword: 'nova', selecaoPasswordUpdatedAt: '2026-09-23T10:00:00.000Z', selecaoPasswordUpdatedBy: 'Avaliadora', aiModelsGlobal: {} });
    escrever('avatar-pool.json', { photos: [{ id: 'p1', url: '/avatar-pool/p1.jpg' }] });
    escrever('achievements.json', {
      3: { first_session: '2026-09-01T00:00:00.000Z', high_score: '2026-05-01T00:00:00.000Z' },
      5: { changed_photo: '2026-10-02T00:00:00.000Z' },
      'visitor-abc123def456': { first_session: '2026-07-01T00:00:00.000Z' },
    });
    escrever('achievement-unlocks.json', { 1: ['first_session'], 5: ['changed_photo'], 7: [] });
    escrever('sidequests.json', {
      bank: [{ id: 'sq-1', title: 'Escuta', createdAt: '2026-05-25T00:00:00.000Z' }],
      active: { 3: { sidequestId: 'sq-1', assignedAt: '2026-05-29T00:00:00.000Z' } },
      completed: { 5: [{ sidequestId: 'sq-1', rewardTitleId: 'qt-1', completedAt: '2026-07-31T00:00:00.000Z' }] },
    });
    escrever('feedback.json', [{ id: 'fb-1', userId: 'visitor-abc', userName: 'Visitante', role: 'visitor', stars: 5, message: '', timestamp: '2026-09-02T00:00:00.000Z' }]);
    escrever('logs.json', [
      { id: 'log1-aaa', userId: '3', userName: 'Aluna', type: 'freeplay', mode: 'competitive', itemId: 'fp-1', itemTitle: 'Sofia',
        durationSeconds: 1800, score: 72, criteriaScores: { 1: 7, 2: 8 }, evaluation: 'texto da avaliação', evalVersion: 'v34',
        evalPartsId: 'av-1-aaaa', evaluationPending: false, evalBatchId: 'batch_1', evalBatchAt: '2026-10-01T10:05:00.000Z',
        mmrBefore: 50, mmrAfter: 54, timestamp: '2026-10-01T10:00:00.000Z',
        messages: [{ role: 'assistant', content: 'Oi.' }, { role: 'user', content: 'Olá, tudo bem?', highlighted: true, comment: 'boa abertura' }] },
      { id: 'log2-bbb', userId: 'visitor-abc123', userName: 'Visitante', type: 'exercise', itemId: 'ex-1', timestamp: '2026-10-02T10:00:00.000Z', messages: [] },
      { id: 'log3-ccc', userId: '3', type: 'tipo-que-nao-existe', messages: [] },
      { id: 'log4-ddd', userId: '99', type: 'freeplay', messages: [] },
    ]);
    escrever('duels.json', [{ id: 'duel-1', token: 'tok-1', status: 'completed', mode: 'training', createdAt: '2026-10-02T12:00:00.000Z',
      challenger: { userId: '3', name: 'Aluna' }, opponent: { userId: '5', name: 'Nova' }, result: { winner: 'challenger' } }]);
    fs.mkdirSync(path.join(dir, 'avaliacoes-criterios'));
    fs.writeFileSync(path.join(dir, 'avaliacoes-criterios', 'av-1-aaaa.json'), '{}');
    fs.writeFileSync(path.join(dir, 'avaliacoes-criterios', 'av-sem-log.json'), '{}');
    escrever('mmr.json', {
      players: { 3: { P: 70 } },
      characters: {
        'fp-1': { D: 47.46, n_D: 34, history: [] },
        'fp-2': { D: 56.2, n_D: 27, history: [] },
        'fp-3': { D: 49.9, n_D: 1, history: [] },
      },
    });
  });

  afterEach(async () => {
    await db.descartar();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a lista de conquistas acompanha a ACHIEVEMENT_DEFS do index.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const inicio = src.indexOf('const ACHIEVEMENT_DEFS');
    const bloco = src.slice(inicio, src.indexOf('];', inicio));
    const ids = [...bloco.matchAll(/\{[^{}]*?id:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect([...CONQUISTAS].sort()).toEqual([...ids].sort());
  });

  it('--dry-run mostra o que mudaria e não grava nada', async () => {
    const antes = await q('SELECT count(*)::int AS n FROM users');
    const rel = await migrarDelta({ pool: db.pool, dir, dryRun: true });
    expect(rel.passos.contas.inseridos).toBe(3);
    expect((await q('SELECT count(*)::int AS n FROM users'))[0].n).toBe(antes[0].n);
    expect((await q(`SELECT count(*)::int AS n FROM catalogo_itens`))[0].n).toBe(2);
    expect(relatorioEmTexto(rel)).toMatch(/SIMULAÇÃO/);
  });

  it('contas: novas entram, senha só pelo token_version maior, username do banco não muda', async () => {
    const rel = await migrarDelta({ pool: db.pool, dir });
    const u = Object.fromEntries((await q('SELECT id::text, username, password_hash, token_version, email, email_verified, profile_photo, teacher_id::text, termos_versao, origem_canal, criado_em FROM users')).map((r) => [r.id, r]));

    // Admin: a senha do banco era mais nova — ficou.
    expect(u[1].password_hash).toBe('hash-admin-NOVO');
    expect(u[1].token_version).toBe(1);
    // Aluna: trocou no sistema antigo — veio, com a foto.
    expect(u[3].password_hash).toBe('hash-aluna-NOVO');
    expect(u[3].token_version).toBe(2);
    expect(u[3].profile_photo).toBe('data:image/jpeg;base64,AAAA');
    expect(u[3].email).toBe('aluna@exemplo.invalid');
    // Joao-4 continua Joao-4.
    expect(u[4].username).toBe('Joao-4');
    // Novas: mesmo id, termos e origem; colisões resolvidas.
    expect(u[5]).toMatchObject({ username: 'nova', email: 'nova@exemplo.invalid', email_verified: true, termos_versao: '1', origem_canal: 'instagram' });
    expect(u[5].criado_em.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(u[6].username).toBe('ADMIN-6');
    expect(u[6].email).toBeNull();
    expect(u[7].teacher_id).toBe('2');
    expect(u.lixo).toBeUndefined();

    expect(rel.passos.contas).toMatchObject({ inseridos: 3, atualizados: 1, rejeitados: 1 });
    expect(rel.avisos.join('\n')).toMatch(/Conta 1: a senha do banco é mais nova/);
    expect(rel.passos.contas.detalhes.join('\n')).toMatch(/conta 3: .*profile_photo.*password_hash, token_version/);

    // Sequência: depois do lastUserId do arquivo (9), nunca para trás.
    const [{ nextval }] = await q(`SELECT nextval(pg_get_serial_sequence('users', 'id'))::int AS nextval`);
    expect(nextval).toBe(10);
  });

  it('recordes, catálogo, configurações e contadores', async () => {
    const rel = await migrarDelta({ pool: db.pool, dir });
    const rec = Object.fromEntries((await q('SELECT character_id, score, user_id::text FROM character_records')).map((r) => [r.character_id, r]));
    expect(rec['fp-1']).toMatchObject({ score: 68, user_id: '5' }); // maior: trocou
    expect(rec['fp-2']).toMatchObject({ score: 90, user_id: '3' }); // banco era maior: ficou
    expect(rec['fp-3']).toMatchObject({ score: 74, user_id: '7' }); // novo
    expect(rec['fp-sumiu']).toBeUndefined();
    expect(rel.passos.recordes).toMatchObject({ inseridos: 1, atualizados: 1, iguais: 1, rejeitados: 1 });

    const cat = Object.fromEntries((await q(`SELECT id, ordem, doc FROM catalogo_itens WHERE tipo = 'freeplay'`)).map((r) => [r.id, r]));
    expect(cat['fp-1'].doc.photoIcon).toBe('/patient-photos/fp-1-icon.jpg?v=2');
    expect(cat['fp-3'].ordem).toBe(3);
    expect(rel.passos['catálogo freeplay']).toMatchObject({ inseridos: 1, atualizados: 1, iguais: 1 });

    const cfg = Object.fromEntries((await q('SELECT chave, valor FROM configuracoes')).map((r) => [r.chave, r.valor]));
    expect(cfg['avatar-pool']).toEqual({ photos: [{ id: 'p1', url: '/avatar-pool/p1.jpg' }] });
    // Só as chaves da senha do seletivo; o resto do bloco é do sistema novo.
    expect(cfg.settings).toEqual({
      selecaoPassword: 'nova', selecaoPasswordUpdatedAt: '2026-09-23T10:00:00.000Z', selecaoPasswordUpdatedBy: 'Avaliadora', visitorEvaluationEnabled: true,
    });

    const cont = Object.fromEntries((await q('SELECT user_id::text, mic_uses FROM contadores_usuario')).map((r) => [r.user_id, r.mic_uses]));
    expect(cont).toEqual({ 3: 10, 5: 7 }); // nunca diminui
  });

  it('senha do seletivo mais nova no banco não é trocada pela do arquivo', async () => {
    await q(`UPDATE configuracoes SET valor = '{"selecaoPassword":"do-app-novo","selecaoPasswordUpdatedAt":"2026-10-20T00:00:00.000Z"}' WHERE chave = 'settings'`);
    const rel = await migrarDelta({ pool: db.pool, dir });
    expect((await q(`SELECT valor FROM configuracoes WHERE chave = 'settings'`))[0].valor.selecaoPassword).toBe('do-app-novo');
    expect(rel.avisos.join('\n')).toMatch(/Senha do seletivo: a do banco .* é mais nova/);
  });

  it('conquistas, sidequests e feedback; visitante e conquista removida vão para os rejeitados', async () => {
    const rel = await migrarDelta({ pool: db.pool, dir });
    const res = (await q('SELECT user_id::text, conquista_id, resgatada_em FROM conquistas_resgatadas ORDER BY 1, 2'));
    expect(res.map((r) => `${r.user_id}/${r.conquista_id}`)).toEqual(['3/first_session', '5/changed_photo']);
    // A do banco ficou com a data dela.
    expect(res[0].resgatada_em.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rel.rejeitados.filter((r) => r.passo !== 'logs').map((r) => r.motivo).sort()).toEqual([
      'conquista removida (já não aparece no sistema antigo)', 'id inválido', 'paciente fora do catálogo', 'visitante não tem conta',
    ]);

    const vistas = Object.fromEntries((await q('SELECT user_id::text, conquistas FROM conquistas_vistas')).map((r) => [r.user_id, r.conquistas]));
    expect(vistas[1]).toEqual(['first_session', 'novo_no_app']); // união com o que o app novo já tinha
    expect(vistas[5]).toEqual(['changed_photo']);
    expect(vistas[7]).toEqual([]);

    expect((await q('SELECT id FROM sidequests_banco')).map((r) => r.id)).toEqual(['sq-1']);
    expect((await q('SELECT user_id::text FROM sidequests_ativas')).map((r) => r.user_id)).toEqual(['3']);
    expect((await q('SELECT user_id::text, recompensa_id FROM sidequests_concluidas'))).toEqual([{ user_id: '5', recompensa_id: 'qt-1' }]);
    expect((await q('SELECT id, user_id, stars FROM feedback'))).toEqual([{ id: 'fb-1', user_id: 'visitor-abc', stars: 5 }]);
  });

  it('dificuldade de partida: só paciente maduro, em todos os critérios ativos, e o que o motor novo mexeu fica', async () => {
    await migrarDelta({ pool: db.pool, dir });
    const est = Object.fromEntries((await q('SELECT character_id, estado, fontes FROM mmr_characters')).map((r) => [r.character_id, r]));
    const ids = (await q('SELECT id::text FROM criterios ORDER BY ordem')).map((r) => r.id);
    expect(Object.keys(est['fp-1'].estado.criterios).sort()).toEqual(ids.sort());
    for (const c of Object.values(est['fp-1'].estado.criterios)) expect(c).toEqual({ D: 47.46, n_D: 0, beta: 1, historico: [] });
    expect(est['fp-1'].fontes).toEqual({});
    expect(est['fp-2'].estado.criterios['1'].D).toBe(61); // o motor novo já tinha mexido
    expect(est['fp-3']).toBeUndefined(); // n_D = 1 no motor antigo: nasce em 50
    // Nada dos alunos: o MMR deles recomeçou do zero.
    expect((await q('SELECT count(*)::int AS n FROM mmr_players'))[0].n).toBe(0);
  });

  it('logs, mensagens e duelos: o log migrado fica igual ao que o app grava', async () => {
    const rel = await migrarDelta({ pool: db.pool, dir });
    expect(rel.passos.logs).toMatchObject({ inseridos: 2, rejeitados: 2 });
    expect(rel.passos['mensagens dos logs']).toMatchObject({ inseridos: 2 });
    expect(rel.passos.duelos).toMatchObject({ inseridos: 1 });

    // O mesmo log, gravado pelo repositório do app com outro id: as linhas têm de bater.
    const { criarRepoLogs } = require('../server/repos/logs');
    const logsRepo = criarRepoLogs(db.pool);
    const original = JSON.parse(fs.readFileSync(path.join(dir, 'logs.json'), 'utf-8'))[0];
    await logsRepo.criar({ ...original, id: 'log1-app' });
    const [a, b] = await Promise.all(['log1-aaa', 'log1-app'].map((id) => logsRepo.porId(id)));
    expect({ ...a, id: 'x' }).toEqual({ ...b, id: 'x' });
    expect(a.messages[1]).toMatchObject({ content: 'Olá, tudo bem?', highlighted: true, comment: 'boa abertura' });

    const visitante = await logsRepo.porId('log2-bbb');
    expect(visitante.userId).toBe('visitor-abc123');
    const motivos = rel.rejeitados.filter((r) => r.passo === 'logs').map((r) => r.motivo).sort();
    expect(motivos).toEqual(['conta 99 inexistente', 'tipo desconhecido "tipo-que-nao-existe"']);

    const [duelo] = await q('SELECT id, token, status, challenger_id, opponent_id FROM duels');
    expect(duelo).toEqual({ id: 'duel-1', token: 'tok-1', status: 'completed', challenger_id: '3', opponent_id: '5' });

    // Só o detalhe que tem log vai para o volume.
    const { arquivosDeDetalhe } = require('../server/migrar-delta');
    expect(arquivosDeDetalhe(dir)).toEqual(['avaliacoes-criterios/av-1-aaaa.json']);
  });

  it('marcação feita depois no sistema antigo chega na segunda rodada, sem duplicar mensagem', async () => {
    await migrarDelta({ pool: db.pool, dir });
    const logs = JSON.parse(fs.readFileSync(path.join(dir, 'logs.json'), 'utf-8'));
    logs[0].messages[0] = { ...logs[0].messages[0], highlighted: true, comment: 'marcado depois' };
    escrever('logs.json', logs);
    const rel = await migrarDelta({ pool: db.pool, dir });
    expect(rel.passos['mensagens dos logs']).toMatchObject({ inseridos: 0, atualizados: 1 });
    expect(rel.passos.logs).toMatchObject({ inseridos: 0, atualizados: 0 });
    const msgs = await q(`SELECT posicao, highlighted, comment FROM log_messages WHERE log_id = 'log1-aaa' ORDER BY posicao`);
    expect(msgs).toEqual([
      { posicao: 1, highlighted: true, comment: 'marcado depois' },
      { posicao: 2, highlighted: true, comment: 'boa abertura' },
    ]);
  });

  it('id que no banco já é de OUTRA pessoa: nada se mistura — a conta e o que pende dela vão para os rejeitados', async () => {
    // Alguém se cadastrou no app novo e pegou o id 5, que o sistema antigo deu a outra pessoa.
    await q(`INSERT INTO users (id, username, name, role, password_hash) VALUES (5, 'cadastro-no-app-novo', 'Outra Pessoa', 'external', 'hash-outra')`);
    const rel = await migrarDelta({ pool: db.pool, dir });
    const [u5] = await q('SELECT username, name, password_hash, email FROM users WHERE id = 5');
    expect(u5).toEqual({ username: 'cadastro-no-app-novo', name: 'Outra Pessoa', password_hash: 'hash-outra', email: null });
    expect(rel.rejeitados.filter((r) => r.chave === '5' || r.chave.startsWith('5/')).map((r) => r.passo).sort())
      .toEqual(['conquistas resgatadas', 'conquistas vistas', 'contadores', 'contas', 'sidequests (concluídas)']);
    // O recorde e o duelo da conta 5 do arquivo também não vão para a pessoa errada.
    expect((await q(`SELECT user_id::text FROM character_records WHERE character_id = 'fp-1'`))[0].user_id).toBe('1');
    expect(await q(`SELECT id FROM duels`)).toEqual([]);
  });

  it('é idempotente: a segunda rodada não insere nem atualiza nada', async () => {
    await migrarDelta({ pool: db.pool, dir });
    const contagem = async () => Object.fromEntries(await Promise.all(
      ['users', 'contadores_usuario', 'catalogo_itens', 'character_records', 'configuracoes', 'conquistas_resgatadas',
        'conquistas_vistas', 'sidequests_banco', 'sidequests_ativas', 'sidequests_concluidas', 'feedback', 'mmr_characters',
        'logs', 'log_messages', 'duels']
        .map(async (t) => [t, (await q(`SELECT count(*)::int AS n FROM ${t}`))[0].n]),
    ));
    const antes = await contagem();
    const rel = await migrarDelta({ pool: db.pool, dir });
    for (const [nome, p] of Object.entries(rel.passos)) {
      expect({ nome, inseridos: p.inseridos, atualizados: p.atualizados }).toEqual({ nome, inseridos: 0, atualizados: 0 });
    }
    expect(await contagem()).toEqual(antes);
  });

  it('arquivo corrompido para a migração antes de gravar', async () => {
    fs.writeFileSync(path.join(dir, 'users.json'), '[{"id": "1",');
    await expect(migrarDelta({ pool: db.pool, dir })).rejects.toThrow(/users.json não é um JSON válido/);
    expect((await q('SELECT count(*)::int AS n FROM users'))[0].n).toBe(4);
  });
});
