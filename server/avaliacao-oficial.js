// AVALIADOR OFICIAL DA PRODUÇÃO — pipeline v34 (AvaliAllos), a régua LTS.
//
// Este é o avaliador de TODOS os modos de sessão do app: Treinamento (com e sem
// progressão), Competitivo, Visitante, Processo Seletivo, Duelo e a correção
// manual do supervisor. Dois caminhos ficam de fora, de propósito:
//
//   · NEUROAVALIAÇÃO — tem grade própria (4 critérios) e é o único modo em que o
//     gabarito diagnóstico pode ir ao aluno. Segue no avaliador de prompt único
//     `avaliacao/avaliador 18/avaliador-v18-25-neuro.md`, em stand-by por
//     decisão do dono.
//   · TRILHA — o avaliador é escolhido POR EXERCÍCIO pelo admin, e a nota é uma
//     porcentagem de domínio. Nada aqui a alcança.
//
// (A Antessala não avalia nada: é maiêutica, e não tem nota.)
//
// O QUE MUDA PARA QUEM LÊ O CÓDIGO ANTIGO
//
// O avaliador de prompt único era UMA chamada que devolvia um texto com tudo
// dentro: `[notas]` no começo (que o servidor extraía e escondia do aluno) e a
// prosa depois. O v34 são nove chamadas e o resultado é ESTRUTURADO: oito
// análises, com cinco qualidades e uma nota por critério, mais um corpo de
// feedback escrito por um sintetizador que nunca viu o Bloco 1.
//
// Isso muda o problema de sigilo. Nota por critério é número, e número podia
// trafegar pelo cliente sem estragar nada; ANÁLISE por critério é prosa escrita
// por quem estava lendo o gabarito, e é exatamente o que o aluno não pode ver.
// Por isso o detalhe NUNCA passa pelo navegador do aluno: ele é gravado aqui, no
// volume, e o log só guarda o `id` do arquivo. O aluno recebe duas coisas, e só
// elas — a NOTA TOTAL e o FEEDBACK QUALITATIVO. Nota e feedback por critério são
// de supervisor e admin, servidos por uma rota que checa o papel.
//
// Fora isso, quem escolhe o modelo continua sendo a tela Administração →
// Modelos de IA (uma categoria por modo). O pipeline roda no modelo/effort que
// a categoria resolver, seja OpenAI ou GLM.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');
const aval = require('./avaliador-pipeline');

// Versão do pipeline em produção. Uma constante, e não configuração: a régua da
// escola é uma só em todos os modos, e trocá-la é decisão de deploy, não de tela.
const VERSAO = 'v34';
// Modo progressão (reatendimento, sidequest e missão diária) — mesma régua e
// mesmos critérios, entrada diferente. Ver PIPELINE_VERSIONS no pipeline.
const VERSAO_PROGRESSAO = 'v34-progressao';
// Modo duelo (dois alunos no mesmo caso) — mesma régua e mesmos critérios, com
// o nó lendo os dois logs e devolvendo dois conjuntos de qualidades.
const VERSAO_DUELO = 'v34-duelo';

// Categorias de Administração → Modelos de IA que rodam o pipeline oficial. A
// única que fica fora (neuro) está no cabeçalho, com o motivo.
const CATEGORIAS_OFICIAIS = new Set(['treinamento', 'competitivo', 'seletivo', 'visitante', 'avaliacaoManual', 'duelo']);
function categoriaUsaPipeline(categoria) {
  return CATEGORIAS_OFICIAIS.has(String(categoria));
}

// --- Materiais de cada modo ------------------------------------------------

// Modo padrão: um atendimento, com o Bloco 1 do caso.
function materiaisPadrao({ bloco1, log }) {
  return { '{{BLOCO_1}}': bloco1 || '', '{{LOG}}': log || '' };
}

// Modo progressão: o atendimento avaliado mais o anterior, a avaliação que o
// aluno leu depois dele e a missão ativa (sidequest OU desafio do dia — nunca as
// duas). O que não existe entra vazio e o pipeline escreve a frase de ausência.
function materiaisProgressao({ bloco1, log, atendimento1, avaliacao1, missao }) {
  return {
    '{{BLOCO_1}}': bloco1 || '',
    '{{ATENDIMENTO_1}}': atendimento1 || '',
    '{{AVALIACAO_1}}': avaliacao1 || '',
    '{{MISSAO}}': missao || '',
    '{{LOG}}': log || '',
  };
}

// Modo duelo: o caso e os dois atendimentos, com o nome de cada aluno no slot
// dele. `A` é sempre o desafiante e `B` o oponente — a ordem é a do registro do
// duelo, e é ela que o código usa depois para mapear o vencedor de volta aos
// dois lados. Trocá-la aqui trocaria o resultado do duelo em silêncio.
function materiaisDuelo({ bloco1, alunoA, logA, alunoB, logB }) {
  return {
    '{{BLOCO_1}}': bloco1 || '',
    '{{ALUNO_A}}': alunoA || '',
    '{{LOG_A}}': logA || '',
    '{{ALUNO_B}}': alunoB || '',
    '{{LOG_B}}': logB || '',
  };
}

// --- Execução --------------------------------------------------------------

// Roda o pipeline oficial e devolve o resultado do avaliador-pipeline.js
// (notaFinal, partes, corpoSintetizador, instrumentacao, missao, comparativo...).
//
// `capturarReasoning: false` fixo: em produção seriam oito resumos de
// raciocínio por sessão avaliada, que ninguém lê, e ligá-los troca o transporte
// das chamadas sem mudar nada do que o aluno ou o supervisor recebem. O
// laboratório da Avaliação Independente é onde se lê raciocínio.
async function avaliar({ client, provider, model, effort, materiais, version = VERSAO, onProgress }) {
  return aval.runAvaliacaoIndependente({
    openai: client, provider, model, effort, materiais, version,
    evaluatorId: version, capturarReasoning: false, onProgress,
  });
}

// Uma versão está PRONTA PARA RODAR quando os .md dela existem no volume e
// montam. Serve para o caller decidir antes de começar, e não no meio: os
// prompts não vêm no git (são dados sensíveis, vivem só no volume persistente e
// sobem por Administração → Prompts), então um deploy pode chegar antes deles.
//
// É o que protege a janela entre o deploy e o upload dos prompts de uma versão
// nova: sem esta checagem, o aluno que reatendesse um caso naquele intervalo
// receberia um erro em vez da nota. `loadAssets` memoiza, então o custo desta
// pergunta é um acesso a disco na primeira vez.
function versaoDisponivel(version) {
  try {
    aval.loadAssets(version);
    return true;
  } catch (e) {
    console.error(`[aval-oficial] versão ${version} indisponível: ${e.message}`);
    return false;
  }
}

// --- Modos ASSÍNCRONOS (Competitivo e Processo Seletivo) -------------------
//
// Nesses dois ninguém espera a nota na tela, então os oito nós vão para a
// Batch API da OpenAI (50% de desconto). O que muda em relação ao avaliador
// antigo: era 1 requisição por sessão, agora são 8 — o `custom_id` de cada uma
// carrega o id da sessão e o número do critério (`<id>::<num>`), e quem coleta
// agrupa por sessão antes de finalizar. O sintetizador NÃO vai no lote: ele
// precisa das oito análises, então roda síncrono no coletor (a preço cheio,
// uma chamada por sessão — ver buildInstrumentacao).
//
// Quando o modelo escolhido não tem Batch API (GLM), o modo cai no caminho
// síncrono em background, que é o `avaliar()` de sempre.

// As requisições dos nós de uma sessão: [{ num, body }].
function requisicoesDosNos({ materiais, model, effort, provider, version = VERSAO }) {
  return aval.buildPipelineNodeRequests({ materiais, model, effort, provider, version });
}

// Fecha o pipeline a partir das saídas dos nós que voltaram do lote: agrega,
// roda o sintetizador e devolve o mesmo resultado do caminho síncrono.
async function finalizarDoLote({ client, provider, model, effort, version = VERSAO, materiais, nodeOutputs }) {
  return aval.finalizePipeline({
    openai: client, provider, model, effort, version,
    materiais, nodeOutputs, batch: true, evaluatorId: version,
  });
}

// --- O que o ALUNO recebe --------------------------------------------------

// Texto do feedback do aluno: saudação da versão + corpo do sintetizador.
//
// Sem a linha "Nota: X/100" que o `montarFeedback` do pipeline cola — na
// produção a nota aparece como selo na tela e no cabeçalho do .txt que o aluno
// baixa, e repeti-la no corpo do texto a mostraria duas vezes.
//
// A saudação sai da VERSÃO, e não de uma constante: o modo duelo declara a dele
// VAZIA, porque o texto de lá é comparativo e em terceira pessoa. Sem isto,
// promover uma régua nova para a produção passaria a colar a saudação da antiga
// no texto que o aluno lê — e ninguém repararia.
function textoDoAluno(result, version = VERSAO) {
  const corpo = (result && result.corpoSintetizador) || '';
  if (!corpo.trim()) return '';
  const cfg = aval.PIPELINE_VERSIONS[version];
  // `saudacao: ''` (duelo) é uma escolha, não um campo faltando — por isso o
  // teste é por `undefined` e não por valor falsy.
  const saudacao = cfg && cfg.saudacao !== undefined ? cfg.saudacao : aval.SAUDACAO;
  return saudacao ? `${saudacao}\n\n${corpo.trim()}` : corpo.trim();
}

// Notas por critério no formato do log (`criteriaScores`): { '1': 8, ... }.
// Critério sem nota (nó fora de formato) fica de fora, como sempre — a base da
// nota final acompanha (ver server/scoring.js).
function notasPorCriterio(result) {
  const out = {};
  for (const p of (result && result.partes) || []) {
    if (Number.isFinite(p.nota)) out[String(p.num)] = p.nota;
  }
  return Object.keys(out).length ? out : null;
}

// Nome de cada critério no momento da avaliação (`criteriaNames`): { '1': 'Manejo do vínculo', ... }.
// O gráfico do perfil junta sessões pelo NOME, não pelo número: quando o admin
// acrescenta ou reordena critérios, o "3" de hoje não é o "3" de ontem.
function nomesPorCriterio(result) {
  const out = {};
  for (const p of (result && result.partes) || []) {
    if (p && p.num != null && typeof p.nome === 'string' && p.nome.trim()) out[String(p.num)] = p.nome.trim();
  }
  return Object.keys(out).length ? out : null;
}

// --- Detalhe por critério (arquivo por avaliação, fora do logs.json) -------
//
// Por que arquivo próprio e não um campo no log: são oito análises por
// avaliação, o logs.json é lido e reescrito inteiro a cada sessão
// salva, e ele já cresce sem parar. Aqui cada avaliação é um arquivo escrito uma
// vez e lido só quando um supervisor abre aquele log. Mesmo desenho do .txt de
// raciocínio da Avaliação Independente.
const DETALHES_DIR = path.join(DATA_DIR, 'avaliacoes-criterios');
// Idade máxima de um detalhe que nunca foi anexado a um log. Acontece quando o
// aluno fecha a aba entre a avaliação e o salvamento: a avaliação rodou, custou,
// e não tem log a que pertencer. Sem poda esses arquivos ficariam para sempre.
const ORFAO_MS = 7 * 24 * 60 * 60 * 1000;

function detalheId() {
  return 'av-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

// Caminho de um id. A checagem de formato é o que garante que nada vindo de URL
// ou de body vire caminho — o id é sempre gerado por nós.
function caminhoDoDetalhe(id) {
  if (!/^av-[0-9]+-[0-9a-f]{8}$/.test(String(id || ''))) return null;
  return path.join(DETALHES_DIR, `${id}.json`);
}

// Grava o detalhe de uma avaliação e devolve o id. `dono` é o userId de quem foi
// avaliado: é ele que autoriza o vínculo com o log depois (ver anexar()).
function salvarDetalhe({ dono, version, model, effort, provider, categoria, result, itemId, itemTitle, batch = false, logId = null }) {
  const id = detalheId();
  const payload = {
    id,
    criadoEm: new Date().toISOString(),
    dono: dono == null ? null : String(dono),
    // Nos modos síncronos o log ainda não existe quando a avaliação termina, e o
    // vínculo é feito depois (ver anexar). Nos assíncronos o log já existe — o
    // detalhe nasce vinculado, e nunca passa pelo cliente.
    logId: logId == null ? null : String(logId),
    version: version || VERSAO,
    categoria: categoria || null,
    model: model || null,
    effort: effort || null,
    provider: provider || null,
    batch: !!batch,
    itemId: itemId == null ? null : String(itemId),
    itemTitle: itemTitle || '',
    notaFinal: result ? result.notaFinal : null,
    considerados: result ? result.considerados : null,
    // Duelo: as duas notas e o vencedor (null nos modos individuais).
    comparativo: (result && result.comparativo) || null,
    // As oito análises, cada uma com as cinco qualidades e a nota. É o material
    // de supervisor — nunca sai por rota que aluno alcance.
    partes: (result && result.partes) || [],
    // O corpo que o aluno leu, guardado junto para o supervisor comparar o que
    // foi dito ao aluno com o que os nós viram.
    corpoSintetizador: (result && result.corpoSintetizador) || '',
    missao: (result && result.missao) || null,
    instrumentacao: (result && result.instrumentacao) || null,
  };
  fs.mkdirSync(DETALHES_DIR, { recursive: true });
  const dest = caminhoDoDetalhe(id);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, dest);
  return id;
}

function lerDetalhe(id) {
  const p = caminhoDoDetalhe(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// Vincula um detalhe a um log. Devolve o detalhe quando o vínculo é legítimo e
// `null` quando não é — e as duas recusas são de segurança, não de robustez:
//
//   · dono diferente de quem está salvando → um aluno passando o id da
//     avaliação de outro para herdar a nota dele;
//   · detalhe já anexado a um log → o mesmo aluno reusando uma avaliação boa em
//     várias sessões.
//
// Quem chama trata `null` como "não há detalhe", e a nota daquele log fica sendo
// o que o caminho antigo produzir.
function anexar(id, { logId, dono }) {
  const detalhe = lerDetalhe(id);
  if (!detalhe) return null;
  if (String(detalhe.dono) !== String(dono)) return null;
  if (detalhe.logId) return null;
  detalhe.logId = String(logId);
  detalhe.anexadoEm = new Date().toISOString();
  const dest = caminhoDoDetalhe(id);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(detalhe, null, 2));
  fs.renameSync(tmp, dest);
  return detalhe;
}

// Campos que uma sessão JÁ EXISTENTE recebe de um resultado do pipeline
// (Competitivo e Seletivo, onde o log é criado antes da avaliação). Grava o
// detalhe por critério vinculado ao log e devolve o que vai no registro.
//
// `textoParaAluno: false` (Seletivo) devolve o corpo do feedback sem a saudação
// — ali quem lê é o recrutador, e o candidato nunca vê nada.
function camposDoLog({ result, logId, dono, version = VERSAO, model, effort, provider, categoria, itemId, itemTitle, batch = false, textoParaAluno = true }) {
  let evalPartsId = null;
  try {
    evalPartsId = salvarDetalhe({
      dono, version, model, effort, provider, categoria, result, itemId, itemTitle, batch, logId,
    });
  } catch (e) {
    console.error('[aval-oficial] falha ao gravar o detalhe por critério:', e.message);
  }
  return {
    score: result ? result.notaFinal : null,
    criteriaScores: notasPorCriterio(result),
    criteriaNames: nomesPorCriterio(result),
    evaluation: textoParaAluno
      ? textoDoAluno(result, version)
      : ((result && result.corpoSintetizador) || '').trim(),
    evalVersion: version,
    evalPartsId,
  };
}

// Apaga o detalhe de uma avaliação. Usado pelo reset de ranking (as notas por
// critério são nota como qualquer outra). Devolve true se apagou.
function apagarDetalhe(id) {
  const p = caminhoDoDetalhe(id);
  if (!p || !fs.existsSync(p)) return false;
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

// O detalhe como a tela do supervisor o consome. Só o que a tela usa — o
// instrumentacao (custo) e o dono ficam fora.
function detalheParaSupervisor(detalhe) {
  if (!detalhe) return null;
  return {
    id: detalhe.id,
    criadoEm: detalhe.criadoEm,
    version: detalhe.version,
    categoria: detalhe.categoria || null,
    model: detalhe.model || null,
    effort: detalhe.effort || null,
    batch: !!detalhe.batch,
    notaFinal: detalhe.notaFinal,
    partes: (detalhe.partes || []).map((p) => ({
      num: p.num,
      nome: p.nome,
      linhaCurta: p.linhaCurta,
      // Individual: `nota` + `qualidades` com as cinco. Duelo: `notas` e
      // `qualidades` indexados pela letra do aluno. A tela desenha os dois.
      nota: p.nota != null ? p.nota : null,
      notas: p.notas || null,
      qualidades: p.qualidades || null,
      qualidadesFaltantes: p.qualidadesFaltantes || null,
      incluido: p.incluido == null ? false : p.incluido,
      analise: p.analise || '',
    })),
    // Duelo: as duas notas e o vencedor.
    comparativo: detalhe.comparativo || null,
    missao: detalhe.missao || null,
  };
}

// Papéis que podem ver nota e feedback POR CRITÉRIO. Aluno interno, aluno
// externo e visitante veem nota total + feedback qualitativo, e nada além.
function podeVerCriterios(role) {
  return role === 'supervisor' || role === 'admin';
}

// Apaga os detalhes órfãos (avaliação que rodou e cujo log nunca foi salvo).
// Devolve quantos saíram. Best-effort: chamado nos sweeps, nunca lança.
function podarOrfaos(agora = Date.now()) {
  let apagados = 0;
  try {
    if (!fs.existsSync(DETALHES_DIR)) return 0;
    for (const nome of fs.readdirSync(DETALHES_DIR)) {
      if (!nome.endsWith('.json')) continue;
      const full = path.join(DETALHES_DIR, nome);
      try {
        const d = JSON.parse(fs.readFileSync(full, 'utf-8'));
        if (d && d.logId) continue; // já pertence a um log
        const t = Date.parse((d && d.criadoEm) || '');
        if (Number.isFinite(t) && agora - t < ORFAO_MS) continue;
        fs.unlinkSync(full);
        apagados++;
      } catch {
        // Arquivo ilegível (escrita interrompida): sai pela idade do arquivo.
        try {
          if (agora - fs.statSync(full).mtimeMs > ORFAO_MS) { fs.unlinkSync(full); apagados++; }
        } catch {}
      }
    }
  } catch {}
  return apagados;
}

module.exports = {
  VERSAO,
  VERSAO_DUELO,
  materiaisDuelo,
  requisicoesDosNos,
  finalizarDoLote,
  camposDoLog,
  VERSAO_PROGRESSAO,
  CATEGORIAS_OFICIAIS,
  categoriaUsaPipeline,
  versaoDisponivel,
  materiaisPadrao,
  materiaisProgressao,
  avaliar,
  textoDoAluno,
  notasPorCriterio,
  nomesPorCriterio,
  DETALHES_DIR,
  salvarDetalhe,
  lerDetalhe,
  anexar,
  apagarDetalhe,
  detalheParaSupervisor,
  podeVerCriterios,
  podarOrfaos,
};
