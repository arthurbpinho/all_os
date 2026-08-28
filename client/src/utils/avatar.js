// A foto a exibir para um usuário.
//
// O servidor manda DOIS campos: `profilePhoto` (o que está gravado na conta) e
// `defaultPhoto` (uma imagem da pool de fotos padrão que o admin monta em
// Administração → Contas). O segundo só vem para quem NÃO tem foto própria —
// nunca subiu uma, ou está ainda com a foto de fábrica — então a precedência
// aqui é direta e não precisa saber qual é a foto de fábrica.
//
// Os dois campos existem separados de propósito: o Perfil grava de volta o que
// está em `profilePhoto`, e substituir ali faria a pessoa "adotar" sem querer
// uma imagem da pool, que o admin pode remover depois.
export function fotoDoUsuario(u) {
  if (!u) return '';
  return u.defaultPhoto || u.profilePhoto || '';
}
