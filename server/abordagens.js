// Abordagem teórica do terapeuta: tags que a pessoa escolhe em Perfil →
// Identidade. É informação para QUEM LÊ os logs (supervisor, admin, pesquisa em
// psicologia comparada) e NÃO entra em nada da avaliação por IA: nenhum prompt,
// transcrição ou material do avaliador lê este campo.
//
// Mora na coluna `users.abordagem` (TEXT, de 001_contas.sql), como os ids
// separados por vírgula ("gestalt,tcc"). O id é estável; o rótulo pode mudar à
// vontade. Valor antigo em texto livre (o campo já existiu assim) não casa com
// id nenhum e simplesmente não aparece.
//
// ESPELHO: client/src/abordagens.js repete esta lista (o teste confere).

const ABORDAGENS = [
  // Ainda não ativa: aparece, mas ninguém pode selecionar.
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
  // Exclusiva: não combina com as outras.
  { id: 'outras', rotulo: 'Outras / Não tenho', ativa: true, exclusiva: true },
];

const POR_ID = new Map(ABORDAGENS.map((a) => [a.id, a]));
const ORDEM = new Map(ABORDAGENS.map((a, i) => [a.id, i]));

// Ids guardados na coluna → lista de ids conhecidos, na ordem do catálogo.
function lerAbordagens(texto) {
  const ids = String(texto || '').split(',').map((s) => s.trim()).filter((id) => POR_ID.has(id));
  return [...new Set(ids)].sort((a, b) => ORDEM.get(a) - ORDEM.get(b));
}

function gravarAbordagens(ids) {
  return lerAbordagens((ids || []).join(',')).join(',');
}

// O que o cliente mandou → { ids } ou { erro }. Recusa id desconhecido, tag
// inativa e a "Outras / Não tenho" junto de outra.
function validarAbordagens(lista) {
  if (!Array.isArray(lista)) return { erro: 'abordagens deve ser uma lista.' };
  if (lista.length > ABORDAGENS.length) return { erro: 'Abordagens demais.' };
  const ids = [...new Set(lista.map((v) => String(v ?? '').trim()))];
  for (const id of ids) {
    const a = POR_ID.get(id);
    if (!a) return { erro: 'Abordagem desconhecida.' };
    if (!a.ativa) return { erro: `A abordagem "${a.rotulo}" ainda não está disponível.` };
  }
  if (ids.length > 1 && ids.some((id) => POR_ID.get(id).exclusiva)) {
    return { erro: '"Outras / Não tenho" não combina com outras abordagens.' };
  }
  return { ids: lerAbordagens(ids.join(',')) };
}

module.exports = { ABORDAGENS, lerAbordagens, gravarAbordagens, validarAbordagens };
