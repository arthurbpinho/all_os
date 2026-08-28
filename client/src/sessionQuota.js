// Lado cliente da cota diária de sessões do Aluno Externo (regra em
// server/session-quota.js). Só consulta e traduz — a decisão é sempre do
// servidor, que barra o primeiro turno do chat com 429.
import { api } from './api';

// Chamado antes de abrir uma sessão: devolve a mensagem do aviso quando a cota
// está esgotada, ou '' quando pode seguir. Falha de rede NÃO bloqueia — seria
// tirar a sessão de quem ainda tem direito a ela por causa de um GET; se a cota
// realmente acabou, o /api/chat barra na sequência.
//
// `contexto` ({ type, itemId }) é a sessão que está sendo aberta. Precisa ir
// junto porque retomar um atendimento JÁ aberto é liberado mesmo com a cota
// esgotada — sem o contexto, a tela barraria quem só quer terminar o que
// começou, enquanto o /api/chat deixaria passar.
export async function sessionQuotaBlockMessage(contexto) {
  try {
    const cota = await api.sessionQuota(contexto);
    return cota && cota.blocked ? cota.message : '';
  } catch {
    return '';
  }
}

// Mesma mensagem quando ela chega dentro do erro do /api/chat (429) — caminho
// de quem burlou a checagem acima ou estourou a cota em outra aba.
export function sessionQuotaMessageFromError(err) {
  const corpo = err && err.body;
  return corpo && corpo.sessionQuota && corpo.sessionQuota.blocked ? corpo.error : '';
}
