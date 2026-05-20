// Engine do MMR (rating competitivo) do simulador clínico.
// Implementa a especificação de mmr_simulador_clinico_v2.md em JS puro — OLS é
// fórmula fechada, então não precisamos de numpy/sklearn nem de SQL/Django.
// Todas as funções aqui são PURAS: recebem e devolvem estado, sem I/O. A
// persistência (mmr.json) vive no server/index.js.
//
// DESVIOS DELIBERADOS em relação ao PSEUDOCÓDIGO do doc (o texto/§ é a fonte de
// verdade quando o pseudocódigo o contradiz):
//
//  1. Pesos da janela. O pseudocódigo dá o maior peso ao índice 0 e pareia com
//     W[0], que é a partida MAIS ANTIGA (eles dão pop(0) no mais antigo e
//     append no mais novo). Isso contradiz §3/§5.2 ("mais recente = maior
//     peso", "20× mais peso que a mais antiga"). Aqui o MAIS RECENTE recebe o
//     maior peso, como o texto manda.
//
//  2. Fronteira da calibração. O texto (§5.1) fala em "5 primeiras partidas" de
//     calibração e "após a 5ª partida ... influencia a dificuldade". O
//     pseudocódigo usava `n <= 5` (MMR) e `n > 5` (dificuldade) — off-by-one
//     entre si e contra o texto. Unificamos numa fronteira só: com n =
//     partidas JÁ concluídas (0-indexed), calibração é n < 5 (partidas 1..5) e
//     a fase madura (MMR por janela E ajuste de dificuldade) começa na 6ª.
//
//  3. Histórico do personagem para a regressão. O pseudocódigo gravava o D já
//     ajustado; gravamos o D CONTRA O QUAL a partida foi de fato jogada (D
//     antes do ajuste) — é esse o D que gerou o S, logo o correto para prever S
//     a partir do gap (P − D).

const P0 = 50;                 // MMR inicial do jogador
const D0 = 50;                 // dificuldade inicial do personagem
const D_MIN = 10;
const D_MAX = 90;
const WINDOW = 20;             // janela de partidas recentes do jogador
const CALIBRATION_MATCHES = 5; // nº de partidas em fase de calibração
const CHAR_MATURE_AT = 20;     // n_D a partir do qual liga a regressão do personagem
const REGRESS_REFIT_EVERY = 5; // reajusta a regressão a cada N partidas válidas
const HISTORY_CAP = 200;       // teto do histórico do personagem em disco

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function newPlayer() {
  return { P: P0, n: 0, W: [] };
}

function newCharacter() {
  return { D: D0, n_D: 0, alpha: null, beta: null, history: [] };
}

// Passo 1 — nota esperada S_esp dado o gap (P − D).
function expectedScore(player, character) {
  const gap = player.P - character.D;
  const mature = character.n_D >= CHAR_MATURE_AT
    && Number.isFinite(character.alpha)
    && Number.isFinite(character.beta);
  if (mature) return character.alpha + character.beta * gap;
  return 50 + 0.5 * gap; // fase cold start (provisória)
}

// Pesos lineares decrescentes, normalizados. Convenção de armazenamento:
// índice 0 = MAIS ANTIGO, último = MAIS RECENTE (push no fim). O mais recente
// recebe peso `size`, o mais antigo peso 1 — razão de `size`× (20× para a
// janela cheia), batendo com §5.2.
function linearWeights(size) {
  if (size <= 0) return [];
  const denom = (size * (size + 1)) / 2;
  const w = new Array(size);
  for (let i = 0; i < size; i++) w[i] = (i + 1) / denom;
  return w;
}

// Passo 3 — sensibilidade do MMR. Usa n ANTES do incremento: n=0 (1ª partida)
// → 0,50; assintótico em 0,10.
function sensitivity(n) {
  return 0.10 + 0.40 * Math.exp(-0.15 * n);
}

// Regressão linear simples por mínimos quadrados (fórmula fechada):
// S ≈ alpha + beta·gap, com gap = P − D. Retorna null quando não há pontos
// suficientes ou o gap é praticamente constante (regressão indefinida).
function fitRegression(history) {
  const pts = (history || []).filter(
    (h) => Number.isFinite(h.P) && Number.isFinite(h.D) && Number.isFinite(h.S),
  );
  const N = pts.length;
  if (N < 2) return null;
  let sx = 0, sy = 0;
  for (const h of pts) { sx += h.P - h.D; sy += h.S; }
  const mx = sx / N, my = sy / N;
  let sxx = 0, sxy = 0;
  for (const h of pts) {
    const dx = (h.P - h.D) - mx;
    sxx += dx * dx;
    sxy += dx * (h.S - my);
  }
  if (sxx < 1e-9) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  return { alpha, beta };
}

// Pipeline completo de UMA partida competitiva. Recebe o estado do jogador e do
// personagem (ou undefined → estado inicial) e a nota crua S (0..100). Devolve
// { player, character, result } com estados NOVOS (não muta a entrada). Sem I/O.
function updateMatch(playerIn, charIn, Sraw) {
  const player = { ...newPlayer(), ...(playerIn || {}) };
  player.W = Array.isArray(playerIn && playerIn.W) ? [...playerIn.W] : [];
  const character = { ...newCharacter(), ...(charIn || {}) };
  character.history = Array.isArray(charIn && charIn.history) ? [...charIn.history] : [];

  const S = clamp(Number(Sraw), 0, 100);
  const nBefore = player.n;                       // partidas já concluídas
  const calibrating = nBefore < CALIBRATION_MATCHES; // partidas 1..5

  // Passo 1 — nota esperada
  const S_esp = expectedScore(player, character);

  // Passo 2 — dificuldade (só quando o jogador NÃO está em calibração: 6ª+).
  // Durante a calibração o sinal do jogador é ruidoso demais para mexer no D.
  const D_before = character.D;
  if (!calibrating) {
    const deltaD = 0.1 * (S_esp - S);
    character.D = clamp(character.D + deltaD, D_MIN, D_MAX);
    character.n_D += 1;
    character.history.push({ P: player.P, D: D_before, S }); // D jogado, não o ajustado
    if (character.history.length > HISTORY_CAP) character.history.shift();
    if (character.n_D >= CHAR_MATURE_AT && character.n_D % REGRESS_REFIT_EVERY === 0) {
      const fit = fitRegression(character.history);
      if (fit) { character.alpha = fit.alpha; character.beta = fit.beta; }
    }
  }

  // Passo 3 — sensibilidade
  const K_p = sensitivity(nBefore);

  // Passo 4 — nota ajustada (sem clamp; preserva extremos)
  const S_aj = S + (50 - S_esp);

  // Passo 5 — atualização do MMR
  const P_before = player.P;
  if (calibrating || player.W.length === 0) {
    // EMA pura (calibração; e fallback defensivo se a janela estiver vazia)
    player.P = (1 - K_p) * player.P + K_p * S_aj;
  } else {
    const w = linearWeights(player.W.length);
    let P_W = 0;
    for (let i = 0; i < player.W.length; i++) P_W += w[i] * player.W[i].S_aj;
    player.P = (1 - K_p) * P_W + K_p * S_aj;
  }

  // Passo 6 — manutenção da janela e contador
  player.W.push({ S_aj, D: character.D, P: player.P });
  if (player.W.length > WINDOW) player.W.shift();
  player.n += 1;

  const result = {
    S,
    S_esp,
    S_aj,
    K_p,
    P_before,
    P_after: player.P,
    delta: player.P - P_before,
    D_before,
    D_after: character.D,
    n: player.n,
    calibratingBefore: calibrating,
    calibrating: player.n < CALIBRATION_MATCHES,
    matchesRemaining: Math.max(0, CALIBRATION_MATCHES - player.n),
  };
  return { player, character, result };
}

// Visão pública do jogador para ranking/perfil. MMR fica OCULTO (null) durante a
// calibração (n < 5), exibindo só quantas partidas faltam.
function playerView(player) {
  const p = player || newPlayer();
  const calibrating = p.n < CALIBRATION_MATCHES;
  return {
    n: p.n,
    calibrating,
    matchesRemaining: Math.max(0, CALIBRATION_MATCHES - p.n),
    mmr: calibrating ? null : Math.round(p.P),
    mmrRaw: p.P,
  };
}

// Dificuldade exibível (1..100, na prática clampada em 10..90). Personagem nunca
// jogado mostra a baseline (50).
function characterDifficulty(character) {
  return Math.round((character && Number.isFinite(character.D)) ? character.D : D0);
}

module.exports = {
  P0, D0, D_MIN, D_MAX, WINDOW, CALIBRATION_MATCHES, CHAR_MATURE_AT, REGRESS_REFIT_EVERY,
  clamp,
  newPlayer,
  newCharacter,
  expectedScore,
  linearWeights,
  sensitivity,
  fitRegression,
  updateMatch,
  playerView,
  characterDifficulty,
};
