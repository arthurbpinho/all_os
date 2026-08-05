// Montagem de system prompts — feita no SERVIDOR para evitar vazamento de
// specificInstruction/evaluatorPrompt/diagnosis ao cliente.

// Prompt de CHAT dos exercícios da Trilha. Não presume que o exercício é uma
// simulação de paciente — a instrução específica de cada exercício define o
// papel (paciente simulado, colega, situação de escrita etc.), e este prompt
// só garante que o modelo não quebre esse papel. O avaliador (nota) é OPCIONAL
// e definido pelo admin por exercício (evaluatorPrompt) — sem avaliador
// configurado, a sessão só finaliza, sem nota (ver wrapCustomEvaluatorPrompt).
function buildTrilhaExercisePrompt(specificInstruction) {
  return `Você está conduzindo um exercício estruturado da Trilha de prática deliberada da Allos (formação de psicólogos). A instrução abaixo define o papel que você deve incorporar durante o exercício — pode ser um paciente simulado, um colega, uma situação de escrita ou qualquer outro formato. Siga EXCLUSIVAMENTE essa instrução, de forma realista e consistente. Nunca quebre o papel descrito nem aja como assistente de IA genérico.

INSTRUÇÃO DO EXERCÍCIO:
${specificInstruction || ''}`;
}

function buildFreeplayPrompt(specificInstruction) {
  return `Você é um paciente em uma sessão de terapia. Aja EXCLUSIVAMENTE como o personagem descrito abaixo. Seja realista, natural e consistente com a descrição. Nunca quebre o personagem. Nunca aja como terapeuta ou IA.

INSTRUÇÃO DO PERSONAGEM:
${specificInstruction || ''}`;
}

// Remove a seção "## Apêndice ..." (e tudo depois dela) do prompt do personagem
// de neuro. Esse bloco é o gabarito para quem desenha a avaliação (hipótese
// diagnóstica esperada, diferenciais, bateria sugerida, racional) e é marcado
// como "fora do personagem" — NÃO pode chegar ao paciente simulado, senão o
// modelo que encarna o paciente conhece a própria resposta. Vai apenas ao
// avaliador, via resolveBloco1 (Bloco 1 + Apêndice), server-side.
function stripApendice(text) {
  const s = String(text || '');
  const m = s.match(/(^|\n)[ \t]*#{1,4}[ \t]*ap[êe]ndice\b/i);
  if (!m) return s.trim();
  const cut = m.index + (m[1] ? m[1].length : 0);
  // corta no cabeçalho do apêndice e remove um separador "---" pendurado antes dele.
  return s.slice(0, cut).replace(/\n*-{3,}[ \t]*$/, '').trim();
}

function buildNeuroPrompt(specificInstruction) {
  return `Você é um paciente em uma sessão de avaliação neuropsicológica/psicológica. Aja EXCLUSIVAMENTE como o personagem descrito abaixo. Seja realista, natural e consistente com o diagnóstico e manifestações clínicas descritas. Nunca quebre o personagem. Nunca revele seu diagnóstico diretamente — o terapeuta deve identificá-lo.

INSTRUÇÃO DO PERSONAGEM:
${stripApendice(specificInstruction)}`;
}

// Wrapper que garante o formato [NOTA:X] no fim, quando o admin define um prompt
// customizado. Na Trilha a nota é sempre uma PORCENTAGEM de 0 a 100 (passa com
// 75+), então forçamos a conversão da escala interna do avaliador para 0–100.
function wrapCustomEvaluatorPrompt(adminPrompt) {
  return `${(adminPrompt || '').trim()}

---

## FORMATO OBRIGATÓRIO DE SAÍDA

Esta avaliação faz parte da Trilha da Allos, onde a nota é uma PORCENTAGEM de domínio de 0 a 100 (o aluno passa de fase com 75 ou mais). Independentemente da escala que você descreveu acima, converta a nota final para uma porcentagem inteira de 0 a 100.

Na ÚLTIMA linha da sua resposta, emita OBRIGATORIAMENTE, exatamente neste formato (é lido pelo sistema):

[NOTA:X]

onde X é um número inteiro de 0 a 100. Sem essa linha, o sistema não consegue registrar a pontuação.`;
}

// Esquema visual (opcional, por exercício da Trilha): o modelo escreve um
// ÚNICO SVG autocontido que sintetiza a sessão, a partir da observação do
// admin (imageSchemaPrompt) + a transcrição. NÃO é geração de imagem "de
// pixel" (a Claude não tem essa capacidade via API) — é o modelo escrevendo
// texto/SVG, que o navegador renderiza como imagem vetorial. Funciona igual
// para GPT e Claude, sem precisar de nenhuma tool de imagem.
function buildImageSchemaPrompt(observacao) {
  return `Você gera um ÚNICO esquema/diagrama visual em SVG que sintetiza o que aconteceu num exercício da Trilha de prática deliberada da Allos (formação de psicólogos), a partir da transcrição que você vai receber a seguir.

OBSERVAÇÃO DE QUEM CRIOU O EXERCÍCIO (o que o esquema deve representar):
${(observacao || '').trim() || '(sem observação específica — use seu critério clínico para sintetizar o que for mais relevante na sessão)'}

## REGRAS OBRIGATÓRIAS
- Responda com absolutamente NADA além de um único bloco <svg>...</svg>, autocontido.
- Use viewBox (não width/height fixos em pixel bruto), pra ficar responsivo.
- Só formas, texto e cores DENTRO do próprio SVG (rect, circle, path, line, text etc.) — nada de <script>, <foreignObject>, referências externas ou imagens embutidas.
- Texto em português, legível e direto.
- Sem comentário, sem explicação, sem cerca de código (\`\`\`) — a resposta é só o SVG cru.`;
}

module.exports = {
  buildTrilhaExercisePrompt,
  buildFreeplayPrompt,
  buildNeuroPrompt,
  buildImageSchemaPrompt,
  wrapCustomEvaluatorPrompt,
  stripApendice,
};
