// Duelos no PostgreSQL: substitui duels.json.
//
// O duelo é um documento aninhado — os dois lados, cada um com a sessão enviada,
// e o resultado — que as rotas leem e alteram inteiro. Ele fica em JSONB, uma
// linha por duelo (ver 004_mmr_duelos.sql). O que muda em relação ao arquivo:
// `travar` trava só o duelo alterado, e não o arquivo com todos os duelos.

const { transacao } = require('../db');

// Colunas de busca extraídas do documento, na ordem do INSERT/UPDATE.
function colunas(duel) {
  const lado = (s) => (s && s.userId ? String(s.userId) : null);
  return [
    String(duel.id),
    String(duel.token),
    String(duel.status),
    duel.createdAt || new Date().toISOString(),
    lado(duel.challenger),
    lado(duel.opponent),
    JSON.stringify(duel),
  ];
}

function criarRepoDuelos(pool) {
  async function criar(duel) {
    await pool.query(
      `INSERT INTO duels (id, token, status, criado_em, challenger_id, opponent_id, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      colunas(duel),
    );
    return duel;
  }

  async function porId(id) {
    const { rows } = await pool.query('SELECT doc FROM duels WHERE id = $1', [String(id)]);
    return rows[0] ? rows[0].doc : null;
  }

  async function porToken(token) {
    const { rows } = await pool.query('SELECT doc FROM duels WHERE token = $1', [String(token)]);
    return rows[0] ? rows[0].doc : null;
  }

  // Duelos em que a conta ou o visitante é um dos lados, em ordem de criação.
  async function listarDoParticipante(userId) {
    const { rows } = await pool.query(
      'SELECT doc FROM duels WHERE challenger_id = $1 OR opponent_id = $1 ORDER BY criado_em, id',
      [String(userId)],
    );
    return rows.map((r) => r.doc);
  }

  async function listarTodos() {
    const { rows } = await pool.query('SELECT doc FROM duels ORDER BY criado_em, id');
    return rows.map((r) => r.doc);
  }

  // Trava UM duelo (por `id` ou por `token`) e entrega o documento a `fn`, que o
  // altera no lugar e responde { gravar?, excluir?, valor }. Grava ou exclui
  // conforme a resposta, na mesma transação.
  // Devolve { encontrado: false } ou { encontrado: true, valor }.
  async function travar({ id, token }, fn) {
    const porIdentificador = id !== undefined;
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT doc FROM duels WHERE ${porIdentificador ? 'id' : 'token'} = $1 FOR UPDATE`,
        [String(porIdentificador ? id : token)],
      );
      if (!rows.length) return { encontrado: false };
      const duel = rows[0].doc;
      const resposta = (await fn(duel)) || {};
      if (resposta.excluir) {
        await client.query('DELETE FROM duels WHERE id = $1', [String(duel.id)]);
      } else if (resposta.gravar) {
        await client.query(
          `UPDATE duels SET token = $2, status = $3, criado_em = $4, challenger_id = $5,
                            opponent_id = $6, doc = $7
           WHERE id = $1`,
          colunas(duel),
        );
      }
      return { encontrado: true, valor: resposta.valor };
    });
  }

  // Retenção: remove os duelos criados há mais de `ttlMs`. Devolve quantos saíram
  // e as chaves dos detalhes por critério deles — o detalhe mora no volume, e sem
  // a chave ninguém mais o alcançaria.
  async function podarVencidos(ttlMs) {
    const { rows } = await pool.query(
      `DELETE FROM duels WHERE criado_em < now() - ($1::bigint * interval '1 millisecond')
       RETURNING doc->'result'->>'evalPartsId' AS eval_parts_id`,
      [Math.floor(ttlMs)],
    );
    return { removidos: rows.length, evalPartsIds: rows.map((r) => r.eval_parts_id).filter(Boolean) };
  }

  return { criar, porId, porToken, listarDoParticipante, listarTodos, travar, podarVencidos };
}

module.exports = { criarRepoDuelos };
