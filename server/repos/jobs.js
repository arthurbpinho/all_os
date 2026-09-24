// Filas e resultados das ferramentas internas (Trilha em batch, Avaliação
// Independente, benchmark de simulação) e o ledger da Batch API, no PostgreSQL.
// Ver 006_sessoes_filas.sql.
//
// Cada job é o mesmo documento que ficava no array do arquivo. O que muda: ler
// uma fila filtra no banco, e alterar um job trava só aquele job — antes, cada
// atualização de progresso relia e regravava a fila inteira.

const { transacao } = require('../db');

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// Colunas de busca extraídas do documento, na ordem do INSERT/UPDATE.
function colunas(doc) {
  return [
    doc.userId != null ? String(doc.userId) : null,
    doc.status != null ? String(doc.status) : null,
    doc.batchId || null,
    JSON.stringify(doc),
  ];
}

function criarRepoJobs(pool) {
  function fila(nome) {
    async function criar(doc) {
      await pool.query(
        `INSERT INTO jobs (fila, id, user_id, status, batch_id, doc, criado_em)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))`,
        [nome, String(doc.id), ...colunas(doc), doc.createdAt || null],
      );
      return doc;
    }

    async function porId(id) {
      const { rows } = await pool.query('SELECT doc FROM jobs WHERE fila = $1 AND id = $2', [nome, String(id)]);
      return rows[0] ? rows[0].doc : null;
    }

    // Filtros: status, statusEm (lista), comBatch / semBatch, userId. Ordem de
    // chegada, ou `recentesPrimeiro`. `limite` opcional.
    async function listar({ status, statusEm, comBatch, semBatch, userId, recentesPrimeiro = false, limite } = {}) {
      const cond = ['fila = $1'];
      const params = [nome];
      const p = (v) => { params.push(v); return `$${params.length}`; };
      if (status !== undefined) cond.push(`status = ${p(status)}`);
      if (statusEm) cond.push(`status = ANY(${p(statusEm)}::text[])`);
      if (comBatch) cond.push('batch_id IS NOT NULL');
      if (semBatch) cond.push('batch_id IS NULL');
      if (userId !== undefined) cond.push(`user_id = ${p(String(userId))}`);
      const ordem = recentesPrimeiro ? 'criado_em DESC, id DESC' : 'criado_em, id';
      const lim = Number.isInteger(limite) && limite > 0 ? ` LIMIT ${p(limite)}` : '';
      const { rows } = await pool.query(`SELECT doc FROM jobs WHERE ${cond.join(' AND ')} ORDER BY ${ordem}${lim}`, params);
      return rows.map((r) => r.doc);
    }

    // Grava a alteração de um documento já travado.
    async function regravar(client, doc) {
      await client.query(
        `UPDATE jobs SET user_id = $3, status = $4, batch_id = $5, doc = $6, atualizado_em = now()
         WHERE fila = $1 AND id = $2`,
        [nome, String(doc.id), ...colunas(doc)],
      );
    }

    // Altera UM job com ele travado. `alteracao` é um objeto (mesclado no
    // documento) ou uma função que muda o documento no lugar e devolve false
    // para não gravar. Devolve o documento gravado, ou null se não existe/não gravou.
    async function atualizar(id, alteracao) {
      return transacao(pool, async (client) => {
        const { rows } = await client.query('SELECT doc FROM jobs WHERE fila = $1 AND id = $2 FOR UPDATE', [nome, String(id)]);
        if (!rows.length) return null;
        const doc = rows[0].doc;
        if (typeof alteracao === 'function') {
          if (alteracao(doc) === false) return null;
        } else {
          Object.assign(doc, alteracao);
        }
        await regravar(client, doc);
        return doc;
      });
    }

    // Altera todos os jobs de um batch, travados juntos (a coleta de um batch
    // fecha todos os itens dele de uma vez). `fn(doc)` devolve false para pular.
    // Devolve os documentos gravados.
    async function atualizarDoBatch(batchId, fn) {
      return transacao(pool, async (client) => {
        const { rows } = await client.query(
          'SELECT doc FROM jobs WHERE fila = $1 AND batch_id = $2 ORDER BY criado_em, id FOR UPDATE',
          [nome, batchId],
        );
        const gravados = [];
        for (const { doc } of rows) {
          if (fn(doc) === false) continue;
          await regravar(client, doc);
          gravados.push(doc);
        }
        return gravados;
      });
    }

    return { criar, porId, listar, atualizar, atualizarDoBatch };
  }

  // --- Ledger da Batch API ---

  async function batchesEmVoo(model) {
    const { rows } = await pool.query(
      'SELECT batch_id, model, tokens, modo, criado_em FROM batches_em_voo WHERE lower(model) = lower($1)',
      [String(model || '')],
    );
    return rows.map((r) => ({ batchId: r.batch_id, model: r.model, tokens: Number(r.tokens), modo: r.modo, criadoEm: iso(r.criado_em) }));
  }

  async function registrarBatch({ batchId, model, tokens, modo }) {
    await pool.query(
      `INSERT INTO batches_em_voo (batch_id, model, tokens, modo) VALUES ($1, $2, $3, $4)
       ON CONFLICT (batch_id) DO NOTHING`,
      [batchId, model, Math.round(Number(tokens) || 0), modo || null],
    );
  }

  // Libera a vaga do batch, e aproveita para tirar as entradas velhas demais.
  async function liberarBatch(batchId, idadeMaximaMs) {
    await pool.query(
      `DELETE FROM batches_em_voo
       WHERE batch_id = $1 OR criado_em < now() - ($2::bigint * interval '1 millisecond')`,
      [batchId, Math.floor(idadeMaximaMs)],
    );
  }

  return { fila, batchesEmVoo, registrarBatch, liberarBatch };
}

module.exports = { criarRepoJobs };
