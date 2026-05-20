require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
  buildExercisePrompt,
  buildFreeplayPrompt,
  buildNeuroPrompt,
  wrapCustomEvaluatorPrompt,
} = require('./prompts');
const mmrEngine = require('./mmr');
const { finalScoreFromCriteria, comparativeScores } = require('./scoring');

const app = express();

// Railway/Cloudflare ficam na frente; sem isso o express-rate-limit aborta com
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR e req.ip fica errado.
app.set('trust proxy', 1);

// CORS allowlist. Em produção o front é servido pelo mesmo origin (o Express
// serve o build do React), então só precisa abrir pra dev local.
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Aceita o Vite dev server (porta 5173) tanto em localhost/127.0.0.1 quanto
// em IPs de rede privada (RFC1918) — pra que `vite --host` funcione quando
// você acessa a URL "Network" mostrada pelo Vite (ex: http://192.168.x.x:5173),
// inclusive testando o app pelo celular da mesma rede.
function isLocalViteDevOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' || u.port !== '5173') return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  // Same-origin (sem header Origin) sempre passa.
  if (!origin) return cb(null, { origin: true });
  if (CORS_ALLOWLIST.includes(origin)) return cb(null, { origin: true });
  // Same-origin com header Origin: browsers modernos mandam Origin mesmo em
  // fetch mesmo-origem. Compara host do Origin com o Host da request.
  try {
    const originHost = new URL(origin).host;
    if (originHost && originHost === req.headers.host) {
      return cb(null, { origin: true });
    }
  } catch {}
  // Vite dev em LAN (192.168.x.x etc.) — necessário pra `vite --host`.
  if (isLocalViteDevOrigin(origin)) return cb(null, { origin: true });
  return cb(new Error('Origin não permitida pelo CORS: ' + origin));
}));

app.use(express.json({ limit: '10mb' }));

// Servir fotos de perfil (pasta profiles_icon na raiz do projeto)
const PROFILES_DIR = path.join(__dirname, '..', 'profiles_icon');
if (fs.existsSync(PROFILES_DIR)) {
  app.use('/profiles_icon', express.static(PROFILES_DIR, { maxAge: '7d' }));
}

// DATA_DIR pode ser sobrescrito via env (Railway: aponta para volume persistente).
// Se não existir, copia o conteúdo seed embutido no repositório (server/data) na primeira execução.
const SEED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : SEED_DATA_DIR;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (DATA_DIR !== SEED_DATA_DIR && fs.existsSync(SEED_DATA_DIR)) {
  for (const f of fs.readdirSync(SEED_DATA_DIR)) {
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(SEED_DATA_DIR, f), dst);
    }
  }
}

// JWT secret — obrigatório em todos os ambientes. Fail-closed: se ausente ou
// curto demais, encerramos o processo em vez de continuar com fallback inseguro
// (que zera todas as sessões a cada restart e é frágil contra deploys novos).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente ou curto demais (mínimo 32 chars).');
  console.error('         Gere com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const TOKEN_TTL = '7d';
const BCRYPT_ROUNDS = 10;

// --- Rate limiting ---
// Em NODE_ENV=test, todos os limiters viram no-op: a suite roda dezenas de
// logins/requests em segundos, o que estouraria janelas reais.
const SKIP_RATE_LIMIT = process.env.NODE_ENV === 'test';
const noopLimiter = (req, res, next) => next();

// Pre-auth (chave por IP): protege contra brute-force de credenciais e flood
// de geração de tokens.
const loginLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
const visitorLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
// Post-auth (chave por user.id, fallback IP): protege a chave Anthropic
// (e a OpenAI do Whisper) de abuse, e segura escrita massiva em logs.
function userKey(req) {
  return (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`;
}
// 300 req/hora cobre ~6 sessões clínicas longas. Era 60 antes — apertado
// demais pra uso real. Como /api/chat e /api/evaluate só aceitam context com
// itemId válido (resolveChatSystemPrompt / resolveEvaluatorSystemPrompt),
// o risco de abuse da chave Anthropic caiu — podemos afrouxar com segurança.
const aiLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Limite de uso da IA atingido. Tente novamente em uma hora.' },
});
const writeLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Limite de operações atingido. Tente novamente mais tarde.' },
});

// Diagnóstico de env no startup — sem expor secrets, só presença + length.
function envDiag(name) {
  const v = process.env[name];
  if (v === undefined) return 'NOT SET';
  if (v === '') return 'EMPTY STRING';
  return `set (${v.length} chars)`;
}
console.log('[startup] JWT_SECRET       =', envDiag('JWT_SECRET'));
console.log('[startup] ANTHROPIC_API_KEY =', envDiag('ANTHROPIC_API_KEY'));
console.log('[startup] OPENAI_API_KEY    =', envDiag('OPENAI_API_KEY'), '(usada só pelo Whisper)');
console.log('[startup] DATA_DIR          =', envDiag('DATA_DIR'), '→ resolved:', DATA_DIR);
console.log('[startup] PORT              =', envDiag('PORT'));
console.log('[startup] env keys count    =', Object.keys(process.env).length);
// Lista nomes de envs que CONTÊM "JWT" ou "SECRET" — pega typos como "jwt_secret" / "JWTSECRET"
const jwtish = Object.keys(process.env).filter((k) => /jwt|secret/i.test(k));
console.log('[startup] env keys com JWT/SECRET no nome:', jwtish.length ? jwtish.join(', ') : '(nenhum)');

function readJSON(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// --- Initialize default data ---
const DEFAULT_PROFILE = {
  gender: '',
  email: '',
  profilePhoto: '/profiles_icon/isaacdeterno.jpeg',
  updateAllOS: false,
  updateAllos: false,
};

const VALID_ROLES = ['therapist', 'supervisor', 'admin'];

function hashPasswordSync(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) {
  // Seed inicial: apenas o admin. Demais contas são criadas pela tela de Contas.
  // Fail-closed: sem ADMIN_INITIAL_PASSWORD setada (e forte), recusa criar o admin —
  // evita o cenário em que um deploy "fresh" volta a aceitar admin/admin123.
  const adminInitialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!adminInitialPassword || adminInitialPassword.length < 12) {
    console.error('[FATAL] ADMIN_INITIAL_PASSWORD ausente ou curta demais (mínimo 12 chars).');
    console.error('         Gere com: openssl rand -base64 24');
    process.exit(1);
  }
  writeJSON('users.json', [
    {
      id: '1',
      username: 'admin',
      passwordHash: hashPasswordSync(adminInitialPassword),
      name: 'Administrador',
      role: 'admin',
      teacherId: null,
      ...DEFAULT_PROFILE,
      profilePhoto: '/profiles_icon/jung(1).png',
    },
  ]);
  console.log('[auth] Seed users.json criado. Login admin: admin / <ADMIN_INITIAL_PASSWORD da env>');
}

// Migração one-shot: passwords em texto puro -> bcrypt hash
(function migratePlaintextPasswords() {
  const users = readJSON('users.json');
  let dirty = false;
  for (const u of users) {
    if (u.password && !u.passwordHash) {
      u.passwordHash = hashPasswordSync(u.password);
      delete u.password;
      dirty = true;
    }
    if (!('teacherId' in u)) {
      u.teacherId = null;
      dirty = true;
    }
  }
  if (dirty) {
    writeJSON('users.json', users);
    console.log('[auth] Senhas em texto puro migradas para bcrypt.');
  }
})();

// Migração one-shot: padroniza profilePhoto em isaacdeterno.jpeg pra TODOS os
// usuários já cadastrados (inclusive os que tinham outra foto, por decisão do
// admin em 2026-05-15). Roda uma única vez — marker em migrations.json garante
// idempotência mesmo após redeploys. Visitantes são efêmeros (não vivem em
// users.json), então não precisam de tratamento. Após esta migração, qualquer
// usuário pode trocar a foto normalmente em /profile e a mudança persiste.
(function migrateDefaultProfilePhoto() {
  const migrations = readJSON('migrations.json', {});
  if (migrations.isaac_default_photo) return;
  const users = readJSON('users.json');
  const target = '/profiles_icon/isaacdeterno.jpeg';
  let changed = 0;
  for (const u of users) {
    if (u.profilePhoto !== target) {
      u.profilePhoto = target;
      changed++;
    }
  }
  if (changed > 0) writeJSON('users.json', users);
  migrations.isaac_default_photo = new Date().toISOString();
  writeJSON('migrations.json', migrations);
  console.log(`[migration] profilePhoto padronizado em ${changed} usuário(s).`);
})();

if (!fs.existsSync(path.join(DATA_DIR, 'exercises.json'))) {
  // Inicia sem exercícios — o admin cadastra via interface.
  writeJSON('exercises.json', []);
}

if (!fs.existsSync(path.join(DATA_DIR, 'freeplay-characters.json'))) {
  writeJSON('freeplay-characters.json', [
    { id: 'fp1', name: 'Sofia', age: 25, description: 'Jovem com queixas relacionais', assistantId: '', specificInstruction: 'Você é Sofia, 25 anos, designer gráfica. Veio à terapia por dificuldades nos relacionamentos amorosos. Tem um padrão de se apegar rápido e depois sentir que o parceiro não corresponde. Fale de forma expressiva e emotiva.' },
    { id: 'fp2', name: 'Roberto', age: 55, description: 'Homem em crise de meia-idade', assistantId: '', specificInstruction: 'Você é Roberto, 55 anos, contador. Está passando por uma crise existencial: os filhos saíram de casa, sente que o casamento esfriou, questiona suas escolhas de carreira. Fale de forma contida, com dificuldade de expressar emoções.' }
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'neuro-characters.json'))) {
  writeJSON('neuro-characters.json', [
    { id: 'nr1', name: 'Beatriz', age: 32, description: 'Paciente com quadro depressivo', diagnosis: 'Transtorno Depressivo Maior', assistantId: '', specificInstruction: 'Você é Beatriz, 32 anos, professora afastada do trabalho. Diagnóstico: Transtorno Depressivo Maior (moderado a grave). Apresente: humor deprimido persistente, anedonia, fadiga, dificuldade de concentração, insônia, sentimentos de inutilidade, ideação suicida passiva ("às vezes penso que seria melhor não acordar"). Responda de forma lenta, com pausas, pouca energia.' },
    { id: 'nr2', name: 'Thiago', age: 8, description: 'Criança com suspeita de TDAH', diagnosis: 'TDAH - Tipo Combinado', assistantId: '', specificInstruction: 'Você é Thiago, 8 anos. Diagnóstico: TDAH tipo combinado. Na sessão: dificuldade de ficar parado, muda de assunto constantemente, se distrai com qualquer coisa, fala muito rápido, interrompe o terapeuta. Porém quando algo te interessa muito (videogames), consegue focar. Responda como uma criança de 8 anos falaria.' }
  ]);
}

if (!fs.existsSync(path.join(DATA_DIR, 'progress.json'))) {
  writeJSON('progress.json', {});
}

if (!fs.existsSync(path.join(DATA_DIR, 'logs.json'))) {
  writeJSON('logs.json', []);
}

// Estado do MMR competitivo. { players: { <userId>: {P,n,W} },
// characters: { <charId>: {D,n_D,alpha,beta,history} } }. Sobrevive ao reset de
// ranking (decisão do dono): zerar notas dos logs NÃO zera o MMR.
if (!fs.existsSync(path.join(DATA_DIR, 'mmr.json'))) {
  writeJSON('mmr.json', { players: {}, characters: {} });
}

// Duelos (avaliação comparada entre dois alunos atendendo o mesmo personagem).
// Array de duelos; cada um guarda os dois lados (challenger/opponent), as
// transcrições e o resultado da avaliação comparativa. Só vale pra treino por
// enquanto (não toca no MMR).
if (!fs.existsSync(path.join(DATA_DIR, 'duels.json'))) {
  writeJSON('duels.json', []);
}

// Notificações in-app (convite de duelo, resultado de duelo). Mapa
// { <userId>: [ {id, type, ...} ] }. Visitantes (id efêmero) não recebem.
if (!fs.existsSync(path.join(DATA_DIR, 'notifications.json'))) {
  writeJSON('notifications.json', {});
}

function readMMR() {
  const data = readJSON('mmr.json', { players: {}, characters: {} });
  if (!data.players) data.players = {};
  if (!data.characters) data.characters = {};
  return data;
}
function writeMMR(data) {
  writeJSON('mmr.json', data);
}

// --- Auth helpers ---
function publicUser(u) {
  if (!u) return null;
  const { password, passwordHash, ...safe } = u;
  // Título ativo (subtítulo desbloqueável): resolve o rótulo a partir da conquista.
  // Disponível em /me, /ranking (via users) e no perfil. ACHIEVEMENT_DEFS é const
  // de módulo já inicializada no momento em que publicUser roda (request time).
  if (safe.activeTitle) {
    const def = ACHIEVEMENT_DEFS.find((d) => d.id === safe.activeTitle);
    safe.titleLabel = def ? def.title : null;
    safe.titleTier = def ? def.tier : null;
  }
  if (safe.role === 'therapist' && safe.teacherId) {
    try {
      const users = readJSON('users.json');
      const teacher = users.find((t) => t.id === safe.teacherId);
      if (teacher && teacher.name) safe.teacherName = teacher.name;
    } catch {}
  }
  return safe;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function getTokenFromReq(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Visitante: reconstrói usuário virtual a partir do JWT (não persistido em users.json)
    if (payload.role === 'visitor') {
      req.user = {
        id: payload.sub,
        username: payload.username || payload.sub,
        name: payload.name || 'Visitante',
        role: 'visitor',
        teacherId: null,
        isVisitor: true,
      };
      return next();
    }
    const users = readJSON('users.json');
    const user = users.find(u => u.id === payload.sub);
    if (!user) return res.status(401).json({ error: 'Sessão inválida' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  };
}

// Permite que admin acesse qualquer recurso, professor acesse o de seus alunos,
// aluno acesse só o próprio.
function canAccessUserResource(actor, targetUserId) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (actor.id === targetUserId) return true;
  if (actor.role === 'supervisor') {
    const users = readJSON('users.json');
    const target = users.find(u => u.id === targetUserId);
    return !!(target && target.teacherId === actor.id);
  }
  return false;
}

// --- Auth ---
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }
  const users = readJSON('users.json');
  const user = users.find(u => u.username === username);
  // Bcrypt sempre — se não houver hash, falha silenciosa (resposta genérica para evitar enumeration)
  const ok = user && user.passwordHash
    ? await bcrypt.compare(String(password), user.passwordHash)
    : false;
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Login como visitante: gera um JWT com role=visitor e id efêmero (não cria
// registro em users.json). Logs gerados pelo visitante são naturalmente
// vistos pelo admin (que vê todos) mas não por nenhum professor (visitor
// não tem teacherId).
app.post('/api/login/visitor', visitorLimiter, (req, res) => {
  const id = 'visitor-' + crypto.randomBytes(6).toString('hex');
  const visitorUser = {
    id,
    username: id,
    name: 'Visitante',
    role: 'visitor',
    teacherId: null,
    isVisitor: true,
  };
  const token = signToken(visitorUser);
  res.json({ token, user: visitorUser });
});

// Re-valida token e devolve user atualizado (usado no boot do client).
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Troca de senha pelo próprio usuário
app.post('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Senha atual e nova são obrigatórias' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });
  }
  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash || '');
  if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  writeJSON('users.json', users);
  res.json({ ok: true });
});

// Define o "título" (subtítulo) ativo exibido no perfil e no ranking. Só
// permite títulos de conquistas que o usuário REALMENTE desbloqueou — a posse
// é revalidada server-side via computeEarnedAchievements (não confia no client).
// titleId vazio limpa o título.
app.post('/api/me/title', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não pode definir título.' });
  }
  const titleId = req.body && req.body.titleId;
  const users = readJSON('users.json');
  const idx = users.findIndex((u) => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

  if (!titleId) {
    users[idx].activeTitle = '';
    writeJSON('users.json', users);
    return res.json(publicUser(users[idx]));
  }

  const def = ACHIEVEMENT_DEFS.find((d) => d.id === titleId);
  if (!def) return res.status(400).json({ error: 'Título inválido.' });

  const allLogs = readJSON('logs.json');
  const userLogs = allLogs.filter((l) => l.userId === req.user.id);
  const streak = computeStreak(userLogs);
  const earned = computeEarnedAchievements(
    userLogs,
    streak,
    readJSON('exercises.json'),
    readJSON('freeplay-characters.json'),
    readJSON('neuro-characters.json'),
  );
  if (!earned.has(titleId)) {
    return res.status(403).json({ error: 'Você ainda não desbloqueou esse título.' });
  }
  users[idx].activeTitle = titleId;
  writeJSON('users.json', users);
  res.json(publicUser(users[idx]));
});

// --- Profile ---
app.get('/api/users/:id', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.id)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  // Visitante consultando o próprio "perfil": devolve o usuário virtual do JWT
  if (req.user.role === 'visitor' && req.params.id === req.user.id) {
    return res.json(publicUser(req.user));
  }
  const users = readJSON('users.json');
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(publicUser(user));
});

app.put('/api/users/:id', requireAuth, (req, res) => {
  // Próprio usuário ou admin. Professor não edita perfil de aluno por aqui.
  if (req.user.id !== req.params.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  // Apenas campos de perfil podem ser alterados aqui
  const allowed = ['name', 'gender', 'email', 'profilePhoto', 'updateAllOS', 'updateAllos'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  users[idx] = { ...users[idx], ...patch };
  writeJSON('users.json', users);
  res.json(publicUser(users[idx]));
});

// --- Admin: gestão de contas ---
const usernameRegex = /^[a-zA-Z0-9._-]{3,32}$/;

function nextUserId(users) {
  // Filtra apenas IDs numéricos. Se algum user legacy tiver id não-numérico
  // (ex: visitor-xxx persistido por erro), o Number() retorna NaN — antes,
  // isso corrompia o maxNumeric e o próximo user virava "NaN".
  const maxNumeric = users.reduce((max, u) => {
    const n = Number(u.id);
    if (!Number.isFinite(n)) return max;
    return n > max ? n : max;
  }, 0);
  return String(maxNumeric + 1);
}

function validateNewUserPayload(body, users, { isUpdate = false, currentUser = null } = {}) {
  const errors = [];
  const username = (body.username || '').trim();
  const role = body.role;
  const teacherId = body.teacherId || null;

  if (!isUpdate || body.username !== undefined) {
    if (!usernameRegex.test(username)) {
      errors.push('Usuário inválido (3-32 caracteres, letras/números/. _ -)');
    }
    const dup = users.find(u => u.username === username && (!currentUser || u.id !== currentUser.id));
    if (dup) errors.push('Usuário já existe');
  }
  if (!isUpdate && (!body.password || String(body.password).length < 6)) {
    errors.push('Senha deve ter ao menos 6 caracteres');
  }
  if (body.password !== undefined && body.password !== '' && String(body.password).length < 6) {
    errors.push('Senha deve ter ao menos 6 caracteres');
  }
  if (!isUpdate && !VALID_ROLES.includes(role)) {
    errors.push('Função inválida');
  }
  if (role === 'therapist') {
    if (!teacherId) {
      errors.push('Aluno deve estar vinculado a um professor');
    } else {
      const t = users.find(u => u.id === teacherId);
      if (!t || t.role !== 'supervisor') errors.push('Professor inválido');
    }
  }
  if (role && role !== 'therapist' && teacherId) {
    errors.push('Apenas alunos podem estar vinculados a um professor');
  }
  return errors;
}

app.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = readJSON('users.json');
  res.json(users.map(publicUser));
});

app.post('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const users = readJSON('users.json');
  const errors = validateNewUserPayload(req.body, users);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const role = req.body.role;
  const newUser = {
    id: nextUserId(users),
    username: req.body.username.trim(),
    name: (req.body.name || req.body.username).trim(),
    role,
    teacherId: role === 'therapist' ? (req.body.teacherId || null) : null,
    passwordHash: await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS),
    ...DEFAULT_PROFILE,
    gender: req.body.gender || '',
    email: req.body.email || '',
    profilePhoto: req.body.profilePhoto || DEFAULT_PROFILE.profilePhoto,
  };
  users.push(newUser);
  writeJSON('users.json', users);
  res.json(publicUser(newUser));
});

app.put('/api/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  const current = users[idx];

  // Admin não pode rebaixar/editar o role da própria conta para evitar lockout
  if (current.id === req.user.id && req.body.role && req.body.role !== current.role) {
    return res.status(400).json({ error: 'Você não pode alterar a sua própria função.' });
  }

  const merged = {
    ...current,
    ...(req.body.username !== undefined ? { username: String(req.body.username).trim() } : {}),
    ...(req.body.name !== undefined ? { name: String(req.body.name).trim() } : {}),
    ...(req.body.role !== undefined ? { role: req.body.role } : {}),
    ...(req.body.email !== undefined ? { email: req.body.email } : {}),
    ...(req.body.gender !== undefined ? { gender: req.body.gender } : {}),
    ...(req.body.profilePhoto !== undefined ? { profilePhoto: req.body.profilePhoto } : {}),
  };

  // teacherId só faz sentido para alunos
  if (merged.role === 'therapist') {
    if (req.body.teacherId !== undefined) merged.teacherId = req.body.teacherId || null;
  } else {
    merged.teacherId = null;
  }

  if (!VALID_ROLES.includes(merged.role)) {
    return res.status(400).json({ error: 'Função inválida' });
  }
  const errors = validateNewUserPayload(merged, users, { isUpdate: true, currentUser: current });
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  if (req.body.password) {
    if (String(req.body.password).length < 6) {
      return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
    }
    merged.passwordHash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);
  }

  // Se um professor mudou de função, desvincular alunos
  if (current.role === 'supervisor' && merged.role !== 'supervisor') {
    for (const u of users) {
      if (u.teacherId === current.id) u.teacherId = null;
    }
  }

  users[idx] = merged;
  writeJSON('users.json', users);
  res.json(publicUser(merged));
});

app.delete('/api/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Você não pode excluir a própria conta.' });
  }
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  const target = users[idx];

  if (target.role === 'supervisor') {
    const linked = users.filter(u => u.teacherId === target.id);
    if (linked.length > 0) {
      return res.status(400).json({
        error: `Este professor tem ${linked.length} aluno(s) vinculado(s). Reatribua-os antes de excluir.`,
      });
    }
  }

  users.splice(idx, 1);
  writeJSON('users.json', users);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireAuth, requireRole('admin'), async (req, res) => {
  const newPassword = req.body && req.body.newPassword;
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
  }
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  writeJSON('users.json', users);
  res.json({ ok: true });
});

// Export completo dos JSON do DATA_DIR — admin-only. Para backup/migração
// pra SQL. Retorna passwordHash dos users (admin já tem acesso total).
// Em produção, o admin loga e baixa via interface (AdminUsers.jsx).
app.get('/api/admin/export', requireAuth, requireRole('admin'), (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    schemaVersion: 1,
    data: {
      users: readJSON('users.json'),
      exercises: readJSON('exercises.json'),
      freeplayCharacters: readJSON('freeplay-characters.json'),
      neuroCharacters: readJSON('neuro-characters.json'),
      progress: readJSON('progress.json', {}),
      logs: readJSON('logs.json'),
      achievements: readJSON('achievements.json', {}),
      activeSessions: readJSON('active-sessions.json', {}),
      mmr: readJSON('mmr.json', { players: {}, characters: {} }),
      duels: readJSON('duels.json', []),
      notifications: readJSON('notifications.json', {}),
    },
  };
  // Content-Disposition: força download como arquivo em vez de renderizar JSON
  // no navegador. Filename inclui data + hora pra evitar sobrescrever backups.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="allos-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Professor: lista de alunos vinculados a ele
app.get('/api/teacher/students', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const users = readJSON('users.json');
  const list = req.user.role === 'admin'
    ? users.filter(u => u.role === 'therapist')
    : users.filter(u => u.role === 'therapist' && u.teacherId === req.user.id);
  res.json(list.map(publicUser));
});

// --- Indicadores: constância, objetivos diários, metas ---
const ACHIEVEMENT_DEFS = [
  { id: 'first_session',       icon: '◐', title: 'Primeira sessão',     description: 'Concluiu sua primeira sessão na plataforma.',                                       tier: 'bronze' },
  { id: 'simulacao_complete',  icon: '◇', title: 'Repertório clínico',  description: 'Concluiu todos os personagens da Simulação.',                                       tier: 'gold' },
  { id: 'neuro_complete',      icon: '◈', title: 'Avaliação completa', description: 'Concluiu todos os personagens da Neuroavaliação.',                                  tier: 'gold' },
  { id: 'trilha_skill_1',      icon: '▲', title: 'Hermenêutica plena',  description: 'Concluiu todos os exercícios da competência Hermenêutica.',                         tier: 'silver' },
  { id: 'trilha_skill_2',      icon: '▲', title: 'Estrutura consolidada', description: 'Concluiu todos os exercícios da competência Estrutura.',                           tier: 'silver' },
  { id: 'trilha_skill_3',      icon: '▲', title: 'Empatia consolidada',  description: 'Concluiu todos os exercícios da competência Empatia.',                              tier: 'silver' },
  { id: 'trilha_skill_4',      icon: '▲', title: 'Olho clínico',        description: 'Concluiu todos os exercícios da competência Especificidade do caso.',               tier: 'silver' },
  { id: 'trilha_skill_5',      icon: '▲', title: 'Autoconhecimento',    description: 'Concluiu todos os exercícios da competência Eu.',                                   tier: 'silver' },
  { id: 'trilha_master',       icon: '◆', title: 'Programa concluído', description: 'Concluiu todos os exercícios das 5 competências.',                                  tier: 'platinum' },
  { id: 'high_score',          icon: '★', title: 'Excelência técnica', description: 'Atingiu pontuação ≥ 25 em uma única sessão.',                                       tier: 'gold' },
  { id: 'speed_demon',         icon: '↗', title: 'Eficiência',          description: 'Concluiu uma sessão em menos de 5 min com pontuação positiva.',                     tier: 'silver' },
  { id: 'early_bird',          icon: '◔', title: 'Madrugador',          description: 'Realizou uma sessão antes das 7h.',                                                 tier: 'bronze' },
  { id: 'night_owl',           icon: '◑', title: 'Sessão noturna',      description: 'Realizou uma sessão depois das 23h.',                                               tier: 'bronze' },
  { id: 'centena',             icon: '∞', title: 'Centena',             description: '100 sessões concluídas.',                                                           tier: 'platinum' },
  { id: 'polivalente',         icon: '◉', title: 'Versatilidade',       description: 'Concluiu sessão de cada tipo (trilha, simulação, neuro) num mesmo dia.',           tier: 'gold' },
  { id: 'streak_7_ever',       icon: '●', title: 'Constância',          description: 'Manteve constância de 7 dias ao menos uma vez.',                                    tier: 'silver' },
  { id: 'streak_30_ever',      icon: '●', title: 'Persistência',        description: 'Manteve constância de 30 dias ao menos uma vez.',                                   tier: 'platinum' },
  { id: 'highlights_10',       icon: '◎', title: 'Curador',             description: 'Marcou 10 mensagens como destaque em sessões.',                                     tier: 'silver' },
  { id: 'all_difficulties',    icon: '⊟', title: 'Calibragem',          description: 'Concluiu exercícios das 3 dificuldades (iniciante, intermediário, avançado).',     tier: 'silver' },
  { id: 'lua_cheia',           icon: '◐', title: 'Amplitude',           description: 'Realizou sessões antes das 7h e depois das 23h em dias diferentes.',               tier: 'gold' },
];

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function computeStreak(userLogs) {
  if (!userLogs.length) {
    return { current: 0, longest: 0, isAlive: false, lastActiveDate: null, status: 'none', daysToWeekly: 7, daysToMonthly: 30 };
  }
  const days = new Set(userLogs.map((l) => dayKey(l.timestamp || l.createdAt || Date.now())));
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);

  let cursor = days.has(today) ? today : (days.has(yesterday) ? yesterday : null);
  let current = 0;
  if (cursor) {
    const d = new Date(cursor + 'T00:00:00Z');
    while (days.has(d.toISOString().slice(0, 10))) {
      current++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }

  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { run = 1; continue; }
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z');
    const cur = new Date(sorted[i] + 'T00:00:00Z');
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 1) run++;
    else { longest = Math.max(longest, run); run = 1; }
  }
  longest = Math.max(longest, run);

  const isAlive = current > 0;
  const lastActiveDate = days.has(today) ? today : (days.has(yesterday) ? yesterday : sorted[sorted.length - 1] || null);
  const status = current >= 30 ? 'monthly' : current >= 7 ? 'weekly' : 'none';

  return {
    current,
    longest,
    isAlive,
    lastActiveDate,
    status,
    daysToWeekly: Math.max(0, 7 - current),
    daysToMonthly: Math.max(0, 30 - current),
  };
}

function computeDailyMissions(userLogs) {
  const today = dayKey(Date.now());
  const todayLogs = userLogs.filter((l) => dayKey(l.timestamp) === today);
  const totalToday = todayLogs.length;
  const exerciseToday = todayLogs.filter((l) => l.type === 'exercise').length;
  const fastGood = todayLogs.some((l) => l.type === 'freeplay' && (l.durationSeconds || 9999) <= 600 && (l.score || 0) >= 8);
  const neuroDone = todayLogs.some((l) => l.type === 'neuro');

  return [
    { id: 'daily_1exercise', icon: '◯', title: 'Sessão diária',     description: 'Conclua 1 exercício hoje (qualquer tipo)',                       target: 1, progress: Math.min(totalToday, 1), completed: totalToday >= 1 },
    { id: 'daily_2trilha',   icon: '◎', title: 'Foco na trilha',    description: 'Conclua 2 exercícios da trilha hoje',                            target: 2, progress: Math.min(exerciseToday, 2), completed: exerciseToday >= 2 },
    { id: 'daily_efficiency',icon: '↗', title: 'Aclamação',         description: 'Conclua uma Simulação em até 10 min com pontuação ≥ 8',         target: 1, progress: fastGood ? 1 : 0, completed: fastGood },
    { id: 'daily_neuro',     icon: '◈', title: 'Construir Sinapses',description: 'Conclua uma Neuroavaliação hoje',                                target: 1, progress: neuroDone ? 1 : 0, completed: neuroDone },
  ];
}

function computeEarnedAchievements(userLogs, streak, exercises, freeplay, neuro) {
  const exerciseIds = new Set(userLogs.filter((l) => l.type === 'exercise' && l.itemId).map((l) => String(l.itemId)));
  const freeplayIds = new Set(userLogs.filter((l) => l.type === 'freeplay' && l.itemId).map((l) => String(l.itemId)));
  const neuroIds    = new Set(userLogs.filter((l) => l.type === 'neuro'    && l.itemId).map((l) => String(l.itemId)));

  const earned = new Set();

  if (userLogs.length >= 1) earned.add('first_session');

  if (freeplay.length > 0 && freeplay.every((c) => freeplayIds.has(String(c.id)))) earned.add('simulacao_complete');
  if (neuro.length > 0    && neuro.every((c)    => neuroIds.has(String(c.id))))    earned.add('neuro_complete');

  for (let s = 1; s <= 5; s++) {
    const phases = exercises.filter((e) => Number(e.skillId) === s);
    if (phases.length > 0 && phases.every((p) => exerciseIds.has(String(p.id)))) {
      earned.add(`trilha_skill_${s}`);
    }
  }
  if ([1, 2, 3, 4, 5].every((s) => earned.has(`trilha_skill_${s}`))) earned.add('trilha_master');

  if (userLogs.some((l) => Number.isFinite(l.score) && l.score >= 25)) earned.add('high_score');
  if (userLogs.some((l) => (l.durationSeconds || 9999) < 300 && Number.isFinite(l.score) && l.score > 0)) earned.add('speed_demon');

  let hasEarly = false;
  let hasLate = false;
  for (const l of userLogs) {
    const h = new Date(l.timestamp).getHours();
    if (h < 7) { earned.add('early_bird'); hasEarly = true; }
    if (h >= 23) { earned.add('night_owl'); hasLate = true; }
  }
  if (hasEarly && hasLate) earned.add('lua_cheia');

  if (userLogs.length >= 100) earned.add('centena');

  const byDay = {};
  for (const l of userLogs) {
    const k = dayKey(l.timestamp);
    if (!byDay[k]) byDay[k] = new Set();
    byDay[k].add(l.type);
  }
  if (Object.values(byDay).some((s) => s.has('exercise') && s.has('freeplay') && s.has('neuro'))) {
    earned.add('polivalente');
  }

  if (streak.longest >= 7)  earned.add('streak_7_ever');
  if (streak.longest >= 30) earned.add('streak_30_ever');

  let highlights = 0;
  for (const l of userLogs) {
    if (Array.isArray(l.messages)) highlights += l.messages.filter((m) => m && m.highlighted).length;
  }
  if (highlights >= 10) earned.add('highlights_10');

  const difficultiesDone = new Set(
    userLogs.filter((l) => l.type === 'exercise' && l.difficulty).map((l) => l.difficulty)
  );
  if (['iniciante', 'intermediario', 'avancado'].every((d) => difficultiesDone.has(d))) {
    earned.add('all_difficulties');
  }

  return earned;
}

app.get('/api/gamification/:userId', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const userId = req.params.userId;
  const allLogs = readJSON('logs.json');
  const userLogs = allLogs.filter((l) => l.userId === userId);
  const exercises = readJSON('exercises.json');
  const freeplay  = readJSON('freeplay-characters.json');
  const neuro     = readJSON('neuro-characters.json');

  const streak = computeStreak(userLogs);
  const dailyMissions = computeDailyMissions(userLogs);
  const earnedSet = computeEarnedAchievements(userLogs, streak, exercises, freeplay, neuro);

  const ach = readJSON('achievements.json', {});
  if (!ach[userId]) ach[userId] = {};
  let dirty = false;
  for (const id of earnedSet) {
    if (!ach[userId][id]) { ach[userId][id] = new Date().toISOString(); dirty = true; }
  }
  if (dirty) writeJSON('achievements.json', ach);

  const achievements = ACHIEVEMENT_DEFS.map((def) => ({
    ...def,
    earned: earnedSet.has(def.id),
    earnedAt: ach[userId][def.id] || null,
  }));

  const validScores = userLogs.map((l) => l.score).filter((s) => Number.isFinite(s));
  const stats = {
    totalSessions: userLogs.length,
    totalExercise: userLogs.filter((l) => l.type === 'exercise').length,
    totalFreeplay: userLogs.filter((l) => l.type === 'freeplay').length,
    totalNeuro:    userLogs.filter((l) => l.type === 'neuro').length,
    averageScore:  validScores.length > 0 ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : null,
    bestScore:     validScores.length > 0 ? Math.max(...validScores) : null,
  };

  res.json({ streak, dailyMissions, achievements, stats });
});

// --- Entrevistador (prompt para construção de personagem) ---
// Admin-only: o prompt do entrevistador é IP da Allos. Antes era acessível
// por qualquer usuário autenticado (incluindo visitante).
const ENTREVISTADOR_DIR = path.join(__dirname, '..', 'entrevistador');

function loadEntrevistadorPrompt() {
  const promptFile = path.join(ENTREVISTADOR_DIR, 'promptentrevistador.md');
  if (!fs.existsSync(promptFile)) return null;
  return fs.readFileSync(promptFile, 'utf-8');
}

app.get('/api/entrevistador-prompt', requireAuth, requireRole('admin'), (req, res) => {
  const content = loadEntrevistadorPrompt();
  if (!content) return res.status(404).json({ error: 'Prompt do entrevistador não encontrado.' });
  res.json({ prompt: content });
});

// Lista de fotos de perfil disponíveis (a partir da pasta profiles_icon na raiz do projeto)
app.get('/api/profile-photos', requireAuth, (req, res) => {
  const dir = path.join(__dirname, '..', 'profiles_icon');
  if (!fs.existsSync(dir)) return res.json([]);
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
    res.json(files.map(filename => ({
      filename,
      url: '/profiles_icon/' + encodeURIComponent(filename),
      label: filename.replace(/\(\d+\)/, '').replace(/\.[^.]+$/, '').trim()
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar fotos: ' + err.message });
  }
});

// --- Helpers de filtragem de campos sensíveis ---
// Cliente (não-admin) recebe só metadados de exibição; admin recebe o objeto
// completo para edição. O conteúdo "secreto" (specificInstruction, evaluatorPrompt,
// diagnosis) é resolvido server-side em /api/chat e /api/evaluate via context.
function isAdmin(user) {
  return !!(user && user.role === 'admin');
}

function publicExercise(e) {
  const { specificInstruction, evaluatorPrompt, ...safe } = e;
  // Cliente precisa saber SE existe avaliador customizado para escolher fluxo,
  // mas não precisa ver o texto.
  safe.hasCustomEvaluator = !!(evaluatorPrompt && String(evaluatorPrompt).trim());
  return safe;
}
function publicFreeplayChar(c) {
  // evaluationCriteria é o Bloco 1 / gabarito — só vai pro avaliador server-side,
  // jamais pro cliente não-admin (vazaria a "resposta" do caso).
  const { specificInstruction, evaluationCriteria, ...safe } = c;
  return safe;
}
function publicNeuroChar(c) {
  // diagnosis e evaluationCriteria são gabaritos — NUNCA vão pra cliente não-admin
  const { specificInstruction, diagnosis, evaluationCriteria, ...safe } = c;
  return safe;
}

// --- Exercises (System 1) ---
app.get('/api/exercises', requireAuth, (req, res) => {
  const list = readJSON('exercises.json');
  res.json(isAdmin(req.user) ? list : list.map(publicExercise));
});

app.post('/api/exercises', requireAuth, requireRole('admin'), (req, res) => {
  const exercises = readJSON('exercises.json');
  const ex = { id: 'ex' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...req.body };
  exercises.push(ex);
  writeJSON('exercises.json', exercises);
  res.json(ex);
});

const EXERCISE_FIELDS = ['title', 'description', 'skillId', 'difficulty', 'specificInstruction', 'evaluatorPrompt'];
function pickFields(body, fields) {
  const out = {};
  for (const f of fields) {
    if (body && Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  }
  return out;
}

app.put('/api/exercises/:id', requireAuth, requireRole('admin'), (req, res) => {
  const exercises = readJSON('exercises.json');
  const idx = exercises.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  // Allowlist: evita que campos arbitrários do body poluam o JSON.
  exercises[idx] = { ...exercises[idx], ...pickFields(req.body, EXERCISE_FIELDS) };
  writeJSON('exercises.json', exercises);
  res.json(exercises[idx]);
});

app.delete('/api/exercises/:id', requireAuth, requireRole('admin'), (req, res) => {
  let exercises = readJSON('exercises.json');
  exercises = exercises.filter(e => e.id !== req.params.id);
  writeJSON('exercises.json', exercises);
  res.json({ ok: true });
});

// --- FreePlay Characters (System 2) ---
function sanitizeCharacterPayload(body) {
  const out = { ...body };
  if ('assistantId' in out) out.assistantId = sanitizeAssistantId(out.assistantId);
  return out;
}

app.get('/api/freeplay', requireAuth, (req, res) => {
  const list = readJSON('freeplay-characters.json');
  const mmr = readMMR();
  // Dificuldade do MMR é aberta (alunos + admin) — exibida nos cards do modo
  // competitivo e no painel admin. Personagem nunca jogado mostra a baseline 50.
  const withDifficulty = (base, c) => ({
    ...base,
    difficulty: mmrEngine.characterDifficulty(mmr.characters[c.id]),
    competitiveMatches: (mmr.characters[c.id] && mmr.characters[c.id].n_D) || 0,
  });
  res.json(
    list.map((c) => withDifficulty(isAdmin(req.user) ? c : publicFreeplayChar(c), c)),
  );
});

app.post('/api/freeplay', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const c = { id: 'fp' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('freeplay-characters.json', chars);
  res.json(c);
});

const FREEPLAY_FIELDS = ['name', 'age', 'description', 'assistantId', 'specificInstruction', 'evaluationCriteria'];

app.put('/api/freeplay/:id', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(pickFields(req.body, FREEPLAY_FIELDS)) };
  writeJSON('freeplay-characters.json', chars);
  res.json(chars[idx]);
});

app.delete('/api/freeplay/:id', requireAuth, requireRole('admin'), (req, res) => {
  let chars = readJSON('freeplay-characters.json');
  chars = chars.filter(c => c.id !== req.params.id);
  writeJSON('freeplay-characters.json', chars);
  res.json({ ok: true });
});

// --- Neuro Characters (System 3) ---
app.get('/api/neuro', requireAuth, (req, res) => {
  const list = readJSON('neuro-characters.json');
  res.json(isAdmin(req.user) ? list : list.map(publicNeuroChar));
});

app.post('/api/neuro', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const c = { id: 'nr' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('neuro-characters.json', chars);
  res.json(c);
});

const NEURO_FIELDS = ['name', 'age', 'description', 'diagnosis', 'assistantId', 'specificInstruction', 'evaluationCriteria'];

app.put('/api/neuro/:id', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(pickFields(req.body, NEURO_FIELDS)) };
  writeJSON('neuro-characters.json', chars);
  res.json(chars[idx]);
});

app.delete('/api/neuro/:id', requireAuth, requireRole('admin'), (req, res) => {
  let chars = readJSON('neuro-characters.json');
  chars = chars.filter(c => c.id !== req.params.id);
  writeJSON('neuro-characters.json', chars);
  res.json({ ok: true });
});

// --- Progress ---
app.get('/api/progress/:userId', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const progress = readJSON('progress.json', {});
  res.json(progress[req.params.userId] || {});
});

app.post('/api/progress/:userId', requireAuth, (req, res) => {
  // Apenas o próprio aluno (ou admin) salva progresso
  if (req.user.id !== req.params.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const progress = readJSON('progress.json', {});
  progress[req.params.userId] = { ...progress[req.params.userId], ...req.body };
  writeJSON('progress.json', progress);
  res.json(progress[req.params.userId]);
});

// --- Logs ---
// Logs expiram automaticamente em 30 dias e são removidos do disco — medida
// preventiva pra conter o crescimento do logs.json a longo prazo. A data de
// expiração de cada log é derivada (timestamp + TTL) e exposta no GET pra que
// o cliente exiba o aviso pros 3 perfis (aluno, professor, admin).
const LOG_TTL_DAYS = 30;
const LOG_TTL_MS = LOG_TTL_DAYS * 24 * 60 * 60 * 1000;

function logExpiresAt(log) {
  const t = new Date(log.timestamp || log.createdAt || 0).getTime();
  if (!Number.isFinite(t) || t === 0) return null;
  return new Date(t + LOG_TTL_MS).toISOString();
}

// Remove logs com mais de LOG_TTL_DAYS. Idempotente; só grava se algo mudou.
// Logs sem timestamp válido são preservados (não dá pra estimar a idade).
// Retorna a quantidade removida.
function pruneExpiredLogs() {
  let logs;
  try { logs = readJSON('logs.json'); } catch { return 0; }
  if (!Array.isArray(logs) || logs.length === 0) return 0;
  const cutoff = Date.now() - LOG_TTL_MS;
  const kept = logs.filter((l) => {
    const t = new Date(l.timestamp || l.createdAt || 0).getTime();
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  if (kept.length === logs.length) return 0;
  writeJSON('logs.json', kept);
  return logs.length - kept.length;
}

// Anexa expiresAt (derivado) a cada log devolvido — não é persistido.
function decorateLogs(arr) {
  return arr.map((l) => ({ ...l, expiresAt: logExpiresAt(l) }));
}

app.get('/api/logs', requireAuth, (req, res) => {
  pruneExpiredLogs();
  const logs = readJSON('logs.json');
  const users = readJSON('users.json');

  // criteriaScores (notas por critério do avaliador) são só pra supervisor/admin.
  // O aluno (therapist) e o visitante recebem o log SEM esse campo.
  const isStudent = req.user.role === 'therapist' || req.user.role === 'visitor';
  const serve = (arr) => {
    const decorated = decorateLogs(arr);
    if (!isStudent) return decorated;
    return decorated.map(({ criteriaScores, ...rest }) => rest);
  };

  // Aluno e visitante: só os próprios.
  if (req.user.role === 'therapist' || req.user.role === 'visitor') {
    return res.json(serve(logs.filter(l => l.userId === req.user.id)));
  }

  // Filtro por userId específico
  if (req.query.userId) {
    if (!canAccessUserResource(req.user, req.query.userId)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    return res.json(serve(logs.filter(l => l.userId === req.query.userId)));
  }

  // Professor: apenas logs de seus alunos
  if (req.user.role === 'supervisor') {
    const myStudents = new Set(
      users.filter(u => u.role === 'therapist' && u.teacherId === req.user.id).map(u => u.id)
    );
    return res.json(serve(logs.filter(l => myStudents.has(l.userId))));
  }

  // Admin: tudo
  res.json(serve(logs));
});

// Metadados da política de expiração — o cliente usa pra montar o aviso.
app.get('/api/logs/policy', requireAuth, (req, res) => {
  res.json({ ttlDays: LOG_TTL_DAYS });
});

// Cap de tamanho pra prevenir bloat em logs.json e ataques de fillup.
const LOG_MAX_TITLE = 200;
const LOG_MAX_MESSAGES = 500;
const LOG_MAX_MESSAGE_LEN = 20000;
const LOG_MAX_EVAL_LEN = 50000;
const LOG_VALID_TYPES = ['exercise', 'freeplay', 'neuro'];

function clampStr(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

// --- Bloco [notas-supervisor] do avaliador (v15+) ---
// O avaliador emite, ao final do texto, um bloco com as notas internas por
// critério. v15 atual usa JSON; versões anteriores usavam Base64 de linhas
// "N:nota". Esse bloco é destinado a SUPERVISOR/ADMIN — nunca ao aluno. No save
// extraímos as notas (vão pro criteriaScores, que o GET esconde do aluno) e
// gravamos o texto da avaliação SEM o bloco.
function parseSupervisorPayload(payload) {
  if (!payload) return null;
  // 1) JSON direto (v15)
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(String(v).replace(',', '.'));
        if (Number.isFinite(n)) out[String(k)] = n;
      }
      if (Object.keys(out).length) return out;
    }
  } catch {}
  // 2) Base64 (v15 original) ou texto puro de linhas "N:nota" (retrocompat)
  let lines = payload;
  if (!payload.includes(':') && /^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    try { lines = Buffer.from(payload, 'base64').toString('utf-8'); } catch {}
  }
  const out = {};
  for (const line of lines.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*:\s*([-+]?\d+(?:[.,]\d+)?)\s*$/);
    if (m) out[m[1]] = Number(m[2].replace(',', '.'));
  }
  return Object.keys(out).length ? out : null;
}

function extractSupervisorNotes(evaluation) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  // bloco no fim do texto: (--- opcional) + [notas-supervisor] + payload até o fim
  const m = text.match(/\n*(?:-{3,}[^\S\n]*\r?\n+)?\[notas-supervisor\][^\S\n]*\r?\n?([\s\S]*)$/i);
  if (!m) return { clean: text, criteria: null };
  const clean = text.slice(0, m.index).replace(/\s+$/, '');
  let payload = (m[1] || '').trim();
  // remove cercas ``` se o modelo envolver o bloco em código
  payload = payload.replace(/^```[a-z]*[ \t]*\r?\n?/i, '').replace(/\r?\n?```\s*$/i, '').trim();
  return { clean, criteria: parseSupervisorPayload(payload) };
}

app.post('/api/logs', requireAuth, writeLimiter, (req, res) => {
  // Allowlist explícita de campos: visitor não consegue "plantar bandeira"
  // com campos arbitrários, e mass-assignment fica bloqueado. userId/userName
  // são sempre forçados do JWT.
  const body = req.body || {};

  if (!LOG_VALID_TYPES.includes(body.type)) {
    return res.status(400).json({ error: 'type inválido (exercise|freeplay|neuro)' });
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length > LOG_MAX_MESSAGES) {
    return res.status(400).json({ error: `messages excede limite de ${LOG_MAX_MESSAGES}` });
  }
  const cleanMessages = rawMessages.map((m) => ({
    role: m && (m.role === 'user' || m.role === 'assistant') ? m.role : 'user',
    content: clampStr(m && m.content, LOG_MAX_MESSAGE_LEN),
    highlighted: !!(m && m.highlighted),
    comment: clampStr(m && m.comment, 2000),
  }));

  // mode só é significativo para freeplay (Simulação): 'competitive' alimenta o
  // MMR; qualquer outro valor cai em 'training' (comportamento de hoje).
  const mode = body.mode === 'competitive' ? 'competitive' : 'training';

  // Extrai o bloco [notas-supervisor] (notas por critério) do texto do avaliador:
  // grava a avaliação SEM o bloco e guarda as notas em criteriaScores (que o GET
  // esconde do aluno). criteriaScores explícito no body (fluxo da trilha) tem
  // prioridade.
  const { clean: cleanEvaluation, criteria: supervisorCriteria } = extractSupervisorNotes(body.evaluation);

  // Nota final: calculada em CÓDIGO a partir das notas por critério do bloco
  // [notas-supervisor] (avaliadores v15/progressão). A IA não emite mais a nota
  // 0–100 no texto — `server/scoring.js` faz a conta (soma → base 100). A trilha
  // (exercise) manda criteriaScores explícito + score já calculado client-side
  // (escala -9..+9, outra fórmula), então nesse caso respeitamos o body.score.
  const explicitCriteria = (body.criteriaScores && typeof body.criteriaScores === 'object')
    ? body.criteriaScores
    : null;
  let finalScore = Number.isFinite(body.score) ? Number(body.score) : null;
  if (supervisorCriteria && !explicitCriteria) {
    const computed = finalScoreFromCriteria(supervisorCriteria);
    if (computed !== null) finalScore = computed;
  }

  const log = {
    id: 'log' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    timestamp: new Date().toISOString(),
    type: body.type,
    mode,
    itemId: clampStr(body.itemId, 200),
    itemTitle: clampStr(body.itemTitle, LOG_MAX_TITLE),
    skillId: Number.isFinite(body.skillId) ? Number(body.skillId) : null,
    difficulty: typeof body.difficulty === 'string' ? body.difficulty.slice(0, 32) : null,
    durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
    score: finalScore,
    criteriaScores: explicitCriteria || supervisorCriteria || null,
    evaluation: clampStr(cleanEvaluation, LOG_MAX_EVAL_LEN),
    messages: cleanMessages,
    userId: req.user.id,
    userName: req.user.name,
  };

  const logs = readJSON('logs.json');
  logs.push(log);
  writeJSON('logs.json', logs);

  // MMR competitivo: partida válida = freeplay + mode competitive + nota
  // numérica + usuário real (visitante tem id efêmero, fica de fora). A nota S
  // é a nota crua (0..100) do avaliador, parseada no cliente — mesmo modelo de
  // confiança do ranking de notas que já existia. Atualização atômica do
  // mmr.json (read-modify-write na mesma request).
  let mmrResult = null;
  if (
    mode === 'competitive' &&
    log.type === 'freeplay' &&
    Number.isFinite(log.score) &&
    log.itemId &&
    req.user.role !== 'visitor'
  ) {
    const mmr = readMMR();
    const { player, character, result } = mmrEngine.updateMatch(
      mmr.players[req.user.id],
      mmr.characters[log.itemId],
      log.score,
    );
    mmr.players[req.user.id] = player;
    mmr.characters[log.itemId] = character;
    writeMMR(mmr);
    mmrResult = result;
  }

  res.json({ ...log, mmr: mmrResult });
});

// --- Ranking global de jogadores (por MMR competitivo) ---
// O ranking ordena pelo MMR (P) do modo Competitivo. Só entra quem jogou ao
// menos 1 partida competitiva. Nas 5 primeiras partidas o MMR fica oculto
// (calibrating=true, mmr=null) — o cliente mostra "faltam X partidas".
//
// Visitante não acessa nem pontua (id efêmero, sem registro de MMR).
app.get('/api/ranking', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não tem acesso ao ranking.' });
  }
  const users = readJSON('users.json');
  const mmr = readMMR();

  const ranking = users
    .filter((u) => u.role !== 'visitor')
    .map((u) => {
      const state = mmr.players[u.id];
      if (!state || state.n < 1) return null; // só quem jogou competitivo
      const view = mmrEngine.playerView(state);
      const def = u.activeTitle ? ACHIEVEMENT_DEFS.find((d) => d.id === u.activeTitle) : null;
      return {
        userId: u.id,
        name: u.name || u.username,
        profilePhoto: u.profilePhoto || '',
        role: u.role,
        title: def ? def.title : null,
        titleTier: def ? def.tier : null,
        mmr: view.mmr,
        calibrating: view.calibrating,
        matchesRemaining: view.matchesRemaining,
        matches: state.n,
      };
    })
    .filter(Boolean);

  res.json(ranking);
});

// MMR do próprio usuário (perfil / tela pós-sessão). Visitante recebe um estado
// neutro (nunca pontua).
app.get('/api/me/mmr', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.json(mmrEngine.playerView(null));
  }
  const mmr = readMMR();
  res.json(mmrEngine.playerView(mmr.players[req.user.id]));
});

// Reset de ranking (admin-only). Zera as NOTAS de todas as sessões e o
// progresso da trilha, mas PRESERVA os logs/transcrições e o texto das
// avaliações — o supervisor continua revisitando as conversas, e os logs
// seguem a regra de expiração de 30 dias normalmente. Use quando o modelo do
// avaliador muda e as notas antigas perdem validade comparativa.
// NÃO toca no mmr.json: por decisão do dono, o MMR competitivo sobrevive ao
// reset (o ranking por MMR continua intacto).
app.post('/api/admin/ranking/reset', requireAuth, requireRole('admin'), (req, res) => {
  const logs = readJSON('logs.json');
  let clearedScores = 0;
  for (const l of logs) {
    if (l.score !== null && l.score !== undefined) clearedScores++;
    l.score = null;
    l.criteriaScores = null;
  }
  writeJSON('logs.json', logs);
  writeJSON('progress.json', {});
  console.log(`[admin] Ranking resetado por ${req.user.username}: ${clearedScores} nota(s) zerada(s), progresso limpo.`);
  res.json({ ok: true, clearedScores });
});

// DELETE admin-only — permite limpeza de logs (ex: remover entradas de teste
// plantadas durante pentest). Antes não havia rota; só dava pra apagar
// editando o JSON manualmente.
app.delete('/api/logs/:id', requireAuth, requireRole('admin'), (req, res) => {
  const logs = readJSON('logs.json');
  const idx = logs.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Log não encontrado' });
  const removed = logs.splice(idx, 1)[0];
  writeJSON('logs.json', logs);
  res.json({ ok: true, removed });
});

// --- Active sessions (sessões em andamento, ainda não finalizadas) ---
// Permite F5 / sair e voltar sem perder a conversa nem o cronômetro.
// Estrutura em disco: active-sessions.json = { "<userId>__<type>__<itemId>": { ... } }

const VALID_SESSION_TYPES = ['exercise', 'freeplay', 'neuro'];

function activeSessionKey(userId, type, itemId) {
  return `${userId}__${type}__${itemId}`;
}

function readActiveSessions() {
  return readJSON('active-sessions.json', {});
}

// Lista todas as sessões ativas do usuário autenticado
app.get('/api/active-sessions', requireAuth, (req, res) => {
  const all = readActiveSessions();
  const mine = Object.values(all).filter((s) => s.userId === req.user.id);
  res.json(mine);
});

// Busca uma sessão ativa específica
app.get('/api/active-sessions/:type/:itemId', requireAuth, (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Tipo de sessão inválido' });
  }
  const all = readActiveSessions();
  const session = all[activeSessionKey(req.user.id, type, itemId)];
  res.json(session || null);
});

// Salva/atualiza (upsert) uma sessão ativa
app.put('/api/active-sessions/:type/:itemId', requireAuth, (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Tipo de sessão inválido' });
  }
  const body = req.body || {};
  const all = readActiveSessions();
  const key = activeSessionKey(req.user.id, type, itemId);
  all[key] = {
    userId: req.user.id,
    type,
    itemId,
    messages: Array.isArray(body.messages) ? body.messages : [],
    elapsedSeconds: Number.isFinite(body.elapsedSeconds) ? Math.max(0, Math.floor(body.elapsedSeconds)) : 0,
    threadId: body.threadId || null,
    itemTitle: body.itemTitle || '',
    lastSavedAt: new Date().toISOString(),
  };
  writeJSON('active-sessions.json', all);
  res.json(all[key]);
});

// Descarta uma sessão ativa (chamado ao finalizar)
app.delete('/api/active-sessions/:type/:itemId', requireAuth, (req, res) => {
  const { type, itemId } = req.params;
  if (!VALID_SESSION_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Tipo de sessão inválido' });
  }
  const all = readActiveSessions();
  const key = activeSessionKey(req.user.id, type, itemId);
  if (key in all) {
    delete all[key];
    writeJSON('active-sessions.json', all);
  }
  res.json({ ok: true });
});

// --- Anthropic Chat Proxy (modelo padrão do projeto) ---
// CHAT_MODEL: simulações de paciente (Trilha/FreePlay/Neuro). Sonnet 4.6.
// HEAVY_MODEL: entrevistador (geração de prompts de pacientes). Opus 4.7.
// EVAL_MODEL: avaliador (v15). Opus 4.7 com prompt caching no system de ~23k.
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6';
const HEAVY_MODEL = process.env.ANTHROPIC_HEAVY_MODEL || 'claude-opus-4-7';
const EVAL_MODEL = process.env.ANTHROPIC_EVAL_MODEL || 'claude-opus-4-7';

function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

// Anthropic exige messages alternando user/assistant, sem role 'system' no array
// (system vai num campo separado). Normaliza: filtra system, garante alternância
// colapsando turnos consecutivos do mesmo role.
function normalizeMessagesForAnthropic(messages) {
  const cleaned = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content || '');
    if (!content) continue;
    if (cleaned.length && cleaned[cleaned.length - 1].role === m.role) {
      cleaned[cleaned.length - 1].content += '\n\n' + content;
    } else {
      cleaned.push({ role: m.role, content });
    }
  }
  return cleaned;
}

// Resolve o system prompt server-side a partir de context/mode enviados pelo
// cliente. Nunca confia em systemPrompt vindo do body. Retorna { systemPrompt,
// status, error } onde status é o HTTP code apropriado em caso de erro.
function resolveChatSystemPrompt({ context, mode, user }) {
  // Modo entrevistador é exclusivo de admin.
  if (mode === 'entrevistador') {
    if (!isAdmin(user)) return { status: 403, error: 'Acesso negado' };
    const prompt = loadEntrevistadorPrompt();
    if (!prompt) return { status: 500, error: 'Prompt do entrevistador não encontrado.' };
    return { systemPrompt: prompt };
  }

  // Modo padrão: cliente envia context com type + itemId; resolvemos o prompt
  // a partir do arquivo correspondente.
  if (!context || typeof context !== 'object') {
    return { status: 400, error: 'context é obrigatório (type + itemId)' };
  }
  const { type, itemId } = context;
  if (!['exercise', 'freeplay', 'neuro'].includes(type)) {
    return { status: 400, error: 'context.type inválido' };
  }
  if (!itemId) return { status: 400, error: 'context.itemId é obrigatório' };

  if (type === 'exercise') {
    const ex = readJSON('exercises.json').find((e) => String(e.id) === String(itemId));
    if (!ex) return { status: 404, error: 'Exercício não encontrado' };
    // Para a simulação (paciente), usamos a persona — o avaliador
    // customizado entra apenas no /api/evaluate.
    return { systemPrompt: buildFreeplayPrompt(ex.specificInstruction) };
  }
  if (type === 'freeplay') {
    const c = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(itemId));
    if (!c) return { status: 404, error: 'Personagem não encontrado' };
    return { systemPrompt: buildFreeplayPrompt(c.specificInstruction) };
  }
  if (type === 'neuro') {
    // Neuroavaliação não é acessível a visitor (deve revelar o diagnóstico
    // só na sessão completa, perfil destinado a alunos cadastrados).
    if (user.role === 'visitor') {
      return { status: 403, error: 'Neuroavaliação não está disponível em modo visitante.' };
    }
    const c = readJSON('neuro-characters.json').find((c) => String(c.id) === String(itemId));
    if (!c) return { status: 404, error: 'Paciente não encontrado' };
    return { systemPrompt: buildNeuroPrompt(c.specificInstruction) };
  }
  return { status: 400, error: 'Modo de chat inválido' };
}

app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context, mode, maxTokens } = req.body || {};
  const anthropic = getAnthropic();

  // Bloqueia tentativas de injetar systemPrompt — visível no log do servidor
  // pra ajudar a debugar clientes antigos que ainda enviam o campo.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'systemPrompt')) {
    return res.status(400).json({
      error: 'systemPrompt não é mais aceito no body. Use context: { type, itemId } ou mode.',
    });
  }

  const resolved = resolveChatSystemPrompt({ context, mode, user: req.user });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }

  if (!anthropic) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Olá, sou o personagem desta simulação. Como posso ajudá-lo nesta sessão?'
    });
  }

  // Default 1500 pra pacientes (Trilha/Simulação/Neuro) — resposta de
  // paciente raramente passa de 3 parágrafos, e segura snappy. Entrevistador
  // sobe pra 16000 (gera prompt de paciente longo, mas sem thinking então
  // 16k é folga real).
  const isEntrevistador = mode === 'entrevistador';
  const tokenCap = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.min(Math.floor(maxTokens), isEntrevistador ? 16000 : 4000)
    : 1500;

  const normalized = normalizeMessagesForAnthropic(messages);
  if (!normalized.length) {
    return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });
  }

  // Prompt caching: cache_control no system + último user message.
  // Em chat de paciente com 50-100 turnos isso reduz o custo de input em ~10x
  // — system+histórico viram cache_read (10% do preço) a partir do 2º turno.
  // Cada novo turno paga cache_creation só do delta (último user message).
  const systemBlocks = [
    { type: 'text', text: resolved.systemPrompt, cache_control: { type: 'ephemeral' } },
  ];
  const cachedMessages = normalized.map((m, i) => {
    if (i !== normalized.length - 1) return m;
    return {
      role: m.role,
      content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }],
    };
  });

  try {
    // Entrevistador roda no Opus 4.7 (prompt generation pede qualidade alta).
    // Pacientes ficam no Sonnet 4.6. Ambos SEM thinking — thinking estava
    // dobrando o custo sem ganho proporcional pra esses use cases.
    const chosenModel = isEntrevistador ? HEAVY_MODEL : CHAT_MODEL;
    const params = {
      model: chosenModel,
      max_tokens: tokenCap,
      system: systemBlocks,
      messages: cachedMessages,
    };
    // Stream + getFinalMessage pra evitar timeout HTTP em maxTokens altos;
    // resposta final tem o mesmo shape de uma chamada não-streaming.
    const stream = anthropic.messages.stream(params);
    const message = await stream.finalMessage();
    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (message.usage) {
      console.log(
        `Chat cache (${chosenModel}): read=${message.usage.cache_read_input_tokens || 0} create=${message.usage.cache_creation_input_tokens || 0} input=${message.usage.input_tokens || 0} output=${message.usage.output_tokens || 0}`,
      );
    }
    res.json({ role: 'assistant', content: text });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// Sanitiza o campo assistantId nos cadastros de personagem. Mantido por
// compatibilidade: dados antigos têm esse campo da era OpenAI Assistants API,
// e o admin/UI ainda exibe. A simulação inteira agora roda via /api/chat
// (Anthropic Messages), então o campo é cosmético — não roteia nada.
function sanitizeAssistantId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const match = s.match(/asst_[A-Za-z0-9]+/);
  return match ? match[0] : s;
}

// --- Avaliação de Sessão (Chat com IA) ---
const AVALIACAO_DIR = path.join(__dirname, '..', 'avaliacao');

function loadAvaliacaoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-v15.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Avaliador comparativo (Duelo): recebe os dois logs do mesmo caso e devolve a
// análise comparativa + JSON [notas-supervisor] com A1..A6 / B1..B6.
function loadComparativoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-comparativo-v1.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador comparativo não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Resolve o system prompt do avaliador server-side. Se context.type ===
// 'exercise' e o exercício tem evaluatorPrompt customizado, usa o customizado
// (envolvido com FORMATO OBRIGATÓRIO [NOTA:X]). Caso contrário, usa o
// avaliador global Allos.
function resolveEvaluatorSystemPrompt({ context }) {
  if (context && typeof context === 'object' && context.type === 'exercise' && context.itemId) {
    const ex = readJSON('exercises.json').find((e) => String(e.id) === String(context.itemId));
    if (!ex) return { status: 404, error: 'Exercício não encontrado' };
    if (ex.evaluatorPrompt && String(ex.evaluatorPrompt).trim()) {
      return { systemPrompt: wrapCustomEvaluatorPrompt(ex.evaluatorPrompt) };
    }
  }
  // freeplay, neuro, avaliação manual (sem context) → avaliador global
  return { systemPrompt: loadAvaliacaoPrompt() };
}

// Resolve o Bloco 1 (gabarito/critério de correção) do personagem, server-side.
// O texto fica fora do cliente — o aluno não pode ver a "resposta" do caso.
// Retorna string vazia quando o caso não tem evaluationCriteria configurado.
function resolveBloco1({ context }) {
  if (!context || typeof context !== 'object' || !context.itemId) return '';
  let char = null;
  if (context.type === 'freeplay') {
    char = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(context.itemId));
  } else if (context.type === 'neuro') {
    char = readJSON('neuro-characters.json').find((c) => String(c.id) === String(context.itemId));
  }
  const criteria = char && char.evaluationCriteria;
  return criteria && String(criteria).trim() ? String(criteria).trim() : '';
}

// Quando há Bloco 1 disponível, prepende ao conteúdo da PRIMEIRA mensagem do
// usuário no array. Em chats multi-turno (aba Avaliacao), a primeira user
// message continua sendo a transcrição original — então o gabarito fica sempre
// no topo do contexto, sem poluir as respostas/perguntas seguintes.
function withBloco1(messages, bloco1) {
  if (!bloco1) return messages;
  const idx = messages.findIndex((m) => m && m.role === 'user');
  if (idx === -1) return messages;
  const original = messages[idx];
  const prefix = `[BLOCO 1 DO CASO] (critério de correção/gabarito)\n${bloco1}\n\n---\n\n`;
  return [
    ...messages.slice(0, idx),
    { ...original, content: prefix + (original.content || '') },
    ...messages.slice(idx + 1),
  ];
}

app.post('/api/evaluate', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body || {};
  const anthropic = getAnthropic();

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'systemPrompt')) {
    return res.status(400).json({
      error: 'systemPrompt não é mais aceito no body. Use context: { type, itemId } quando aplicável.',
    });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }

  if (!anthropic) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Não é possível realizar a avaliação sem a chave da API.'
    });
  }

  const resolved = resolveEvaluatorSystemPrompt({ context });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  const bloco1 = resolveBloco1({ context });
  const finalMessages = withBloco1(messages, bloco1);
  const normalized = normalizeMessagesForAnthropic(finalMessages);
  if (!normalized.length) {
    return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });
  }

  try {
    // Prompt caching no system de ~32k tokens (avaliador v15) — a primeira
    // chamada paga cache_creation (~1.25x), as próximas dentro de 5min leem
    // a 10% do preço. Como o system raramente muda e cada avaliação reusa
    // exatamente os mesmos bytes de prefix, o hit rate fica alto.
    //
    // Sem thinking + effort high: o adaptive thinking estava gastando 8-15k
    // tokens × $75/M = $0.60-$1.10 por avaliação só de raciocínio interno.
    // Opus 4.7 já produz avaliação clínica densa sem precisar de thinking
    // extendido — os 6 critérios + nota final cabem em ~3-5k de output.
    //
    // max_tokens=16000 é folga real (output típico fica em 3-5k tokens).
    // Antes era 64000 pra acomodar thinking, agora não precisa.
    const stream = anthropic.messages.stream({
      model: EVAL_MODEL,
      max_tokens: 16000,
      system: [
        {
          type: 'text',
          text: resolved.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: normalized,
    });
    const message = await stream.finalMessage();
    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    // Log de cache hits ajuda a confirmar que o caching tá funcionando.
    if (message.usage) {
      console.log(
        `Evaluate cache: read=${message.usage.cache_read_input_tokens || 0} create=${message.usage.cache_creation_input_tokens || 0} input=${message.usage.input_tokens || 0} output=${message.usage.output_tokens || 0}`,
      );
    }
    res.json({ role: 'assistant', content: text });
  } catch (err) {
    console.error('Evaluate error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- Speech to Text Proxy ---
app.post('/api/transcribe', requireAuth, aiLimiter, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.json({ text: '[Transcrição não disponível sem API Key]' });
  }

  // Filename único por request — antes era 'tmp_audio.webm' fixo, então dois
  // /api/transcribe concorrentes sobrescreviam o áudio um do outro e o
  // segundo recebia transcrição do áudio errado.
  const tmpFile = path.join(DATA_DIR, `tmp_audio_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`);

  try {
    const { default: OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });
    // Audio comes as base64
    const buffer = Buffer.from(req.body.audio, 'base64');
    fs.writeFileSync(tmpFile, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'pt'
    });
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição' });
  } finally {
    // Limpeza sempre, mesmo se a chamada à OpenAI falhar
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
});

// ============================================================================
// DUELOS — avaliação comparada entre dois alunos atendendo o mesmo personagem
// ============================================================================
// Fluxo: o desafiante (challenger) escolhe um personagem e um oponente (um
// terapeuta do sistema OU um visitante via link). Cada um atende o MESMO
// personagem na sua própria sessão. Quando os DOIS enviam, o avaliador
// comparativo roda server-side, gera a análise + JSON [notas-supervisor]
// (A1..A6 = challenger, B1..B6 = opponent), e o backend calcula as duas notas
// (server/scoring.js) e o vencedor. Só treino por enquanto — não toca no MMR.

const DUEL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // mesma janela dos logs
const DUEL_MAX_MESSAGES = 500;
const DUEL_MAX_MESSAGE_LEN = 20000;

function readDuels() { return readJSON('duels.json', []); }
function writeDuels(d) { writeJSON('duels.json', d); }
function readNotifications() { return readJSON('notifications.json', {}); }
function writeNotifications(n) { writeJSON('notifications.json', n); }

function pruneExpiredDuels() {
  let duels;
  try { duels = readDuels(); } catch { return 0; }
  if (!Array.isArray(duels) || duels.length === 0) return 0;
  const cutoff = Date.now() - DUEL_TTL_MS;
  const kept = duels.filter((d) => {
    const t = new Date(d.createdAt || 0).getTime();
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  if (kept.length === duels.length) return 0;
  writeDuels(kept);
  return duels.length - kept.length;
}

// Cria uma notificação para um usuário real (visitantes não recebem).
function pushNotification(userId, notif) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const all = readNotifications();
  if (!all[userId]) all[userId] = [];
  all[userId].unshift({
    id: 'ntf-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    read: false,
    ...notif,
  });
  // Cap de 50 notificações por usuário pra não inchar o arquivo.
  if (all[userId].length > 50) all[userId] = all[userId].slice(0, 50);
  writeNotifications(all);
}

// Sanitiza mensagens enviadas pelo cliente ao submeter uma sessão de duelo.
function cleanDuelMessages(rawMessages) {
  const arr = Array.isArray(rawMessages) ? rawMessages.slice(0, DUEL_MAX_MESSAGES) : [];
  return arr
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && !m.isSystem)
    .map((m) => ({
      role: m.role,
      content: clampStr(m.content, DUEL_MAX_MESSAGE_LEN),
      highlighted: !!m.highlighted,
      comment: clampStr(m.comment, 2000),
    }));
}

// Monta a transcrição textual de um lado, no formato que o avaliador espera.
function transcriptFromMessages(messages, authorName, characterName) {
  return (messages || [])
    .map((m) => {
      const author = m.role === 'user' ? authorName : characterName;
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    })
    .join('\n\n---\n\n');
}

// Identidade pública de um usuário (pro card do oponente / lado do duelo).
function duelIdentity(user) {
  return {
    userId: user.id,
    name: user.name || user.username || 'Terapeuta',
    profilePhoto: user.profilePhoto || '',
    isVisitor: user.role === 'visitor',
  };
}

// Resolve qual lado do duelo é o usuário (challenger | opponent | null).
function duelSideFor(duel, user) {
  if (!user) return null;
  if (duel.challenger && duel.challenger.userId === user.id) return 'challenger';
  if (duel.opponent && duel.opponent.userId === user.id) return 'opponent';
  return null;
}

function isDuelParticipant(duel, user) {
  return !!duelSideFor(duel, user) || isAdmin(user);
}

// Versão do duelo segura pro cliente. Transcrições só aparecem quando o duelo
// está concluído (e só pra participantes/admin). Notas por critério só pra admin.
function sanitizeDuelForUser(duel, user) {
  const side = duelSideFor(duel, user);
  const completed = duel.status === 'completed';
  const sideView = (s, includeMessages) => ({
    userId: s.userId || null,
    name: s.name || null,
    profilePhoto: s.profilePhoto || '',
    isVisitor: !!s.isVisitor,
    kind: s.kind || undefined,
    state: s.state,
    accepted: !!s.accepted,
    submittedAt: s.submittedAt || null,
    durationSeconds: s.durationSeconds || 0,
    ...(includeMessages ? { messages: s.messages || [] } : {}),
  });
  const wantMessages = completed && (side || isAdmin(user));
  const out = {
    id: duel.id,
    createdAt: duel.createdAt,
    status: duel.status,
    mode: duel.mode,
    inviteMethod: duel.inviteMethod,
    character: duel.character,
    challenger: sideView(duel.challenger, wantMessages),
    opponent: sideView(duel.opponent, wantMessages),
    youAre: side,
  };
  // Token (pro link de WhatsApp) só pro desafiante e pro admin.
  if (side === 'challenger' || isAdmin(user)) out.token = duel.token;
  if (duel.result) {
    out.result = {
      winner: duel.result.winner,
      scoreChallenger: duel.result.scoreChallenger,
      scoreOpponent: duel.result.scoreOpponent,
      evaluation: duel.result.evaluation, // já vem sem o bloco [notas-supervisor]
      evaluatedAt: duel.result.evaluatedAt,
    };
    if (isAdmin(user)) {
      out.result.criteriaChallenger = duel.result.criteriaChallenger;
      out.result.criteriaOpponent = duel.result.criteriaOpponent;
    }
  }
  return out;
}

// Roda o avaliador comparativo nos dois logs e devolve as notas + texto limpo.
async function runComparativeEvaluation(duel) {
  const anthropic = getAnthropic();
  const challengerName = duel.challenger.name || 'Aluno A';
  const opponentName = duel.opponent.name || 'Aluno B';
  const logA = transcriptFromMessages(duel.challenger.messages, challengerName, duel.character.name);
  const logB = transcriptFromMessages(duel.opponent.messages, opponentName, duel.character.name);

  if (!anthropic) {
    // Modo demonstração (sem API key): nota neutra pros dois, sem vencedor real.
    const criteria = { A1: 5, A2: 5, A3: 5, A4: 5, A5: 5, A6: 5, B1: 5, B2: 5, B3: 5, B4: 5, B5: 5, B6: 5 };
    const comp = comparativeScores(criteria);
    return {
      evaluationClean: '[Modo demonstração — API Key não configurada] Avaliação comparativa indisponível.',
      comp,
    };
  }

  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: duel.character.id } });
  const userContent =
    (bloco1 ? `[BLOCO 1 DO CASO] (referência interna do avaliador — gabarito)\n${bloco1}\n\n---\n\n` : '') +
    `[LOG DO ALUNO A — ${challengerName}]\n${logA || '(sem mensagens)'}\n\n---\n\n` +
    `[LOG DO ALUNO B — ${opponentName}]\n${logB || '(sem mensagens)'}`;

  const stream = anthropic.messages.stream({
    model: EVAL_MODEL,
    max_tokens: 16000,
    system: [
      { type: 'text', text: loadComparativoPrompt(), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userContent }],
  });
  const message = await stream.finalMessage();
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (message.usage) {
    console.log(
      `Duel evaluate cache: read=${message.usage.cache_read_input_tokens || 0} create=${message.usage.cache_creation_input_tokens || 0} input=${message.usage.input_tokens || 0} output=${message.usage.output_tokens || 0}`,
    );
  }
  const { clean, criteria } = extractSupervisorNotes(text);
  const comp = comparativeScores(criteria);
  return { evaluationClean: clean, comp };
}

// Lista de oponentes possíveis: terapeutas do sistema (exceto você).
app.get('/api/duel/opponents', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não pode iniciar duelos.' });
  }
  const users = readJSON('users.json');
  const list = users
    .filter((u) => u.role === 'therapist' && u.id !== req.user.id)
    .map((u) => ({ userId: u.id, name: u.name || u.username, profilePhoto: u.profilePhoto || '' }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
  res.json(list);
});

// Cria um duelo. body: { characterId, opponentUserId?, inviteMethod }.
// - opponentUserId presente → convida um usuário específico.
//   inviteMethod 'system' dispara notificação in-app; 'whatsapp' gera só o link.
// - opponentUserId ausente → duelo aberto (link p/ visitante ou qualquer um).
app.post('/api/duel', requireAuth, writeLimiter, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não pode iniciar duelos.' });
  }
  const body = req.body || {};
  const character = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(body.characterId));
  if (!character) return res.status(404).json({ error: 'Personagem não encontrado.' });

  const inviteMethod = body.inviteMethod === 'system' ? 'system' : 'whatsapp';

  // Convite pelo sistema (in-app) é direcionado a um usuário específico, que
  // aceita pela notificação. Convite por WhatsApp/link é ABERTO: quem abrir o
  // link aceita (usuário logado ou visitante) — evita travar o aceite quando o
  // destinatário entra como visitante.
  let opponent;
  let notifyUserId = null;
  if (inviteMethod === 'system') {
    const opponentUserId = body.opponentUserId || null;
    if (!opponentUserId) return res.status(400).json({ error: 'Convite pelo sistema exige um oponente.' });
    const target = readJSON('users.json').find((u) => u.id === opponentUserId);
    if (!target || target.role === 'visitor') return res.status(404).json({ error: 'Oponente inválido.' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode duelar consigo mesmo.' });
    opponent = { ...duelIdentity(target), kind: 'user', state: 'invited', accepted: false, messages: [], durationSeconds: 0, submittedAt: null };
    notifyUserId = target.id;
  } else {
    opponent = { userId: null, name: null, profilePhoto: '', isVisitor: true, kind: 'open', state: 'invited', accepted: false, messages: [], durationSeconds: 0, submittedAt: null };
  }
  // Convite via link (whatsapp/aberto): challenger fica 'invited' até confirmar
  // que enviou o link ("Sim! Enviei"). Convite via sistema também só inicia a
  // sessão do challenger quando ele clica em iniciar — em ambos os casos o lado
  // do challenger começa como 'invited' e vira 'in_progress' no start.
  const duel = {
    id: 'duel-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode: 'training',
    status: 'pending',
    inviteMethod,
    character: { id: character.id, name: character.name },
    challenger: { ...duelIdentity(req.user), state: 'in_progress', messages: [], durationSeconds: 0, submittedAt: null },
    opponent,
    result: null,
  };

  const duels = readDuels();
  duels.push(duel);
  writeDuels(duels);

  // Convite in-app: notifica o oponente.
  if (notifyUserId) {
    pushNotification(notifyUserId, {
      type: 'duel_invite',
      duelId: duel.id,
      fromName: duel.challenger.name,
      fromUserId: req.user.id,
      characterName: character.name,
    });
  }

  res.json(sanitizeDuelForUser(duel, req.user));
});

// Detalhe de um duelo (participante ou admin).
app.get('/api/duel/:id', requireAuth, (req, res) => {
  const duel = readDuels().find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  if (!isDuelParticipant(duel, req.user)) return res.status(403).json({ error: 'Acesso negado.' });
  res.json(sanitizeDuelForUser(duel, req.user));
});

// Resumo de um duelo por token (pra tela de aceitar via link, inclusive visitante).
app.get('/api/duel/by-token/:token', requireAuth, (req, res) => {
  const duel = readDuels().find((d) => d.token === req.params.token);
  if (!duel) return res.status(404).json({ error: 'Convite inválido ou expirado.' });
  res.json({
    id: duel.id,
    status: duel.status,
    character: duel.character,
    challengerName: duel.challenger.name,
    opponentKind: duel.opponent.kind,
    opponentTaken: !!duel.opponent.userId,
    youAre: duelSideFor(duel, req.user),
  });
});

// Aceita um duelo enviado por link (token) — usuário logado OU visitante.
app.post('/api/duel/by-token/:token/accept', requireAuth, (req, res) => {
  const duels = readDuels();
  const duel = duels.find((d) => d.token === req.params.token);
  if (!duel) return res.status(404).json({ error: 'Convite inválido ou expirado.' });
  const out = acceptDuel(duel, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  writeDuels(duels);
  res.json(sanitizeDuelForUser(duel, req.user));
});

// Aceita um duelo recebido por notificação (convite in-app, usuário específico).
app.post('/api/duel/:id/accept', requireAuth, (req, res) => {
  const duels = readDuels();
  const duel = duels.find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  const out = acceptDuel(duel, req.user);
  if (out.error) return res.status(out.status).json({ error: out.error });
  // Marca a notificação de convite como lida.
  markDuelInviteRead(req.user.id, duel.id);
  writeDuels(duels);
  res.json(sanitizeDuelForUser(duel, req.user));
});

// Lógica compartilhada de aceite (muta o objeto duel; o caller persiste).
function acceptDuel(duel, user) {
  const side = duelSideFor(duel, user);
  if (side === 'challenger') return { status: 400, error: 'Você é o desafiante deste duelo.' };
  if (duel.status === 'completed') return { status: 400, error: 'Este duelo já foi concluído.' };
  // Já aceitou antes (convite in-app pré-atribui opponent.userId, mas só
  // consideramos "já é o oponente" quando accepted === true) → idempotente.
  if (side === 'opponent' && duel.opponent.accepted) return {};

  if (duel.opponent.kind === 'user') {
    // Convite in-app a um usuário específico: só esse usuário aceita.
    if (duel.opponent.userId && duel.opponent.userId !== user.id) {
      return { status: 403, error: 'Este convite é de outra pessoa.' };
    }
  } else {
    // Duelo aberto (link/WhatsApp): o primeiro a aceitar trava o lado do oponente.
    if (duel.opponent.userId && duel.opponent.userId !== user.id) {
      return { status: 409, error: 'Este duelo já foi aceito por outra pessoa.' };
    }
  }

  Object.assign(duel.opponent, duelIdentity(user), {
    kind: duel.opponent.kind,
    state: 'in_progress',
    accepted: true,
    acceptedAt: new Date().toISOString(),
    messages: duel.opponent.messages || [],
    durationSeconds: 0,
    submittedAt: null,
  });
  duel.updatedAt = new Date().toISOString();
  return {};
}

function markDuelInviteRead(userId, duelId) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const all = readNotifications();
  const list = all[userId];
  if (!list) return;
  let dirty = false;
  for (const n of list) {
    if (n.type === 'duel_invite' && n.duelId === duelId && !n.read) { n.read = true; dirty = true; }
  }
  if (dirty) writeNotifications(all);
}

// Submete a sessão de um lado. Quando os DOIS submeteram, roda o avaliador
// comparativo (no request do segundo a submeter) e grava o resultado.
app.post('/api/duel/:id/submit', requireAuth, aiLimiter, async (req, res) => {
  const duels = readDuels();
  const duel = duels.find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  const side = duelSideFor(duel, req.user);
  if (!side) return res.status(403).json({ error: 'Você não participa deste duelo.' });
  if (duel.status === 'completed') return res.json(sanitizeDuelForUser(duel, req.user));

  const messages = cleanDuelMessages(req.body && req.body.messages);
  const duration = Number.isFinite(req.body && req.body.durationSeconds)
    ? Math.max(0, Math.floor(req.body.durationSeconds)) : 0;

  duel[side].messages = messages;
  duel[side].durationSeconds = duration;
  duel[side].state = 'submitted';
  duel[side].submittedAt = new Date().toISOString();
  duel.updatedAt = new Date().toISOString();

  const bothSubmitted = duel.challenger.state === 'submitted' && duel.opponent.state === 'submitted';
  if (!bothSubmitted) {
    writeDuels(duels);
    return res.json(sanitizeDuelForUser(duel, req.user));
  }

  // Os dois enviaram → roda a avaliação comparativa agora.
  duel.status = 'evaluating';
  writeDuels(duels);

  try {
    const { evaluationClean, comp } = await runComparativeEvaluation(duel);
    // Relê e remapeia (o arquivo pode ter mudado durante a chamada à IA).
    const fresh = readDuels();
    const target = fresh.find((d) => d.id === duel.id) || duel;
    if (comp) {
      target.result = {
        winner: comp.winner === 'A' ? 'challenger' : comp.winner === 'B' ? 'opponent' : 'draw',
        scoreChallenger: comp.scoreA,
        scoreOpponent: comp.scoreB,
        criteriaChallenger: comp.criteriaChallenger,
        criteriaOpponent: comp.criteriaOpponent,
        evaluation: evaluationClean,
        evaluatedAt: new Date().toISOString(),
      };
      target.status = 'completed';
    } else {
      target.result = { winner: null, scoreChallenger: null, scoreOpponent: null, evaluation: evaluationClean, evaluatedAt: new Date().toISOString(), error: 'Não foi possível extrair as notas da avaliação.' };
      target.status = 'completed';
    }
    target.updatedAt = new Date().toISOString();
    writeDuels(fresh);

    // Notifica os dois lados reais com o resultado (visitantes ficam de fora).
    notifyDuelResult(target);
    return res.json(sanitizeDuelForUser(target, req.user));
  } catch (err) {
    console.error('Duel evaluation error:', err.message);
    const fresh = readDuels();
    const target = fresh.find((d) => d.id === duel.id) || duel;
    target.status = 'pending'; // volta a pendente pra permitir retry
    writeDuels(fresh);
    return res.status(500).json({ error: 'Erro ao avaliar o duelo: ' + err.message });
  }
});

function notifyDuelResult(duel) {
  if (!duel.result) return;
  const r = duel.result;
  const sides = [
    { s: duel.challenger, score: r.scoreChallenger, theirScore: r.scoreOpponent, won: r.winner === 'challenger', theirName: duel.opponent.name },
    { s: duel.opponent, score: r.scoreOpponent, theirScore: r.scoreChallenger, won: r.winner === 'opponent', theirName: duel.challenger.name },
  ];
  for (const side of sides) {
    if (!side.s.userId || side.s.isVisitor) continue;
    pushNotification(side.s.userId, {
      type: 'duel_result',
      duelId: duel.id,
      characterName: duel.character.name,
      opponentName: side.theirName,
      outcome: r.winner === 'draw' ? 'draw' : (side.won ? 'win' : 'loss'),
      yourScore: side.score,
      theirScore: side.theirScore,
    });
  }
}

// Logs sociais: duelos do usuário agrupados por oponente, ordenados por número
// de partidas (desc) e depois por nome do oponente (asc).
app.get('/api/duels/social', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json([]);
  pruneExpiredDuels();
  const duels = readDuels().filter((d) => isDuelParticipant(d, req.user));
  const groups = {};
  for (const d of duels) {
    const side = duelSideFor(d, req.user);
    if (!side && !isAdmin(req.user)) continue;
    const me = side === 'opponent' ? d.opponent : d.challenger;
    const them = side === 'opponent' ? d.challenger : d.opponent;
    const key = them.userId || (them.name ? `name:${them.name}` : `duel:${d.id}`);
    if (!groups[key]) {
      groups[key] = {
        opponent: { userId: them.userId || null, name: them.name || 'Visitante', profilePhoto: them.profilePhoto || '', isVisitor: !!them.isVisitor },
        count: 0, wins: 0, losses: 0, draws: 0, duels: [],
      };
    }
    const g = groups[key];
    g.count++;
    let outcome = null;
    let yourScore = null;
    let theirScore = null;
    if (d.result) {
      yourScore = side === 'opponent' ? d.result.scoreOpponent : d.result.scoreChallenger;
      theirScore = side === 'opponent' ? d.result.scoreChallenger : d.result.scoreOpponent;
      if (d.result.winner === 'draw') { outcome = 'draw'; g.draws++; }
      else if ((d.result.winner === 'challenger' && side === 'challenger') || (d.result.winner === 'opponent' && side === 'opponent')) { outcome = 'win'; g.wins++; }
      else { outcome = 'loss'; g.losses++; }
    }
    g.duels.push({
      id: d.id,
      characterName: d.character.name,
      date: d.result ? d.result.evaluatedAt : d.createdAt,
      status: d.status,
      outcome, yourScore, theirScore,
    });
  }
  const list = Object.values(groups)
    .map((g) => ({ ...g, duels: g.duels.sort((a, b) => new Date(b.date) - new Date(a.date)) }))
    .sort((a, b) => (b.count - a.count) || (a.opponent.name || '').localeCompare(b.opponent.name || '', 'pt-BR'));
  res.json(list);
});

// --- Notificações in-app ---
app.get('/api/notifications', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json({ items: [], unread: 0 });
  const all = readNotifications();
  const items = all[req.user.id] || [];
  res.json({ items, unread: items.filter((n) => !n.read).length });
});

app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json({ ok: true });
  const all = readNotifications();
  const items = all[req.user.id] || [];
  const n = items.find((x) => x.id === req.params.id);
  if (n) { n.read = true; writeNotifications(all); }
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json({ ok: true });
  const all = readNotifications();
  const items = all[req.user.id] || [];
  let dirty = false;
  for (const n of items) if (!n.read) { n.read = true; dirty = true; }
  if (dirty) writeNotifications(all);
  res.json({ ok: true });
});

// Serve static files in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Só faz listen quando executado diretamente (`node server/index.js`).
// Quando importado por testes (`require('./server/index.js')`), o supertest
// cria seu próprio server interno em porta aleatória — sem precisar de listen.
if (require.main === module) {
  // Limpeza de logs expirados no boot + a cada 6h. unref() pra não segurar o
  // processo vivo só por causa do timer.
  const removed = pruneExpiredLogs();
  if (removed > 0) console.log(`[logs] ${removed} log(s) expirado(s) (>${LOG_TTL_DAYS} dias) removido(s) no boot.`);
  setInterval(() => {
    const n = pruneExpiredLogs();
    if (n > 0) console.log(`[logs] ${n} log(s) expirado(s) removido(s).`);
  }, 6 * 60 * 60 * 1000).unref();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor Allos rodando na porta ${PORT}`));
}

module.exports = app;
