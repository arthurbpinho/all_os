// A montagem de system prompts (exercise/freeplay/neuro/avaliador) vive no
// servidor (server/prompts.js). O cliente passa apenas `context: { type, itemId }`
// em api.chat / api.evaluate; o backend resolve o prompt internamente. Isso
// evita o vazamento de specificInstruction, evaluatorPrompt e diagnosis para
// usuários não-admin.
//
// Este módulo guarda apenas: constantes de display + parsing/cálculo das notas.

export const SKILL_NAMES = {
  1: 'Hermenêutica',
  2: 'Estrutura',
  3: 'Empatia',
  4: 'Especificidade do caso',
  5: 'Eu'
};

export const SKILL_COLORS = {
  1: '#008f8f',  // Marrs Green   — Hermenêutica
  2: '#B85A40',  // Terra         — Estrutura
  3: '#1A7A6D',  // Deep green    — Empatia
  4: '#5C8A82',  // Sage          — Especificidade do caso
  5: '#A07845'   // Amber/brown   — Eu
};

// Mapeamento critério → skill e peso. Necessário no cliente porque calculateScores
// roda aqui (a partir das notas que a IA devolve no [CRITERIOS:...]).
export const CRITERIA_MAP = {
  1:  { skillId: 2, weight: 1, name: 'Abertura e Encerramento' },        // Estrutura
  2:  { skillId: 5, weight: 2, name: 'Estágio de Mudança' },             // Eu
  3:  { skillId: 3, weight: 2, name: 'Construção do Vínculo' },          // Empatia
  4:  { skillId: 5, weight: 1, name: 'Confiança no Método' },            // Eu
  5:  { skillId: 3, weight: 1, name: 'Confiança Enquanto Profissional' },// Empatia
  6:  { skillId: 4, weight: 2, name: 'Priorização' },                    // Especificidade do caso
  7:  { skillId: 4, weight: 2, name: 'Esquema de Aprofundamento' },      // Especificidade do caso
  8:  { skillId: 1, weight: 1, name: 'Formulação de Caso' },             // Hermenêutica
  9:  { skillId: 1, weight: 2, name: 'Insight / Potência' },             // Hermenêutica
  10: { skillId: 2, weight: 1, name: 'Setting — Corpo e Espaço' }        // Estrutura
};

// Calcula notas a partir das notas por critério
export function calculateScores(criteriaScores) {
  const scores = { ...criteriaScores };

  // Regra dos zeros: substituir 0 pela moda das demais notas
  const nonZeroValues = Object.values(scores).filter(v => v !== 0);
  if (nonZeroValues.length > 0) {
    const freq = {};
    nonZeroValues.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    const moda = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
    Object.keys(scores).forEach(k => {
      if (scores[k] === 0) scores[k] = moda;
    });
  }

  // Nota geral = soma(nota × peso) para todos os 10 critérios
  let totalScore = 0;
  for (let c = 1; c <= 10; c++) {
    totalScore += (scores[c] || 0) * CRITERIA_MAP[c].weight;
  }

  // Nota por skill = soma(nota × peso) apenas dos critérios daquela skill
  const skillScores = {};
  for (let s = 1; s <= 5; s++) {
    skillScores[s] = 0;
    for (let c = 1; c <= 10; c++) {
      if (CRITERIA_MAP[c].skillId === s) {
        skillScores[s] += (scores[c] || 0) * CRITERIA_MAP[c].weight;
      }
    }
  }

  return { totalScore, skillScores, adjustedCriteria: scores };
}

// Monta a *mensagem* (role: user) que vai pro avaliador com a transcrição.
// O system prompt v9 é resolvido no servidor; se o personagem tiver Bloco 1
// configurado (evaluationCriteria), o servidor prepende o gabarito ANTES
// dessa string, formando o pacote final:
//   [BLOCO 1 DO CASO] (critério de correção/gabarito)
//   {gabarito}
//
//   ---
//
//   [LOG DO ATENDIMENTO]
//   Sessão: ...
//   {transcript}
//
// Quando não há Bloco 1 (aba Avaliação manual ou personagem sem gabarito),
// a mensagem chega ao avaliador só com o LOG — ele opera em modo degradado.
export function buildDirectEvaluationPrompt(sessionLabel, characterName, transcript) {
  return `[LOG DO ATENDIMENTO]
Sessão: ${sessionLabel}
Personagem: ${characterName}

${transcript}`;
}

// Tenta extrair as notas por critério da resposta da IA
export function parseCriteriaScores(text) {
  const scores = {};
  // Procura padrão [CRITERIOS:1=+3,2=-1,3=+1,...,10=+3]
  const match = text.match(/\[CRITERIOS:([\d=+\-,]+)\]/);
  if (match) {
    const pairs = match[1].split(',');
    pairs.forEach(pair => {
      const [crit, val] = pair.split('=');
      scores[Number(crit)] = Number(val);
    });
  }
  return Object.keys(scores).length === 10 ? scores : null;
}
