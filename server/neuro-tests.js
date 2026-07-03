// Catálogo fixo de testes/questionários neuropsicológicos (Neuroavaliação /
// System 3). Fonte ÚNICA de verdade: o servidor expõe via GET /api/neuro/tests
// e valida seleções contra ele. Os ids são estáveis (não derivados em runtime)
// pra que os gabaritos gravados nos personagens não quebrem se um nome mudar.
//
// Estrutura: lista de categorias { category, tests: [{ id, abbr, name }] }.

const NEURO_TEST_CATALOG = [
  {
    category: 'Inteligência / Cognição Global',
    tests: [
      { id: 'wais-iii', abbr: 'WAIS-III', name: 'Escala Wechsler de Inteligência para Adultos' },
      { id: 'wisc-iv', abbr: 'WISC-IV', name: 'Escala Wechsler de Inteligência para Crianças' },
      { id: 'wasi', abbr: 'WASI', name: 'Escala Wechsler Abreviada de Inteligência' },
    ],
  },
  {
    category: 'Espectro Autista',
    tests: [
      { id: 'cat-q', abbr: 'CAT-Q', name: 'Questionário de Camuflagem de Traços Autistas' },
      { id: 'srs-2', abbr: 'SRS-2', name: 'Social Responsiveness Scale, 2nd Edition' },
      { id: 'aq-16', abbr: 'AQ 16+', name: 'Quociente do Espectro do Autismo' },
    ],
  },
  {
    category: 'TDAH',
    tests: [
      { id: 'asrs-18', abbr: 'ASRS-18', name: 'Adult ADHD Self-Report Scale' },
      { id: 'bdefs', abbr: 'BDEFS', name: 'Barkley Deficits in Executive Functioning Scale' },
      { id: 'mta-snap-iv', abbr: 'MTA-SNAP-IV', name: 'Swanson, Nolan, and Pelham Rating Scale' },
      { id: 'diva-5', abbr: 'DIVA-5', name: 'Entrevista Diagnóstica para o TDAH em Adultos' },
    ],
  },
  {
    category: 'Atenção',
    tests: [
      { id: 'd2-r', abbr: 'd2-R', name: 'Teste de Atenção d2 - Revisado' },
      { id: 'tavis-4', abbr: 'TAVIS-4', name: 'Teste de Atenção Visual - 4ª edição' },
      { id: 'teaco', abbr: 'TEACO', name: 'Teste de Atenção Concentrada' },
      { id: 'tealt', abbr: 'TEALT', name: 'Teste de Atenção Alternada' },
      { id: 'bpa-2', abbr: 'BPA-2', name: 'Bateria Psicológica para Avaliação da Atenção' },
    ],
  },
  {
    category: 'Funções Executivas',
    tests: [
      { id: 'fdt', abbr: 'FDT', name: 'Five Digit Test' },
      { id: 'bis-11', abbr: 'BIS-11', name: 'Escala de Impulsividade de Barratt' },
    ],
  },
  {
    category: 'Emocional',
    tests: [
      { id: 'eag-a', abbr: 'EAG-A', name: 'Escala de Ansiedade Generalizada' },
      { id: 'humor-a', abbr: 'HUMOR-A', name: 'Bateria de Avaliação de Indicadores de Depressão' },
      { id: 'phq-9', abbr: 'PHQ-9', name: 'Questionário de Saúde do Paciente' },
      { id: 'humor-ij', abbr: 'HUMOR-IJ', name: 'Escalas de Sintomas Internalizantes Infantojuvenil' },
      { id: 'ham-a', abbr: 'HAM-A', name: 'Escala de Avaliação de Ansiedade de Hamilton' },
    ],
  },
  {
    category: 'Memória',
    tests: [
      { id: 'cubos', abbr: 'CUBOS', name: 'Cubos de Corsi' },
      { id: 'ravlt', abbr: 'RAVLT', name: 'Rey Auditory Verbal Learning Test' },
      { id: 'figuras-de-rey', abbr: 'Figuras de Rey', name: 'Teste de Cópia e Reprodução de Memória' },
    ],
  },
  {
    category: 'Velocidade de Processamento',
    tests: [
      { id: 'codigos', abbr: 'Códigos', name: 'Teste Beta-III' },
    ],
  },
  {
    category: 'Personalidade',
    tests: [
      { id: 'epq-j', abbr: 'EPQ-J', name: 'Questionário de Personalidade para Crianças e Adolescentes' },
      { id: 'bfp', abbr: 'BFP', name: 'Bateria Fatorial de Personalidade' },
      { id: 'neo-pi-r', abbr: 'NEO PI-R', name: 'Inventário de Personalidade NEO Revisado' },
    ],
  },
];

// Índices derivados (id -> { id, abbr, name, category }) e Set de ids válidos.
const NEURO_TEST_BY_ID = new Map();
for (const group of NEURO_TEST_CATALOG) {
  for (const t of group.tests) {
    NEURO_TEST_BY_ID.set(t.id, { ...t, category: group.category });
  }
}
const NEURO_TEST_IDS = new Set(NEURO_TEST_BY_ID.keys());

function isValidTestId(id) {
  return NEURO_TEST_IDS.has(id);
}

// Metadados de um teste pelo id. Fallback defensivo para ids desconhecidos
// (personagens antigos, dados corrompidos) — devolve o id como abbr/name.
function testMeta(id) {
  const t = NEURO_TEST_BY_ID.get(id);
  return t ? { id: t.id, abbr: t.abbr, name: t.name, category: t.category }
           : { id, abbr: id, name: id, category: '' };
}

// Normaliza uma lista de ids: filtra os inválidos, remove duplicatas, preserva
// a ordem de entrada e aplica um teto de tamanho.
function normalizeTestIds(list, cap = 60) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(list)) {
    for (const raw of list) {
      const id = String(raw == null ? '' : raw).trim();
      if (NEURO_TEST_IDS.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

// Compara a seleção do aluno com o gabarito do personagem (teste EXATO).
// Acurácia = Jaccard: acertos / (acertos + faltantes + extras), em % (0..100).
// results = resultados do paciente para TODA a bateria recomendada (o "gabarito"
// revelado ao aluno depois que ele comita a seleção).
function compareNeuroTests(recommendedTests, testResults, selectedTests) {
  const recommended = normalizeTestIds(recommendedTests);
  const selected = normalizeTestIds(selectedTests);
  const recSet = new Set(recommended);
  const selSet = new Set(selected);

  const matched = selected.filter((id) => recSet.has(id));
  const missing = recommended.filter((id) => !selSet.has(id));
  const extra = selected.filter((id) => !recSet.has(id));

  const denom = matched.length + missing.length + extra.length;
  // Sem bateria recomendada cadastrada (admin não configurou) → acurácia N/A
  // (null), pra não penalizar o aluno com 0%. Com gabarito, denom é sempre > 0
  // (>= nº de recomendados), então é Jaccard puro.
  const accuracy = recommended.length === 0 ? null : Math.round((matched.length / denom) * 100);

  const resultsList = [];
  for (const id of recommended) {
    const val = testResults && typeof testResults === 'object' ? testResults[id] : undefined;
    if (val) {
      resultsList.push({ ...testMeta(id), result: String(val) });
    }
  }

  return {
    accuracy,
    counts: {
      recommended: recommended.length,
      selected: selected.length,
      matched: matched.length,
      missing: missing.length,
      extra: extra.length,
    },
    selected: selected.map(testMeta),
    recommended: recommended.map(testMeta),
    matched: matched.map(testMeta),
    missing: missing.map(testMeta),
    extra: extra.map(testMeta),
    results: resultsList,
  };
}

module.exports = {
  NEURO_TEST_CATALOG,
  NEURO_TEST_IDS,
  isValidTestId,
  testMeta,
  normalizeTestIds,
  compareNeuroTests,
};
