// Antes e depois da suíte inteira: apaga os schemas de teste (`teste_*`) que
// sobraram. Cada arquivo de teste apaga o seu ao terminar, mas uma execução
// interrompida no meio (Ctrl+C, fork que caiu) deixa o schema para trás.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function limparSchemasDeTeste() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'teste\\_%'");
    for (const { nspname } of rows) {
      await client.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

// O Vitest roda o export padrão antes da suíte e a função devolvida, depois.
module.exports = async function setup() {
  await limparSchemasDeTeste();
  return limparSchemasDeTeste;
};
