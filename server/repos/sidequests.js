// Sidequests no PostgreSQL: substitui sidequests.json.
//
// Várias leituras são síncronas e acontecem em muito lugar (o título de
// recompensa aparece em publicUser e no ranking; a missão do Treinamento decide
// o prompt do avaliador). Por isso o estado fica numa cópia em memória, no mesmo
// formato do arquivo ({ bank, active, completed }), carregada no boot e
// atualizada a cada gravação — que passa sempre por aqui. O banco é a verdade e
// cada gravação trava só o que muda. Vale porque o app roda em UMA instância
// (CLAUDE.md §2).

const { transacao } = require('../db');

// Trava por aluno para concluir a missão diária (pg_advisory_xact_lock de duas partes).
const TRAVA_MISSAO = 7140003;
const MARCA_SEMEADO = 'sidequests-banco-semeado';

function criarRepoSidequests(pool) {
  let estado = { bank: [], active: {}, completed: {} };

  async function carregar() {
    const [banco, ativas, concluidas] = await Promise.all([
      pool.query('SELECT doc FROM sidequests_banco ORDER BY criado_em, id'),
      pool.query('SELECT user_id::text, doc FROM sidequests_ativas'),
      pool.query('SELECT user_id::text, doc FROM sidequests_concluidas ORDER BY concluida_em, id'),
    ]);
    const completed = {};
    for (const r of concluidas.rows) (completed[r.user_id] ||= []).push(r.doc);
    estado = {
      bank: banco.rows.map((r) => r.doc),
      active: Object.fromEntries(ativas.rows.map((r) => [r.user_id, r.doc])),
      completed,
    };
  }

  // O estado em memória. SOMENTE LEITURA: toda alteração passa pelas funções abaixo.
  function ler() {
    return estado;
  }

  // Semeia o banco de sidequests no primeiro boot de um banco novo. Uma vez só: se
  // o admin apagar tudo depois, o banco fica vazio (como o arquivo ficava).
  async function semearBancoUmaVez(seed) {
    await transacao(pool, async (client) => {
      const marca = await client.query(
        `INSERT INTO configuracoes (chave, valor) VALUES ($1, 'true') ON CONFLICT DO NOTHING RETURNING chave`,
        [MARCA_SEMEADO],
      );
      if (!marca.rows.length) return;
      for (const s of seed) {
        await client.query(
          'INSERT INTO sidequests_banco (id, criado_em, doc) VALUES ($1, COALESCE($2::timestamptz, now()), $3) ON CONFLICT DO NOTHING',
          [s.id, s.createdAt || null, JSON.stringify(s)],
        );
      }
    });
  }

  async function adicionarAoBanco(entry) {
    await pool.query(
      'INSERT INTO sidequests_banco (id, criado_em, doc) VALUES ($1, COALESCE($2::timestamptz, now()), $3)',
      [entry.id, entry.createdAt || null, JSON.stringify(entry)],
    );
    estado.bank = [...estado.bank, entry];
    return entry;
  }

  async function removerDoBanco(id) {
    const r = await pool.query('DELETE FROM sidequests_banco WHERE id = $1', [String(id)]);
    if (!r.rowCount) return false;
    estado.bank = estado.bank.filter((s) => s.id !== String(id));
    return true;
  }

  // Atribui (ou substitui) a sidequest ativa do aluno.
  async function atribuir(userId, doc) {
    await pool.query(
      `INSERT INTO sidequests_ativas (user_id, doc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc, atribuida_em = now()`,
      [String(userId), JSON.stringify(doc)],
    );
    estado.active = { ...estado.active, [String(userId)]: doc };
    return doc;
  }

  async function desatribuir(userId) {
    await pool.query('DELETE FROM sidequests_ativas WHERE user_id = $1', [String(userId)]);
    const { [String(userId)]: _removida, ...resto } = estado.active;
    estado.active = resto;
  }

  function registrarConcluida(userId, registro) {
    const id = String(userId);
    estado.completed = { ...estado.completed, [id]: [...(estado.completed[id] || []), registro] };
  }

  // Conclui a sidequest ativa: `montar(ativa)` devolve o registro de conclusão.
  // Com a atribuição travada — duas submissões simultâneas não concedem o título
  // duas vezes. Devolve o registro, ou null se não havia ativa.
  async function concluirAtiva(userId, montar) {
    const id = String(userId);
    const registro = await transacao(pool, async (client) => {
      const { rows } = await client.query('SELECT doc FROM sidequests_ativas WHERE user_id = $1 FOR UPDATE', [id]);
      if (!rows.length) return null;
      const r = montar(rows[0].doc);
      await client.query(
        'INSERT INTO sidequests_concluidas (user_id, recompensa_id, doc) VALUES ($1, $2, $3)',
        [id, r.rewardTitleId || null, JSON.stringify(r)],
      );
      await client.query('DELETE FROM sidequests_ativas WHERE user_id = $1', [id]);
      return r;
    });
    if (registro) {
      const { [id]: _concluida, ...resto } = estado.active;
      estado.active = resto;
      registrarConcluida(id, registro);
    }
    return registro;
  }

  // Conclui a missão diária, sem repetir a recompensa (não dá para farmar). Com o
  // aluno travado. Devolve o registro, ou null se a recompensa já era dele.
  async function concluirDiaria(userId, registro) {
    const id = String(userId);
    const gravado = await transacao(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [TRAVA_MISSAO, id]);
      const ja = await client.query(
        'SELECT 1 FROM sidequests_concluidas WHERE user_id = $1 AND recompensa_id = $2 LIMIT 1',
        [id, registro.rewardTitleId],
      );
      if (ja.rows.length) return null;
      await client.query(
        'INSERT INTO sidequests_concluidas (user_id, recompensa_id, doc) VALUES ($1, $2, $3)',
        [id, registro.rewardTitleId || null, JSON.stringify(registro)],
      );
      return registro;
    });
    if (gravado) registrarConcluida(id, gravado);
    return gravado;
  }

  return {
    carregar, ler, semearBancoUmaVez, adicionarAoBanco, removerDoBanco,
    atribuir, desatribuir, concluirAtiva, concluirDiaria,
  };
}

module.exports = { criarRepoSidequests };
