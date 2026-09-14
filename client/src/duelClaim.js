// Duelo feito como visitante, a caminho de uma conta nova.
//
// O servidor entrega um "vale" (claimToken) no fim do duelo do visitante. Ele
// fica aqui entre a tela do duelo e a de cadastro, que o envia junto do
// formulário; ao confirmar o e-mail, o duelo passa para a conta criada.
//
// sessionStorage e não localStorage de propósito: num computador compartilhado
// (laboratório da faculdade), a próxima pessoa a se cadastrar herdaria o duelo
// — e as transcrições — de quem usou a máquina antes.
const KEY = 'allos_duel_claim';

export function guardarDuelClaim(claim) {
  try { sessionStorage.setItem(KEY, JSON.stringify(claim)); } catch { /* modo privado */ }
}

export function lerDuelClaim() {
  try {
    const c = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return c && typeof c.token === 'string' ? c : null;
  } catch {
    return null;
  }
}

export function limparDuelClaim() {
  try { sessionStorage.removeItem(KEY); } catch { /* modo privado */ }
}
