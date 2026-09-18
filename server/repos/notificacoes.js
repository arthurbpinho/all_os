// Notificações do sino e inscrições de Web Push no PostgreSQL: substitui
// notifications.json e push-subscriptions.json.
//
// Cada notificação é uma linha: criar, atualizar ou marcar como lida mexe só
// nela, em vez de regravar o mapa de todo mundo.

const ID_CONTA = /^[0-9]{1,18}$/;
const MAX_POR_PESSOA = 50;
const MAX_DISPOSITIVOS = 10;

const ehConta = (id) => ID_CONTA.test(String(id || ''));

// Linha → notificação no formato de sempre: { id, createdAt, read, refId?, ...conteúdo }.
function paraNotificacao(r) {
  return {
    ...r.doc,
    id: r.id,
    createdAt: r.criado_em.toISOString(),
    read: r.lida,
    ...(r.ref_id ? { refId: r.ref_id } : {}),
  };
}

// Tira do conteúdo os campos que viram coluna.
function conteudo(notif) {
  const { id, createdAt, read, refId, ...resto } = notif || {};
  return resto;
}

function criarRepoNotificacoes(pool) {
  // Mantém só as MAX_POR_PESSOA mais recentes do sino.
  async function podarExcesso(userId) {
    await pool.query(
      `DELETE FROM notificacoes WHERE user_id = $1 AND id IN (
         SELECT id FROM notificacoes WHERE user_id = $1 ORDER BY ordem DESC OFFSET $2)`,
      [String(userId), MAX_POR_PESSOA],
    );
  }

  async function criar(userId, id, notif) {
    if (!ehConta(userId)) return null;
    const { rows } = await pool.query(
      `INSERT INTO notificacoes (id, user_id, doc) VALUES ($1, $2, $3) RETURNING *`,
      [id, String(userId), JSON.stringify(conteudo(notif))],
    );
    await podarExcesso(userId);
    return paraNotificacao(rows[0]);
  }

  // Cria ou ATUALIZA pela chave `refId`: a atualização mescla o conteúdo, volta a
  // não lida e sobe ao topo. Uma instrução só — duas atualizações simultâneas
  // da mesma avaliação não viram duas notificações.
  async function criarOuAtualizar(userId, refId, id, notif) {
    if (!ehConta(userId)) return null;
    const { rows } = await pool.query(
      `INSERT INTO notificacoes (id, user_id, ref_id, doc) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, ref_id) WHERE ref_id IS NOT NULL DO UPDATE
         SET doc = notificacoes.doc || EXCLUDED.doc, lida = false, criado_em = now(),
             ordem = nextval('notificacoes_ordem_seq')
       RETURNING *`,
      [id, String(userId), refId, JSON.stringify(conteudo(notif))],
    );
    await podarExcesso(userId);
    return paraNotificacao(rows[0]);
  }

  async function doUsuario(userId) {
    if (!ehConta(userId)) return [];
    const { rows } = await pool.query(
      'SELECT * FROM notificacoes WHERE user_id = $1 ORDER BY ordem DESC LIMIT $2',
      [String(userId), MAX_POR_PESSOA],
    );
    return rows.map(paraNotificacao);
  }

  async function marcarLida(userId, id) {
    if (!ehConta(userId)) return;
    await pool.query('UPDATE notificacoes SET lida = true WHERE user_id = $1 AND id = $2', [String(userId), String(id)]);
  }

  async function marcarTodasLidas(userId) {
    if (!ehConta(userId)) return;
    await pool.query('UPDATE notificacoes SET lida = true WHERE user_id = $1 AND NOT lida', [String(userId)]);
  }

  // Convite de um duelo: marcar como lido (aceitou) ou apagar (duelo cancelado).
  async function marcarConviteDeDueloLido(userId, duelId) {
    if (!ehConta(userId)) return;
    await pool.query(
      `UPDATE notificacoes SET lida = true
       WHERE user_id = $1 AND NOT lida AND doc->>'type' = 'duel_invite' AND doc->>'duelId' = $2`,
      [String(userId), String(duelId)],
    );
  }

  async function removerConviteDeDuelo(userId, duelId) {
    if (!ehConta(userId)) return;
    await pool.query(
      `DELETE FROM notificacoes WHERE user_id = $1 AND doc->>'type' = 'duel_invite' AND doc->>'duelId' = $2`,
      [String(userId), String(duelId)],
    );
  }

  // Tudo, no formato do notifications.json (export do admin).
  async function todasPorUsuario() {
    const { rows } = await pool.query('SELECT * FROM notificacoes ORDER BY user_id, ordem DESC');
    const mapa = {};
    for (const r of rows) (mapa[String(r.user_id)] ||= []).push(paraNotificacao(r));
    return mapa;
  }

  // --- Web Push ---

  function paraInscricao(r) {
    return { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, ua: r.ua, createdAt: r.criado_em.toISOString() };
  }

  async function inscricoes(userId) {
    if (!ehConta(userId)) return [];
    const { rows } = await pool.query('SELECT * FROM push_inscricoes WHERE user_id = $1 ORDER BY ordem', [String(userId)]);
    return rows.map(paraInscricao);
  }

  // Assina (ou renova) um dispositivo. Um endpoint já assinado é atualizado no
  // lugar; acima de MAX_DISPOSITIVOS saem os mais antigos.
  async function inscrever(userId, { endpoint, keys, ua }) {
    if (!ehConta(userId)) return;
    await pool.query(
      `INSERT INTO push_inscricoes (user_id, endpoint, p256dh, auth, ua) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, ua = EXCLUDED.ua, criado_em = now()`,
      [String(userId), endpoint, keys.p256dh, keys.auth, ua || null],
    );
    await pool.query(
      `DELETE FROM push_inscricoes WHERE user_id = $1 AND endpoint IN (
         SELECT endpoint FROM push_inscricoes WHERE user_id = $1 ORDER BY ordem DESC OFFSET $2)`,
      [String(userId), MAX_DISPOSITIVOS],
    );
  }

  async function desinscrever(userId, endpoints) {
    if (!ehConta(userId) || !endpoints.length) return;
    await pool.query(
      'DELETE FROM push_inscricoes WHERE user_id = $1 AND endpoint = ANY($2::text[])',
      [String(userId), endpoints],
    );
  }

  return {
    criar,
    criarOuAtualizar,
    doUsuario,
    marcarLida,
    marcarTodasLidas,
    marcarConviteDeDueloLido,
    removerConviteDeDuelo,
    todasPorUsuario,
    inscricoes,
    inscrever,
    desinscrever,
  };
}

module.exports = { criarRepoNotificacoes, MAX_POR_PESSOA, MAX_DISPOSITIVOS };
