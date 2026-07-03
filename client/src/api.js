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
    // Quando o corpo não é JSON (404 de rota não registrada, 500/502/504 em
    // HTML de proxy etc.), inclui o status pra não virar um "Erro desconhecido"
    // opaco — facilita diagnosticar (ex.: 404 = servidor não reiniciado).
    const err = await res.json().catch(() => null);
    throw new Error((err && err.error) || `Erro ${res.status}${res.statusText ? ' ' + res.statusText : ''} na requisição`);
  }
  return res.json();
}

// Fluxo do Processo Seletivo (candidato) — ISOLADO do auth global: usa um token
// de candidato próprio (passado explicitamente) e NUNCA dispara clearAuth/logout
// em 401, pra não derrubar uma sessão logada (avaliador/admin) aberta no mesmo
// navegador. Uma senha incorreta responde 401, e isso não pode deslogar ninguém.
async function selecaoRequest(path, { method = 'POST', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `Erro ${res.status} na requisição`);
    if (data && typeof data.daysLeft === 'number') err.daysLeft = data.daysLeft;
    throw err;
  }
  return data;
}

// Catálogo de testes neuropsicológicos: fixo no servidor, então cacheamos a
// promessa (uma requisição por sessão, compartilhada por admin + TestSelector).
let neuroTestsPromise = null;
function getNeuroTestsCached() {
  if (!neuroTestsPromise) {
    neuroTestsPromise = request('/neuro/tests').catch((err) => {
      neuroTestsPromise = null; // permite re-tentar depois de uma falha
      throw err;
    });
  }
  return neuroTestsPromise;
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
  // Gera (via gpt-5.4-mini) a descrição visual da aparência a partir da foto
  // (data URI). Não persiste — o perfil salva junto com a foto.
  describeAppearance: (photo) => request('/me/visual-description', { method: 'POST', body: { photo } }),

  // Processo Seletivo — candidato (token próprio, isolado do auth global)
  selecaoSenha: (password) => selecaoRequest('/selecao/senha', { body: { password } }),
  selecaoIniciar: (payload) => selecaoRequest('/selecao/iniciar', { body: payload }),
  selecaoChat: (token, messages) => selecaoRequest('/selecao/chat', { body: { messages }, token }),
  selecaoFinish: (token, payload) => selecaoRequest('/selecao/finish', { body: payload, token }),
  // Processo Seletivo — avaliador/admin (auth global normal)
  selecaoLogs: () => request('/selecao/logs'),
  selecaoDashboard: (range) => request(`/selecao/dashboard?range=${encodeURIComponent(range || 'month')}`),

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
  // Foto do paciente: { icon, full } (data URLs) ou { clear: true }.
  setFreeplayPhoto: (id, data) => request(`/freeplay/${id}/photo`, { method: 'PUT', body: data }),

  // Neuro
  getNeuro: () => request('/neuro'),
  createNeuro: (data) => request('/neuro', { method: 'POST', body: data }),
  updateNeuro: (id, data) => request(`/neuro/${id}`, { method: 'PUT', body: data }),
  deleteNeuro: (id) => request(`/neuro/${id}`, { method: 'DELETE' }),
  // Catálogo de testes neuropsicológicos (grupos [{category, tests:[{id,abbr,name}]}]).
  // Fixo — cacheado em memória depois do primeiro fetch.
  getNeuroTests: () => getNeuroTestsCached(),
  // Compara a seleção do aluno com o gabarito e revela os resultados do paciente.
  compareNeuroTests: (id, selectedTests) =>
    request(`/neuro/${id}/compare-tests`, { method: 'POST', body: { selectedTests } }),

  // Progress
  getProgress: (userId) => request(`/progress/${userId}`),
  saveProgress: (userId, data) => request(`/progress/${userId}`, { method: 'POST', body: data }),
  // Trilha — estatísticas da barra superior (concluídos, nível, constância)
  getTrilhaStats: (userId) => request(`/trilha/${userId}`),

  // Logs
  getLogs: (userId) => request(`/logs${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`),
  saveLog: (data) => request('/logs', { method: 'POST', body: data }),
  // Competitivo: avaliação assíncrona (nota em até 24h nos logs). Salva a sessão
  // pendente e retorna na hora ({ ok, pending, logId }) — sem nota/MMR.
  competitiveFinish: (data) => request('/competitive/finish', { method: 'POST', body: data }),
  getLogsPolicy: () => request('/logs/policy'),

  // Feedback (coletado do visitante ao fim da sessão: estrelas 0–5 + mensagem)
  submitFeedback: (data) => request('/feedback', { method: 'POST', body: data }),
  getAdminFeedback: () => request('/admin/feedback'),
  // Avaliação Independente v25 (Opus 4.8, 14 nós): { log, casoId } → 14 partes + nota 0–100.
  // payload: { log, casoId, evaluator, model, effort, batch }. batch:true → { queued, jobId }.
  avaliacaoIndependente: (payload) => request('/avaliacao-independente', { method: 'POST', body: payload }),
  avaliacaoFila: () => request('/avaliacao-independente/fila'),
  // Admin: dispara um aviso (notificação) pra todos + publica atualização.
  adminSendNotification: (data) => request('/admin/notifications', { method: 'POST', body: data }),
  adminSendUpdate: (data) => request('/admin/updates', { method: 'POST', body: data }),
  // Atualizações do sistema criadas pelo admin (mescladas com o changelog).
  getUpdates: () => request('/updates'),

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
  //
  // A resposta vem em STREAM (SSE) — o avaliador demora 30-90s e bufferar tudo
  // estourava o timeout de 100s do Cloudflare em produção. Aqui a gente lê os
  // deltas e remonta o texto, devolvendo o MESMO formato { role, content } de
  // antes (os chamadores não mudam). `onToken(delta, full)` é opcional, pra
  // quem quiser exibir o texto chegando ao vivo.
  // `onReasoning(delta, full)` é opcional: quando passado, o cliente pede o
  // resumo do raciocínio (showReasoning) e recebe eventos `data:{reasoning}`. O
  // servidor só envia esses eventos pra supervisor/admin — pro aluno fica vazio.
  evaluate: async (messages, context, onToken, onReasoning) => {
    const token = getToken();
    const wantReasoning = typeof onReasoning === 'function';
    const body = context ? { messages, context } : { messages };
    if (wantReasoning) body.showReasoning = true;
    const res = await fetch(BASE + '/evaluate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      clearAuth();
      notifySessionExpired();
      const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
      throw new Error(err.error || 'Sessão expirada');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro na avaliação' }));
      throw new Error(err.error || 'Erro na avaliação');
    }
    // Modo demonstração (sem API key) e erros pré-stream voltam como JSON.
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      return res.json();
    }
    // Stream SSE: acumula os deltas (eventos `data: {delta|done|error}`).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let reasoning = '';
    let streamError = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.delta) {
            full += obj.delta;
            if (onToken) { try { onToken(obj.delta, full); } catch {} }
          } else if (obj.reasoning) {
            reasoning += obj.reasoning;
            if (onReasoning) { try { onReasoning(obj.reasoning, reasoning); } catch {} }
          } else if (obj.error) {
            streamError = obj.error;
          }
        }
      }
    }
    if (streamError) throw new Error(streamError);
    return { role: 'assistant', content: full, reasoning };
  },

  // Profile
  getUser: (id) => request(`/users/${id}`),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: data }),
  getProfilePhotos: () => request('/profile-photos'),

  // Entrevistador
  getEntrevistadorPrompt: () => request('/entrevistador-prompt'),

  // Indicadores (constância, objetivos diários, metas)
  getGamification: (userId) => request(`/gamification/${userId}`),
  // Resgatar ("claim") uma conquista cumprida
  claimAchievement: (id) => request(`/achievements/${id}/claim`, { method: 'POST' }),

  // Ranking global de jogadores (não disponível pra visitante)
  getRanking: () => request('/ranking'),
  // MMR competitivo do próprio usuário (perfil / pós-sessão)
  getMyMmr: () => request('/me/mmr'),
  // Reset de ranking (admin): zera notas + progresso, preserva logs.
  adminResetRanking: () => request('/admin/ranking/reset', { method: 'POST' }),

  // Configurações da plataforma. getSettings: qualquer usuário (visitante inclui)
  // — o EchoSession usa pra saber se roda a avaliação do visitante.
  // adminUpdateSettings: toggle admin-only (ex.: { visitorEvaluationEnabled: true }).
  getSettings: () => request('/settings'),
  adminUpdateSettings: (data) => request('/admin/settings', { method: 'PUT', body: data }),

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
  // Cancela (exclui) um duelo ainda não aceito. Só funciona enquanto pendente.
  cancelDuel: (id) => request(`/duel/${id}`, { method: 'DELETE' }),
  // Baixa o log de um duelo (avaliação cruzada + notas + sessões) como arquivo.
  // Não usa o helper `request` porque o servidor responde com attachment.
  exportDuelLog: async (id) => {
    const token = getToken();
    const res = await fetch(`${BASE}/duel/${encodeURIComponent(id)}/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      let err = 'Erro ao baixar o log';
      try { const j = await res.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }
    const dispo = res.headers.get('content-disposition') || '';
    const match = dispo.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `duelo-${id}.txt`;
    const blob = await res.blob();
    return { blob, filename };
  },
  // Logs sociais: duelos agrupados por oponente.
  getSocialLogs: () => request('/duels/social'),

  // --- Progressão (avaliação de evolução em sessões repetidas) ---
  getProgressionPatients: () => request('/progression/available-patients'),
  evaluateProgression: (data) => request('/progression/evaluate', { method: 'POST', body: data }),

  // --- Sidequests (missões clínicas do Treinamento) ---
  // Aluno: sua sidequest ativa + concluídas.
  getMySidequest: () => request('/me/sidequest'),
  // Missão diária (rotaciona do banco): a do usuário (com status de conclusão).
  getMyDailyMission: () => request('/me/daily-mission'),
  // Supervisor/admin: banco de sidequests reutilizáveis.
  getSidequestBank: () => request('/sidequests/bank'),
  createSidequest: (data) => request('/sidequests/bank', { method: 'POST', body: data }),
  deleteSidequest: (id) => request(`/sidequests/bank/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Sidequests de um aluno (ativa + concluídas).
  getStudentSidequests: (userId) => request(`/sidequests/student/${encodeURIComponent(userId)}`),
  assignSidequest: (userId, sidequestId) =>
    request('/sidequests/assign', { method: 'POST', body: { userId, sidequestId } }),
  unassignSidequest: (userId) =>
    request('/sidequests/unassign', { method: 'POST', body: { userId } }),

  // --- Modo Desafio (titular-desafiante) ---
  // Mapa { characterId: titularSummary } pra renderizar os cards do FreePlay.
  // Visitantes Titulares aparecem como { isVisitor:true, name:"Um visitante" }.
  getTitulares: () => request('/desafio/titulares'),
  // Coroas (👑) do usuário logado — personagens onde ele é Titular atual.
  // Já vem em /api/me como user.crowns; este endpoint serve pra refresh
  // após perder/ganhar coroa sem precisar refazer login.
  getMyCrowns: () => request('/me/crowns'),
  // Estado de uma sessão de Desafio antes de começar: 'reivindicar' (sem
  // Titular), 'desafiar' (com Titular) ou 'auto-titular' (você já é).
  getDesafioState: (characterId) => request(`/desafio/state/${encodeURIComponent(characterId)}`),
  // Reivindica a posição de Titular (não há Titular atual). Independente da
  // nota — o aluno vira Titular ao final do atendimento.
  // Reivindica o Titular (não há Titular atual). Vira Titular sempre, mas agora
  // recebe avaliação individual (v15) opaca em SSE — mesmo padrão de stream do
  // desafiar. Quando não há avaliador (visitante sem toggle / sem chave), o
  // servidor devolve JSON cru (kind:'claimed', evaluation:''). onToken(delta,
  // full) opcional pra exibir o feedback chegando ao vivo.
  reivindicarTitular: async (data, onToken) => {
    const token = getToken();
    const res = await fetch(BASE + '/desafio/reivindicar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    if (res.status === 401) {
      clearAuth();
      notifySessionExpired();
      const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
      throw new Error(err.error || 'Sessão expirada');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro ao reivindicar' }));
      throw new Error(err.error || 'Erro ao reivindicar');
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      // Sem avaliador (visitante sem toggle / sem chave) — JSON cru.
      return res.json();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let finalPayload = null;
    let streamError = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.delta) {
            full += obj.delta;
            if (onToken) { try { onToken(obj.delta, full); } catch {} }
          } else if (obj.done) {
            finalPayload = obj;
          } else if (obj.error && !obj.done) {
            streamError = obj.error;
          }
        }
      }
    }
    if (streamError) throw new Error(streamError);
    return { evaluationStream: full, ...(finalPayload || {}) };
  },
  // Desafia o Titular atual via SSE: stream do avaliador titular-desafiante
  // + evento final `data:{done, outcome, evaluation, justification, titular}`.
  // onToken(delta, full) opcional pra exibir o texto chegando ao vivo.
  desafiarTitular: async (data, onToken) => {
    const token = getToken();
    const res = await fetch(BASE + '/desafio/desafiar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    if (res.status === 401) {
      clearAuth();
      notifySessionExpired();
      const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
      throw new Error(err.error || 'Sessão expirada');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro no desafio' }));
      throw new Error(err.error || 'Erro no desafio');
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      // Modo demonstração / fallback sem stream — devolve JSON cru.
      return res.json();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let finalPayload = null;
    let streamError = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          if (obj.delta) {
            full += obj.delta;
            if (onToken) { try { onToken(obj.delta, full); } catch {} }
          } else if (obj.done) {
            finalPayload = obj;
          } else if (obj.error) {
            streamError = obj.error;
          }
        }
      }
    }
    if (streamError) throw new Error(streamError);
    return { evaluationStream: full, ...(finalPayload || {}) };
  },

  // --- Notificações in-app ---
  getNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST', body: {} }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST', body: {} }),
};
