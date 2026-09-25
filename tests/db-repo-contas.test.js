// Repositório de contas (server/repos/contas.js) contra o Postgres de teste.
//
// Além das regras de negócio, estes testes cobrem o que motivou a migração:
// operações simultâneas que no JSON perdiam uma das escritas.

const { URL_TESTE, criarPoolIsolado } = require('./db-helpers');

describe.skipIf(!URL_TESTE)('repositório de contas', () => {
  const { criarRepoContas } = require('../server/repos/contas');

  let db;
  let repo;

  beforeEach(async () => {
    db = await criarPoolIsolado();
    repo = criarRepoContas(db.pool);
  });

  afterEach(() => db.descartar());

  const novaConta = (dados = {}) => repo.criar({
    username: 'fulano', name: 'Fulano de Tal', role: 'external', passwordHash: 'hash',
    ...dados,
  });
  const futuro = () => new Date(Date.now() + 3600_000);
  const passado = () => new Date(Date.now() - 1000);
  const token = (c) => c.repeat(64);
  const contar = async (tabela) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n;

  describe('leitura', () => {
    it('devolve a conta no formato do users.json', async () => {
      const criada = await novaConta({ username: 'Maria', email: 'Maria@X.org' });

      const u = await repo.porId(criada.id);

      expect(u).toMatchObject({
        id: criada.id, username: 'Maria', usernameLower: 'maria',
        email: 'maria@x.org', emailLower: 'maria@x.org',
        role: 'external', teacherId: null, tokenVersion: 0,
      });
      // Campos que só existem em algumas contas continuam ausentes, não null.
      expect(u).not.toHaveProperty('origem');
      expect(u).not.toHaveProperty('shareAppearance');
    });

    it('conta sem e-mail volta com e-mail vazio, como no JSON', async () => {
      const u = await novaConta();
      expect(u.email).toBe('');
    });

    it('acha por username e por e-mail sem distinguir maiúsculas', async () => {
      const criada = await novaConta({ username: 'Joao', email: 'joao@x.org' });
      expect((await repo.porUsername('JOAO')).id).toBe(criada.id);
      expect((await repo.porEmail('JOAO@X.ORG')).id).toBe(criada.id);
      expect(await repo.porUsername('')).toBeNull();
    });

    it('id que não é número (visitante, lixo na URL) não quebra: só não acha', async () => {
      expect(await repo.porId('visitor-abc123')).toBeNull();
      expect(await repo.porId('1; DROP TABLE users')).toBeNull();
    });

    it('lista os alunos de um professor', async () => {
      const prof = await novaConta({ username: 'prof', role: 'supervisor' });
      await novaConta({ username: 'aluno1', role: 'therapist', teacherId: prof.id });
      await novaConta({ username: 'aluno2', role: 'external', teacherId: prof.id });
      await novaConta({ username: 'solto', role: 'external' });

      const alunos = await repo.alunosDoProfessor(prof.id);

      expect(alunos.map((a) => a.username)).toEqual(['aluno1', 'aluno2']);
    });
  });

  describe('escrita', () => {
    it('username em uso vira ErroConta, não erro cru do banco', async () => {
      await novaConta({ username: 'joao' });
      await expect(novaConta({ username: 'JOAO' }))
        .rejects.toMatchObject({ name: 'ErroConta', codigo: 'username-em-uso' });
    });

    it('edição de perfil normaliza os tipos e ignora o que não é campo de perfil', async () => {
      const u = await novaConta();

      const editada = await repo.atualizarPerfil(u.id, {
        updateAllOS: 'sim',
        sidequestsEnabled: 0,
        abordagem: `  ${'a'.repeat(200)}  `,
        role: 'admin',
        passwordHash: 'roubado',
      });

      expect(editada).toMatchObject({ updateAllOS: true, sidequestsEnabled: false, role: 'external', passwordHash: 'hash' });
      expect(editada.abordagem).toHaveLength(120);
    });

    it('duas trocas de senha simultâneas contam as duas no tokenVersion', async () => {
      const u = await novaConta();

      await Promise.all([repo.trocarSenha(u.id, 'h1'), repo.trocarSenha(u.id, 'h2')]);

      expect((await repo.porId(u.id)).tokenVersion).toBe(2);
    });

    it('senha trocada pelo admin derruba as sessões', async () => {
      const u = await novaConta();
      const editada = await repo.atualizarPorAdmin(u.id, { name: 'Outro Nome' }, { passwordHash: 'novo' });
      expect(editada).toMatchObject({ name: 'Outro Nome', passwordHash: 'novo', tokenVersion: 1 });
    });

    it('professor que muda de função solta os alunos', async () => {
      const prof = await novaConta({ username: 'prof', role: 'supervisor' });
      const aluno = await novaConta({ username: 'aluno', role: 'therapist', teacherId: prof.id });

      await repo.atualizarPorAdmin(prof.id, { role: 'evaluator' });

      expect((await repo.porId(aluno.id)).teacherId).toBeNull();
    });

    it('aluno que vira outro papel perde o professor', async () => {
      const prof = await novaConta({ username: 'prof', role: 'supervisor' });
      const aluno = await novaConta({ username: 'aluno', role: 'therapist', teacherId: prof.id });

      const promovido = await repo.atualizarPorAdmin(aluno.id, { role: 'supervisor' });

      expect(promovido).toMatchObject({ role: 'supervisor', teacherId: null });
    });

  });

  // Decisão de 2026-09-14: excluir vira lápide (002_contas_exclusao_logica.sql).
  describe('exclusão lógica', () => {
    const linha = async (id) => (await db.pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

    it('a conta some de todas as buscas, mas a linha e o id continuam', async () => {
      const u = await novaConta({ username: 'saindo', email: 'saindo@x.org' });

      expect(await repo.excluir(u.id)).toBe(true);

      expect(await repo.porId(u.id)).toBeNull();
      expect(await repo.porUsername('saindo')).toBeNull();
      expect(await repo.porEmail('saindo@x.org')).toBeNull();
      expect((await repo.listar()).map((c) => c.id)).not.toContain(u.id);
      expect((await linha(u.id)).excluido_em).not.toBeNull();
    });

    it('apaga o que identifica a pessoa', async () => {
      const u = await novaConta({
        username: 'saindo', name: 'Pessoa Saindo', email: 'saindo@x.org',
        profilePhoto: '/foto.jpg', visualDescription: 'cabelo curto',
        origem: { canal: 'instagram', detalhe: '' },
        consentimento: { termos: { em: new Date().toISOString(), versao: '1' } },
      });

      await repo.excluir(u.id);

      const r = await linha(u.id);
      expect(r).toMatchObject({
        name: '', email: null, password_hash: '', profile_photo: '', visual_description: null,
        origem_canal: null, termos_aceito_em: null,
      });
      expect(r.username).not.toMatch(/saindo/i);
    });

    it('libera o nome e o e-mail para uma conta nova, com outro id', async () => {
      const u = await novaConta({ username: 'saindo', email: 'saindo@x.org' });
      await repo.excluir(u.id);

      const nova = await novaConta({ username: 'SAINDO', email: 'saindo@x.org' });

      expect(nova.id).not.toBe(u.id);
      expect(await repo.usernameIndisponivel('saindo')).toBe(true);
    });

    it('conta excluída não é editada, não troca senha e não é excluída de novo', async () => {
      const u = await novaConta();
      await repo.excluir(u.id);

      expect(await repo.atualizarPerfil(u.id, { name: 'Voltei' })).toBeNull();
      expect(await repo.trocarSenha(u.id, 'nova')).toBeNull();
      expect(await repo.atualizarPorAdmin(u.id, { name: 'Voltei' })).toBeNull();
      expect(await repo.excluir(u.id)).toBe(false);
    });

    it('leva junto os pedidos de nova senha e de troca de e-mail', async () => {
      const u = await novaConta();
      await repo.criarReset(u.id, { tokenHash: token('a'), expiresAt: futuro() });
      await repo.criarTrocaEmail(u.id, { email: 'n@x.org', tokenHash: token('b'), expiresAt: futuro() });

      await repo.excluir(u.id);

      expect(await contar('password_resets')).toBe(0);
      expect(await contar('email_changes')).toBe(0);
    });

    it('professor com aluno ativo não é excluído; aluno excluído não conta como vínculo', async () => {
      const prof = await novaConta({ username: 'prof', role: 'supervisor' });
      const aluno = await novaConta({ username: 'aluno', role: 'therapist', teacherId: prof.id });

      await expect(repo.excluir(prof.id)).rejects.toMatchObject({ codigo: 'professor-com-alunos' });

      await repo.excluir(aluno.id);
      expect(await repo.excluir(prof.id)).toBe(true);
    });
  });

  describe('cadastro público', () => {
    const pendencia = (dados = {}) => repo.criarPendencia({
      tokenHash: token('a'),
      expiresAt: futuro(),
      username: 'nova',
      name: 'Pessoa Nova',
      email: 'nova@x.org',
      passwordHash: 'hash',
      origem: { canal: 'instagram', detalhe: '' },
      consentimento: { termos: { aceito: true, em: new Date().toISOString(), versao: '1' } },
      updateAllOS: true,
      ip: '203.0.113.7',
      duelClaim: { duelId: 'duel-1' },
      ...dados,
    });

    it('pendência segura o nome até vencer', async () => {
      await pendencia();
      expect(await repo.usernameIndisponivel('NOVA')).toBe(true);
    });

    it('pendência vencida não segura o nome, e sai quando outra entra no lugar', async () => {
      await pendencia({ expiresAt: passado() });
      expect(await repo.usernameIndisponivel('nova')).toBe(false);

      await pendencia({ tokenHash: token('b'), email: 'outra@x.org' });

      expect(await contar('pending_registrations')).toBe(1);
    });

    it('refazer o cadastro com o mesmo e-mail substitui a pendência', async () => {
      await pendencia({ username: 'errado' });
      await pendencia({ tokenHash: token('b'), username: 'certo' });

      expect(await repo.usernameIndisponivel('errado')).toBe(false);
      expect(await repo.confirmarCadastro(token('a'))).toBeNull();
    });

    it('confirmar cria aluno externo verificado, com origem e consentimento, e o link morre', async () => {
      await pendencia();

      const { user, duelClaim } = await repo.confirmarCadastro(token('a'), {
        perfilPadrao: { profilePhoto: '/foto.jpg', sidequestsEnabled: true },
      });

      expect(user).toMatchObject({
        username: 'nova', role: 'external', teacherId: null,
        email: 'nova@x.org', emailVerified: true, profilePhoto: '/foto.jpg', updateAllOS: true,
        origem: { canal: 'instagram', detalhe: '' },
        consentimento: { termos: { aceito: true, versao: '1' } },
      });
      expect(duelClaim).toEqual({ duelId: 'duel-1' });
      expect(await repo.confirmarCadastro(token('a'))).toBeNull();
    });

    it('nome tomado antes do clique devolve conflito e a pendência fica', async () => {
      await pendencia();
      await novaConta({ username: 'NOVA' });

      expect(await repo.confirmarCadastro(token('a'))).toEqual({ conflito: 'username-em-uso' });
      expect(await contar('pending_registrations')).toBe(1);
    });

    it('link vencido não confirma', async () => {
      await pendencia({ expiresAt: passado() });
      expect(await repo.confirmarCadastro(token('a'))).toBeNull();
    });

    it('reenviar troca o token: o link antigo deixa de valer', async () => {
      await pendencia();

      const reenvio = await repo.renovarTokenPendencia('NOVA@x.org', { tokenHash: token('c'), expiresAt: futuro() });

      expect(reenvio).toMatchObject({ username: 'nova', email: 'nova@x.org' });
      expect(await repo.confirmarCadastro(token('a'))).toBeNull();
      expect(await repo.confirmarCadastro(token('c'))).toHaveProperty('user');
    });
  });

  describe('nova senha', () => {
    it('pedir de novo invalida o link anterior', async () => {
      const u = await novaConta();
      await repo.criarReset(u.id, { tokenHash: token('a'), expiresAt: futuro() });
      await repo.criarReset(u.id, { tokenHash: token('b'), expiresAt: futuro() });

      expect(await repo.contaDoReset(token('a'))).toBeNull();
      expect((await repo.contaDoReset(token('b'))).id).toBe(u.id);
    });

    it('o link é de uso único, mesmo com dois cliques simultâneos, e derruba as sessões', async () => {
      const u = await novaConta();
      await repo.criarReset(u.id, { tokenHash: token('a'), expiresAt: futuro() });

      const resultados = await Promise.all([
        repo.consumirReset(token('a'), 'senha-1'),
        repo.consumirReset(token('a'), 'senha-2'),
      ]);

      expect(resultados.filter(Boolean)).toHaveLength(1);
      expect((await repo.porId(u.id)).tokenVersion).toBe(1);
    });

    it('link vencido não vale', async () => {
      const u = await novaConta();
      await repo.criarReset(u.id, { tokenHash: token('a'), expiresAt: passado() });

      expect(await repo.contaDoReset(token('a'))).toBeNull();
      expect(await repo.consumirReset(token('a'), 'x')).toBeNull();
    });
  });

  describe('troca de e-mail', () => {
    it('confirmar grava o endereço novo já verificado', async () => {
      const u = await novaConta({ email: 'velho@x.org' });
      await repo.criarTrocaEmail(u.id, { email: 'Novo@X.org', tokenHash: token('a'), expiresAt: futuro() });

      const { user } = await repo.confirmarTrocaEmail(token('a'));

      expect(user).toMatchObject({ email: 'novo@x.org', emailVerified: true });
      expect(await repo.confirmarTrocaEmail(token('a'))).toBeNull();
    });

    it('se outra conta pegou o endereço, devolve conflito e não mexe em nada', async () => {
      const u = await novaConta({ username: 'um', email: 'velho@x.org' });
      await repo.criarTrocaEmail(u.id, { email: 'disputado@x.org', tokenHash: token('a'), expiresAt: futuro() });
      await novaConta({ username: 'dois', email: 'disputado@x.org' });

      expect(await repo.confirmarTrocaEmail(token('a'))).toEqual({ conflito: 'email-em-uso' });
      expect((await repo.porId(u.id)).email).toBe('velho@x.org');
      expect(await contar('email_changes')).toBe(1);
    });
  });

  it('poda só o que venceu', async () => {
    const u = await novaConta();
    await repo.criarReset(u.id, { tokenHash: token('a'), expiresAt: passado() });
    await repo.criarTrocaEmail(u.id, { email: 'n@x.org', tokenHash: token('b'), expiresAt: futuro() });

    const removidos = await repo.podarVencidos();

    expect(removidos).toEqual({ pending_registrations: 0, password_resets: 1, email_changes: 0 });
    expect(await contar('email_changes')).toBe(1);
  });
});
