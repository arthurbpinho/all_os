// AVALIADOR OFICIAL DA PRODUÇÃO — pipeline v29 (AvaliAllos).
//
// Desde 2026-09 este é o avaliador de TODOS os modos de sessão individual:
// Treinamento (com e sem progressão), Competitivo, Visitante, Processo Seletivo
// e a correção manual do supervisor. Ele substituiu a família de prompt único
// `avaliacao/avaliador 18/*`, que continua no volume porque três caminhos ainda
// a usam de propósito:
//
//   · DUELO — a avaliação é COMPARATIVA (um texto, notas A1..A15/B1..B15) e o
//     v29 é individual. Decisão do dono: fica no comparativo v18.25 até existir
//     um prompt comparativo na régua nova.
//   · NEUROAVALIAÇÃO — tem grade própria (4 critérios) e é o único modo em que o
//     gabarito diagnóstico pode ir ao aluno. Em stand-by, por decisão do dono.
//   · TRILHA — o avaliador é escolhido POR EXERCÍCIO pelo admin, e a nota é uma
//     porcentagem de domínio. Nada aqui a alcança.
//
// O QUE MUDA PARA QUEM LÊ O CÓDIGO ANTIGO
//
// O avaliador antigo era UMA chamada que devolvia um texto com tudo dentro:
// `[notas]` no começo (que o servidor extraía e escondia do aluno) e a prosa
// depois. O v29 são dezesseis chamadas e o resultado é ESTRUTURADO: quinze
// análises com nota, faixa e travas por critério, mais um corpo de feedback
// escrito por um sintetizador que nunca viu o Bloco 1.
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
const VERSAO = 'v29';
// Modo progressão (reatendimento, sidequest e missão diária) — mesma régua e
// mesmos critérios, entrada diferente. Ver PIPELINE_VERSIONS em avaliacao-v25.js.
const VERSAO_PROGRESSAO = 'v29-progressao';

// Categorias de Administração → Modelos de IA que rodam o pipeline oficial. As
// que ficam fora (duelo, neuro) estão listadas no cabeçalho, com o motivo.
const CATEGORIAS_OFICIAIS = new Set(['treinamento', 'competitivo', 'seletivo', 'visitante', 'avaliacaoManual']);
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

// --- Execução --------------------------------------------------------------

// Roda o pipeline oficial e devolve o resultado do avaliacao-v25.js
// (notaFinal, partes, corpoSintetizador, instrumentacao, missao...).
//
// `capturarReasoning: false` fixo: em produção seriam quinze resumos de
// raciocínio por sessão avaliada, que ninguém lê, e ligá-los troca o transporte
// das chamadas sem mudar nada do que o aluno ou o supervisor recebem. O
// laboratório da Avaliação Independente é onde se lê raciocínio.
async function avaliar({ client, provider, model, effort, materiais, version = VERSAO, onProgress }) {
  return aval.runAvaliacaoIndependente({
    openai: client, provider, model, effort, materiais, version,
    variant: null, evaluatorId: version, capturarReasoning: false, onProgress,
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
// Nesses dois ninguém espera a nota na tela, então os quinze nós vão para a
// Batch API da OpenAI (50% de desconto). O que muda em relação ao avaliador
// antigo: eram 1 requisição por sessão, agora são 15 — o `custom_id` de cada uma
// carrega o id da sessão e o número do critério (`<id>::<num>`), e quem coleta
// agrupa por sessão antes de finalizar. O sintetizador NÃO vai no lote: ele
// precisa das quinze análises, então roda síncrono no coletor (a preço cheio,
// uma chamada por sessão — ver buildInstrumentacao).
//
// Quando o modelo escolhido não tem Batch API (GLM), o modo cai no caminho
// síncrono em background, que é o `avaliar()` de sempre.

// As requisições dos nós de uma sessão: [{ num, body }].
function requisicoesDosNos({ materiais, model, effort, provider, version = VERSAO }) {
  return aval.buildPipelineNodeRequests({ materiais, model, effort, provider, version, variant: null });
}

// Fecha o pipeline a partir das saídas dos nós que voltaram do lote: agrega,
// roda o sintetizador e devolve o mesmo resultado do caminho síncrono.
async function finalizarDoLote({ client, provider, model, effort, version = VERSAO, materiais, nodeOutputs }) {
  return aval.finalizePipeline({
    openai: client, provider, model, effort, version, variant: null,
    materiais, log: materiais['{{LOG}}'], nodeOutputs, batch: true, evaluatorId: version,
  });
}

// --- O que o ALUNO recebe --------------------------------------------------

// Texto do feedback do aluno: saudação da versão + corpo do sintetizador.
//
// Sem a linha "Nota: X/100" que o `montarFeedback` do pipeline cola — na
// produção a nota aparece como selo na tela e no cabeçalho do .txt que o aluno
// baixa, e repeti-la no corpo do texto a mostraria duas vezes.
//
// `version` não é mais lido aqui (a saudação virou uma só), mas continua na
// assinatura: os callers a passam, e é ela que diz de qual régua é este texto se
// um dia houver mais de uma outra vez.
function textoDoAluno(result, version = VERSAO) {
  const corpo = (result && result.corpoSintetizador) || '';
  if (!corpo.trim()) return '';
  return `${aval.SAUDACAO}\n\n${corpo.trim()}`;
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

// --- Detalhe por critério (arquivo por avaliação, fora do logs.json) -------
//
// Por que arquivo próprio e não um campo no log: são quinze análises por
// avaliação (~10 KB), o logs.json é lido e reescrito inteiro a cada sessão
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
    // As quinze análises com nota, faixa, travas e etiqueta. É o material de
    // supervisor — nunca sai por rota que aluno alcance.
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
    evaluation: textoParaAluno
      ? textoDoAluno(result, version)
      : ((result && result.corpoSintetizador) || '').trim(),
    evalVersion: version,
    evalPartsId,
  };
}

// Apaga o detalhe de uma avaliação. Usado pelo reset de ranking (as quinze
// notas por critério são nota como qualquer outra). Devolve true se apagou.
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
      nota: p.nota,
      faixa: p.faixa != null ? p.faixa : null,
      realizacao: p.realizacao || null,
      etiqueta: p.etiqueta || null,
      travas: p.travas || null,
      travasInconsistentes: !!p.travasInconsistentes,
      incluido: !!p.incluido,
      analise: p.analise || '',
    })),
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
  DETALHES_DIR,
  salvarDetalhe,
  lerDetalhe,
  anexar,
  apagarDetalhe,
  detalheParaSupervisor,
  podeVerCriterios,
  podarOrfaos,
};
