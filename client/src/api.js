const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
    throw new Error(err.error || 'Erro na requisição');
  }
  return res.json();
}

export const api = {
  login: (username, password) => request('/login', { method: 'POST', body: { username, password } }),

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
  getLogs: (userId) => request(`/logs${userId ? `?userId=${userId}` : ''}`),
  saveLog: (data) => request('/logs', { method: 'POST', body: data }),

  // Chat (chat completions)
  chat: (messages, systemPrompt) => request('/chat', { method: 'POST', body: { messages, systemPrompt } }),

  // Assistants API (FreePlay/Neuro com assistant_id)
  createThread: () => request('/assistants/thread', { method: 'POST', body: {} }),
  assistantMessage: (threadId, assistantId, message) =>
    request('/assistants/message', { method: 'POST', body: { threadId, assistantId, message } }),

  // Transcribe
  transcribe: (audioBase64) => request('/transcribe', { method: 'POST', body: { audio: audioBase64 } }),

  // Avaliação. Se systemPrompt é fornecido, sobrescreve o avaliador global Allos
  // (usado pela Trilha, que tem prompt do avaliador customizado por exercício).
  evaluate: (messages, systemPrompt) =>
    request('/evaluate', {
      method: 'POST',
      body: systemPrompt ? { messages, systemPrompt } : { messages },
    }),

  // Profile
  getUser: (id) => request(`/users/${id}`),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),
  getProfilePhotos: () => request('/profile-photos'),
};
