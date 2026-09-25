// Conquistas resgatadas, conquistas já avisadas, contador de microfone e
// sequência de missões diárias no PostgreSQL: substitui achievements.json,
// achievement-unlocks.json, counters.json e daily-missions.json.
//
// Visitante não acumula nada disso: os ids que não são de conta devolvem o
// estado vazio e não gravam.

const { transacao } = require('../db');

const ID_CONTA = /^[0-9]{1,18}$/;
const ehConta = (id) => ID_CONTA.test(String(id || ''));

function criarRepoGamificacao(pool) {
  // --- Conquistas resgatadas ---

  // { [conquistaId]: resgatadaEm }, o mapa de um usuário no achievements.json.
  async function resgatadas(userId) {
    if (!ehConta(userId)) return {};
    const { rows } = await pool.query(
      'SELECT conquista_id, resgatada_em FROM conquistas_resgatadas WHERE user_id = $1',
      [String(userId)],
    );
    return Object.fromEntries(rows.map((r) => [r.conquista_id, r.resgatada_em.toISOString()]));
  }

  // Resgata (idempotente). Devolve a data do resgate — a primeira, se já havia.
  async function resgatar(userId, conquistaId) {
    const { rows } = await pool.query(
      `WITH novo AS (
         INSERT INTO conquistas_resgatadas (user_id, conquista_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING resgatada_em)
       SELECT resgatada_em FROM novo
       UNION ALL
       SELECT resgatada_em FROM conquistas_resgatadas WHERE user_id = $1 AND conquista_id = $2
       LIMIT 1`,
      [String(userId), String(conquistaId)],
    );
    return rows[0].resgatada_em.toISOString();
  }

  // Tudo, no formato do achievements.json (export do admin).
  async function todasResgatadas() {
    const { rows } = await pool.query('SELECT user_id::text, conquista_id, resgatada_em FROM conquistas_resgatadas');
    const mapa = {};
    for (const r of rows) (mapa[r.user_id] ||= {})[r.conquista_id] = r.resgatada_em.toISOString();
    return mapa;
  }

  // --- Conquistas já avisadas no sino ---

  // Devolve as conquistas já vistas antes desta chamada — ou null na primeira vez
  // (a linha de base silenciosa, que grava o conjunto atual). Depois disso, só
  // regrava quando há alguma desbloqueada nova, como fazia o arquivo. Atômico:
  // duas chamadas simultâneas não avisam a mesma conquista duas vezes.
  async function trocarVistas(userId, conquistas) {
    if (!ehConta(userId)) return [];
    const id = String(userId);
    return transacao(pool, async (client) => {
      const novo = await client.query(
        `INSERT INTO conquistas_vistas (user_id, conquistas) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [id, conquistas],
      );
      if (novo.rows.length) return null;
      const { rows } = await client.query('SELECT conquistas FROM conquistas_vistas WHERE user_id = $1 FOR UPDATE', [id]);
      const antes = rows[0].conquistas;
      const vistas = new Set(antes);
      if (conquistas.some((c) => !vistas.has(c))) {
        await client.query('UPDATE conquistas_vistas SET conquistas = $2, atualizado_em = now() WHERE user_id = $1', [id, conquistas]);
      }
      return antes;
    });
  }

  // --- Microfone ---

  async function usosDoMicrofone(userId) {
    if (!ehConta(userId)) return 0;
    const { rows } = await pool.query('SELECT mic_uses FROM contadores_usuario WHERE user_id = $1', [String(userId)]);
    return rows[0] ? rows[0].mic_uses : 0;
  }

  async function contarUsoDoMicrofone(userId) {
    if (!ehConta(userId)) return;
    await pool.query(
      `INSERT INTO contadores_usuario (user_id, mic_uses) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET mic_uses = contadores_usuario.mic_uses + 1`,
      [String(userId)],
    );
  }

  // --- Sequência de missões diárias ---

  function paraSequencia(r) {
    return r ? { current: r.atual, best: r.melhor, lastDate: r.ultima_data } : { current: 0, best: 0, lastDate: null };
  }

  async function sequenciaDeMissoes(userId) {
    if (!ehConta(userId)) return paraSequencia(null);
    const { rows } = await pool.query('SELECT * FROM sequencia_missoes_diarias WHERE user_id = $1', [String(userId)]);
    return paraSequencia(rows[0]);
  }

  // Conta o dia `hoje` (se ainda não contado): continua a sequência quando o
  // último dia contado foi `ontem`, senão recomeça em 1. Com a linha travada.
  async function contarDiaDeMissoes(userId, hoje, ontem) {
    if (!ehConta(userId)) return paraSequencia(null);
    const id = String(userId);
    return transacao(pool, async (client) => {
      await client.query('INSERT INTO sequencia_missoes_diarias (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      const { rows } = await client.query('SELECT * FROM sequencia_missoes_diarias WHERE user_id = $1 FOR UPDATE', [id]);
      const r = rows[0];
      if (r.ultima_data === hoje) return paraSequencia(r); // já contado hoje
      const atual = r.ultima_data === ontem ? r.atual + 1 : 1;
      const { rows: [gravado] } = await client.query(
        `UPDATE sequencia_missoes_diarias SET atual = $2, melhor = GREATEST(melhor, $2), ultima_data = $3
         WHERE user_id = $1 RETURNING *`,
        [id, atual, hoje],
      );
      return paraSequencia(gravado);
    });
  }

  return {
    resgatadas,
    resgatar,
    todasResgatadas,
    trocarVistas,
    usosDoMicrofone,
    contarUsoDoMicrofone,
    sequenciaDeMissoes,
    contarDiaDeMissoes,
  };
}

module.exports = { criarRepoGamificacao };
