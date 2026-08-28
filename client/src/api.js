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

// Caminho de prompt na URL: encoda cada segmento (há espaço em "nova
// avaliacao/") mas preserva as barras, que fazem parte da rota curinga.
function encodePromptPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

// GET de resposta em TEXTO puro (endpoints que devolvem .txt pronto pra baixar).
// O `request` faz res.json() e não serve pra eles.
async function requestText(path, oque = 'baixar o arquivo') {
  const token = getToken();
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error((err && err.error) || `Erro ${res.status} ao ${oque}`);
  }
  return res.text();
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
    const e = new Error((err && err.error) || `Erro ${res.status}${res.statusText ? ' ' + res.statusText : ''} na requisição`);
    // Status e corpo ficam disponíveis pra quem precisa reagir ao ERRO
    // específico (ex.: 429 da cota do Aluno Externo, que vira modal em vez de
    // uma bolha "Erro: ..." no chat).
    e.status = res.status;
    e.body = err;
    throw e;
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

// Poll do job de avaliação em Batch da Trilha (exercício com avaliador OpenAI
// — ver /api/evaluate no server, que devolve {pending:true, jobId} nesse caso
// em vez de abrir o SSE). Backoff simples 4s → dobra até um teto de 60s; pode
// levar minutos a até 24h, mesma natureza do Batch do Competitivo.
async function pollTrilhaEvalBatch(jobId) {
  let delay = 4000;
  for (;;) {
    const data = await request(`/trilha/evaluate-batch/${encodeURIComponent(jobId)}`);
    if (data.status === 'completed') {
      return { role: 'assistant', content: data.content || '', reasoning: '', usage: data.usage || null };
    }
    if (data.status === 'error') {
      throw new Error(data.error || 'Falha na avaliação em lote.');
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 60000);
  }
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
  // Trocar a senha invalida TODOS os tokens da conta (inclusive o que esta tela
  // está usando), então o servidor devolve um novo — sem guardá-lo aqui, a
  // próxima chamada levaria 401 e derrubaria a pessoa pro login logo depois de
  // ela ter trocado a senha com sucesso.
  changeMyPassword: async (currentPassword, newPassword) => {
    const data = await request('/me/password', { method: 'POST', body: { currentPassword, newPassword } });
    if (data && data.token) setToken(data.token);
    return data;
  },

  // Exclusão da PRÓPRIA conta — pede senha atual (ver server/index.js pros
  // limites: admin e supervisor com alunos vinculados são bloqueados lá).
  deleteMyAccount: (password) => request('/me', { method: 'DELETE', body: { password } }),

  // --- Cadastro público (Aluno Externo) e recuperação de conta ---
  // Todas sem token: são as rotas de quem ainda não tem (ou perdeu) a conta.
  config: () => request('/config'),
  cadastrar: (payload) => request('/cadastro', { method: 'POST', body: payload }),
  cadastroDisponibilidade: (username) =>
    request(`/cadastro/disponibilidade?username=${encodeURIComponent(username)}`),
  cadastroReenviar: (email) => request('/cadastro/reenviar', { method: 'POST', body: { email } }),
  // Atende os dois links que chegam por e-mail: cadastro novo e troca de
  // endereço. Quando é cadastro, a resposta já vem com o token de sessão.
  confirmarEmail: async (token) => {
    const data = await request('/confirmar-email', { method: 'POST', body: { token } });
    if (data && data.token) setToken(data.token);
    return data;
  },
  esqueciSenha: (email, turnstileToken) =>
    request('/senha/esqueci', { method: 'POST', body: { email, turnstileToken } }),
  redefinirSenha: (token, newPassword) =>
    request('/senha/redefinir', { method: 'POST', body: { token, newPassword } }),
  // Troca do e-mail da própria conta: exige a senha atual e só vale depois de
  // confirmar o endereço novo pelo link.
  trocarMeuEmail: (senhaAtual, novoEmail) =>
    request('/me/email', { method: 'POST', body: { senhaAtual, novoEmail } }),
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
  selecaoSenhaConfig: () => request('/selecao/senha-config'),
  selecaoTrocarSenha: (password) => request('/selecao/senha-config', { method: 'PUT', body: { password } }),

  // Exercises
  getExercises: () => request('/exercises'),
  createExercise: (data) => request('/exercises', { method: 'POST', body: data }),
  updateExercise: (id, data) => request(`/exercises/${id}`, { method: 'PUT', body: data }),
  deleteExercise: (id) => request(`/exercises/${id}`, { method: 'DELETE' }),
  // Avatar da IA do exercício (a "bolinha" no chat da Trilha): { icon, full } (data URLs) ou { clear: true }.
  setExercisePhoto: (id, data) => request(`/exercises/${id}/photo`, { method: 'PUT', body: data }),

  // Trilha — competências (etiquetas dos exercícios, editáveis pelo admin)
  getTrilhaSkills: () => request('/trilha-skills'),
  createTrilhaSkill: (data) => request('/trilha-skills', { method: 'POST', body: data }),
  updateTrilhaSkill: (id, data) => request(`/trilha-skills/${id}`, { method: 'PUT', body: data }),
  deleteTrilhaSkill: (id) => request(`/trilha-skills/${id}`, { method: 'DELETE' }),

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
  deleteAdminFeedback: (id) => request(`/admin/feedback/${id}`, { method: 'DELETE' }),
  // Suporte: mensagem do usuário pra administração. Cai no painel de Logs de
  // Erro do admin; devolve { codigo } pra pessoa guardar. { subject?, message }
  sendSupportMessage: (data) => request('/suporte', { method: 'POST', body: data }),
  // Avaliação Independente (laboratório de pricing do AVALIADOR): { log, casoId }
  // → nota 0–100 + as partes por critério (uma por nó, nos avaliadores de pipeline).
  // payload: { log, casoId, evaluator, model, effort, batch }. batch:true → { queued, jobId }.
  avaliacaoIndependente: (payload) => request('/avaliacao-independente', { method: 'POST', body: payload }),
  avaliacaoFila: () => request('/avaliacao-independente/fila'),
  // Resumo do raciocínio de uma avaliação (v28) — resposta é TEXTO puro, não
  // JSON, então não passa pelo `request` (que faz res.json()).
  avaliacaoReasoning: async (id) => {
    const token = getToken();
    const res = await fetch(`${BASE}/avaliacao-independente/${encodeURIComponent(id)}/reasoning`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error((err && err.error) || `Erro ${res.status} ao baixar o raciocínio`);
    }
    return res.text();
  },
  // Simulação Independente (laboratório de pricing do PACIENTE): catálogo de
  // modelos/preços + um turno de conversa. A resposta traz `turno` com tokens,
  // custo em USD e latência daquela chamada — é o que a tela mostra em tempo real.
  simIndependenteModelos: () => request('/simulacao-independente/modelos'),
  simIndependenteChat: (payload) => request('/simulacao-independente/chat', { method: 'POST', body: payload }),
  // Benchmarking de Simulação (laboratório de capacidade do PACIENTE com ALUNO
  // SIMULADO): sobe o log de um atendimento, a IA extrai a persona de quem
  // atendeu e refaz o caso pelo nº de interações pedido. Roda em background —
  // `benchStart` devolve { id } e a tela faz polling em `benchRun`. Sem avaliação.
  benchOpcoes: () => request('/benchmark-simulacao/opcoes'),
  benchStart: (payload) => request('/benchmark-simulacao', { method: 'POST', body: payload }),
  benchFila: () => request('/benchmark-simulacao/fila'),
  benchRun: (id) => request(`/benchmark-simulacao/${encodeURIComponent(id)}`),
  benchCancelar: (id) => request(`/benchmark-simulacao/${encodeURIComponent(id)}/cancelar`, { method: 'POST', body: {} }),
  // Log completo e resumo do raciocínio: TEXTO puro (dois arquivos separados, o
  // raciocínio nunca vem junto do log), então não passam pelo `request`.
  benchLogTxt: (id) => requestText(`/benchmark-simulacao/${encodeURIComponent(id)}/log`, 'baixar o log'),
  benchReasoningTxt: (id) => requestText(`/benchmark-simulacao/${encodeURIComponent(id)}/reasoning`, 'baixar o raciocínio'),
  benchPersonaTxt: (id) => requestText(`/benchmark-simulacao/${encodeURIComponent(id)}/persona`, 'baixar a ficha de persona'),
  // LOTE: os modelos escolhidos, mesmo caso, mesma ficha de persona (extraída uma
  // vez só — é o que torna a comparação válida). `modo`: 'fila' (um modelo por
  // vez, sem risco de TPM) ou 'paralelo' (todos juntos).
  benchLoteStart: (payload) => request('/benchmark-simulacao/lote', { method: 'POST', body: payload }),
  benchLotes: () => request('/benchmark-simulacao/lotes'),
  benchLote: (id) => request(`/benchmark-simulacao/lote/${encodeURIComponent(id)}`),
  benchLoteCancelar: (id) => request(`/benchmark-simulacao/lote/${encodeURIComponent(id)}/cancelar`, { method: 'POST', body: {} }),
  benchLoteRelatorioTxt: (id) => requestText(`/benchmark-simulacao/lote/${encodeURIComponent(id)}/relatorio`, 'baixar o relatório do lote'),
  // TRI dos personagens: dificuldade ÚNICA, alimentada por competitivo +
  // processo seletivo + visitante juntos. Cumulativo — sem recorte por período.
  triPersonagens: () => request('/tri/personagens'),
  // Admin: painel de Logs de Erro. O usuário só vê "deu erro (código X)" — o
  // detalhe (mensagem real, stack, quem, onde) mora aqui.
  adminErrorLogs: () => request('/admin/error-logs'),
  adminClearErrorLogs: () => request('/admin/error-logs', { method: 'DELETE' }),
  // Admin: dispara um aviso (notificação) pra todos.
  adminSendNotification: (data) => request('/admin/notifications', { method: 'POST', body: data }),

  // Chat (chat completions). O servidor resolve o systemPrompt a partir de
  // context: { type, itemId } — NUNCA mande systemPrompt do cliente
  // (o backend rejeita com 400). maxTokens só é honrado em mode 'entrevistador'.
  //
  // context.category (opcional) diz de qual MODO a conversa é — 'competitivo',
  // 'duelo', 'treinamento' — pra o servidor escolher o modelo do
  // paciente configurado naquela categoria (Administração → Modelos de IA). É só
  // uma dica: o servidor valida a categoria, e visitante/neuro ele deriva por
  // conta própria (role e context.type são fatos, não dica do cliente).
  chat: (messages, context, maxTokens) =>
    request('/chat', { method: 'POST', body: { messages, context, maxTokens } }),

  // Cota diária de sessões (só o Aluno Externo tem; nos outros papéis volta
  // enabled:false). Consultada antes de abrir uma sessão pra avisar ali mesmo,
  // em vez de deixar a pessoa entrar num chat que o servidor vai barrar.
  // O contexto ({type,itemId}) diz QUAL sessão vai ser aberta: retomar uma já
  // aberta é liberado mesmo com a cota esgotada (ver server/session-quota.js).
  sessionQuota: (ctx) => {
    const q = new URLSearchParams();
    if (ctx && ctx.type) q.set('type', ctx.type);
    if (ctx && ctx.itemId) q.set('itemId', ctx.itemId);
    const qs = q.toString();
    return request('/session-quota' + (qs ? `?${qs}` : ''));
  },

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
    // Exercício da Trilha com avaliador OpenAI também: {pending:true, jobId} —
    // roda em Batch, então troca sozinho pra polling em vez de esperar SSE.
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      const data = await res.json();
      if (data && data.pending && data.jobId) {
        return await pollTrilhaEvalBatch(data.jobId);
      }
      return data;
    }
    // Stream SSE: acumula os deltas (eventos `data: {delta|done|error}`).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let reasoning = '';
    let usage = null;
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
          } else if (obj.usage) {
            // Custo dos Logs da Trilha: tokens normalizados pelo servidor —
            // o cliente só acumula/repassa ao salvar o log (ver ChatSession).
            usage = obj.usage;
          } else if (obj.error) {
            streamError = obj.error;
          }
        }
      }
    }
    if (streamError) throw new Error(streamError);
    return { role: 'assistant', content: full, reasoning, usage };
  },

  // Trilha — esquema visual (SVG) opcional ao final do exercício. Mesmo
  // esquema de stream do /evaluate (SSE com heartbeat), mas só interessa o
  // resultado final — não há delta pra mostrar token a token.
  generateImageSchema: async (itemId, messages) => {
    const token = getToken();
    const res = await fetch(BASE + '/trilha/image-schema', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ itemId, messages }),
    });
    if (res.status === 401) {
      clearAuth();
      notifySessionExpired();
      const err = await res.json().catch(() => ({ error: 'Sessão expirada' }));
      throw new Error(err.error || 'Sessão expirada');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Erro ao gerar o esquema visual' }));
      throw new Error(err.error || 'Erro ao gerar o esquema visual');
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return { svg: data.svg || '', usage: data.usage || null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let svg = '';
    let usage = null;
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
          if (obj.svg) svg = obj.svg;
          if (obj.usage) usage = obj.usage;
          if (obj.error) streamError = obj.error;
        }
      }
    }
    if (streamError) throw new Error(streamError);
    if (!svg) throw new Error('Não recebi o esquema visual.');
    return { svg, usage };
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

  // Modelos de IA por categoria (admin-only). getAiModels devolve as opções +
  // o que cada categoria roda hoje; setAiModel grava UMA categoria por vez
  // ({ categoria, evaluator?, patient? }) e responde o catálogo já atualizado.
  // Passar null num campo limpa a escolha e volta ao padrão do sistema.
  getAiModels: () => request('/admin/ai-models'),
  setAiModel: (data) => request('/admin/ai-models', { method: 'PUT', body: data }),
  // Padrão global (todas as categorias sem escolha própria): mesma rota, com
  // { global: true }. Devolve o catálogo já atualizado, como o setAiModel.
  setAiModelGlobal: (data) => request('/admin/ai-models', { method: 'PUT', body: { ...data, global: true } }),

  // Prompts do avaliador/entrevistador (admin-only). Vivem no volume, fora do
  // git — por isso toda gravação passa por validação + backup no servidor, e há
  // histórico de versões para restaurar. O caminho tem espaços ("nova
  // avaliacao/"), daí o encode por segmento.
  adminListPrompts: () => request('/admin/prompts'),
  adminGetPrompt: (p) => request('/admin/prompts/' + encodePromptPath(p)),
  // Grava um .md do volume. `criar:true` é para arquivo NOVO (o servidor recusa
  // se o caminho já existir); sem a flag é edição do que já está lá.
  adminSavePrompt: (p, content, { criar = false } = {}) =>
    request('/admin/prompts/' + encodePromptPath(p), { method: 'PUT', body: criar ? { content, criar: true } : { content } }),
  adminGetPromptVersion: (p, id) => request(`/admin/prompt-versions/${encodeURIComponent(id)}?path=${encodeURIComponent(p)}`),
  adminRestorePromptVersion: (p, id) =>
    request(`/admin/prompt-versions/${encodeURIComponent(id)}/restaurar`, { method: 'POST', body: { path: p } }),

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

  // --- Antessala (pré-supervisão) ---
  // Aluno: seus mapas de caso (resumos). Supervisor/admin: mapas entregues dos
  // alunos. get/save/deliver/delete operam sobre um mapa. reflect é a camada
  // maiêutica (o servidor monta o system prompt travado).
  getAntessalaCases: () => request('/antessala'),
  getSupervisorAntessala: () => request('/antessala/supervisor'),
  getAntessalaCase: (id) => request(`/antessala/${encodeURIComponent(id)}`),
  createAntessalaCase: (doc) => request('/antessala', { method: 'POST', body: doc }),
  updateAntessalaCase: (id, doc) => request(`/antessala/${encodeURIComponent(id)}`, { method: 'PUT', body: doc }),
  deliverAntessalaCase: (id) => request(`/antessala/${encodeURIComponent(id)}/deliver`, { method: 'POST', body: {} }),
  deleteAntessalaCase: (id) => request(`/antessala/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // { questions: string[], text } — perguntas para o aluno aprofundar a etapa.
  reflectAntessala: (step, doc) => request('/antessala/reflect', { method: 'POST', body: { step, doc } }),

  // --- Comunidade ---
  // getDiscussion é a ÚNICA chamada do app que funciona sem sessão: é o link
  // compartilhado (/comunidade/discussao/:id), que abre pra qualquer pessoa em
  // modo leitura. O `request` já manda o Authorization só quando existe token,
  // então a mesma função serve o membro logado e o visitante de fora.
  getComunidade: (sort = 'recent') => request(`/comunidade?sort=${encodeURIComponent(sort)}`),
  getDiscussion: (id) => request(`/comunidade/${encodeURIComponent(id)}`),
  createDiscussion: (data) => request('/comunidade', { method: 'POST', body: data }),
  deleteDiscussion: (id) => request(`/comunidade/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  voteDiscussion: (id, value) => request(`/comunidade/${encodeURIComponent(id)}/vote`, { method: 'POST', body: { value } }),
  votePoll: (id, optionId) => request(`/comunidade/${encodeURIComponent(id)}/poll`, { method: 'POST', body: { optionId } }),
  createComment: (id, data) => request(`/comunidade/${encodeURIComponent(id)}/comentarios`, { method: 'POST', body: data }),
  voteComment: (id, cid, value) =>
    request(`/comunidade/${encodeURIComponent(id)}/comentarios/${encodeURIComponent(cid)}/vote`, { method: 'POST', body: { value } }),
  deleteComment: (id, cid) =>
    request(`/comunidade/${encodeURIComponent(id)}/comentarios/${encodeURIComponent(cid)}`, { method: 'DELETE' }),

  // --- Pool de fotos padrão (Administração → Contas) ---
  // Até 10 imagens usadas como avatar de quem não tem foto própria (visitante e
  // conta ainda com a foto de fábrica).
  adminGetAvatarPool: () => request('/admin/avatar-pool'),
  adminAddAvatarPool: (image) => request('/admin/avatar-pool', { method: 'POST', body: { image } }),
  adminRemoveAvatarPool: (id) => request(`/admin/avatar-pool/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Administração da Comunidade (admin) ---
  adminGetComunidade: () => request('/admin/comunidade'),
  adminGetComunidadeUser: (userId) => request(`/admin/comunidade/usuario/${encodeURIComponent(userId)}`),
  adminSetInstitutionAvatar: (body) => request('/admin/comunidade/avatar-instituicao', { method: 'PUT', body }),
  adminBanComunidade: (data) => request('/admin/comunidade/ban', { method: 'POST', body: data }),
  adminUnbanComunidade: (userId) => request(`/admin/comunidade/ban/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  adminPurgeComunidade: (data) => request('/admin/comunidade/purgar', { method: 'POST', body: data }),

  // --- Notificações in-app ---
  getNotifications: () => request('/notifications'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST', body: {} }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST', body: {} }),

  // --- Web Push ---
  getVapidPublicKey: () => request('/push/vapid-public-key'),
  subscribePush: (subscription) => request('/push/subscribe', { method: 'POST', body: { subscription } }),
  unsubscribePush: (endpoint) => request('/push/unsubscribe', { method: 'POST', body: { endpoint } }),
  // Push de teste pra si mesmo: diz se saiu, pra quantos aparelhos, e por que não.
  testPush: () => request('/push/test', { method: 'POST', body: {} }),
};
