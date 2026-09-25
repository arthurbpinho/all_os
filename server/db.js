// Acesso ao PostgreSQL (Neon em produção, Docker em dev/teste).
//
// É o substituto de readJSON/writeJSON. A regra da migração vale para todo uso
// deste módulo: nunca "ler a coleção inteira, alterar em memória e regravar" —
// isso reproduziria em cima do banco a race condition que motivou a troca.
// Escreva direto na linha afetada, e use uma transação quando uma operação
// tocar mais de uma tabela.

const { Pool } = require('pg');

let pool = null;

// DATABASE_SCHEMA existe para a suíte de testes: cada arquivo de teste roda num
// schema próprio. O search_path vai no parâmetro de conexão, então vale para
// toda conexão que o pool abrir. Em produção fica vazio (schema public).
function schemaConfigurado() {
  const schema = process.env.DATABASE_SCHEMA;
  if (!schema) return null;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`DATABASE_SCHEMA inválido: "${schema}".`);
  }
  return schema;
}

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL ausente: o servidor não tem onde persistir os dados.');
    }
    const schema = schemaConfigurado();
    pool = new Pool({ connectionString, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

// Roda `fn(client)` numa transação sobre `alvo` (um Pool). Qualquer exceção
// desfaz tudo que foi feito dentro dela — é o que garante que uma operação em
// várias tabelas (ex.: fechar um duelo e atualizar o MMR dos dois lados) nunca
// fique pela metade.
async function transacao(alvo, fn) {
  const client = await alvo.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function withTransaction(fn) {
  return transacao(getPool(), fn);
}

// Deixa o banco pronto para o app: cria o schema de teste (quando há um) e
// aplica as migrações pendentes. Devolve os nomes das migrações aplicadas.
async function iniciar() {
  const { migrate } = require('./db/migrate');
  const client = await getPool().connect();
  try {
    const schema = schemaConfigurado();
    if (schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    return await migrate(client);
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { getPool, query, transacao, withTransaction, iniciar, closePool };
