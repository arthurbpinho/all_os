// A montagem de system prompts (exercise/freeplay/neuro/avaliador) vive no
// servidor (server/prompts.js). O cliente passa apenas `context: { type, itemId }`
// em api.chat / api.evaluate; o backend resolve o prompt internamente. Isso
// evita o vazamento de specificInstruction, evaluatorPrompt e diagnosis para
// usuários não-admin.
//
// Este módulo guarda apenas o que a TELA precisa: a mensagem que leva a
// transcrição ao avaliador, a saudação do feedback e a limpeza do texto que o
// aluno lê. Guardava também o mapa de 10 critérios × 5 competências e o cálculo
// de nota por competência do avaliador v9 — os dois saíram com aquela grade.

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

// Saudação que abre o feedback do aluno. Os avaliadores v18.25 não a escrevem (a
// especificação deles diz que "o sistema monta a mensagem"), então ela entra
// aqui, na hora de mostrar o texto na tela, e no servidor, na hora de salvar o
// log. ESPELHO de EVAL_GREETING em server/index.js — mudou aqui, mude lá.
export const EVAL_GREETING = [
  'Trate este feedback como pré-correção — ponto de partida para conversa com seu supervisor e colegas, não veredicto.',
  '',
  'Tenho acesso apenas ao que você escreveu, não ao que você pensou. Use o botão de estrela para descrever seu raciocínio clínico nas falas em que ele importa — isso me ajuda a diferenciar decisões clínicas conscientes de erros por falta de percepção.',
].join('\n');

// Deixa a saída do avaliador no estado em que o ALUNO pode ler: sem nenhum bloco
// de máquina e com a saudação na frente. Espelha extractSupervisorNotes do
// servidor (que faz o mesmo com o texto que vai pro log); aqui é para a tela
// pós-sessão e para os downloads que o próprio aluno faz, porque o texto que
// chega do /api/evaluate vem cru.
//
// Dois formatos de saída convivem:
//   v18.25 (atual) → `[notas]` (uma linha por critério) no INÍCIO, `[feedback]` e
//     o corpo depois. Enquanto o `[feedback]` não chegou, não há nada legível
//     ainda: devolvemos vazio em vez de deixar as notas aparecerem na tela.
//   v15/v16 (logs antigos) → prosa + `[notas-supervisor]` no fim.
// Em ambos, os blocos de resultado de missão ([sidequest-resultado],
// [missao-diaria-resultado]) e os marcadores de nota da Trilha saem também.
export function cleanEvaluationForStudent(text) {
  if (!text) return '';
  let s = String(text);
  const hasNotas = /(?:^|\n)[^\S\n]*\[notas\][^\S\n]*\n/i.test(s);
  const fb = s.match(/(?:^|\n)[^\S\n]*\[feedback\][^\S\n]*(?:\n|$)/i);
  if (fb) {
    s = `${EVAL_GREETING}\n\n${s.slice(fb.index + fb[0].length)}`;
  } else if (hasNotas) {
    return ''; // v18.25 ainda no bloco de notas — nada para o aluno ler
  }
  return s
    // Notas por critério — só supervisor/admin.
    .replace(/(?:^|\n)[^\S\n]*\[notas\][^\S\n]*\n[\s\S]*$/i, '')
    .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[notas-supervisor\][\s\S]*$/i, '')
    // Resultado de missão (JSON de conclusão) — só sistema/supervisor.
    .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[sidequest-resultado\][\s\S]*$/i, '')
    .replace(/\n*(?:-{3,}[^\S\n]*\n+)?\[missao-diaria-resultado\][\s\S]*$/i, '')
    // Marcadores de nota (Trilha e avaliadores antigos).
    .replace(/\[CRITERIOS:[^\]]+\]\s*/g, '')
    .replace(/\[NOTA:[^\]]+\]\s*/g, '')
    .replace(/\*\*\s*Nota:\s*\d{1,3}\s*\/\s*100\s*\*\*\s*/i, '')
    .trim();
}
