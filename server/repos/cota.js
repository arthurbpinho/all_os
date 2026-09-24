// Cota de sessões do aluno externo no PostgreSQL: substitui
// external-session-starts.json. A REGRA continua em server/session-quota.js
// (pura); aqui fica só a persistência, no formato que ela lê: [{ t, key }].

const { transacao } = require('../db');

// Chave da trava por usuário (pg_advisory_xact_lock de duas partes: esta
// constante + o hash do id). Diferente da trava das migrações.
const TRAVA_COTA = 7140002;

function criarRepoCota(pool) {
  const SELECT_INICIOS = `
    SELECT (extract(epoch FROM iniciado_em) * 1000)::float8 AS t, chave AS key
    FROM cota_sessoes
    WHERE user_id = $1 AND iniciado_em > now() - ($2::bigint * interval '1 millisecond')
    ORDER BY iniciado_em, id`;

  // Aberturas do usuário ainda dentro da janela.
  async function inicios(userId, janelaMs) {
    const { rows } = await pool.query(SELECT_INICIOS, [String(userId), Math.floor(janelaMs)]);
    return rows;
  }

  // Roda `decidir(inicios, { registrar })` com a cota do usuário travada: dois
  // cliques em "Iniciar" ao mesmo tempo não viram um registro só, nem passam os
  // dois quando só resta um slot. As aberturas fora da janela são apagadas aqui.
  async function comTrava(userId, janelaMs, decidir) {
    const id = String(userId);
    return transacao(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TRAVA_COTA, id]);
      await client.query(
        `DELETE FROM cota_sessoes WHERE user_id = $1 AND iniciado_em <= now() - ($2::bigint * interval '1 millisecond')`,
        [id, Math.floor(janelaMs)],
      );
      const { rows } = await client.query(SELECT_INICIOS, [id, Math.floor(janelaMs)]);
      const registrar = (chave) => client.query('INSERT INTO cota_sessoes (user_id, chave) VALUES ($1, $2)', [id, chave || null]);
      return decidir(rows, { registrar });
    });
  }

  // Fecha a sessão daquela chave (o atendimento foi finalizado). O registro
  // continua contando para a cota.
  async function fechar(userId, chave) {
    await pool.query('UPDATE cota_sessoes SET chave = NULL WHERE user_id = $1 AND chave = $2', [String(userId), chave]);
  }

  return { inicios, comTrava, fechar };
}

module.exports = { criarRepoCota };
