// Migração DELTA do volume do sistema antigo (a pasta /data em JSON) para um
// banco que JÁ TEM dados — a segunda passada depois da importação de 22/09
// (server/importar-volume.js, que exige banco vazio). Decisões em demandas.md §26.
//
// Não cria nem altera tabela: só insere e atualiza linhas das tabelas que já
// existem. Tudo roda numa transação só; com `dryRun` ela é desfeita no fim e o
// relatório mostra o que teria mudado.
//
// Idempotente: cada passo é um INSERT … ON CONFLICT que só regrava a linha que
// de fato mudou. Rodar duas vezes com a mesma pasta não muda nada na segunda.
//
// Quem ganha um conflito (a mesma linha mudou nos dois lados):
//   · o sistema antigo é a verdade até a virada — é onde os alunos estão;
//   · exceto senha: vale o lado com `token_version` maior (é ela que sobe a cada
//     troca de senha). Com o mesmo número e hash diferente, fica o do banco;
//   · username de conta que já está no banco nunca muda (a importação de 22/09
//     renomeou colisões de caixa, e a pessoa já foi avisada);
//   · senha do Processo Seletivo: vale a de `selecaoPasswordUpdatedAt` mais novo;
//   · recorde 👑: só troca por nota MAIOR (a regra do app, repos/mmr.js);
//   · conquista resgatada, feedback e dificuldade semeada: o que já está no banco
//     fica.
//
// Logs de atendimento (com as mensagens) e duelos entram desde 2026-10-13, tarde:
// o dono quis guardar o histórico de todo mundo. O detalhe por critério de cada
// avaliação mora no volume (avaliacoes-criterios/) e vai pelo
// scripts/sincronizar-fotos-delta.sh.
//
// O que fica de fora, de propósito (decisão do dono, 2026-10-13): logs e
// dashboard do seletivo, Comunidade, logs de erro, sessões em andamento, filas
// internas, Antessala, push, missões diárias, progresso da Trilha, notificações e
// o MMR dos alunos (o motor recomeçou do zero na migração 017).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAPEIS = ['admin', 'supervisor', 'therapist', 'external', 'evaluator'];
const PAPEIS_ALUNO = ['therapist', 'external'];
const ID_CONTA = /^[0-9]{1,18}$/;
const ehConta = (id) => ID_CONTA.test(String(id ?? ''));

// As conquistas que existem (ACHIEVEMENT_DEFS em server/index.js). Resgate de id
// fora daqui é de uma conquista removida — não aparece nem no sistema antigo — e
// vai para os rejeitados. Um teste garante que esta lista acompanha o index.js.
const CONQUISTAS = [
  'first_session', 'first_ranked', 'madrugador', 'changed_photo', 'invited_friend', 'constancia',
  'papagaio', 'eficiencia', 'bom_garoto', 'centena', 'persistencia', 'duelista', 'consistente',
  'simulacao_complete', 'excelencia', 'perfeicao', 'meteu_o_lacan', 'estrelinha', 'invicto', 'davi_golias',
];

const CATALOGOS = [
  ['freeplay', 'freeplay-characters.json'],
  ['neuro', 'neuro-characters.json'],
  ['exercicios', 'exercises.json'],
  ['trilha_skills', 'trilha-skills.json'],
];

// Paciente que amadureceu no motor antigo (n_D ≥ 20) dá a dificuldade de partida
// do motor novo; o resto nasce em 50, como a spec §11 manda.
const N_D_MADURO = 20;

const CHAVES_SENHA_SELECAO = ['selecaoPassword', 'selecaoPasswordUpdatedAt', 'selecaoPasswordUpdatedBy'];

const TIPOS_LOG = ['exercise', 'freeplay', 'neuro'];
const MODOS_LOG = ['training', 'competitive'];
const ID_VISITANTE = /^visitor-[\w-]{1,64}$/;

// Os mesmos normalizadores de server/repos/logs.js (criar): o log migrado tem de
// ficar igual ao que o app grava. Um teste compara os dois caminhos.
const numeroOuNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const inteiroOuNull = (v) => { const n = numeroOuNull(v); return n === null ? null : Math.trunc(n); };
const textoOuNull = (v) => (v == null ? null : String(v));
const jsonOuNull = (v) => (v === undefined ? null : v);

// Colunas de `logs`, na ordem do INSERT, com o campo do JSON e o normalizador.
const COLUNAS_LOG = [
  ['user_name', (l) => String(l.userName ?? '')],
  ['type', (l) => l.type],
  ['mode', (l) => l.mode || 'training'],
  ['item_id', (l) => String(l.itemId ?? '')],
  ['item_title', (l) => String(l.itemTitle ?? '')],
  ['skill_id', (l) => inteiroOuNull(l.skillId)],
  ['difficulty', (l) => textoOuNull(l.difficulty)],
  ['duration_seconds', (l) => inteiroOuNull(l.durationSeconds) ?? 0],
  ['image_schema', (l) => textoOuNull(l.imageSchema)],
  ['cost', (l) => jsonOuNull(l.cost)],
  ['neuro_tests', (l) => jsonOuNull(l.neuroTests)],
  ['score', (l) => numeroOuNull(l.score)],
  ['criteria_scores', (l) => jsonOuNull(l.criteriaScores)],
  ['criteria_names', (l) => jsonOuNull(l.criteriaNames)],
  ['evaluation', (l) => String(l.evaluation ?? '')],
  ['eval_version', (l) => textoOuNull(l.evalVersion)],
  ['eval_parts_id', (l) => textoOuNull(l.evalPartsId)],
  ['evaluation_pending', (l) => !!l.evaluationPending],
  ['eval_batch_id', (l) => textoOuNull(l.evalBatchId)],
  ['eval_batch_at', (l) => textoOuNull(l.evalBatchAt)],
  ['eval_batch_tentativas', (l) => inteiroOuNull(l.evalBatchTentativas)],
  ['eval_batch_espera', (l) => textoOuNull(l.evalBatchEspera)],
  ['eval_attempts', (l) => inteiroOuNull(l.evalAttempts)],
  ['eval_error', (l) => textoOuNull(l.evalError)],
  ['mmr_before', (l) => inteiroOuNull(l.mmrBefore)],
  ['mmr_after', (l) => inteiroOuNull(l.mmrAfter)],
  ['mmr_delta', (l) => jsonOuNull(l.mmrDelta)],
];
const TIPOS_COLUNA_LOG = {
  user_name: 'text', type: 'text', mode: 'text', item_id: 'text', item_title: 'text', skill_id: 'int',
  difficulty: 'text', duration_seconds: 'int', image_schema: 'text', cost: 'jsonb', neuro_tests: 'jsonb',
  score: 'float8', criteria_scores: 'jsonb', criteria_names: 'jsonb', evaluation: 'text', eval_version: 'text',
  eval_parts_id: 'text', evaluation_pending: 'bool', eval_batch_id: 'text', eval_batch_at: 'timestamptz',
  eval_batch_tentativas: 'int', eval_batch_espera: 'text', eval_attempts: 'int', eval_error: 'text',
  mmr_before: 'int', mmr_after: 'int', mmr_delta: 'jsonb',
};

function data(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const objeto = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lista = (v) => (Array.isArray(v) ? v : []);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// JSON com as chaves em ordem: o jsonb não guarda a ordem das chaves, então é
// assim que o relatório compara um documento do arquivo com o do banco.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((c) => [c, x[c]])) : x));

// Lê a pasta de origem SÓ para leitura. Devolve os JSONs e o sha256 de cada um,
// que vai no relatório para amarrar o resultado à cópia exata do volume.
function lerOrigem(dir) {
  const arquivos = {};
  const hashes = {};
  const nomes = ['users.json', 'counters.json', 'character-records.json', 'settings.json', 'avatar-pool.json',
    'achievements.json', 'achievement-unlocks.json', 'sidequests.json', 'feedback.json', 'mmr.json',
    'logs.json', 'duels.json',
    ...CATALOGOS.map(([, f]) => f)];
  for (const nome of nomes) {
    const p = path.join(dir, nome);
    if (!fs.existsSync(p)) { arquivos[nome] = undefined; continue; }
    const bruto = fs.readFileSync(p);
    hashes[nome] = crypto.createHash('sha256').update(bruto).digest('hex');
    try {
      arquivos[nome] = JSON.parse(bruto.toString('utf-8'));
    } catch (e) {
      // Arquivo corrompido PARA a migração: seguir perderia dado sem aviso.
      throw new Error(`${nome} não é um JSON válido: ${e.message}`);
    }
  }
  return { arquivos, hashes };
}

async function migrarDelta({ pool, dir, dryRun = false, log = () => {} }) {
  const { arquivos: A, hashes } = lerOrigem(dir);
  const rel = { dryRun, hashes, passos: {}, avisos: [], rejeitados: [], ausentes: [] };
  for (const [nome, v] of Object.entries(A)) if (v === undefined) rel.ausentes.push(nome);

  const passo = (nome) => {
    if (!rel.passos[nome]) rel.passos[nome] = { inseridos: 0, atualizados: 0, iguais: 0, rejeitados: 0, detalhes: [] };
    return rel.passos[nome];
  };
  const rejeitar = (nomePasso, arquivo, chave, motivo, registro) => {
    passo(nomePasso).rejeitados += 1;
    rel.rejeitados.push({ passo: nomePasso, arquivo, chave: String(chave), motivo, registro });
  };
  // Conta o que o RETURNING devolveu: (xmax = 0) é linha nova; o resto, atualizada.
  const contar = (nomePasso, rows, total) => {
    const p = passo(nomePasso);
    const ins = rows.filter((r) => r.inserido).length;
    p.inseridos += ins;
    p.atualizados += rows.length - ins;
    p.iguais += total - rows.length;
    return p;
  };

  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN');
    const q = (sql, params) => client.query(sql, params);

    // ------------------------------------------------------------------ contas
    log('contas…');
    const usuarios = lista(A['users.json']);
    const { rows: noBanco } = await q(
      `SELECT id::text, username, lower(username) AS ul, lower(email) AS el, token_version, md5(password_hash) AS pw,
              excluido_em, name, role, teacher_id::text, email, email_verified, gender, profile_photo, visual_description,
              share_appearance, sidequests_enabled, abordagem, active_title, update_all_os, update_allos,
              origem_canal, origem_detalhe, termos_aceito_em, termos_versao
       FROM users`,
    );
    const banco = new Map(noBanco.map((u) => [u.id, u]));
    const idsJson = new Set();
    const validos = [];
    for (const u of usuarios) {
      const id = String(u && u.id);
      if (!ehConta(id)) { rejeitar('contas', 'users.json', id, 'id inválido', { id }); continue; }
      if (idsJson.has(id)) { rejeitar('contas', 'users.json', id, 'id repetido no arquivo', { id }); continue; }
      if (!PAPEIS.includes(u.role)) { rejeitar('contas', 'users.json', id, `papel desconhecido "${u.role}"`, { id, role: u.role }); continue; }
      idsJson.add(id);
      validos.push(u);
    }
    const idsFinais = new Set([...banco.keys(), ...idsJson]);
    // O mesmo id com OUTRA pessoa no banco: alguém se cadastrou no app novo e o
    // antigo deu o mesmo id a outra conta. Não se mistura: a conta do arquivo e
    // tudo que pende dela (logs, conquistas, recordes…) vão para os rejeitados.
    // O "-<id>" é a renomeação de colisão de caixa — a mesma pessoa.
    const idsConflitantes = new Set();
    for (const u of validos) {
      const atual = banco.get(String(u.id));
      if (!atual || atual.excluido_em) continue;
      const nomeArq = norm(u.username);
      if (atual.ul !== nomeArq && atual.ul !== `${nomeArq}-${u.id}`) idsConflitantes.add(String(u.id));
    }
    const donoValido = (id) => idsFinais.has(String(id)) && !idsConflitantes.has(String(id));
    const semDono = (id) => (idsConflitantes.has(String(id)) ? `conta ${id} em conflito de id (é outra pessoa no banco)` : 'conta inexistente');

    // Unicidade sem caixa de username e e-mail no conjunto FINAL. O dono de cada
    // nome/endereço parte do banco; conta do JSON só toma o que estiver livre.
    const donoUser = new Map();
    const donoEmail = new Map();
    for (const u of banco.values()) {
      donoUser.set(u.ul, u.id);
      if (u.el && !idsJson.has(u.id)) donoEmail.set(u.el, u.id);
    }
    const linhas = [];
    for (const u of [...validos].sort((a, b) => Number(a.id) - Number(b.id))) {
      const id = String(u.id);
      const atual = banco.get(id);
      if (idsConflitantes.has(id)) {
        rejeitar('contas', 'users.json', id, 'o id já pertence a OUTRA conta no banco (username diferente) — não misturado', { id });
        continue;
      }
      if (atual && atual.excluido_em) {
        rel.avisos.push(`Conta ${id}: excluída no sistema novo — não foi reativada nem alterada.`);
        continue;
      }
      let username = String(u.username || '').trim() || `usuario-${id}`;
      if (atual) {
        username = atual.username; // nunca muda
      } else if (donoUser.has(norm(username)) && donoUser.get(norm(username)) !== id) {
        const original = username;
        username = `${username}-${id}`;
        rel.avisos.push(`Conta ${id}: nome "${original}" já existia (só muda a caixa) — entra como "${username}".`);
      }
      donoUser.set(norm(username), id);

      let email = norm(u.email) || null;
      if (email && donoEmail.has(email) && donoEmail.get(email) !== id) {
        rel.avisos.push(`Conta ${id}: o e-mail já pertence à conta ${donoEmail.get(email)} — ${atual ? 'mantido o do banco' : 'entra sem e-mail'}.`);
        email = atual ? atual.el : null;
      }
      if (email) donoEmail.set(email, id);

      let teacher = u.teacherId ? String(u.teacherId) : null;
      if (teacher && !PAPEIS_ALUNO.includes(u.role)) {
        rel.avisos.push(`Conta ${id}: tinha professor mas não é aluno (${u.role}) — vínculo ignorado.`);
        teacher = null;
      } else if (teacher && !idsFinais.has(teacher)) {
        rel.avisos.push(`Conta ${id}: professor ${teacher} não existe — fica sem professor.`);
        teacher = null;
      }

      const termos = objeto(objeto(u.consentimento).termos);
      const origem = objeto(u.origem);
      const tv = Number.isInteger(u.tokenVersion) ? u.tokenVersion : 0;
      const senhaDiferente = atual && crypto.createHash('md5').update(String(u.passwordHash || '')).digest('hex') !== atual.pw;
      if (senhaDiferente && tv === atual.token_version) {
        rel.avisos.push(`Conta ${id}: senha diferente com o mesmo token_version (${tv}) — ficou a do banco.`);
      } else if (senhaDiferente && tv < atual.token_version) {
        rel.avisos.push(`Conta ${id}: a senha do banco é mais nova (token_version ${atual.token_version} > ${tv}) — mantida.`);
      }
      linhas.push({
        id, username, name: String(u.name || ''), role: u.role, password_hash: String(u.passwordHash || ''),
        token_version: tv, email, email_verified: !!(email && u.emailVerified),
        gender: String(u.gender || ''), profile_photo: String(u.profilePhoto || ''),
        visual_description: u.visualDescription == null ? null : String(u.visualDescription),
        share_appearance: u.shareAppearance == null ? null : !!u.shareAppearance,
        sidequests_enabled: u.sidequestsEnabled !== false, abordagem: String(u.abordagem || '').slice(0, 120),
        active_title: String(u.activeTitle || ''), update_all_os: !!u.updateAllOS, update_allos: !!u.updateAllos,
        origem_canal: origem.canal ? String(origem.canal) : null,
        origem_detalhe: origem.canal ? String(origem.detalhe || '') : null,
        termos_aceito_em: data(termos.em), termos_versao: data(termos.em) ? String(termos.versao || '1') : null,
        criado_em: data(u.criadoEm), teacher_id: teacher,
      });
    }

    // Para o relatório: quais campos mudam em cada conta que já existia.
    const CAMPOS_PERFIL = ['name', 'role', 'teacher_id', 'email', 'email_verified', 'gender', 'profile_photo',
      'visual_description', 'share_appearance', 'sidequests_enabled', 'abordagem', 'active_title', 'update_all_os',
      'update_allos', 'origem_canal', 'origem_detalhe', 'termos_versao'];
    for (const l of linhas) {
      const atual = banco.get(l.id);
      if (!atual) continue;
      const mudou = CAMPOS_PERFIL.filter((c) => JSON.stringify(atual[c] ?? null) !== JSON.stringify(l[c] ?? null));
      const t1 = atual.termos_aceito_em ? atual.termos_aceito_em.toISOString() : null;
      if (t1 !== l.termos_aceito_em) mudou.push('termos_aceito_em');
      if (l.token_version > atual.token_version) mudou.push('password_hash', 'token_version');
      if (mudou.length) passo('contas').detalhes.push(`conta ${l.id}: ${mudou.join(', ')}`);
    }

    const { rows: rContas } = await q(
      `WITH x AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
           id bigint, username text, name text, role text, password_hash text, token_version int, email text,
           email_verified bool, gender text, profile_photo text, visual_description text, share_appearance bool,
           sidequests_enabled bool, abordagem text, active_title text, update_all_os bool, update_allos bool,
           origem_canal text, origem_detalhe text, termos_aceito_em timestamptz, termos_versao text,
           criado_em timestamptz, teacher_id bigint))
       INSERT INTO users AS u (id, username, name, role, password_hash, token_version, email, email_verified,
         gender, profile_photo, visual_description, share_appearance, sidequests_enabled, abordagem, active_title,
         update_all_os, update_allos, origem_canal, origem_detalhe, termos_aceito_em, termos_versao, criado_em, teacher_id)
       SELECT id, username, name, role, password_hash, token_version, email, email_verified, gender, profile_photo,
         visual_description, share_appearance, sidequests_enabled, abordagem, active_title, update_all_os, update_allos,
         origem_canal, origem_detalhe, termos_aceito_em, termos_versao, COALESCE(criado_em, now()), teacher_id
       FROM x
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, role = EXCLUDED.role, teacher_id = EXCLUDED.teacher_id,
         email = EXCLUDED.email, email_verified = EXCLUDED.email_verified, gender = EXCLUDED.gender,
         profile_photo = EXCLUDED.profile_photo, visual_description = EXCLUDED.visual_description,
         share_appearance = EXCLUDED.share_appearance, sidequests_enabled = EXCLUDED.sidequests_enabled,
         abordagem = EXCLUDED.abordagem, active_title = EXCLUDED.active_title,
         update_all_os = EXCLUDED.update_all_os, update_allos = EXCLUDED.update_allos,
         origem_canal = EXCLUDED.origem_canal, origem_detalhe = EXCLUDED.origem_detalhe,
         termos_aceito_em = EXCLUDED.termos_aceito_em, termos_versao = EXCLUDED.termos_versao,
         password_hash = CASE WHEN EXCLUDED.token_version > u.token_version THEN EXCLUDED.password_hash ELSE u.password_hash END,
         token_version = GREATEST(u.token_version, EXCLUDED.token_version)
       WHERE u.excluido_em IS NULL AND (
         EXCLUDED.token_version > u.token_version OR
         ROW(u.name, u.role, u.teacher_id, u.email, u.email_verified, u.gender, u.profile_photo, u.visual_description,
             u.share_appearance, u.sidequests_enabled, u.abordagem, u.active_title, u.update_all_os, u.update_allos,
             u.origem_canal, u.origem_detalhe, u.termos_aceito_em, u.termos_versao)
         IS DISTINCT FROM
         ROW(EXCLUDED.name, EXCLUDED.role, EXCLUDED.teacher_id, EXCLUDED.email, EXCLUDED.email_verified, EXCLUDED.gender,
             EXCLUDED.profile_photo, EXCLUDED.visual_description, EXCLUDED.share_appearance, EXCLUDED.sidequests_enabled,
             EXCLUDED.abordagem, EXCLUDED.active_title, EXCLUDED.update_all_os, EXCLUDED.update_allos,
             EXCLUDED.origem_canal, EXCLUDED.origem_detalhe, EXCLUDED.termos_aceito_em, EXCLUDED.termos_versao))
       RETURNING u.id::text, (xmax = 0) AS inserido`,
      [JSON.stringify(linhas)],
    );
    contar('contas', rContas, linhas.length);
    for (const id of banco.keys()) {
      if (!idsJson.has(id) && !banco.get(id).excluido_em) {
        rel.avisos.push(`Conta ${id}: existe no banco e não está no users.json — nada foi feito (excluída no sistema antigo?).`);
      }
    }

    // Ids de conta nunca voltam (CLAUDE.md §5.2): a sequência só anda para a frente.
    const ultimoEmitido = Number(objeto(objeto(A['counters.json']).__meta).lastUserId) || 0;
    const { rows: [seq] } = await q(
      `SELECT setval(pg_get_serial_sequence('users', 'id'),
                     GREATEST(COALESCE(pg_sequence_last_value(pg_get_serial_sequence('users', 'id')::regclass), 0),
                              COALESCE((SELECT max(id) FROM users), 0), $1::bigint, 1)) AS valor`,
      [ultimoEmitido],
    );
    passo('contas').detalhes.push(`sequência de ids de conta em ${seq.valor}`);

    // ------------------------------------------------------------- contadores
    log('contadores…');
    const contadores = [];
    for (const [userId, c] of Object.entries(objeto(A['counters.json']))) {
      if (userId === '__meta') continue;
      if (!ehConta(userId) || !donoValido(userId)) { rejeitar('contadores', 'counters.json', userId, semDono(userId), { userId }); continue; }
      contadores.push({ user_id: userId, mic_uses: Math.max(0, Math.round(Number(objeto(c).micUses) || 0)) });
    }
    const { rows: rCont } = await q(
      `INSERT INTO contadores_usuario AS c (user_id, mic_uses)
       SELECT user_id, mic_uses FROM jsonb_to_recordset($1::jsonb) AS x(user_id bigint, mic_uses int)
       ON CONFLICT (user_id) DO UPDATE SET mic_uses = EXCLUDED.mic_uses WHERE EXCLUDED.mic_uses > c.mic_uses
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(contadores)],
    );
    contar('contadores', rCont, contadores.length);

    // --------------------------------------------------------------- catálogos
    log('catálogos…');
    const idsFreeplay = new Set();
    for (const [tipo, arquivo] of CATALOGOS) {
      const itens = A[arquivo];
      if (itens === undefined) continue;
      const nome = `catálogo ${tipo}`;
      const validosCat = [];
      const vistos = new Set();
      lista(itens).forEach((item, i) => {
        const id = item && item.id != null ? String(item.id) : '';
        if (!id) { rejeitar(nome, arquivo, `(posição ${i + 1})`, 'item sem id', null); return; }
        if (vistos.has(id)) { rejeitar(nome, arquivo, id, 'id repetido (ficou o primeiro)', null); return; }
        vistos.add(id);
        validosCat.push({ ordem: i + 1, doc: item });
      });
      if (tipo === 'freeplay') for (const id of vistos) idsFreeplay.add(id);
      const { rows: atuais } = await q('SELECT id, ordem, doc FROM catalogo_itens WHERE tipo = $1', [tipo]);
      const atualPorId = new Map(atuais.map((r) => [r.id, r]));
      for (const { ordem, doc } of validosCat) {
        const a = atualPorId.get(String(doc.id));
        if (!a) { passo(nome).detalhes.push(`${doc.id}: novo (posição ${ordem})`); continue; }
        const campos = [...new Set([...Object.keys(doc), ...Object.keys(a.doc)])]
          .filter((k) => canon(doc[k]) !== canon(a.doc[k]));
        if (a.ordem !== ordem) campos.push('ordem');
        if (campos.length) passo(nome).detalhes.push(`${doc.id}: ${campos.join(', ')}`);
      }
      for (const id of atualPorId.keys()) {
        if (!vistos.has(id)) rel.avisos.push(`Catálogo ${tipo}: ${id} está no banco e não no ${arquivo} — mantido.`);
        if (tipo === 'freeplay') idsFreeplay.add(id);
      }
      const { rows: rCat } = await q(
        `INSERT INTO catalogo_itens AS c (tipo, id, ordem, doc)
         SELECT $2, x.doc->>'id', x.ordem, x.doc FROM jsonb_to_recordset($1::jsonb) AS x(ordem int, doc jsonb)
         ON CONFLICT (tipo, id) DO UPDATE SET doc = EXCLUDED.doc, ordem = EXCLUDED.ordem, atualizado_em = now()
         WHERE c.doc IS DISTINCT FROM EXCLUDED.doc OR c.ordem IS DISTINCT FROM EXCLUDED.ordem
         RETURNING (xmax = 0) AS inserido`,
        // A posição no arquivo é a ordem: o "Paciente em Destaque" é o último.
        [JSON.stringify(validosCat), tipo],
      );
      contar(nome, rCat, validosCat.length);
    }

    // -------------------------------------------------------------- recordes 👑
    log('recordes…');
    const recordes = [];
    for (const [characterId, r] of Object.entries(objeto(A['character-records.json']))) {
      const score = Number(objeto(r).score);
      if (!Number.isFinite(score)) { rejeitar('recordes', 'character-records.json', characterId, 'nota inválida', null); continue; }
      if (!idsFreeplay.has(characterId)) { rejeitar('recordes', 'character-records.json', characterId, 'paciente fora do catálogo', null); continue; }
      const uid = ehConta(r.userId) ? String(r.userId) : null;
      if (uid && !donoValido(uid)) { rejeitar('recordes', 'character-records.json', characterId, idsConflitantes.has(uid) ? semDono(uid) : `conta ${uid} inexistente`, null); continue; }
      recordes.push({ character_id: characterId, score, user_id: uid, user_name: String(r.userName || ''), user_photo: r.userPhoto || null, at: data(r.at) });
    }
    const { rows: recAtuais } = await q('SELECT character_id, score, user_id::text FROM character_records');
    const recPorId = new Map(recAtuais.map((r) => [r.character_id, r]));
    for (const r of recordes) {
      const a = recPorId.get(r.character_id);
      if (!a) passo('recordes').detalhes.push(`${r.character_id}: novo — ${r.score} (conta ${r.user_id})`);
      else if (a.score < r.score) passo('recordes').detalhes.push(`${r.character_id}: ${a.score} (conta ${a.user_id}) → ${r.score} (conta ${r.user_id})`);
      else if (a.score > r.score) rel.avisos.push(`Recorde ${r.character_id}: o do banco (${a.score}) é maior que o do arquivo (${r.score}) — mantido.`);
    }
    const { rows: rRec } = await q(
      `INSERT INTO character_records AS r (character_id, score, user_id, user_name, user_photo, at, origem)
       SELECT character_id, score, user_id, user_name, user_photo, COALESCE(at, now()), 'competitivo'
       FROM jsonb_to_recordset($1::jsonb) AS x(character_id text, score float8, user_id bigint, user_name text, user_photo text, at timestamptz)
       ON CONFLICT (character_id) DO UPDATE SET
         score = EXCLUDED.score, user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name,
         user_photo = EXCLUDED.user_photo, at = EXCLUDED.at, origem = EXCLUDED.origem
       WHERE r.score < EXCLUDED.score
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(recordes)],
    );
    contar('recordes', rRec, recordes.length);

    // ----------------------------------------------------------- configurações
    log('configurações…');
    const configs = [];
    if (A['avatar-pool.json'] !== undefined) {
      configs.push({ chave: 'avatar-pool', valor: { photos: lista(objeto(A['avatar-pool.json']).photos) } });
    }
    const { rows: rCfg } = await q(
      `INSERT INTO configuracoes AS c (chave, valor)
       SELECT chave, valor FROM jsonb_to_recordset($1::jsonb) AS x(chave text, valor jsonb)
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()
       WHERE c.valor IS DISTINCT FROM EXCLUDED.valor
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(configs)],
    );
    contar('configurações', rCfg, configs.length);

    // Senha do Processo Seletivo: só as três chaves dela, e só se a do arquivo for
    // mais nova. O resto do bloco 'settings' é do sistema novo.
    const s = objeto(A['settings.json']);
    if (s.selecaoPassword) {
      const { rows: [atual] } = await q(`SELECT valor FROM configuracoes WHERE chave = 'settings'`);
      const emBanco = data(atual && atual.valor && atual.valor.selecaoPasswordUpdatedAt);
      const noArquivo = data(s.selecaoPasswordUpdatedAt);
      if (!emBanco || (noArquivo && noArquivo > emBanco)) {
        const patch = Object.fromEntries(CHAVES_SENHA_SELECAO.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
        const { rows } = await q(
          `INSERT INTO configuracoes AS c (chave, valor) VALUES ('settings', $1::jsonb)
           ON CONFLICT (chave) DO UPDATE SET valor = c.valor || EXCLUDED.valor, atualizado_em = now()
           WHERE NOT (c.valor @> EXCLUDED.valor)
           RETURNING (xmax = 0) AS inserido`,
          [JSON.stringify(patch)],
        );
        contar('senha do seletivo', rows, 1);
        if (rows.length) passo('senha do seletivo').detalhes.push(`trocada de ${emBanco || '—'} para a de ${noArquivo}`);
      } else {
        contar('senha do seletivo', [], 1);
        if (noArquivo !== emBanco) rel.avisos.push(`Senha do seletivo: a do banco (${emBanco}) é mais nova que a do arquivo (${noArquivo}) — mantida.`);
      }
    }

    // --------------------------------------------------------------- conquistas
    log('conquistas…');
    const resgates = [];
    for (const [dono, mapa] of Object.entries(objeto(A['achievements.json']))) {
      for (const [conquista, em] of Object.entries(objeto(mapa))) {
        const chave = `${dono}/${conquista}`;
        if (!ehConta(dono)) { rejeitar('conquistas resgatadas', 'achievements.json', chave, 'visitante não tem conta', { conquista, em }); continue; }
        if (!donoValido(dono)) { rejeitar('conquistas resgatadas', 'achievements.json', chave, semDono(dono), null); continue; }
        if (!CONQUISTAS.includes(conquista)) { rejeitar('conquistas resgatadas', 'achievements.json', chave, 'conquista removida (já não aparece no sistema antigo)', { conquista, em }); continue; }
        resgates.push({ user_id: dono, conquista_id: conquista, resgatada_em: data(em) });
      }
    }
    const { rows: rRes } = await q(
      `INSERT INTO conquistas_resgatadas (user_id, conquista_id, resgatada_em)
       SELECT user_id, conquista_id, COALESCE(resgatada_em, now())
       FROM jsonb_to_recordset($1::jsonb) AS x(user_id bigint, conquista_id text, resgatada_em timestamptz)
       ON CONFLICT (user_id, conquista_id) DO NOTHING
       RETURNING true AS inserido`,
      [JSON.stringify(resgates)],
    );
    contar('conquistas resgatadas', rRes, resgates.length);

    const vistas = [];
    for (const [dono, ids] of Object.entries(objeto(A['achievement-unlocks.json']))) {
      if (!ehConta(dono) || !donoValido(dono)) { rejeitar('conquistas vistas', 'achievement-unlocks.json', dono, semDono(dono), null); continue; }
      vistas.push({ user_id: dono, conquistas: [...new Set(lista(ids).map(String))].sort() });
    }
    // União com o que o banco já tem: a pessoa pode ter visto conquistas no app novo.
    const { rows: rVis } = await q(
      `INSERT INTO conquistas_vistas AS v (user_id, conquistas)
       SELECT user_id, conquistas FROM jsonb_to_recordset($1::jsonb) AS x(user_id bigint, conquistas text[])
       ON CONFLICT (user_id) DO UPDATE
         SET conquistas = ARRAY(SELECT DISTINCT e FROM unnest(v.conquistas || EXCLUDED.conquistas) AS e ORDER BY e),
             atualizado_em = now()
       WHERE NOT (EXCLUDED.conquistas <@ v.conquistas)
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(vistas)],
    );
    contar('conquistas vistas', rVis, vistas.length);

    // --------------------------------------------------------------- sidequests
    log('sidequests…');
    const sq = A['sidequests.json'];
    if (sq !== undefined) {
      const banco2 = [];
      for (const b of lista(objeto(sq).bank)) {
        if (!b || !b.id) { rejeitar('sidequests (banco)', 'sidequests.json', '(sem id)', 'item sem id', null); continue; }
        banco2.push({ id: String(b.id), criado_em: data(b.createdAt), doc: b });
      }
      const { rows: rB } = await q(
        `INSERT INTO sidequests_banco AS s (id, criado_em, doc)
         SELECT id, COALESCE(criado_em, now()), doc FROM jsonb_to_recordset($1::jsonb) AS x(id text, criado_em timestamptz, doc jsonb)
         ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc WHERE s.doc IS DISTINCT FROM EXCLUDED.doc
         RETURNING (xmax = 0) AS inserido`,
        [JSON.stringify(banco2)],
      );
      contar('sidequests (banco)', rB, banco2.length);

      const ativas = [];
      for (const [dono, doc] of Object.entries(objeto(objeto(sq).active))) {
        if (!ehConta(dono) || !donoValido(dono)) { rejeitar('sidequests (ativas)', 'sidequests.json', dono, semDono(dono), null); continue; }
        ativas.push({ user_id: dono, atribuida_em: data(objeto(doc).assignedAt), doc });
      }
      const { rows: rA } = await q(
        `INSERT INTO sidequests_ativas AS s (user_id, atribuida_em, doc)
         SELECT user_id, COALESCE(atribuida_em, now()), doc FROM jsonb_to_recordset($1::jsonb) AS x(user_id bigint, atribuida_em timestamptz, doc jsonb)
         ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, atribuida_em = EXCLUDED.atribuida_em
         WHERE s.doc IS DISTINCT FROM EXCLUDED.doc
         RETURNING (xmax = 0) AS inserido`,
        [JSON.stringify(ativas)],
      );
      contar('sidequests (ativas)', rA, ativas.length);

      // Concluídas não têm chave natural: a mesma conta com o mesmo documento é a
      // mesma conclusão — é isso que impede a segunda rodada de duplicar.
      const concluidas = [];
      for (const [dono, docs] of Object.entries(objeto(objeto(sq).completed))) {
        if (!ehConta(dono) || !donoValido(dono)) { rejeitar('sidequests (concluídas)', 'sidequests.json', dono, semDono(dono), null); continue; }
        for (const doc of lista(docs)) concluidas.push({ user_id: dono, recompensa_id: objeto(doc).rewardTitleId || null, concluida_em: data(objeto(doc).completedAt), doc });
      }
      const { rows: rC } = await q(
        `INSERT INTO sidequests_concluidas (user_id, recompensa_id, concluida_em, doc)
         SELECT x.user_id, x.recompensa_id, COALESCE(x.concluida_em, now()), x.doc
         FROM jsonb_to_recordset($1::jsonb) AS x(user_id bigint, recompensa_id text, concluida_em timestamptz, doc jsonb)
         WHERE NOT EXISTS (SELECT 1 FROM sidequests_concluidas s WHERE s.user_id = x.user_id AND s.doc = x.doc)
         RETURNING true AS inserido`,
        [JSON.stringify(concluidas)],
      );
      contar('sidequests (concluídas)', rC, concluidas.length);
    }

    // ----------------------------------------------------------------- feedback
    log('feedback…');
    const feedbacks = [];
    for (const f of lista(A['feedback.json'])) {
      if (!f || !f.id) { rejeitar('feedback', 'feedback.json', '(sem id)', 'item sem id', null); continue; }
      feedbacks.push({
        id: String(f.id), criado_em: data(f.timestamp), user_id: f.userId == null ? null : String(f.userId),
        user_name: String(f.userName || ''), role: String(f.role || ''), stars: Math.round(Number(f.stars) || 0), message: String(f.message || ''),
      });
    }
    const { rows: rF } = await q(
      `INSERT INTO feedback (id, criado_em, user_id, user_name, role, stars, message)
       SELECT id, COALESCE(criado_em, now()), user_id, user_name, role, stars, message
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, criado_em timestamptz, user_id text, user_name text, role text, stars int, message text)
       ON CONFLICT (id) DO NOTHING
       RETURNING true AS inserido`,
      [JSON.stringify(feedbacks)],
    );
    contar('feedback', rF, feedbacks.length);

    // ------------------------------------------------- logs de atendimento
    // Um log é identificado pelo id que o app gerou ('log<ms>-<hex>'): a mesma
    // sessão nunca entra duas vezes. As mensagens, por (log, posição). Se o
    // aluno marcou ou comentou uma mensagem no sistema antigo depois da primeira
    // passada, a segunda leva a mudança.
    log('logs…');
    const logs = [];
    const mensagens = [];
    const idsLog = new Set();
    for (const l of lista(A['logs.json'])) {
      const id = l && l.id != null ? String(l.id) : '';
      if (!id) { rejeitar('logs', 'logs.json', '(sem id)', 'log sem id', null); continue; }
      if (idsLog.has(id)) { rejeitar('logs', 'logs.json', id, 'id repetido no arquivo', null); continue; }
      const dono = String(l.userId ?? '');
      const conta = ehConta(dono);
      if (!conta && !ID_VISITANTE.test(dono)) { rejeitar('logs', 'logs.json', id, `dono inválido "${dono}"`, null); continue; }
      if (conta && !donoValido(dono)) { rejeitar('logs', 'logs.json', id, idsConflitantes.has(dono) ? semDono(dono) : `conta ${dono} inexistente`, null); continue; }
      if (!TIPOS_LOG.includes(l.type)) { rejeitar('logs', 'logs.json', id, `tipo desconhecido "${l.type}"`, null); continue; }
      if (!MODOS_LOG.includes(l.mode || 'training')) { rejeitar('logs', 'logs.json', id, `modo desconhecido "${l.mode}"`, null); continue; }
      idsLog.add(id);
      const linha = { id, criado_em: data(l.timestamp), user_id: conta ? dono : null, visitante_id: conta ? null : dono };
      for (const [coluna, f] of COLUNAS_LOG) linha[coluna] = f(l);
      logs.push(linha);
      lista(l.messages).forEach((m, i) => {
        mensagens.push({
          log_id: id, posicao: i + 1, role: m && m.role != null ? String(m.role) : null,
          content: String((m && m.content) ?? ''), highlighted: !!(m && m.highlighted), comment: String((m && m.comment) ?? ''),
        });
      });
    }
    const colsLog = COLUNAS_LOG.map(([c]) => c);
    const { rows: rLogs } = await q(
      `WITH x AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, criado_em timestamptz, user_id bigint, visitante_id text,
         ${colsLog.map((c) => `${c} ${TIPOS_COLUNA_LOG[c]}`).join(', ')}))
       INSERT INTO logs AS l (id, criado_em, user_id, visitante_id, ${colsLog.join(', ')})
       SELECT id, COALESCE(criado_em, now()), user_id, visitante_id, ${colsLog.join(', ')} FROM x
       ON CONFLICT (id) DO UPDATE SET ${colsLog.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
       WHERE ROW(${colsLog.map((c) => `l.${c}`).join(', ')}) IS DISTINCT FROM ROW(${colsLog.map((c) => `EXCLUDED.${c}`).join(', ')})
       RETURNING l.id, (xmax = 0) AS inserido`,
      [JSON.stringify(logs)],
    );
    contar('logs', rLogs, logs.length);
    for (const r of rLogs) if (!r.inserido) passo('logs').detalhes.push(`${r.id}: atualizado (avaliação ou dados do log mudaram)`);

    const { rows: rMsg } = await q(
      `INSERT INTO log_messages AS m (log_id, posicao, role, content, highlighted, comment)
       SELECT log_id, posicao, role, content, highlighted, comment
       FROM jsonb_to_recordset($1::jsonb) AS x(log_id text, posicao int, role text, content text, highlighted bool, comment text)
       ON CONFLICT (log_id, posicao) DO UPDATE SET
         role = EXCLUDED.role, content = EXCLUDED.content, highlighted = EXCLUDED.highlighted, comment = EXCLUDED.comment
       WHERE ROW(m.role, m.content, m.highlighted, m.comment) IS DISTINCT FROM ROW(EXCLUDED.role, EXCLUDED.content, EXCLUDED.highlighted, EXCLUDED.comment)
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(mensagens.filter((m) => m.role !== null))],
    );
    contar('mensagens dos logs', rMsg, mensagens.filter((m) => m.role !== null).length);
    const semPapel = mensagens.filter((m) => m.role === null).length;
    if (semPapel) rel.avisos.push(`${semPapel} mensagem(ns) sem papel (role) — não gravadas.`);
    if (idsLog.size) {
      const { rows: sobrando } = await q(
        `SELECT m.log_id, count(*)::int AS n FROM log_messages m
         JOIN jsonb_to_recordset($1::jsonb) AS x(log_id text, total int) ON x.log_id = m.log_id
         WHERE m.posicao > x.total GROUP BY m.log_id`,
        [JSON.stringify([...idsLog].map((id) => ({ log_id: id, total: mensagens.filter((m) => m.log_id === id).length })))],
      );
      for (const r of sobrando) rel.avisos.push(`Log ${r.log_id}: o banco tem ${r.n} mensagem(ns) a mais que o arquivo — mantidas.`);
    }

    // ------------------------------------------------------------------ duelos
    log('duelos…');
    const duelos = [];
    const lado = (x) => (x && x.userId ? String(x.userId) : null);
    for (const d of lista(A['duels.json'])) {
      if (!d || !d.id || !d.token) { rejeitar('duelos', 'duels.json', d && d.id, 'duelo sem id ou sem token', null); continue; }
      const emConflito = [lado(d.challenger), lado(d.opponent)].find((x) => x && idsConflitantes.has(x));
      if (emConflito) { rejeitar('duelos', 'duels.json', d.id, semDono(emConflito), null); continue; }
      duelos.push({
        id: String(d.id), token: String(d.token), status: String(d.status), criado_em: data(d.createdAt),
        challenger_id: lado(d.challenger), opponent_id: lado(d.opponent), doc: d,
      });
    }
    const { rows: tokensOcupados } = await q(
      `SELECT d.token, d.id FROM duels d JOIN jsonb_to_recordset($1::jsonb) AS x(id text, token text)
       ON x.token = d.token AND x.id <> d.id`,
      [JSON.stringify(duelos.map(({ id, token }) => ({ id, token })))],
    );
    const ocupados = new Set(tokensOcupados.map((r) => r.token));
    const duelosOk = duelos.filter((d) => {
      if (!ocupados.has(d.token)) return true;
      rejeitar('duelos', 'duels.json', d.id, 'token do convite já pertence a outro duelo no banco', null);
      return false;
    });
    const { rows: rDuel } = await q(
      `INSERT INTO duels AS d (id, token, status, criado_em, challenger_id, opponent_id, doc)
       SELECT id, token, status, COALESCE(criado_em, now()), challenger_id, opponent_id, doc
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, token text, status text, criado_em timestamptz, challenger_id text, opponent_id text, doc jsonb)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, challenger_id = EXCLUDED.challenger_id,
         opponent_id = EXCLUDED.opponent_id, doc = EXCLUDED.doc
       WHERE d.doc IS DISTINCT FROM EXCLUDED.doc
       RETURNING (xmax = 0) AS inserido`,
      [JSON.stringify(duelosOk)],
    );
    contar('duelos', rDuel, duelosOk.length);

    // ------------------------------------- dificuldade de partida dos pacientes
    // O D antigo (um número só, sobre a nota total) vira o D inicial de CADA
    // critério ativo, com as contagens zeradas: o caso continua "novo" para o motor
    // (ganho alto, sem regressão, sem histórico), só começa mais perto de onde já
    // estava. Paciente que o motor novo já mexeu fica como está.
    log('dificuldade dos pacientes…');
    const { rows: criterios } = await q('SELECT id::text FROM criterios WHERE ativo ORDER BY ordem, id');
    const sementes = [];
    if (criterios.length) {
      for (const [cid, c] of Object.entries(objeto(objeto(A['mmr.json']).characters))) {
        const D = Number(objeto(c).D);
        const nD = Number(objeto(c).n_D) || 0;
        if (!idsFreeplay.has(cid)) continue;
        if (!Number.isFinite(D) || nD < N_D_MADURO) {
          passo('dificuldade dos pacientes').detalhes.push(`${cid}: começa em 50 (no motor antigo, n_D = ${nD})`);
          continue;
        }
        const Dc = Math.round(clamp(D, 10, 90) * 100) / 100;
        const estado = { criterios: Object.fromEntries(criterios.map((k) => [k.id, { D: Dc, n_D: 0, beta: 1, historico: [] }])) };
        sementes.push({ character_id: cid, estado, D: Dc, nD });
      }
    } else {
      rel.avisos.push('Nenhum critério ativo no banco — dificuldade dos pacientes não semeada.');
    }
    const { rows: rD } = await q(
      `INSERT INTO mmr_characters (character_id, estado, fontes)
       SELECT character_id, estado, '{}'::jsonb FROM jsonb_to_recordset($1::jsonb) AS x(character_id text, estado jsonb)
       ON CONFLICT (character_id) DO NOTHING
       RETURNING character_id, true AS inserido`,
      [JSON.stringify(sementes.map(({ character_id, estado }) => ({ character_id, estado })))],
    );
    contar('dificuldade dos pacientes', rD, sementes.length);
    const semeados = new Set(rD.map((r) => r.character_id));
    for (const s2 of sementes) {
      passo('dificuldade dos pacientes').detalhes.push(semeados.has(s2.character_id)
        ? `${s2.character_id}: D = ${s2.D} em ${criterios.length} critérios (motor antigo, n_D = ${s2.nD})`
        : `${s2.character_id}: o motor novo já tem estado — mantido`);
    }

    await q(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  rel.duracaoMs = Date.now() - t0;
  return rel;
}

// SÓ o Processo Seletivo — avaliações dos candidatos e registros da dashboard
// (decisão do dono, 2026-10-13, depois da virada). Separado de migrarDelta de
// propósito: com o sistema novo no ar, a regra "o antigo vence" de migrarDelta
// desfaria o que foi mudado no novo. Aqui é só INSERIR o que falta:
//   · selecao_logs: pelo id (e pela sessão); um log que já está no banco nunca
//     é sobrescrito — se o avaliador deu "nova chance" no sistema novo, fica;
//   · selecao_estatisticas: não tem chave natural, então compara pelo conjunto
//     (data, nota, status), contando repetições: entra só a diferença.
// O WhatsApp é normalizado como o app normaliza (só dígitos), para o bloqueio de
// 15 dias reconhecer os números migrados.
async function migrarSeletivo({ pool, dir, dryRun = false, log = () => {} }) {
  const ler = (nome) => {
    const p = path.join(dir, nome);
    if (!fs.existsSync(p)) return { valor: undefined, hash: null };
    const bruto = fs.readFileSync(p);
    try {
      return { valor: JSON.parse(bruto.toString('utf-8')), hash: crypto.createHash('sha256').update(bruto).digest('hex') };
    } catch (e) {
      throw new Error(`${nome} não é um JSON válido: ${e.message}`);
    }
  };
  const logsArq = ler('selection-logs.json');
  const statsArq = ler('selection-stats.json');
  const rel = { dryRun, hashes: {}, passos: {}, avisos: [], rejeitados: [], ausentes: [] };
  if (logsArq.hash) rel.hashes['selection-logs.json'] = logsArq.hash; else rel.ausentes.push('selection-logs.json');
  if (statsArq.hash) rel.hashes['selection-stats.json'] = statsArq.hash; else rel.ausentes.push('selection-stats.json');
  const passo = (nome) => {
    if (!rel.passos[nome]) rel.passos[nome] = { inseridos: 0, atualizados: 0, iguais: 0, rejeitados: 0, detalhes: [] };
    return rel.passos[nome];
  };
  const rejeitar = (nomePasso, arquivo, chave, motivo) => {
    passo(nomePasso).rejeitados += 1;
    rel.rejeitados.push({ passo: nomePasso, arquivo, chave: String(chave), motivo, registro: null });
  };

  const client = await pool.connect();
  const t0 = Date.now();
  try {
    await client.query('BEGIN');

    log('avaliações do seletivo…');
    const linhas = [];
    const vistos = new Set();
    for (const l of lista(logsArq.valor)) {
      const id = l && l.id != null ? String(l.id) : '';
      if (!id) { rejeitar('avaliações do seletivo', 'selection-logs.json', '(sem id)', 'log sem id'); continue; }
      if (vistos.has(id)) { rejeitar('avaliações do seletivo', 'selection-logs.json', id, 'id repetido no arquivo'); continue; }
      const criado = data(l.timestamp);
      if (!criado) { rejeitar('avaliações do seletivo', 'selection-logs.json', id, 'sem data'); continue; }
      vistos.add(id);
      linhas.push({
        id, session_id: String(l.sessionId || id), criado_em: criado,
        whatsapp: String((objeto(l.candidate).whatsapp) || '').replace(/\D+/g, ''),
        status: String(l.status || 'pending'), eval_batch_id: l.evalBatchId || null, doc: l,
      });
    }
    const { rows: rLogs } = await client.query(
      `INSERT INTO selecao_logs (id, session_id, criado_em, whatsapp, status, eval_batch_id, doc)
       SELECT id, session_id, criado_em, whatsapp, status, eval_batch_id, doc
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, session_id text, criado_em timestamptz, whatsapp text, status text, eval_batch_id text, doc jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [JSON.stringify(linhas)],
    );
    const p1 = passo('avaliações do seletivo');
    p1.inseridos = rLogs.length;
    p1.iguais = linhas.length - rLogs.length;

    log('dashboard do seletivo…');
    // Conjunto (data, nota, status) com as repetições contadas, dos dois lados.
    const chaveStat = (t, s, st) => `${t}|${s == null ? '' : Number(s)}|${st}`;
    const { rows: noBanco } = await client.query(
      `SELECT to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t, score, status FROM selecao_estatisticas`,
    );
    const contagem = new Map();
    for (const r of noBanco) {
      const k = chaveStat(r.t, r.score, r.status);
      contagem.set(k, (contagem.get(k) || 0) + 1);
    }
    const faltam = [];
    let iguaisStats = 0;
    for (const sArq of lista(statsArq.valor)) {
      const t = data(sArq && sArq.timestamp);
      if (!t) { rejeitar('dashboard do seletivo', 'selection-stats.json', '(sem data)', 'registro sem data'); continue; }
      const score = sArq.score == null ? null : Number(sArq.score);
      const status = String(sArq.status || '');
      const k = chaveStat(t, score, status);
      const n = contagem.get(k) || 0;
      if (n > 0) { contagem.set(k, n - 1); iguaisStats += 1; continue; }
      faltam.push({ criado_em: t, score: Number.isFinite(score) ? score : null, status });
    }
    const { rows: rStats } = await client.query(
      `INSERT INTO selecao_estatisticas (criado_em, score, status)
       SELECT criado_em, score, status FROM jsonb_to_recordset($1::jsonb) AS x(criado_em timestamptz, score float8, status text)
       RETURNING id`,
      [JSON.stringify(faltam)],
    );
    const p2 = passo('dashboard do seletivo');
    p2.inseridos = rStats.length;
    p2.iguais = iguaisStats;
    if (faltam.length) p2.detalhes.push(`registros novos de ${faltam.map((f) => f.criado_em).sort()[0].slice(0, 10)} a ${faltam.map((f) => f.criado_em).sort().slice(-1)[0].slice(0, 10)}`);

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  rel.duracaoMs = Date.now() - t0;
  return rel;
}

function relatorioEmTexto(r) {
  const linhas = [r.dryRun ? 'SIMULAÇÃO (--dry-run): nada foi gravado — a transação foi desfeita.' : 'Migração gravada.', ''];
  linhas.push(`${'passo'.padEnd(28)} ${'novos'.padStart(6)} ${'atualiz.'.padStart(9)} ${'iguais'.padStart(7)} ${'rejeit.'.padStart(8)}`);
  for (const [nome, p] of Object.entries(r.passos)) {
    linhas.push(`${nome.padEnd(28)} ${String(p.inseridos).padStart(6)} ${String(p.atualizados).padStart(9)} ${String(p.iguais).padStart(7)} ${String(p.rejeitados).padStart(8)}`);
  }
  for (const [nome, p] of Object.entries(r.passos)) {
    if (!p.detalhes.length) continue;
    linhas.push('', `${nome}:`);
    for (const d of p.detalhes) linhas.push(`  - ${d}`);
  }
  if (r.avisos.length) linhas.push('', 'Avisos:', ...r.avisos.map((a) => `  - ${a}`));
  if (r.rejeitados.length) {
    const porMotivo = {};
    for (const x of r.rejeitados) porMotivo[`${x.arquivo}: ${x.motivo}`] = (porMotivo[`${x.arquivo}: ${x.motivo}`] || 0) + 1;
    linhas.push('', 'Rejeitados (detalhe no arquivo de rejeitados):', ...Object.entries(porMotivo).map(([m, n]) => `  - ${n}× ${m}`));
  }
  if (r.ausentes.length) linhas.push('', `Arquivos ausentes na origem (nada a migrar deles): ${r.ausentes.join(', ')}`);
  linhas.push('', `Tempo: ${(r.duracaoMs / 1000).toFixed(1)} s`);
  return linhas.join('\n');
}

// Os arquivos de detalhe por critério (avaliacoes-criterios/<evalPartsId>.json)
// que têm log — só esses vão para o volume novo; os sem log o app novo poda.
function arquivosDeDetalhe(dir) {
  const p = path.join(dir, 'logs.json');
  if (!fs.existsSync(p)) return [];
  const ids = new Set(lista(JSON.parse(fs.readFileSync(p, 'utf-8'))).map((l) => l && l.evalPartsId).filter(Boolean));
  return [...ids].map((id) => `avaliacoes-criterios/${id}.json`)
    .filter((f) => fs.existsSync(path.join(dir, f)));
}

module.exports = { migrarDelta, migrarSeletivo, relatorioEmTexto, arquivosDeDetalhe, CONQUISTAS };
