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
console.log('[startup] OPENAI_API_KEY    =', envDiag('OPENAI_API_KEY'), '(avaliadores + entrevistador GPT-5.4; e Whisper)');
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

// Sidequests: missões clínicas que o supervisor atribui a um aluno e que viram
// o objetivo principal no Treinamento (avaliadas pelo avaliador de progressão).
//  - bank: catálogo reutilizável de sidequests (definições).
//  - active: { <studentId>: <sidequest atribuída> } — no máx. 1 ativa por aluno.
//  - completed: { <studentId>: [ <sidequest concluída + recompensa> ] }.
// O Competitivo (MMR) ignora sidequests inteiramente.
if (!fs.existsSync(path.join(DATA_DIR, 'sidequests.json'))) {
  writeJSON('sidequests.json', { bank: [], active: {}, completed: {} });
}

// Modo Desafio (titular-desafiante): mapa { <characterId>: { titular, log } }.
// Vive dentro do Treinamento como aba paralela — não toca em logs.json,
// progressão, sidequests nem MMR. Quando o aluno clica no rosto do Titular
// atual entra como Desafiante; quando ninguém é Titular, clicar no 👑 inicia
// uma reivindicação (vira Titular ao final, independente da nota). Visitantes
// podem ser Titular, mas ficam como "Um visitante" (sem persistência de ID).
if (!fs.existsSync(path.join(DATA_DIR, 'desafio.json'))) {
  writeJSON('desafio.json', { titulares: {} });
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
    if (def) {
      safe.titleLabel = def.title;
      safe.titleTier = def.tier;
    } else {
      // Pode ser um título de recompensa de sidequest (qt-*).
      const quest = resolveQuestTitle(safe.id, safe.activeTitle);
      safe.titleLabel = quest ? quest.label : null;
      safe.titleTier = quest ? quest.tier : null;
    }
  }
  if (safe.role === 'therapist' && safe.teacherId) {
    try {
      const users = readJSON('users.json');
      const teacher = users.find((t) => t.id === safe.teacherId);
      if (teacher && teacher.name) safe.teacherName = teacher.name;
    } catch {}
  }
  // Coroas (modo Desafio): lista de personagens onde o usuário é Titular atual.
  // Visitante recebe [] — id efêmero, não persistimos titularidade dele em
  // termos de identidade. getUserCrowns lê desafio.json e filtra por userId.
  try {
    safe.crowns = getUserCrowns(safe.id);
  } catch { safe.crowns = []; }
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

// Define o "título" (subtítulo) ativo exibido no perfil e no ranking. SÓ
// conquistas de OURO valem como título — e somente se já RESGATADAS pelo
// usuário (achievements.json). Sidequests (qt-*) também valem. titleId vazio limpa.
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

  // Título de recompensa de sidequest (qt-*): valida contra as sidequests
  // concluídas pelo próprio usuário (não vive em ACHIEVEMENT_DEFS).
  if (String(titleId).startsWith('qt-')) {
    const quest = resolveQuestTitle(req.user.id, titleId);
    if (!quest) {
      return res.status(403).json({ error: 'Você ainda não desbloqueou esse título.' });
    }
    users[idx].activeTitle = titleId;
    writeJSON('users.json', users);
    return res.json(publicUser(users[idx]));
  }

  const def = ACHIEVEMENT_DEFS.find((d) => d.id === titleId);
  if (!def) return res.status(400).json({ error: 'Título inválido.' });
  if (def.tier !== 'gold') {
    return res.status(403).json({ error: 'Apenas conquistas de ouro podem virar título de perfil.' });
  }

  // Precisa estar RESGATADA (claim). O claim já revalidou o critério server-side.
  const ach = readJSON('achievements.json', {});
  if (!(ach[req.user.id] && ach[req.user.id][titleId])) {
    return res.status(403).json({ error: 'Você precisa resgatar essa conquista antes de exibi-la.' });
  }
  users[idx].activeTitle = titleId;
  writeJSON('users.json', users);
  res.json(publicUser(users[idx]));
});

// Resgatar ("claim") uma conquista. Só grava se o critério estiver de fato
// cumprido (revalidado server-side via achievementsForUser). Visitante não resgata.
app.post('/api/achievements/:id/claim', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não acumula conquistas.' });
  }
  const id = req.params.id;
  const def = ACHIEVEMENT_DEFS.find((d) => d.id === id);
  if (!def) return res.status(404).json({ error: 'Conquista inválida.' });

  const userId = req.user.id;
  const userLogs = readJSON('logs.json').filter((l) => l.userId === userId);
  const streak = computeStreak(userLogs);
  const { unlocked } = achievementsForUser(userId, userLogs, streak, readJSON('freeplay-characters.json'));
  if (!unlocked.has(id)) {
    return res.status(403).json({ error: 'Você ainda não cumpriu o requisito desta conquista.' });
  }

  const ach = readJSON('achievements.json', {});
  if (!ach[userId]) ach[userId] = {};
  if (!ach[userId][id]) {
    ach[userId][id] = new Date().toISOString();
    writeJSON('achievements.json', ach);
  }
  res.json({ id, claimed: true, claimedAt: ach[userId][id], tier: def.tier, title: def.title });
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
// Conquistas separadas por dificuldade: bronze, silver (prata), gold (ouro).
// SÓ as de OURO valem como título de perfil (ver POST /api/me/title).
// `target` (opcional) = meta numérica → ganha barra de progresso no front; o
// valor atual vem em `progress[id]` (computado em computeAchievements).
// As conquistas são RESGATÁVEIS ("claim"): ficam disponíveis quando o critério
// é cumprido (`unlocked`) e só contam como ganhas (`earned`) após o resgate
// (POST /api/achievements/:id/claim, gravado em achievements.json).
const ACHIEVEMENT_DEFS = [
  // ---------- BRONZE ----------
  { id: 'first_session',  icon: '◐', title: 'Primeira Sessão',            description: 'Concluiu sua primeira sessão na plataforma.',                          tier: 'bronze' },
  { id: 'first_ranked',   icon: '◔', title: 'Primeira sessão ranqueada',  description: 'Concluiu sua primeira sessão no modo Competitivo.',                     tier: 'bronze' },
  { id: 'madrugador',     icon: '☾', title: 'Madrugador',                 description: 'Realizou uma sessão entre 1h e 5h da madrugada.',                       tier: 'bronze' },
  { id: 'changed_photo',  icon: '☺', title: 'Não sou mais o Isaac',       description: 'Trocou a foto de perfil padrão pela sua.',                              tier: 'bronze' },
  { id: 'invited_friend', icon: '✉', title: 'Chamei um amigo!',           description: 'Convidou um visitante para um duelo de treino (não ranqueado).',        tier: 'bronze' },

  // ---------- PRATA ----------
  { id: 'constancia',     icon: '●', title: 'Constância',                 description: 'Manteve constância de 4 semanas consecutivas.',                         tier: 'silver', target: 4 },
  { id: 'eficiencia',     icon: '↗', title: 'Eficiência',                 description: 'Concluiu uma sessão em menos de 5 min com pontuação acima de 60.',      tier: 'silver' },
  { id: 'consistente',    icon: '≡', title: 'Consistente',                description: 'Jogou uma partida ranqueada sem alterar o seu MMR.',                    tier: 'silver' },
  { id: 'papagaio',       icon: '◍', title: 'Papagaio',                   description: 'Usou o botão de microfone 100 vezes.',                                  tier: 'silver', target: 100 },
  { id: 'destronador',    icon: '⇅', title: 'Destronador',                description: 'No Modo Desafio, retomou um paciente que acabou de perder.',            tier: 'silver' },
  { id: 'bom_garoto',     icon: '✓', title: 'Bom garoto',                 description: 'Cumpriu todas as missões diárias por 7 dias seguidos.',                 tier: 'silver', target: 7 },

  // ---------- OURO (valem título de perfil) ----------
  { id: 'simulacao_complete', icon: '◇', title: 'Repertório Clínico',     description: 'Concluiu todos os personagens da Simulação.',                           tier: 'gold' },
  { id: 'excelencia',         icon: '★', title: 'Excelência Técnica',     description: 'Atingiu pontuação maior ou igual a 90 em uma sessão.',                  tier: 'gold' },
  { id: 'perfeicao',          icon: '✪', title: 'Perfeição',              description: 'Tirou nota 100 em uma sessão.',                                         tier: 'gold' },
  { id: 'meteu_o_lacan',      icon: '⊛', title: 'Meteu o Lacan',          description: 'Tirou 80 ou mais em uma sessão com até 10 mensagens.',                  tier: 'gold' },
  { id: 'estrelinha',         icon: '✶', title: 'Estrelinha',             description: 'Marcou 1000 mensagens como destaque.',                                  tier: 'gold', target: 1000 },
  { id: 'centena',            icon: '∞', title: 'Centena',                description: 'Concluiu 100 sessões em qualquer modo.',                                tier: 'gold', target: 100 },
  { id: 'persistencia',       icon: '❖', title: 'Persistência',           description: 'Manteve constância por 20 semanas.',                                    tier: 'gold', target: 20 },
  { id: 'rei',                icon: '♛', title: 'Rei',                     description: 'Foi Titular de 7 pacientes ao mesmo tempo.',                            tier: 'gold', target: 7 },
  { id: 'duelista',           icon: '⚔', title: 'Duelista',               description: 'Venceu 10 duelos ranqueados.',                                          tier: 'gold', target: 10 },
  { id: 'invicto',            icon: '⚑', title: 'Invicto',                description: 'Venceu 5 duelos ranqueados consecutivos.',                              tier: 'gold', target: 5 },
  { id: 'davi_golias',        icon: '◭', title: 'Davi e Golias',          description: 'Venceu um duelo ranqueado contra alguém com 30+ de MMR a mais que você.', tier: 'gold' },
  { id: 'vinganca',           icon: '⚡', title: 'Vingança',               description: 'No Modo Desafio, roubou um paciente de quem já tinha roubado um seu.',  tier: 'gold' },
];

// Foto de perfil padrão ("Isaac"): a conquista "Não sou mais o Isaac" dispara
// quando o usuário troca por qualquer outra.
const DEFAULT_PROFILE_PHOTO = '/profiles_icon/isaacdeterno.jpeg';
function isDefaultProfilePhoto(photo) {
  return !photo || photo === DEFAULT_PROFILE_PHOTO;
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

// Chave de semana (ISO 8601 simplificado): retorna a data ISO da SEGUNDA-feira
// da semana de `timestamp` em UTC. Duas datas têm a mesma semana se compartilham
// a mesma "monday key" (formato YYYY-MM-DD). Diferença entre duas mondays
// consecutivas é exatamente 7 dias — facilita o cálculo de runs.
function weekKey(timestamp) {
  const d = new Date(timestamp);
  // getUTCDay(): domingo=0..sábado=6. Convertendo pra ISO (segunda=1..domingo=7):
  const isoDay = d.getUTCDay() || 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (isoDay - 1)));
  return monday.toISOString().slice(0, 10);
}

// Streak em SEMANAS consecutivas. Uma semana é "ativa" quando o usuário tem
// pelo menos um log nela (qualquer dia entre segunda e domingo UTC). Mudou de
// streak diária — a régua agora é constância semanal: você não precisa abrir
// o app todo dia, só pelo menos uma vez por semana pra manter a sequência.
function computeStreak(userLogs) {
  if (!userLogs.length) {
    return {
      current: 0, longest: 0, isAlive: false, lastActiveDate: null,
      status: 'none', daysToNextWeek: 7, weeksToMonthly: 4,
    };
  }
  const weeks = new Set(userLogs.map((l) => weekKey(l.timestamp || l.createdAt || Date.now())));
  const thisWeek = weekKey(Date.now());
  const lastWeek = weekKey(Date.now() - 7 * 86400000);

  // Cursor: começa na semana atual (se tem log) ou na anterior (carência de 1
  // semana — você não perde a streak imediatamente quando vira a segunda).
  let cursor = weeks.has(thisWeek) ? thisWeek : (weeks.has(lastWeek) ? lastWeek : null);
  let current = 0;
  if (cursor) {
    const d = new Date(cursor + 'T00:00:00Z');
    while (weeks.has(d.toISOString().slice(0, 10))) {
      current++;
      d.setUTCDate(d.getUTCDate() - 7);
    }
  }

  const sorted = [...weeks].sort();
  let longest = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) { run = 1; continue; }
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z');
    const cur = new Date(sorted[i] + 'T00:00:00Z');
    const diff = Math.round((cur - prev) / 86400000);
    if (diff === 7) run++;
    else { longest = Math.max(longest, run); run = 1; }
  }
  longest = Math.max(longest, run);

  const isAlive = current > 0;
  // Última data de atividade real (pra UI mostrar "última sessão em...").
  const allDays = userLogs
    .map((l) => dayKey(l.timestamp || l.createdAt || Date.now()))
    .sort();
  const lastActiveDate = allDays[allDays.length - 1] || null;
  // status: 4+ semanas = mensal; 1+ = semanal; 0 = none.
  const status = current >= 4 ? 'monthly' : current >= 1 ? 'weekly' : 'none';

  // Dias até a próxima segunda UTC (quando uma nova semana começa). Se hoje é
  // segunda, fica 7; se domingo, fica 1.
  const now = new Date();
  const isoDayNow = now.getUTCDay() || 7;
  const daysToNextWeek = 8 - isoDayNow;

  return {
    current,
    longest,
    isAlive,
    lastActiveDate,
    status,
    daysToNextWeek,
    weeksToMonthly: Math.max(0, 4 - current),
  };
}

function computeDailyMissions(userLogs) {
  const today = dayKey(Date.now());
  const todayLogs = userLogs.filter((l) => dayKey(l.timestamp) === today);
  const totalToday = todayLogs.length;
  const rankedToday = todayLogs.filter((l) => l.mode === 'competitive').length;

  return [
    { id: 'daily_session', icon: '◯', title: 'Sessão diária', description: 'Conclua 1 sessão hoje (qualquer modo)', target: 1, progress: Math.min(totalToday, 1), completed: totalToday >= 1 },
    { id: 'daily_ranked',  icon: '◔', title: 'Competindo',    description: 'Conclua 1 sessão ranqueada hoje',       target: 1, progress: Math.min(rankedToday, 1), completed: rankedToday >= 1 },
  ];
}

// Todas as missões diárias completas hoje? (base do streak da conquista "Bom garoto")
function allDailyMissionsCompleteToday(userLogs) {
  const missions = computeDailyMissions(userLogs);
  return missions.length > 0 && missions.every((m) => m.completed);
}

// --- Contadores diversos persistidos (uso de microfone etc.) ---
function getMicUses(userId) {
  const c = readJSON('counters.json', {});
  return (c[userId] && c[userId].micUses) || 0;
}
function bumpMicUses(userId) {
  const c = readJSON('counters.json', {});
  if (!c[userId]) c[userId] = {};
  c[userId].micUses = (c[userId].micUses || 0) + 1;
  writeJSON('counters.json', c);
}

// --- Streak de missões diárias (conquista "Bom garoto" = 7 dias seguidos) ---
function getDailyMissionStreak(userId) {
  const d = readJSON('daily-missions.json', {});
  return d[userId] || { current: 0, best: 0, lastDate: null };
}
function updateDailyMissionStreak(userId, userLogs) {
  if (!allDailyMissionsCompleteToday(userLogs)) return;
  const store = readJSON('daily-missions.json', {});
  const today = dayKey(Date.now());
  const rec = store[userId] || { current: 0, best: 0, lastDate: null };
  if (rec.lastDate === today) return; // já contado hoje
  const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
  rec.current = rec.lastDate === yesterday ? (rec.current || 0) + 1 : 1;
  rec.lastDate = today;
  rec.best = Math.max(rec.best || 0, rec.current);
  store[userId] = rec;
  writeJSON('daily-missions.json', store);
}

// --- Histórico de trocas de titularidade do Modo Desafio (Vingança/Destronador) ---
// Cada entrada: { characterId, characterName, fromUserId, toUserId, reason, at }.
// fromUserId null = posição estava vaga (reivindicação inicial).
function appendDesafioHistory(entry) {
  const hist = readJSON('desafio-history.json', []);
  hist.push({ ...entry, at: new Date().toISOString() });
  if (hist.length > 5000) hist.splice(0, hist.length - 5000); // teto defensivo
  writeJSON('desafio-history.json', hist);
}

// --- Helpers de duelo (conquistas competitivas) ---
// Visão do usuário num duelo ranqueado concluído, ou null se não se aplica.
function duelUserView(duel, userId) {
  const m = duel && duel.result && duel.result.mmr;
  if (!m || !m.ranked) return null;
  let side = null;
  if (duel.challenger && duel.challenger.userId === userId) side = 'challenger';
  else if (duel.opponent && duel.opponent.userId === userId) side = 'opponent';
  if (!side) return null;
  const mine = m[side];
  const other = side === 'challenger' ? m.opponent : m.challenger;
  if (!mine || !other) return null;
  return {
    won: duel.result.winner === side,
    myBefore: mine.before,
    myAfter: mine.after,
    oppBefore: other.before,
    at: duel.result.evaluatedAt || duel.updatedAt || duel.createdAt || '',
  };
}
// Duelos ranqueados do usuário, mais antigo → mais recente (para sequências).
function userRankedDuelViews(duels, userId) {
  return (duels || [])
    .map((d) => duelUserView(d, userId))
    .filter(Boolean)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

// --- Helpers de Modo Desafio sobre o histórico de trocas ---
// Vingança: alguém roubou um paciente meu e, depois, eu roubei um paciente dele.
function desafioRevenge(history, userId) {
  const evts = [...(history || [])].sort((a, b) => new Date(a.at) - new Date(b.at));
  const tookFromMeAt = {}; // X -> instante em que X me roubou um paciente
  for (const e of evts) {
    if (e.fromUserId === userId && e.toUserId && e.toUserId !== userId && !tookFromMeAt[e.toUserId]) {
      tookFromMeAt[e.toUserId] = e.at;
    }
    if (e.toUserId === userId && e.fromUserId && tookFromMeAt[e.fromUserId] &&
        new Date(tookFromMeAt[e.fromUserId]) < new Date(e.at)) {
      return true;
    }
  }
  return false;
}
// Destronador: retomei um paciente logo após perdê-lo (troca consecutiva na
// mesma posição: eu perdi e a mudança seguinte daquele personagem é eu de volta).
function desafioRetake(history, userId) {
  const byChar = {};
  for (const e of (history || [])) {
    if (!byChar[e.characterId]) byChar[e.characterId] = [];
    byChar[e.characterId].push(e);
  }
  for (const cid of Object.keys(byChar)) {
    const evts = byChar[cid].sort((a, b) => new Date(a.at) - new Date(b.at));
    for (let i = 1; i < evts.length; i++) {
      if (evts[i].toUserId === userId && evts[i - 1].fromUserId === userId) return true;
    }
  }
  return false;
}

// Cálculo unificado das conquistas. Retorna { unlocked:Set, progress:{} }.
// `unlocked` = critério cumprido (resgatável); `progress[id]` = valor atual das
// que têm meta (barra de progresso no front).
function computeAchievements(ctx) {
  const { userLogs, streak, freeplay, duels, crownsCount, micUses, desafioHistory, profilePhoto, dailyStreakBest, userId } = ctx;
  const unlocked = new Set();
  const progress = {};
  const add = (id) => unlocked.add(id);
  const scores = userLogs.map((l) => l.score).filter((s) => Number.isFinite(s));

  // ---------- BRONZE ----------
  if (userLogs.length >= 1) add('first_session');
  if (userLogs.some((l) => l.mode === 'competitive')) add('first_ranked');
  if (userLogs.some((l) => { const h = new Date(l.timestamp).getHours(); return h >= 1 && h < 5; })) add('madrugador');
  if (!isDefaultProfilePhoto(profilePhoto)) add('changed_photo');
  if ((duels || []).some((d) => d.mode !== 'competitive' && d.challenger && d.challenger.userId === userId && d.opponent && (d.opponent.isVisitor || d.opponent.kind === 'open'))) add('invited_friend');

  // ---------- PRATA ----------
  progress.constancia = streak.longest;
  if (streak.longest >= 4) add('constancia');

  if (userLogs.some((l) => (l.durationSeconds || 9999) < 300 && Number.isFinite(l.score) && l.score > 60)) add('eficiencia');

  const consistentPvE = userLogs.some((l) => l.mode === 'competitive' && Number.isFinite(l.mmrBefore) && Number.isFinite(l.mmrAfter) && Math.round(l.mmrBefore) === Math.round(l.mmrAfter));
  const consistentDuel = userRankedDuelViews(duels, userId).some((v) => Number.isFinite(v.myBefore) && Number.isFinite(v.myAfter) && Math.round(v.myBefore) === Math.round(v.myAfter));
  if (consistentPvE || consistentDuel) add('consistente');

  progress.papagaio = micUses || 0;
  if ((micUses || 0) >= 100) add('papagaio');

  if (desafioRetake(desafioHistory, userId)) add('destronador');

  progress.bom_garoto = dailyStreakBest || 0;
  if ((dailyStreakBest || 0) >= 7) add('bom_garoto');

  // ---------- OURO (valem título de perfil) ----------
  const freeplayIds = new Set(userLogs.filter((l) => l.type === 'freeplay' && l.itemId).map((l) => String(l.itemId)));
  progress.simulacao_complete = (freeplay || []).filter((c) => freeplayIds.has(String(c.id))).length;
  if ((freeplay || []).length > 0 && freeplay.every((c) => freeplayIds.has(String(c.id)))) add('simulacao_complete');

  if (scores.some((s) => s >= 90)) add('excelencia');
  if (scores.some((s) => s >= 100)) add('perfeicao');
  if (userLogs.some((l) => Number.isFinite(l.score) && l.score >= 80 && Array.isArray(l.messages) && l.messages.length <= 10)) add('meteu_o_lacan');

  let highlights = 0;
  for (const l of userLogs) if (Array.isArray(l.messages)) highlights += l.messages.filter((m) => m && m.highlighted).length;
  progress.estrelinha = highlights;
  if (highlights >= 1000) add('estrelinha');

  progress.centena = userLogs.length;
  if (userLogs.length >= 100) add('centena');

  progress.persistencia = streak.longest;
  if (streak.longest >= 20) add('persistencia');

  progress.rei = crownsCount || 0;
  if ((crownsCount || 0) >= 7) add('rei');

  const views = userRankedDuelViews(duels, userId);
  const rankedWins = views.filter((v) => v.won).length;
  progress.duelista = rankedWins;
  if (rankedWins >= 10) add('duelista');

  let cur = 0, bestStreak = 0;
  for (const v of views) { if (v.won) { cur += 1; bestStreak = Math.max(bestStreak, cur); } else { cur = 0; } }
  progress.invicto = bestStreak;
  if (bestStreak >= 5) add('invicto');

  if (views.some((v) => v.won && Number.isFinite(v.oppBefore) && Number.isFinite(v.myBefore) && (v.oppBefore - v.myBefore) >= 30)) add('davi_golias');

  if (desafioRevenge(desafioHistory, userId)) add('vinganca');

  return { unlocked, progress };
}

// Monta o contexto e roda computeAchievements para um usuário. Centraliza a
// leitura das várias fontes (logs, duelos, coroas, contadores, histórico).
function achievementsForUser(userId, userLogs, streak, freeplay) {
  return computeAchievements({
    userLogs,
    streak,
    freeplay,
    duels: readDuels(),
    crownsCount: getUserCrowns(userId).length,
    micUses: getMicUses(userId),
    desafioHistory: readJSON('desafio-history.json', []),
    profilePhoto: (readJSON('users.json').find((u) => u.id === userId) || {}).profilePhoto,
    dailyStreakBest: getDailyMissionStreak(userId).best || 0,
    userId,
  });
}

app.get('/api/gamification/:userId', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const userId = req.params.userId;
  const allLogs = readJSON('logs.json');
  const userLogs = allLogs.filter((l) => l.userId === userId);
  const freeplay  = readJSON('freeplay-characters.json');

  const streak = computeStreak(userLogs);
  const dailyMissions = computeDailyMissions(userLogs);
  const { unlocked, progress } = achievementsForUser(userId, userLogs, streak, freeplay);

  // claimed = conquistas RESGATADAS (gravadas em achievements.json). Não há mais
  // resgate automático: o usuário precisa resgatar (POST /api/achievements/:id/claim).
  const ach = readJSON('achievements.json', {});
  const claimedMap = ach[userId] || {};

  const achievements = ACHIEVEMENT_DEFS.map((def) => {
    const isUnlocked = unlocked.has(def.id);
    const claimedAt = claimedMap[def.id] || null;
    const out = {
      ...def,
      unlocked: isUnlocked,
      claimed: !!claimedAt,
      claimable: isUnlocked && !claimedAt,
      earned: !!claimedAt,          // compat: "ganha" = resgatada
      earnedAt: claimedAt,
    };
    if (Number.isFinite(def.target)) {
      out.progressRaw = progress[def.id] || 0;
      out.progress = Math.min(out.progressRaw, def.target);
    }
    return out;
  });

  // Sidequests concluídas entram como conquistas (tier 'quest'): aparecem nas
  // "Metas" já resgatadas e ficam selecionáveis como subtítulo.
  const completedQuests = readSidequests().completed[userId] || [];
  for (const q of completedQuests) {
    achievements.push({
      id: q.rewardTitleId,
      icon: '✦',
      title: q.rewardTitleLabel,
      description: `Sidequest concluída: ${q.title}`,
      tier: q.rewardTitleTier || 'quest',
      unlocked: true,
      claimed: true,
      claimable: false,
      earned: true,
      earnedAt: q.completedAt || null,
      sidequest: true,
    });
  }

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

// Extrai um bloco de resultado de objetivo do texto do avaliador. Genérico para
// [sidequest-resultado] ({sidequest_completed}) e [missao-diaria-resultado]
// ({daily_completed}). O bloco vem ANTES do [notas-supervisor]; rode esta
// extração no texto já limpo das notas (ou encadeie uma após a outra). Splice só
// do próprio bloco → independe da ordem em que os blocos foram emitidos.
// Retorna { clean, result } — result null quando não há bloco. Destinado a
// supervisor/sistema; o aluno nunca vê o JSON.
function extractResultBlock(evaluation, marker, completedKey) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  const markerRe = new RegExp('\\[' + marker + '\\]', 'i');
  const markerMatch = text.match(markerRe);
  if (!markerMatch) return { clean: text, result: null };
  const markerIdx = markerMatch.index;
  const after = text.slice(markerIdx);
  const jsonMatch = after.match(/\{[\s\S]*?\}/);
  let result = null;
  let blockEnd = markerIdx + after.match(new RegExp('\\[' + marker + '\\][^\\n]*', 'i'))[0].length;
  if (jsonMatch) {
    blockEnd = markerIdx + jsonMatch.index + jsonMatch[0].length;
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const v = obj[completedKey];
        result = {
          completed: v === true || String(v).toLowerCase() === 'true',
          justification: typeof obj.justification === 'string' ? obj.justification : '',
        };
      }
    } catch {}
  }
  const before = text.slice(0, markerIdx);
  const sep = before.match(/\n*-{3,}[^\S\n]*\n*$/);
  const start = sep ? before.length - sep[0].length : markerIdx;
  const clean = (text.slice(0, start) + text.slice(blockEnd)).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, result };
}
function extractSidequestResult(evaluation) {
  return extractResultBlock(evaluation, 'sidequest-resultado', 'sidequest_completed');
}
function extractDailyMissionResult(evaluation) {
  return extractResultBlock(evaluation, 'missao-diaria-resultado', 'daily_completed');
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
  // Extrai primeiro o [sidequest-resultado] (remove só o próprio bloco, em
  // qualquer posição), depois o [notas-supervisor] (até o fim). Assim a extração
  // independe da ordem em que o avaliador emitiu os dois blocos.
  const { clean: cleanAfterSq, result: sidequestResult } = extractSidequestResult(body.evaluation);
  const { clean: cleanAfterDaily, result: dailyResult } = extractDailyMissionResult(cleanAfterSq);
  const { clean: cleanEvaluation, criteria: supervisorCriteria } = extractSupervisorNotes(cleanAfterDaily);

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
    // Grava o MMR antes/depois desta partida no log (conquista "Consistente":
    // MMR arredondado inalterado). Reescreve o log já persistido.
    log.mmrBefore = Math.round(result.P_before);
    log.mmrAfter = Math.round(result.P_after);
    writeJSON('logs.json', logs);
  }

  // Sidequest: só no Treinamento (freeplay + mode 'training'). Se o aluno tinha
  // uma sidequest ativa e o avaliador a marcou como cumprida, conclui aqui —
  // move pra histórico, concede o título de recompensa e devolve o resultado pra
  // tela pós-sessão celebrar. O Competitivo (mode 'competitive') nunca entra.
  let sidequestOutcome = null;
  if (log.type === 'freeplay' && mode === 'training' && req.user.role !== 'visitor') {
    const active = getActiveSidequest(req.user.id);
    if (active && sidequestResult) {
      if (sidequestResult.completed) {
        const record = completeSidequest(req.user.id, sidequestResult.justification, {
          characterId: log.itemId,
          characterName: log.itemTitle,
        });
        if (record) {
          sidequestOutcome = {
            completed: true,
            title: record.title,
            rewardTitleId: record.rewardTitleId,
            rewardTitleLabel: record.rewardTitleLabel,
          };
        }
      } else {
        sidequestOutcome = { completed: false, title: active.title };
      }
    }
  }

  // Missão diária (desafio do dia, rotacionado do banco): mesmo gate da sidequest
  // — Treinamento, não-visitante. Independente da sidequest (uma não anula a outra).
  let dailyMissionOutcome = null;
  if (log.type === 'freeplay' && mode === 'training' && req.user.role !== 'visitor') {
    const activeDaily = getActiveDailyMission(req.user.id);
    if (activeDaily && dailyResult) {
      if (dailyResult.completed) {
        const record = completeDailyMission(req.user.id, dailyResult.justification, {
          characterId: log.itemId,
          characterName: log.itemTitle,
        });
        if (record) {
          dailyMissionOutcome = {
            completed: true,
            title: record.title,
            rewardTitleId: record.rewardTitleId,
            rewardTitleLabel: record.rewardTitleLabel,
          };
        }
      } else {
        dailyMissionOutcome = { completed: false, title: activeDaily.title };
      }
    }
  }

  // Streak de missões diárias (conquista "Bom garoto" = 7 dias seguidos). Conta
  // com o novo log já incluído; visitante não acumula.
  if (req.user.role !== 'visitor') {
    updateDailyMissionStreak(req.user.id, logs.filter((l) => l.userId === req.user.id));
  }

  res.json({ ...log, mmr: mmrResult, sidequest: sidequestOutcome, dailyMission: dailyMissionOutcome });
});

// --- Ranking global de jogadores (por MMR competitivo) ---
// O ranking ordena pelo MMR (P) do modo Competitivo. Só entra quem jogou ao
// menos 1 partida competitiva. Nas 3 primeiras partidas o MMR fica oculto
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
      let titleLabel = null, titleTier = null;
      if (u.activeTitle) {
        const def = ACHIEVEMENT_DEFS.find((d) => d.id === u.activeTitle);
        if (def) { titleLabel = def.title; titleTier = def.tier; }
        else {
          const quest = resolveQuestTitle(u.id, u.activeTitle);
          if (quest) { titleLabel = quest.label; titleTier = quest.tier; }
        }
      }
      return {
        userId: u.id,
        name: u.name || u.username,
        profilePhoto: u.profilePhoto || '',
        role: u.role,
        title: titleLabel,
        titleTier: titleTier,
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

// --- Configurações globais da plataforma (settings.json) ---
// Flags controladas pelo admin. Hoje: visitorEvaluationEnabled — liga a avaliação
// (gpt-5.4, via Simulação Livre, o único modo que o visitante acessa) para
// VISITANTES. Default FALSE: no dia a dia o visitante joga sem avaliação (não
// queima tokens nem expõe a IA). O dono liga durante palestras/eventos pra deixar
// as pessoas testarem e verem a avaliação funcionando, e desliga depois.
function readSettings() {
  return readJSON('settings.json', {});
}
function visitorEvaluationEnabled() {
  return readSettings().visitorEvaluationEnabled === true;
}

// Configurações visíveis ao cliente — QUALQUER usuário autenticado (inclusive
// visitante: o EchoSession precisa saber se deve rodar a avaliação do visitante).
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ visitorEvaluationEnabled: visitorEvaluationEnabled() });
});

// Toggle das flags (admin-only).
app.put('/api/admin/settings', requireAuth, requireRole('admin'), (req, res) => {
  const cur = readSettings();
  const body = req.body || {};
  if (typeof body.visitorEvaluationEnabled === 'boolean') {
    cur.visitorEvaluationEnabled = body.visitorEvaluationEnabled;
  }
  writeJSON('settings.json', cur);
  console.log(`[admin] settings atualizado por ${req.user.username}: visitorEvaluationEnabled=${cur.visitorEvaluationEnabled === true}`);
  res.json({ visitorEvaluationEnabled: cur.visitorEvaluationEnabled === true });
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

// --- Provedores de IA ---
// Tudo roda na OpenAI por design:
//  - Pacientes (PATIENT_MODEL): as simulações de paciente de TODAS as abas
//    (Trilha/Treinamento/Neuro/Duelo). gpt-5.4-mini com effort 'minimal' — o
//    personagem responde direto, rápido e natural, sem raciocínio denso. O
//    prompt caching da OpenAI é automático no prefixo (system + histórico).
//  - OpenAI GPT-5.x (reasoning): avaliador (v15), avaliador de duelo e
//    entrevistador. São tarefas de raciocínio denso onde o modelo precisa
//    pensar sobre o Bloco 1/gabarito SEM vazar isso ao aluno. Num reasoning
//    model esse raciocínio fica em reasoning tokens OCULTOS (não saem no
//    content), o que mantém o Bloco 1 opaco por construção.
// CHAT_MODEL (Anthropic) ficou legado — getAnthropic não é mais chamado.
const CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-sonnet-4-6';
// Modelo dos pacientes (chat de simulação). Mini da família 5.4. O personagem
// responde direto, SEM reasoning — effort 'none' (o gpt-5.4-mini não aceita
// 'minimal'; suporta none/low/medium/high/xhigh). Nada de "pensar" antes de falar.
const PATIENT_MODEL = process.env.OPENAI_PATIENT_MODEL || 'gpt-5.4-mini-2026-03-17';
const PATIENT_EFFORT = process.env.OPENAI_PATIENT_EFFORT || 'none';
// Avaliador (v15 + duelo) roda no gpt-5.5. O entrevistador segue no full 5.4
// (HEAVY) — geração de prompt de paciente é menos sensível a custo.
const OPENAI_EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-5.5-2026-04-23';
const OPENAI_HEAVY_MODEL = process.env.OPENAI_HEAVY_MODEL || 'gpt-5.4-2026-03-05';
// reasoning_effort por caminho. Avaliador em 'medium' — o default da família
// GPT-5.x (setado explícito p/ não depender de defaults da API e manter o
// summary). O canal de raciocínio OCULTO mantém o cruzamento gabarito × log fora
// da prosa que o ALUNO lê (Echo/ChatSession); NÃO zerar o canal (ir abaixo de
// minimal), senão reabre o vazamento do Bloco 1 — causa-raiz do bug do Opus v15.
const OPENAI_EVAL_EFFORT = process.env.OPENAI_EVAL_EFFORT || 'medium';
const OPENAI_HEAVY_EFFORT = process.env.OPENAI_HEAVY_EFFORT || 'medium';
// Avaliador da Simulação Livre (freeplay em treino). Por decisão do dono é um
// modelo mais barato/antigo (5.4 default) e a avaliação é assumidamente MENOS
// precisa que a do Competitivo — que reserva o EVAL (5.5). A simulação livre é
// alto volume; o modelo bom fica pro que vale ranking. Selecionado em
// /api/evaluate quando context.mode === 'training' e type === 'freeplay'.
const OPENAI_SIM_MODEL = process.env.OPENAI_SIM_MODEL || 'gpt-5.4-2026-03-05';
const OPENAI_SIM_EFFORT = process.env.OPENAI_SIM_EFFORT || 'medium';

function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
  return new OpenAI({ apiKey });
}

// Monta o array de mensagens no formato OpenAI: a instrução de sistema vai como
// role 'developer' (papel de instruções dos reasoning models GPT-5), seguida dos
// turnos user/assistant. Sem cache_control — o prompt caching da OpenAI é
// automático no prefixo (>1024 tokens), então o system de ~32k é cacheado sozinho.
function buildOpenAIMessages(systemPrompt, messages) {
  const turns = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : String(m.content || ''),
    }))
    .filter((m) => m.content);
  return [{ role: 'developer', content: systemPrompt }, ...turns];
}

// Loga uso/custo de uma chamada OpenAI (cache hit, reasoning tokens, in/out).
function logOpenAIUsage(label, model, usage) {
  if (!usage) return;
  console.log(
    `${label} (${model}): cached=${usage.prompt_tokens_details?.cached_tokens || 0} reasoning=${usage.completion_tokens_details?.reasoning_tokens || 0} in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0}`,
  );
}

// Chamada não-streaming ao GPT-5.4 (entrevistador e avaliador de duelo).
// max_completion_tokens precisa caber reasoning + saída visível: se for curto
// demais, o modelo gasta o orçamento todo no reasoning e devolve content vazio.
// Daí a folga generosa.
async function openaiComplete({ openai, model, effort, systemPrompt, messages, maxCompletionTokens }) {
  const resp = await openai.chat.completions.create({
    model,
    reasoning_effort: effort,
    max_completion_tokens: maxCompletionTokens,
    messages: buildOpenAIMessages(systemPrompt, messages),
  });
  return { text: resp.choices?.[0]?.message?.content || '', usage: resp.usage || null };
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

  // Default 1500 pra pacientes (Trilha/Simulação/Neuro) — resposta de
  // paciente raramente passa de 3 parágrafos, e segura snappy. Entrevistador
  // sobe pra 16000 (gera prompt de paciente longo).
  const isEntrevistador = mode === 'entrevistador';
  const tokenCap = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.min(Math.floor(maxTokens), isEntrevistador ? 16000 : 4000)
    : 1500;

  // --- Entrevistador → GPT-5.4 (reasoning) ---
  // Geração de prompt de paciente: tarefa longa e nuançada, roda no OpenAI como
  // os avaliadores. Admin-only (garantido em resolveChatSystemPrompt). Resposta
  // não-streaming (JSON) — o mesmo shape que o cliente já espera de /api/chat.
  if (isEntrevistador) {
    const openai = getOpenAI();
    if (!openai) {
      return res.json({
        role: 'assistant',
        content: '[Modo demonstração — OPENAI_API_KEY não configurada] Não é possível gerar prompts sem a chave da OpenAI.',
      });
    }
    try {
      // max_completion_tokens = saída desejada + folga pro reasoning oculto.
      const { text, usage } = await openaiComplete({
        openai,
        model: OPENAI_HEAVY_MODEL,
        effort: OPENAI_HEAVY_EFFORT,
        systemPrompt: resolved.systemPrompt,
        messages,
        maxCompletionTokens: tokenCap + 16000,
      });
      logOpenAIUsage('Entrevistador', OPENAI_HEAVY_MODEL, usage);
      return res.json({ role: 'assistant', content: text });
    } catch (err) {
      console.error('OpenAI entrevistador error:', err.message);
      return res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
    }
  }

  // --- Paciente → OpenAI (gpt-5.4-mini, effort none) ---
  // O personagem responde direto, SEM reasoning. Prompt caching da OpenAI é
  // automático no prefixo (>1024 tokens), então o system + histórico (chat de
  // 50-100 turnos) é cacheado sozinho a partir do 2º turno.
  const openai = getOpenAI();
  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Olá, sou o personagem desta simulação. Como posso ajudá-lo nesta sessão?'
    });
  }

  const validTurns = (messages || []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') &&
      (typeof m.content === 'string' ? m.content : String(m.content || '')),
  );
  if (!validTurns.length) {
    return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });
  }

  try {
    // effort 'none' = sem reasoning → resposta direta e rápida.
    const { text, usage } = await openaiComplete({
      openai,
      model: PATIENT_MODEL,
      effort: PATIENT_EFFORT,
      systemPrompt: resolved.systemPrompt,
      messages,
      maxCompletionTokens: tokenCap + 2000,
    });
    logOpenAIUsage('Chat paciente', PATIENT_MODEL, usage);
    res.json({ role: 'assistant', content: text });
  } catch (err) {
    console.error('OpenAI paciente error:', err.message);
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
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-v16-2.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Avaliador comparativo (Duelo): recebe os dois logs do mesmo caso e devolve a
// análise comparativa + JSON [notas-supervisor] com A1..A6 / B1..B6.
function loadComparativoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-comparativo-v2.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador comparativo não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Avaliador de progressão: compara dois logs (Atendimento 1 e 2) do mesmo paciente.
// Atendimento 2 é o objeto da avaliação; Atendimento 1 é referência contextual.
function loadProgressaoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-progressao-v2.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador de progressão não encontrado em ${promptFile}`);
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
  const { messages, context, showReasoning } = req.body || {};
  const openai = getOpenAI();

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'systemPrompt')) {
    return res.status(400).json({
      error: 'systemPrompt não é mais aceito no body. Use context: { type, itemId } quando aplicável.',
    });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }

  // Gate de visitante: avaliação só roda pra visitante quando o admin liga o
  // toggle (eventos/palestras). Server-side por segurança — o cliente já evita
  // chamar, mas um visitante não pode forçar a avaliação batendo direto na rota.
  if (req.user.role === 'visitor' && !visitorEvaluationEnabled()) {
    return res.status(403).json({ error: 'A avaliação não está disponível para visitantes no momento.' });
  }

  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — OPENAI_API_KEY não configurada] Não é possível realizar a avaliação sem a chave da OpenAI.'
    });
  }

  const resolved = resolveEvaluatorSystemPrompt({ context });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  // Split de modelo: Treinamento simples (1º atendimento, sem sidequest) roda no
  // avaliador barato (SIM/5.4). Competitivo, Neuro, Duelo e Trilha ficam no
  // melhor (EVAL/5.5). O cliente sinaliza via context.mode; sem mode (aba Avaliar
  // Sessão) cai no EVAL.
  const isFreeSim = !!(context && context.type === 'freeplay' && context.mode === 'training');
  let systemPrompt = resolved.systemPrompt;
  let evalModel = isFreeSim ? OPENAI_SIM_MODEL : OPENAI_EVAL_MODEL;
  let evalEffort = isFreeSim ? OPENAI_SIM_EFFORT : OPENAI_EVAL_EFFORT;
  let inputTurns;
  let progressionMode = false;
  let sidequestActive = false;

  // Treinamento conectado à progressão + sidequests. Quando o aluno reatende um
  // paciente (há log anterior) OU tem uma sidequest ativa, a avaliação passa a
  // rodar no AVALIADOR DE PROGRESSÃO, com o contexto montado server-side: Bloco 1
  // + Atendimento 1 + feedback anterior + sidequest ativa, seguido do atendimento
  // que o cliente enviou (Atendimento 2). Continua sendo Treinamento, então roda
  // no SIM/5.4 (herdado de isFreeSim acima) — o 5.5 fica só pro Competitivo, Neuro,
  // Duelo e Trilha. O Competitivo (MMR) nunca entra aqui.
  if (isFreeSim && context.itemId && req.user.role !== 'visitor') {
    const prevLog = getLastLogForCharacter(req.user.id, context.itemId);
    const activeSq = getActiveSidequest(req.user.id);
    const activeDaily = getActiveDailyMission(req.user.id);
    if (prevLog || activeSq || activeDaily) {
      progressionMode = true;
      sidequestActive = !!activeSq;
      systemPrompt = loadProgressaoPrompt();

      const studentName = req.user.name || 'Aluno';
      const freeChar = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(context.itemId));
      const characterName = (prevLog && prevLog.itemTitle) || (freeChar && freeChar.name) || 'Paciente';
      const bloco1p = resolveBloco1({ context });

      // Atendimento 2 = a sessão que o cliente acabou de enviar para correção.
      const atd2Content = (messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m) => (typeof m.content === 'string' ? m.content : String(m.content || '')))
        .filter(Boolean)
        .join('\n\n');

      let content = '';
      if (bloco1p) content += `[BLOCO 1 DO CASO] (critério de correção/gabarito)\n${bloco1p}\n\n---\n\n`;
      if (prevLog) {
        const transcript1 = transcriptFromMessages(prevLog.messages, studentName, characterName);
        content += `[ATENDIMENTO 1 — ${studentName} com ${characterName}]\n${transcript1 || '(sem mensagens)'}\n\n---\n\n`;
        const { criteria: prevCriteria, pointsToReview } = getPreviousFeedback(req.user.id, context.itemId);
        if (prevCriteria) {
          const noteLines = Object.entries(prevCriteria).map(([k, v]) => `${k}: ${v}`).join(', ');
          content += `[AVALIAÇÃO DO ATENDIMENTO 1 — Notas anteriores]\nNotas por critério: ${noteLines}\n`;
          if (pointsToReview) content += `\nPontos para revisar com supervisor:\n${pointsToReview}`;
          content += `\n\n---\n\n`;
        }
      }
      if (activeSq) {
        content += `[SIDEQUEST ATIVA]\nTÍTULO: ${activeSq.title}\nDescrição: ${activeSq.description}\n\nEsta sidequest é o objetivo principal deste atendimento. Avalie primariamente se o aluno a cumpriu e emita o bloco [sidequest-resultado] conforme a especificação.\n\n---\n\n`;
      }
      if (activeDaily) {
        content += `[MISSÃO DIÁRIA]\nTÍTULO: ${activeDaily.title}\nDescrição: ${activeDaily.description}\n\nEste é o desafio do dia, um objetivo clínico ADICIONAL (independente da sidequest). Avalie se o aluno o cumpriu, com a mesma régua da sidequest, e emita o bloco [missao-diaria-resultado] conforme a especificação.\n\n---\n\n`;
      }
      content += `[ATENDIMENTO 2 — ${studentName} com ${characterName}] (objeto da avaliação)\n${atd2Content || '(sem mensagens)'}`;

      inputTurns = [{ role: 'user', content }];
    }
  }

  if (!progressionMode) {
    const bloco1 = resolveBloco1({ context });
    const finalMessages = withBloco1(messages, bloco1);
    inputTurns = (finalMessages || [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
      .filter((m) => m.content);
  }
  if (!inputTurns.length) {
    return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });
  }

  // Reasoning visível: SÓ pra supervisor/admin e SÓ quando o cliente pede (aba
  // Avaliar Sessão). O resumo do raciocínio referencia o Bloco 1 — jamais pode
  // chegar ao aluno. O gate é por ROLE no servidor: a rota /avaliacao não tem
  // guard de role no cliente (só o link some do nav), então não dá pra confiar
  // no front. Aluno nunca recebe os eventos `data:{reasoning}`.
  const canSeeReasoning = !!(req.user && (req.user.role === 'supervisor' || req.user.role === 'admin'));
  const streamReasoning = canSeeReasoning && showReasoning === true;

  try {
    // Avaliador v16-2 no GPT-5.4 (reasoning) via Responses API. O modelo cruza
    // Bloco 1 × log e pontua os 6 critérios no canal de reasoning OCULTO — não
    // sai no output_text, então o gabarito não vaza pro aluno (era o que o Opus
    // sem thinking fazia errado, externalizando a análise). Quando o pedido vem
    // da aba Avaliar Sessão (supervisor/admin), o RESUMO do raciocínio
    // (reasoning.summary) é encaminhado à parte em eventos `data:{reasoning}` —
    // a OpenAI não expõe a cadeia bruta, só o resumo. O prompt caching é
    // automático no prefixo, então o system de ~32k é cacheado sozinho.
    //
    // STREAM (SSE) por causa do timeout de 100s do Cloudflare: o proxy corta
    // (524) se ficar >100s sem byte. Gotcha do reasoning model: durante o
    // raciocínio NÃO há output_text — o heartbeat ': keepalive' segura a conexão.
    // max_output_tokens=64000 é só um TETO (reasoning + saída visível saem dele);
    // não é reserva — só paga o gerado. Folga generosa garante que a prosa nunca
    // trunque, independente do effort; se fosse curto, o modelo devolveria vazio.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // desliga buffering de proxies (nginx/railway)
    if (res.flushHeaders) res.flushHeaders();
    res.write(': ok\n\n'); // heartbeat inicial — garante TTFB baixo antes do 1º token

    // Mantém a conexão viva durante a fase de reasoning (sem output deltas).
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 15000);

    let usage = null;
    try {
      const stream = await openai.responses.create({
        model: evalModel,
        reasoning: { effort: evalEffort, summary: 'auto' },
        max_output_tokens: 64000,
        instructions: systemPrompt,
        input: inputTurns,
        stream: true,
      });
      for await (const ev of stream) {
        if (ev.type === 'response.output_text.delta') {
          if (ev.delta) res.write(`data: ${JSON.stringify({ delta: ev.delta })}\n\n`);
        } else if (streamReasoning && ev.type === 'response.reasoning_summary_text.delta') {
          if (ev.delta) res.write(`data: ${JSON.stringify({ reasoning: ev.delta })}\n\n`);
        } else if (ev.type === 'response.completed') {
          usage = ev.response?.usage || null;
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    if (usage) {
      console.log(
        `Evaluate (${evalModel}${progressionMode ? ' · progressão' + (sidequestActive ? '+sidequest' : '') : (isFreeSim ? ' · treino' : '')}): cached=${usage.input_tokens_details?.cached_tokens || 0} reasoning=${usage.output_tokens_details?.reasoning_tokens || 0} in=${usage.input_tokens || 0} out=${usage.output_tokens || 0}`,
      );
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Evaluate error:', err.message);
    if (res.headersSent) {
      // Stream já começou (status 200 enviado) — reporta o erro pelo próprio SSE.
      try { res.write(`data: ${JSON.stringify({ error: 'Erro ao comunicar com a IA: ' + err.message })}\n\n`); } catch {}
      res.end();
    } else {
      res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
    }
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
    // Conta o uso do microfone (conquista "Papagaio"). Visitante não acumula.
    if (req.user.role !== 'visitor') bumpMicUses(req.user.id);
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
    if (duel.result.mmr) out.result.mmr = duel.result.mmr;
    if (isAdmin(user)) {
      out.result.criteriaChallenger = duel.result.criteriaChallenger;
      out.result.criteriaOpponent = duel.result.criteriaOpponent;
    }
  }
  return out;
}

// Roda o avaliador comparativo nos dois logs e devolve as notas + texto limpo.
// Busca o último log (por timestamp) do usuário com um character específico.
// Retorna o log completo ou null se não encontrado.
function getLastLogForCharacter(userId, characterId) {
  const logs = readJSON('logs.json');
  const relevant = logs.filter(
    (log) => log.userId === userId && log.itemId === characterId && log.messages && log.messages.length > 0
  );
  if (relevant.length === 0) return null;
  return relevant.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
}

// Extrai as notas (criteria) e pontos-para-revisar da avaliação anterior de um paciente.
// Retorna { criteria, pointsToReview } ou { criteria: null, pointsToReview: '' } se não encontrado.
function getPreviousFeedback(userId, characterId) {
  const lastLog = getLastLogForCharacter(userId, characterId);
  if (!lastLog) return { criteria: null, pointsToReview: '' };

  const { criteria } = extractSupervisorNotes(lastLog.evaluation || '');

  // Extrai a seção "Pontos para revisar com supervisor" do texto da avaliação.
  // Padrão: procura por "Pontos para revisar com supervisor:" (case-insensitive)
  const text = lastLog.evaluation || '';
  const pointsMatch = text.match(/pontos?\s+para\s+revisar\s+com\s+supervisor[:\s]*([\s\S]*?)(?:\[notas-supervisor\]|$)/i);
  const pointsToReview = pointsMatch ? pointsMatch[1].trim() : '';

  return { criteria, pointsToReview };
}

// Executa avaliação de progressão: compara Atendimento 1 (anterior) vs Atendimento 2 (novo).
// userMessages: array de mensagens da nova sessão (Log 2).
// Retorna { evaluationClean, criteria } onde criteria tem apenas as 6 notas do Atendimento 2.
async function runProgressionEvaluation(userId, characterId, userMessages) {
  const openai = getOpenAI();

  if (!openai) {
    const criteria = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    return {
      evaluationClean: '[Modo demonstração — OPENAI_API_KEY não configurada] Avaliação de progressão indisponível.',
      criteria,
    };
  }

  // Busca Atendimento 1 (Log anterior)
  const log1 = getLastLogForCharacter(userId, characterId);
  if (!log1) {
    return {
      evaluationClean: 'Erro: Nenhum atendimento anterior encontrado para este paciente.',
      criteria: null,
    };
  }

  // Busca Bloco 1 do paciente
  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: characterId } });

  // Monta as transcrições dos dois atendimentos
  const characterName = log1.itemTitle || 'Paciente';
  const studentName = log1.userName || 'Aluno';

  const transcript1 = transcriptFromMessages(log1.messages, studentName, characterName);
  const transcript2 = transcriptFromMessages(userMessages, studentName, characterName);

  // Busca feedback anterior (notas do Atendimento 1 + pontos para revisar)
  const { criteria: previousCriteria, pointsToReview } = getPreviousFeedback(userId, characterId);

  // Monta o bloco de feedback anterior (notas + pontos para revisar)
  let previousFeedbackSection = '';
  if (previousCriteria) {
    const noteLines = Object.entries(previousCriteria)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    previousFeedbackSection = `[AVALIAÇÃO DO ATENDIMENTO 1 — Notas anteriores]\nNotas por critério: ${noteLines}\n`;
    if (pointsToReview) {
      previousFeedbackSection += `\nPontos para revisar com supervisor:\n${pointsToReview}`;
    }
  }

  // Monta conteúdo para o avaliador (4 materiais conforme avaliador-progressao-v1.md)
  const userContent =
    (bloco1 ? `[BLOCO 1 DO CASO]\n${bloco1}\n\n---\n\n` : '') +
    `[ATENDIMENTO 1 — ${studentName} com ${characterName}]\n${transcript1 || '(sem mensagens)'}\n\n---\n\n` +
    (previousFeedbackSection ? `${previousFeedbackSection}\n\n---\n\n` : '') +
    `[ATENDIMENTO 2 — ${studentName} com ${characterName}]\n${transcript2 || '(sem mensagens)'}`;

  const { text, usage } = await openaiComplete({
    openai,
    model: OPENAI_EVAL_MODEL,
    effort: OPENAI_EVAL_EFFORT,
    systemPrompt: loadProgressaoPrompt(),
    messages: [{ role: 'user', content: userContent }],
    maxCompletionTokens: 64000,
  });

  logOpenAIUsage('Progression evaluate', OPENAI_EVAL_MODEL, usage);
  const { clean, criteria } = extractSupervisorNotes(text);

  return { evaluationClean: clean, criteria };
}

async function runComparativeEvaluation(duel) {
  const openai = getOpenAI();
  const challengerName = duel.challenger.name || 'Aluno A';
  const opponentName = duel.opponent.name || 'Aluno B';
  const logA = transcriptFromMessages(duel.challenger.messages, challengerName, duel.character.name);
  const logB = transcriptFromMessages(duel.opponent.messages, opponentName, duel.character.name);

  if (!openai) {
    // Modo demonstração (sem API key): nota neutra pros dois, sem vencedor real.
    const criteria = { A1: 5, A2: 5, A3: 5, A4: 5, A5: 5, A6: 5, B1: 5, B2: 5, B3: 5, B4: 5, B5: 5, B6: 5 };
    const comp = comparativeScores(criteria);
    return {
      evaluationClean: '[Modo demonstração — OPENAI_API_KEY não configurada] Avaliação comparativa indisponível.',
      comp,
    };
  }

  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: duel.character.id } });
  const userContent =
    (bloco1 ? `[BLOCO 1 DO CASO] (referência interna do avaliador — gabarito)\n${bloco1}\n\n---\n\n` : '') +
    `[LOG DO ALUNO A — ${challengerName}]\n${logA || '(sem mensagens)'}\n\n---\n\n` +
    `[LOG DO ALUNO B — ${opponentName}]\n${logB || '(sem mensagens)'}`;

  // Avaliador comparativo no GPT-5.4 (reasoning oculto → Bloco 1 não vaza).
  const { text, usage } = await openaiComplete({
    openai,
    model: OPENAI_EVAL_MODEL,
    effort: OPENAI_EVAL_EFFORT,
    systemPrompt: loadComparativoPrompt(),
    messages: [{ role: 'user', content: userContent }],
    maxCompletionTokens: 64000,
  });
  logOpenAIUsage('Duel evaluate', OPENAI_EVAL_MODEL, usage);
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
  // Modo: 'competitive' alimenta o MMR (PvP) ao final; qualquer outro = treino.
  // O duelo só rankeia de fato se os DOIS forem usuários cadastrados, fora da
  // calibração e sem nota abaixo do mínimo (anti-smurf) — isso é verificado na
  // hora da avaliação (applyDuelMmr). Aqui só registramos a intenção. Visitante
  // nunca cria duelo (já barrado acima).
  const mode = body.mode === 'competitive' ? 'competitive' : 'training';

  const duel = {
    id: 'duel-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    token: crypto.randomBytes(12).toString('hex'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mode,
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

// Cancela (exclui) um duelo que ainda NÃO foi aceito pelo oponente. Só um
// participante (o desafiante, ou o oponente convidado por convite in-app) ou um
// admin pode cancelar, e apenas enquanto o duelo está pendente e sem aceite.
// Duelos em andamento (aceitos) ou concluídos NÃO podem ser excluídos por aqui —
// ficam disponíveis para download e somem sozinhos 30 dias após a criação.
app.delete('/api/duel/:id', requireAuth, (req, res) => {
  const duels = readDuels();
  const idx = duels.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Duelo não encontrado.' });
  const duel = duels[idx];
  if (!isDuelParticipant(duel, req.user)) return res.status(403).json({ error: 'Acesso negado.' });
  if (duel.opponent.accepted || duel.status !== 'pending') {
    return res.status(409).json({ error: 'Só é possível cancelar um duelo que ainda não foi aceito. Duelos em andamento ou concluídos não podem ser excluídos.' });
  }
  duels.splice(idx, 1);
  writeDuels(duels);
  // Remove a notificação de convite pendente do oponente (o duelo deixou de existir).
  if (duel.opponent && duel.opponent.userId) removeDuelInviteNotification(duel.opponent.userId, duel.id);
  res.json({ ok: true });
});

// Download do log de um duelo (avaliação cruzada + notas + as duas sessões),
// em texto. Só participantes (ou admin) baixam — cada um só acessa os seus
// duelos. O conteúdo é apagado automaticamente 30 dias após a criação do duelo.
app.get('/api/duel/:id/export', requireAuth, (req, res) => {
  pruneExpiredDuels();
  const duel = readDuels().find((d) => d.id === req.params.id);
  if (!duel) return res.status(404).json({ error: 'Duelo não encontrado.' });
  if (!isDuelParticipant(duel, req.user)) return res.status(403).json({ error: 'Acesso negado.' });
  const doc = buildDuelExport(duel, req.user);
  const stamp = new Date(duel.createdAt || Date.now()).toISOString().slice(0, 10);
  const slug = String(duel.character && duel.character.name || 'duelo')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'duelo';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="duelo-${slug}-${stamp}.txt"`);
  res.send(doc);
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

// Remove de vez a(s) notificação(ões) de convite de um duelo (usado no cancelamento).
function removeDuelInviteNotification(userId, duelId) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const all = readNotifications();
  const list = all[userId];
  if (!list) return;
  const next = list.filter((n) => !(n.type === 'duel_invite' && n.duelId === duelId));
  if (next.length !== list.length) { all[userId] = next; writeNotifications(all); }
}

// Monta o log de um duelo em texto (avaliação cruzada + notas + as duas sessões),
// destacando qual lado é o usuário que está baixando.
function buildDuelExport(duel, user) {
  const side = duelSideFor(duel, user);
  const fmt = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
    catch { return String(iso); }
  };
  const challengerName = duel.challenger.name || 'Desafiante';
  const opponentName = duel.opponent.name || 'Visitante';
  const youTag = (s) => (side === s ? ' (você)' : '');
  const statusLabel = duel.status === 'completed' ? 'Concluído'
    : duel.status === 'evaluating' ? 'Em avaliação'
    : duel.opponent.accepted ? 'Em andamento' : 'Aguardando aceite';
  const lines = [];
  const L = (s = '') => lines.push(s);
  const rule = (c = '=') => L(c.repeat(64));

  L('ALLOS — LOG DE DUELO (AVALIAÇÃO CRUZADA)');
  rule();
  L(`Duelo:       ${duel.id}`);
  L(`Criado em:   ${fmt(duel.createdAt)}`);
  L(`Personagem:  ${duel.character && duel.character.name || '—'}`);
  L(`Modo:        ${duel.mode === 'competitive' ? 'Competitivo (MMR)' : 'Treino'}`);
  L(`Status:      ${statusLabel}`);
  L(`Desafiante:  ${challengerName}${youTag('challenger')}`);
  L(`Oponente:    ${opponentName}${youTag('opponent')}`);
  L('');

  if (duel.result) {
    L('NOTAS');
    rule('-');
    const sc = duel.result.scoreChallenger;
    const so = duel.result.scoreOpponent;
    L(`${challengerName}: ${Number.isFinite(sc) ? sc + '/100' : '—'}`);
    L(`${opponentName}: ${Number.isFinite(so) ? so + '/100' : '—'}`);
    const w = duel.result.winner;
    const outcome = w === 'draw' ? 'Empate'
      : w === 'challenger' ? `Vitória de ${challengerName}`
      : w === 'opponent' ? `Vitória de ${opponentName}` : '—';
    L(`Resultado: ${outcome}`);
    if (duel.result.mmr && duel.result.mmr.ranked) L('Duelo valeu MMR (competitivo).');
    L('');
    L('AVALIAÇÃO CRUZADA');
    rule('-');
    L(duel.result.evaluation || '(sem texto de avaliação)');
    L('');
  } else {
    L('Este duelo ainda não foi avaliado — sem notas nem avaliação cruzada.');
    L('');
  }

  for (const [s, name] of [['challenger', challengerName], ['opponent', opponentName]]) {
    const sideObj = duel[s];
    L(`SESSÃO — ${name}${youTag(s)}`);
    rule('-');
    if (sideObj.durationSeconds) {
      const mins = Math.floor(sideObj.durationSeconds / 60);
      const secs = sideObj.durationSeconds % 60;
      L(`Duração: ${mins}min ${secs}s${sideObj.submittedAt ? ` · enviada em ${fmt(sideObj.submittedAt)}` : ''}`);
      L('');
    }
    const transcript = transcriptFromMessages(sideObj.messages, name, duel.character && duel.character.name);
    L(transcript || '(sessão não enviada)');
    L('');
  }

  rule();
  L(`Exportado em ${fmt(new Date().toISOString())}.`);
  L('Os dados deste duelo são apagados automaticamente 30 dias após a criação.');
  L('Guarde este arquivo se precisar mantê-lo.');
  return lines.join('\n');
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
      // MMR PvP (só duelo competitivo entre dois usuários cadastrados).
      applyDuelMmr(target, comp);
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

// Aplica o MMR PvP a um duelo competitivo já avaliado (muta duel.result.mmr e
// persiste mmr.json se rankeado). comp = saída de comparativeScores
// (scoreA = challenger, scoreB = opponent). Para treino, ou quando algum lado
// não é usuário cadastrado, marca não-rankeado (sem mexer no MMR).
function applyDuelMmr(duel, comp) {
  if (duel.mode !== 'competitive' || !comp) return;
  const ch = duel.challenger;
  const op = duel.opponent;
  const bothReal = ch.userId && !ch.isVisitor && op.userId && !op.isVisitor;
  if (!bothReal) {
    duel.result.mmr = { ranked: false, reason: 'visitor' };
    return;
  }
  const mmr = readMMR();
  const out = mmrEngine.processDuel(
    mmr.players[ch.userId],
    mmr.players[op.userId],
    mmr.characters[duel.character.id],
    comp.scoreA,
    comp.scoreB,
  );
  if (!out.ranked) {
    duel.result.mmr = { ranked: false, reason: out.reason };
    return;
  }
  mmr.players[ch.userId] = out.playerA;
  mmr.players[op.userId] = out.playerB;
  mmr.characters[duel.character.id] = out.character;
  writeMMR(mmr);
  const round1 = (x) => Math.round(x * 10) / 10;
  duel.result.mmr = {
    ranked: true,
    challenger: { before: Math.round(out.resultA.P_before), after: Math.round(out.playerA.P), delta: round1(out.resultA.delta), pvpDelta: round1(out.pvp.deltaA) },
    opponent: { before: Math.round(out.resultB.P_before), after: Math.round(out.playerB.P), delta: round1(out.resultB.delta), pvpDelta: round1(out.pvp.deltaB) },
    characterDifficulty: mmrEngine.characterDifficulty(out.character),
  };
}

function notifyDuelResult(duel) {
  if (!duel.result) return;
  const r = duel.result;
  const rankedMmr = r.mmr && r.mmr.ranked ? r.mmr : null;
  const sides = [
    { s: duel.challenger, key: 'challenger', score: r.scoreChallenger, theirScore: r.scoreOpponent, won: r.winner === 'challenger', theirName: duel.opponent.name },
    { s: duel.opponent, key: 'opponent', score: r.scoreOpponent, theirScore: r.scoreChallenger, won: r.winner === 'opponent', theirName: duel.challenger.name },
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
      mmrDelta: rankedMmr ? rankedMmr[side.key].delta : null,
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
      accepted: !!d.opponent.accepted,
      youAre: side,
      // Cancelável só enquanto pendente e sem aceite (duelos em andamento/concluídos não).
      canCancel: d.status === 'pending' && !d.opponent.accepted && !!side,
      // Download do log liberado quando há avaliação cruzada (duelo concluído).
      canExport: d.status === 'completed',
      outcome, yourScore, theirScore,
    });
  }
  const list = Object.values(groups)
    .map((g) => ({ ...g, duels: g.duels.sort((a, b) => new Date(b.date) - new Date(a.date)) }))
    .sort((a, b) => (b.count - a.count) || (a.opponent.name || '').localeCompare(b.opponent.name || '', 'pt-BR'));
  res.json(list);
});

// --- Avaliação de Progressão ---
// Lista pacientes (characters) com os quais o usuário já interagiu,
// permitindo seleção para avaliação de progressão.
app.get('/api/progression/available-patients', requireAuth, (req, res) => {
  const logs = readJSON('logs.json');
  const userLogs = logs.filter((log) => log.userId === req.user.id && log.itemId && log.messages && log.messages.length > 0);

  // Agrupa por character (itemId) e pega o mais recente de cada um
  const patients = {};
  for (const log of userLogs) {
    if (!patients[log.itemId] || new Date(log.timestamp) > new Date(patients[log.itemId].timestamp)) {
      patients[log.itemId] = log;
    }
  }

  const list = Object.values(patients)
    .map((log) => ({
      characterId: log.itemId,
      characterName: log.itemTitle || 'Paciente',
      lastInteraction: log.timestamp,
    }))
    .sort((a, b) => new Date(b.lastInteraction) - new Date(a.lastInteraction));

  res.json(list);
});

// Executa avaliação de progressão: compara última sessão anterior com nova sessão.
app.post('/api/progression/evaluate', requireAuth, aiLimiter, async (req, res) => {
  const { characterId, messages } = req.body || {};

  if (!characterId || typeof characterId !== 'string') {
    return res.status(400).json({ error: 'characterId obrigatório' });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser um array' });
  }

  try {
    const { evaluationClean, criteria } = await runProgressionEvaluation(req.user.id, characterId, messages);

    if (!criteria) {
      return res.status(400).json({ error: evaluationClean });
    }

    res.json({
      evaluation: evaluationClean,
      criteria,
    });
  } catch (err) {
    console.error('Erro em /api/progression/evaluate:', err);
    res.status(500).json({ error: 'Erro ao executar avaliação de progressão' });
  }
});

// --- Sidequests (missões clínicas do Treinamento) ---
// Banco de definições reutilizáveis + atribuição ativa por aluno (máx. 1) +
// histórico de concluídas com o título de recompensa. Funções declaradas aqui
// são hoisted, então publicUser/ranking/gamification (acima) já as enxergam.
function readSidequests() {
  const data = readJSON('sidequests.json', { bank: [], active: {}, completed: {} });
  if (!Array.isArray(data.bank)) data.bank = [];
  if (!data.active || typeof data.active !== 'object') data.active = {};
  if (!data.completed || typeof data.completed !== 'object') data.completed = {};
  return data;
}
function writeSidequests(data) { writeJSON('sidequests.json', data); }

function getActiveSidequest(userId) {
  return readSidequests().active[userId] || null;
}

// Resolve um título de recompensa (qt-*) para { label, tier } a partir das
// sidequests concluídas pelo usuário. Null se o usuário não o desbloqueou.
function resolveQuestTitle(userId, titleId) {
  if (!titleId || !String(titleId).startsWith('qt-')) return null;
  const list = readSidequests().completed[userId] || [];
  const found = list.find((c) => c.rewardTitleId === titleId);
  return found ? { label: found.rewardTitleLabel, tier: found.rewardTitleTier || 'quest' } : null;
}

// Snapshot público de uma sidequest atribuída (sem campos internos sensíveis).
function publicSidequest(sq) {
  if (!sq) return null;
  return {
    sidequestId: sq.sidequestId,
    title: sq.title,
    description: sq.description,
    rewardTitleId: sq.rewardTitleId,
    rewardTitleLabel: sq.rewardTitleLabel,
    assignedAt: sq.assignedAt || null,
  };
}

// Marca a sidequest ativa de um aluno como concluída: move pra completed,
// concede o título de recompensa e limpa a ativa. Idempotente (no-op sem ativa).
// Retorna o registro de conclusão ou null.
function completeSidequest(userId, justification, ctx = {}) {
  const data = readSidequests();
  const active = data.active[userId];
  if (!active) return null;
  const record = {
    sidequestId: active.sidequestId,
    title: active.title,
    description: active.description,
    rewardTitleId: active.rewardTitleId,
    rewardTitleLabel: active.rewardTitleLabel,
    rewardTitleTier: active.rewardTitleTier || 'quest',
    justification: clampStr(justification, 1000),
    completedAt: new Date().toISOString(),
    characterId: ctx.characterId || null,
    characterName: ctx.characterName || null,
  };
  if (!Array.isArray(data.completed[userId])) data.completed[userId] = [];
  data.completed[userId].push(record);
  delete data.active[userId];
  writeSidequests(data);
  return record;
}

// --- Missão diária: rotação GLOBAL e determinística do banco de sidequests ---
// Toda meia-noite UTC entra outra missão (bank[diasDesdeEpoca % tamanho]); é a
// MESMA para todos. Avaliada e recompensada como uma sidequest (concede o
// título de recompensa daquela entrada do banco). Coexiste com a sidequest
// atribuída — uma não anula a outra.
function dailyMissionIndex() {
  // Dia de calendário no fuso de São Paulo (UTC−3): a missão diária vira à
  // meia-noite LOCAL (0h), não à meia-noite UTC. Determinístico e global.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return Math.floor(Date.parse(ymd + 'T00:00:00Z') / 86400000);
}
function getDailyMission() {
  const bank = readSidequests().bank;
  if (!bank.length) return null;
  return bank[dailyMissionIndex() % bank.length];
}
// O usuário já ganhou a recompensa desta missão (em qualquer ocasião)?
function hasCompletedReward(userId, rewardTitleId) {
  const list = readSidequests().completed[userId] || [];
  return list.some((c) => c.rewardTitleId === rewardTitleId);
}
// Missão diária ATIVA para o usuário: a do dia, se ele ainda não a concluiu.
function getActiveDailyMission(userId) {
  const dm = getDailyMission();
  if (!dm) return null;
  if (hasCompletedReward(userId, dm.rewardTitleId)) return null;
  return dm;
}
// Conclui a missão diária do dia: grava na lista de concluídas (concede o título
// de recompensa, igual à sidequest) — dedup por recompensa (não dá pra farmar).
function completeDailyMission(userId, justification, ctx = {}) {
  const data = readSidequests();
  if (!data.bank.length) return null;
  const dm = data.bank[dailyMissionIndex() % data.bank.length];
  if (!Array.isArray(data.completed[userId])) data.completed[userId] = [];
  if (data.completed[userId].some((c) => c.rewardTitleId === dm.rewardTitleId)) return null;
  const record = {
    sidequestId: dm.id,
    title: dm.title,
    description: dm.description,
    rewardTitleId: dm.rewardTitleId,
    rewardTitleLabel: dm.rewardTitleLabel,
    rewardTitleTier: dm.rewardTitleTier || 'quest',
    justification: clampStr(justification, 1000),
    completedAt: new Date().toISOString(),
    characterId: ctx.characterId || null,
    characterName: ctx.characterName || null,
    daily: true,
  };
  data.completed[userId].push(record);
  writeSidequests(data);
  return record;
}
function publicDailyMission(dm) {
  if (!dm) return null;
  return { sidequestId: dm.id, title: dm.title, description: dm.description, rewardTitleLabel: dm.rewardTitleLabel };
}

const SQ_MAX_TITLE = 120;
const SQ_MAX_DESC = 2000;

function canManageSidequests(user) {
  return !!(user && (user.role === 'supervisor' || user.role === 'admin'));
}

// Banco de sidequests reutilizáveis (supervisor/admin).
app.get('/api/sidequests/bank', requireAuth, (req, res) => {
  if (!canManageSidequests(req.user)) return res.status(403).json({ error: 'Acesso negado' });
  res.json(readSidequests().bank);
});

app.post('/api/sidequests/bank', requireAuth, (req, res) => {
  if (!canManageSidequests(req.user)) return res.status(403).json({ error: 'Acesso negado' });
  const title = clampStr(req.body && req.body.title, SQ_MAX_TITLE).trim();
  const description = clampStr(req.body && req.body.description, SQ_MAX_DESC).trim();
  const rewardTitle = clampStr(req.body && req.body.rewardTitle, SQ_MAX_TITLE).trim();
  if (!title || !description) {
    return res.status(400).json({ error: 'Título e descrição são obrigatórios.' });
  }
  if (!rewardTitle) {
    return res.status(400).json({ error: 'Título de recompensa é obrigatório.' });
  }
  const data = readSidequests();
  const id = 'sq-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const entry = {
    id,
    title,
    description,
    rewardTitleId: 'qt-' + id,
    rewardTitleLabel: rewardTitle,
    rewardTitleTier: 'quest',
    createdBy: req.user.id,
    createdByName: req.user.name || req.user.username,
    createdAt: new Date().toISOString(),
  };
  data.bank.push(entry);
  writeSidequests(data);
  res.json(entry);
});

app.delete('/api/sidequests/bank/:id', requireAuth, (req, res) => {
  if (!canManageSidequests(req.user)) return res.status(403).json({ error: 'Acesso negado' });
  const data = readSidequests();
  const before = data.bank.length;
  data.bank = data.bank.filter((s) => s.id !== req.params.id);
  if (data.bank.length === before) return res.status(404).json({ error: 'Sidequest não encontrada.' });
  writeSidequests(data);
  res.json({ ok: true });
});

// Sidequests de um aluno (ativa + concluídas). Supervisor (só seus alunos),
// admin (todos) ou o próprio aluno.
app.get('/api/sidequests/student/:userId', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const data = readSidequests();
  res.json({
    active: publicSidequest(data.active[req.params.userId] || null),
    completed: data.completed[req.params.userId] || [],
  });
});

// Atribui (ou substitui) a sidequest ativa de um aluno. Máx. 1 por aluno.
app.post('/api/sidequests/assign', requireAuth, (req, res) => {
  if (!canManageSidequests(req.user)) return res.status(403).json({ error: 'Acesso negado' });
  const { userId, sidequestId } = req.body || {};
  if (!userId || !sidequestId) {
    return res.status(400).json({ error: 'userId e sidequestId são obrigatórios.' });
  }
  if (!canAccessUserResource(req.user, userId)) {
    return res.status(403).json({ error: 'Você não supervisiona este aluno.' });
  }
  const users = readJSON('users.json');
  const target = users.find((u) => u.id === userId);
  if (!target || target.role !== 'therapist') {
    return res.status(400).json({ error: 'Sidequests só podem ser atribuídas a terapeutas.' });
  }
  const data = readSidequests();
  const def = data.bank.find((s) => s.id === sidequestId);
  if (!def) return res.status(404).json({ error: 'Sidequest não encontrada no banco.' });
  data.active[userId] = {
    sidequestId: def.id,
    title: def.title,
    description: def.description,
    rewardTitleId: def.rewardTitleId,
    rewardTitleLabel: def.rewardTitleLabel,
    rewardTitleTier: def.rewardTitleTier || 'quest',
    assignedBy: req.user.id,
    assignedByName: req.user.name || req.user.username,
    assignedAt: new Date().toISOString(),
  };
  writeSidequests(data);
  res.json({ active: publicSidequest(data.active[userId]) });
});

// Remove a sidequest ativa de um aluno (sem concluí-la).
app.post('/api/sidequests/unassign', requireAuth, (req, res) => {
  if (!canManageSidequests(req.user)) return res.status(403).json({ error: 'Acesso negado' });
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId é obrigatório.' });
  if (!canAccessUserResource(req.user, userId)) {
    return res.status(403).json({ error: 'Você não supervisiona este aluno.' });
  }
  const data = readSidequests();
  if (data.active[userId]) { delete data.active[userId]; writeSidequests(data); }
  res.json({ ok: true });
});

// Sidequest do próprio usuário (Treinamento mostra a ativa; perfil mostra as
// concluídas). Visitante nunca tem sidequest.
app.get('/api/me/sidequest', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json({ active: null, completed: [] });
  const data = readSidequests();
  res.json({
    active: publicSidequest(data.active[req.user.id] || null),
    completed: data.completed[req.user.id] || [],
  });
});

// Missão diária do usuário (Treinamento). Mostra a do dia + se ele já concluiu.
app.get('/api/me/daily-mission', requireAuth, (req, res) => {
  const dm = getDailyMission();
  if (!dm) return res.json({ mission: null, completed: false });
  const completed = req.user.role !== 'visitor' && hasCompletedReward(req.user.id, dm.rewardTitleId);
  res.json({ mission: publicDailyMission(dm), completed });
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

// ============================================================================
// MODO DESAFIO (titular-desafiante) — aba paralela dentro do Treinamento
// ============================================================================
// Sistema isolado: NÃO toca em logs.json, progressão, sidequests nem MMR.
// Cada paciente tem no máximo um Titular por vez; quem clica no rosto do
// Titular atual entra como Desafiante (avaliador titular-desafiante decide se
// assume); quando ninguém é Titular, clicar no 👑 reivindica a posição (vira
// Titular ao final, independente da nota). Visitantes podem ser Titular mas
// não persistimos identidade — aparecem como "Um visitante" (incentivo pra
// usuários reais substituírem).

const DESAFIO_MAX_MESSAGES = 500;
const DESAFIO_MAX_MESSAGE_LEN = 20000;

function readDesafio() {
  const data = readJSON('desafio.json', { titulares: {} });
  if (!data.titulares || typeof data.titulares !== 'object') data.titulares = {};
  return data;
}
function writeDesafio(data) { writeJSON('desafio.json', data); }

// Snapshot público de um Titular pra cards do FreePlay. Não inclui o log do
// titular (esse fica server-side, só vai pro avaliador). Visitante vira
// "Um visitante" — não há nome próprio nem foto.
function publicTitular(t) {
  if (!t) return null;
  if (t.isVisitor) {
    return {
      isVisitor: true,
      name: 'Um visitante',
      profilePhoto: '',
      claimedAt: t.claimedAt || null,
      lastDefendedAt: t.lastDefendedAt || null,
    };
  }
  return {
    isVisitor: false,
    userId: t.userId || null,
    name: t.userName || 'Terapeuta',
    profilePhoto: t.userPhoto || '',
    claimedAt: t.claimedAt || null,
    lastDefendedAt: t.lastDefendedAt || null,
  };
}

// Lista de coroas (títulos temporários "👑 <personagem>") de um usuário real.
// Atravessa todos os titulares e devolve os personagens onde o userId é
// Titular. Visitante nunca tem coroa persistente (id efêmero).
function getUserCrowns(userId) {
  if (!userId || String(userId).startsWith('visitor-')) return [];
  const { titulares } = readDesafio();
  const out = [];
  for (const [characterId, t] of Object.entries(titulares)) {
    if (!t || t.isVisitor) continue;
    if (t.userId === userId) {
      out.push({
        characterId,
        characterName: t.characterName || 'Paciente',
        label: `👑 ${t.characterName || 'Paciente'}`,
      });
    }
  }
  return out;
}

// Sanitiza mensagens enviadas pelo cliente ao concluir um desafio.
function cleanDesafioMessages(rawMessages) {
  const arr = Array.isArray(rawMessages) ? rawMessages.slice(0, DESAFIO_MAX_MESSAGES) : [];
  return arr
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && !m.isSystem)
    .map((m) => ({
      role: m.role,
      content: clampStr(m.content, DESAFIO_MAX_MESSAGE_LEN),
      highlighted: !!m.highlighted,
      comment: clampStr(m.comment, 2000),
    }));
}

// Avaliador titular-desafiante: mesma família dos demais avaliadores em
// avaliacao/. Comparativo, mas com resultado binário (Titular permanece ou
// Desafiante assume). Output NÃO carrega notas numéricas — só o bloco
// [titular-desafiante-resultado] com {"desafiante_assume": bool, "justification": "..."}.
function loadTitularDesafiantePrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-titular-desafiante-v2.md');
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador titular-desafiante não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Extrai o bloco [titular-desafiante-resultado] do output do avaliador.
// Mesma forma do [sidequest-resultado] — JSON cru após marcador. Retorna
// { clean, result } onde result = { desafianteAssume, justification } ou null.
function extractTitularDesafianteResult(evaluation) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  const markerMatch = text.match(/\[titular-desafiante-resultado\]/i);
  if (!markerMatch) return { clean: text, result: null };
  const markerIdx = markerMatch.index;
  const after = text.slice(markerIdx);
  const jsonMatch = after.match(/\{[\s\S]*?\}/);
  let result = null;
  let blockEnd = markerIdx + (after.match(/\[titular-desafiante-resultado\][^\n]*/i)[0].length);
  if (jsonMatch) {
    blockEnd = markerIdx + jsonMatch.index + jsonMatch[0].length;
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const v = obj.desafiante_assume;
        result = {
          desafianteAssume: v === true || String(v).toLowerCase() === 'true',
          justification: typeof obj.justification === 'string' ? obj.justification : '',
        };
      }
    } catch {}
  }
  // Remove também um separador "---" imediatamente antes do marcador.
  const before = text.slice(0, markerIdx);
  const sep = before.match(/\n*-{3,}[^\S\n]*\n*$/);
  const start = sep ? before.length - sep[0].length : markerIdx;
  const clean = (text.slice(0, start) + text.slice(blockEnd)).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, result };
}

// Resolve o "lado" titular pro card (usado tanto na lista pública quanto no
// estado de início de uma sessão de desafio).
app.get('/api/desafio/titulares', requireAuth, (req, res) => {
  const { titulares } = readDesafio();
  const out = {};
  for (const [characterId, t] of Object.entries(titulares)) {
    out[characterId] = publicTitular(t);
  }
  res.json(out);
});

// Coroas do usuário logado (lista de personagens onde ele é Titular).
// Visitante recebe [] — não tem coroa persistente.
app.get('/api/me/crowns', requireAuth, (req, res) => {
  if (req.user.role === 'visitor') return res.json([]);
  res.json(getUserCrowns(req.user.id));
});

// Estado inicial pra uma sessão de Desafio. Antes de começar o atendimento, o
// cliente bate aqui pra saber se vai entrar como Reivindicante (sem Titular
// atual) ou Desafiante (há Titular). Validamos que o personagem existe.
app.get('/api/desafio/state/:characterId', requireAuth, (req, res) => {
  const characters = readJSON('freeplay-characters.json');
  const char = characters.find((c) => String(c.id) === String(req.params.characterId));
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado.' });
  const { titulares } = readDesafio();
  const t = titulares[char.id];
  if (!t) {
    return res.json({
      mode: 'reivindicar',
      character: { id: char.id, name: char.name },
      titular: null,
    });
  }
  // Bloqueio: usuário não pode "desafiar a si mesmo" — já é Titular.
  if (!t.isVisitor && req.user.role !== 'visitor' && t.userId === req.user.id) {
    return res.json({
      mode: 'auto-titular',
      character: { id: char.id, name: char.name },
      titular: publicTitular(t),
    });
  }
  return res.json({
    mode: 'desafiar',
    character: { id: char.id, name: char.name },
    titular: publicTitular(t),
  });
});

// Reivindica um Titular (não há Titular atual). O aluno vira Titular ao final,
// SEMPRE — independente da nota; reivindicar nunca "falha". Mas, como todo
// atendimento do Treinamento, agora recebe avaliação clínica: rodamos o
// avaliador individual (v15) sobre o log do reivindicante e devolvemos a prosa
// de feedback. Por viver no Modo Desafio, a avaliação é OPACA — o bloco oculto
// [notas-supervisor] é stripado server-side ANTES de qualquer byte chegar ao
// cliente (a nota nunca aparece, nem ao aluno nem ao supervisor; ver opacidade
// do titular-desafiante). Reivindicamos PRIMEIRO (write atômico instantâneo) e
// só então rodamos a avaliação — assim a avaliação demorada não abre janela de
// race com outro reivindicante. Responde em SSE (mesmo padrão de /api/evaluate
// e /desafio/desafiar) por causa do timeout de 100s do Cloudflare; cai pra JSON
// quando não há avaliador (visitante sem toggle, ou OPENAI_API_KEY ausente).
app.post('/api/desafio/reivindicar', requireAuth, aiLimiter, async (req, res) => {
  const body = req.body || {};
  const openai = getOpenAI();
  const characters = readJSON('freeplay-characters.json');
  const char = characters.find((c) => String(c.id) === String(body.characterId));
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado.' });

  const data = readDesafio();
  if (data.titulares[char.id]) {
    return res.status(409).json({
      error: 'Alguém já reivindicou este Titular enquanto você atendia. Vá pra desafiar.',
      titular: publicTitular(data.titulares[char.id]),
    });
  }

  const messages = cleanDesafioMessages(body.messages);
  if (!messages.length) {
    return res.status(400).json({ error: 'A sessão precisa ter ao menos uma mensagem.' });
  }

  const isVisitor = req.user.role === 'visitor';

  // Reivindica imediatamente (vira Titular independente da avaliação).
  const now = new Date().toISOString();
  data.titulares[char.id] = {
    characterName: char.name,
    isVisitor,
    userId: isVisitor ? null : req.user.id,
    userName: isVisitor ? null : (req.user.name || req.user.username || 'Terapeuta'),
    userPhoto: isVisitor ? '' : (req.user.profilePhoto || ''),
    logMessages: messages,
    durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
    claimedAt: now,
    lastDefendedAt: now,
  };
  writeDesafio(data);

  // Histórico de titularidade (conquistas Vingança/Destronador). Reivindicação =
  // posição estava vaga → fromUserId null. Visitante não entra no histórico.
  if (!isVisitor) {
    appendDesafioHistory({ characterId: char.id, characterName: char.name, fromUserId: null, toUserId: req.user.id, reason: 'reivindicar' });
  }

  const titularPublic = publicTitular(data.titulares[char.id]);

  // Sem avaliador disponível (visitante com toggle off, ou sem chave OpenAI):
  // reivindica sem avaliação e devolve JSON (o cliente trata os dois formatos).
  const skipEval = (isVisitor && !visitorEvaluationEnabled()) || !openai;
  if (skipEval) {
    return res.json({
      ok: true,
      kind: 'claimed',
      character: { id: char.id, name: char.name },
      titular: titularPublic,
      isVisitor,
      evaluation: '',
    });
  }

  // Avaliação individual (v15) do log do reivindicante, em stream. Opaca: o
  // bloco [notas-supervisor] é cortado durante o stream (não enviamos os deltas
  // a partir do marcador) e o `clean` final passa por extractSupervisorNotes.
  const context = { type: 'freeplay', itemId: char.id };
  const systemPrompt = loadAvaliacaoPrompt();
  const bloco1 = resolveBloco1({ context });
  const evalMessages = messages.map((m) => ({ role: m.role, content: m.content }));
  const inputTurns = withBloco1(evalMessages, bloco1)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
    .filter((m) => m.content);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  res.write(': ok\n\n');
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  // Marcador do bloco oculto de notas (mesmo regex do extractSupervisorNotes).
  const NOTES_RE = /\n*(?:-{3,}[^\S\n]*\r?\n+)?\[notas-supervisor\]/i;
  let fullText = '';
  let forwarding = true; // vira false ao detectar o início do bloco de notas
  let usage = null;
  try {
    const stream = await openai.responses.create({
      model: OPENAI_SIM_MODEL,
      reasoning: { effort: OPENAI_SIM_EFFORT, summary: 'auto' },
      max_output_tokens: 64000,
      instructions: systemPrompt,
      input: inputTurns,
      stream: true,
    });
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') {
        if (!ev.delta) continue;
        const prevLen = fullText.length;
        fullText += ev.delta;
        if (!forwarding) continue;
        const m = fullText.match(NOTES_RE);
        if (!m) {
          res.write(`data: ${JSON.stringify({ delta: ev.delta })}\n\n`);
        } else {
          // Emite só o trecho deste delta que vem ANTES do marcador, depois
          // para de encaminhar (as notas nunca chegam ao cliente).
          forwarding = false;
          const cut = m.index;
          if (cut > prevLen) {
            res.write(`data: ${JSON.stringify({ delta: fullText.slice(prevLen, cut) })}\n\n`);
          }
        }
      } else if (ev.type === 'response.completed') {
        usage = ev.response?.usage || null;
      }
    }
    if (usage) logOpenAIUsage('Reivindicar (v15 opaco)', OPENAI_SIM_MODEL, usage);
  } catch (err) {
    clearInterval(heartbeat);
    console.error('Reivindicar evaluate error:', err.message);
    // A reivindicação já foi gravada; só sinaliza que a avaliação falhou.
    try {
      res.write(`data: ${JSON.stringify({
        done: true,
        kind: 'claimed',
        evaluation: '',
        error: 'A reivindicação foi registrada, mas a avaliação falhou: ' + err.message,
        titular: titularPublic,
        character: { id: char.id, name: char.name },
      })}\n\n`);
    } catch {}
    res.end();
    return;
  }
  clearInterval(heartbeat);

  const { clean } = extractSupervisorNotes(fullText);
  res.write(`data: ${JSON.stringify({
    done: true,
    kind: 'claimed',
    evaluation: clean,
    titular: titularPublic,
    character: { id: char.id, name: char.name },
  })}\n\n`);
  res.end();
});

// Desafia o Titular atual: o cliente envia seu log; o servidor carrega o log
// do Titular, monta o contexto pro avaliador titular-desafiante, roda o modelo
// em stream (mesmo padrão SSE de /api/evaluate por causa do timeout do
// Cloudflare), parseia o bloco [titular-desafiante-resultado] no final, e
// atualiza o Titular se o Desafiante assumiu. O cliente recebe a prosa
// chegando em deltas + um evento final `data:{done, outcome}` com o resultado.
app.post('/api/desafio/desafiar', requireAuth, aiLimiter, async (req, res) => {
  const body = req.body || {};
  const openai = getOpenAI();

  const characters = readJSON('freeplay-characters.json');
  const char = characters.find((c) => String(c.id) === String(body.characterId));
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado.' });

  const data = readDesafio();
  const titular = data.titulares[char.id];
  if (!titular) {
    return res.status(409).json({
      error: 'Não há Titular para este caso. Reivindique a posição em vez de desafiar.',
    });
  }
  // Bloqueio: não pode desafiar a si mesmo.
  if (!titular.isVisitor && req.user.role !== 'visitor' && titular.userId === req.user.id) {
    return res.status(409).json({ error: 'Você já é o Titular deste caso — não pode se desafiar.' });
  }

  if (req.user.role === 'visitor' && !visitorEvaluationEnabled()) {
    return res.status(403).json({ error: 'A avaliação não está disponível para visitantes no momento.' });
  }

  const desafianteMessages = cleanDesafioMessages(body.messages);
  if (!desafianteMessages.length) {
    return res.status(400).json({ error: 'A sessão do Desafiante precisa ter ao menos uma mensagem.' });
  }

  if (!openai) {
    // Sem chave OpenAI: não dá pra rodar avaliador comparativo. Mantém o
    // Titular atual e devolve mensagem de erro pro cliente (sem trocar nada).
    return res.json({
      ok: true,
      kind: 'challenge',
      outcome: 'titular-permanece',
      evaluation: '[Modo demonstração — OPENAI_API_KEY não configurada] O avaliador titular-desafiante não pôde rodar; o Titular permanece.',
      titular: publicTitular(titular),
    });
  }

  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: char.id } });
  const titularName = titular.isVisitor ? 'Titular (visitante)' : (titular.userName || 'Titular');
  const desafianteName = req.user.role === 'visitor' ? 'Desafiante (visitante)' : (req.user.name || req.user.username || 'Desafiante');
  const logTitular = transcriptFromMessages(titular.logMessages || [], titularName, char.name);
  const logDesafiante = transcriptFromMessages(desafianteMessages, desafianteName, char.name);

  const userContent =
    (bloco1 ? `[BLOCO 1 DO CASO] (referência interna do avaliador — gabarito)\n${bloco1}\n\n---\n\n` : '') +
    `[LOG DO TITULAR — ${titularName} com ${char.name}]\n${logTitular || '(sem mensagens)'}\n\n---\n\n` +
    `[LOG DO DESAFIANTE — ${desafianteName} com ${char.name}]\n${logDesafiante || '(sem mensagens)'}`;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  res.write(': ok\n\n');
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  let fullText = '';
  let usage = null;
  try {
    const stream = await openai.responses.create({
      model: OPENAI_SIM_MODEL,
      reasoning: { effort: OPENAI_SIM_EFFORT, summary: 'auto' },
      max_output_tokens: 64000,
      instructions: loadTitularDesafiantePrompt(),
      input: [{ role: 'user', content: userContent }],
      stream: true,
    });
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') {
        if (ev.delta) {
          fullText += ev.delta;
          res.write(`data: ${JSON.stringify({ delta: ev.delta })}\n\n`);
        }
      } else if (ev.type === 'response.completed') {
        usage = ev.response?.usage || null;
      }
    }
    if (usage) logOpenAIUsage('Desafio (titular-desafiante)', OPENAI_SIM_MODEL, usage);
  } catch (err) {
    clearInterval(heartbeat);
    console.error('Desafio evaluate error:', err.message);
    try { res.write(`data: ${JSON.stringify({ error: 'Erro ao comunicar com a IA: ' + err.message })}\n\n`); } catch {}
    res.end();
    return;
  }
  clearInterval(heartbeat);

  // Parse do bloco [titular-desafiante-resultado] + atualização de estado.
  // Se o desafiante assume, troca o Titular. Read-modify-write atômico no
  // mesmo request — improvável ter race aqui (avaliação demora minutos).
  const { clean, result } = extractTitularDesafianteResult(fullText);
  let outcome = 'titular-permanece';
  let newTitular = titular;
  if (result && result.desafianteAssume) {
    outcome = 'desafiante-assume';
    const fresh = readDesafio();
    const isVisitor = req.user.role === 'visitor';
    const now = new Date().toISOString();
    fresh.titulares[char.id] = {
      characterName: char.name,
      isVisitor,
      userId: isVisitor ? null : req.user.id,
      userName: isVisitor ? null : (req.user.name || req.user.username || 'Terapeuta'),
      userPhoto: isVisitor ? '' : (req.user.profilePhoto || ''),
      logMessages: desafianteMessages,
      durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
      claimedAt: now,
      lastDefendedAt: now,
    };
    writeDesafio(fresh);
    newTitular = fresh.titulares[char.id];
    // Histórico de titularidade (Vingança/Destronador): desafiante tomou a
    // posição do titular anterior. Visitante não entra no histórico.
    if (!isVisitor) {
      appendDesafioHistory({ characterId: char.id, characterName: char.name, fromUserId: titular.userId || null, toUserId: req.user.id, reason: 'desafio' });
    }
  } else {
    // Titular permaneceu: só atualiza lastDefendedAt.
    const fresh = readDesafio();
    if (fresh.titulares[char.id]) {
      fresh.titulares[char.id].lastDefendedAt = new Date().toISOString();
      writeDesafio(fresh);
      newTitular = fresh.titulares[char.id];
    }
  }

  // Sinaliza fim com payload final (cliente já remontou a prosa via deltas).
  // Mandamos `clean` também porque o cliente exibe o texto sem o bloco JSON.
  res.write(`data: ${JSON.stringify({
    done: true,
    outcome,
    evaluation: clean,
    justification: result ? result.justification : '',
    titular: publicTitular(newTitular),
    character: { id: char.id, name: char.name },
  })}\n\n`);
  res.end();
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
