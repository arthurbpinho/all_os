// Modelo de IA e limite semanal do Terapeuta externo (demandas.md §16.2 e §18)
// — lógica PURA.
//
// O admin escolhe, em Administração → Acessos, qual modelo atende o paciente e
// qual corrige a sessão do aluno externo, e um teto de uso numa janela
// DESLIZANTE de 7 dias, em dólares, em tokens ou nos dois. Estourou, as chamadas
// de IA dele param até os usos mais antigos saírem da janela, e o suporte (os
// admins) recebe um aviso.
//
// Por que janela deslizante e não "zera na segunda": com corte fixo quem gasta
// tudo no domingo gasta de novo na segunda, e o teto vira o dobro.

const JANELA_MS = 7 * 24 * 60 * 60 * 1000;

// USD por 1 MILHÃO de tokens. Chave = prefixo do id do modelo (casa o mais
// longo, então sobrevive a troca de pin). Mesmos números de V25_PRICES e
// TRILHA_COST_PRICES (docs dos provedores, ago/2026).
const PRECOS = {
  'gpt-5.6-sol': { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, cacheWrite: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, cacheWrite: 0.2, output: 1.2 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 4.5 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15 },
  'glm-5.2': { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
};

function precoDoModelo(model) {
  const s = String(model || '');
  let melhor = null;
  for (const k of Object.keys(PRECOS)) {
    if (s.startsWith(k) && (!melhor || k.length > melhor.length)) melhor = k;
  }
  return melhor ? PRECOS[melhor] : null;
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// Tokens de um usage normalizado ({ input, cacheRead, cacheWrite, output }).
function tokensDe(uso) {
  if (!uso) return 0;
  return num(uso.input) + num(uso.cacheRead) + num(uso.cacheWrite) + num(uso.output);
}

// USD de um usage normalizado. null = modelo fora da tabela: aí só os tokens
// contam, e o limite em dólar não enxerga aquela chamada (melhor que inventar preço).
function custoUsd(model, uso) {
  const p = precoDoModelo(model);
  if (!p || !uso) return null;
  return (num(uso.input) * p.input + num(uso.cacheRead) * p.cacheRead
    + num(uso.cacheWrite) * p.cacheWrite + num(uso.output) * p.output) / 1e6;
}

// Configuração saneada. `pacientes` e `avaliadores` são os presets válidos
// (chaves de ai-models.js): escolha fora deles vira "padrão da categoria".
function normalizarConfig(raw, { pacientes = {}, avaliadores = {} } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tem = (obj, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(obj, k);
  const limite = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
  };
  return {
    modeloPaciente: tem(pacientes, r.modeloPaciente) ? r.modeloPaciente : '',
    modeloAvaliador: tem(avaliadores, r.modeloAvaliador) ? r.modeloAvaliador : '',
    limiteUsd: limite(r.limiteUsd, 100000) != null ? Math.round(limite(r.limiteUsd, 100000) * 100) / 100 : null,
    limiteTokens: limite(r.limiteTokens, 1e12) != null ? Math.floor(limite(r.limiteTokens, 1e12)) : null,
  };
}

function temLimite(cfg) {
  return !!(cfg && (cfg.limiteUsd || cfg.limiteTokens));
}

const MENSAGEM_LIMITE = 'Você chegou ao limite semanal de uso de IA do seu perfil. Ele se renova aos poucos, conforme os usos de 7 dias atrás saem da conta. O suporte da Allos já foi avisado.';

// Estado da pessoa na janela. `uso` = { usd, tokens, primeiro } (primeiro = ISO
// do uso mais antigo na janela, que é quando algo volta a caber).
function estado(uso, cfg, agora = Date.now()) {
  const usd = Math.round(num(uso && uso.usd) * 10000) / 10000;
  const tokens = Math.floor(num(uso && uso.tokens));
  const limiteUsd = (cfg && cfg.limiteUsd) || null;
  const limiteTokens = (cfg && cfg.limiteTokens) || null;
  const porUsd = limiteUsd != null && usd >= limiteUsd;
  const porTokens = limiteTokens != null && tokens >= limiteTokens;
  const excedido = porUsd || porTokens;
  const primeiro = uso && uso.primeiro ? Date.parse(uso.primeiro) : NaN;
  return {
    usd, tokens, limiteUsd, limiteTokens, excedido,
    motivo: porUsd && porTokens ? 'ambos' : porUsd ? 'usd' : porTokens ? 'tokens' : null,
    renovaEm: excedido && Number.isFinite(primeiro) ? new Date(Math.max(agora, primeiro + JANELA_MS)).toISOString() : null,
    mensagem: excedido ? MENSAGEM_LIMITE : '',
  };
}

// Quantos tokens um valor em dólar compra em cada modelo, para o admin traduzir
// um limite no outro. Entrada e saída separadas: o preço da saída é 4 a 8 vezes
// o da entrada, e uma média esconderia isso.
function equivalencias(limiteUsd, modelos) {
  const usd = num(limiteUsd);
  return (modelos || []).map(({ key, label, model }) => {
    const p = precoDoModelo(model);
    return {
      key, label,
      precoPorMTok: p ? { entrada: p.input, saida: p.output } : null,
      tokensEntrada: p && usd ? Math.floor((usd / p.input) * 1e6) : null,
      tokensSaida: p && usd ? Math.floor((usd / p.output) * 1e6) : null,
    };
  });
}

module.exports = {
  JANELA_MS, PRECOS, MENSAGEM_LIMITE,
  precoDoModelo, tokensDe, custoUsd, normalizarConfig, temLimite, estado, equivalencias,
};
