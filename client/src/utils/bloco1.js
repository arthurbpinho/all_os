// Extrai o "Bloco 1" do prompt do personagem (specificInstruction).
//
// Bloco 1 = parte do prompt que vai do início de "## [II. IDENTIDADE]" até
// o final de "## [V. ABERTURA E CONTINUIDADE]". Esse trecho funciona como
// gabarito/critério de correção pro avaliador — descreve quem é o paciente,
// suas camadas, voz, dinâmica e abertura.
//
// O fim é detectado pela primeira ocorrência (após o início) de:
//   - "## [VI." — próxima seção
//   - "---" em linha própria — separador final do template
//   - fim do texto
//
// Retorna o trecho trimado, ou string vazia se não encontrar a seção II.
export function extractBloco1(specificInstruction) {
  if (!specificInstruction || typeof specificInstruction !== 'string') return '';

  const startRe = /##\s*\[\s*II\.\s*IDENTIDADE\s*\]/i;
  const startMatch = specificInstruction.match(startRe);
  if (!startMatch) return '';

  const startIdx = startMatch.index;
  const tail = specificInstruction.slice(startIdx);

  // Procura, no que vem depois, o primeiro fim válido.
  const candidates = [];
  const sectionVI = tail.search(/##\s*\[\s*VI\./i);
  if (sectionVI !== -1) candidates.push(sectionVI);
  // Separador "---" só conta se vier DEPOIS de [V. ABERTURA E CONTINUIDADE].
  const vMatch = tail.match(/##\s*\[\s*V\.\s*ABERTURA\s+E\s+CONTINUIDADE\s*\]/i);
  if (vMatch) {
    const afterV = tail.slice(vMatch.index + vMatch[0].length);
    const dashRel = afterV.search(/\n\s*---\s*(\n|$)/);
    if (dashRel !== -1) candidates.push(vMatch.index + vMatch[0].length + dashRel);
  }

  const endIdx = candidates.length > 0 ? Math.min(...candidates) : tail.length;
  return tail.slice(0, endIdx).trim();
}
