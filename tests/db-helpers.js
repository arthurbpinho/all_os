// Postgres de teste: um schema descartável por teste.
//
// A suíte roda em forks paralelos (vitest.config.js), e dois arquivos de teste
// no mesmo schema disputariam as mesmas tabelas — passariam e falhariam ao
// acaso. Cada chamada cria um schema com nome aleatório e `descartar()` apaga
// tudo.
//
// Sem TEST_DATABASE_URL os testes de banco são pulados: suba o banco com
// `npm run db:up`.

const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const URL_TESTE = process.env.TEST_DATABASE_URL;

const nomeDeSchema = () => `teste_${crypto.randomBytes(6).toString('hex')}`;

// Uma conexão só, sem migrações — para testar o próprio runner de migrações.
// O search_path vale para esta conexão e nenhuma outra.
async function criarSchemaIsolado() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_TESTE, max: 1 });
  const client = await pool.connect();
  const schema = nomeDeSchema();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);

  async function descartar() {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  return { client, schema, descartar };
}

// Um Pool inteiro ancorado no schema, já migrado — é o que o código de produção
// recebe. O search_path vai no parâmetro de conexão (`options`), então TODA
// conexão que o pool abrir cai no schema do teste, inclusive as das transações.
async function criarPoolIsolado() {
  const { Pool } = require('pg');
  const { migrate } = require('../server/db/migrate');
  const schema = nomeDeSchema();
  const pool = new Pool({ connectionString: URL_TESTE, options: `-c search_path=${schema}` });

  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await migrate(client);
  } finally {
    client.release();
  }

  async function descartar() {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }

  return { pool, schema, descartar };
}

module.exports = { URL_TESTE, criarSchemaIsolado, criarPoolIsolado };
