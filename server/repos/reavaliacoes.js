// Reavaliações de logs (migração 018): o pedido do aluno, a decisão do
// supervisor/admin e a execução do pipeline de novo sobre o mesmo atendimento.
//
// O ciclo de uma linha:
//   solicitada ──(aprovar)──▶ em_andamento ──▶ concluida | falhou
//        └──────(recusar)──▶ recusada
// Supervisor/admin que manda reavaliar direto cria a linha já em_andamento.
//
// O índice único parcial (um pedido aberto por log) é quem impede duas
// reavaliações simultâneas do mesmo log: a segunda bate no índice e volta null.

const { transacao } = require('../db');

// Uma execução em_andamento mais velha que isto é dada como interrompida (o
// servidor reiniciou no meio, ou o pipeline travou). O pipeline síncrono leva
// minutos, não meia hora.
const TRAVADA_MS = 30 * 60 * 1000;

const ABERTAS = `('solicitada', 'em_andamento')`;

function paraReavaliacao(r) {
  if (!r) return null;
  const iso = (d) => (d ? d.toISOString() : null);
  const anterior = r.avaliacao_anterior || null;
  return {
    id: String(r.id),
    logId: r.log_id,
    status: r.status,
    solicitadoPor: r.solicitado_por == null ? null : String(r.solicitado_por),
    solicitadoPorNome: r.solicitado_por_nome || null,
    solicitadoEm: iso(r.solicitado_em),
    motivo: r.motivo || '',
    decididoPor: r.decidido_por == null ? null : String(r.decidido_por),
    decididoPorNome: r.decidido_por_nome || null,
    decididoEm: iso(r.decidido_em),
    concluidoEm: iso(r.concluido_em),
    erro: r.erro || null,
    notaAnterior: anterior && Number.isFinite(anterior.score) ? anterior.score : null,
    notaNova: r.nota_nova,
    avaliacaoAnterior: anterior,
  };
}

const SELECT = `
  SELECT r.*, us.name AS solicitado_por_nome, ud.name AS decidido_por_nome
  FROM reavaliacoes r
  LEFT JOIN users us ON us.id = r.solicitado_por
  LEFT JOIN users ud ON ud.id = r.decidido_por`;

function criarRepoReavaliacoes(pool) {
  async function porId(id, db = pool) {
    const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [String(id)]);
    return paraReavaliacao(rows[0]);
  }

  // A mais recente de cada log (aberta ou não) — é o estado que as telas mostram.
  async function ultimasDosLogs(logIds) {
    const ids = [...new Set((logIds || []).map(String))];
    if (!ids.length) return new Map();
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (r.log_id) r.*, us.name AS solicitado_por_nome, ud.name AS decidido_por_nome
       FROM reavaliacoes r
       LEFT JOIN users us ON us.id = r.solicitado_por
       LEFT JOIN users ud ON ud.id = r.decidido_por
       WHERE r.log_id = ANY($1::text[])
       ORDER BY r.log_id, r.id DESC`,
      [ids],
    );
    return new Map(rows.map((r) => [r.log_id, paraReavaliacao(r)]));
  }

  async function abertaDoLog(logId, db = pool) {
    const { rows } = await db.query(`${SELECT} WHERE r.log_id = $1 AND r.status IN ${ABERTAS}`, [String(logId)]);
    return paraReavaliacao(rows[0]);
  }

  // Dá como falha a execução que ficou em_andamento além do razoável. Devolve
  // quantas fechou. Roda no boot e antes de toda tentativa nova.
  async function encerrarTravadas({ logId = null, agora = Date.now() } = {}) {
    const params = [new Date(agora - TRAVADA_MS).toISOString()];
    let cond = '';
    if (logId) { params.push(String(logId)); cond = ' AND log_id = $2'; }
    const { rowCount } = await pool.query(
      `UPDATE reavaliacoes SET status = 'falhou', concluido_em = now(),
         erro = 'A reavaliação foi interrompida antes de terminar (o servidor reiniciou ou o pipeline travou).'
       WHERE status = 'em_andamento' AND decidido_em < $1${cond}`,
      params,
    );
    return rowCount;
  }

  // O aluno pede. null quando já há um pedido aberto para o log.
  async function solicitar({ logId, por, motivo = '' }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO reavaliacoes (log_id, status, solicitado_por, motivo)
         VALUES ($1, 'solicitada', $2, $3) RETURNING id`,
        [String(logId), por == null ? null : String(por), String(motivo || '')],
      );
      return porId(rows[0].id);
    } catch (e) {
      if (e.code === '23505') return null; // reavaliacoes_uma_aberta_uq
      throw e;
    }
  }

  // Supervisor/admin aprova o pedido aberto ou, sem pedido, manda reavaliar
  // direto. Guarda a avaliação vigente em `anterior`. null quando já há uma
  // reavaliação em_andamento para o log.
  async function iniciar({ logId, por, motivo = '', anterior }) {
    await encerrarTravadas({ logId });
    return transacao(pool, async (client) => {
      // Serializa com outro aprovar/recusar do mesmo log.
      await client.query('SELECT 1 FROM logs WHERE id = $1 FOR UPDATE', [String(logId)]);
      const aberta = await abertaDoLog(logId, client);
      if (aberta && aberta.status === 'em_andamento') return null;
      let id;
      if (aberta) {
        await client.query(
          `UPDATE reavaliacoes SET status = 'em_andamento', decidido_por = $2, decidido_em = now(),
             avaliacao_anterior = $3::jsonb
           WHERE id = $1`,
          [aberta.id, String(por), JSON.stringify(anterior || null)],
        );
        id = aberta.id;
      } else {
        const { rows } = await client.query(
          `INSERT INTO reavaliacoes (log_id, status, solicitado_por, motivo, decidido_por, decidido_em, avaliacao_anterior)
           VALUES ($1, 'em_andamento', $2, $3, $2, now(), $4::jsonb) RETURNING id`,
          [String(logId), String(por), String(motivo || ''), JSON.stringify(anterior || null)],
        );
        id = rows[0].id;
      }
      return porId(id, client);
    });
  }

  // Recusa o pedido aberto. null quando não há pedido esperando decisão.
  async function recusar({ logId, por }) {
    const { rows } = await pool.query(
      `UPDATE reavaliacoes SET status = 'recusada', decidido_por = $2, decidido_em = now()
       WHERE log_id = $1 AND status = 'solicitada' RETURNING id`,
      [String(logId), String(por)],
    );
    return rows.length ? porId(rows[0].id) : null;
  }

  // Fecha a execução. Só mexe numa linha em_andamento: se ela já foi dada como
  // travada, o resultado tardio não ressuscita o registro (devolve null).
  async function concluir(id, { notaNova }) {
    const { rowCount } = await pool.query(
      `UPDATE reavaliacoes SET status = 'concluida', concluido_em = now(), nota_nova = $2, erro = NULL
       WHERE id = $1 AND status = 'em_andamento'`,
      [String(id), Number.isFinite(notaNova) ? notaNova : null],
    );
    return rowCount ? porId(id) : null;
  }

  async function falhar(id, erro) {
    const { rowCount } = await pool.query(
      `UPDATE reavaliacoes SET status = 'falhou', concluido_em = now(), erro = $2
       WHERE id = $1 AND status = 'em_andamento'`,
      [String(id), String(erro || 'erro desconhecido').slice(0, 1000)],
    );
    return rowCount ? porId(id) : null;
  }

  // Está em_andamento? (Checado antes de gravar o resultado no log: uma
  // execução dada como travada não pode sobrescrever o log depois.)
  async function emAndamento(id) {
    const { rows } = await pool.query(`SELECT 1 FROM reavaliacoes WHERE id = $1 AND status = 'em_andamento'`, [String(id)]);
    return rows.length > 0;
  }

  return {
    porId, ultimasDosLogs, abertaDoLog, encerrarTravadas, solicitar, iniciar, recusar, concluir, falhar, emAndamento,
  };
}

module.exports = { criarRepoReavaliacoes, TRAVADA_MS };
