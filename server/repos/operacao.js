// Logs de erro, feedback e configurações do admin no PostgreSQL: substitui
// error-logs.json, feedback.json, settings.json e avatar-pool.json (e, depois,
// o comunidade-config.json).

const { transacao } = require('../db');

const clonar = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function criarRepoOperacao(pool) {
  // --- Logs de erro ---

  // Grava a entrada (a de server/error-log.js) e poda por idade e por teto.
  async function registrarErro(entrada, { maximo, ttlMs }) {
    await pool.query(
      'INSERT INTO erros (id, criado_em, entrada) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [entrada.id, entrada.timestamp, JSON.stringify(entrada)],
    );
    await pool.query(
      `DELETE FROM erros
       WHERE criado_em < now() - ($1::bigint * interval '1 millisecond')
          OR id IN (SELECT id FROM erros ORDER BY criado_em DESC, id DESC OFFSET $2)`,
      [Math.floor(ttlMs), maximo],
    );
  }

  // Mais recente primeiro, como o painel sempre recebeu.
  async function erros() {
    const { rows } = await pool.query('SELECT entrada FROM erros ORDER BY criado_em DESC, id DESC');
    return rows.map((r) => r.entrada);
  }

  async function limparErros() {
    const r = await pool.query('DELETE FROM erros');
    return r.rowCount;
  }

  // --- Feedback ---

  async function criarFeedback({ id, timestamp, userId, userName, role, stars, message }) {
    await pool.query(
      `INSERT INTO feedback (id, criado_em, user_id, user_name, role, stars, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, timestamp, userId == null ? null : String(userId), userName || '', role || '', stars || 0, message || ''],
    );
  }

  // Mais recente primeiro.
  async function feedbacks() {
    const { rows } = await pool.query('SELECT * FROM feedback ORDER BY criado_em DESC, id DESC');
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.criado_em.toISOString(),
      userId: r.user_id,
      userName: r.user_name,
      role: r.role,
      stars: r.stars,
      message: r.message,
    }));
  }

  async function excluirFeedback(id) {
    const r = await pool.query('DELETE FROM feedback WHERE id = $1', [String(id)]);
    return r.rowCount > 0;
  }

  // --- Configurações ---
  //
  // Lidas em quase toda requisição (o modelo de IA de cada categoria sai daqui),
  // então ficam numa cópia em memória, carregada no boot e atualizada a cada
  // gravação — que passa sempre por `atualizarConfig`. Vale porque o app roda em
  // UMA instância (CLAUDE.md §2), como a cópia dos prompts.

  const config = new Map();

  async function carregarConfig() {
    const { rows } = await pool.query('SELECT chave, valor FROM configuracoes');
    config.clear();
    for (const r of rows) config.set(r.chave, r.valor);
  }

  // Cópia do bloco (quem lê pode alterar à vontade sem mexer na memória).
  function lerConfig(chave, padrao) {
    return clonar(config.has(chave) ? config.get(chave) : padrao);
  }

  // Altera um bloco com a linha travada: `fn(valor)` muda o valor no lugar (ou
  // devolve um novo) e devolve false para não gravar. Devolve uma cópia do valor final.
  async function atualizarConfig(chave, padrao, fn) {
    const valor = await transacao(pool, async (client) => {
      await client.query(
        'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [chave, JSON.stringify(padrao)],
      );
      const { rows } = await client.query('SELECT valor FROM configuracoes WHERE chave = $1 FOR UPDATE', [chave]);
      const atual = rows[0].valor;
      const retorno = fn(atual);
      if (retorno === false) return atual;
      const novo = retorno === undefined ? atual : retorno;
      await client.query('UPDATE configuracoes SET valor = $2, atualizado_em = now() WHERE chave = $1', [chave, JSON.stringify(novo)]);
      return novo;
    });
    config.set(chave, valor);
    return clonar(valor);
  }

  return {
    registrarErro,
    erros,
    limparErros,
    criarFeedback,
    feedbacks,
    excluirFeedback,
    carregarConfig,
    lerConfig,
    atualizarConfig,
  };
}

module.exports = { criarRepoOperacao };
