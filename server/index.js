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

const app = express();

// CORS allowlist. Em produção o front é servido pelo mesmo origin (o Express
// serve o build do React), então só precisa abrir pra dev local.
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Same-origin (sem header Origin) sempre passa.
    if (!origin) return cb(null, true);
    if (CORS_ALLOWLIST.includes(origin)) return cb(null, true);
    return cb(new Error('Origin não permitida pelo CORS'));
  },
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
// Pre-auth (chave por IP): protege contra brute-force de credenciais e flood
// de geração de tokens.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
const visitorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
// Post-auth (chave por user.id, fallback IP): protege a chave OpenAI de abuse
// e segura escrita massiva em logs.
function userKey(req) {
  return (req.user && req.user.id) ? `u:${req.user.id}` : `ip:${req.ip}`;
}
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Limite de uso da IA atingido. Tente novamente em uma hora.' },
});
const writeLimiter = rateLimit({
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
console.log('[startup] JWT_SECRET    =', envDiag('JWT_SECRET'));
console.log('[startup] OPENAI_API_KEY =', envDiag('OPENAI_API_KEY'));
console.log('[startup] DATA_DIR       =', envDiag('DATA_DIR'), '→ resolved:', DATA_DIR);
console.log('[startup] PORT           =', envDiag('PORT'));
console.log('[startup] env keys count =', Object.keys(process.env).length);
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
  profilePhoto: '',
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

// --- Auth helpers ---
function publicUser(u) {
  if (!u) return null;
  const { password, passwordHash, ...safe } = u;
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
  const maxNumeric = users.reduce((max, u) => {
    const n = Number(u.id);
    return Number.isFinite(n) && n > max ? n : max;
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
    profilePhoto: req.body.profilePhoto || '',
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
    { id: 'daily_efficiency',icon: '↗', title: 'Eficiência clínica',description: 'Conclua uma Simulação em até 10 min com pontuação ≥ 8',         target: 1, progress: fastGood ? 1 : 0, completed: fastGood },
    { id: 'daily_neuro',     icon: '◈', title: 'Discernimento',     description: 'Conclua uma Neuroavaliação hoje',                                target: 1, progress: neuroDone ? 1 : 0, completed: neuroDone },
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
  const { specificInstruction, ...safe } = c;
  return safe;
}
function publicNeuroChar(c) {
  // diagnosis é o gabarito do Sistema 3 — NUNCA vai pra cliente não-admin
  const { specificInstruction, diagnosis, ...safe } = c;
  return safe;
}

// --- Exercises (System 1) ---
app.get('/api/exercises', requireAuth, (req, res) => {
  const list = readJSON('exercises.json');
  res.json(isAdmin(req.user) ? list : list.map(publicExercise));
});

app.post('/api/exercises', requireAuth, requireRole('admin'), (req, res) => {
  const exercises = readJSON('exercises.json');
  const ex = { id: 'ex' + Date.now(), ...req.body };
  exercises.push(ex);
  writeJSON('exercises.json', exercises);
  res.json(ex);
});

app.put('/api/exercises/:id', requireAuth, requireRole('admin'), (req, res) => {
  const exercises = readJSON('exercises.json');
  const idx = exercises.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  exercises[idx] = { ...exercises[idx], ...req.body };
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
  res.json(isAdmin(req.user) ? list : list.map(publicFreeplayChar));
});

app.post('/api/freeplay', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const c = { id: 'fp' + Date.now(), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('freeplay-characters.json', chars);
  res.json(c);
});

app.put('/api/freeplay/:id', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(req.body) };
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
  const c = { id: 'nr' + Date.now(), ...sanitizeCharacterPayload(req.body) };
  chars.push(c);
  writeJSON('neuro-characters.json', chars);
  res.json(c);
});

app.put('/api/neuro/:id', requireAuth, requireRole('admin'), (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = { ...chars[idx], ...sanitizeCharacterPayload(req.body) };
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
app.get('/api/logs', requireAuth, (req, res) => {
  const logs = readJSON('logs.json');
  const users = readJSON('users.json');

  // Aluno e visitante: só os próprios.
  if (req.user.role === 'therapist' || req.user.role === 'visitor') {
    return res.json(logs.filter(l => l.userId === req.user.id));
  }

  // Filtro por userId específico
  if (req.query.userId) {
    if (!canAccessUserResource(req.user, req.query.userId)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    return res.json(logs.filter(l => l.userId === req.query.userId));
  }

  // Professor: apenas logs de seus alunos
  if (req.user.role === 'supervisor') {
    const myStudents = new Set(
      users.filter(u => u.role === 'therapist' && u.teacherId === req.user.id).map(u => u.id)
    );
    return res.json(logs.filter(l => myStudents.has(l.userId)));
  }

  // Admin: tudo
  res.json(logs);
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

  const log = {
    id: 'log' + Date.now(),
    timestamp: new Date().toISOString(),
    type: body.type,
    itemId: clampStr(body.itemId, 200),
    itemTitle: clampStr(body.itemTitle, LOG_MAX_TITLE),
    skillId: Number.isFinite(body.skillId) ? Number(body.skillId) : null,
    difficulty: typeof body.difficulty === 'string' ? body.difficulty.slice(0, 32) : null,
    durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.floor(body.durationSeconds)) : 0,
    score: Number.isFinite(body.score) ? Number(body.score) : null,
    criteriaScores: body.criteriaScores && typeof body.criteriaScores === 'object' ? body.criteriaScores : null,
    evaluation: clampStr(body.evaluation, LOG_MAX_EVAL_LEN),
    messages: cleanMessages,
    userId: req.user.id,
    userName: req.user.name,
  };

  const logs = readJSON('logs.json');
  logs.push(log);
  writeJSON('logs.json', logs);
  res.json(log);
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

// --- OpenAI Chat Proxy (modelo padrão do projeto) ---
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5.4-mini';

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const { default: OpenAI } = require('openai');
  return new OpenAI({ apiKey });
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
  const openai = getOpenAI();

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

  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Olá, sou o personagem desta simulação. Como posso ajudá-lo nesta sessão?'
    });
  }

  // Default 1500 (Trilha/Simulação/Neuro). Modo entrevistador permite valor
  // maior pra gerar o prompt completo do paciente.
  const tokenCap = Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.min(Math.floor(maxTokens), 32000)
    : 1500;

  try {
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: resolved.systemPrompt },
        ...messages,
      ],
      max_completion_tokens: tokenCap,
    });
    res.json(completion.choices[0].message);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com a IA: ' + err.message });
  }
});

// --- OpenAI Assistants API (FreePlay/Neuro com assistant_id por personagem) ---
// Mantém os mesmos prompts e fluxos do projeto Echos.
// Cria uma thread por sessão; envia user message; aguarda run completar; retorna resposta.

app.post('/api/assistants/thread', requireAuth, async (req, res) => {
  const openai = getOpenAI();
  if (!openai) {
    return res.json({ threadId: 'demo-thread-' + Date.now(), demo: true });
  }
  try {
    const thread = await openai.beta.threads.create();
    res.json({ threadId: thread.id });
  } catch (err) {
    console.error('Thread create error:', err.message);
    res.status(500).json({ error: 'Erro ao criar thread: ' + err.message });
  }
});

// Extrai um ID de assistant válido a partir de qualquer string (URL, texto, etc.)
function sanitizeAssistantId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const match = s.match(/asst_[A-Za-z0-9]+/);
  return match ? match[0] : s;
}

function isValidAssistantId(id) {
  return typeof id === 'string' && /^asst_[A-Za-z0-9]+$/.test(id) && id.length <= 64;
}

// Verifica se um assistantId está cadastrado em algum personagem do banco.
// Impede que um cliente passe um assistantId arbitrário (de outro projeto da
// OpenAI) e use a nossa chave para conversar com qualquer assistant.
function assistantIdIsCadastrado(assistantId) {
  if (!assistantId) return false;
  const fp = readJSON('freeplay-characters.json').some((c) => sanitizeAssistantId(c.assistantId) === assistantId);
  if (fp) return true;
  const nr = readJSON('neuro-characters.json').some((c) => sanitizeAssistantId(c.assistantId) === assistantId);
  return nr;
}

app.post('/api/assistants/message', requireAuth, aiLimiter, async (req, res) => {
  const { threadId, message } = req.body;
  const assistantId = sanitizeAssistantId(req.body.assistantId);
  const openai = getOpenAI();

  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] (resposta simulada do personagem)'
    });
  }

  if (!threadId || !assistantId) {
    return res.status(400).json({ error: 'threadId e assistantId são obrigatórios.' });
  }

  if (!isValidAssistantId(assistantId)) {
    return res.status(400).json({
      error: 'Assistant ID inválido. Deve começar com "asst_" e ter no máximo 64 caracteres. Verifique no painel da OpenAI.',
      code: 'invalid_assistant_id',
    });
  }

  // Hardening: só aceita assistantIds que estão cadastrados no banco —
  // bloqueia uso da chave OpenAI da Allos com assistants de terceiros.
  if (!assistantIdIsCadastrado(assistantId)) {
    return res.status(403).json({ error: 'Assistant ID não cadastrado.' });
  }

  try {
    // 1. Adiciona mensagem do usuário
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message,
    });

    // 2. Executa o assistente (modelo é definido no próprio assistant na OpenAI)
    let run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    });

    // 3. Aguarda conclusão (polling)
    const startedAt = Date.now();
    const TIMEOUT_MS = 180000;
    while (run.status === 'queued' || run.status === 'in_progress') {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        return res.status(504).json({ error: 'Tempo limite excedido aguardando o assistente.' });
      }
      await new Promise((r) => setTimeout(r, 1000));
      run = await openai.beta.threads.runs.retrieve(threadId, run.id);
    }

    if (run.status !== 'completed') {
      const detail = run.last_error ? `${run.last_error.code} — ${run.last_error.message}` : run.status;
      return res.status(500).json({ error: `Falha na execução do assistente: ${detail}` });
    }

    // 4. Recupera última mensagem (resposta da IA)
    const list = await openai.beta.threads.messages.list(threadId, { order: 'desc', limit: 1 });
    const last = list.data && list.data[0];
    if (!last || last.role !== 'assistant') {
      return res.status(500).json({ error: 'Resposta do assistente não encontrada.' });
    }

    const content = last.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text.value)
      .join('\n\n');

    res.json({ role: 'assistant', content });
  } catch (err) {
    console.error('Assistants error:', err.message);
    res.status(500).json({ error: 'Erro ao comunicar com o assistente: ' + err.message });
  }
});

// --- Avaliação de Sessão (Chat com IA) ---
const AVALIACAO_DIR = path.join(__dirname, '..', 'avaliacao');

function loadAvaliacaoPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'prompt-avaliacao-simulacao-v8-beta.md');
  const manualFile = path.join(AVALIACAO_DIR, 'manual-calibracao-avaliacao-v2.md');
  const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8') : '';
  const manual = fs.existsSync(manualFile) ? fs.readFileSync(manualFile, 'utf-8') : '';
  return prompt + '\n\n---\n\n# DOCUMENTO ANEXO — Manual de Calibração (v2)\n\n' + manual;
}

// Wrapper que garante o formato [NOTA:X] no fim, quando o admin define um prompt customizado
function wrapCustomEvaluatorPrompt(adminPrompt) {
  return `${adminPrompt.trim()}

---

## FORMATO OBRIGATÓRIO DE SAÍDA

Ao final da sua resposta, inclua OBRIGATORIAMENTE estas linhas, exatamente neste formato (são lidas pelo sistema):

[NOTA:X]

Onde X é a nota numérica que você atribui ao desempenho do aluno (use a escala que sua avaliação considera apropriada — pode ser positiva ou negativa, com ou sem sinal). Sem essa linha, o sistema não consegue registrar a pontuação.`;
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

app.post('/api/evaluate', requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body || {};
  const apiKey = process.env.OPENAI_API_KEY;

  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'systemPrompt')) {
    return res.status(400).json({
      error: 'systemPrompt não é mais aceito no body. Use context: { type, itemId } quando aplicável.',
    });
  }

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }

  if (!apiKey) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Não é possível realizar a avaliação sem a chave da API.'
    });
  }

  const resolved = resolveEvaluatorSystemPrompt({ context });
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

  try {
    const { default: OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: resolved.systemPrompt },
        ...messages,
      ],
      max_completion_tokens: 5000,
    });
    res.json(completion.choices[0].message);
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

  try {
    const { default: OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey });
    // Audio comes as base64
    const buffer = Buffer.from(req.body.audio, 'base64');
    const tmpFile = path.join(DATA_DIR, 'tmp_audio.webm');
    fs.writeFileSync(tmpFile, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-1',
      language: 'pt'
    });
    fs.unlinkSync(tmpFile);
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição' });
  }
});

// Serve static files in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Servidor Allos rodando na porta ${PORT}`));
