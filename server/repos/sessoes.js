// Sessões ativas (a conversa em andamento) no PostgreSQL: substitui
// active-sessions.json. Uma linha por sessão e uma linha por mensagem.
//
// A tela manda a conversa INTEIRA a cada salvamento. Gravar tudo de novo a cada
// vez seria o mesmo "regrava o arquivo inteiro" de antes, só que menor; aqui só
// as mensagens que mudaram são escritas, numa instrução só.

const { transacao } = require('../db');

const ID_CONTA = /^[0-9]{1,18}$/;
const ID_VISITANTE = /^visitor-[\w-]{1,64}$/;

// Coluna e valor do dono, ou null se o id não é de conta nem de visitante.
function dono(donoId) {
  const id = String(donoId || '');
  if (ID_CONTA.test(id)) return { coluna: 'user_id', valor: id };
  if (ID_VISITANTE.test(id)) return { coluna: 'visitante_id', valor: id };
  return null;
}

// Mensagem → colunas. `role` e `content` viram colunas; o resto da mensagem
// (destaque, comentário, o que a tela guardar) vai em `extras`, para voltar
// igual. Conteúdo que não é texto também vai em `extras`, sem perda.
function paraLinha(m) {
  const msg = m && typeof m === 'object' ? m : {};
  const { role, content, ...resto } = msg;
  const extras = { ...resto };
  let texto = '';
  if (typeof content === 'string') texto = content;
  else if (content !== undefined) extras.content = content;
  return {
    role: String(role == null ? '' : role),
    content: texto,
    extras: Object.keys(extras).length ? JSON.stringify(extras) : null,
  };
}

function daLinha(r) {
  return { role: r.role, content: r.content, ...(r.extras || {}) };
}

function criarRepoSessoes(pool) {
  function paraSessao(r, mensagens) {
    return {
      userId: r.user_id != null ? String(r.user_id) : r.visitante_id,
      type: r.tipo,
      itemId: r.item_id,
      messages: mensagens,
      elapsedSeconds: r.elapsed_seconds,
      threadId: r.thread_id,
      itemTitle: r.item_title,
      neuroTests: r.neuro_tests,
      lastSavedAt: r.ultimo_salvamento.toISOString(),
    };
  }

  async function montar(linhas, q = pool) {
    if (!linhas.length) return [];
    const { rows } = await q.query(
      `SELECT sessao_id::text, role, content, extras FROM sessao_ativa_mensagens
       WHERE sessao_id = ANY($1::bigint[]) ORDER BY sessao_id, posicao`,
      [linhas.map((r) => r.id)],
    );
    const porSessao = new Map(linhas.map((r) => [String(r.id), []]));
    for (const m of rows) porSessao.get(m.sessao_id).push(daLinha(m));
    return linhas.map((r) => paraSessao(r, porSessao.get(String(r.id))));
  }

  async function listarDoDono(donoId) {
    const d = dono(donoId);
    if (!d) return [];
    const { rows } = await pool.query(
      `SELECT * FROM sessoes_ativas WHERE ${d.coluna} = $1 ORDER BY ultimo_salvamento, id`, [d.valor],
    );
    return montar(rows);
  }

  async function porChave(donoId, tipo, itemId) {
    const d = dono(donoId);
    if (!d) return null;
    const { rows } = await pool.query(
      `SELECT * FROM sessoes_ativas WHERE ${d.coluna} = $1 AND tipo = $2 AND item_id = $3`,
      [d.valor, tipo, String(itemId)],
    );
    return (await montar(rows))[0] || null;
  }

  // Upsert da sessão e das mensagens, numa transação. A sessão fica travada até
  // o fim: dois salvamentos simultâneos da mesma conversa entram em fila.
  async function salvar(donoId, { tipo, itemId, messages, elapsedSeconds, threadId, itemTitle, neuroTests }) {
    const d = dono(donoId);
    if (!d) throw new Error('Dono de sessão inválido.');
    const lista = Array.isArray(messages) ? messages : [];
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO sessoes_ativas (${d.coluna}, tipo, item_id, item_title, elapsed_seconds, thread_id, neuro_tests)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (${d.coluna}, tipo, item_id) WHERE ${d.coluna} IS NOT NULL DO UPDATE
           SET item_title = EXCLUDED.item_title, elapsed_seconds = EXCLUDED.elapsed_seconds,
               thread_id = EXCLUDED.thread_id, neuro_tests = EXCLUDED.neuro_tests,
               ultimo_salvamento = now()
         RETURNING *`,
        [d.valor, tipo, String(itemId), itemTitle || '', elapsedSeconds || 0, threadId || null,
          neuroTests == null ? null : JSON.stringify(neuroTests)],
      );
      const sessao = rows[0];
      // A conversa encolheu (a tela descartou mensagens): as sobras saem.
      await client.query('DELETE FROM sessao_ativa_mensagens WHERE sessao_id = $1 AND posicao >= $2', [sessao.id, lista.length]);
      if (lista.length) {
        const linhas = lista.map(paraLinha);
        await client.query(
          `INSERT INTO sessao_ativa_mensagens (sessao_id, posicao, role, content, extras)
           SELECT $1, m.posicao, m.role, m.content, m.extras
           FROM unnest($2::int[], $3::text[], $4::text[], $5::jsonb[]) AS m (posicao, role, content, extras)
           ON CONFLICT (sessao_id, posicao) DO UPDATE
             SET role = EXCLUDED.role, content = EXCLUDED.content, extras = EXCLUDED.extras
             WHERE (sessao_ativa_mensagens.role, sessao_ativa_mensagens.content, sessao_ativa_mensagens.extras)
               IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.content, EXCLUDED.extras)`,
          [sessao.id, linhas.map((_, i) => i), linhas.map((l) => l.role), linhas.map((l) => l.content), linhas.map((l) => l.extras)],
        );
      }
      return (await montar([sessao], client))[0];
    });
  }

  async function excluir(donoId, tipo, itemId) {
    const d = dono(donoId);
    if (!d) return false;
    const r = await pool.query(
      `DELETE FROM sessoes_ativas WHERE ${d.coluna} = $1 AND tipo = $2 AND item_id = $3`,
      [d.valor, tipo, String(itemId)],
    );
    return r.rowCount > 0;
  }

  // Retenção: sessão sem salvamento há mais de `ttlMs` sai (as mensagens vão junto).
  async function podarVencidas(ttlMs) {
    const r = await pool.query(
      `DELETE FROM sessoes_ativas WHERE ultimo_salvamento < now() - ($1::bigint * interval '1 millisecond')`,
      [Math.floor(ttlMs)],
    );
    return r.rowCount;
  }

  // Todas, no formato do active-sessions.json (export do admin).
  async function todasPorChave() {
    const { rows } = await pool.query('SELECT * FROM sessoes_ativas ORDER BY id');
    const sessoes = await montar(rows);
    return Object.fromEntries(sessoes.map((s) => [`${s.userId}__${s.type}__${s.itemId}`, s]));
  }

  return { listarDoDono, porChave, salvar, excluir, podarVencidas, todasPorChave };
}

module.exports = { criarRepoSessoes };
