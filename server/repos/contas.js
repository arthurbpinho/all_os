// Contas no PostgreSQL: o substituto de readJSON('users.json') e dos três
// arquivos de token por e-mail (cadastro pendente, nova senha, troca de e-mail).
//
// Fala com o resto do app no MESMO formato do users.json — camelCase, id string,
// `email: ''` quando não há endereço. Assim as rotas trocam a origem do dado sem
// trocar o jeito de usá-lo, e publicUser/signToken seguem como estão.
//
// Toda escrita vai direto na linha afetada. Nada aqui lê a tabela inteira para
// regravar: era esse padrão que perdia dados no JSON.
//
// Conta excluída é uma lápide (ver 002_contas_exclusao_logica.sql): nenhuma
// leitura nem escrita daqui a alcança — para o app, ela não existe.

const { transacao } = require('../db');
const { normalizeUsername, normalizeEmail } = require('../cadastro');

const PAPEIS_ALUNO = ['therapist', 'external'];

// Id de conta é BIGINT. Um id que não é número (o `visitor-…` do JWT, lixo vindo
// da URL) faria o Postgres recusar a query com erro; aqui ele só não acha nada,
// que é o que o `users.find` do JSON fazia.
const ID_VALIDO = /^[0-9]{1,18}$/;
const idValido = (id) => ID_VALIDO.test(String(id));

class ErroConta extends Error {
  constructor(codigo) {
    super(codigo);
    this.name = 'ErroConta';
    this.codigo = codigo;
  }
}

// Regra do banco violada → erro que a rota sabe traduzir para o usuário. Na
// prática só acontece quando duas requisições disputam o mesmo nome ou e-mail no
// mesmo instante: a validação da rota roda antes e pega o caso comum.
const ERRO_POR_CONSTRAINT = {
  users_username_lower_uq: 'username-em-uso',
  pending_registrations_username_lower_uq: 'username-em-uso',
  users_email_lower_uq: 'email-em-uso',
  pending_registrations_email_lower_uq: 'email-em-uso',
  users_teacher_id_fkey: 'professor-invalido',
  users_teacher_so_para_aluno: 'professor-so-para-aluno',
};

function traduzirErro(e) {
  const codigo = e && ERRO_POR_CONSTRAINT[e.constraint];
  return codigo ? new ErroConta(codigo) : e;
}

// --- Linha do banco ↔ objeto do users.json ---------------------------------

function paraUsuario(r) {
  if (!r) return null;
  const u = {
    id: r.id,
    username: r.username,
    usernameLower: normalizeUsername(r.username),
    name: r.name,
    role: r.role,
    teacherId: r.teacher_id,
    passwordHash: r.password_hash,
    tokenVersion: r.token_version,
    email: r.email || '',
    emailLower: normalizeEmail(r.email),
    emailVerified: r.email_verified,
    gender: r.gender,
    profilePhoto: r.profile_photo,
    sidequestsEnabled: r.sidequests_enabled,
    abordagem: r.abordagem,
    activeTitle: r.active_title,
    updateAllOS: r.update_all_os,
    updateAllos: r.update_allos,
    criadoEm: r.criado_em.toISOString(),
  };
  // Campos que no JSON só existiam em algumas contas continuam ausentes quando
  // não há valor — quem os lê testa presença, não valor.
  if (r.visual_description !== null) u.visualDescription = r.visual_description;
  if (r.share_appearance !== null) u.shareAppearance = r.share_appearance;
  if (r.origem_canal !== null) u.origem = { canal: r.origem_canal, detalhe: r.origem_detalhe || '' };
  if (r.termos_aceito_em !== null) {
    u.consentimento = {
      termos: { aceito: true, em: r.termos_aceito_em.toISOString(), versao: r.termos_versao },
    };
  }
  // publicUser buscava o nome do professor em users.json a cada chamada. Aqui ele
  // já vem da consulta, e é o que deixa publicUser continuar síncrono.
  if (r.teacher_name) u.teacherName = r.teacher_name;
  return u;
}

const texto = (v) => String(v ?? '');
const booleano = (v) => !!v;
const opcional = (fn) => (v) => (v == null ? null : fn(v));
const emailOuNull = (v) => normalizeEmail(v) || null;

// Chave do users.json → [coluna, normalização]. A normalização existe porque a
// rota aceita JSON de qualquer cliente: o arquivo gravava `updateAllOS: "sim"`
// sem reclamar, e a coluna BOOLEAN recusaria. Converter preserva o que o valor
// significava (truthy) em vez de transformar isso em erro 500.
const CAMPOS_PERFIL = {
  name: ['name', texto],
  gender: ['gender', texto],
  profilePhoto: ['profile_photo', texto],
  updateAllOS: ['update_all_os', booleano],
  updateAllos: ['update_allos', booleano],
  visualDescription: ['visual_description', opcional(texto)],
  shareAppearance: ['share_appearance', opcional(booleano)],
  sidequestsEnabled: ['sidequests_enabled', booleano],
  abordagem: ['abordagem', (v) => texto(v).trim().slice(0, 120)],
};

const CAMPOS_ADMIN = {
  username: ['username', (v) => texto(v).trim()],
  name: ['name', (v) => texto(v).trim()],
  role: ['role', texto],
  email: ['email', emailOuNull],
  emailVerified: ['email_verified', booleano],
  gender: ['gender', texto],
  profilePhoto: ['profile_photo', texto],
  teacherId: ['teacher_id', (v) => v || null],
};

const CAMPOS_CRIACAO = {
  ...CAMPOS_PERFIL,
  ...CAMPOS_ADMIN,
  passwordHash: ['password_hash', texto],
};

function mapear(definicoes, dados) {
  const colunas = {};
  for (const [chave, [coluna, normalizar]] of Object.entries(definicoes)) {
    if (dados[chave] !== undefined) colunas[coluna] = normalizar(dados[chave]);
  }
  return colunas;
}

function origemEConsentimento(dados) {
  const colunas = {};
  if (dados.origem) {
    colunas.origem_canal = dados.origem.canal;
    colunas.origem_detalhe = dados.origem.detalhe || '';
  }
  const termos = dados.consentimento && dados.consentimento.termos;
  if (termos) {
    colunas.termos_aceito_em = termos.em;
    colunas.termos_versao = String(termos.versao);
  }
  return colunas;
}

function inserirSql(tabela, colunas) {
  const nomes = Object.keys(colunas);
  return {
    sql: `INSERT INTO ${tabela} (${nomes.join(', ')})
          VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')})
          RETURNING *`,
    valores: Object.values(colunas),
  };
}

// --- Repositório ------------------------------------------------------------

// `pool` é injetado para os testes rodarem cada um no seu schema. Toda função
// que pode compor uma transação aceita um `db` opcional (o client da transação).
function criarRepoContas(pool) {
  // Toda consulta que devolve conta passa por aqui: `sql` é um SELECT ou um
  // INSERT/UPDATE com RETURNING, e o nome do professor entra por JOIN.
  async function varios(sql, params, db = pool, { ordem = null } = {}) {
    const { rows } = await db.query(
      `WITH r AS (${sql})
       SELECT r.*, t.name AS teacher_name FROM r LEFT JOIN users t ON t.id = r.teacher_id
       ${ordem ? `ORDER BY r.${ordem}` : ''}`,
      params,
    );
    return rows.map(paraUsuario);
  }

  async function um(sql, params, db = pool) {
    return (await varios(sql, params, db))[0] || null;
  }

  // --- Leitura (só contas ativas) ---

  async function porId(id, db = pool) {
    if (!idValido(id)) return null;
    return um('SELECT * FROM users WHERE id = $1 AND excluido_em IS NULL', [String(id)], db);
  }

  async function porUsername(username, db = pool) {
    const lower = normalizeUsername(username);
    if (!lower) return null;
    return um('SELECT * FROM users WHERE lower(username) = $1 AND excluido_em IS NULL', [lower], db);
  }

  async function porEmail(email, db = pool) {
    const lower = normalizeEmail(email);
    if (!lower) return null;
    return um('SELECT * FROM users WHERE lower(email) = $1 AND excluido_em IS NULL', [lower], db);
  }

  function listar() {
    return varios('SELECT * FROM users WHERE excluido_em IS NULL', [], pool, { ordem: 'id' });
  }

  async function alunosDoProfessor(teacherId) {
    if (!idValido(teacherId)) return [];
    return varios(
      'SELECT * FROM users WHERE teacher_id = $1 AND excluido_em IS NULL',
      [String(teacherId)], pool, { ordem: 'id' },
    );
  }

  // Nome tomado por uma conta ou por um cadastro ainda pendente e válido. Lápide
  // não entra: o username dela foi trocado na exclusão.
  async function usernameIndisponivel(username) {
    const lower = normalizeUsername(username);
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM users WHERE lower(username) = $1)
           OR EXISTS (SELECT 1 FROM pending_registrations
                      WHERE lower(username) = $1 AND expires_at > now()) AS em_uso`,
      [lower],
    );
    return rows[0].em_uso;
  }

  // --- Escrita ---

  async function criar(dados, db = pool) {
    const { sql, valores } = inserirSql('users', {
      ...mapear(CAMPOS_CRIACAO, dados),
      ...origemEConsentimento(dados),
    });
    try {
      return await um(sql, valores, db);
    } catch (e) {
      throw traduzirErro(e);
    }
  }

  // Grava contas com o id que elas já têm (seed dos testes, importação de dados).
  // Avança a sequência no fim: sem isso, o próximo cadastro receberia um id que
  // acabou de ser gravado aqui e colidiria.
  async function importar(usuarios) {
    return transacao(pool, async (client) => {
      for (const u of usuarios) {
        const { sql, valores } = inserirSql('users', {
          id: String(u.id),
          ...mapear(CAMPOS_CRIACAO, u),
          ...origemEConsentimento(u),
        });
        try {
          await client.query(sql, valores);
        } catch (e) {
          throw traduzirErro(e);
        }
      }
      await client.query(
        `SELECT setval(pg_get_serial_sequence('users', 'id'),
                       COALESCE((SELECT max(id) FROM users), 1),
                       (SELECT max(id) FROM users) IS NOT NULL)`,
      );
    });
  }

  // `revogarSessoes` incrementa o tokenVersion NA MESMA instrução, e não com
  // "lê o valor, soma 1, grava": duas trocas simultâneas contam as duas.
  async function atualizar(id, colunas, { revogarSessoes = false } = {}, db = pool) {
    if (!idValido(id)) return null;
    const nomes = Object.keys(colunas);
    const sets = nomes.map((c, i) => `${c} = $${i + 2}`);
    if (revogarSessoes) sets.push('token_version = token_version + 1');
    if (!sets.length) return porId(id, db);
    try {
      return await um(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND excluido_em IS NULL RETURNING *`,
        [String(id), ...Object.values(colunas)],
        db,
      );
    } catch (e) {
      throw traduzirErro(e);
    }
  }

  // Campos que o próprio usuário edita (PUT /api/users/:id). Qualquer outra chave
  // do patch é ignorada: role, senha e e-mail têm caminhos próprios.
  function atualizarPerfil(id, patch) {
    return atualizar(id, mapear(CAMPOS_PERFIL, patch || {}));
  }

  // Edição pela tela de Contas. `patch` traz os campos da conta; `passwordHash`,
  // quando vem, derruba as sessões abertas.
  async function atualizarPorAdmin(id, patch, { passwordHash } = {}) {
    if (!idValido(id)) return null;
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        'SELECT role FROM users WHERE id = $1 AND excluido_em IS NULL FOR UPDATE',
        [String(id)],
      );
      if (!rows.length) return null;

      const colunas = mapear(CAMPOS_ADMIN, patch || {});
      if (passwordHash) colunas.password_hash = passwordHash;

      const novoPapel = colunas.role;
      if (novoPapel !== undefined && !PAPEIS_ALUNO.includes(novoPapel)) {
        colunas.teacher_id = null; // só aluno tem professor
      }
      // Professor que deixa de ser professor: os alunos dele ficam sem vínculo.
      if (rows[0].role === 'supervisor' && novoPapel !== undefined && novoPapel !== 'supervisor') {
        await client.query('UPDATE users SET teacher_id = NULL WHERE teacher_id = $1', [String(id)]);
      }
      return atualizar(id, colunas, { revogarSessoes: !!passwordHash }, client);
    });
  }

  function trocarSenha(id, passwordHash) {
    return atualizar(id, { password_hash: passwordHash }, { revogarSessoes: true });
  }

  function definirTitulo(id, titleId) {
    return atualizar(id, { active_title: texto(titleId) });
  }

  // Exclusão lógica: a linha fica (com o id que os logs referenciam) e perde tudo
  // que identifica a pessoa. Devolve false se a conta não existe ou já foi
  // excluída; lança ErroConta('professor-com-alunos') se ainda há aluno ativo
  // vinculado.
  async function excluir(id) {
    if (!idValido(id)) return false;
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        'SELECT 1 FROM users WHERE id = $1 AND excluido_em IS NULL FOR UPDATE',
        [String(id)],
      );
      if (!rows.length) return false;

      const alunos = await client.query(
        'SELECT 1 FROM users WHERE teacher_id = $1 AND excluido_em IS NULL LIMIT 1',
        [String(id)],
      );
      if (alunos.rows.length) throw new ErroConta('professor-com-alunos');

      // Sem DELETE, a cascata das FKs não dispara: os links pendentes saem à mão.
      await client.query('DELETE FROM password_resets WHERE user_id = $1', [String(id)]);
      await client.query('DELETE FROM email_changes WHERE user_id = $1', [String(id)]);

      // `#` não passa no usernameRegex do cadastro: nenhum nome real colide com
      // uma lápide, e o nome original fica livre para outra conta.
      await client.query(
        `UPDATE users SET
           excluido_em = now(),
           username = '#excluida-' || id,
           name = '', email = NULL, email_verified = false,
           password_hash = '', token_version = token_version + 1,
           teacher_id = NULL, gender = '', profile_photo = '',
           visual_description = NULL, share_appearance = NULL,
           abordagem = '', active_title = '',
           update_all_os = false, update_allos = false,
           origem_canal = NULL, origem_detalhe = NULL,
           termos_aceito_em = NULL, termos_versao = NULL
         WHERE id = $1`,
        [String(id)],
      );
      return true;
    });
  }

  // --- Cadastro público ---

  async function criarPendencia(p) {
    return transacao(pool, async (client) => {
      // Os índices únicos não sabem de validade: sem apagar as vencidas antes,
      // uma pendência abandonada seguraria o nome para sempre. A do mesmo e-mail
      // também sai — é a pessoa refazendo o cadastro.
      await client.query(
        'DELETE FROM pending_registrations WHERE expires_at <= now() OR lower(email) = $1',
        [normalizeEmail(p.email)],
      );
      const { sql, valores } = inserirSql('pending_registrations', {
        token_hash: p.tokenHash,
        expires_at: p.expiresAt,
        username: p.username,
        name: p.name,
        email: normalizeEmail(p.email),
        password_hash: p.passwordHash,
        update_all_os: !!p.updateAllOS,
        update_allos: !!p.updateAllos,
        ip: p.ip || null,
        duel_claim: p.duelClaim ?? null,
        ...origemEConsentimento(p),
      });
      try {
        await client.query(sql, valores);
      } catch (e) {
        throw traduzirErro(e);
      }
    });
  }

  // Reenvio do link: token novo, e o antigo deixa de valer.
  async function renovarTokenPendencia(email, { tokenHash, expiresAt }) {
    const { rows } = await pool.query(
      `UPDATE pending_registrations SET token_hash = $2, expires_at = $3
       WHERE lower(email) = $1 AND expires_at > now()
       RETURNING username, name, email`,
      [normalizeEmail(email), tokenHash, expiresAt],
    );
    return rows[0] || null;
  }

  // Clique no link de confirmação. Devolve null (link inválido ou vencido),
  // { conflito } (nome ou e-mail tomado nesse meio-tempo — a pendência fica,
  // como no JSON) ou { user, duelClaim }.
  async function confirmarCadastro(tokenHash, { perfilPadrao = {} } = {}) {
    try {
      return await transacao(pool, async (client) => {
        // DELETE ... RETURNING torna o link de uso único: de dois cliques
        // simultâneos, só um recebe a linha.
        const { rows } = await client.query(
          'DELETE FROM pending_registrations WHERE token_hash = $1 AND expires_at > now() RETURNING *',
          [tokenHash],
        );
        const reg = rows[0];
        if (!reg) return null;

        // Entre o cadastro e o clique (até 48h) o admin pode ter criado uma conta
        // com esse nome ou e-mail.
        if (await porUsername(reg.username, client)) throw new ErroConta('username-em-uso');
        if (await porEmail(reg.email, client)) throw new ErroConta('email-em-uso');

        const user = await criar({
          ...perfilPadrao,
          username: reg.username,
          name: reg.name,
          role: 'external',
          teacherId: null,
          passwordHash: reg.password_hash,
          email: reg.email,
          emailVerified: true,
          updateAllOS: reg.update_all_os,
          updateAllos: reg.update_allos,
          origem: reg.origem_canal ? { canal: reg.origem_canal, detalhe: reg.origem_detalhe } : null,
          consentimento: { termos: { em: reg.termos_aceito_em, versao: reg.termos_versao } },
        }, client);

        await client.query(
          'DELETE FROM pending_registrations WHERE lower(email) = $1 OR lower(username) = $2',
          [normalizeEmail(reg.email), normalizeUsername(reg.username)],
        );
        return { user, duelClaim: reg.duel_claim };
      });
    } catch (e) {
      if (e instanceof ErroConta && (e.codigo === 'username-em-uso' || e.codigo === 'email-em-uso')) {
        return { conflito: e.codigo };
      }
      throw e;
    }
  }

  // --- Nova senha ---

  // Um pedido por conta: pedir de novo substitui o link anterior.
  async function criarReset(userId, { tokenHash, expiresAt, ip }) {
    await pool.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at, ip)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at,
             ip = EXCLUDED.ip, criado_em = now()`,
      [tokenHash, String(userId), expiresAt, ip || null],
    );
  }

  // Dono de um link válido — a rota precisa do papel e do username para validar
  // a senha nova antes de consumir o link.
  function contaDoReset(tokenHash) {
    return um(
      `SELECT u.* FROM password_resets pr JOIN users u ON u.id = pr.user_id
       WHERE pr.token_hash = $1 AND pr.expires_at > now() AND u.excluido_em IS NULL`,
      [tokenHash],
    );
  }

  async function consumirReset(tokenHash, passwordHash) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        'DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > now() RETURNING user_id',
        [tokenHash],
      );
      if (!rows.length) return null;
      return atualizar(rows[0].user_id, { password_hash: passwordHash }, { revogarSessoes: true }, client);
    });
  }

  // --- Troca de e-mail ---

  async function criarTrocaEmail(userId, { email, tokenHash, expiresAt }) {
    await pool.query(
      `INSERT INTO email_changes (token_hash, user_id, email, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash, email = EXCLUDED.email,
             expires_at = EXCLUDED.expires_at, criado_em = now()`,
      [tokenHash, String(userId), normalizeEmail(email), expiresAt],
    );
  }

  // null (link inválido), { conflito } (outra conta pegou o endereço — o pedido
  // fica, como no JSON) ou { user }.
  async function confirmarTrocaEmail(tokenHash) {
    try {
      return await transacao(pool, async (client) => {
        const { rows } = await client.query(
          'DELETE FROM email_changes WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, email',
          [tokenHash],
        );
        if (!rows.length) return null;
        const user = await atualizar(rows[0].user_id, { email: rows[0].email, email_verified: true }, {}, client);
        return user ? { user } : null;
      });
    } catch (e) {
      if (e instanceof ErroConta && e.codigo === 'email-em-uso') return { conflito: e.codigo };
      throw e;
    }
  }

  // No JSON a poda rodava a cada leitura; aqui as consultas já ignoram o que
  // venceu, e isto só libera espaço. Serve para um job periódico.
  async function podarVencidos() {
    const removidos = {};
    for (const tabela of ['pending_registrations', 'password_resets', 'email_changes']) {
      const { rowCount } = await pool.query(`DELETE FROM ${tabela} WHERE expires_at <= now()`);
      removidos[tabela] = rowCount;
    }
    return removidos;
  }

  return {
    porId,
    porUsername,
    porEmail,
    listar,
    alunosDoProfessor,
    usernameIndisponivel,
    criar,
    importar,
    atualizarPerfil,
    atualizarPorAdmin,
    trocarSenha,
    definirTitulo,
    excluir,
    criarPendencia,
    renovarTokenPendencia,
    confirmarCadastro,
    criarReset,
    contaDoReset,
    consumirReset,
    criarTrocaEmail,
    confirmarTrocaEmail,
    podarVencidos,
  };
}

module.exports = { criarRepoContas, ErroConta };
