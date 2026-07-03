// Extrai o "Bloco 1" do prompt do personagem (specificInstruction).
//
// Bloco 1 = seções II a V do prompt — gabarito/critério de correção pro
// avaliador. Descreve quem é o paciente, suas camadas, voz, dinâmica e
// continuidade.
//
// O matching trava apenas no número romano (II..VI). O título depois do
// número é livre: aceita "## [II. IDENTIDADE]", "## [II - Construção do
// personagem]", "## [II: ...]", "## [II ...]", etc.
//
// O fim é detectado, em ordem de preferência:
//   - "## [VI..." — próxima seção (corte exato antes dela)
//   - "---" em linha própria DEPOIS do header da seção V (separador final
//     do template, quando não há seção VI)
//   - fim do texto
//
// Retorna o trecho trimado, ou string vazia se não encontrar a seção II.

// Lookahead garante que II/V/VI sejam o numeral romano completo — sem isso,
// "## [V " bateria dentro de "## [VI..." e quebraria a detecção de fim.
const SECTION_BOUNDARY = '(?=[\\s.\\-:\\]])';

function sectionRegex(numeral) {
  return new RegExp(`##\\s*\\[\\s*${numeral}${SECTION_BOUNDARY}`, 'i');
}

export function extractBloco1(specificInstruction) {
  if (!specificInstruction || typeof specificInstruction !== 'string') return '';

  const startMatch = specificInstruction.match(sectionRegex('II'));
  if (!startMatch) return '';

  const startIdx = startMatch.index;
  const tail = specificInstruction.slice(startIdx);

  // Preferência 1: corte na próxima seção [VI ...].
  const sectionVI = tail.search(sectionRegex('VI'));
  if (sectionVI !== -1) return tail.slice(0, sectionVI).trim();

  // Preferência 2: separador "---" em linha própria depois do header da V.
  // O fallback existe pra casos em que o template não tem seção VI explícita
  // (V é a última e fecha com "---" + bloco de metadados).
  const vMatch = tail.match(sectionRegex('V'));
  if (vMatch) {
    const afterVStart = vMatch.index + vMatch[0].length;
    const afterV = tail.slice(afterVStart);
    const dashRel = afterV.search(/\n\s*---\s*(\n|$)/);
    if (dashRel !== -1) return tail.slice(0, afterVStart + dashRel).trim();
  }

  // Sem [VI] e sem "---" pós-V — devolve da II até o fim do prompt.
  return tail.trim();
}

// Apêndice = a seção "## Apêndice ..." do prompt de neuro (Beatriz-neuro.md).
// É o gabarito para quem desenha a avaliação — hipótese diagnóstica esperada,
// diagnósticos diferenciais, bateria sugerida e racional clínico —, marcado como
// "fora do personagem". Vai só pro avaliador (junto do Bloco 1); NUNCA pro
// paciente (o servidor também o remove do prompt do paciente).
const APENDICE_RE = /(^|\n)[ \t]*#{1,4}[ \t]*ap[êe]ndice\b[^\n]*/i;

// Extrai o apêndice (do cabeçalho "## Apêndice" até o fim), sem o rodapé
// "*Fim do prompt.*". Retorna '' se não houver apêndice.
export function extractApendice(specificInstruction) {
  if (!specificInstruction || typeof specificInstruction !== 'string') return '';
  const m = specificInstruction.match(APENDICE_RE);
  if (!m) return '';
  const start = m.index + (m[1] ? m[1].length : 0); // começa no '#'
  return specificInstruction
    .slice(start)
    .replace(/\n*\*?\s*fim do prompt\.?\s*\*?\s*$/i, '')
    .trim();
}

// Remove a seção do apêndice (e o separador "---" logo antes) do prompt — o que
// sobra é a persona (I–V) que o paciente encarna. Espelha o stripApendice do
// servidor; usado no preview/validação do formulário.
export function stripApendice(specificInstruction) {
  if (!specificInstruction || typeof specificInstruction !== 'string') return '';
  const m = specificInstruction.match(APENDICE_RE);
  if (!m) return specificInstruction.trim();
  const cut = m.index + (m[1] ? m[1].length : 0);
  return specificInstruction.slice(0, cut).replace(/\n*-{3,}[ \t]*$/, '').trim();
}
