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

// Quanto falta até `resetAt` (ISO), em texto curto: "3h 42min", "42min",
// "menos de 1 min". '' quando não há horário ou ele já passou.
export function formatarEspera(resetAt, agora = Date.now()) {
  const alvo = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(alvo) || alvo <= agora) return '';
  const min = Math.ceil((alvo - agora) / 60000);
  if (min <= 1) return 'menos de 1 min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}min`;
  return m ? `${h}h ${m}min` : `${h}h`;
}
