// Cota diária de sessões do Aluno Externo — lógica PURA (sem express, sem disco).
//
// Regra: quem entra pelo auto-cadastro ('external') pode ABRIR no máximo 3
// atendimentos a cada 24h. A janela é DESLIZANTE (não zera à meia-noite): o
// slot mais antigo volta 24h depois de ter sido usado, que é exatamente o que a
// mensagem promete ("em 24 horas você conseguirá acessar novamente").
//
// O que consome um slot é ABRIR a sessão, não finalizá-la — senão bastava nunca
// mandar pra correção pra usar o app sem limite. Continuar uma sessão já aberta
// nunca é barrado: o slot dela já foi cobrado e o aluno precisa poder terminar
// o atendimento.
//
// COMO O SERVIDOR SABE QUE É UMA ABERTURA. Pela sua PRÓPRIA memória, nunca pelo
// que o cliente manda. A primeira versão decidia isso contando as mensagens do
// corpo da requisição ("chegou 1 turno = sessão nova"), e isso era um bypass
// completo: bastava enviar uma mensagem de enchimento antes da real pra nenhuma
// sessão ser cobrada, nunca. Hoje cada slot fica preso a uma CHAVE de sessão
// (tipo + paciente) que o servidor registra como aberta; enquanto ela estiver
// aberta, conversar é de graça. Finalizar o atendimento (salvar o log) fecha a
// chave, e reabrir aquele mesmo paciente volta a custar um slot.
//
// Mora fora do index.js pelo mesmo motivo de cadastro.js e scoring.js: regra
// pequena, muito testável, e o index já passa de 9 mil linhas.

const EXTERNAL_DAILY_SESSION_LIMIT = 3;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

// Texto exato mostrado ao aluno quando ele tenta abrir a 4ª sessão.
const QUOTA_MESSAGE =
  'Limitamos o uso de alunos externos para 3 sessões. Em 24 horas você conseguirá acessar novamente.';

// Só 'external' tem cota. Aluno interno, supervisor, admin, avaliador e
// visitante seguem sem limite diário.
function hasSessionQuota(role) {
  return role === 'external';
}

// Chave de uma sessão: o par tipo+paciente. Sem a categoria de propósito —
// Treino, Competitivo e Duelo contra o MESMO paciente contam como a mesma
// sessão. É uma folga deliberada: fechar a chave depende do log salvo, e o log
// não distingue as três, então uma chave mais fina ficaria aberta pra sempre.
function sessionKey(context) {
  const c = context || {};
  const tipo = String(c.type || '').slice(0, 20);
  const item = String(c.itemId || '').slice(0, 200);
  return tipo && item ? `${tipo}:${item}` : null;
}

// Aberturas ainda dentro da janela de 24h, normalizadas em { t, key }.
// Aceita o formato antigo (timestamp solto, sem chave) pra não invalidar a cota
// de quem já estava com sessões contadas quando esta versão subiu.
function pruneStarts(starts, now = Date.now()) {
  if (!Array.isArray(starts)) return [];
  return starts
    .map((r) => {
      if (typeof r === 'number') return { t: r, key: null };
      if (typeof r === 'string') return { t: Date.parse(r), key: null };
      if (r && typeof r === 'object') {
        const t = typeof r.t === 'number' ? r.t : Date.parse(r.t);
        return { t, key: typeof r.key === 'string' ? r.key : null };
      }
      return { t: NaN, key: null };
    })
    .filter((r) => Number.isFinite(r.t) && r.t > now - QUOTA_WINDOW_MS)
    .sort((a, b) => a.t - b.t);
}

// Estado da cota de um aluno: quanto usou, quanto sobra e quando o próximo slot
// abre. `resetAt` é 24h depois da abertura MAIS ANTIGA ainda válida — é o
// instante em que `remaining` deixa de ser 0.
function quotaState(starts, now = Date.now()) {
  const validos = pruneStarts(starts, now);
  const used = validos.length;
  const remaining = Math.max(0, EXTERNAL_DAILY_SESSION_LIMIT - used);
  return {
    enabled: true,
    limit: EXTERNAL_DAILY_SESSION_LIMIT,
    used,
    remaining,
    blocked: remaining === 0,
    resetAt: used ? new Date(validos[0].t + QUOTA_WINDOW_MS).toISOString() : null,
    message: QUOTA_MESSAGE,
  };
}

// Estado de quem não tem cota — mesmo shape, pra UI não precisar de if.
function unlimitedState() {
  return {
    enabled: false,
    limit: null,
    used: 0,
    remaining: null,
    blocked: false,
    resetAt: null,
    message: QUOTA_MESSAGE,
  };
}

// Registra uma abertura. Devolve a lista já podada + o novo registro.
function registerStart(starts, key, now = Date.now()) {
  return [...pruneStarts(starts, now), { t: now, key: key || null }];
}

// Esta chave já tem uma sessão aberta na janela? É o que torna "continuar"
// gratuito sem depender de nada que o cliente diga.
function hasOpenSession(starts, key, now = Date.now()) {
  if (!key) return false;
  return pruneStarts(starts, now).some((r) => r.key === key);
}

// Fecha a chave (o atendimento foi finalizado). O registro CONTINUA contando
// para a cota — o slot foi gasto —, só deixa de valer como "sessão aberta", pra
// que reabrir o mesmo paciente custe um slot novo.
function closeSession(starts, key, now = Date.now()) {
  if (!key) return pruneStarts(starts, now);
  return pruneStarts(starts, now).map((r) => (r.key === key ? { ...r, key: null } : r));
}

// Uma sessão nova chega no /api/chat com UM único turno: o "Iniciar" oculto que
// as três telas de sessão (Treino/Competitivo, Trilha e Duelo) mandam pra IA
// abrir o atendimento. Do segundo turno em diante é conversa em andamento — ou
// retomada de sessão salva (F5), que também traz o histórico inteiro.
function isSessionStart(messages) {
  if (!Array.isArray(messages)) return false;
  const turnos = messages.filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && String((m && m.content) || ''),
  );
  return turnos.length <= 1;
}

module.exports = {
  EXTERNAL_DAILY_SESSION_LIMIT,
  QUOTA_WINDOW_MS,
  QUOTA_MESSAGE,
  hasSessionQuota,
  pruneStarts,
  quotaState,
  unlimitedState,
  registerStart,
  sessionKey,
  hasOpenSession,
  closeSession,
  isSessionStart,
};
