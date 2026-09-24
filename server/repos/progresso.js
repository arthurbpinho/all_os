// Progresso da Trilha no PostgreSQL: o substituto do progress.json.
//
// No arquivo era { [userId]: { [chave]: valor } }, e o POST /api/progress fazia
// merge RASO do corpo sobre o objeto do usuário. Aqui cada chave é uma linha: o
// merge vira um UPSERT por chave, e duas gravações simultâneas de chaves
// diferentes deixam de apagar uma à outra.

const { transacao } = require('../db');
const { colunasDoDono } = require('./logs');

function criarRepoProgresso(pool) {
  // Coluna e valor do dono (conta ou visitante), ou null se o id não é de dono.
  function dono(userId) {
    const d = colunasDoDono(userId);
    if (!d) return null;
    return d.user_id ? { coluna: 'user_id', valor: d.user_id } : { coluna: 'visitante_id', valor: d.visitante_id };
  }

  // O progresso do dono no formato do JSON: { [chave]: valor }, na ordem em que
  // as chaves apareceram pela primeira vez.
  async function doDono(userId, db = pool) {
    const d = dono(userId);
    if (!d) return {};
    const { rows } = await db.query(
      `SELECT chave, valor FROM progress WHERE ${d.coluna} = $1 ORDER BY id`,
      [d.valor],
    );
    return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  }

  // Merge raso: cada chave do patch substitui a chave inteira (não mescla dentro
  // do valor). Devolve o progresso completo depois do merge, ou null se o dono
  // não é válido.
  async function mesclar(userId, patch) {
    const d = dono(userId);
    if (!d) return null;
    return transacao(pool, async (client) => {
      for (const [chave, valor] of Object.entries(patch || {})) {
        await client.query(
          `INSERT INTO progress (${d.coluna}, chave, valor) VALUES ($1, $2, $3)
           ON CONFLICT (${d.coluna}, chave) WHERE ${d.coluna} IS NOT NULL
           DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
          [d.valor, chave, JSON.stringify(valor ?? null)],
        );
      }
      return doDono(userId, client);
    });
  }

  // Reset do ranking: o progresso de todo mundo sai junto com as notas.
  async function limparTudo() {
    await pool.query('DELETE FROM progress');
  }

  // Todo o progresso no formato do progress.json ({ [userId]: { [chave]: valor } }),
  // para o export completo do admin.
  async function todosPorDono() {
    const { rows } = await pool.query(
      'SELECT COALESCE(user_id::text, visitante_id) AS dono, chave, valor FROM progress ORDER BY id',
    );
    const out = {};
    for (const r of rows) {
      if (!out[r.dono]) out[r.dono] = {};
      out[r.dono][r.chave] = r.valor;
    }
    return out;
  }

  return { doDono, mesclar, limparTudo, todosPorDono };
}

module.exports = { criarRepoProgresso };
