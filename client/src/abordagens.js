// Tags de abordagem teórica do terapeuta (Perfil → Identidade). Só para quem lê
// os logs — não entra em nada da avaliação por IA.
//
// ESPELHO de server/abordagens.js, que valida o que chega (o teste confere que
// as duas listas são iguais). Mudou lá, mude aqui.
export const ABORDAGENS = [
  { id: 'allos', rotulo: 'Allos', ativa: false },
  { id: 'junguiana', rotulo: 'Psicologia Junguiana', ativa: true },
  { id: 'gestalt', rotulo: 'Gestalt-Terapia', ativa: true },
  { id: 'acp', rotulo: 'Abordagem Centrada na Pessoa', ativa: true },
  { id: 'humanista', rotulo: 'Humanista-Fenomenológica', ativa: true },
  { id: 'psicanalise', rotulo: 'Psicanálise (Lacan / Freud)', ativa: true },
  { id: 'psicanalises-contemporaneas', rotulo: 'Psicanálises Contemporâneas', ativa: true },
  { id: 'contextuais', rotulo: 'Terapias Contextuais / PBE', ativa: true },
  { id: 'tcc', rotulo: 'Terapia Cognitivo Comportamental', ativa: true },
  { id: 'analise-comportamento', rotulo: 'Análise do Comportamento', ativa: true },
  { id: 'sistemicas', rotulo: 'Escolas Sistêmicas', ativa: true },
  { id: 'transpessoais', rotulo: 'Psicologias Transpessoais / Psicodrama', ativa: true },
  { id: 'socio-historica', rotulo: 'Psicologia Sócio-Histórica / Crítica / Esquizoanálise', ativa: true },
  { id: 'outras', rotulo: 'Outras / Não tenho', ativa: true, exclusiva: true },
];

const POR_ID = new Map(ABORDAGENS.map((a) => [a.id, a]));

export function rotuloDaAbordagem(id) {
  const a = POR_ID.get(id);
  return a ? a.rotulo : null;
}

// Liga/desliga uma tag na seleção, respeitando a exclusiva ("Outras / Não
// tenho" sai quando outra entra, e vice-versa). Tag inativa não entra.
export function alternarAbordagem(selecionadas, id) {
  const a = POR_ID.get(id);
  if (!a || !a.ativa) return selecionadas;
  if (selecionadas.includes(id)) return selecionadas.filter((x) => x !== id);
  if (a.exclusiva) return [id];
  return [...selecionadas.filter((x) => !POR_ID.get(x)?.exclusiva), id];
}
