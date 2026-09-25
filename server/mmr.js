// Motor do MMR (rating competitivo) e da TRI (dificuldade dos casos) do simulador
// clínico, POR CRITÉRIO. Reescrito para a spec de MMR-por-criterio.md
// (demandas.md §24). Todas as funções aqui são PURAS: recebem e devolvem estado,
// sem I/O.
//
// Grandezas (spec §2):
//   P_c    — MMR do aluno no critério c
//   D_c    — dificuldade do caso no critério c (TRI, único e compartilhado entre
//            populações: competitivo, seletivo e visitante)
//   N_c    — nota ponderada da avaliação, fora do circuito P↔D: N_c = S_c + (D_c − 50)
//
// Escala INTERNA 0..100 (0..10 da rubrica × 10). O motor sempre trabalha em
// 0..100 e não sabe converter para exibição — quem exibe divide por 10.
//
// Formato do estado (JSONB gravado em mmr_players/mmr_characters/mmr_anon_players):
//
//   mmr_players.estado = {
//     nEntradas: N,                                 // avaliações que entraram
//     criterios: {
//       [criterioId]: {
//         P: 62.3,                                  // MMR atual do critério (0..100)
//         n: 8,                                     // avaliações desse critério
//         janela: [                                 // 10 mais recentes (§3.7)
//           { N: 71, D_antes: 55, P_antes: 60 },
//           ...
//         ]
//       },
//       ...
//     }
//   }
//
//   mmr_characters.estado = {
//     criterios: {
//       [criterioId]: {
//         D: 63.1,                                  // dificuldade atual (10..90)
//         n_D: 12,                                  // movimentos do D nesse critério
//         beta: 1.0,                                // inclinação da regressão (0,5..1,5)
//         historico: [                              // 200 pontos (§4)
//           { P: 60, D_antes: 61, S: 72 },
//           ...
//         ]
//       },
//       ...
//     }
//   }
//
//   mmr_characters.fontes = {
//     [criterioId]: { competitivo: 5, selecao: 2, visitante: 0 }
//   }
//
//   mmr_anon_players.estado = mesmo shape de mmr_players.estado.
//
// Fica de fora explicitamente (spec §13): S_aj (fórmula 50 + (S − S_esp)),
// inclinação genérica 0,5, intercepto livre da regressão, dWeight do seletivo/
// visitante, e o bloqueio do D durante a calibração. O motor antigo vivia
// disso; nada disso é reintroduzido.

'use strict';

// Constantes
const P0 = 50;                    // MMR inicial por critério
const D0 = 50;                    // D inicial por critério
const D_MIN = 10;
const D_MAX = 90;
const WINDOW = 10;                // janela de partidas recentes por critério (spec §3.6)
const CALIBRATION_MATCHES = 3;    // calibração continua sendo 3 avaliações (spec §6)
const CHAR_MATURE_AT = 20;        // n_D para a regressão do critério começar (spec §4)
const REGRESS_REFIT_EVERY = 5;    // reajusta β a cada 5 movimentos (spec §4)
const HISTORY_CAP = 200;          // teto do histórico por caso × critério (spec §4)
const SIMPLE_MEAN_UNTIL = 4;      // as 4 primeiras avaliações do critério = média simples
const K_MIN = 0.20;               // piso da sensibilidade (spec §3.5)
const BETA_MIN = 0.5;
const BETA_MAX = 1.5;
const BETA_DEFAULT = 1;
const GAIN_IMATURE = 0.2;         // ganho do D antes de amadurecer (n_D < 20)
const GAIN_MATURE = 0.1;          // ganho do D depois de maduro
const TOTAL_MIN_TO_MOVE_D = 25;   // nota total bruta < 25 não move o D (spec §3.1)
const PVP_STAKE = 0.20;           // 20% do MMR de cada critério por lado
const PVP_MIN_SCORE = 25;         // duelo: nota total bruta mínima em ambos os lados
const FONTES_VALIDAS = new Set(['competitivo', 'selecao', 'visitante']);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// -----------------------------------------------------------------------------
// Fábricas de estado
// -----------------------------------------------------------------------------

function newPlayer() {
  return { nEntradas: 0, criterios: {} };
}

function newCharacter() {
  return { criterios: {} };
}

function newAnonPopulation() {
  return newPlayer();
}

function newPlayerCriterio() {
  return { P: P0, n: 0, janela: [] };
}

function newCharCriterio() {
  return { D: D0, n_D: 0, beta: BETA_DEFAULT, historico: [] };
}

// Clona superficialmente + normaliza os campos do estado. Evita mutar a entrada.
function clonePlayer(state) {
  const s = state || {};
  const out = { nEntradas: Number(s.nEntradas) || 0, criterios: {} };
  const src = s.criterios || {};
  for (const id of Object.keys(src)) {
    const c = src[id] || {};
    out.criterios[id] = {
      P: isNum(c.P) ? c.P : P0,
      n: Number(c.n) || 0,
      janela: Array.isArray(c.janela) ? c.janela.map((e) => ({ ...e })) : [],
    };
  }
  return out;
}

function cloneCharacter(state) {
  const s = state || {};
  const out = { criterios: {} };
  const src = s.criterios || {};
  for (const id of Object.keys(src)) {
    const c = src[id] || {};
    out.criterios[id] = {
      D: isNum(c.D) ? c.D : D0,
      n_D: Number(c.n_D) || 0,
      beta: isNum(c.beta) ? c.beta : BETA_DEFAULT,
      historico: Array.isArray(c.historico) ? c.historico.map((e) => ({ ...e })) : [],
    };
  }
  return out;
}

function cloneFontes(fontes) {
  const src = fontes || {};
  const out = {};
  for (const id of Object.keys(src)) {
    const f = src[id] || {};
    out[id] = { competitivo: Number(f.competitivo) || 0, selecao: Number(f.selecao) || 0, visitante: Number(f.visitante) || 0 };
  }
  return out;
}

// Garante a linha do critério dentro do estado, se ainda não existir.
function ensurePlayerCrit(state, id) {
  if (!state.criterios[id]) state.criterios[id] = newPlayerCriterio();
  return state.criterios[id];
}
function ensureCharCrit(state, id) {
  if (!state.criterios[id]) state.criterios[id] = newCharCriterio();
  return state.criterios[id];
}
function ensureFonte(fontes, id) {
  if (!fontes[id]) fontes[id] = { competitivo: 0, selecao: 0, visitante: 0 };
  return fontes[id];
}

// -----------------------------------------------------------------------------
// Sub-cálculos por critério
// -----------------------------------------------------------------------------

// Nota esperada (spec §3.2): usada só para ajustar o D. Precede a atualização.
function expectedScore(playerCrit, charCrit) {
  const beta = isNum(charCrit.beta) ? charCrit.beta : BETA_DEFAULT;
  return 50 + beta * (playerCrit.P - charCrit.D);
}

// Nota ponderada (spec §3.4): sem teto, sem piso. Fora do circuito P↔D.
function weightedScore(S, D) { return S + (D - 50); }

// Sensibilidade K (spec §3.5). Com este K, nas 4 primeiras avaliações do
// critério a atualização em EMA vira média simples: K = 1/(n+1).
function sensitivity(n) { return Math.max(1 / (n + 1), K_MIN); }

// Pesos lineares crescentes: mais recente (fim do array) pesa mais.
function linearWeights(size) {
  if (size <= 0) return [];
  const denom = (size * (size + 1)) / 2;
  const w = new Array(size);
  for (let i = 0; i < size; i++) w[i] = (i + 1) / denom;
  return w;
}

// Regressão do caso por critério (spec §4). Só ajusta β; intercepto fixo em 50.
function fitRegression(historico) {
  const pts = (historico || []).filter((h) => isNum(h.P) && isNum(h.D_antes) && isNum(h.S));
  if (pts.length < 2) return null;
  let sxx = 0, sxy = 0;
  for (const h of pts) {
    const gap = h.P - h.D_antes;
    sxx += gap * gap;
    sxy += gap * (h.S - 50);
  }
  if (sxx < 1e-9) return null;
  const beta = clamp(sxy / sxx, BETA_MIN, BETA_MAX);
  return { beta };
}

// -----------------------------------------------------------------------------
// updateMatch — pipeline de UMA avaliação
// -----------------------------------------------------------------------------
//
// Argumentos:
//   playerIn     — estado do aluno (ou população anônima); undefined vira newPlayer()
//   charIn       — estado do caso; undefined vira newCharacter()
//   fontesIn     — contagens por origem no caso (JSONB paralelo); undefined vira {}
//   opts:
//     criterios    — { [criterioId]: S_interno_0_100 }  (mandatório)
//     notaTotal    — Number 0..100 (nota total bruta desta avaliação, usada só
//                    para saber se está abaixo de 25 — trava do D)
//     isAdmin      — true zera o efeito da avaliação (spec §3.1)
//     fonte        — 'competitivo' | 'selecao' | 'visitante' (para as contagens)
//
// Devolve { player, character, fontes, result } com estados NOVOS.
// result inclui, por critério: S, S_esp, N_c, K, P_before/P_after, D_before/D_after.
function updateMatch(playerIn, charIn, fontesIn, opts) {
  const criterios = (opts && opts.criterios) || {};
  const isAdmin = !!(opts && opts.isAdmin);
  const notaTotal = opts && Number.isFinite(Number(opts.notaTotal)) ? Number(opts.notaTotal) : null;
  const fonte = opts && FONTES_VALIDAS.has(opts.fonte) ? opts.fonte : null;
  const bloqueiaD = isAdmin || (notaTotal !== null && notaTotal < TOTAL_MIN_TO_MOVE_D);

  const player = clonePlayer(playerIn);
  const character = cloneCharacter(charIn);
  const fontes = cloneFontes(fontesIn);

  const result = { criterios: {}, movimentou: false };
  // Se for admin, nada muda — devolvemos os clones intactos e o result vazio.
  if (isAdmin) return { player, character, fontes, result };

  const ids = Object.keys(criterios).filter((id) => isNum(Number(criterios[id])));
  for (const id of ids) {
    const S = clamp(Number(criterios[id]), 0, 100);
    const pc = ensurePlayerCrit(player, id);
    const cc = ensureCharCrit(character, id);
    const P_before = pc.P;
    const D_before = cc.D;
    const n_before = pc.n;
    const nD_before = cc.n_D;

    const S_esp = expectedScore(pc, cc);
    const N_c = weightedScore(S, D_before);
    const K = sensitivity(n_before);

    // Ajuste do D (só se a trava de 25 não bloqueou)
    if (!bloqueiaD) {
      const g = nD_before < CHAR_MATURE_AT ? GAIN_IMATURE : GAIN_MATURE;
      cc.D = clamp(cc.D + g * (S_esp - S), D_MIN, D_MAX);
      cc.historico.push({ P: P_before, D_antes: D_before, S });
      if (cc.historico.length > HISTORY_CAP) cc.historico.shift();
      cc.n_D += 1;
      if (cc.n_D >= CHAR_MATURE_AT && cc.n_D % REGRESS_REFIT_EVERY === 0) {
        const fit = fitRegression(cc.historico);
        if (fit) cc.beta = fit.beta;
      }
      if (fonte) ensureFonte(fontes, id)[fonte] += 1;
    }

    // Atualização do MMR do aluno
    if (n_before < SIMPLE_MEAN_UNTIL || pc.janela.length === 0) {
      // Média simples via EMA: com K=1/(n+1), P vira exatamente a média das N_c
      // vistas até aqui (spec §3.6). A inicial P0=50 desaparece na 1ª avaliação
      // (K=1).
      pc.P = (1 - K) * pc.P + K * N_c;
    } else {
      const w = linearWeights(pc.janela.length);
      let P_janela = 0;
      for (let i = 0; i < pc.janela.length; i++) P_janela += w[i] * pc.janela[i].N;
      pc.P = (1 - K) * P_janela + K * N_c;
    }
    pc.janela.push({ N: N_c, D_antes: D_before, P_antes: P_before });
    if (pc.janela.length > WINDOW) pc.janela.shift();
    pc.n = n_before + 1;

    result.criterios[id] = {
      S, S_esp, N: N_c, K,
      P_before, P_after: pc.P, delta: pc.P - P_before,
      D_before, D_after: cc.D,
      D_moved: !bloqueiaD,
      n: pc.n,
    };
    result.movimentou = true;
  }

  if (result.movimentou) player.nEntradas = (Number(player.nEntradas) || 0) + 1;
  result.calibratingBefore = (Number(playerIn && playerIn.nEntradas) || 0) < CALIBRATION_MATCHES;
  result.calibrating = player.nEntradas < CALIBRATION_MATCHES;
  result.matchesRemaining = Math.max(0, CALIBRATION_MATCHES - player.nEntradas);

  return { player, character, fontes, result };
}

// -----------------------------------------------------------------------------
// processDuel — duelo por critério (spec §7)
// -----------------------------------------------------------------------------
//
// opts:
//   criteriosA / criteriosB — { [id]: S 0..100 } de cada lado (mesmo caso)
//   notaTotalA / notaTotalB — nota total bruta de cada lado (para a trava de 25 + PVP_MIN_SCORE)
//   isAdminA / isAdminB — trava de admin
//
// Se qualquer trava disparar (calibração, nota mínima, admin), devolve
// { ranked: false, reason, ... } SEM movimentar nada.
function processDuel(playerAIn, playerBIn, charIn, fontesIn, opts) {
  const pAin = clonePlayer(playerAIn);
  const pBin = clonePlayer(playerBIn);
  const critA = (opts && opts.criteriosA) || {};
  const critB = (opts && opts.criteriosB) || {};
  const nA = Number(opts && opts.notaTotalA);
  const nB = Number(opts && opts.notaTotalB);
  const isAdminA = !!(opts && opts.isAdminA);
  const isAdminB = !!(opts && opts.isAdminB);
  const belowMinA = Number.isFinite(nA) && nA < PVP_MIN_SCORE;
  const belowMinB = Number.isFinite(nB) && nB < PVP_MIN_SCORE;
  const calibA = pAin.nEntradas < CALIBRATION_MATCHES;
  const calibB = pBin.nEntradas < CALIBRATION_MATCHES;

  let reason = null;
  if (isAdminA || isAdminB) reason = 'admin';
  else if (calibA || calibB) reason = 'calibrating';
  else if (belowMinA || belowMinB) reason = 'anti_smurf';
  if (reason) return { ranked: false, reason, notaTotalA: nA, notaTotalB: nB };

  // Deltas PvP por critério, com os MMRs de ANTES (spec §7 "A conta, por critério").
  const idsDuelo = new Set([...Object.keys(critA), ...Object.keys(critB)]);
  const pvp = {};
  for (const id of idsDuelo) {
    const S_A = Number.isFinite(Number(critA[id])) ? clamp(Number(critA[id]), 0, 100) : null;
    const S_B = Number.isFinite(Number(critB[id])) ? clamp(Number(critB[id]), 0, 100) : null;
    if (S_A === null || S_B === null) continue; // critério ausente num dos lados: pula
    const P_A = (pAin.criterios[id] && isNum(pAin.criterios[id].P)) ? pAin.criterios[id].P : P0;
    const P_B = (pBin.criterios[id] && isNum(pBin.criterios[id].P)) ? pBin.criterios[id].P : P0;
    const apostaA = PVP_STAKE * P_A;
    const apostaB = PVP_STAKE * P_B;
    const pool = apostaA + apostaB;
    let fracA, fracB;
    if (S_A === 0 && S_B === 0) { fracA = 0.5; fracB = 0.5; }
    else { fracA = S_A / (S_A + S_B); fracB = S_B / (S_A + S_B); }
    const recebidoA = fracA * pool;
    const recebidoB = fracB * pool;
    const winner = S_A > S_B ? 'A' : (S_B > S_A ? 'B' : 'draw');
    pvp[id] = { apostaA, apostaB, pool, fracA, fracB, recebidoA, recebidoB,
                deltaA: recebidoA - apostaA, deltaB: recebidoB - apostaB, winner, S_A, S_B };
  }

  // Aplica as duas avaliações em sequência (spec §7 "Ordem"): A, depois B, com
  // o D encadeado (o D do caso se move como se fossem duas avaliações seguidas).
  const upA = updateMatch(pAin, charIn, fontesIn, { criterios: critA, notaTotal: nA });
  const upB = updateMatch(pBin, upA.character, upA.fontes, { criterios: critB, notaTotal: nB });
  const playerA = upA.player;
  const playerB = upB.player;
  const character = upB.character;
  const fontes = upB.fontes;

  // Aplica o delta PvP por cima do MMR de cada critério dos dois lados.
  for (const id of Object.keys(pvp)) {
    if (playerA.criterios[id]) playerA.criterios[id].P += pvp[id].deltaA;
    if (playerB.criterios[id]) playerB.criterios[id].P += pvp[id].deltaB;
  }

  return {
    ranked: true, reason: null, notaTotalA: nA, notaTotalB: nB,
    pvp,
    playerA, playerB, character, fontes,
    resultA: upA.result, resultB: upB.result,
  };
}

// -----------------------------------------------------------------------------
// Totais derivados (spec §5)
// -----------------------------------------------------------------------------
//
// A agregação é a MESMA de server/scoring.js (linear): soma dos valores por
// critério / (N × valorMax) × 100. Aqui os valores por critério vêm em 0..100
// (escala interna); o resultado é 0..100 também.

function agregarTotal(porCriterio, criterioIds) {
  const src = porCriterio || {};
  const ids = Array.isArray(criterioIds) && criterioIds.length ? criterioIds : Object.keys(src);
  const vals = ids.map((id) => Number(src[id])).filter(Number.isFinite);
  if (!vals.length) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum / vals.length; // média das notas 0..100 == mesma forma que scoring.js
}

// -----------------------------------------------------------------------------
// Views públicas
// -----------------------------------------------------------------------------

// Visão do aluno (perfil, ranking): MMR total derivado + por critério.
// Oculto (null) durante a calibração. `criterioIds`, se passado, restringe o
// cálculo aos critérios ativos hoje.
function playerView(player, criterioIds) {
  const p = clonePlayer(player);
  const calibrating = p.nEntradas < CALIBRATION_MATCHES;
  const porCriterio = {};
  for (const id of Object.keys(p.criterios)) porCriterio[id] = p.criterios[id].P;
  const mmrTotalRaw = agregarTotal(porCriterio, criterioIds);
  const criteriosView = {};
  for (const id of Object.keys(p.criterios)) {
    const c = p.criterios[id];
    criteriosView[id] = { n: c.n, mmrRaw: c.P, mmr: calibrating ? null : c.P };
  }
  const mmrTotal = calibrating ? null : (mmrTotalRaw == null ? null : Math.round(mmrTotalRaw));
  return {
    nEntradas: p.nEntradas,
    // Compat com quem ainda lê `n` (contador antigo) e `mmr` (número redondo).
    n: p.nEntradas,
    calibrating,
    matchesRemaining: Math.max(0, CALIBRATION_MATCHES - p.nEntradas),
    mmr: mmrTotal,
    mmrRaw: calibrating ? null : mmrTotalRaw,
    mmrTotal,
    mmrTotalRaw: calibrating ? null : mmrTotalRaw,
    criterios: criteriosView,
  };
}

// Dificuldade do caso: D total derivado + por critério + β + n_D.
function characterView(character, criterioIds) {
  const c = cloneCharacter(character);
  const porCriterio = {};
  for (const id of Object.keys(c.criterios)) porCriterio[id] = c.criterios[id].D;
  const dTotalRaw = agregarTotal(porCriterio, criterioIds);
  const criteriosView = {};
  for (const id of Object.keys(c.criterios)) {
    const k = c.criterios[id];
    criteriosView[id] = {
      D: k.D, DRaw: k.D, n_D: k.n_D, beta: k.beta,
      madura: k.n_D >= CHAR_MATURE_AT,
    };
  }
  return {
    dTotal: dTotalRaw == null ? null : Math.round(dTotalRaw),
    dTotalRaw,
    criterios: criteriosView,
  };
}

// Compat: dificuldade "total" do caso como um número redondo (10..90). Chamada
// por rotas que só querem o número — o novo view (characterView) é o caminho
// mais rico.
function characterDifficulty(character, criterioIds) {
  const v = characterView(character, criterioIds).dTotal;
  return v == null ? Math.round(D0) : Math.round(v);
}

// Compat: média das notas brutas registradas no histórico do caso, agregando
// todos os critérios (spec §5 é linear, então a média das médias por critério é
// a mesma coisa que a média geral quando não há missing data).
function characterAvgScore(character, criterioIds) {
  const c = cloneCharacter(character);
  const ids = Array.isArray(criterioIds) && criterioIds.length ? criterioIds : Object.keys(c.criterios);
  const medias = [];
  for (const id of ids) {
    const cc = c.criterios[id];
    if (!cc) continue;
    const notas = cc.historico.map((h) => Number(h.S)).filter(Number.isFinite);
    if (notas.length) medias.push(notas.reduce((a, b) => a + b, 0) / notas.length);
  }
  if (!medias.length) return null;
  return medias.reduce((a, b) => a + b, 0) / medias.length;
}

// -----------------------------------------------------------------------------
// Notas ponderadas para exibição (spec §3.4)
// -----------------------------------------------------------------------------
// A nota ponderada exibida é SEMPRE recalculada com o D atual do caso.
// Recebe { [criterioId]: S_bruta_0_100 } + o estado do caso; devolve
// { [criterioId]: N_atual_sem_teto_sem_piso, total: N_total }.
function calcularPonderadas(criteriosBrutos, character, criterioIds) {
  const brutos = criteriosBrutos || {};
  const cState = cloneCharacter(character);
  const out = {};
  for (const id of Object.keys(brutos)) {
    const S = Number(brutos[id]);
    if (!Number.isFinite(S)) continue;
    const D = cState.criterios[id] && isNum(cState.criterios[id].D) ? cState.criterios[id].D : D0;
    out[id] = weightedScore(S, D);
  }
  const total = agregarTotal(out, criterioIds);
  return { criterios: out, total };
}

module.exports = {
  // Constantes (para testes e telas que precisam mostrar limites)
  P0, D0, D_MIN, D_MAX, WINDOW, CALIBRATION_MATCHES, CHAR_MATURE_AT, REGRESS_REFIT_EVERY,
  HISTORY_CAP, SIMPLE_MEAN_UNTIL, K_MIN, BETA_MIN, BETA_MAX, BETA_DEFAULT,
  GAIN_IMATURE, GAIN_MATURE, TOTAL_MIN_TO_MOVE_D, PVP_STAKE, PVP_MIN_SCORE,
  FONTES_VALIDAS,
  // Utilitários
  clamp,
  // Fábricas
  newPlayer, newCharacter, newAnonPopulation, newPlayerCriterio, newCharCriterio,
  // Sub-cálculos
  expectedScore, weightedScore, sensitivity, linearWeights, fitRegression,
  // Pipelines
  updateMatch, processDuel,
  // Derivações e views
  agregarTotal, playerView, characterView, calcularPonderadas,
  // Compat com quem só quer o número redondo
  characterDifficulty, characterAvgScore,
};
