// Processo Seletivo no PostgreSQL: substitui selection-logs.json e
// selection-stats.json.
//
// O log do candidato é o mesmo documento de sempre. O que muda: fechar a
// avaliação, marcar o batch ou o desfecho do e-mail trava só os logs envolvidos,
// e a deduplicação por WhatsApp é uma consulta indexada.

const { transacao } = require('../db');

function colunas(doc) {
  return [doc.status, doc.evalBatchId || null, JSON.stringify(doc)];
}

function criarRepoSelecao(pool) {
  // Grava o log de uma sessão. Devolve false se a sessão já tinha log (o /finish
  // repetido) — decidido pelo banco, então dois /finish simultâneos não duplicam.
  async function criar(doc, whatsapp) {
    const r = await pool.query(
      `INSERT INTO selecao_logs (id, session_id, criado_em, whatsapp, status, eval_batch_id, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id) DO NOTHING`,
      [doc.id, doc.sessionId, doc.timestamp, whatsapp || '', ...colunas(doc)],
    );
    return r.rowCount > 0;
  }

  async function existeSessao(sessionId) {
    const { rows } = await pool.query('SELECT 1 FROM selecao_logs WHERE session_id = $1', [String(sessionId)]);
    return rows.length > 0;
  }

  // Momento (ms) do atendimento mais recente deste WhatsApp que ainda bloqueia
  // uma nova tentativa, ou null. Bloqueia o log dos últimos `janelaMs` que não
  // recebeu "nova chance". A janela é explícita porque os logs não expiram mais
  // (§24.0): sem ela, um atendimento antigo bloquearia para sempre.
  async function ultimoBloqueioDoWhatsapp(whatsapp, janelaMs) {
    const { rows } = await pool.query(
      `SELECT (extract(epoch FROM max(criado_em)) * 1000)::float8 AS t FROM selecao_logs
       WHERE whatsapp = $1 AND NOT (doc ? 'novaChance')
         AND criado_em > now() - ($2::bigint * interval '1 millisecond')`,
      [String(whatsapp), Math.floor(janelaMs)],
    );
    return rows[0].t == null ? null : Number(rows[0].t);
  }

  // Marca o log com a "nova chance" ({ em, por }). Idempotente: se o log já foi
  // liberado, devolve o documento como está, sem trocar quem liberou nem quando.
  // Devolve null se o log não existe.
  async function concederNovaChance(id, concessao) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query('SELECT doc FROM selecao_logs WHERE id = $1 FOR UPDATE', [String(id)]);
      if (!rows.length) return null;
      const doc = rows[0].doc;
      if (!doc.novaChance) {
        doc.novaChance = concessao;
        await regravar(client, doc);
      }
      return doc;
    });
  }

  // Todos os logs, por data (`desc` = mais recentes primeiro).
  async function listar(ordem = 'asc') {
    const dir = ordem === 'desc' ? 'DESC' : 'ASC';
    const { rows } = await pool.query(`SELECT doc FROM selecao_logs ORDER BY criado_em ${dir}, id ${dir}`);
    return rows.map((r) => r.doc);
  }

  // Pendentes de avaliação, com ou sem batch.
  async function pendentes({ comBatch }) {
    const { rows } = await pool.query(
      `SELECT doc FROM selecao_logs WHERE status = 'pending' AND eval_batch_id IS ${comBatch ? 'NOT NULL' : 'NULL'}
       ORDER BY criado_em, id`,
    );
    return rows.map((r) => r.doc);
  }

  async function regravar(client, doc) {
    await client.query(
      'UPDATE selecao_logs SET status = $2, eval_batch_id = $3, doc = $4 WHERE id = $1',
      [doc.id, ...colunas(doc)],
    );
  }

  // Trava os logs dados (ou os de um batch) e entrega cada documento a `fn`, que
  // o altera no lugar e devolve false para não gravar. Devolve os gravados.
  async function atualizarTravados(sql, params, fn) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query(sql, params);
      const gravados = [];
      for (const { doc } of rows) {
        if (fn(doc) === false) continue;
        await regravar(client, doc);
        gravados.push(doc);
      }
      return gravados;
    });
  }

  function atualizarVarios(ids, fn) {
    return atualizarTravados(
      'SELECT doc FROM selecao_logs WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE',
      [ids.map(String)], fn,
    );
  }

  async function atualizar(id, fn) {
    const [doc] = await atualizarVarios([id], fn);
    return doc || null;
  }

  function atualizarDoBatch(batchId, fn) {
    return atualizarTravados(
      'SELECT doc FROM selecao_logs WHERE eval_batch_id = $1 ORDER BY id FOR UPDATE',
      [batchId], fn,
    );
  }

  // Logs do seletivo são persistentes (demandas.md §24.0). As estatísticas
  // anônimas continuam sendo registradas — quem consulta a Dashboard vê os dois.

  // --- Estatísticas ---

  async function registrarEstatisticas(lista) {
    for (const s of lista) {
      await pool.query(
        'INSERT INTO selecao_estatisticas (criado_em, score, status) VALUES ($1, $2, $3)',
        [s.timestamp, s.score, s.status],
      );
    }
  }

  // { timestamp, score, status } desde `desde` (Date).
  async function estatisticasDesde(desde) {
    const { rows } = await pool.query(
      'SELECT criado_em, score, status FROM selecao_estatisticas WHERE criado_em >= $1 ORDER BY criado_em, id',
      [desde],
    );
    return rows.map((r) => ({ timestamp: r.criado_em.toISOString(), score: r.score, status: r.status }));
  }

  return {
    criar, existeSessao, ultimoBloqueioDoWhatsapp, concederNovaChance, listar, pendentes,
    atualizar, atualizarVarios, atualizarDoBatch,
    registrarEstatisticas, estatisticasDesde,
  };
}

module.exports = { criarRepoSelecao };
