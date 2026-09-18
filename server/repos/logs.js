// Logs de atendimento no PostgreSQL: o substituto do logs.json, a tabela central
// do app — um registro por atendimento finalizado (Treinamento, Competitivo,
// Progressão, Trilha, Neuro, visitante).
//
// Fala com o resto do app no formato do logs.json (camelCase, `timestamp` ISO,
// `messages[]` dentro do log), pelo mesmo motivo do repositório de contas: as
// rotas trocam a origem do dado sem trocar o jeito de usá-lo.
//
// Toda escrita vai direto no log afetado. Os sweeps do Competitivo, que no JSON
// liam e regravavam o arquivo inteiro sob lock, passam a atualizar log a log com
// condição (ver `atualizar`).

const { transacao } = require('../db');

const ID_CONTA = /^[0-9]{1,18}$/;
const ID_VISITANTE = /^visitor-[\w-]{1,64}$/;

// Dono do log: conta (BIGINT, com FK) ou visitante (id efêmero do JWT, sem linha
// em users). Qualquer outra coisa não é dono válido e devolve null.
function colunasDoDono(userId) {
  const id = String(userId ?? '');
  if (ID_CONTA.test(id)) return { user_id: id, visitante_id: null };
  if (ID_VISITANTE.test(id)) return { user_id: null, visitante_id: id };
  return null;
}

// Condição SQL do dono, na coluna certa (é ela que tem índice).
function filtroDoDono(userId, indice = 1) {
  const dono = colunasDoDono(userId);
  if (!dono) return null;
  return dono.user_id
    ? { sql: `l.user_id = $${indice}`, valor: dono.user_id }
    : { sql: `l.visitante_id = $${indice}`, valor: dono.visitante_id };
}

// O log com as mensagens agregadas, na ordem em que foram ditas.
const SELECT_LOG = `
  SELECT l.*, COALESCE(m.mensagens, '[]'::json) AS mensagens
  FROM logs l
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'role', lm.role, 'content', lm.content,
             'highlighted', lm.highlighted, 'comment', lm.comment
           ) ORDER BY lm.posicao) AS mensagens
    FROM log_messages lm WHERE lm.log_id = l.id
  ) m ON true`;

// Ordem do logs.json: os logs entravam no fim do array.
const ORDEM_CRONOLOGICA = 'ORDER BY l.criado_em, l.id';

const json = (v) => (v == null ? null : JSON.stringify(v));
const numeroOuNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const inteiroOuNull = (v) => {
  const n = numeroOuNull(v);
  return n === null ? null : Math.trunc(n);
};
const textoOuNull = (v) => (v == null ? null : String(v));

// Campos que só alguns logs têm (o Competitivo, sobretudo). No JSON eles só
// existiam quando preenchidos, então continuam ausentes quando vazios.
const OPCIONAIS = [
  ['eval_batch_id', 'evalBatchId'],
  ['eval_batch_at', 'evalBatchAt'],
  ['eval_batch_tentativas', 'evalBatchTentativas'],
  ['eval_batch_espera', 'evalBatchEspera'],
  ['eval_attempts', 'evalAttempts'],
  ['eval_error', 'evalError'],
  ['mmr_before', 'mmrBefore'],
  ['mmr_after', 'mmrAfter'],
  ['criteria_names', 'criteriaNames'],
];

function paraLog(r) {
  if (!r) return null;
  const log = {
    id: r.id,
    timestamp: r.criado_em.toISOString(),
    type: r.type,
    mode: r.mode,
    itemId: r.item_id,
    itemTitle: r.item_title,
    skillId: r.skill_id,
    difficulty: r.difficulty,
    durationSeconds: r.duration_seconds,
    score: r.score,
    criteriaScores: r.criteria_scores,
    evaluation: r.evaluation,
    evalVersion: r.eval_version,
    evalPartsId: r.eval_parts_id,
    imageSchema: r.image_schema,
    cost: r.cost,
    messages: r.mensagens || [],
    neuroTests: r.neuro_tests,
    userId: r.user_id ?? r.visitante_id,
    userName: r.user_name,
    evaluationPending: r.evaluation_pending,
  };
  for (const [coluna, chave] of OPCIONAIS) {
    if (r[coluna] === null || r[coluna] === undefined) continue;
    log[chave] = r[coluna] instanceof Date ? r[coluna].toISOString() : r[coluna];
  }
  return log;
}

// Chave do log → [coluna, normalização]: os campos que a avaliação (síncrona ou
// em lote) e o MMR mudam depois que o log existe.
const CAMPOS_AVALIACAO = {
  score: ['score', numeroOuNull],
  criteriaScores: ['criteria_scores', json],
  criteriaNames: ['criteria_names', json],
  evaluation: ['evaluation', (v) => String(v ?? '')],
  evalVersion: ['eval_version', textoOuNull],
  evalPartsId: ['eval_parts_id', textoOuNull],
  evaluationPending: ['evaluation_pending', (v) => !!v],
  evalBatchId: ['eval_batch_id', textoOuNull],
  evalBatchAt: ['eval_batch_at', textoOuNull],
  evalBatchTentativas: ['eval_batch_tentativas', inteiroOuNull],
  evalBatchEspera: ['eval_batch_espera', textoOuNull],
  evalAttempts: ['eval_attempts', inteiroOuNull],
  evalError: ['eval_error', textoOuNull],
  mmrBefore: ['mmr_before', inteiroOuNull],
  mmrAfter: ['mmr_after', inteiroOuNull],
};

function mapear(definicoes, dados) {
  const colunas = {};
  for (const [chave, [coluna, normalizar]] of Object.entries(definicoes)) {
    if (dados[chave] !== undefined) colunas[coluna] = normalizar(dados[chave]);
  }
  return colunas;
}

function criarRepoLogs(pool) {
  async function varios(condicao, params, db = pool, ordem = ORDEM_CRONOLOGICA) {
    const { rows } = await db.query(`${SELECT_LOG} ${condicao ? `WHERE ${condicao}` : ''} ${ordem}`, params);
    return rows.map(paraLog);
  }

  // --- Leitura ---

  async function porId(id, db = pool) {
    const { rows } = await db.query(`${SELECT_LOG} WHERE l.id = $1`, [String(id)]);
    return paraLog(rows[0]);
  }

  async function listarDoDono(userId) {
    const f = filtroDoDono(userId);
    return f ? varios(f.sql, [f.valor]) : [];
  }

  // Logs de várias contas de uma vez (os alunos de um supervisor).
  async function listarDeContas(userIds) {
    const ids = (userIds || []).map(String).filter((id) => ID_CONTA.test(id));
    return ids.length ? varios('l.user_id = ANY($1::bigint[])', [ids]) : [];
  }

  function listarTodos() {
    return varios('', []);
  }

  // Atendimento mais recente do dono com um paciente, entre os que têm conversa.
  // Empate de horário fica com o que entrou primeiro, como o sort estável do JSON.
  async function ultimoDoPaciente(userId, itemId) {
    const f = filtroDoDono(userId);
    if (!f) return null;
    const [log] = await varios(
      `${f.sql} AND l.item_id = $2 AND EXISTS (SELECT 1 FROM log_messages x WHERE x.log_id = l.id)`,
      [f.valor, String(itemId ?? '')],
      pool,
      'ORDER BY l.criado_em DESC, l.id ASC LIMIT 1',
    );
    return log || null;
  }

  // Pacientes que o dono já atendeu (com conversa), um por paciente, com o título
  // e a data do atendimento mais recente.
  async function pacientesAtendidos(userId) {
    const f = filtroDoDono(userId);
    if (!f) return [];
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (l.item_id) l.item_id, l.item_title, l.criado_em
       FROM logs l
       WHERE ${f.sql} AND l.item_id <> ''
         AND EXISTS (SELECT 1 FROM log_messages x WHERE x.log_id = l.id)
       ORDER BY l.item_id, l.criado_em DESC, l.id ASC`,
      [f.valor],
    );
    return rows.map((r) => ({ itemId: r.item_id, itemTitle: r.item_title, timestamp: r.criado_em.toISOString() }));
  }

  // Fila do Competitivo: pendentes ainda sem lote (para submeter) ou já num lote
  // (para coletar).
  function pendentesCompetitivos({ comLote = false } = {}) {
    return comLote
      ? varios('l.evaluation_pending AND l.eval_batch_id IS NOT NULL', [])
      : varios(`l.mode = 'competitive' AND l.evaluation_pending AND l.eval_batch_id IS NULL`, []);
  }

  // --- Escrita ---

  async function criar(log) {
    const dono = colunasDoDono(log.userId);
    if (!dono) throw new Error(`Dono de log inválido: "${log.userId}".`);
    return transacao(pool, async (client) => {
      const colunas = {
        id: String(log.id),
        ...(log.timestamp ? { criado_em: log.timestamp } : {}),
        ...dono,
        user_name: String(log.userName ?? ''),
        type: log.type,
        mode: log.mode || 'training',
        item_id: String(log.itemId ?? ''),
        item_title: String(log.itemTitle ?? ''),
        skill_id: inteiroOuNull(log.skillId),
        difficulty: textoOuNull(log.difficulty),
        duration_seconds: inteiroOuNull(log.durationSeconds) ?? 0,
        image_schema: textoOuNull(log.imageSchema),
        cost: json(log.cost),
        neuro_tests: json(log.neuroTests),
        ...mapear(CAMPOS_AVALIACAO, log),
      };
      const nomes = Object.keys(colunas);
      await client.query(
        `INSERT INTO logs (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(colunas),
      );

      // Todas as mensagens numa instrução só, na ordem do array.
      const mensagens = Array.isArray(log.messages) ? log.messages : [];
      if (mensagens.length) {
        await client.query(
          `INSERT INTO log_messages (log_id, posicao, role, content, highlighted, comment)
           SELECT $1, t.ord, t.m->>'role', COALESCE(t.m->>'content', ''),
                  COALESCE((t.m->>'highlighted')::boolean, false), COALESCE(t.m->>'comment', '')
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(m, ord)`,
          [String(log.id), JSON.stringify(mensagens)],
        );
      }
      return porId(log.id, client);
    });
  }

  // Atualiza os campos de avaliação de UM log. As condições reproduzem os guardas
  // que os sweeps faziam dentro do lock do arquivo, agora na mesma instrução:
  //   soSePendente → só mexe se o log ainda está pendente (não reabre um fechado);
  //   loteAtual    → só mexe se o log está naquele lote (null = sem lote nenhum).
  // Devolve o log atualizado, ou null se ele não existe ou a condição não bateu.
  async function atualizar(id, campos, { soSePendente = false, loteAtual } = {}) {
    const colunas = mapear(CAMPOS_AVALIACAO, campos || {});
    const nomes = Object.keys(colunas);
    if (!nomes.length) return porId(id);

    const params = [String(id), ...Object.values(colunas)];
    const condicoes = ['id = $1'];
    if (soSePendente) condicoes.push('evaluation_pending');
    if (loteAtual === null) condicoes.push('eval_batch_id IS NULL');
    else if (loteAtual !== undefined) {
      params.push(String(loteAtual));
      condicoes.push(`eval_batch_id = $${params.length}`);
    }

    const { rowCount } = await pool.query(
      `UPDATE logs SET ${nomes.map((c, i) => `${c} = $${i + 2}`).join(', ')}
       WHERE ${condicoes.join(' AND ')}`,
      params,
    );
    return rowCount ? porId(id) : null;
  }

  // Exclusão pelo admin. Devolve o log removido (com as mensagens), como a rota
  // devolvia, ou null se ele não existe.
  async function excluir(id) {
    return transacao(pool, async (client) => {
      const trava = await client.query('SELECT 1 FROM logs WHERE id = $1 FOR UPDATE', [String(id)]);
      if (!trava.rows.length) return null;
      const log = await porId(id, client);
      await client.query('DELETE FROM logs WHERE id = $1', [String(id)]);
      return log;
    });
  }

  // Reset do ranking: zera nota, notas por critério e a chave do detalhe de TODOS
  // os logs, preservando o texto que o aluno leu. Devolve quantos tinham nota e os
  // ids dos detalhes, que a rota apaga do volume.
  async function zerarNotas() {
    const { rows } = await pool.query(
      `WITH antes AS (SELECT id, score, eval_parts_id FROM logs FOR UPDATE)
       UPDATE logs l SET score = NULL, criteria_scores = NULL, eval_parts_id = NULL
       FROM antes a WHERE l.id = a.id
       RETURNING a.score IS NOT NULL AS tinha_nota, a.eval_parts_id`,
    );
    return {
      notasZeradas: rows.filter((r) => r.tinha_nota).length,
      evalPartsIds: rows.map((r) => r.eval_parts_id).filter(Boolean),
    };
  }

  // Retenção: remove os logs mais velhos que `ttlMs` (as mensagens vão junto).
  // Devolve quantos saíram.
  async function podarVencidos(ttlMs) {
    const { rowCount } = await pool.query(
      `DELETE FROM logs WHERE criado_em < now() - ($1::bigint * interval '1 millisecond')`,
      [Math.floor(ttlMs)],
    );
    return rowCount;
  }

  return {
    porId,
    listarDoDono,
    listarDeContas,
    listarTodos,
    ultimoDoPaciente,
    pacientesAtendidos,
    pendentesCompetitivos,
    criar,
    atualizar,
    excluir,
    zerarNotas,
    podarVencidos,
  };
}

module.exports = { criarRepoLogs, colunasDoDono };
