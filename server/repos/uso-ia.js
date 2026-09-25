// Uso de IA por conta no PostgreSQL (012_uso_ia.sql).

const ID = /^[0-9]{1,18}$/;

function criarRepoUsoIa(pool) {
  async function registrar(userId, { categoria = '', modelo = '', tokens = 0, usd = null } = {}) {
    if (!ID.test(String(userId))) return;
    await pool.query(
      `INSERT INTO uso_ia (user_id, categoria, modelo, tokens, usd) VALUES ($1, $2, $3, $4, $5)`,
      [String(userId), String(categoria).slice(0, 40), String(modelo).slice(0, 80),
        Math.max(0, Math.floor(Number(tokens) || 0)), Number.isFinite(usd) && usd >= 0 ? usd : null],
    );
  }

  // { usd, tokens, primeiro } da conta na janela.
  async function somaJanela(userId, janelaMs) {
    if (!ID.test(String(userId))) return { usd: 0, tokens: 0, primeiro: null };
    const { rows } = await pool.query(
      `SELECT COALESCE(sum(usd), 0)::float8 AS usd, COALESCE(sum(tokens), 0)::float8 AS tokens, min(criado_em) AS primeiro
       FROM uso_ia WHERE user_id = $1 AND criado_em > now() - make_interval(secs => $2)`,
      [String(userId), janelaMs / 1000],
    );
    const r = rows[0];
    return { usd: r.usd, tokens: r.tokens, primeiro: r.primeiro ? r.primeiro.toISOString() : null };
  }

  // Uso na janela de cada conta ativa de um papel (a tela do admin).
  async function resumoDoPapel(role, janelaMs) {
    const { rows } = await pool.query(
      `SELECT u.id::text AS "userId", u.name, u.username,
              COALESCE(sum(x.usd), 0)::float8 AS usd, COALESCE(sum(x.tokens), 0)::float8 AS tokens,
              min(x.criado_em) AS primeiro
       FROM users u
       LEFT JOIN uso_ia x ON x.user_id = u.id AND x.criado_em > now() - make_interval(secs => $2)
       WHERE u.role = $1 AND u.excluido_em IS NULL
       GROUP BY u.id ORDER BY usd DESC, tokens DESC, lower(u.name)`,
      [role, janelaMs / 1000],
    );
    return rows.map((r) => ({ ...r, primeiro: r.primeiro ? r.primeiro.toISOString() : null }));
  }

  // true (e marca) quando a conta não foi avisada dentro da janela: um aviso ao
  // suporte por estouro. Atômico — duas chamadas recusadas ao mesmo tempo não
  // geram dois avisos.
  async function deveAlertar(userId, janelaMs) {
    if (!ID.test(String(userId))) return false;
    const { rowCount } = await pool.query(
      `INSERT INTO uso_ia_alertas (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET alertado_em = now()
       WHERE uso_ia_alertas.alertado_em <= now() - make_interval(secs => $2)`,
      [String(userId), janelaMs / 1000],
    );
    return rowCount > 0;
  }

  async function idsDosAdmins() {
    const { rows } = await pool.query(`SELECT id::text FROM users WHERE role = 'admin' AND excluido_em IS NULL`);
    return rows.map((r) => r.id);
  }

  async function podar(idadeMs) {
    const r = await pool.query(`DELETE FROM uso_ia WHERE criado_em < now() - make_interval(secs => $1)`, [idadeMs / 1000]);
    return r.rowCount;
  }

  return { registrar, somaJanela, resumoDoPapel, deveAlertar, idsDosAdmins, podar };
}

module.exports = { criarRepoUsoIa };
