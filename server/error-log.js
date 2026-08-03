// Registro de erros do servidor — alimenta o painel "Logs de Erro" do admin.
//
// Motivo de existir: as respostas de erro devolviam `err.message` cru ao
// usuário, o que vazava provedor de IA, modelo, estado de cota, ids de request
// e caminhos absolutos do disco. Agora o usuário recebe uma mensagem genérica
// mais um CÓDIGO curto, e o detalhe inteiro fica aqui, visível só pro admin.
// O código é a ponte: o usuário diz "deu erro, código err-xyz" e o admin acha
// a entrada exata no painel.
//
// Este arquivo é puro (sem IO): quem lê e grava o JSON é o server/index.js,
// que já tem readJSON/writeJSON apontando pro DATA_DIR. Isso mantém o módulo
// testável sem tocar em disco.

const crypto = require('crypto');

// Arquivo no DATA_DIR (volume persistente em produção).
const ERROR_LOG_FILE = 'error-logs.json';

// Teto de entradas guardadas. O painel é pra diagnóstico recente, não é
// histórico eterno — e o arquivo é reescrito inteiro a cada gravação, então
// deixar crescer sem limite tornaria cada erro mais caro que o anterior.
const MAX_ENTRIES = 500;

// Além do teto, descarta o que é velho demais pra ser útil.
const TTL_DAYS = 30;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

// Quantas linhas de stack guardar. As primeiras já dizem onde estourou; o
// resto é ruído de node_modules.
const STACK_LINES = 6;

// Mensagem genérica padrão. Quem chama pode passar uma mais específica, mas
// nunca deve montar a partir do erro real.
const GENERIC_MESSAGE = '😵‍💫 Algo deu errado do nosso lado. Tente novamente em instantes.';

// Junta a mensagem visível com o código curto. É a ÚNICA forma de montar
// resposta de erro pro usuário — assim nenhum ponto do app volta a concatenar
// err.message por descuido. O código é o que o usuário repassa pro suporte.
function userFacingError(id, message = GENERIC_MESSAGE) {
  return { error: `${message} (código ${id})`, errorId: id };
}

function newErrorId() {
  return `err-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Remove segredo que porventura apareça no texto do erro. Provedores de IA às
// vezes ecoam trechos da request em mensagens de erro, e este arquivo é lido
// por humanos e pode ser copiado pra fora do servidor.
function redact(text) {
  return String(text == null ? '' : text)
    .replace(/\b(sk|sk-ant|sk-proj|ghp|gho|xai|glm)-[A-Za-z0-9_-]{8,}/gi, '$1-[REDIGIDO]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDIGIDO]')
    .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}["']?/gi, '$1=[REDIGIDO]');
}

function clip(text, max) {
  const s = redact(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Quem estava logado. Cobre os três tipos de sessão do app: usuário real,
// visitante anônimo e candidato do processo seletivo (que tem auth própria).
function describeActor(req) {
  if (!req) return { id: null, username: null, role: 'desconhecido' };
  if (req.user) {
    return {
      id: req.user.id || null,
      username: req.user.username || null,
      role: req.user.role || 'desconhecido',
    };
  }
  if (req.candidate) {
    // Candidato é efêmero e os dados dele são pessoais (nome/e-mail/WhatsApp).
    // Pro diagnóstico basta saber que foi o fluxo do seletivo.
    return { id: req.candidate.sub || null, username: null, role: 'candidate' };
  }
  return { id: null, username: null, role: 'anônimo' };
}

// Monta a entrada. `where` é o rótulo humano do ponto de falha (ex.:
// 'chat/paciente'), que é o que o admin lê primeiro na lista.
function buildErrorEntry({ err, req, where, status = 500, extra = null, ip = null } = {}) {
  const e = err || {};
  const stack = typeof e.stack === 'string'
    ? clip(e.stack.split('\n').slice(0, STACK_LINES).join('\n'), 2000)
    : null;
  return {
    id: newErrorId(),
    timestamp: new Date().toISOString(),
    where: String(where || 'desconhecido'),
    message: clip(e.message || e || 'erro sem mensagem', 1000),
    name: e.name ? String(e.name).slice(0, 80) : null,
    status,
    method: (req && req.method) || null,
    path: req ? clip((req.originalUrl || req.url || '').split('?')[0], 200) : null,
    actor: describeActor(req),
    ip: ip ? String(ip).slice(0, 60) : null,
    extra: extra || null,
    stack,
  };
}

// Insere no topo (mais recente primeiro) e poda por idade e por teto.
function appendError(list, entry) {
  const arr = Array.isArray(list) ? list : [];
  const cutoff = Date.now() - TTL_MS;
  const fresh = arr.filter((it) => {
    const t = new Date((it && it.timestamp) || 0).getTime();
    // Entrada com timestamp ilegível fica — descartar às cegas esconderia erro.
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  return [entry, ...fresh].slice(0, MAX_ENTRIES);
}

module.exports = {
  ERROR_LOG_FILE,
  MAX_ENTRIES,
  TTL_DAYS,
  GENERIC_MESSAGE,
  userFacingError,
  newErrorId,
  redact,
  buildErrorEntry,
  appendError,
};
