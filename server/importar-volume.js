// Importação dos dados do sistema em arquivos (a pasta /data do volume do
// Railway) para o PostgreSQL. Roda UMA vez, na virada, com o banco vazio.
//
// Por que ler o volume e não o export da tela de Administração: o export não
// leva sidequests, Processo Seletivo, configurações, feedback, fila de avaliação
// e outros. A cópia da pasta /data tem tudo.
//
// Dado real de produção é sujo, e a importação não pode morrer no meio por causa
// de um registro. Por isso:
//   · cada registro entra sozinho; o que não cabe no banco é PULADO e listado no
//     relatório, com o motivo;
//   · conta que já foi excluída do users.json mas ainda é referenciada (por um
//     log, por um MMR…) vira uma LÁPIDE, igual à exclusão lógica do app novo:
//     o dado continua ligado a um id, e a pessoa não é identificável;
//   · o professor é ligado numa segunda passada (o aluno pode vir antes dele no
//     arquivo);
//   · nome de usuário que só difere na caixa (`Joao` e `joao`) é renomeado com o
//     id, e e-mail repetido fica na primeira conta — os dois casos saem no
//     relatório.
//
// Os catálogos (pacientes, exercícios, neuro, trilha) também entram, com a
// marca de semeado. Ficam FORA, de propósito: os prompts, que entram sozinhos no primeiro boot a
// partir do mesmo volume; e os links pendentes de e-mail (cadastro, nova senha,
// troca de e-mail), que duram horas — quem estava no meio pede de novo.

const fs = require('fs');
const path = require('path');
const { criarRepoLogs } = require('./repos/logs');
const { criarRepoDuelos } = require('./repos/duelos');
const { criarRepoMmr } = require('./repos/mmr');
const { criarRepoSessoes } = require('./repos/sessoes');
const { criarRepoJobs } = require('./repos/jobs');
const { normalizeUsername, normalizeEmail } = require('./cadastro');
const { ARQUIVOS: ARQUIVOS_CATALOGO } = require('./catalogo');
const { marcaSemeado } = require('./repos/catalogo');

// Tabelas de dados. Os prompts ficam de fora: o boot os semeia do volume, e
// apagá-los aqui jogaria fora o histórico de versões.
const TABELAS_DE_DADOS = [
  'users', 'pending_registrations', 'password_resets', 'email_changes',
  'logs', 'log_messages', 'progress',
  'mmr_players', 'mmr_characters', 'mmr_anon_players', 'character_records', 'duels',
  'sessoes_ativas', 'sessao_ativa_mensagens', 'cota_sessoes', 'batches_em_voo', 'jobs',
  'notificacoes', 'push_inscricoes', 'conquistas_resgatadas', 'conquistas_vistas',
  'contadores_usuario', 'sequencia_missoes_diarias', 'erros', 'feedback', 'configuracoes',
  'sidequests_banco', 'sidequests_ativas', 'sidequests_concluidas', 'antessala_mapas',
  'selecao_logs', 'selecao_estatisticas', 'comunidade_discussoes', 'tags', 'user_tags', 'uso_ia', 'uso_ia_alertas', 'catalogo_itens',
];

const PAPEIS = ['admin', 'supervisor', 'therapist', 'external', 'evaluator'];
const PAPEIS_ALUNO = ['therapist', 'external'];
const ID_CONTA = /^[0-9]{1,18}$/;
const ehConta = (id) => ID_CONTA.test(String(id ?? ''));

const FILAS = {
  'trilha-eval-queue.json': 'trilha-avaliacao',
  'avaliacao-fila.json': 'avaliacao-fila',
  'avaliacao-v25.json': 'avaliacao-resultados',
  'benchmark-fila.json': 'benchmark-fila',
  'benchmark-lotes.json': 'benchmark-lotes',
};

// Data válida em ISO, ou null.
function data(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = (v) => (Array.isArray(v) ? v : []);

async function importarVolume({ pool, dir, limpar = false }) {
  const relatorio = { arquivos: {}, ausentes: [], lapides: [], avisos: [] };
  const conta = (arquivo) => {
    if (!relatorio.arquivos[arquivo]) relatorio.arquivos[arquivo] = { importados: 0, ignorados: 0, motivos: [] };
    return relatorio.arquivos[arquivo];
  };
  const ok = (arquivo, n = 1) => { conta(arquivo).importados += n; };
  const pulou = (arquivo, qual, motivo) => {
    const c = conta(arquivo);
    c.ignorados += 1;
    if (c.motivos.length < 20) c.motivos.push(`${qual}: ${motivo}`);
  };

  function ler(arquivo, padrao) {
    const p = path.join(dir, arquivo);
    if (!fs.existsSync(p)) {
      relatorio.ausentes.push(arquivo);
      return padrao;
    }
    // Arquivo corrompido PARA a importação: seguir em frente perderia dado sem aviso.
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      throw new Error(`${arquivo} não é um JSON válido: ${e.message}`);
    }
  }

  // Tenta gravar um registro; o que falhar vira "ignorado" com o motivo do banco.
  async function registro(arquivo, qual, fn) {
    try {
      await fn();
      ok(arquivo);
    } catch (e) {
      pulou(arquivo, qual, e.message);
    }
  }

  // --- 0. Banco vazio ---
  const { rows: [{ ocupado }] } = await pool.query(
    'SELECT EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM logs) AS ocupado',
  );
  if (ocupado && !limpar) {
    throw new Error('O banco já tem dados. A importação é para um banco vazio (use --limpar para apagar os dados e importar de novo).');
  }
  if (limpar) await pool.query(`TRUNCATE ${TABELAS_DE_DADOS.join(', ')} RESTART IDENTITY CASCADE`);

  // --- 1. Contas ---
  const idsImportados = new Set();
  const lapides = new Set();
  const nomesUsados = new Set();
  const emailsUsados = new Set();
  const usuarios = lista(ler('users.json', []));

  for (const u of usuarios) {
    const id = String(u && u.id);
    if (!ehConta(id)) { pulou('users.json', id, 'id inválido'); continue; }
    if (idsImportados.has(id)) { pulou('users.json', id, 'id repetido'); continue; }
    if (!PAPEIS.includes(u.role)) { pulou('users.json', id, `papel desconhecido "${u.role}"`); continue; }

    let username = String(u.username || '').trim() || `usuario-${id}`;
    if (nomesUsados.has(normalizeUsername(username))) {
      const original = username;
      username = `${username}-${id}`;
      relatorio.avisos.push(`Conta ${id}: nome "${original}" já existia (diferença só de maiúsculas) — renomeada para "${username}".`);
    }
    let email = normalizeEmail(u.email) || null;
    if (email && emailsUsados.has(email)) {
      relatorio.avisos.push(`Conta ${id}: e-mail ${email} já pertence a outra conta — importada sem e-mail.`);
      email = null;
    }
    const termos = u.consentimento && u.consentimento.termos;
    await registro('users.json', id, async () => {
      await pool.query(
        `INSERT INTO users (id, username, name, role, password_hash, token_version, email, email_verified,
           gender, profile_photo, visual_description, share_appearance, sidequests_enabled, abordagem,
           active_title, update_all_os, update_allos, origem_canal, origem_detalhe,
           termos_aceito_em, termos_versao, criado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, COALESCE($22::timestamptz, now()))`,
        [
          id, username, String(u.name || ''), u.role, String(u.passwordHash || ''),
          Number.isInteger(u.tokenVersion) ? u.tokenVersion : 0,
          email, !!(email && u.emailVerified),
          String(u.gender || ''), String(u.profilePhoto || ''),
          u.visualDescription == null ? null : String(u.visualDescription),
          u.shareAppearance == null ? null : !!u.shareAppearance,
          u.sidequestsEnabled !== false, String(u.abordagem || '').slice(0, 120),
          String(u.activeTitle || ''), !!u.updateAllOS, !!u.updateAllos,
          u.origem && u.origem.canal ? String(u.origem.canal) : null,
          u.origem && u.origem.canal ? String(u.origem.detalhe || '') : null,
          termos ? data(termos.em) : null, termos && data(termos.em) ? String(termos.versao || '1') : null,
          data(u.criadoEm),
        ],
      );
      idsImportados.add(id);
      nomesUsados.add(normalizeUsername(username));
      if (email) emailsUsados.add(email);
    });
  }

  // Professor na segunda passada.
  for (const u of usuarios) {
    const id = String(u && u.id);
    if (!idsImportados.has(id) || !u.teacherId) continue;
    const professor = String(u.teacherId);
    if (!PAPEIS_ALUNO.includes(u.role)) {
      relatorio.avisos.push(`Conta ${id}: tinha professor mas não é aluno (${u.role}) — vínculo ignorado.`);
    } else if (!idsImportados.has(professor)) {
      relatorio.avisos.push(`Conta ${id}: professor ${professor} não existe — importada sem professor.`);
    } else {
      await pool.query('UPDATE users SET teacher_id = $2 WHERE id = $1', [id, professor]);
    }
  }

  // Conta referenciada que não está no users.json: foi excluída. Vira lápide.
  async function garantirConta(id) {
    const s = String(id);
    if (!ehConta(s) || idsImportados.has(s) || lapides.has(s)) return;
    await pool.query(
      `INSERT INTO users (id, username, name, role, password_hash, excluido_em)
       VALUES ($1::bigint, '#excluida-' || $1::text, '', 'therapist', '', now()) ON CONFLICT DO NOTHING`,
      [s],
    );
    lapides.add(s);
  }

  // --- 2. Logs e progresso ---
  const logsRepo = criarRepoLogs(pool);
  for (const log of lista(ler('logs.json', []))) {
    await registro('logs.json', log && log.id, async () => {
      if (ehConta(log.userId)) await garantirConta(log.userId);
      await logsRepo.criar(log);
    });
  }

  for (const [dono, chaves] of Object.entries(objeto(ler('progress.json', {})))) {
    const coluna = ehConta(dono) ? 'user_id' : (/^visitor-[\w-]{1,64}$/.test(dono) ? 'visitante_id' : null);
    if (!coluna) { pulou('progress.json', dono, 'dono inválido'); continue; }
    await registro('progress.json', dono, async () => {
      if (coluna === 'user_id') await garantirConta(dono);
      for (const [chave, valor] of Object.entries(objeto(chaves))) {
        await pool.query(`INSERT INTO progress (${coluna}, chave, valor) VALUES ($1, $2, $3)`, [dono, chave, JSON.stringify(valor ?? null)]);
      }
    });
  }

  // --- 3. MMR, recordes e duelos ---
  const mmr = objeto(ler('mmr.json', {}));
  const jogadores = {};
  for (const [id, estado] of Object.entries(objeto(mmr.players))) {
    if (!ehConta(id)) { pulou('mmr.json', id, 'jogador com id inválido'); continue; }
    await garantirConta(id);
    jogadores[id] = estado;
  }
  await registro('mmr.json', 'estado', () => criarRepoMmr(pool).importar({
    players: jogadores,
    characters: objeto(mmr.characters),
    anonPlayers: objeto(mmr.anonPlayers),
    charSources: objeto(mmr.charSources),
  }));

  for (const [characterId, r] of Object.entries(objeto(ler('character-records.json', {})))) {
    await registro('character-records.json', characterId, async () => {
      if (ehConta(r.userId)) await garantirConta(r.userId);
      await pool.query(
        `INSERT INTO character_records (character_id, score, user_id, user_name, user_photo, at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))`,
        [characterId, Number(r.score), ehConta(r.userId) ? String(r.userId) : null, String(r.userName || ''), r.userPhoto || null, data(r.at)],
      );
    });
  }

  const duelosRepo = criarRepoDuelos(pool);
  for (const d of lista(ler('duels.json', []))) {
    await registro('duels.json', d && d.id, () => duelosRepo.criar(d));
  }

  // --- 4. Sessões em andamento, cota e filas ---
  const sessoesRepo = criarRepoSessoes(pool);
  for (const [chave, s] of Object.entries(objeto(ler('active-sessions.json', {})))) {
    await registro('active-sessions.json', chave, async () => {
      if (ehConta(s.userId)) await garantirConta(s.userId);
      await sessoesRepo.salvar(s.userId, {
        tipo: s.type, itemId: s.itemId, messages: s.messages, elapsedSeconds: s.elapsedSeconds,
        threadId: s.threadId, itemTitle: s.itemTitle, neuroTests: s.neuroTests,
      });
      if (data(s.lastSavedAt)) {
        await pool.query(
          `UPDATE sessoes_ativas SET ultimo_salvamento = $4
           WHERE COALESCE(user_id::text, visitante_id) = $1 AND tipo = $2 AND item_id = $3`,
          [String(s.userId), s.type, String(s.itemId), data(s.lastSavedAt)],
        );
      }
    });
  }

  for (const [userId, inicios] of Object.entries(objeto(ler('external-session-starts.json', {})))) {
    if (!ehConta(userId)) { pulou('external-session-starts.json', userId, 'id inválido'); continue; }
    await registro('external-session-starts.json', userId, async () => {
      await garantirConta(userId);
      for (const r of lista(inicios)) {
        const t = typeof r === 'object' && r ? r.t : r;
        const chave = typeof r === 'object' && r && typeof r.key === 'string' ? r.key : null;
        if (!data(t)) continue;
        await pool.query('INSERT INTO cota_sessoes (user_id, iniciado_em, chave) VALUES ($1, $2, $3)', [userId, data(t), chave]);
      }
    });
  }

  for (const e of lista(ler('batch-ledger.json', []))) {
    await registro('batch-ledger.json', e && e.batchId, () => pool.query(
      `INSERT INTO batches_em_voo (batch_id, model, tokens, modo, criado_em)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now())) ON CONFLICT DO NOTHING`,
      [String(e.batchId), String(e.model || ''), Math.round(Number(e.tokens) || 0), e.modo || null, data(e.criadoEm)],
    ));
  }

  const jobsRepo = criarRepoJobs(pool);
  for (const [arquivo, fila] of Object.entries(FILAS)) {
    for (const doc of lista(ler(arquivo, []))) {
      await registro(arquivo, doc && doc.id, () => jobsRepo.fila(fila).criar(doc));
    }
  }

  // --- 5. Notificações, push, conquistas e contadores ---
  for (const [userId, itens] of Object.entries(objeto(ler('notifications.json', {})))) {
    if (!ehConta(userId)) { pulou('notifications.json', userId, 'id inválido'); continue; }
    await garantirConta(userId);
    // O arquivo guarda a mais recente primeiro; a ordem do sino é a de inserção.
    for (const n of [...lista(itens)].reverse()) {
      const { id, createdAt, read, refId, ...doc } = objeto(n);
      await registro('notifications.json', id, () => pool.query(
        `INSERT INTO notificacoes (id, user_id, ref_id, lida, criado_em, doc)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6)`,
        [String(id), userId, refId || null, !!read, data(createdAt), JSON.stringify(doc)],
      ));
    }
  }

  for (const [userId, subs] of Object.entries(objeto(ler('push-subscriptions.json', {})))) {
    if (!ehConta(userId)) continue;
    await garantirConta(userId);
    for (const s of lista(subs)) {
      await registro('push-subscriptions.json', userId, () => pool.query(
        `INSERT INTO push_inscricoes (user_id, endpoint, p256dh, auth, ua, criado_em)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) ON CONFLICT DO NOTHING`,
        [userId, s.endpoint, s.keys && s.keys.p256dh, s.keys && s.keys.auth, s.ua || null, data(s.createdAt)],
      ));
    }
  }

  for (const [userId, mapa] of Object.entries(objeto(ler('achievements.json', {})))) {
    if (!ehConta(userId)) continue;
    await garantirConta(userId);
    for (const [conquista, em] of Object.entries(objeto(mapa))) {
      await registro('achievements.json', `${userId}/${conquista}`, () => pool.query(
        `INSERT INTO conquistas_resgatadas (user_id, conquista_id, resgatada_em)
         VALUES ($1, $2, COALESCE($3::timestamptz, now()))`,
        [userId, conquista, data(em)],
      ));
    }
  }

  for (const [userId, ids] of Object.entries(objeto(ler('achievement-unlocks.json', {})))) {
    if (!ehConta(userId)) continue;
    await registro('achievement-unlocks.json', userId, async () => {
      await garantirConta(userId);
      await pool.query('INSERT INTO conquistas_vistas (user_id, conquistas) VALUES ($1, $2)', [userId, lista(ids).map(String)]);
    });
  }

  // counters.json: contadores por conta + `__meta.lastUserId`, o último id já
  // emitido. Ids de conta nunca voltam (CLAUDE.md §5.2), então a sequência do
  // banco começa depois do maior dos dois.
  const contadores = objeto(ler('counters.json', {}));
  const ultimoIdEmitido = Number(objeto(contadores.__meta).lastUserId) || 0;
  for (const [userId, c] of Object.entries(contadores)) {
    if (userId === '__meta' || !ehConta(userId)) continue;
    await registro('counters.json', userId, async () => {
      await garantirConta(userId);
      await pool.query('INSERT INTO contadores_usuario (user_id, mic_uses) VALUES ($1, $2)', [userId, Math.max(0, Math.round(Number(objeto(c).micUses) || 0))]);
    });
  }

  for (const [userId, s] of Object.entries(objeto(ler('daily-missions.json', {})))) {
    if (!ehConta(userId)) continue;
    await registro('daily-missions.json', userId, async () => {
      await garantirConta(userId);
      await pool.query(
        'INSERT INTO sequencia_missoes_diarias (user_id, atual, melhor, ultima_data) VALUES ($1, $2, $3, $4)',
        [userId, Math.round(Number(s.current) || 0), Math.round(Number(s.best) || 0), s.lastDate || null],
      );
    });
  }

  // --- 6. Operação ---
  for (const e of lista(ler('error-logs.json', []))) {
    await registro('error-logs.json', e && e.id, () => pool.query(
      'INSERT INTO erros (id, criado_em, entrada) VALUES ($1, COALESCE($2::timestamptz, now()), $3) ON CONFLICT DO NOTHING',
      [String(e.id), data(e.timestamp), JSON.stringify(e)],
    ));
  }

  for (const f of lista(ler('feedback.json', []))) {
    await registro('feedback.json', f && f.id, () => pool.query(
      `INSERT INTO feedback (id, criado_em, user_id, user_name, role, stars, message)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7)`,
      [String(f.id), data(f.timestamp), f.userId == null ? null : String(f.userId), String(f.userName || ''),
        String(f.role || ''), Math.round(Number(f.stars) || 0), String(f.message || '')],
    ));
  }

  const configs = [
    ['settings.json', 'settings', (v) => objeto(v)],
    ['avatar-pool.json', 'avatar-pool', (v) => ({ photos: lista(objeto(v).photos) })],
    // A chave `visitorAvatars` é de uma migração antiga que não vem junto.
    ['comunidade-config.json', 'comunidade-config', (v) => { const { visitorAvatars, ...resto } = objeto(v); return resto; }],
  ];
  for (const [arquivo, chave, formatar] of configs) {
    const valor = ler(arquivo, undefined);
    if (valor === undefined) continue;
    await registro(arquivo, chave, () => pool.query(
      'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)', [chave, JSON.stringify(formatar(valor))],
    ));
  }

  // --- 6b. Catálogos (pacientes, neuro, exercícios, competências da Trilha) ---
  // Entram com a marca de "semeado" (015_catalogo.sql): o boot do app novo não
  // põe os padrões por cima. Item sem id ou com id repetido é pulado — o app não
  // teria como editá-lo nem excluí-lo.
  for (const [tipo, arquivo] of Object.entries(ARQUIVOS_CATALOGO)) {
    const itens = ler(arquivo, undefined);
    if (itens === undefined) continue;
    const validos = [];
    const ids = new Set();
    for (const item of lista(itens)) {
      const id = item && item.id != null ? String(item.id) : '';
      if (!id) { pulou(arquivo, '(sem id)', 'item sem id'); continue; }
      if (ids.has(id)) { pulou(arquivo, id, 'id repetido (ficou o primeiro)'); continue; }
      ids.add(id);
      validos.push(item);
    }
    await pool.query(
      `INSERT INTO catalogo_itens (tipo, id, ordem, doc)
       SELECT $1, t.x->>'id', t.ord::int, t.x FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(x, ord)`,
      [tipo, JSON.stringify(validos)],
    );
    ok(arquivo, validos.length);
    await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ($1, 'true') ON CONFLICT DO NOTHING`, [marcaSemeado(tipo)]);
  }

  // --- 7. Sidequests e Antessala ---
  const sidequests = ler('sidequests.json', undefined);
  if (sidequests !== undefined) {
    // O banco de sidequests do sistema antigo é o que vale: a semente do app novo não entra por cima.
    await pool.query(`INSERT INTO configuracoes (chave, valor) VALUES ('sidequests-banco-semeado', 'true') ON CONFLICT DO NOTHING`);
    const sq = objeto(sidequests);
    for (const s of lista(sq.bank)) {
      await registro('sidequests.json', `banco/${s && s.id}`, () => pool.query(
        'INSERT INTO sidequests_banco (id, criado_em, doc) VALUES ($1, COALESCE($2::timestamptz, now()), $3)',
        [String(s.id), data(s.createdAt), JSON.stringify(s)],
      ));
    }
    for (const [userId, doc] of Object.entries(objeto(sq.active))) {
      if (!ehConta(userId)) continue;
      await registro('sidequests.json', `ativa/${userId}`, async () => {
        await garantirConta(userId);
        await pool.query(
          'INSERT INTO sidequests_ativas (user_id, atribuida_em, doc) VALUES ($1, COALESCE($2::timestamptz, now()), $3)',
          [userId, data(doc.assignedAt), JSON.stringify(doc)],
        );
      });
    }
    for (const [userId, docs] of Object.entries(objeto(sq.completed))) {
      if (!ehConta(userId)) continue;
      await garantirConta(userId);
      for (const doc of lista(docs)) {
        await registro('sidequests.json', `concluida/${userId}`, () => pool.query(
          'INSERT INTO sidequests_concluidas (user_id, recompensa_id, concluida_em, doc) VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4)',
          [userId, doc.rewardTitleId || null, data(doc.completedAt), JSON.stringify(doc)],
        ));
      }
    }
  }

  for (const m of lista(ler('antessala.json', []))) {
    await registro('antessala.json', m && m.id, async () => {
      if (!ehConta(m.ownerId)) throw new Error('dono inválido');
      await garantirConta(m.ownerId);
      const criado = data(m.createdAt) || new Date().toISOString();
      await pool.query(
        `INSERT INTO antessala_mapas (id, owner_id, status, criado_em, atualizado_em, doc)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [String(m.id), String(m.ownerId), m.status, criado, data(m.updatedAt) || criado, JSON.stringify(m)],
      );
    });
  }

  // --- 8. Processo Seletivo ---
  for (const l of lista(ler('selection-logs.json', []))) {
    await registro('selection-logs.json', l && l.id, () => pool.query(
      `INSERT INTO selecao_logs (id, session_id, criado_em, whatsapp, status, eval_batch_id, doc)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7)`,
      [String(l.id), String(l.sessionId || l.id), data(l.timestamp),
        String((l.candidate && l.candidate.whatsapp) || '').replace(/\D+/g, ''),
        String(l.status || 'pending'), l.evalBatchId || null, JSON.stringify(l)],
    ));
  }
  for (const s of lista(ler('selection-stats.json', []))) {
    await registro('selection-stats.json', s && s.timestamp, () => pool.query(
      'INSERT INTO selecao_estatisticas (criado_em, score, status) VALUES (COALESCE($1::timestamptz, now()), $2, $3)',
      [data(s.timestamp), s.score == null ? null : Number(s.score), String(s.status || '')],
    ));
  }

  // --- 9. Comunidade ---
  // Os ids ficam os mesmos: estão nos links que já circularam por WhatsApp.
  const comunidade = objeto(ler('comunidade.json', {}));
  for (const d of lista(comunidade.discussions)) {
    await registro('comunidade.json', d && d.id, () => {
      if (!ehConta(d.id)) throw new Error('id de discussão inválido');
      return pool.query(
        'INSERT INTO comunidade_discussoes (id, author_id, criado_em, doc) VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4)',
        [String(d.id), d.authorId == null ? null : String(d.authorId), data(d.createdAt), JSON.stringify(d)],
      );
    });
  }
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('comunidade_discussoes', 'id'),
       GREATEST(COALESCE((SELECT max(id) FROM comunidade_discussoes), 0), $1::bigint, 1),
       GREATEST(COALESCE((SELECT max(id) FROM comunidade_discussoes), 0), $1::bigint) > 0)`,
    [Math.max(0, (Number(comunidade.nextId) || 1) - 1)],
  );

  // --- 10. Sequência de ids de conta ---
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('users', 'id'),
       GREATEST(COALESCE((SELECT max(id) FROM users), 0), $1::bigint, 1),
       GREATEST(COALESCE((SELECT max(id) FROM users), 0), $1::bigint) > 0)`,
    [ultimoIdEmitido],
  );

  relatorio.lapides = [...lapides];
  return relatorio;
}

// Relatório em texto, para o terminal.
function relatorioEmTexto(r) {
  const linhas = ['Importação concluída.', ''];
  for (const [arquivo, c] of Object.entries(r.arquivos)) {
    linhas.push(`${arquivo.padEnd(30)} ${String(c.importados).padStart(6)} importado(s)${c.ignorados ? `, ${c.ignorados} ignorado(s)` : ''}`);
    for (const m of c.motivos) linhas.push(`    - ${m}`);
  }
  if (r.lapides.length) linhas.push('', `Contas excluídas que ainda eram referenciadas (viraram lápide): ${r.lapides.join(', ')}`);
  if (r.avisos.length) linhas.push('', 'Avisos:', ...r.avisos.map((a) => `  - ${a}`));
  if (r.ausentes.length) linhas.push('', `Arquivos que não existiam no volume (nada a importar): ${r.ausentes.join(', ')}`);
  return linhas.join('\n');
}

module.exports = { importarVolume, relatorioEmTexto, TABELAS_DE_DADOS };
