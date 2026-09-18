// MMR, dificuldade dos pacientes (TRI) e recordes 👑 no PostgreSQL: substitui
// mmr.json e character-records.json.
//
// O motor (server/mmr.js) continua dono das contas e do formato do estado. Este
// repositório guarda esse estado e garante a concorrência: `aplicar` roda cada
// partida numa transação que trava só as linhas envolvidas, então duas partidas
// do mesmo aluno entram em fila e não se sobrescrevem.

const { transacao } = require('../db');
const mmrEngine = require('../mmr');

const ID_CONTA = /^[0-9]{1,18}$/;

function criarRepoMmr(pool) {
  // --- Leitura ---

  async function jogador(userId) {
    if (!ID_CONTA.test(String(userId))) return null;
    const { rows } = await pool.query('SELECT estado FROM mmr_players WHERE user_id = $1', [String(userId)]);
    return rows[0] ? rows[0].estado : null;
  }

  // { [userId]: estado }, o `players` do mmr.json.
  async function jogadores() {
    const { rows } = await pool.query('SELECT user_id::text AS id, estado FROM mmr_players');
    return Object.fromEntries(rows.map((r) => [r.id, r.estado]));
  }

  // { [characterId]: estado }, o `characters` do mmr.json.
  async function personagens() {
    const { rows } = await pool.query('SELECT character_id AS id, estado FROM mmr_characters');
    return Object.fromEntries(rows.map((r) => [r.id, r.estado]));
  }

  // { [characterId]: { fonte: n } }, o `charSources` do mmr.json.
  async function fontes() {
    const { rows } = await pool.query(`SELECT character_id AS id, fontes FROM mmr_characters WHERE fontes <> '{}'`);
    return Object.fromEntries(rows.map((r) => [r.id, r.fontes]));
  }

  // { [pool]: estado }, o `anonPlayers` do mmr.json.
  async function populacoes() {
    const { rows } = await pool.query('SELECT pool AS id, estado FROM mmr_anon_players');
    return Object.fromEntries(rows.map((r) => [r.id, r.estado]));
  }

  // Tudo no formato do mmr.json (export do admin).
  async function snapshot() {
    const [players, characters, anonPlayers, charSources] = await Promise.all([
      jogadores(), personagens(), populacoes(), fontes(),
    ]);
    return { players, characters, anonPlayers, charSources };
  }

  // --- Escrita ---

  // Aplica UMA partida — Competitivo, duelo ou atendimento de população anônima.
  //
  //   alvo: { characterId, userIds, populacao, fonte }
  //   calcular({ character, players, populacao }) →
  //     { character?, players?, populacao?, contarFonte?, ...o que mais quiser }
  //
  // Os estados chegam travados e já com o padrão do motor quando ainda não
  // existem. Só é gravado o que `calcular` devolver; `fonte` só é contada quando
  // ela devolve `contarFonte: true` (o motor não mexe no D durante a calibração).
  // Devolve o que `calcular` devolveu.
  async function aplicar({ characterId, userIds = [], populacao = null, fonte = null }, calcular) {
    const charId = String(characterId);
    // Sempre na mesma ordem, para duas transações que travam os mesmos jogadores
    // nunca se esperarem em círculo.
    const ids = [...new Set(userIds.map(String))].filter((id) => ID_CONTA.test(id)).sort();

    return transacao(pool, async (client) => {
      // A linha é criada antes de travar: SELECT ... FOR UPDATE não trava linha
      // que ainda não existe, e duas primeiras partidas simultâneas no mesmo
      // paciente se sobrescreveriam.
      await client.query(
        'INSERT INTO mmr_characters (character_id, estado) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [charId, JSON.stringify(mmrEngine.newCharacter())],
      );
      const c = (await client.query(
        'SELECT estado, fontes FROM mmr_characters WHERE character_id = $1 FOR UPDATE', [charId],
      )).rows[0];

      const players = {};
      for (const id of ids) {
        await client.query(
          'INSERT INTO mmr_players (user_id, estado) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, JSON.stringify(mmrEngine.newPlayer())],
        );
        players[id] = (await client.query(
          'SELECT estado FROM mmr_players WHERE user_id = $1 FOR UPDATE', [id],
        )).rows[0].estado;
      }

      let anon;
      if (populacao) {
        await client.query(
          'INSERT INTO mmr_anon_players (pool, estado) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [populacao, JSON.stringify(mmrEngine.newAnonPopulation())],
        );
        anon = (await client.query(
          'SELECT estado FROM mmr_anon_players WHERE pool = $1 FOR UPDATE', [populacao],
        )).rows[0].estado;
      }

      const out = (await calcular({ character: c.estado, players, populacao: anon })) || {};

      if (out.character) {
        const novasFontes = { ...c.fontes };
        if (fonte && out.contarFonte) novasFontes[fonte] = (novasFontes[fonte] || 0) + 1;
        await client.query(
          'UPDATE mmr_characters SET estado = $2, fontes = $3, atualizado_em = now() WHERE character_id = $1',
          [charId, JSON.stringify(out.character), JSON.stringify(novasFontes)],
        );
      }
      for (const [id, estado] of Object.entries(out.players || {})) {
        if (!players[id]) continue; // só grava jogador que foi travado aqui
        await client.query(
          'UPDATE mmr_players SET estado = $2, atualizado_em = now() WHERE user_id = $1',
          [id, JSON.stringify(estado)],
        );
      }
      if (populacao && out.populacao) {
        await client.query(
          'UPDATE mmr_anon_players SET estado = $2, atualizado_em = now() WHERE pool = $1',
          [populacao, JSON.stringify(out.populacao)],
        );
      }
      return out;
    });
  }

  // Substitui todo o estado do MMR pelo snapshot dado (formato do mmr.json). Para
  // importação de dados e para os testes montarem um sistema já em uso.
  async function importar({ players = {}, characters = {}, anonPlayers = {}, charSources = {} } = {}) {
    return transacao(pool, async (client) => {
      await client.query('DELETE FROM mmr_players');
      await client.query('DELETE FROM mmr_characters');
      await client.query('DELETE FROM mmr_anon_players');
      for (const [id, estado] of Object.entries(players)) {
        await client.query('INSERT INTO mmr_players (user_id, estado) VALUES ($1, $2)', [id, JSON.stringify(estado)]);
      }
      const charIds = new Set([...Object.keys(characters), ...Object.keys(charSources)]);
      for (const id of charIds) {
        await client.query(
          'INSERT INTO mmr_characters (character_id, estado, fontes) VALUES ($1, $2, $3)',
          [id, JSON.stringify(characters[id] || mmrEngine.newCharacter()), JSON.stringify(charSources[id] || {})],
        );
      }
      for (const [p, estado] of Object.entries(anonPlayers)) {
        await client.query('INSERT INTO mmr_anon_players (pool, estado) VALUES ($1, $2)', [p, JSON.stringify(estado)]);
      }
    });
  }

  // --- Recordes 👑 ---

  function paraRecorde(r) {
    return {
      score: r.score,
      userId: r.user_id,
      userName: r.user_name,
      userPhoto: r.user_photo,
      at: r.at.toISOString(),
    };
  }

  // { [characterId]: recorde }, o character-records.json.
  async function recordes() {
    const { rows } = await pool.query('SELECT * FROM character_records');
    return Object.fromEntries(rows.map((r) => [r.character_id, paraRecorde(r)]));
  }

  // Registra a nota como recorde se ela SUPERAR a atual — empate não troca o dono
  // (quem chegou primeiro fica com o 👑). A comparação e a gravação são uma
  // instrução só, então duas notas simultâneas no mesmo paciente não se perdem.
  // Devolve o recorde novo, ou null se a nota não bateu o atual.
  async function registrarRecorde(characterId, score, { userId, userName, userPhoto }) {
    const { rows } = await pool.query(
      `INSERT INTO character_records (character_id, score, user_id, user_name, user_photo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (character_id) DO UPDATE
         SET score = EXCLUDED.score, user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name,
             user_photo = EXCLUDED.user_photo, at = now()
         WHERE character_records.score < EXCLUDED.score
       RETURNING *`,
      [String(characterId), score, String(userId), userName || 'Aluno', userPhoto || null],
    );
    return rows[0] ? paraRecorde(rows[0]) : null;
  }

  // Reset do ranking: os recordes são notas do avaliador antigo e caem junto.
  async function limparRecordes() {
    await pool.query('DELETE FROM character_records');
  }

  return {
    jogador,
    jogadores,
    personagens,
    fontes,
    populacoes,
    snapshot,
    aplicar,
    importar,
    recordes,
    registrarRecorde,
    limparRecordes,
  };
}

module.exports = { criarRepoMmr };
