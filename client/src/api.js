const BASE = '/api';
const TOKEN_KEY = 'allos_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
export function clearAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('allos_user');
  } catch {}
}

// Listeners notificados quando o token é considerado inválido (401).
const sessionListeners = new Set();
export function onSessionExpired(fn) {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}
function notifySessionExpired() {
  for (const fn of sessionListeners) {
    try { fn(); } catch {}
  }
}

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    clearAuth();
    notifySessionExpired();
    const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
    throw new Error(err.error || 'Sessão expirada');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
    throw new Error(err.error || 'Erro na requisição');
  }
  return res.json();
}

export const api = {
  // Auth
  login: async (username, password) => {
    const data = await request('/login', { method: 'POST', body: { username, password } });
    if (data && data.token) setToken(data.token);
    return data && data.user ? data.user : data;
  },
  loginVisitor: async () => {
    const data = await request('/login/visitor', { method: 'POST', body: {} });
    if (data && data.token) setToken(data.token);
    return data && data.user ? data.user : data;
  },
  logout: () => { clearAuth(); },
  me: () => request('/me'),
  changeMyPassword: (currentPassword, newPassword) =>
    request('/me/password', { method: 'POST', body: { currentPassword, newPassword } }),
  // Título (subtítulo) ativo exibido no perfil/ranking. titleId vazio limpa.
  setMyTitle: (titleId) => request('/me/title', { method: 'POST', body: { titleId } }),

  // Exercises
  getExercises: () => request('/exercises'),
  createExercise: (data) => request('/exercises', { method: 'POST', body: data }),
  updateExercise: (id, data) => request(`/exercises/${id}`, { method: 'PUT', body: data }),
  deleteExercise: (id) => request(`/exercises/${id}`, { method: 'DELETE' }),

  // FreePlay
  getFreeplay: () => request('/freeplay'),
  createFreeplay: (data) => request('/freeplay', { method: 'POST', body: data }),
  updateFreeplay: (id, data) => request(`/freeplay/${id}`, { method: 'PUT', body: data }),
  deleteFreeplay: (id) => request(`/freeplay/${id}`, { method: 'DELETE' }),

  // Neuro
  getNeuro: () => request('/neuro'),
  createNeuro: (data) => request('/neuro', { method: 'POST', body: data }),
  updateNeuro: (id, data) => request(`/neuro/${id}`, { method: 'PUT', body: data }),
  deleteNeuro: (id) => request(`/neuro/${id}`, { method: 'DELETE' }),

  // Progress
  getProgress: (userId) => request(`/progress/${userId}`),
  saveProgress: (userId, data) => request(`/progress/${userId}`, { method: 'POST', body: data }),

  // Logs
  getLogs: (userId) => request(`/logs${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  saveLog: (data) => request('/logs', { method: 'POST', body: data }),
  getLogsPolicy: () => request('/logs/policy'),

  // Chat (chat completions). O servidor resolve o systemPrompt a partir de
  // context: { type, itemId } — NUNCA mande systemPrompt do cliente
  // (o backend rejeita com 400). maxTokens só é honrado em mode 'entrevistador'.
  chat: (messages, context, maxTokens) =>
    request('/chat', { method: 'POST', body: { messages, context, maxTokens } }),

  // Chat com o entrevistador (admin-only). O servidor usa o prompt do
  // entrevistador internamente.
  adminEntrevistadorChat: (messages, maxTokens) =>
    request('/chat', { method: 'POST', body: { messages, mode: 'entrevistador', maxTokens } }),

  // Transcribe
  transcribe: (audioBase64) => request('/transcribe', { method: 'POST', body: { audio: audioBase64 } }),

  // Avaliação. O servidor decide entre avaliador customizado (quando o
  // exercício tem evaluatorPrompt) e o avaliador global a partir de context.
  // Para a Avaliação Independente (transcrição manual), passe sem context.
  evaluate: (messages, context) =>
    request('/evaluate', {
      method: 'POST',
      body: context ? { messages, context } : { messages },
    }),

  // Profile
  getUser: (id) => request(`/users/${id}`),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),
  getProfilePhotos: () => request('/profile-photos'),

  // Entrevistador
  getEntrevistadorPrompt: () => request('/entrevistador-prompt'),

  // Indicadores (constância, objetivos diários, metas)
  getGamification: (userId) => request(`/gamification/${userId}`),

  // Ranking global de jogadores (não disponível pra visitante)
  getRanking: () => request('/ranking'),
  // MMR competitivo do próprio usuário (perfil / pós-sessão)
  getMyMmr: () => request('/me/mmr'),
  // Reset de ranking (admin): zera notas + progresso, preserva logs.
  adminResetRanking: () => request('/admin/ranking/reset', { method: 'POST' }),

  // Sessões ativas (não finalizadas) — sobreviver F5/sair e voltar
  listActiveSessions: () => request('/active-sessions'),
  getActiveSession: (type, itemId) => request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`),
  saveActiveSession: (type, itemId, data) =>
    request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`, { method: 'PUT', body: data }),
  clearActiveSession: (type, itemId) =>
    request(`/active-sessions/${type}/${encodeURIComponent(itemId)}`, { method: 'DELETE' }),

  // Admin: export completo (backup / migração pra SQL).
  // Não usa o helper `request` porque o servidor responde com
  // Content-Disposition: attachment — queremos preservar o filename e baixar
  // como blob, não fazer res.json().
  adminExportData: async () => {
    const token = getToken();
    const res = await fetch(BASE + '/admin/export', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let err = 'Erro ao exportar';
      try { const j = await res.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }
    // Extrai filename do header (fallback pra um nome default)
    const dispo = res.headers.get('content-disposition') || '';
    const match = dispo.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `allos-export-${new Date().toISOString().slice(0,10)}.json`;
    const blob = await res.blob();
    return { blob, filename };
  },

  // Admin: gestão de contas
  adminListUsers: () => request('/admin/users'),
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: data }),
  adminUpdateUser: (id, data) => request(`/admin/users/${id}`, { method: 'PUT', body: data }),
  adminDeleteUser: (id) => request(`/admin/users/${id}`, { method: 'DELETE' }),
  adminResetPassword: (id, newPassword) =>
    request(`/admin/users/${id}/reset-password`, { method: 'POST', body: { newPassword } }),

  // Professor: alunos vinculados
  getMyStudents: () => request('/teacher/students'),

  // --- Duelos (avaliação comparada entre dois alunos) ---
  // Lista de oponentes possíveis (terapeutas do sistema, exceto você).
  getDuelOpponents: () => request('/duel/opponents'),
  // Cria um duelo. data: { characterId, opponentUserId?, inviteMethod: 'system'|'whatsapp' }
  createDuel: (data) => request('/duel', { method: 'POST', body: data }),
  getDuel: (id) => request(`/duel/${id}`),
  // Resumo por token (tela de aceitar via link — funciona pra visitante também).
  getDuelByToken: (token) => request(`/duel/by-token/${encodeURIComponent(token)}`),
  acceptDuelByToken: (token) => request(`/duel/by-token/${encodeURIComponent(token)}/accept`, { method: 'POST', body: {} }),
  // Aceitar duelo recebido por notificação (convite in-app).
  acceptDuel: (id) => request(`/duel/${id}/accept`, { method: 'POST', body: {} }),
  // Submete a sessão de um lado. data: { messages, durationSeconds }
  submitDuel: (id, data) => request(`/duel/${id}/submit`, { method: 'POST', body: data }),
  // Logs sociais: duelos agrupados por oponente.
  getSocialLogs: () => request('/duels/social'),

  // --- Notificações in-app ---
  getNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST', body: {} }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST', body: {} }),
};
