// Tags de terapeutas no PostgreSQL (010_tags.sql).

const { transacao } = require('../db');

const ID = /^[0-9]{1,18}$/;
const NOME_MAX = 40;

function normalizarNome(nome) {
  return String(nome == null ? '' : nome).trim().replace(/\s+/g, ' ').slice(0, NOME_MAX);
}

function criarRepoTags(pool) {
  // Todas, em ordem alfabética, com quantas contas (ativas) têm cada uma.
  async function listar() {
    const { rows } = await pool.query(
      `SELECT t.id::text, t.nome, count(u.id)::int AS total
       FROM tags t
       LEFT JOIN user_tags ut ON ut.tag_id = t.id
       LEFT JOIN users u ON u.id = ut.user_id AND u.excluido_em IS NULL
       GROUP BY t.id ORDER BY lower(t.nome)`,
    );
    return rows;
  }

  // Devolve a tag criada, ou null se o nome já existe (sem diferença de caixa).
  async function criar(nome) {
    const n = normalizarNome(nome);
    if (!n) throw new Error('nome vazio');
    const { rows } = await pool.query(
      `INSERT INTO tags (nome) VALUES ($1) ON CONFLICT (lower(nome)) DO NOTHING RETURNING id::text, nome`,
      [n],
    );
    return rows[0] || null;
  }

  // Devolve { ok } | { naoExiste } | { nomeEmUso }.
  async function renomear(id, nome) {
    const n = normalizarNome(nome);
    if (!ID.test(String(id)) || !n) return { naoExiste: true };
    try {
      const r = await pool.query('UPDATE tags SET nome = $2 WHERE id = $1', [String(id), n]);
      return r.rowCount ? { ok: true } : { naoExiste: true };
    } catch (e) {
      if (e.code === '23505') return { nomeEmUso: true };
      throw e;
    }
  }

  async function excluir(id) {
    if (!ID.test(String(id))) return false;
    const r = await pool.query('DELETE FROM tags WHERE id = $1', [String(id)]);
    return r.rowCount > 0;
  }

  // Troca as tags da conta pelas dadas (ids inexistentes são ignorados).
  async function definirDoUsuario(userId, tagIds) {
    const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(String))].filter((i) => ID.test(i));
    return transacao(pool, async (client) => {
      await client.query('DELETE FROM user_tags WHERE user_id = $1', [String(userId)]);
      if (ids.length) {
        await client.query(
          `INSERT INTO user_tags (user_id, tag_id)
           SELECT $1, id FROM tags WHERE id = ANY($2::bigint[])`,
          [String(userId), ids],
        );
      }
    });
  }

  // { [userId]: [{ id, nome }] } de todas as contas.
  async function porUsuario() {
    const { rows } = await pool.query(
      `SELECT ut.user_id::text, t.id::text, t.nome
       FROM user_tags ut JOIN tags t ON t.id = ut.tag_id ORDER BY lower(t.nome)`,
    );
    const mapa = {};
    for (const r of rows) (mapa[r.user_id] ||= []).push({ id: r.id, nome: r.nome });
    return mapa;
  }

  // Ids das contas com a tag (Set de strings). Tag inválida = nenhuma conta.
  async function contasComTag(tagId) {
    if (!ID.test(String(tagId))) return new Set();
    const { rows } = await pool.query('SELECT user_id::text FROM user_tags WHERE tag_id = $1', [String(tagId)]);
    return new Set(rows.map((r) => r.user_id));
  }

  return { listar, criar, renomear, excluir, definirDoUsuario, porUsuario, contasComTag };
}

module.exports = { criarRepoTags, normalizarNome };
