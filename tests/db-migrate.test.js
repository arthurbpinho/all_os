// Runner de migrações contra um Postgres de verdade (o do docker-compose).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL_TESTE, criarSchemaIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('migrações de schema', () => {
  const { migrate } = require('../server/db/migrate');

  let db;
  let dir;

  const escrever = (nome, sql) => fs.writeFileSync(path.join(dir, nome), sql);

  beforeEach(async () => {
    db = await criarSchemaIsolado();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-migrations-'));
  });

  afterEach(async () => {
    await db.descartar();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aplica os arquivos em ordem numérica e registra cada um', async () => {
    escrever('002_segunda.sql', 'ALTER TABLE exemplo ADD COLUMN nome TEXT;');
    escrever('001_primeira.sql', 'CREATE TABLE exemplo (id BIGINT PRIMARY KEY);');

    const novas = await migrate(db.client, { dir });

    expect(novas).toEqual(['001_primeira.sql', '002_segunda.sql']);
    const { rows } = await db.client.query('SELECT versao FROM schema_migrations ORDER BY versao');
    expect(rows.map((r) => r.versao)).toEqual(['001_primeira.sql', '002_segunda.sql']);
  });

  it('não reaplica o que já rodou', async () => {
    escrever('001_primeira.sql', 'CREATE TABLE exemplo (id BIGINT PRIMARY KEY);');
    await migrate(db.client, { dir });

    const segundaVez = await migrate(db.client, { dir });

    expect(segundaVez).toEqual([]);
  });

  it('migração que falha não deixa nada para trás nem é marcada como aplicada', async () => {
    escrever('001_quebrada.sql', 'CREATE TABLE parcial (id BIGINT); SELECT coluna_que_nao_existe FROM parcial;');

    await expect(migrate(db.client, { dir })).rejects.toThrow(/001_quebrada\.sql/);

    const tabela = await db.client.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
      [db.schema, 'parcial'],
    );
    expect(tabela.rowCount).toBe(0);
    const registro = await db.client.query('SELECT 1 FROM schema_migrations');
    expect(registro.rowCount).toBe(0);
  });

  it('ignora arquivo fora do padrão NNN_nome.sql', async () => {
    escrever('rascunho.sql', 'CREATE TABLE nao_devia (id BIGINT);');
    escrever('LEIAME.md', 'nada');

    const novas = await migrate(db.client, { dir });

    expect(novas).toEqual([]);
  });
});
