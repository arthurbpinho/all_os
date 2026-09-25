// Migrações de schema: arquivos `NNN_descricao.sql` em server/db/migrations,
// aplicados em ordem, cada um uma única vez. Substitui o migrations.json (os
// marcadores one-shot do boot), como o CLAUDE.md §4 recomenda.
//
// Cada arquivo roda numa transação própria: se falhar no meio, nada dele fica
// no banco e ele não é marcado como aplicado — a próxima execução tenta de novo.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ARQUIVO_VALIDO = /^\d{3,}_[\w-]+\.sql$/;

// Chave do advisory lock. Um deploy novo pode subir enquanto o anterior ainda
// está de pé, e dois processos migrando ao mesmo tempo aplicariam o mesmo
// arquivo duas vezes. O lock serializa os dois; o valor só precisa ser fixo.
const LOCK_ID = 7140001;

// `client` tem de ser uma conexão dedicada (pool.connect()), não o pool: o
// advisory lock pertence à sessão, e o pool poderia soltar e pegar conexões
// diferentes entre o lock e o unlock.
async function migrate(client, { dir = MIGRATIONS_DIR } = {}) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        versao      TEXT PRIMARY KEY,
        aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT versao FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.versao));

    const arquivos = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => ARQUIVO_VALIDO.test(f)).sort()
      : [];

    const novas = [];
    for (const arquivo of arquivos) {
      if (aplicadas.has(arquivo)) continue;
      const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (versao) VALUES ($1)', [arquivo]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migração ${arquivo} falhou: ${e.message}`);
      }
      novas.push(arquivo);
    }
    return novas;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  }
}

module.exports = { migrate, MIGRATIONS_DIR };

// `npm run db:migrate`
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const { getPool, closePool } = require('../db');
  (async () => {
    const client = await getPool().connect();
    try {
      const novas = await migrate(client);
      console.log(novas.length
        ? `[db] migrações aplicadas: ${novas.join(', ')}`
        : '[db] nenhuma migração pendente');
    } finally {
      client.release();
      await closePool();
    }
  })().catch((e) => {
    console.error('[db]', e.message);
    process.exit(1);
  });
}
