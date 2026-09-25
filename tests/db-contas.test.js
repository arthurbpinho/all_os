// Schema de contas (001_contas.sql): as regras de CLAUDE.md §5 que passam a ser
// garantidas pelo banco, e não mais só pelo código que lê e regrava users.json.

const { URL_TESTE, criarSchemaIsolado } = require('./db-helpers');

// Códigos de erro do Postgres que as regras produzem.
const UNICO = '23505';
const CHECK = '23514';
const FK = '23503';

describe.skipIf(!URL_TESTE)('schema de contas', () => {
  const { migrate } = require('../server/db/migrate');

  let db;

  beforeEach(async () => {
    db = await criarSchemaIsolado();
    await migrate(db.client);
  });

  afterEach(() => db.descartar());

  async function inserir(tabela, campos) {
    const colunas = Object.keys(campos);
    const { rows } = await db.client.query(
      `INSERT INTO ${tabela} (${colunas.join(', ')})
       VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING *`,
      Object.values(campos),
    );
    return rows[0];
  }

  const conta = (campos = {}) => inserir('users', {
    username: 'fulano', name: 'Fulano de Tal', role: 'external', password_hash: 'hash',
    ...campos,
  });

  const vencimento = () => new Date(Date.now() + 3600_000);

  describe('users', () => {
    it('id volta como string, como era no users.json', async () => {
      const u = await conta();
      expect(typeof u.id).toBe('string');
    });

    it('id de conta excluída nunca é reemitido', async () => {
      await conta({ username: 'primeira' });
      const segunda = await conta({ username: 'segunda' });
      await db.client.query('DELETE FROM users WHERE id = $1', [segunda.id]);

      const terceira = await conta({ username: 'terceira' });

      expect(Number(terceira.id)).toBeGreaterThan(Number(segunda.id));
    });

    it('username é único sem distinguir maiúsculas', async () => {
      await conta({ username: 'Joao' });
      await expect(conta({ username: 'joao' })).rejects.toMatchObject({ code: UNICO });
    });

    it('e-mail é único sem distinguir maiúsculas, e várias contas podem não ter e-mail', async () => {
      await conta({ username: 'um', email: 'Pessoa@Allos.org' });
      await expect(conta({ username: 'dois', email: 'pessoa@allos.org' })).rejects.toMatchObject({ code: UNICO });

      await conta({ username: 'sem1' });
      await conta({ username: 'sem2' });
      const { rows } = await db.client.query('SELECT count(*)::int AS n FROM users WHERE email IS NULL');
      expect(rows[0].n).toBe(2);
    });

    it('recusa papel fora da lista', async () => {
      await expect(conta({ role: 'visitor' })).rejects.toMatchObject({ code: CHECK });
    });

    it('só aluno (interno ou externo) pode ter professor', async () => {
      const prof = await conta({ username: 'prof', role: 'supervisor' });

      await expect(conta({ username: 'outroprof', role: 'supervisor', teacher_id: prof.id }))
        .rejects.toMatchObject({ code: CHECK });

      const externo = await conta({ username: 'externo', role: 'external', teacher_id: prof.id });
      expect(externo.teacher_id).toBe(prof.id);
    });

    it('não deixa excluir professor com aluno vinculado', async () => {
      const prof = await conta({ username: 'prof', role: 'supervisor' });
      await conta({ username: 'aluno', role: 'therapist', teacher_id: prof.id });

      await expect(db.client.query('DELETE FROM users WHERE id = $1', [prof.id]))
        .rejects.toMatchObject({ code: FK });
    });

    it('conta nova nasce com os padrões de perfil do app', async () => {
      const u = await conta();
      expect(u).toMatchObject({
        token_version: 0,
        email_verified: false,
        sidequests_enabled: true,
        share_appearance: null,
        update_all_os: false,
        update_allos: false,
      });
    });
  });

  describe('tokens por e-mail', () => {
    it('um pedido de nova senha por conta, e os pedidos somem com a conta', async () => {
      const u = await conta();
      await inserir('password_resets', { token_hash: 'a'.repeat(64), user_id: u.id, expires_at: vencimento() });

      await expect(inserir('password_resets', { token_hash: 'b'.repeat(64), user_id: u.id, expires_at: vencimento() }))
        .rejects.toMatchObject({ code: UNICO });

      await db.client.query('DELETE FROM users WHERE id = $1', [u.id]);
      const { rowCount } = await db.client.query('SELECT 1 FROM password_resets');
      expect(rowCount).toBe(0);
    });

    it('uma troca de e-mail pendente por conta', async () => {
      const u = await conta();
      await inserir('email_changes', { token_hash: 'a'.repeat(64), user_id: u.id, email: 'novo@x.org', expires_at: vencimento() });

      await expect(inserir('email_changes', { token_hash: 'b'.repeat(64), user_id: u.id, email: 'outro@x.org', expires_at: vencimento() }))
        .rejects.toMatchObject({ code: UNICO });
    });

    it('cadastro pendente segura o nome e o e-mail sem distinguir maiúsculas', async () => {
      const pendencia = (campos) => inserir('pending_registrations', {
        expires_at: vencimento(), name: 'Pessoa Nova', password_hash: 'hash',
        termos_aceito_em: new Date(), termos_versao: '1',
        ...campos,
      });
      await pendencia({ token_hash: 'a'.repeat(64), username: 'Maria', email: 'maria@x.org' });

      await expect(pendencia({ token_hash: 'b'.repeat(64), username: 'maria', email: 'outra@x.org' }))
        .rejects.toMatchObject({ code: UNICO });
      await expect(pendencia({ token_hash: 'c'.repeat(64), username: 'outra', email: 'MARIA@x.org' }))
        .rejects.toMatchObject({ code: UNICO });
    });
  });
});
