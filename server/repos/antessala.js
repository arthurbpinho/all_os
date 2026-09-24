// Mapas de caso da Antessala no PostgreSQL: substitui antessala.json.
//
// O mapa é um documento aninhado que a tela lê e grava inteiro; aqui ele fica
// numa linha, com as chaves de busca em colunas. Editar, entregar ou excluir um
// mapa trava só aquele mapa.

const { transacao } = require('../db');

function colunas(doc) {
  return [String(doc.id), String(doc.ownerId), doc.status, doc.createdAt, doc.updatedAt, JSON.stringify(doc)];
}

function criarRepoAntessala(pool) {
  async function criar(doc) {
    await pool.query(
      `INSERT INTO antessala_mapas (id, owner_id, status, criado_em, atualizado_em, doc)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      colunas(doc),
    );
    return doc;
  }

  async function porId(id) {
    const { rows } = await pool.query('SELECT doc FROM antessala_mapas WHERE id = $1', [String(id)]);
    return rows[0] ? rows[0].doc : null;
  }

  // Mapas de um dono, mais recentemente alterados primeiro.
  async function doDono(ownerId) {
    if (!/^[0-9]{1,18}$/.test(String(ownerId))) return [];
    const { rows } = await pool.query(
      'SELECT doc FROM antessala_mapas WHERE owner_id = $1 ORDER BY atualizado_em DESC, id',
      [String(ownerId)],
    );
    return rows.map((r) => r.doc);
  }

  // Mapas entregues — de todos (sem `ownerIds`) ou só dos donos dados.
  async function entregues(ownerIds = null) {
    if (ownerIds && !ownerIds.length) return [];
    const { rows } = ownerIds
      ? await pool.query(
        `SELECT doc FROM antessala_mapas WHERE status = 'delivered' AND owner_id = ANY($1::bigint[])`,
        [ownerIds.map(String)],
      )
      : await pool.query(`SELECT doc FROM antessala_mapas WHERE status = 'delivered'`);
    return rows.map((r) => r.doc);
  }

  // Trava UM mapa e entrega o documento a `fn`, que responde
  // { gravar?: <doc novo>, excluir?, valor }. Devolve { encontrado, valor }.
  async function travar(id, fn) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query('SELECT doc FROM antessala_mapas WHERE id = $1 FOR UPDATE', [String(id)]);
      if (!rows.length) return { encontrado: false };
      const resposta = (await fn(rows[0].doc)) || {};
      if (resposta.excluir) {
        await client.query('DELETE FROM antessala_mapas WHERE id = $1', [String(id)]);
      } else if (resposta.gravar) {
        await client.query(
          `UPDATE antessala_mapas SET owner_id = $2, status = $3, criado_em = $4, atualizado_em = $5, doc = $6
           WHERE id = $1`,
          colunas(resposta.gravar),
        );
      }
      return { encontrado: true, valor: resposta.valor };
    });
  }

  return { criar, porId, doDono, entregues, travar };
}

module.exports = { criarRepoAntessala };
