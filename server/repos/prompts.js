// Prompts, histórico de versões e critérios no PostgreSQL (005_prompts.sql).
//
// Quem chama é o server/prompt-files.js, que valida o conteúdo antes e mantém a
// cópia em memória (prompt-store) em dia depois. Este módulo só persiste, e
// garante que conteúdo novo e versão anterior entrem juntos ou não entrem.

const { transacao } = require('../db');

const crypto = require('crypto');

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const sha256 = (texto) => crypto.createHash('sha256').update(String(texto), 'utf8').digest('hex');

function criarRepoPrompts(pool) {
  async function todos() {
    const { rows } = await pool.query('SELECT caminho, conteudo, atualizado_em FROM prompt_arquivos ORDER BY caminho');
    return rows.map((r) => ({ caminho: r.caminho, conteudo: r.conteudo, atualizadoEm: iso(r.atualizado_em) }));
  }

  // Deriva as linhas de critério do .md de critérios de uma régua, pelo NOME
  // (ver 005_prompts.sql). Roda dentro da transação de quem gravou o .md.
  async function sincronizarCriterios(client, regua, lista) {
    const nomes = [];
    for (const [i, c] of lista.entries()) {
      nomes.push(String(c.nome).toLowerCase());
      await client.query(
        `INSERT INTO criterios (regua, nome, ordem, linha_curta, descricao)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (regua, lower(nome)) DO UPDATE
           SET nome = EXCLUDED.nome, ordem = EXCLUDED.ordem, linha_curta = EXCLUDED.linha_curta,
               descricao = EXCLUDED.descricao, ativo = true, atualizado_em = now()
           WHERE (criterios.nome, criterios.ordem, criterios.linha_curta, criterios.descricao, criterios.ativo)
             IS DISTINCT FROM (EXCLUDED.nome, EXCLUDED.ordem, EXCLUDED.linha_curta, EXCLUDED.descricao, true)`,
        [regua, c.nome, i + 1, c.linhaCurta || '', c.descricao || ''],
      );
    }
    await client.query(
      `UPDATE criterios SET ativo = false, atualizado_em = now()
       WHERE regua = $1 AND ativo AND NOT (lower(nome) = ANY($2::text[]))`,
      [regua, nomes],
    );
  }

  // Cria um prompt que ainda não existe. Devolve null se o caminho já existe —
  // decidido pelo banco, então duas criações simultâneas não se sobrescrevem.
  async function criar(caminho, conteudo, autor, { criterios } = {}) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO prompt_arquivos (caminho, conteudo, atualizado_por) VALUES ($1, $2, $3)
         ON CONFLICT (caminho) DO NOTHING RETURNING atualizado_em`,
        [caminho, conteudo, autor || null],
      );
      if (!rows.length) return null;
      if (criterios) await sincronizarCriterios(client, criterios.regua, criterios.lista);
      return { atualizadoEm: iso(rows[0].atualizado_em) };
    });
  }

  // Grava um prompt existente, guardando antes o conteúdo que estava no ar.
  // Devolve null se o caminho não existe.
  async function gravar(caminho, conteudo, autor, { motivo = 'edicao', criterios } = {}) {
    return transacao(pool, async (client) => {
      const atual = await client.query('SELECT conteudo FROM prompt_arquivos WHERE caminho = $1 FOR UPDATE', [caminho]);
      if (!atual.rows.length) return null;
      const versao = await client.query(
        'INSERT INTO prompt_versoes (caminho, conteudo, motivo, autor) VALUES ($1, $2, $3, $4) RETURNING id::text',
        [caminho, atual.rows[0].conteudo, motivo, autor || null],
      );
      const { rows } = await client.query(
        `UPDATE prompt_arquivos SET conteudo = $2, atualizado_em = now(), atualizado_por = $3
         WHERE caminho = $1 RETURNING atualizado_em`,
        [caminho, conteudo, autor || null],
      );
      if (criterios) await sincronizarCriterios(client, criterios.regua, criterios.lista);
      return { versaoAnterior: versao.rows[0].id, atualizadoEm: iso(rows[0].atualizado_em) };
    });
  }

  // Exclui um prompt, com o conteúdo guardado no histórico. Null se não existe.
  async function excluir(caminho, autor) {
    return transacao(pool, async (client) => {
      const { rows } = await client.query('DELETE FROM prompt_arquivos WHERE caminho = $1 RETURNING conteudo', [caminho]);
      if (!rows.length) return null;
      const versao = await client.query(
        `INSERT INTO prompt_versoes (caminho, conteudo, motivo, autor) VALUES ($1, $2, 'exclusao', $3) RETURNING id::text`,
        [caminho, rows[0].conteudo, autor || null],
      );
      return { versaoAnterior: versao.rows[0].id };
    });
  }

  // Histórico de um caminho, mais recente primeiro.
  async function versoes(caminho) {
    const { rows } = await pool.query(
      `SELECT id::text, criado_em, octet_length(conteudo) AS size, motivo, autor
       FROM prompt_versoes WHERE caminho = $1 ORDER BY id DESC`,
      [caminho],
    );
    return rows.map((r) => ({ id: r.id, createdAt: iso(r.criado_em), size: r.size, motivo: r.motivo, autor: r.autor }));
  }

  // Conteúdo de uma versão, conferindo que ela é DAQUELE caminho.
  async function versao(caminho, id) {
    if (!/^[0-9]{1,18}$/.test(String(id))) return null;
    const { rows } = await pool.query('SELECT conteudo FROM prompt_versoes WHERE caminho = $1 AND id = $2', [caminho, String(id)]);
    return rows[0] ? rows[0].conteudo : null;
  }

  // Semeadura: insere o que falta, na ordem dada — o primeiro de um caminho
  // repetido fica. Nunca sobrescreve o que já está no banco. Devolve quantos entraram.
  async function importarFaltantes(entradas) {
    let n = 0;
    for (const e of entradas) {
      const r = await pool.query(
        'INSERT INTO prompt_arquivos (caminho, conteudo) VALUES ($1, $2) ON CONFLICT (caminho) DO NOTHING',
        [e.caminho, e.conteudo],
      );
      n += r.rowCount;
    }
    return n;
  }

  // Semeadura do boot (014_prompts_semente.sql). Para cada entrada (a primeira
  // de um caminho repetido fica):
  //   · caminho novo → insere;
  //   · banco igual à semente → só registra o hash;
  //   · banco ainda com o texto da semente anterior (hash bate) → atualiza, com
  //     a versão velha no histórico (motivo 'semente');
  //   · banco editado pelo admin → preserva, e devolve o caminho em `preservados`.
  async function semear(entradas) {
    const r = { inseridos: 0, atualizados: [], preservados: [] };
    const vistos = new Set();
    for (const e of entradas) {
      if (vistos.has(e.caminho)) continue;
      vistos.add(e.caminho);
      const hash = sha256(e.conteudo);
      await transacao(pool, async (client) => {
        const { rows } = await client.query(
          'SELECT conteudo, semente_hash FROM prompt_arquivos WHERE caminho = $1 FOR UPDATE', [e.caminho],
        );
        if (!rows.length) {
          const ins = await client.query(
            `INSERT INTO prompt_arquivos (caminho, conteudo, semente_hash) VALUES ($1, $2, $3)
             ON CONFLICT (caminho) DO NOTHING`,
            [e.caminho, e.conteudo, hash],
          );
          r.inseridos += ins.rowCount;
          return;
        }
        const atual = rows[0];
        if (atual.conteudo === e.conteudo) {
          if (atual.semente_hash !== hash) {
            await client.query('UPDATE prompt_arquivos SET semente_hash = $2 WHERE caminho = $1', [e.caminho, hash]);
          }
          return;
        }
        if (atual.semente_hash && atual.semente_hash === sha256(atual.conteudo)) {
          await client.query(
            `INSERT INTO prompt_versoes (caminho, conteudo, motivo, autor) VALUES ($1, $2, 'semente', 'semente')`,
            [e.caminho, atual.conteudo],
          );
          await client.query(
            `UPDATE prompt_arquivos SET conteudo = $2, semente_hash = $3, atualizado_em = now(), atualizado_por = 'semente'
             WHERE caminho = $1`,
            [e.caminho, e.conteudo, hash],
          );
          r.atualizados.push(e.caminho);
          return;
        }
        r.preservados.push(e.caminho);
      });
    }
    return r;
  }

  // Sincroniza os critérios fora de uma gravação (boot).
  async function derivarCriterios(regua, lista) {
    return transacao(pool, (client) => sincronizarCriterios(client, regua, lista));
  }

  const paraCriterio = (r) => ({
    id: r.id, regua: r.regua, nome: r.nome, ordem: r.ordem, linhaCurta: r.linha_curta, ativo: r.ativo,
    historicoDesde: r.historico_desde ? iso(r.historico_desde) : null,
    nomesAnteriores: r.nomes_anteriores || [],
  });

  async function criteriosDa(regua) {
    const { rows } = await pool.query(
      `SELECT id::text, regua, nome, ordem, linha_curta, ativo, historico_desde, nomes_anteriores FROM criterios
       WHERE regua = $1 ORDER BY ativo DESC, ordem, id`,
      [regua],
    );
    return rows.map(paraCriterio);
  }

  // Todos os critérios ativos de todas as réguas: nomes antigos e início do
  // histórico, para o gráfico do perfil juntar as notas certas.
  async function identidadesDeCriterios() {
    const { rows } = await pool.query(
      `SELECT id::text, regua, nome, ordem, linha_curta, ativo, historico_desde, nomes_anteriores
       FROM criterios WHERE ativo ORDER BY regua, ordem`,
    );
    return rows.map(paraCriterio);
  }

  // "Zerar histórico": a média do critério recomeça agora, e os nomes antigos
  // deixam de apontar para ele.
  async function zerarHistorico(regua, nome) {
    await pool.query(
      `UPDATE criterios SET historico_desde = now(), nomes_anteriores = '{}', atualizado_em = now()
       WHERE regua = $1 AND lower(nome) = lower($2)`,
      [regua, nome],
    );
  }

  // "Manter histórico" num critério que mudou de nome: o novo herda o início do
  // histórico e os nomes do antigo (mais o próprio nome antigo).
  async function herdarHistorico(regua, nomeAntigo, nomeNovo) {
    if (String(nomeAntigo).toLowerCase() === String(nomeNovo).toLowerCase()) return;
    await pool.query(
      `UPDATE criterios n
       SET nomes_anteriores = ARRAY(
             SELECT DISTINCT x FROM unnest(n.nomes_anteriores || o.nomes_anteriores || ARRAY[o.nome]) AS x
             WHERE lower(x) <> lower(n.nome)),
           historico_desde = o.historico_desde, atualizado_em = now()
       FROM criterios o
       WHERE n.regua = $1 AND lower(n.nome) = lower($3) AND o.regua = $1 AND lower(o.nome) = lower($2)`,
      [regua, nomeAntigo, nomeNovo],
    );
  }

  return {
    todos, criar, gravar, excluir, versoes, versao, importarFaltantes, semear, derivarCriterios,
    criteriosDa, identidadesDeCriterios, zerarHistorico, herdarHistorico,
  };
}

module.exports = { criarRepoPrompts };
