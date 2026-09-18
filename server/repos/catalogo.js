// Catálogos (pacientes, neuro, exercícios, competências da Trilha) no
// PostgreSQL (015_catalogo.sql).

const { transacao } = require('../db');

const TIPOS = ['freeplay', 'neuro', 'exercicios', 'trilha_skills'];
const marcaSemeado = (tipo) => `catalogo-${tipo}-semeado`;

function conferirTipo(tipo) {
  if (!TIPOS.includes(tipo)) throw new Error(`Catálogo desconhecido: ${tipo}`);
}

// Item sem id não tem como ser editado nem excluído depois; id repetido faria
// o segundo apagar o primeiro. Os dois são recusados antes de chegar ao banco.
function conferirLista(tipo, lista) {
  if (!Array.isArray(lista)) throw new Error(`O catálogo ${tipo} tem de ser uma lista.`);
  const ids = new Set();
  for (const item of lista) {
    const id = item && item.id != null ? String(item.id) : '';
    if (!id) throw new Error(`Item sem id no catálogo ${tipo}.`);
    if (ids.has(id)) throw new Error(`Id repetido no catálogo ${tipo}: ${id}.`);
    ids.add(id);
  }
}

async function inserirTodos(client, tipo, lista) {
  if (!lista.length) return;
  await client.query(
    `INSERT INTO catalogo_itens (tipo, id, ordem, doc)
     SELECT $1, t.x->>'id', t.ord::int, t.x
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(x, ord)`,
    [tipo, JSON.stringify(lista)],
  );
}

function criarRepoCatalogo(pool) {
  // { freeplay: [...], neuro: [...], ... } na ordem gravada.
  async function todos() {
    const { rows } = await pool.query('SELECT tipo, doc FROM catalogo_itens ORDER BY tipo, ordem');
    const out = Object.fromEntries(TIPOS.map((t) => [t, []]));
    for (const r of rows) out[r.tipo].push(r.doc);
    return out;
  }

  // Troca o catálogo inteiro pela lista dada. É o mesmo "lê tudo, altera, grava
  // tudo" dos arquivos, que o app já fazia — os catálogos têm dezenas de itens.
  async function substituir(tipo, lista) {
    conferirTipo(tipo);
    conferirLista(tipo, lista);
    await transacao(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`catalogo:${tipo}`]);
      await client.query('DELETE FROM catalogo_itens WHERE tipo = $1', [tipo]);
      await inserirTodos(client, tipo, lista);
    });
  }

  // Primeira carga de um catálogo (do volume ou do padrão), UMA vez: depois da
  // marca, um catálogo que o admin esvaziou continua vazio no próximo boot.
  // Devolve true se semeou.
  async function semearUmaVez(tipo, lista) {
    conferirTipo(tipo);
    conferirLista(tipo, lista);
    return transacao(pool, async (client) => {
      const marca = await client.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ($1, 'true') ON CONFLICT DO NOTHING RETURNING chave`,
        [marcaSemeado(tipo)],
      );
      if (!marca.rowCount) return false;
      const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM catalogo_itens WHERE tipo = $1', [tipo]);
      if (n === 0) await inserirTodos(client, tipo, lista);
      return true;
    });
  }

  async function jaSemeado(tipo) {
    const { rowCount } = await pool.query('SELECT 1 FROM configuracoes WHERE chave = $1', [marcaSemeado(tipo)]);
    return rowCount > 0;
  }

  return { todos, substituir, semearUmaVez, jaSemeado };
}

module.exports = { criarRepoCatalogo, TIPOS, marcaSemeado, conferirLista };
