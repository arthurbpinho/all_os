// Discussões da Comunidade no PostgreSQL: substitui comunidade.json.
//
// A discussão é o documento de sempre (título, texto, enquete, votos e
// comentários), que as regras puras de server/comunidade.js leem e alteram. Uma
// linha por discussão: comentar ou votar trava só aquela discussão, em vez de
// regravar o feed inteiro.

const { transacao } = require('../db');

function criarRepoComunidade(pool) {
  // Todas, na ordem de criação (a mesma do array do arquivo).
  async function listar() {
    const { rows } = await pool.query('SELECT doc FROM comunidade_discussoes ORDER BY id');
    return rows.map((r) => r.doc);
  }

  async function porId(id) {
    if (!/^[0-9]{1,18}$/.test(String(id))) return null;
    const { rows } = await pool.query('SELECT doc FROM comunidade_discussoes WHERE id = $1', [String(id)]);
    return rows[0] ? rows[0].doc : null;
  }

  // Cria com o próximo id: `montar(id)` recebe o id (string, como vai na URL) e
  // devolve o documento.
  async function criar(montar) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT nextval(pg_get_serial_sequence('comunidade_discussoes', 'id'))::text AS id`,
      );
      const doc = montar(rows[0].id);
      await client.query(
        'INSERT INTO comunidade_discussoes (id, author_id, criado_em, doc) VALUES ($1, $2, $3, $4)',
        [rows[0].id, doc.authorId == null ? null : String(doc.authorId), doc.createdAt, JSON.stringify(doc)],
      );
      return doc;
    });
  }

  // Trava UMA discussão e entrega o documento a `fn`, que o altera no lugar e
  // responde { gravar?, excluir?, valor }. Devolve { encontrado, valor }.
  async function travar(id, fn) {
    if (!/^[0-9]{1,18}$/.test(String(id))) return { encontrado: false };
    return transacao(pool, async (client) => {
      const { rows } = await client.query('SELECT doc FROM comunidade_discussoes WHERE id = $1 FOR UPDATE', [String(id)]);
      if (!rows.length) return { encontrado: false };
      const doc = rows[0].doc;
      const resposta = (await fn(doc)) || {};
      if (resposta.excluir) {
        await client.query('DELETE FROM comunidade_discussoes WHERE id = $1', [String(id)]);
      } else if (resposta.gravar) {
        await client.query('UPDATE comunidade_discussoes SET doc = $2 WHERE id = $1', [String(id), JSON.stringify(doc)]);
      }
      return { encontrado: true, valor: resposta.valor };
    });
  }

  // Apaga o conteúdo de um usuário: as discussões dele (todas, ou só as `ids`) e,
  // quando é tudo, os comentários dele viram lápide. Numa transação, com as
  // discussões travadas. Devolve quantos itens saíram.
  async function purgar(userId, ids = null) {
    const uid = String(userId);
    const alvo = ids ? new Set(ids.map(String)) : null;
    return transacao(pool, async (client) => {
      const { rows } = await client.query('SELECT id::text, doc FROM comunidade_discussoes ORDER BY id FOR UPDATE');
      let n = 0;
      for (const { id, doc } of rows) {
        if (doc.authorId === uid && (!alvo || alvo.has(id))) {
          await client.query('DELETE FROM comunidade_discussoes WHERE id = $1', [id]);
          n += 1;
          continue;
        }
        if (alvo) continue;
        let mudou = false;
        for (const c of (doc.comments || [])) {
          if (c.authorId === uid && !c.deleted) {
            c.deleted = true; c.body = ''; delete c.author; n += 1; mudou = true;
          }
        }
        if (mudou) await client.query('UPDATE comunidade_discussoes SET doc = $2 WHERE id = $1', [id, JSON.stringify(doc)]);
      }
      return n;
    });
  }

  return { listar, porId, criar, travar, purgar };
}

module.exports = { criarRepoComunidade };
