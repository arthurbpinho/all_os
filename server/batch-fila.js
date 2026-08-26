// Fila local na frente da Batch API da OpenAI — a lógica pura, sem I/O.
//
// O TETO QUE ISTO EXISTE PARA RESPEITAR
//
// A OpenAI limita, por (organização, modelo), quantos tokens podem estar
// ENFILEIRADOS ao mesmo tempo em batches — o "enqueued token limit". Não é o
// TPM (aquele é por minuto e tem limitador próprio em avaliacao-v25.js): é um
// contador de OCUPAÇÃO, que só baixa quando um batch termina.
//
// O que conta como enfileirado é o TETO de cada requisição, não o que ela vai
// gastar: input + max_completion_tokens. Uma run do pipeline (15 nós, teto de
// 16k cada) reserva ~583 mil tokens — medido, não estimado no chute. Com o teto
// de 2.000.000 do gpt-5.6-luna nesta organização, cabem 3,4 runs ao mesmo tempo.
// Foi exatamente o que aconteceu em 26/08/2026: seis runs disparadas em 25
// segundos, três entraram e três morreram com `token_limit_exceeded`.
//
// COMO A OPENAI RECUSA
//
// Não é um erro na chamada: `batches.create` responde 200 e o batch nasce. A
// recusa vem depois, na validação — o batch vira `failed` e o motivo aparece em
// `errors.data[]`. Por isso quem descobre é o coletor, não quem submete, e por
// isso o coletor precisa saber devolver o trabalho para a fila em vez de
// enterrá-lo (que era o comportamento antigo: `status = 'erro'`, e o aluno
// ficava sem nota por um teto que se resolve esperando).
//
// A REGRA DESTE MÓDULO
//
//   fila cheia (token_limit_exceeded) → ESPERA. Não conta tentativa, não
//     desiste nunca. É o caso em que esperar é a solução, e a promessa ao aluno
//     ("sua nota sai em até 24h") é o que autoriza esperar.
//   outra falha transitória (rate limit, erro do provedor) → RETENTA, contando
//     tentativa, até MAX_TENTATIVAS.
//   qualquer outra coisa → ERRO de verdade, com a mensagem da OpenAI junto.
//
// Só funções puras aqui: quem lê e grava arquivo é o index.js. É o que permite
// testar a régua da fila sem rede e sem volume.

// Tetos conhecidos de tokens enfileirados, por prefixo de modelo. A OpenAI não
// expõe isso por API — o único jeito de saber é ler a mensagem de recusa, e é
// o que aprenderLimite() faz em runtime. Esta tabela é só o palpite inicial,
// deliberadamente conservador: errar para baixo atrasa um batch, errar para
// cima o mata.
const TETOS_CONHECIDOS = {
  // Medido no erro real (ago/2026, org da escola).
  'gpt-5.6-luna': 2000000,
};
// Palpite para modelo fora da tabela. Vale até a primeira recusa ensinar o
// número certo.
const TETO_PADRAO = Number(process.env.BATCH_TETO_ENFILEIRADO || 2000000);
// Fração do teto que a fila se permite ocupar. Não é 1: entre decidir que cabe
// e o batch ser validado, outro modo (Competitivo, Trilha, Seletivo) pode ter
// submetido o seu, e a estimativa de input é aproximada.
const FATOR_SEGURANCA = Number(process.env.BATCH_FATOR_SEGURANCA || 0.85);
// Teto de tentativas para falha transitória que NÃO é fila cheia.
const MAX_TENTATIVAS = Number(process.env.BATCH_MAX_TENTATIVAS || 8);

// Tetos aprendidos com as recusas desta execução. Memória de processo: um
// restart esquece e reaprende no primeiro erro, que custa um ciclo de coleta.
const _tetosAprendidos = new Map();

// Códigos de falha de batch que são estado passageiro do provedor, não defeito
// do nosso payload.
const CODIGOS_TRANSITORIOS = new Set([
  'token_limit_exceeded',   // fila cheia — o caso desta fila existir
  'rate_limit_exceeded',
  'server_error',
  'internal_error',
]);

// Mensagem legível de um batch que falhou. A Batch API põe só `failed` no
// status; o porquê mora em `errors.data[]`.
function mensagemDeErro(batchObj) {
  const data = batchObj && batchObj.errors && batchObj.errors.data;
  if (!Array.isArray(data) || !data.length) return '';
  const msg = data.map((e) => (e && (e.message || e.code)) || '').filter(Boolean).join(' | ');
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

// Códigos presentes em errors.data[].
function codigosDeErro(batchObj) {
  const data = (batchObj && batchObj.errors && batchObj.errors.data) || [];
  return data.map((e) => (e && e.code) || '').filter(Boolean);
}

// "Limit: 2,000,000 enqueued tokens" → 2000000. É assim que descobrimos o teto
// de um modelo: pela recusa. Aceita o separador de milhar da mensagem.
function extrairTetoDaMensagem(msg) {
  const m = /Limit:\s*([\d.,]+)\s*enqueued tokens/i.exec(String(msg || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/[.,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Classifica o desfecho de um batch não-completo. `acao`:
//   'espera'  → fila cheia: volta pro fim da fila sem contar tentativa.
//   'retenta' → transitório: volta contando tentativa.
//   'erro'    → definitivo: vira erro com a mensagem.
// `cancelled` é decisão humana e nunca volta sozinho.
function classificarFalha(batchObj, tentativas = 0) {
  const status = (batchObj && batchObj.status) || 'failed';
  const motivo = mensagemDeErro(batchObj);
  const codigos = codigosDeErro(batchObj);
  const teto = extrairTetoDaMensagem(motivo);

  if (status === 'cancelled' || status === 'cancelling') {
    return { acao: 'erro', motivo: motivo || 'batch cancelado', teto: null };
  }
  // Expirado é a janela de 24h estourada com o batch ainda rodando: o trabalho
  // não deu errado, faltou tempo. Volta para a fila.
  if (status === 'expired') {
    return { acao: 'retenta', motivo: motivo || 'batch expirou (janela de 24h)', teto: null, expirou: true };
  }
  if (codigos.includes('token_limit_exceeded')) {
    return { acao: 'espera', motivo: motivo || 'fila de tokens da OpenAI cheia', teto };
  }
  if (codigos.some((c) => CODIGOS_TRANSITORIOS.has(c))) {
    if (tentativas + 1 >= MAX_TENTATIVAS) {
      return { acao: 'erro', motivo: `${motivo} (desistiu após ${tentativas + 1} tentativas)`, teto };
    }
    return { acao: 'retenta', motivo, teto };
  }
  return { acao: 'erro', motivo: motivo || `batch ${status}`, teto };
}

// Guarda o teto que a recusa revelou, para as próximas decisões de vaga.
function aprenderTeto(model, teto) {
  if (!model || !Number.isFinite(teto) || teto <= 0) return false;
  const chave = String(model);
  if (_tetosAprendidos.get(chave) === teto) return false;
  _tetosAprendidos.set(chave, teto);
  return true;
}

// Teto de tokens enfileirados de um modelo: o aprendido vence a tabela, que
// vence o padrão. Casa por prefixo mais longo (como a tabela de preços).
function tetoDoModelo(model) {
  const m = String(model || '').toLowerCase();
  for (const [k, v] of _tetosAprendidos) {
    if (m.startsWith(String(k).toLowerCase())) return v;
  }
  const prefixos = Object.keys(TETOS_CONHECIDOS).sort((a, b) => b.length - a.length);
  for (const p of prefixos) if (m.startsWith(p)) return TETOS_CONHECIDOS[p];
  return TETO_PADRAO;
}

// Tokens que uma requisição RESERVA na fila: o input mais o teto de saída. É a
// conta que a OpenAI faz, e é por isso que um max_completion_tokens folgado
// (64k na Trilha, 16k no pipeline) pesa mesmo quando o modelo gera 800 tokens.
// `estimarTokens` entra por parâmetro para o módulo não depender do avaliador.
function tokensDaRequisicao(body, estimarTokens) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const texto = msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))) .join('\n');
  const teto = Number(body && (body.max_completion_tokens || body.max_tokens)) || 0;
  return estimarTokens(texto) + teto;
}

// Quanto ainda cabe para este modelo, dado o que já está em voo.
function espacoLivre(model, tokensEmVoo) {
  return Math.max(0, Math.floor(tetoDoModelo(model) * FATOR_SEGURANCA) - (Number(tokensEmVoo) || 0));
}

// Cabe um lote de `tokens` agora?
function temVaga({ model, tokens, tokensEmVoo }) {
  return (Number(tokens) || 0) <= espacoLivre(model, tokensEmVoo);
}

// Divide os itens pendentes em LOTES que cabem no espaço livre, na ordem em que
// vieram (quem chegou antes vai antes). Devolve só os lotes que cabem AGORA; o
// resto fica para o próximo ciclo — é a fila fazendo o seu trabalho.
//
// Um item maior que o espaço livre inteiro não é descartado: se ele sozinho cabe
// no teto do modelo, espera esvaziar; se não cabe nem no teto, vai sozinho num
// lote e a OpenAI que recuse (aí a recusa vira erro visível, em vez de um item
// preso para sempre numa fila que nunca terá espaço).
function dividirEmLotes({ itens, model, tokensEmVoo, maxItensPorLote = 0 }) {
  const livre = espacoLivre(model, tokensEmVoo);
  const tetoTotal = Math.floor(tetoDoModelo(model) * FATOR_SEGURANCA);
  const lotes = [];
  let atual = [];
  let soma = 0;
  let orcamento = livre;

  for (const item of itens) {
    const t = Number(item.tokens) || 0;
    if (t > tetoTotal) {
      // Não cabe nem sozinho: manda isolado para a recusa ser explícita.
      if (atual.length) { lotes.push(atual); orcamento -= soma; atual = []; soma = 0; }
      if (orcamento > 0) { lotes.push([item]); orcamento = 0; }
      continue;
    }
    const estouraLote = soma + t > orcamento;
    const estouraItens = maxItensPorLote > 0 && atual.length >= maxItensPorLote;
    if (atual.length && (estouraLote || estouraItens)) {
      lotes.push(atual);
      orcamento -= soma;
      atual = [];
      soma = 0;
    }
    if (t > orcamento) break; // não cabe mais nada neste ciclo
    atual.push(item);
    soma += t;
  }
  if (atual.length) lotes.push(atual);
  return lotes;
}

// Entradas do ledger que já podem sair: batch em estado terminal, ou velho
// demais para ainda estar ocupando fila (a janela do batch é de 24h).
function ledgerExpirado(entrada, agora = Date.now()) {
  const t = Date.parse((entrada && entrada.criadoEm) || '');
  if (!Number.isFinite(t)) return true;
  return agora - t > 26 * 60 * 60 * 1000;
}

// Soma dos tokens em voo de um modelo, a partir das entradas do ledger.
function tokensEmVooDe(ledger, model, agora = Date.now()) {
  const m = String(model || '').toLowerCase();
  return (Array.isArray(ledger) ? ledger : [])
    .filter((e) => e && String(e.model || '').toLowerCase() === m && !ledgerExpirado(e, agora))
    .reduce((s, e) => s + (Number(e.tokens) || 0), 0);
}

module.exports = {
  MAX_TENTATIVAS,
  FATOR_SEGURANCA,
  mensagemDeErro,
  codigosDeErro,
  extrairTetoDaMensagem,
  classificarFalha,
  aprenderTeto,
  tetoDoModelo,
  tokensDaRequisicao,
  espacoLivre,
  temVaga,
  dividirEmLotes,
  ledgerExpirado,
  tokensEmVooDe,
  // exportado para teste: zera os tetos aprendidos entre casos.
  _resetTetos: () => _tetosAprendidos.clear(),
};
