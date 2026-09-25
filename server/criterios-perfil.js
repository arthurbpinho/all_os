// Gráfico de critérios do perfil (demandas.md §16.3) — lógica PURA.
//
// Média de cada critério nas sessões avaliadas da pessoa. O admin escolhe, em
// Administração → Acessos, quais modos alimentam o gráfico: misturar Trilha ou
// Neuro com a Simulação pode não fazer sentido, porque as réguas são outras.
//
// Critério é identificado pelo NOME (normalizado sem caixa e sem espaço extra),
// não pelo número: um critério novo começa sem histórico, e um que mudou de
// posição continua com o seu.

const MODOS = [
  { key: 'treinamento', label: 'Treinamento' },
  { key: 'competitivo', label: 'Competitivo' },
  { key: 'trilha', label: 'Trilha' },
  { key: 'neuro', label: 'Neuroavaliação' },
];
const MODO_KEYS = MODOS.map((m) => m.key);
const MODOS_PADRAO = ['treinamento', 'competitivo'];

function normalizarModos(raw) {
  if (!Array.isArray(raw)) return [...MODOS_PADRAO];
  return MODO_KEYS.filter((k) => raw.includes(k));
}

// Modo de um log, no vocabulário acima.
function modoDoLog(log) {
  if (!log) return null;
  if (log.type === 'exercise') return 'trilha';
  if (log.type === 'neuro') return 'neuro';
  if (log.type === 'freeplay') return log.mode === 'competitive' ? 'competitivo' : 'treinamento';
  return null;
}

function chaveDoNome(nome) {
  return String(nome).trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

// Nomes de um log: os gravados na avaliação ou, em log antigo, os que
// `nomesDaRegua(evalVersion)` devolver ({ '1': nome }). Sem nome, não entra —
// melhor faltar uma sessão no gráfico que somar o critério errado.
function nomesDoLog(log, nomesDaRegua) {
  if (log.criteriaNames && typeof log.criteriaNames === 'object') return log.criteriaNames;
  if (log.evalVersion && typeof nomesDaRegua === 'function') return nomesDaRegua(log.evalVersion) || null;
  return null;
}

// [{ nome, media, n }] na ordem em que cada critério apareceu pela última vez
// (a régua atual primeiro), mais quantas sessões entraram.
//
// `apelidos` ({ chave do nome antigo: nome atual }) junta um critério renomeado
// com "manter histórico"; `desde` ({ chave do nome: ISO }) descarta as notas de
// antes de um "zerar histórico".
function mediasPorCriterio(logs, { modos = MODOS_PADRAO, nomesDaRegua, apelidos = {}, desde = {} } = {}) {
  const aceitos = new Set(normalizarModos(modos));
  const acc = new Map();
  let sessoes = 0;
  // Mais recente primeiro: o nome exibido e a ordem vêm da avaliação mais nova.
  const ordenados = [...(logs || [])].sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  for (const log of ordenados) {
    if (!aceitos.has(modoDoLog(log))) continue;
    const notas = log.criteriaScores;
    if (!notas || typeof notas !== 'object') continue;
    const nomes = nomesDoLog(log, nomesDaRegua);
    if (!nomes) continue;
    let contou = false;
    const ordemNoLog = Object.keys(notas).sort((a, b) => Number(a) - Number(b));
    for (const num of ordemNoLog) {
      const v = Number(notas[num]);
      const gravado = nomes[num];
      if (!Number.isFinite(v) || typeof gravado !== 'string' || !gravado.trim()) continue;
      const nome = apelidos[chaveDoNome(gravado)] || gravado;
      const k = chaveDoNome(nome);
      if (desde[k] && String(log.timestamp || '') < desde[k]) continue;
      if (!acc.has(k)) acc.set(k, { nome: nome.trim(), soma: 0, n: 0 });
      const item = acc.get(k);
      item.soma += v;
      item.n += 1;
      contou = true;
    }
    if (contou) sessoes += 1;
  }
  const criterios = [...acc.values()].map(({ nome, soma, n }) => ({ nome, media: Math.round((soma / n) * 10) / 10, n }));
  return { criterios, sessoes };
}

module.exports = { MODOS, MODO_KEYS, MODOS_PADRAO, normalizarModos, modoDoLog, chaveDoNome, mediasPorCriterio };
