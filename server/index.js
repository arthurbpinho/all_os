require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const {
  buildTrilhaExercisePrompt,
  buildFreeplayPrompt,
  buildNeuroPrompt,
  buildImageSchemaPrompt,
  wrapCustomEvaluatorPrompt,
} = require('./prompts');
const mmrEngine = require('./mmr');
const { runAvaliacaoIndependente, buildV25NodeRequests, finalizeV25, buildChatBody } = require('./avaliacao-v25');
const aiIndependente = require('./avaliacao-independente');
const simIndependente = require('./simulacao-independente');
const errorLog = require('./error-log');
const { buildReflectionPrompt: buildAntessalaReflection } = require('./antessala');
const { finalScoreFromCriteria, comparativeScores } = require('./scoring');
const {
  NEURO_TEST_CATALOG,
  isValidTestId,
  testMeta: neuroTestMeta,
  normalizeTestIds: normalizeNeuroTestIds,
  compareNeuroTests,
} = require('./neuro-tests');

const app = express();

// Railway/Cloudflare ficam na frente; sem isso o express-rate-limit aborta com
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR e req.ip fica errado.
app.set('trust proxy', 1);

// Não anuncia "Express" em toda resposta — é reconhecimento de graça pra scanner.
app.disable('x-powered-by');

// Headers de segurança. Vem ANTES de tudo pra valer também nos estáticos.
// O CSP é o único ponto que pode quebrar a tela, então está escrito explícito
// em vez de usar o default do helmet — cada linha abaixo corresponde a algo que
// o app realmente carrega:
//   style/font externos  → Google Fonts (client/index.html)
//   img data:            → recortador de foto (canvas.toDataURL)
//   img/media blob:      → download de log e gravação de áudio do entrevistador
//   script 'self' apenas → o anti-flash do tema virou /theme-init.js justamente
//                          pra não precisar de 'unsafe-inline' aqui
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"], // trava clickjacking do painel admin
      'form-action': ["'self'"],
      'script-src': ["'self'"],
      'script-src-attr': ["'none'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'"],
      'worker-src': ["'self'"],
      'manifest-src': ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  // O app é servido inteiro pela mesma origem; nada é embutido de fora.
  crossOriginEmbedderPolicy: false,
  // Casa com frame-ancestors 'none' acima (o default do helmet é SAMEORIGIN).
  // Navegador moderno obedece o CSP; este header cobre os antigos.
  xFrameOptions: { action: 'deny' },
  // 1 ano. Sem `preload` de propósito: preload é praticamente irreversível e
  // exige decisão consciente sobre o domínio inteiro.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
}));

// --- IP real do cliente (base de TODO rate limit pré-autenticação) ---
// O X-Forwarded-For é parcialmente controlado por quem chama: o atacante manda
// o header, o Cloudflare só APENDA o IP real, e `trust proxy` faz o Express
// escolher uma posição que o atacante consegue prever. Efeito prático: um balde
// de rate limit novo e zerado a cada request forjada — brute-force sem limite.
// O CF-Connecting-IP é SOBRESCRITO pelo Cloudflare em toda request, então é o
// único valor confiável aqui.
//
// ATENÇÃO: isso só vale enquanto o tráfego chegar pelo Cloudflare. A URL
// *.up.railway.app fura o Cloudflare e, por ela, o CF-Connecting-IP volta a ser
// forjável. Mantenha o domínio da Railway fora de divulgação (ver DEPLOY.md).
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const raw = (typeof cf === 'string' && cf.trim()) ? cf.trim() : (req.ip || '');
  // Express entrega IPv4 como ::ffff:1.2.3.4 quando o socket é IPv6.
  if (raw.startsWith('::ffff:') && raw.includes('.')) return raw.slice(7);
  return raw;
}

// Chave de rate limit por IP. IPv6 é agrupado pelo /64 porque um único cliente
// costuma ter um /64 inteiro à disposição — chavear pelo endereço completo
// devolveria baldes infinitos de graça, que é exatamente o bypass que estamos
// fechando.
function ipKey(req) {
  const ip = clientIp(req);
  if (!ip) return 'ip:desconhecido';
  if (!ip.includes(':')) return `ip4:${ip}`;
  const [head, tail] = ip.split('%')[0].split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail ? tail.split(':').filter(Boolean) : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `ip6:${full.slice(0, 4).join(':')}`;
}

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
    const src = path.join(SEED_DATA_DIR, f);
    // Só semeia ARQUIVOS de dados (.json etc). Pula subpastas — ex.: patient-photos
    // (fotos enviadas em runtime) não é seed e copyFileSync quebraria com EISDIR.
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(DATA_DIR, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

// Fotos de paciente enviadas pelo admin ficam no volume persistente (DATA_DIR),
// não no repo — assim sobrevivem a redeploys do Railway. Servidas em
// /patient-photos. (As 6 fotos "de fábrica" continuam vindo de /profiles_icon.)
const PATIENT_PHOTOS_DIR = path.join(DATA_DIR, 'patient-photos');
if (!fs.existsSync(PATIENT_PHOTOS_DIR)) fs.mkdirSync(PATIENT_PHOTOS_DIR, { recursive: true });
app.use('/patient-photos', express.static(PATIENT_PHOTOS_DIR, { maxAge: '7d' }));

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
// Visitante é anônimo e não persistido: token curto limita a janela em que um
// token raspado do site serve pra queimar chamada de IA. Ver signToken.
const VISITOR_TOKEN_TTL = '2h';
const BCRYPT_ROUNDS = 10;

// --- Rate limiting ---
// Em NODE_ENV=test, todos os limiters viram no-op: a suite roda dezenas de
// logins/requests em segundos, o que estouraria janelas reais.
const SKIP_RATE_LIMIT = process.env.NODE_ENV === 'test';
const noopLimiter = (req, res, next) => next();

// Pre-auth (chave por IP): protege contra brute-force de credenciais e flood
// de geração de tokens. O keyGenerator explícito é obrigatório — o default do
// express-rate-limit usa req.ip, que é forjável atrás do Cloudflare (ver ipKey).
const loginLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
// Emissão de token de visitante. Era 5/15min, de quando o visitante nascia de
// um clique deliberado em "Entrar como visitante". Agora o app ABRE em modo
// visitante, então cada primeira visita gasta um token — e numa faculdade ou
// clínica todo mundo sai pelo mesmo IP: com 5, a sexta pessoa da sala não
// entraria.
//
// Afrouxar aqui não reabre a torneira: emitir token é só assinar um JWT (custo
// zero). O que custa dinheiro são as chamadas de IA, e essas estão travadas em
// VISITOR_AI_MAX por HORA por IP — teto que independe de quantos tokens o IP
// pediu. É o aiLimiter que segura o custo, não este.
const visitorLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
// Post-auth: protege a chave Anthropic (e a OpenAI do Whisper) de abuse, e
// segura escrita massiva em logs.
//
// Visitante é chaveado por IP, NÃO por user.id: o id dele é sorteado a cada
// /api/login/visitor, então chavear por id daria 300 chamadas de IA novas a
// cada token pedido — torneira aberta na conta de IA, sem senha nenhuma.
// Usuário real continua por id (o IP é compartilhado numa clínica/faculdade e
// não deve fazer um aluno consumir a cota do outro).
function userKey(req) {
  if (req.user && req.user.id && !req.user.isVisitor) return `u:${req.user.id}`;
  return ipKey(req);
}
// Teto de IA do visitante: uma conversa de demonstração cabe folgado; farm de
// chamada não. Usuário autenticado mantém os 300/h.
const VISITOR_AI_MAX = 40;

// --- Política de senha ---
// Piso por perfil. Supervisor e admin exigem mais porque são as contas que
// alcançam dados de todos os alunos. Antes o piso era 6 pra todo mundo — o que
// deixava o admin trocar, pela tela de Perfil, a senha de 12 exigida no boot
// (ADMIN_INITIAL_PASSWORD) por uma de 6.
const PASSWORD_MIN = 8;
const PASSWORD_MIN_PRIVILEGIADO = 12;
function senhaMinimaPara(role) {
  return (role === 'admin' || role === 'supervisor') ? PASSWORD_MIN_PRIVILEGIADO : PASSWORD_MIN;
}
// Devolve a mensagem de erro, ou null se a senha serve.
function validarSenha(senha, role) {
  const min = senhaMinimaPara(role);
  if (String(senha == null ? '' : senha).length < min) {
    const extra = min === PASSWORD_MIN_PRIVILEGIADO ? ' (contas de supervisor e admin exigem mais)' : '';
    return `Senha deve ter ao menos ${min} caracteres${extra}`;
  }
  return null;
}

// --- Atraso progressivo por CONTA nas tentativas de login ---
// O loginLimiter é por IP. Quem tem muitos IPs (botnet, VPN, Tor) ataca uma
// conta específica sem teto nenhum, porque cada IP traz 10 tentativas novas.
// Um contador por username fecha essa brecha.
//
// Por que ATRASO e não bloqueio: bloquear a conta transformaria isso numa arma
// — bastaria errar a senha de um aluno de propósito pra trancá-lo pra fora.
// O atraso encarece o ataque (que precisa de milhares de tentativas) sem
// impedir a pessoa certa de entrar.
const falhasLogin = new Map(); // username -> { count, last }
const FALHA_JANELA_MS = 15 * 60 * 1000;
const FALHA_TOLERANCIA = 3;      // as 3 primeiras não atrasam — typo acontece
const FALHA_ATRASO_MAX_MS = 5000;

function limparFalhasVelhas() {
  const cutoff = Date.now() - FALHA_JANELA_MS;
  for (const [k, v] of falhasLogin) if (v.last < cutoff) falhasLogin.delete(k);
}
function atrasoLoginMs(username) {
  const reg = falhasLogin.get(username);
  if (!reg || Date.now() - reg.last > FALHA_JANELA_MS) return 0;
  const excedente = reg.count - FALHA_TOLERANCIA;
  if (excedente <= 0) return 0;
  return Math.min(250 * (2 ** (excedente - 1)), FALHA_ATRASO_MAX_MS);
}
function registrarFalhaLogin(username) {
  limparFalhasVelhas();
  const reg = falhasLogin.get(username);
  const agora = Date.now();
  if (!reg || agora - reg.last > FALHA_JANELA_MS) falhasLogin.set(username, { count: 1, last: agora });
  else falhasLogin.set(username, { count: reg.count + 1, last: agora });
}
function limparFalhasLogin(username) {
  falhasLogin.delete(username);
}
// 300 req/hora cobre ~6 sessões clínicas longas. Era 60 antes — apertado
// demais pra uso real. Como /api/chat e /api/evaluate só aceitam context com
// itemId válido (resolveChatSystemPrompt / resolveEvaluatorSystemPrompt),
// o risco de abuse da chave Anthropic caiu — podemos afrouxar com segurança.
const aiLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: (req) => ((req.user && req.user.isVisitor) ? VISITOR_AI_MAX : 300),
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
console.log('[startup] GLM_API_KEY       =', envDiag('GLM_API_KEY'), '(GLM 5.2 / z.ai — Treinamento, Seletivo, Avaliação Independente e reflexão da Antessala)');
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

// Escrita atômica: grava num .tmp e faz rename (operação atômica no SO). Se o
// processo cair no meio da escrita, o arquivo original permanece íntegro — nunca
// fica um JSON pela metade.
function writeJSON(file, data) {
  const dest = path.join(DATA_DIR, file);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, dest);
}

// --- Registro de erros (painel "Logs de Erro" do admin) ---
// Grava o erro COMPLETO no DATA_DIR e devolve um código curto. A resposta ao
// usuário nunca deve conter err.message: use `falhou()` logo abaixo.
// Nunca lança — falhar ao registrar um erro não pode virar um segundo erro.
function registrarErro(req, err, where, { status = 500, extra = null } = {}) {
  let entry;
  try {
    entry = errorLog.buildErrorEntry({
      err, req, where, status, extra,
      ip: (() => { try { return clientIp(req); } catch { return null; } })(),
    });
    writeJSON(errorLog.ERROR_LOG_FILE, errorLog.appendError(readJSON(errorLog.ERROR_LOG_FILE), entry));
  } catch (e) {
    console.error('[error-log] não consegui registrar o erro:', e && e.message);
    if (!entry) return errorLog.newErrorId(); // ainda devolve código pro usuário
  }
  // Mantém o rastro no stdout do Railway também — o painel pode estar fora do ar
  // justamente quando mais se precisa dele.
  console.error(`[${entry.where}] ${entry.id}:`, (err && err.message) || err);
  return entry.id;
}

// Registra e devolve o corpo JSON pronto pra resposta: mensagem genérica com
// emoji + código. Uso: `res.status(500).json(falhou(req, err, 'chat/paciente'))`.
function falhou(req, err, where, { status = 500, message, extra } = {}) {
  const id = registrarErro(req, err, where, { status, extra });
  return errorLog.userFacingError(id, message);
}

// Mutex em memória por arquivo (fila de promises). Serializa o ciclo
// ler→modificar→gravar de um mesmo arquivo entre requests concorrentes, evitando
// "lost update" quando há um await (ex.: chamada de IA) no meio do handler.
// Válido enquanto o servidor roda em UM processo (caso atual no Railway). IMPORTANTE:
// mantenha awaits longos (IA) FORA do lock — pegue o lock só pro trecho curto
// "re-lê → aplica → grava".
const fileLocks = new Map();
async function withFileLock(file, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  fileLocks.set(file, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Limpa a entrada se ninguém mais está na fila, pra não vazar memória.
    if (fileLocks.get(file) === next) fileLocks.delete(file);
  }
}

// --- Initialize default data ---
const DEFAULT_PROFILE = {
  gender: '',
  email: '',
  profilePhoto: '/profiles_icon/isaacdeterno.jpeg',
  updateAllOS: false,
  updateAllos: false,
};

// 'evaluator' (Avaliador) acompanha o Processo Seletivo (Dashboard + Logs de
// avaliações). Conta real criada pelo admin, como as demais.
const VALID_ROLES = ['therapist', 'supervisor', 'admin', 'evaluator'];

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

// Competências da Trilha (etiquetas que agrupam os exercícios em "lanes").
// Deixam de ser fixas em código: o admin pode renomear, recolorir, criar e
// excluir (bloqueado se algum exercício ainda usa a competência). `order`
// controla a ordem de exibição no menu de escolha. Seed reproduz as 5
// competências originais, na mesma ordem em que já apareciam (MENU_ORDER).
if (!fs.existsSync(path.join(DATA_DIR, 'trilha-skills.json'))) {
  writeJSON('trilha-skills.json', [
    { id: 1, name: 'Hermenêutica', color: '#008f8f', order: 1 },
    { id: 5, name: 'Personalidade', color: '#A07845', order: 2 },
    { id: 2, name: 'Estrutura', color: '#B85A40', order: 3 },
    { id: 4, name: 'Especificidade do caso', color: '#5C8A82', order: 4 },
    { id: 3, name: 'Empatia', color: '#1A7A6D', order: 5 },
  ]);
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

// Feedback de visitantes: coletado num popup ao fim de uma sessão em modo
// visitante (estrelas 0–5 + mensagem livre). Lista append-only.
if (!fs.existsSync(path.join(DATA_DIR, 'feedback.json'))) {
  writeJSON('feedback.json', []);
}

// Processo Seletivo — logs completos dos candidatos (dados do candidato +
// mensagens + avaliação + nota + status). Retenção PRÓPRIA de 15 dias
// (pruneExpiredSelectionLogs), independente dos 30 dias do logs.json.
if (!fs.existsSync(path.join(DATA_DIR, 'selection-logs.json'))) {
  writeJSON('selection-logs.json', []);
}

// Processo Seletivo — estatísticas anônimas e PERMANENTES para a Dashboard.
// { timestamp, score, status } — sem PII, sem mensagens. Sobrevive à expiração
// dos logs completos, de modo que a Dashboard mantém o histórico agregado.
if (!fs.existsSync(path.join(DATA_DIR, 'selection-stats.json'))) {
  writeJSON('selection-stats.json', []);
}

// Avaliação Independente — FILA de jobs em batch (async). Runtime, não versionado.
if (!fs.existsSync(path.join(DATA_DIR, 'avaliacao-fila.json'))) {
  writeJSON('avaliacao-fila.json', []);
}

// Antessala (pré-supervisão) — mapas de caso criados pelo aluno antes da
// supervisão. Um registro por mapa, indexado por aluno (ownerId) e data — a
// leitura longitudinal (mesma tendência do aluno por vários mapas) fica
// consultável pelo supervisor sem refatoração.
if (!fs.existsSync(path.join(DATA_DIR, 'antessala.json'))) {
  writeJSON('antessala.json', []);
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

// --- TRI: populações anônimas alimentando a MESMA dificuldade ---
//
// A dificuldade dos personagens é ÚNICA. Competitivo, Processo Seletivo e
// (quando ligado) visitante escrevem todos em mmr.characters. É o ponto do
// sistema: Elo/TRI existe justamente para que respondentes de níveis
// diferentes produzam a mesma estimativa de dificuldade. Pools separadas
// devolveriam só "nota média por personagem" e jogariam essa propriedade fora.
//
// Candidato e visitante não têm MMR próprio (o candidato é efêmero; o visitante
// tem id sorteado a cada sessão). Cada um desses grupos vira então UM jogador
// persistente — a "população" —, guardado em mmr.anonPlayers. Começa em 50 e
// aprende: se o grupo é de fato mais fraco, o rating dele cai e o sistema para
// de confundir "respondente fraco" com "personagem difícil". Sem isso, um
// rating fixo em 50 empurraria a dificuldade compartilhada para cima.
const TRI_POOLS = ['selecao', 'visitante'];

// Peso do ajuste de dificuldade por fonte. Sinal de população é mais ruidoso
// que o de um aluno conhecido (o rating usado é a média do grupo, não a
// habilidade daquela pessoa), então recebe ganho menor — e o seletivo, que terá
// muito mais volume, não afoga o sinal do competitivo. Aluno real = 1.
const TRI_PESOS = {
  selecao: Number(process.env.TRI_PESO_SELECAO) || 0.35,
  visitante: Number(process.env.TRI_PESO_VISITANTE) || 0.5,
};

// Avaliação de visitante ainda não existe. A ligação está pronta: quando ligar,
// basta VISITOR_TRI=1 — o resto do caminho já está escrito e testado.
const VISITOR_TRI_ENABLED = process.env.VISITOR_TRI === '1';

// Quantos atendimentos cada fonte contribuiu para cada personagem. Não entra no
// engine — é só para a dashboard poder dizer de onde veio o número.
function bumpTriFonte(mmr, characterId, fonte) {
  if (!mmr.charSources) mmr.charSources = {};
  const id = String(characterId);
  if (!mmr.charSources[id]) mmr.charSources[id] = {};
  mmr.charSources[id][fonte] = (mmr.charSources[id][fonte] || 0) + 1;
}

// Registra UM atendimento de população anônima. Atualiza a dificuldade
// COMPARTILHADA e o rating da própria população. Idempotência não é garantida —
// quem chama deve fazê-lo uma única vez por avaliação concluída.
// Nunca lança: a TRI é observabilidade, não pode derrubar uma avaliação.
async function registrarTriAnonimo(pool, characterId, score) {
  if (!TRI_POOLS.includes(pool)) return null;
  if (!characterId || !Number.isFinite(Number(score))) return null;
  let out = null;
  try {
    await withFileLock('mmr.json', async () => {
      const mmr = readMMR();
      if (!mmr.anonPlayers) mmr.anonPlayers = {};
      const { player, character, result } = mmrEngine.updateMatch(
        mmr.anonPlayers[pool] || mmrEngine.newAnonPopulation(),
        mmr.characters[String(characterId)],
        Number(score),
        { dWeight: TRI_PESOS[pool] },
      );
      mmr.anonPlayers[pool] = player;
      mmr.characters[String(characterId)] = character;
      // Durante a calibração da população (3 primeiras) o engine não mexe no D;
      // só conta como contribuição o que de fato moveu a dificuldade.
      if (!result.calibratingBefore) bumpTriFonte(mmr, characterId, pool);
      writeMMR(mmr);
      out = result;
    });
    console.log(
      `[tri:${pool}] ${characterId} nota=${Math.round(Number(score))} ` +
      `D ${out.D_before.toFixed(1)} → ${out.D_after.toFixed(1)} · ` +
      `rating da população ${out.P_before.toFixed(1)} → ${out.P_after.toFixed(1)}` +
      (out.calibratingBefore ? ' (população em calibração, D intocado)' : ''),
    );
  } catch (e) {
    console.error(`[tri:${pool}] falha ao registrar ${characterId}:`, e && e.message);
  }
  return out;
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
    { expiresIn: user.role === 'visitor' ? VISITOR_TOKEN_TTL : TOKEN_TTL }
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
  // Atraso progressivo por conta (ver falhasLogin). Aplicado ANTES de comparar
  // o hash e valendo mesmo pra usuário inexistente — se só as contas reais
  // atrasassem, o atraso viraria um oráculo de enumeração.
  const atraso = SKIP_RATE_LIMIT ? 0 : atrasoLoginMs(String(username));
  if (atraso > 0) await new Promise((r) => setTimeout(r, atraso));

  const users = readJSON('users.json');
  const user = users.find(u => u.username === username);
  // Bcrypt sempre — se não houver hash, falha silenciosa (resposta genérica para evitar enumeration)
  const ok = user && user.passwordHash
    ? await bcrypt.compare(String(password), user.passwordHash)
    : false;
  if (!ok) {
    registrarFalhaLogin(String(username));
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  limparFalhasLogin(String(username)); // acertou: zera o contador
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
  const erroSenha = validarSenha(newPassword, req.user.role);
  if (erroSenha) return res.status(400).json({ error: erroSenha.replace('Senha deve', 'Nova senha deve') });
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

// Descrição visual da aparência (perfil). Um agente gpt-5.4-mini descreve a
// aparência da pessoa a partir da foto de perfil (data URI), em um parágrafo de
// até ~6 linhas. POR ORA o texto vive SÓ no perfil — NÃO é injetado nos
// pacientes ainda. Esta rota NÃO persiste: devolve a descrição e o cliente
// salva via PUT /api/users/:id junto com a foto e o consentimento.
app.post('/api/me/visual-description', requireAuth, aiLimiter, async (req, res) => {
  // Tudo dentro do try/catch: qualquer erro (leitura de arquivo, SDK, rede)
  // volta como JSON — nunca um 500 em HTML que vira "Erro desconhecido" no cliente.
  try {
    if (req.user.role === 'visitor') {
      return res.status(403).json({ error: 'Visitante não gera descrição visual.' });
    }
    const { photo } = req.body || {};
    // Aceita tanto uma foto recém-enviada (data URI) quanto uma já salva no
    // perfil (caminho /profiles_icon/<arquivo>) — neste caso lemos do disco e
    // convertemos em data URI. Assim funciona mesmo sem um upload novo.
    let imageUrl = null;
    if (typeof photo === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(photo)) {
      imageUrl = photo;
    } else if (typeof photo === 'string' && photo.startsWith('/profiles_icon/')) {
      const fname = path.basename(photo); // basename evita path traversal
      const fpath = path.join(PROFILES_DIR, fname);
      if (fpath.startsWith(PROFILES_DIR) && fs.existsSync(fpath)) {
        const ext = path.extname(fname).slice(1).toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        imageUrl = `data:${mime};base64,` + fs.readFileSync(fpath).toString('base64');
      }
    }
    if (!imageUrl) {
      return res.status(400).json({ error: 'Adicione uma foto de perfil válida para gerar a descrição visual.' });
    }
    const openai = getOpenAI();
    if (!openai) {
      return res.status(503).json({ error: 'Descrição visual indisponível: OPENAI_API_KEY não configurada.' });
    }
    const visionModel = process.env.OPENAI_VISION_MODEL || 'gpt-5.4-mini-2026-03-17';
    const system = `Você descreve, de forma objetiva e respeitosa, a APARÊNCIA VISUAL de uma pessoa a partir de uma foto, para uso como "aparência do terapeuta" em simulações clínicas. Escreva INTEIRAMENTE em português do Brasil (sem usar outros idiomas ou alfabetos), em UM único parágrafo de no máximo 6 linhas (sem títulos, sem listas, sem preâmbulo e sem comentar a qualidade da foto). Descreva apenas o que é visível: faixa etária aparente, tom de pele, cabelo (cor/comprimento/estilo), traços e expressão do rosto, barba/óculos/acessórios e vestuário/estilo geral. Não invente nome, profissão, emoções internas, etnia ou estado de saúde, e não faça julgamentos. Se não houver uma pessoa claramente visível, responda apenas: "Não foi possível identificar uma aparência na imagem."`;
    const resp = await openai.chat.completions.create({
      model: visionModel,
      reasoning_effort: 'none',
      max_completion_tokens: 500,
      messages: [
        { role: 'developer', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Descreva a aparência visual desta pessoa em um único parágrafo de no máximo 6 linhas.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });
    const description = (resp.choices?.[0]?.message?.content || '').trim();
    logOpenAIUsage('Descrição visual', visionModel, resp.usage);
    if (!description) return res.status(502).json({ error: 'Não foi possível gerar a descrição.' });
    return res.json({ description });
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json(falhou(req, err, 'perfil/descrição-visual'));
    }
  }
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
  // Apenas campos de perfil podem ser alterados aqui. visualDescription é
  // gerado por IA (POST /api/me/visual-description) e shareAppearance é o
  // consentimento de mostrar a aparência aos pacientes simulados (ainda não
  // usado nos prompts — só guardado no perfil por enquanto).
  const allowed = ['name', 'gender', 'email', 'profilePhoto', 'updateAllOS', 'updateAllos', 'visualDescription', 'shareAppearance'];
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
  // Piso depende do perfil sendo criado/editado (ver validarSenha).
  if (!isUpdate && !body.password) {
    errors.push(`Senha deve ter ao menos ${senhaMinimaPara(role)} caracteres`);
  } else if (body.password !== undefined && body.password !== '') {
    const erroSenha = validarSenha(body.password, role);
    if (erroSenha) errors.push(erroSenha);
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
    // Piso pelo perfil RESULTANTE: promover alguém a supervisor já na mesma
    // request exige a senha do perfil novo, não a do antigo.
    const erroSenha = validarSenha(req.body.password, merged.role);
    if (erroSenha) return res.status(400).json({ error: erroSenha });
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
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  // Piso pelo perfil de quem está sendo resetado (ver validarSenha).
  const erroSenha = validarSenha(newPassword, users[idx].role);
  if (erroSenha) return res.status(400).json({ error: erroSenha });
  users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  writeJSON('users.json', users);
  res.json({ ok: true });
});

// Export completo dos JSON do DATA_DIR — admin-only. Para backup/migração
// pra SQL. Em produção, o admin loga e baixa via interface (AdminUsers.jsx).
//
// passwordHash NÃO vai no export por padrão. O endpoint é admin-only, mas o
// ARQUIVO gerado sai do servidor: vai pro notebook, pro Drive, pro WhatsApp.
// Hash bcrypt não é senha, mas é quebrável OFFLINE, onde nenhum rate limit
// alcança — um backup de dados não deve virar um arquivo de credenciais.
// Pra restaurar um desastre você não precisa deles: recria os usuários e emite
// senhas novas. Quem realmente precisar pede ?includeSecrets=true, e aí é um
// ato consciente e registrado no log.
app.get('/api/admin/export', requireAuth, requireRole('admin'), (req, res) => {
  const incluirSegredos = req.query.includeSecrets === 'true';
  const users = readJSON('users.json');
  if (incluirSegredos) {
    console.warn(`[export] ${req.user.username} exportou COM os hashes de senha.`);
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    exportedBy: req.user.username,
    schemaVersion: 1,
    // Deixa explícito no próprio arquivo se ele contém credenciais ou não.
    includesSecrets: incluirSegredos,
    data: {
      users: incluirSegredos ? users : users.map(({ passwordHash, ...rest }) => rest),
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
  { id: 'first_session',  icon: '◐', title: 'Primeira Sessão',           description: 'Concluiu sua primeira sessão na plataforma.',                    tier: 'bronze' },
  { id: 'first_ranked',   icon: '◔', title: 'Primeira sessão ranqueada', description: 'Concluiu sua primeira sessão no modo Competitivo.',              tier: 'bronze' },
  { id: 'madrugador',     icon: '☾', title: 'Madrugador',                description: 'Realizou uma sessão entre 1h e 5h da madrugada.',                tier: 'bronze' },
  { id: 'changed_photo',  icon: '☺', title: 'Não sou mais o Isaac',      description: 'Trocou a foto de perfil padrão pela sua.',                       tier: 'bronze' },
  { id: 'invited_friend', icon: '✉', title: 'Chamei um amigo!',          description: 'Convidou um visitante para um duelo de treino (não ranqueado).', tier: 'bronze' },
  { id: 'constancia',     icon: '●', title: 'Constância',                description: 'Manteve constância de 4 semanas consecutivas.',                  tier: 'bronze', target: 4 },
  { id: 'papagaio',       icon: '◍', title: 'Papagaio',                  description: 'Usou o botão de microfone 100 vezes.',                           tier: 'bronze', target: 100 },

  // ---------- PRATA ----------
  { id: 'eficiencia',   icon: '↗', title: 'Eficiência',   description: 'Concluiu uma sessão em menos de 5 min com pontuação acima de 60.',     tier: 'silver' },
  { id: 'bom_garoto',   icon: '✓', title: 'Bom garoto',   description: 'Cumpriu todas as missões diárias por 7 dias seguidos.',                tier: 'silver', target: 7 },
  { id: 'centena',      icon: '∞', title: 'Centena',      description: 'Concluiu 100 sessões em qualquer modo.',                               tier: 'silver', target: 100 },
  { id: 'persistencia', icon: '❖', title: 'Persistência', description: 'Manteve constância por 20 semanas.',                                   tier: 'silver', target: 20 },
  { id: 'duelista',     icon: '⚔', title: 'Duelista',     description: 'Venceu 10 duelos ranqueados.',                                         tier: 'silver', target: 10 },
  { id: 'vinganca',     icon: '⚡', title: 'Vingança',     description: 'No Modo Desafio, roubou um paciente de quem já tinha roubado um seu.', tier: 'silver' },

  // ---------- OURO (valem título de perfil) ----------
  { id: 'consistente',        icon: '≡', title: 'Consistente',        description: 'Jogou uma partida ranqueada sem alterar o seu MMR.',                      tier: 'gold' },
  { id: 'destronador',        icon: '⇅', title: 'Destronador',        description: 'No Modo Desafio, retomou um paciente que acabou de perder.',              tier: 'gold' },
  { id: 'simulacao_complete', icon: '◇', title: 'Repertório Clínico', description: 'Concluiu todos os personagens da Simulação.',                             tier: 'gold' },
  { id: 'excelencia',         icon: '★', title: 'Excelência Técnica', description: 'Atingiu pontuação maior ou igual a 90 em uma sessão.',                    tier: 'gold' },
  { id: 'perfeicao',          icon: '✪', title: 'Perfeição',          description: 'Tirou nota 100 em uma sessão.',                                           tier: 'gold' },
  { id: 'meteu_o_lacan',      icon: '⊛', title: 'Meteu o Lacan',      description: 'Tirou 80 ou mais em uma sessão com até 10 mensagens.',                    tier: 'gold' },
  { id: 'estrelinha',         icon: '✶', title: 'Estrelinha',         description: 'Marcou 1000 mensagens como destaque.',                                    tier: 'gold', target: 1000 },
  { id: 'rei',                icon: '♛', title: 'Rei',                description: 'Foi Titular de 7 pacientes ao mesmo tempo.',                              tier: 'gold', target: 7 },
  { id: 'invicto',            icon: '⚑', title: 'Invicto',            description: 'Venceu 5 duelos ranqueados consecutivos.',                                tier: 'gold', target: 5 },
  { id: 'davi_golias',        icon: '◭', title: 'Davi e Golias',      description: 'Venceu um duelo ranqueado contra alguém com 30+ de MMR a mais que você.', tier: 'gold' },
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

// Streak em DIAS consecutivos — a "Constância" da Trilha. Mesma ideia da
// ofensiva semanal (computeStreak), mas por dia: um dia é "ativo" quando há ao
// menos um log nele. Carência de 1 dia (você não perde a constância no instante
// em que vira meia-noite — tem o dia de hoje para manter). Como os logs têm TTL
// de 30 dias, a constância contabiliza no máximo a janela recente — suficiente
// para o uso diário.
function computeDailyStreak(userLogs) {
  if (!userLogs.length) {
    return { current: 0, longest: 0, isAlive: false, lastActiveDate: null };
  }
  const days = new Set(userLogs.map((l) => dayKey(l.timestamp || l.createdAt || Date.now())));
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);

  // Cursor: começa hoje (se tem log) ou ontem (carência de 1 dia).
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

  return { current, longest, isAlive: current > 0, lastActiveDate: sorted[sorted.length - 1] || null };
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

  // Conquistas desbloqueadas FORA de sessão (trocar foto, convidar amigo) só são
  // detectadas quando o próprio dono abre suas Metas — notifica aqui (com som no
  // sino). Idempotente via achievement-unlocks.json; só pro próprio usuário.
  if (req.params.userId === req.user.id && req.user.role !== 'visitor') {
    try { notifyNewAchievements(userId, unlocked, claimedMap); } catch {}
  }

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
    res.status(500).json(falhou(req, err, 'admin/listar-fotos'));
  }
});

// --- Helpers de filtragem de campos sensíveis ---
// Cliente (não-admin) recebe só metadados de exibição; admin recebe o objeto
// completo para edição. O conteúdo "secreto" (specificInstruction, evaluatorPrompt,
// diagnosis) é resolvido server-side em /api/chat e /api/evaluate via context.
function isAdmin(user) {
  return !!(user && user.role === 'admin');
}

// Neuroavaliação está restrita a professor (supervisor) e admin por enquanto —
// oculta de alunos e visitantes. Gate único usado no chat, na comparação de
// testes e na listagem/CRUD dos personagens.
function canUseNeuro(user) {
  return !!(user && (user.role === 'admin' || user.role === 'supervisor'));
}

function publicExercise(e) {
  const { specificInstruction, evaluatorPrompt, imageSchemaPrompt, ...safe } = e;
  // Cliente precisa saber SE existe avaliador customizado / esquema visual
  // para escolher fluxo, mas não precisa ver o texto (evaluatorPrompt e a
  // observação do esquema são instruções do admin, não gabarito do aluno).
  safe.hasCustomEvaluator = !!(evaluatorPrompt && String(evaluatorPrompt).trim());
  safe.hasImageSchema = !!e.imageSchemaEnabled;
  return safe;
}
function publicFreeplayChar(c) {
  // evaluationCriteria é o Bloco 1 / gabarito — só vai pro avaliador server-side,
  // jamais pro cliente não-admin (vazaria a "resposta" do caso).
  const { specificInstruction, evaluationCriteria, ...safe } = c;
  return safe;
}
function publicNeuroChar(c) {
  // diagnosis, evaluationCriteria, evaluationAppendix, recommendedTests e
  // testResults são gabaritos — NUNCA vão pra cliente não-admin (o aluno só vê os
  // testes recomendados e os resultados DEPOIS de comitar a própria seleção, via
  // /compare-tests). specificInstruction também sai (contém o apêndice/gabarito).
  const { specificInstruction, diagnosis, evaluationCriteria, evaluationAppendix, recommendedTests, testResults, ...safe } = c;
  return safe;
}

// Sanitiza os campos de gabarito de testes (Neuroavaliação) vindos do admin:
// recommendedTests (ids válidos, deduplicados) e testResults (id válido -> texto
// limitado). Só mantém resultados de testes que existem no catálogo.
const NEURO_TEST_RESULT_MAX = 2000;
function sanitizeNeuroTestFields(body) {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(body, 'recommendedTests')) {
    out.recommendedTests = normalizeNeuroTestIds(body.recommendedTests);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'testResults')) {
    const raw = body.testResults;
    const clean = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const id = String(k == null ? '' : k).trim();
        if (isValidTestId(id)) {
          const val = clampStr(v, NEURO_TEST_RESULT_MAX).trim();
          if (val) clean[id] = val;
        }
      }
    }
    out.testResults = clean;
  }
  // Quando o payload traz os dois campos juntos (fluxo normal do admin), descarta
  // resultados de testes que não estão na bateria recomendada — evita órfãos.
  if (out.recommendedTests && out.testResults) {
    const keep = new Set(out.recommendedTests);
    for (const k of Object.keys(out.testResults)) {
      if (!keep.has(k)) delete out.testResults[k];
    }
  }
  return out;
}

// --- Exercises (System 1) ---
app.get('/api/exercises', requireAuth, (req, res) => {
  const list = readJSON('exercises.json');
  res.json(isAdmin(req.user) ? list : list.map(publicExercise));
});

app.post('/api/exercises', requireAuth, requireRole('admin'), (req, res) => {
  const exercises = readJSON('exercises.json');
  const ex = { id: 'ex' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'), ...req.body };
  // evaluatorModel/chatModel/imageSchemaModel são allowlists fechadas
  // (TRILHA_EXERCISE_MODELS/TRILHA_CHAT_MODELS/TRILHA_IMAGE_MODELS, definidas
  // mais abaixo) — valor fora delas cai no default da Trilha.
  if (!TRILHA_EXERCISE_MODELS[ex.evaluatorModel]) ex.evaluatorModel = TRILHA_EXERCISE_MODEL_DEFAULT;
  if (!TRILHA_CHAT_MODELS[ex.chatModel]) ex.chatModel = TRILHA_CHAT_MODEL_DEFAULT;
  if (!TRILHA_IMAGE_MODELS[ex.imageSchemaModel]) ex.imageSchemaModel = TRILHA_IMAGE_MODEL_DEFAULT;
  ex.imageSchemaEnabled = !!ex.imageSchemaEnabled;
  exercises.push(ex);
  writeJSON('exercises.json', exercises);
  res.json(ex);
});

const EXERCISE_FIELDS = [
  'title', 'description', 'skillId', 'difficulty', 'specificInstruction',
  'evaluatorPrompt', 'evaluatorModel', 'chatModel',
  'imageSchemaEnabled', 'imageSchemaPrompt', 'imageSchemaModel',
];
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
  const patch = pickFields(req.body, EXERCISE_FIELDS);
  if ('evaluatorModel' in patch && !TRILHA_EXERCISE_MODELS[patch.evaluatorModel]) patch.evaluatorModel = TRILHA_EXERCISE_MODEL_DEFAULT;
  if ('chatModel' in patch && !TRILHA_CHAT_MODELS[patch.chatModel]) patch.chatModel = TRILHA_CHAT_MODEL_DEFAULT;
  if ('imageSchemaModel' in patch && !TRILHA_IMAGE_MODELS[patch.imageSchemaModel]) patch.imageSchemaModel = TRILHA_IMAGE_MODEL_DEFAULT;
  if ('imageSchemaEnabled' in patch) patch.imageSchemaEnabled = !!patch.imageSchemaEnabled;
  exercises[idx] = { ...exercises[idx], ...patch };
  writeJSON('exercises.json', exercises);
  res.json(exercises[idx]);
});

app.delete('/api/exercises/:id', requireAuth, requireRole('admin'), (req, res) => {
  let exercises = readJSON('exercises.json');
  exercises = exercises.filter(e => e.id !== req.params.id);
  writeJSON('exercises.json', exercises);
  res.json({ ok: true });
});

// --- Trilha Skills (competências) ---
// Etiquetas que agrupam os exercícios em "lanes" no mapa da Trilha. Antes eram
// 5 competências fixas em código (SKILL_NAMES/SKILL_COLORS no cliente); agora
// vivem em dados e o admin pode criar, renomear, recolorir e excluir.
function nextTrilhaSkillId(skills) {
  return skills.reduce((max, s) => Math.max(max, Number(s.id) || 0), 0) + 1;
}
function nextTrilhaSkillOrder(skills) {
  return skills.reduce((max, s) => Math.max(max, Number(s.order) || 0), 0) + 1;
}
function sanitizeSkillColor(v) {
  const s = String(v == null ? '' : v).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#5C8A82';
}

app.get('/api/trilha-skills', requireAuth, (req, res) => {
  const skills = readJSON('trilha-skills.json', []);
  res.json([...skills].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)));
});

app.post('/api/trilha-skills', requireAuth, requireRole('admin'), (req, res) => {
  const skills = readJSON('trilha-skills.json', []);
  const name = clampStr(req.body && req.body.name, 60).trim();
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
  const skill = {
    id: nextTrilhaSkillId(skills),
    name,
    color: sanitizeSkillColor(req.body && req.body.color),
    order: nextTrilhaSkillOrder(skills),
  };
  skills.push(skill);
  writeJSON('trilha-skills.json', skills);
  res.json(skill);
});

const TRILHA_SKILL_FIELDS = ['name', 'color', 'order'];
app.put('/api/trilha-skills/:id', requireAuth, requireRole('admin'), (req, res) => {
  const skills = readJSON('trilha-skills.json', []);
  const idx = skills.findIndex((s) => String(s.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Competência não encontrada' });
  const patch = pickFields(req.body, TRILHA_SKILL_FIELDS);
  if ('name' in patch) {
    const name = clampStr(patch.name, 60).trim();
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    patch.name = name;
  }
  if ('color' in patch) patch.color = sanitizeSkillColor(patch.color);
  if ('order' in patch) patch.order = Number.isFinite(Number(patch.order)) ? Number(patch.order) : skills[idx].order;
  skills[idx] = { ...skills[idx], ...patch };
  writeJSON('trilha-skills.json', skills);
  res.json(skills[idx]);
});

app.delete('/api/trilha-skills/:id', requireAuth, requireRole('admin'), (req, res) => {
  const skills = readJSON('trilha-skills.json', []);
  const idx = skills.findIndex((s) => String(s.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Competência não encontrada' });
  const skillId = skills[idx].id;
  const inUse = readJSON('exercises.json', []).filter((e) => String(e.skillId) === String(skillId)).length;
  if (inUse > 0) {
    return res.status(409).json({ error: `Existem ${inUse} exercício(s) usando esta competência. Mova-os para outra competência antes de excluir.` });
  }
  skills.splice(idx, 1);
  writeJSON('trilha-skills.json', skills);
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
  removePatientPhotoFiles(req.params.id); // limpa a foto do volume junto
  res.json({ ok: true });
});

// data:image/jpeg;base64,XXXX → Buffer. Aceita só imagem; null se inválido.
function decodeImageDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch { return null; }
}
function removePatientPhotoFiles(id) {
  for (const suf of ['-icon.jpg', '-full.jpg']) {
    try {
      const p = path.join(PATIENT_PHOTOS_DIR, id + suf);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignora */ }
  }
}

// Foto do paciente: o cliente manda o ícone (quadrado) + a imagem inteira já
// processados (canvas → JPEG data URL). O servidor não tem lib de imagem — só
// grava os bytes no volume e guarda a URL no personagem. `clear:true` remove.
app.put('/api/freeplay/:id/photo', requireAuth, requireRole('admin'), writeLimiter, (req, res) => {
  const chars = readJSON('freeplay-characters.json');
  const idx = chars.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });

  if (req.body && req.body.clear) {
    removePatientPhotoFiles(req.params.id);
    delete chars[idx].photoIcon;
    delete chars[idx].photoFull;
    writeJSON('freeplay-characters.json', chars);
    return res.json(chars[idx]);
  }

  const icon = decodeImageDataUrl(req.body && req.body.icon);
  const full = decodeImageDataUrl(req.body && req.body.full);
  if (!icon || !full) return res.status(400).json({ error: 'Envie a foto (icon e full) como data URL de imagem.' });
  const MAX = 6 * 1024 * 1024; // bytes por arquivo
  if (icon.length > MAX || full.length > MAX) return res.status(413).json({ error: 'Imagem muito grande.' });

  try {
    fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-icon.jpg`), icon);
    fs.writeFileSync(path.join(PATIENT_PHOTOS_DIR, `${req.params.id}-full.jpg`), full);
  } catch (err) {
    return res.status(500).json(falhou(req, err, 'admin/gravar-foto-paciente',
      { extra: { casoId: req.params.id } }));
  }
  // ?v=<ts> quebra o cache do navegador quando a foto muda.
  const v = Date.now();
  chars[idx].photoIcon = `/patient-photos/${req.params.id}-icon.jpg?v=${v}`;
  chars[idx].photoFull = `/patient-photos/${req.params.id}-full.jpg?v=${v}`;
  writeJSON('freeplay-characters.json', chars);
  res.json(chars[idx]);
});

// --- Neuro Characters (System 3) ---
app.get('/api/neuro', requireAuth, (req, res) => {
  // Restrito a professor + admin (oculto de alunos por enquanto). Ambos gerenciam
  // os personagens, então recebem os dados completos; publicNeuroChar segue como
  // a projeção "de aluno" para o dia em que o neuro reabrir a esse perfil.
  if (!canUseNeuro(req.user)) {
    return res.status(403).json({ error: 'Neuroavaliação está disponível apenas para professores e administradores no momento.' });
  }
  const list = readJSON('neuro-characters.json');
  res.json(canUseNeuro(req.user) ? list : list.map(publicNeuroChar));
});

const NEURO_FIELDS = ['name', 'age', 'description', 'diagnosis', 'assistantId', 'specificInstruction', 'evaluationCriteria', 'evaluationAppendix', 'recommendedTests', 'testResults'];

app.post('/api/neuro', requireAuth, requireRole('admin', 'supervisor'), (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const base = sanitizeCharacterPayload(pickFields(req.body, NEURO_FIELDS));
  const c = {
    id: 'nr' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    ...base,
    ...sanitizeNeuroTestFields(req.body),
  };
  chars.push(c);
  writeJSON('neuro-characters.json', chars);
  res.json(c);
});

// Catálogo de testes neuropsicológicos (fonte única — server/neuro-tests.js).
// Não é gabarito: é a lista pública usada pelo TestSelector do aluno e pelo
// formulário do admin. Requer só autenticação.
app.get('/api/neuro/tests', requireAuth, (req, res) => {
  res.json(NEURO_TEST_CATALOG);
});

// Compara a seleção de testes do aluno com o gabarito do personagem e REVELA os
// resultados da bateria recomendada (só depois de o aluno comitar a seleção).
app.post('/api/neuro/:id/compare-tests', requireAuth, (req, res) => {
  // Neuroavaliação restrita a professor + admin por enquanto.
  if (!canUseNeuro(req.user)) {
    return res.status(403).json({ error: 'Neuroavaliação está disponível apenas para professores e administradores no momento.' });
  }
  const char = readJSON('neuro-characters.json').find((c) => String(c.id) === String(req.params.id));
  if (!char) return res.status(404).json({ error: 'Paciente não encontrado' });
  const selected = Array.isArray(req.body && req.body.selectedTests) ? req.body.selectedTests : [];
  const comparison = compareNeuroTests(char.recommendedTests, char.testResults, selected);
  res.json(comparison);
});

app.put('/api/neuro/:id', requireAuth, requireRole('admin', 'supervisor'), (req, res) => {
  const chars = readJSON('neuro-characters.json');
  const idx = chars.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  chars[idx] = {
    ...chars[idx],
    ...sanitizeCharacterPayload(pickFields(req.body, NEURO_FIELDS)),
    ...sanitizeNeuroTestFields(req.body),
  };
  writeJSON('neuro-characters.json', chars);
  res.json(chars[idx]);
});

app.delete('/api/neuro/:id', requireAuth, requireRole('admin', 'supervisor'), (req, res) => {
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

// Estatísticas da Trilha (barra superior): exercícios concluídos (distintos,
// aprovados com nota ≥ 75), nível derivado dessa contagem e Constância (streak
// diário). Fonte: progress.json (aprovações, persistente) + logs.json (dias
// ativos para a constância).
const TRILHA_PASS = 75;
const TRILHA_LEVEL_THRESHOLDS = [3, 10, 30, 100]; // nível 2,3,4,5
function trilhaLevel(completed) {
  let level = 1;
  for (const t of TRILHA_LEVEL_THRESHOLDS) if (completed >= t) level++;
  return level; // 1..5
}
app.get('/api/trilha/:userId', requireAuth, (req, res) => {
  if (!canAccessUserResource(req.user, req.params.userId)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  const progressAll = readJSON('progress.json', {});
  const userProgress = progressAll[req.params.userId] || {};
  let completed = 0;
  for (const k of Object.keys(userProgress)) {
    const p = userProgress[k];
    // p.passed é a fonte de verdade (setada pelo cliente ao salvar progresso —
    // inclui exercícios SEM avaliador, que "passam" ao só finalizar, com
    // score: null). O check por score fica como fallback pra dado antigo.
    if (p && typeof p === 'object' && (p.passed === true || (Number.isFinite(p.score) && p.score >= TRILHA_PASS))) completed++;
  }
  const level = trilhaLevel(completed);
  const nextThreshold = level < 5 ? TRILHA_LEVEL_THRESHOLDS[level - 1] : null;

  const exerciseLogs = readJSON('logs.json', [])
    .filter((l) => l && String(l.userId) === String(req.params.userId) && l.type === 'exercise');
  const constancia = computeDailyStreak(exerciseLogs);

  res.json({ completed, level, nextThreshold, pass: TRILHA_PASS, constancia });
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
const LOG_MAX_IMAGE_SCHEMA_LEN = 100000; // SVG do esquema visual (opcional, Trilha)
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

  // Neuroavaliação: registra a bateria de testes escolhida pelo aluno. Recomputa
  // a comparação server-side a partir do gabarito do personagem (à prova de
  // adulteração) — o cliente só manda os ids selecionados. Só para type 'neuro'.
  let neuroTests = null;
  if (body.type === 'neuro' && Array.isArray(body.neuroSelectedTests)) {
    const nchar = readJSON('neuro-characters.json').find((c) => String(c.id) === String(body.itemId));
    if (nchar) {
      neuroTests = compareNeuroTests(nchar.recommendedTests, nchar.testResults, body.neuroSelectedTests);
      // Justificativas do aluno por teste (só ids válidos, texto limitado).
      const just = {};
      const rawJ = body.neuroTestJustifications;
      if (rawJ && typeof rawJ === 'object' && !Array.isArray(rawJ)) {
        for (const [k, v] of Object.entries(rawJ)) {
          const tid = String(k == null ? '' : k).trim();
          if (isValidTestId(tid)) {
            const txt = clampStr(v, 2000).trim();
            if (txt) just[tid] = txt;
          }
        }
      }
      neuroTests.justifications = just;
    }
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
    // Esquema visual (opcional, Trilha): revalida o SVG aqui também (não confia
    // no que o cliente manda) — só persiste um bloco <svg> sanitizado ou null.
    imageSchema: clampStr(extractAndSanitizeSvg(body.imageSchema), LOG_MAX_IMAGE_SCHEMA_LEN) || null,
    // Custo da Trilha (admin, "Logs da Trilha"): chat/avaliador/esquema visual,
    // com o MODELO sempre resolvido do exercício (nunca do cliente).
    cost: buildTrilhaCost(body),
    messages: cleanMessages,
    neuroTests,
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
    if (!result.calibratingBefore) bumpTriFonte(mmr, log.itemId, 'competitivo');
    writeMMR(mmr);
    mmrResult = result;
    // Grava o MMR antes/depois desta partida no log (conquista "Consistente":
    // MMR arredondado inalterado). Reescreve o log já persistido.
    log.mmrBefore = Math.round(result.P_before);
    log.mmrAfter = Math.round(result.P_after);
    writeJSON('logs.json', logs);
  }

  // TRI do visitante — desligada por padrão (VISITOR_TRI=1 liga).
  // O visitante não tem MMR (id sorteado a cada sessão), então entra na mesma
  // camada anônima do seletivo, com rating fixo 50, mas em POOL SEPARADA: é
  // outra população e misturar corromperia as duas leituras.
  if (
    VISITOR_TRI_ENABLED &&
    req.user.role === 'visitor' &&
    log.type === 'freeplay' &&
    Number.isFinite(log.score) &&
    log.itemId
  ) {
    registrarTriAnonimo('visitante', log.itemId, log.score).catch(() => {});
  }

  // Sidequest: só no Treinamento (freeplay + mode 'training'). Se o aluno tinha
  // uma sidequest ativa e o avaliador a marcou como cumprida, conclui aqui —
  // move pra histórico, concede o título de recompensa e devolve o resultado pra
  // tela pós-sessão celebrar. O Competitivo (mode 'competitive') nunca entra.
  // Resolve a missão do Treinamento UMA VEZ, antes de concluir qualquer coisa: se
  // a sidequest for concluída logo abaixo, ela sai de `active`, e uma releitura
  // depois disso faria a missão diária "assumir" no meio da própria submissão —
  // concedendo uma missão que nunca foi ao prompt do avaliador.
  const missionEligible = log.type === 'freeplay' && mode === 'training' && req.user.role !== 'visitor';
  const { sidequest: activeMissionSq, daily: activeMissionDaily } = missionEligible
    ? resolveTrainingMission(req.user.id)
    : { sidequest: null, daily: null };

  let sidequestOutcome = null;
  if (missionEligible) {
    const active = activeMissionSq;
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
          // Avisa no sino (com som): ganhou a sidequest e o título de recompensa.
          pushNotification(req.user.id, {
            type: 'sidequest_completed',
            sidequestId: record.sidequestId,
            title: record.title,
            rewardTitleId: record.rewardTitleId,
            rewardTitleLabel: record.rewardTitleLabel,
          });
        }
      } else {
        // Repassa o "por que não passou" (justification do avaliador) pra tela
        // pós-sessão mostrar ao aluno o que faltou. Pode vir vazio.
        sidequestOutcome = { completed: false, title: active.title, reason: sidequestResult.justification || '' };
      }
    }
  }

  // Missão diária (desafio do dia, rotacionado do banco): mesmo gate da sidequest
  // — Treinamento, não-visitante. Só entra quando NÃO havia sidequest ativa (uma
  // ou outra): `activeMissionDaily` já vem null se havia.
  let dailyMissionOutcome = null;
  if (missionEligible) {
    const activeDaily = activeMissionDaily;
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
        dailyMissionOutcome = { completed: false, title: activeDaily.title, reason: dailyResult.justification || '' };
      }
    }
  }

  // Streak de missões diárias (conquista "Bom garoto" = 7 dias seguidos). Conta
  // com o novo log já incluído; visitante não acumula.
  if (req.user.role !== 'visitor') {
    updateDailyMissionStreak(req.user.id, logs.filter((l) => l.userId === req.user.id));
  }

  // Conquistas que esta sessão acabou de desbloquear → notifica no sino (com som).
  // Best-effort: nada aqui pode derrubar a submissão da sessão.
  if (req.user.role !== 'visitor') {
    try {
      const myLogs = logs.filter((l) => l.userId === req.user.id);
      const stk = computeStreak(myLogs);
      const { unlocked } = achievementsForUser(req.user.id, myLogs, stk, readJSON('freeplay-characters.json'));
      const claimedMap = readJSON('achievements.json', {})[req.user.id] || {};
      notifyNewAchievements(req.user.id, unlocked, claimedMap);
    } catch (err) {
      console.error('notifyNewAchievements (pós-sessão) falhou:', err.message);
    }
  }

  res.json({ ...log, mmr: mmrResult, sidequest: sidequestOutcome, dailyMission: dailyMissionOutcome });
});

// --- Feedback (popup ao fim da sessão, principalmente do visitante) ---
// Coleta uma nota de 0 a 5 estrelas + mensagem livre. Lista append-only em
// feedback.json. Qualquer usuário autenticado (inclusive visitante) pode enviar.
app.post('/api/feedback', requireAuth, writeLimiter, (req, res) => {
  const body = req.body || {};
  const stars = Number.isFinite(body.stars)
    ? Math.min(5, Math.max(0, Math.round(body.stars)))
    : 0;
  const message = clampStr(body.message, 2000);
  if (!stars && !message) {
    return res.status(400).json({ error: 'Envie ao menos uma nota ou uma mensagem.' });
  }
  const entry = {
    id: 'fb' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    timestamp: new Date().toISOString(),
    userId: req.user.id,
    userName: req.user.name || '',
    role: req.user.role || '',
    stars,
    message,
  };
  const all = readJSON('feedback.json', []);
  all.push(entry);
  writeJSON('feedback.json', all);
  res.json({ ok: true });
});

// Admin: lista todo o feedback coletado (mais recente primeiro).
app.get('/api/admin/feedback', requireAuth, requireRole('admin'), (req, res) => {
  const all = readJSON('feedback.json', []);
  res.json([...all].reverse());
});

// --- Logs de Erro (painel do admin) ---
// Contrapartida do `falhou()`: o usuário recebe só a mensagem genérica + código,
// e o detalhe (mensagem real, stack, quem, onde, quando) vive aqui.
app.get('/api/admin/error-logs', requireAuth, requireRole('admin'), (req, res) => {
  const all = readJSON(errorLog.ERROR_LOG_FILE, []);
  // Já vem do mais recente pro mais antigo (appendError insere no topo).
  res.json({
    errors: all,
    meta: { max: errorLog.MAX_ENTRIES, ttlDays: errorLog.TTL_DAYS },
  });
});

// Admin: limpa o painel. Útil depois de resolver uma leva de erros, pra a
// próxima falha não se perder no meio das antigas.
app.delete('/api/admin/error-logs', requireAuth, requireRole('admin'), (req, res) => {
  const antes = readJSON(errorLog.ERROR_LOG_FILE, []).length;
  writeJSON(errorLog.ERROR_LOG_FILE, []);
  console.log(`[error-log] painel limpo por ${req.user.username} (${antes} entradas)`);
  res.json({ ok: true, removidos: antes });
});

// Admin: dispara um aviso (notificação in-app) para TODOS os usuários reais.
// Cai no sino de notificações (type 'admin_notice'). Visitantes não recebem.
app.post('/api/admin/notifications', requireAuth, requireRole('admin'), (req, res) => {
  const message = clampStr(req.body && req.body.message, 500).trim();
  const title = clampStr(req.body && req.body.title, 120).trim();
  if (!message) return res.status(400).json({ error: 'A mensagem do aviso é obrigatória.' });
  const users = readJSON('users.json');
  let count = 0;
  for (const u of users) {
    if (!u || u.role === 'visitor') continue;
    pushNotification(u.id, {
      type: 'admin_notice',
      title: title || 'Aviso',
      message,
      fromName: req.user.name || 'Administração',
    });
    count++;
  }
  console.log(`[admin] aviso enviado por ${req.user.username} para ${count} usuário(s)`);
  res.json({ ok: true, count });
});

// Atualizações do sistema criadas pelo admin (painel "Atualizações"). Ficam em
// updates.json e são mescladas no cliente com o changelog estático.
//
// Restrito a admin e supervisor: são notas de versão, comunicação interna de
// desenvolvimento — aluno e visitante não veem. O painel também some pra eles
// no cliente; o gate está aqui porque esconder só na tela deixaria o conteúdo
// acessível a qualquer um com uma sessão.
app.get('/api/updates', requireAuth, requireRole('admin', 'supervisor'), (req, res) => {
  const list = readJSON('updates.json', []);
  const sorted = [...list].sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(sorted);
});

app.post('/api/admin/updates', requireAuth, requireRole('admin'), (req, res) => {
  const title = clampStr(req.body && req.body.title, 120).trim();
  const body = clampStr(req.body && req.body.body, 4000).trim();
  if (!body) return res.status(400).json({ error: 'O conteúdo da atualização é obrigatório.' });
  const reqDate = req.body && req.body.date;
  const date = (typeof reqDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reqDate))
    ? reqDate
    : new Date().toISOString().slice(0, 10);
  const entry = {
    id: 'upd-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    date,
    title,
    body,
    createdAt: new Date().toISOString(),
  };
  const list = readJSON('updates.json', []);
  list.push(entry);
  writeJSON('updates.json', list);
  console.log(`[admin] atualização publicada por ${req.user.username}: ${title || date}`);
  res.json(entry);
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
    // Rascunho da escolha de testes (só Neuroavaliação): preserva os testes
    // indicados + justificativas se o aluno recarregar durante a etapa de testes.
    neuroTests: (type === 'neuro' && body.neuroTests && typeof body.neuroTests === 'object') ? body.neuroTests : null,
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
// getAnthropic() voltou a ser chamado: Claude Sonnet 5 é uma das opções de
// evaluatorModel da Trilha (ver TRILHA_EXERCISE_MODELS/buildAnthropicArgs).
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
// Avaliador da Trilha (exercícios). Por decisão do dono roda no mini da família
// 5.4 — alto volume, feedback ao aluno, nota 0–100 (porcentagem). Não há Bloco 1
// nos exercícios, então o raciocínio leve ('low') basta e não há risco de vazar
// gabarito. O mini não aceita 'minimal'; usa none/low/medium/high/xhigh.
const OPENAI_EXERCISE_MODEL = process.env.OPENAI_EXERCISE_MODEL || 'gpt-5.4-mini-2026-03-17';
const OPENAI_EXERCISE_EFFORT = process.env.OPENAI_EXERCISE_EFFORT || 'low';
// Avaliador da Neuroavaliação. Por decisão do dono roda no 5.4 com effort 'low'
// (não no 5.5/EVAL) — exercício de sessão única, mais delimitado que o processo
// clínico completo. Selecionado em /api/evaluate quando context.type === 'neuro'.
const OPENAI_NEURO_MODEL = process.env.OPENAI_NEURO_MODEL || 'gpt-5.4-2026-03-05';
const OPENAI_NEURO_EFFORT = process.env.OPENAI_NEURO_EFFORT || 'low';

// --- Avaliadores de PRODUÇÃO trocados por decisão do dono (2026-07) ---
// TREINAMENTO (freeplay training): GLM 5.2 / high; FALLBACK pra gpt-5.4/medium (o
// SIM acima) se o GLM falhar. SELETIVO: mesmo par (GLM 5.2 high, fallback 5.4
// medium), síncrono. COMPETITIVO: gpt-5.5 / high, rodado em BATCH (assíncrono).
// O 5.5/high também pode ser escolhido por exercício na Trilha (ver
// TRILHA_EXERCISE_MODELS) — deixou de ser exclusivo do Competitivo. Env-
// overridáveis (trocar p/ 'gpt-*' reverte pro OpenAI). Provider é derivado do
// prefixo do modelo.
const TRAINING_EVAL_MODEL = process.env.TRAINING_EVAL_MODEL || 'glm-5.2';
const TRAINING_EVAL_EFFORT = process.env.TRAINING_EVAL_EFFORT || 'high';
const SELECAO_EVAL_MODEL = process.env.SELECAO_EVAL_MODEL || 'glm-5.2';
const SELECAO_EVAL_EFFORT = process.env.SELECAO_EVAL_EFFORT || 'high';
const OPENAI_COMP_MODEL = process.env.OPENAI_COMP_MODEL || 'gpt-5.5-2026-04-23';
const OPENAI_COMP_EFFORT = process.env.OPENAI_COMP_EFFORT || 'high';
function providerForModel(m) {
  return String(m || '').startsWith('glm') ? 'glm' : 'openai';
}

// Modelo do avaliador ESCOLHIDO POR EXERCÍCIO na Trilha (admin define ao salvar
// o exercício, ver EXERCISE_FIELDS/evaluatorModel). Cinco opções fixas — não é
// o laboratório livre de modelo/effort da Avaliação Independente (AVAL_MODELOS),
// só um atalho de presets pro uso do dia a dia. GLM e Claude rodam em modo
// buffered (sem streaming pro cliente) com FALLBACK pro mini padrão da Trilha
// se falharem — igual ao par Treinamento/GLM (ver isExerciseAltProvider em
// /api/evaluate).
const TRILHA_EXERCISE_MODEL_DEFAULT = 'gpt-5.4-mini';
const TRILHA_EXERCISE_MODELS = {
  'gpt-5.4-mini': { model: OPENAI_EXERCISE_MODEL, provider: 'openai', effort: OPENAI_EXERCISE_EFFORT },
  'gpt-5.4': { model: OPENAI_HEAVY_MODEL, provider: 'openai', effort: 'high' },
  'glm-5.2': { model: 'glm-5.2', provider: 'glm', effort: 'high' },
  'gpt-5.5': { model: OPENAI_COMP_MODEL, provider: 'openai', effort: 'high' },
  'claude-sonnet-5': { model: 'claude-sonnet-5', provider: 'anthropic', effort: 'high' },
};

// Modelo do PERSONAGEM/exercício em si (o lado da CONVERSA, não da nota) —
// também escolhido por exercício na Trilha (chatModel). Mesmas 5 opções do
// evaluatorModel. Mini e GPT-5.5 seguem sem reasoning (igual ao PATIENT_MODEL
// de sempre usado por freeplay/neuro — resposta direta, rápida); GLM 5.2,
// GPT-5.4 e Claude Sonnet 5 rodam em 'high' por decisão do dono (mesmo padrão
// do evaluatorModel) — personagem mais lento, porém mais nuançado. GLM/Claude
// têm FALLBACK pro mini padrão se falharem, igual ao par Treinamento/GLM.
const TRILHA_CHAT_MODEL_DEFAULT = 'gpt-5.4-mini';
const TRILHA_CHAT_MODELS = {
  'gpt-5.4-mini': { model: PATIENT_MODEL, provider: 'openai', effort: PATIENT_EFFORT },
  'gpt-5.4': { model: OPENAI_HEAVY_MODEL, provider: 'openai', effort: 'high' },
  'glm-5.2': { model: 'glm-5.2', provider: 'glm', effort: 'high' },
  'gpt-5.5': { model: OPENAI_COMP_MODEL, provider: 'openai', effort: 'none' },
  'claude-sonnet-5': { model: 'claude-sonnet-5', provider: 'anthropic', effort: 'high' },
};

// Esquema visual (SVG) OPCIONAL ao final do exercício — admin liga por
// exercício (imageSchemaEnabled) e escreve a observação (imageSchemaPrompt, ver
// buildImageSchemaPrompt) do que o esquema deve representar. Duas opções: o
// modelo ESCREVE um SVG autocontido (texto), que o navegador renderiza como
// imagem vetorial — não é geração de imagem "de pixel" (Claude não tem essa
// capacidade via API), por isso funciona igual pros dois provedores.
const TRILHA_IMAGE_MODEL_DEFAULT = 'gpt-5.4';
const TRILHA_IMAGE_MODELS = {
  'gpt-5.4': { model: OPENAI_HEAVY_MODEL, provider: 'openai', effort: 'high' },
  'claude-sonnet-5': { model: 'claude-sonnet-5', provider: 'anthropic', effort: 'high' },
};

function getAnthropic() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

// Monta os args da Messages API da Anthropic pro avaliador OU pro
// personagem/exercício da Trilha em Claude Sonnet 5 (única chamada de produção
// que usa Anthropic — a Simulação Independente tem o helper próprio dela,
// isolado). cache_control no system (reaproveitado entre turnos/alunos do
// mesmo exercício) e no último turno — importante pro chat, que reenvia o
// histórico inteiro a cada turno. max_tokens varia por chamador (avaliador
// precisa de folga pro feedback; chat usa o teto normal de resposta).
function buildAnthropicArgs({ model, effort, systemPrompt, turns, maxTokens }) {
  const args = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: turns.map((t, i) => (
      i === turns.length - 1
        ? { role: t.role, content: [{ type: 'text', text: t.content, cache_control: { type: 'ephemeral' } }] }
        : { role: t.role, content: t.content }
    )),
  };
  if (effort === 'disabled') {
    args.thinking = { type: 'disabled' };
  } else {
    args.thinking = { type: 'adaptive' };
    args.output_config = { effort }; // 'low' | 'medium' | 'high'
  }
  return args;
}
function extractAnthropicText(resp) {
  const blocks = (resp && resp.content) || [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}

// Extrai o bloco <svg>...</svg> da resposta do esquema visual e sanitiza
// defensivamente (o modelo às vezes cerca em texto/```; a transcrição do
// aluno — conteúdo não confiável — entra no prompt, então tratamos a saída
// como HTML não confiável também). O cliente ainda renderiza via <img> (blob
// URL), que por si só já impede execução de script num SVG — isto é
// defesa em profundidade, não a única barreira.
function extractAndSanitizeSvg(text) {
  const s = String(text || '');
  const match = s.match(/<svg[\s\S]*?<\/svg>/i);
  if (!match) return null;
  return match[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(xlink:href|href)\s*=\s*"\s*javascript:[^"]*"/gi, '')
    .replace(/(xlink:href|href)\s*=\s*'\s*javascript:[^']*'/gi, '');
}

// ── Custo dos Logs da Trilha (admin) ────────────────────────────────────────
// Normaliza o `usage` cru de qualquer chamada de IA da Trilha (chat/avaliador/
// esquema visual, nos 3 provedores) num shape único: {input, cacheRead,
// cacheWrite, output}. Necessário porque cada provedor/API devolve um formato
// diferente — OpenAI ainda tem DOIS formatos (Responses API pro avaliador/
// esquema visual; chat.completions pro chat do personagem via openaiComplete).
// Espelha normalizeSimUsage (simulacao-independente.js), mas isolado —
// production não importa os módulos dos laboratórios de pricing.
function normalizeUsage(provider, usage) {
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  if (!usage) return zero;
  if (provider === 'anthropic') {
    return {
      input: Math.max(0, usage.input_tokens || 0),
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      output: usage.output_tokens || 0,
    };
  }
  if (provider === 'glm') {
    const promptTotal = usage.prompt_tokens || 0;
    const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
    const completion = usage.completion_tokens || 0;
    const total = usage.total_tokens || 0;
    // GOTCHA GLM: completion_tokens sub-reporta o thinking; usa total-prompt
    // como piso da saída.
    const output = Math.max(completion, total > promptTotal ? total - promptTotal : 0);
    return { input: Math.max(0, promptTotal - cacheRead), cacheRead, cacheWrite: 0, output };
  }
  // OpenAI — Responses API (avaliador/esquema visual): input_tokens/output_tokens.
  if (usage.input_tokens != null || usage.output_tokens != null) {
    const cacheRead = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
    return { input: Math.max(0, (usage.input_tokens || 0) - cacheRead), cacheRead, cacheWrite: 0, output: usage.output_tokens || 0 };
  }
  // OpenAI — chat.completions (chat do personagem via openaiComplete).
  const cacheRead = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  return { input: Math.max(0, (usage.prompt_tokens || 0) - cacheRead), cacheRead, cacheWrite: 0, output: usage.completion_tokens || 0 };
}

// Preços em USD por 1 MILHÃO de tokens. Chaves = alias curto (sem data de
// pin) — resolveTrilhaPrices casa pelo PREFIXO mais longo do model id real,
// então sobrevive a troca de pin (ex.: 'gpt-5.4-mini-2026-03-17' → chave
// 'gpt-5.4-mini'). Mesmos números de V25_PRICES/SIM_PRICES (docs dos
// provedores, jul/2026) — sem importar esses módulos (isolados dos labs).
const TRILHA_COST_PRICES = {
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, cacheWrite: 0.75, output: 4.5 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, cacheWrite: 2.5, output: 15 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },
  'glm-5.2': { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
};
function resolveTrilhaPrices(model) {
  const s = String(model || '');
  let best = null;
  for (const key of Object.keys(TRILHA_COST_PRICES)) {
    if (s.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? TRILHA_COST_PRICES[best] : null;
}
// Custo em USD de um usage já normalizado. null = modelo fora da tabela (a UI
// mostra tokens, nunca um dólar errado).
function computeTrilhaCost(model, usage) {
  const p = resolveTrilhaPrices(model);
  if (!p || !usage) return null;
  return (usage.input * p.input + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite + usage.output * p.output) / 1e6;
}

// Sanitiza o usage que o cliente manda ao salvar o log (acumulado do lado
// dele, turno a turno) — não é fronteira de segurança (só afeta o dashboard
// de custo do admin), mas garante números finitos e não-negativos.
function sanitizeUsageInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { input: num(raw.input), cacheRead: num(raw.cacheRead), cacheWrite: num(raw.cacheWrite), output: num(raw.output) };
}

// Monta o breakdown de custo de um log de exercício da Trilha: chat
// (personagem, sempre) + avaliador (só se o exercício tiver evaluatorPrompt) +
// esquema visual (só se imageSchemaEnabled). Os MODELOS vêm sempre do
// EXERCÍCIO (server-side, nunca do cliente) — só o usage (tokens) é
// client-supplied, o resto (preço, qual modelo rodou) é recalculado aqui.
function buildTrilhaCost(body) {
  if (body.type !== 'exercise' || !body.itemId) return null;
  const ex = readJSON('exercises.json').find((e) => String(e.id) === String(body.itemId));
  if (!ex) return null;

  const parts = {};
  let totalUsd = 0;
  let anyPriced = false;
  const addPart = (key, spec, rawUsage) => {
    const usage = sanitizeUsageInput(rawUsage);
    if (!usage) return;
    const usd = computeTrilhaCost(spec.model, usage);
    parts[key] = { model: spec.model, usage, usd };
    if (usd != null) { totalUsd += usd; anyPriced = true; }
  };

  addPart('chat', TRILHA_CHAT_MODELS[ex.chatModel] || TRILHA_CHAT_MODELS[TRILHA_CHAT_MODEL_DEFAULT], body.chatUsage);
  if (ex.evaluatorPrompt && String(ex.evaluatorPrompt).trim()) {
    addPart('evaluator', TRILHA_EXERCISE_MODELS[ex.evaluatorModel] || TRILHA_EXERCISE_MODELS[TRILHA_EXERCISE_MODEL_DEFAULT], body.evaluatorUsage);
  }
  if (ex.imageSchemaEnabled) {
    addPart('imageSchema', TRILHA_IMAGE_MODELS[ex.imageSchemaModel] || TRILHA_IMAGE_MODELS[TRILHA_IMAGE_MODEL_DEFAULT], body.imageSchemaUsage);
  }

  if (!Object.keys(parts).length) return null;
  return { ...parts, totalUsd: anyPriced ? totalUsd : null };
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
    // O exercício nem sempre é uma simulação de paciente — a instrução define
    // o papel (paciente, colega, escrita livre etc.). O avaliador customizado
    // entra apenas no /api/evaluate. chatModelKey: qual IA roda ESSA conversa
    // (escolha do admin ao salvar o exercício, ver TRILHA_CHAT_MODELS).
    const chatModelKey = TRILHA_CHAT_MODELS[ex.chatModel] ? ex.chatModel : TRILHA_CHAT_MODEL_DEFAULT;
    return { systemPrompt: buildTrilhaExercisePrompt(ex.specificInstruction), chatModelKey };
  }
  if (type === 'freeplay') {
    const c = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(itemId));
    if (!c) return { status: 404, error: 'Personagem não encontrado' };
    return { systemPrompt: buildFreeplayPrompt(c.specificInstruction) };
  }
  if (type === 'neuro') {
    // Neuroavaliação restrita a professor + admin por enquanto (oculta de alunos
    // e visitantes).
    if (!canUseNeuro(user)) {
      return { status: 403, error: 'Neuroavaliação está disponível apenas para professores e administradores no momento.' };
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
      return res.status(500).json(falhou(req, err, 'entrevistador/chat',
        { extra: { modelo: OPENAI_HEAVY_MODEL } }));
    }
  }

  // --- Paciente/Personagem → OpenAI (gpt-5.4-mini, effort none) por padrão.
  // Na Trilha, o admin pode escolher outra IA por exercício (chatModel, ver
  // TRILHA_CHAT_MODELS) — freeplay/neuro continuam fixos no PATIENT_MODEL.
  // O personagem responde direto, SEM reasoning. Prompt caching da OpenAI é
  // automático no prefixo (>1024 tokens), então o system + histórico (chat de
  // 50-100 turnos) é cacheado sozinho a partir do 2º turno.
  const isExerciseChat = !!(context && context.type === 'exercise');
  const chatModelSpec = isExerciseChat
    ? (TRILHA_CHAT_MODELS[resolved.chatModelKey] || TRILHA_CHAT_MODELS[TRILHA_CHAT_MODEL_DEFAULT])
    : TRILHA_CHAT_MODELS[TRILHA_CHAT_MODEL_DEFAULT];

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
    if (chatModelSpec.provider !== 'openai') {
      // Exercício da Trilha com GLM 5.2 ou Claude Sonnet 5 escolhido pelo
      // admin: chamada direta (/api/chat não streama pro cliente). FALLBACK
      // pro mini padrão se o provedor alternativo falhar (rate limit/
      // instabilidade/sem API key) — o aluno sempre recebe resposta.
      const altProvider = chatModelSpec.provider;
      const altClient = getClientForProvider(altProvider);
      try {
        if (!altClient) throw new Error(`${altProvider} indisponível`);
        let text;
        let rawUsage;
        if (altProvider === 'anthropic') {
          const args = buildAnthropicArgs({
            model: chatModelSpec.model, effort: chatModelSpec.effort,
            systemPrompt: resolved.systemPrompt, turns: normalizeMessagesForAnthropic(messages),
            maxTokens: tokenCap + 2000,
          });
          const resp = await altClient.messages.create(args);
          text = extractAnthropicText(resp);
          rawUsage = resp.usage || null;
        } else {
          const body = buildChatBody({
            provider: altProvider, model: chatModelSpec.model, effort: chatModelSpec.effort,
            maxTokens: tokenCap + 2000, messages: buildOpenAIMessages(resolved.systemPrompt, messages),
          });
          const resp = await altClient.chat.completions.create(body);
          text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
          rawUsage = resp.usage || null;
        }
        if (!text.trim()) throw new Error('resposta vazia');
        // Custo dos Logs da Trilha: usage normalizado por provedor (ver
        // normalizeUsage) — o cliente só acumula e repassa, nunca calcula preço.
        return res.json({ role: 'assistant', content: text, usage: normalizeUsage(altProvider, rawUsage) });
      } catch (altErr) {
        console.error(`[chat trilha] ${chatModelSpec.model} falhou → fallback ${PATIENT_MODEL}:`, altErr.message);
        const { text, usage } = await openaiComplete({
          openai, model: PATIENT_MODEL, effort: PATIENT_EFFORT,
          systemPrompt: resolved.systemPrompt, messages, maxCompletionTokens: tokenCap + 2000,
        });
        logOpenAIUsage('Chat paciente (fallback)', PATIENT_MODEL, usage);
        return res.json({ role: 'assistant', content: text, usage: normalizeUsage('openai', usage) });
      }
    }

    // effort 'none' = sem reasoning → resposta direta e rápida.
    const { text, usage } = await openaiComplete({
      openai,
      model: chatModelSpec.model,
      effort: chatModelSpec.effort,
      systemPrompt: resolved.systemPrompt,
      messages,
      maxCompletionTokens: tokenCap + 2000,
    });
    logOpenAIUsage('Chat paciente', chatModelSpec.model, usage);
    res.json({ role: 'assistant', content: text, usage: normalizeUsage('openai', usage) });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'chat/paciente',
      { extra: { modelo: chatModelSpec.model } }));
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

// Avaliador dedicado do Processo Seletivo: "só-nota", saída curta e direcionada ao
// AVALIADOR (síntese + pontos fortes/fracos + observações), sem o diálogo socrático
// nem o feedback longo ao aluno do v16-2. Mesmos 6 critérios/régua e o mesmo bloco
// [notas-supervisor] (a nota final sai igual do scoring.js). System muito menor
// (~3k vs ~32k) → corta input; saída curta → corta prosa. Fallback no v16-2 se o
// arquivo sumir — o seletivo nunca fica sem avaliador.
function loadSelecaoEvaluatorPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'avaliador-processo-seletivo-v1.md');
  if (!fs.existsSync(promptFile)) return loadAvaliacaoPrompt();
  return fs.readFileSync(promptFile, 'utf-8');
}

// Avaliador dedicado da Neuroavaliação: sessão única, foco em acolhimento,
// entrevista, hipótese diagnóstica e adequação da bateria de testes. Se o arquivo
// não existir, cai no avaliador global (v16.2) — neuro nunca fica sem avaliador.
function loadNeuroEvaluatorPrompt() {
  const promptFile = path.join(AVALIACAO_DIR, 'neuro', 'avaliador-neuro-v1.md');
  if (!fs.existsSync(promptFile)) return loadAvaliacaoPrompt();
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

// Resolve o system prompt do avaliador server-side. Para exercícios da Trilha,
// o avaliador é OPCIONAL e definido pelo admin (evaluatorPrompt): sem ele, não
// há avaliador padrão de fallback — a avaliação simplesmente não acontece
// (400). Também resolve QUAL MODELO roda o avaliador (evaluatorModel).
function resolveEvaluatorSystemPrompt({ context }) {
  if (context && typeof context === 'object' && context.type === 'exercise' && context.itemId) {
    const ex = readJSON('exercises.json').find((e) => String(e.id) === String(context.itemId));
    if (!ex) return { status: 404, error: 'Exercício não encontrado' };
    if (!ex.evaluatorPrompt || !String(ex.evaluatorPrompt).trim()) {
      return { status: 400, error: 'Este exercício não tem avaliador configurado — a avaliação não está disponível.' };
    }
    const evaluatorModelKey = TRILHA_EXERCISE_MODELS[ex.evaluatorModel] ? ex.evaluatorModel : TRILHA_EXERCISE_MODEL_DEFAULT;
    return { systemPrompt: wrapCustomEvaluatorPrompt(ex.evaluatorPrompt), evaluatorModelKey };
  }
  // Neuroavaliação → avaliador dedicado (sessão única, diagnóstico + testes).
  if (context && typeof context === 'object' && context.type === 'neuro') {
    return { systemPrompt: loadNeuroEvaluatorPrompt() };
  }
  // freeplay, avaliação manual (sem context) → avaliador global
  return { systemPrompt: loadAvaliacaoPrompt() };
}

// Resolve o Bloco 1 (gabarito/critério de correção) do personagem, server-side.
// O texto fica fora do cliente — o aluno não pode ver a "resposta" do caso.
// Retorna string vazia quando o caso não tem evaluationCriteria configurado.
// Monta o trecho de gabarito da BATERIA de testes neuropsicológicos (recomendados
// + resultados) e orienta o avaliador a pesar a adequação da seleção do aluno.
// Vai junto do Bloco 1, server-side — nunca sai pro cliente por essa via.
function buildNeuroBatteryGabarito(char) {
  const recommended = normalizeNeuroTestIds(char && char.recommendedTests);
  if (!recommended.length) return '';
  const lines = recommended.map((id) => {
    const meta = neuroTestMeta(id);
    const result = char.testResults && char.testResults[id];
    const label = `- ${meta.abbr} — ${meta.name}`;
    return result ? `${label}\n  Resultado: ${String(result)}` : label;
  });
  return [
    'BATERIA DE TESTES NEUROPSICOLÓGICOS RECOMENDADA (GABARITO):',
    ...lines,
    '',
    'Ao avaliar, pese a ADEQUAÇÃO da bateria de testes que o aluno escolheu (informada na transcrição da sessão): testes recomendados que ele deixou de aplicar e testes desnecessários/extras que ele pediu devem influenciar a nota, junto com a qualidade da devolutiva.',
  ].join('\n');
}

function resolveBloco1({ context }) {
  if (!context || typeof context !== 'object' || !context.itemId) return '';
  let char = null;
  if (context.type === 'freeplay') {
    char = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(context.itemId));
  } else if (context.type === 'neuro') {
    char = readJSON('neuro-characters.json').find((c) => String(c.id) === String(context.itemId));
  }
  if (!char) return '';
  let bloco = char.evaluationCriteria && String(char.evaluationCriteria).trim()
    ? String(char.evaluationCriteria).trim()
    : '';
  if (context.type === 'neuro') {
    // Gabarito de neuro = BLOCO 1 (estrutura do caso: quem é, camadas, voz) +
    // APÊNDICE (hipótese diagnóstica esperada, diferenciais, bateria sugerida,
    // racional) + diagnóstico curto + bateria estruturada. Tudo server-side, fora
    // do alcance do aluno e do próprio paciente simulado.
    const sections = [];
    if (char.diagnosis && String(char.diagnosis).trim()) {
      sections.push(`DIAGNÓSTICO CORRETO DO CASO (gabarito — oculto do aluno): ${String(char.diagnosis).trim()}`);
    }
    if (bloco) sections.push(`BLOCO 1 — ESTRUTURA DO CASO:\n${bloco}`);
    if (char.evaluationAppendix && String(char.evaluationAppendix).trim()) {
      sections.push(`APÊNDICE — GABARITO NEUROPSICOLÓGICO (fora do personagem; hipótese diagnóstica esperada, diferenciais, bateria sugerida e racional clínico):\n${String(char.evaluationAppendix).trim()}`);
    }
    const battery = buildNeuroBatteryGabarito(char);
    if (battery) sections.push(battery);
    bloco = sections.join('\n\n');
  }
  return bloco;
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
  // avaliador barato (SIM/5.4). Competitivo, Duelo e (avaliação manual) ficam no
  // melhor (EVAL/5.5); Neuro tem régua própria (5.4/low, ver isNeuroEval); Trilha
  // usa o mini. O cliente sinaliza via context.mode; sem mode (aba Avaliar Sessão)
  // cai no EVAL.
  const isFreeSim = !!(context && context.type === 'freeplay' && context.mode === 'training');
  // Trilha (exercícios): modelo é ESCOLHIDO POR EXERCÍCIO (admin, ver
  // TRILHA_EXERCISE_MODELS/evaluatorModel). Não entra no progressionMode (que é
  // exclusivo do freeplay/treinamento).
  const isExercise = !!(context && context.type === 'exercise');
  const exerciseModelSpec = isExercise
    ? (TRILHA_EXERCISE_MODELS[resolved.evaluatorModelKey] || TRILHA_EXERCISE_MODELS[TRILHA_EXERCISE_MODEL_DEFAULT])
    : null;
  // GLM/Claude na Trilha rodam em modo buffered (sem streaming pro cliente),
  // igual ao par Treinamento/GLM. FALLBACK pro mini padrão da Trilha se o
  // provedor alternativo falhar (rate limit/instabilidade/sem API key).
  const isExerciseAltProvider = isExercise && exerciseModelSpec.provider !== 'openai';
  // Neuro roda no 5.4/low (dedicado), fora da régua EVAL/SIM.
  const isNeuroEval = !!(context && context.type === 'neuro');
  let systemPrompt = resolved.systemPrompt;
  let evalModel = isExercise ? (isExerciseAltProvider ? OPENAI_EXERCISE_MODEL : exerciseModelSpec.model) : isNeuroEval ? OPENAI_NEURO_MODEL : (isFreeSim ? OPENAI_SIM_MODEL : OPENAI_EVAL_MODEL);
  let evalEffort = isExercise ? (isExerciseAltProvider ? OPENAI_EXERCISE_EFFORT : exerciseModelSpec.effort) : isNeuroEval ? OPENAI_NEURO_EFFORT : (isFreeSim ? OPENAI_SIM_EFFORT : OPENAI_EVAL_EFFORT);
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
    // Uma missão OU outra (ver resolveTrainingMission): no máximo um dos dois vem
    // preenchido, então o avaliador recebe um único objetivo de missão.
    const { sidequest: activeSq, daily: activeDaily } = resolveTrainingMission(req.user.id);
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
        content += `[MISSÃO DIÁRIA]\nTÍTULO: ${activeDaily.title}\nDescrição: ${activeDaily.description}\n\nEste é o desafio do dia e é o objetivo principal deste atendimento (o aluno não tem sidequest ativa — as duas nunca aparecem juntas). Avalie primariamente se o aluno o cumpriu, com a mesma régua da sidequest, e emita o bloco [missao-diaria-resultado] conforme a especificação.\n\n---\n\n`;
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
    let usageProvider = 'openai'; // provedor do usage capturado — pra normalizar certo
    let usageModel = evalModel; // modelo que efetivamente rodou (pode virar o fallback)
    try {
      if (isFreeSim) {
        // TREINAMENTO → GLM 5.2 (buffered: a UI já mostra a tela "avaliando", não
        // streama token a token; o heartbeat acima segura a conexão). FALLBACK:
        // se o GLM falhar (rate limit/instabilidade), refaz no gpt-5.4/medium
        // (evalModel/evalEffort do SIM). O aluno sempre recebe nota+feedback.
        let full = '';
        const tProvider = providerForModel(TRAINING_EVAL_MODEL);
        const tClient = getClientForProvider(tProvider);
        try {
          if (!tClient) throw new Error(`${tProvider} indisponível`);
          const body = buildChatBody({
            provider: tProvider, model: TRAINING_EVAL_MODEL, effort: TRAINING_EVAL_EFFORT,
            maxTokens: 64000, messages: [{ role: 'developer', content: systemPrompt }, ...inputTurns],
          });
          const resp = await tClient.chat.completions.create(body);
          full = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
          if (!full.trim()) throw new Error('resposta vazia');
          usage = resp.usage || null;
          usageProvider = tProvider;
          usageModel = TRAINING_EVAL_MODEL;
          console.log(`Evaluate (${TRAINING_EVAL_MODEL} · treino${progressionMode ? '+progressão' : ''})`);
        } catch (glmErr) {
          console.error(`[evaluate treino] ${TRAINING_EVAL_MODEL} falhou → fallback ${evalModel}/${evalEffort}:`, glmErr.message);
          const resp = await openai.responses.create({
            model: evalModel, reasoning: { effort: evalEffort },
            max_output_tokens: 64000, instructions: systemPrompt, input: inputTurns,
          });
          full = resp.output_text || '';
          usage = resp.usage || null;
          usageProvider = 'openai';
          usageModel = evalModel;
        }
        if (full) res.write(`data: ${JSON.stringify({ delta: full })}\n\n`);
      } else if (isExerciseAltProvider) {
        // Exercício da Trilha com GLM 5.2 ou Claude Sonnet 5 escolhido pelo
        // admin: mesmo esquema buffered + fallback do Treinamento, mas o
        // fallback aqui é o MINI padrão da própria Trilha (evalModel/evalEffort
        // já apontam pra ele).
        let full = '';
        const altProvider = exerciseModelSpec.provider;
        const altClient = getClientForProvider(altProvider);
        try {
          if (!altClient) throw new Error(`${altProvider} indisponível`);
          if (altProvider === 'anthropic') {
            const args = buildAnthropicArgs({
              model: exerciseModelSpec.model, effort: exerciseModelSpec.effort,
              systemPrompt, turns: inputTurns, maxTokens: 64000,
            });
            const resp = await altClient.messages.create(args);
            full = extractAnthropicText(resp);
            usage = resp.usage || null;
          } else {
            const body = buildChatBody({
              provider: altProvider, model: exerciseModelSpec.model, effort: exerciseModelSpec.effort,
              maxTokens: 64000, messages: [{ role: 'developer', content: systemPrompt }, ...inputTurns],
            });
            const resp = await altClient.chat.completions.create(body);
            full = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
            usage = resp.usage || null;
          }
          if (!full.trim()) throw new Error('resposta vazia');
          usageProvider = altProvider;
          usageModel = exerciseModelSpec.model;
          console.log(`Evaluate (${exerciseModelSpec.model} · trilha)`);
        } catch (altErr) {
          console.error(`[evaluate trilha] ${exerciseModelSpec.model} falhou → fallback ${evalModel}/${evalEffort}:`, altErr.message);
          const resp = await openai.responses.create({
            model: evalModel, reasoning: { effort: evalEffort },
            max_output_tokens: 64000, instructions: systemPrompt, input: inputTurns,
          });
          full = resp.output_text || '';
          usage = resp.usage || null;
          usageProvider = 'openai';
          usageModel = evalModel;
        }
        if (full) res.write(`data: ${JSON.stringify({ delta: full })}\n\n`);
      } else {
        const stream = await openai.responses.create({
          model: evalModel,
          // Exercício (mini/5.5): só effort, sem summary — o resumo de raciocínio
          // nunca vai pro aluno e evita qualquer incompatibilidade do mini com summary.
          reasoning: isExercise ? { effort: evalEffort } : { effort: evalEffort, summary: 'auto' },
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
        usageProvider = 'openai';
        usageModel = evalModel;
      }
    } finally {
      clearInterval(heartbeat);
    }
    let normalizedUsage = null;
    if (usage) {
      normalizedUsage = normalizeUsage(usageProvider, usage);
      console.log(
        `Evaluate (${usageModel}${progressionMode ? ' · progressão' + (sidequestActive ? '+sidequest' : '') : (isExercise ? ' · trilha' : (isFreeSim ? ' · treino' : ''))}): cached=${normalizedUsage.cacheRead} in=${normalizedUsage.input} out=${normalizedUsage.output}`,
      );
    }
    // Custo dos Logs da Trilha: só relevante quando isExercise (o cliente
    // acumula e repassa ao salvar o log; fora da Trilha o campo é ignorado).
    if (normalizedUsage) res.write(`data: ${JSON.stringify({ usage: normalizedUsage })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    // Registra uma vez só e reaproveita o mesmo corpo nos dois caminhos, pra o
    // aluno ver o mesmo código independentemente de o stream já ter começado.
    const corpo = falhou(req, err, 'avaliação/evaluate', { extra: { modelo: evalModel } });
    if (res.headersSent) {
      // Stream já começou (status 200 enviado) — reporta o erro pelo próprio SSE.
      try { res.write(`data: ${JSON.stringify(corpo)}\n\n`); } catch {}
      res.end();
    } else {
      res.status(500).json(corpo);
    }
  }
});

// Esquema visual (SVG) OPCIONAL ao final de um exercício da Trilha — só roda
// se o admin ligou imageSchemaEnabled nesse exercício (ver TRILHA_IMAGE_MODELS
// e buildImageSchemaPrompt). O cliente manda a transcrição (messages); a
// observação do admin (imageSchemaPrompt) é injetada AQUI, server-side — nunca
// sai pro aluno, mesma lógica do evaluatorPrompt.
app.post('/api/trilha/image-schema', requireAuth, aiLimiter, async (req, res) => {
  const { itemId, messages } = req.body || {};

  // Mesmo gate de custo de IA que a avaliação usa pra visitante.
  if (req.user.role === 'visitor' && !visitorEvaluationEnabled()) {
    return res.status(403).json({ error: 'Não disponível para visitantes no momento.' });
  }
  if (!itemId) return res.status(400).json({ error: 'itemId é obrigatório' });
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }

  const ex = readJSON('exercises.json').find((e) => String(e.id) === String(itemId));
  if (!ex) return res.status(404).json({ error: 'Exercício não encontrado' });
  if (!ex.imageSchemaEnabled) {
    return res.status(400).json({ error: 'Este exercício não tem esquema visual habilitado.' });
  }

  const turns = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
    .filter((m) => m.content);
  if (!turns.length) return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant)' });

  const modelKey = TRILHA_IMAGE_MODELS[ex.imageSchemaModel] ? ex.imageSchemaModel : TRILHA_IMAGE_MODEL_DEFAULT;
  const spec = TRILHA_IMAGE_MODELS[modelKey];
  const systemPrompt = buildImageSchemaPrompt(ex.imageSchemaPrompt);

  const client = getClientForProvider(spec.provider);
  if (!client) {
    return res.status(503).json({ error: `Indisponível: ${spec.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} não configurada.` });
  }

  // SSE por causa do timeout de 100s do Cloudflare — effort 'high' com o
  // histórico inteiro do exercício pode demorar. Igual ao /api/evaluate: o
  // heartbeat segura a conexão; a resposta só sai completa no final (não dá
  // pra validar/extrair um SVG parcial no meio do stream).
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
  res.write(': ok\n\n');
  const heartbeat = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  try {
    let raw = '';
    let rawUsage = null;
    if (spec.provider === 'anthropic') {
      const args = buildAnthropicArgs({ model: spec.model, effort: spec.effort, systemPrompt, turns, maxTokens: 8000 });
      const resp = await client.messages.create(args);
      raw = extractAnthropicText(resp);
      rawUsage = resp.usage || null;
    } else {
      const resp = await client.responses.create({
        model: spec.model, reasoning: { effort: spec.effort },
        max_output_tokens: 16000, instructions: systemPrompt, input: turns,
      });
      raw = resp.output_text || '';
      rawUsage = resp.usage || null;
    }
    const svg = extractAndSanitizeSvg(raw);
    if (!svg) throw new Error('esquema visual sem SVG válido na resposta');
    // Custo dos Logs da Trilha: usage normalizado — o cliente só acumula/repassa.
    const usage = normalizeUsage(spec.provider, rawUsage);
    console.log(`Image schema (${spec.model} · trilha): cached=${usage.cacheRead} in=${usage.input} out=${usage.output}`);
    res.write(`data: ${JSON.stringify({ svg, usage })}\n\n`);
  } catch (err) {
    const corpo = falhou(req, err, 'trilha/esquema-visual', { extra: { modelo: spec.model } });
    try { res.write(`data: ${JSON.stringify(corpo)}\n\n`); } catch {}
  } finally {
    clearInterval(heartbeat);
  }
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

// ============================================================================
// PROCESSO SELETIVO — avaliação externa individual por link fixo + role avaliador
// ----------------------------------------------------------------------------
// Um link fixo público (/processo-seletivo), protegido por senha compartilhada,
// pelo qual candidatos externos (sem conta, como o visitante) fazem UMA simulação.
// A avaliação/nota/feedback rodam 100% no servidor e NUNCA voltam ao candidato —
// só o agradecimento. O avaliador (role 'evaluator') acompanha por Dashboard +
// Logs de avaliações. O padrão de "sessão externa por link" espelha o Duelo.
// ============================================================================
// Senha do processo seletivo. É deliberadamente fácil — vai por WhatsApp pro
// candidato e só destrava um formulário público; não protege dado sensível.
// O que a protege de força bruta é o selecaoLimiter (agora chaveado por IP real).
const SELECAO_PASSWORD = process.env.SELECAO_PASSWORD || 'allos01';

// Comparação em tempo constante: com `!==`, o tempo de resposta vaza quantos
// caracteres iniciais bateram. Não é o vetor mais provável aqui, mas custa 4 linhas.
function senhaSelecaoConfere(entrada) {
  const a = Buffer.from(String(entrada == null ? '' : entrada), 'utf8');
  const b = Buffer.from(SELECAO_PASSWORD, 'utf8');
  // timingSafeEqual exige buffers do mesmo tamanho; compara contra si mesmo
  // pra não responder mais rápido só porque o comprimento difere.
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}
const SELECTION_LOG_TTL_DAYS = 15; // regra "1 avaliação por WhatsApp a cada 15 dias"
const SELECTION_LOG_TTL_MS = SELECTION_LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
const SELECTION_ACTIVE_THRESHOLD = 40; // nota mínima p/ contar como candidato ATIVO
const SELECAO_TOKEN_TTL = '3h'; // JWT efêmero do candidato
// Modelo/effort do avaliador do seletivo — env dedicado (desacoplado do Treinamento).
// Default cai no SIM (gpt-5.4/medium). Roda via BATCH API (50% off), então o custo
// efetivo fica ~metade do preço de tabela desse modelo.
const OPENAI_SELECAO_MODEL = process.env.OPENAI_SELECAO_MODEL || OPENAI_SIM_MODEL;
const OPENAI_SELECAO_EFFORT = process.env.OPENAI_SELECAO_EFFORT || OPENAI_SIM_EFFORT;
const SELECAO_BATCH_POLL_MS = 3 * 60 * 1000; // frequência do coletor de batches
const SELECAO_MAX_SESSIONS = 6; // máx. de sessões por candidato (igual à Simulação)

const selecaoLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

// WhatsApp normalizado (só dígitos) — chave de deduplicação por pessoa.
function normalizeWhatsapp(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

// Espelha pruneExpiredLogs (logs.json), mas com TTL PRÓPRIO de 15 dias. Chamado
// no boot/6h, na listagem e antes do dedup de WhatsApp. As estatísticas anônimas
// (selection-stats.json) NÃO são podadas — a Dashboard mantém o histórico.
function pruneExpiredSelectionLogs() {
  let logs;
  try { logs = readJSON('selection-logs.json'); } catch { return 0; }
  if (!Array.isArray(logs) || logs.length === 0) return 0;
  const cutoff = Date.now() - SELECTION_LOG_TTL_MS;
  const kept = logs.filter((l) => {
    const t = new Date((l && l.timestamp) || 0).getTime();
    if (!Number.isFinite(t) || t === 0) return true;
    return t >= cutoff;
  });
  if (kept.length === logs.length) return 0;
  writeJSON('selection-logs.json', kept);
  return logs.length - kept.length;
}

// Auth do candidato: JWT role 'candidate' com o characterId sorteado + os dados
// do candidato, tudo ASSINADO (tamper-proof). Isolado do requireAuth central pra
// não mexer na auth testada. O candidato não é persistido em users.json.
function requireCandidate(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'candidate') return res.status(403).json({ error: 'Acesso negado' });
    req.candidate = payload; // { sub, role, characterId, candidate: {...} }
    return next();
  } catch {
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}

// --- Avaliação do candidato via OpenAI BATCH API (50% off) ---------------------
// A avaliação NÃO é síncrona: ela roda em lote assíncrono. O candidato só vê o
// agradecimento; o avaliador lê o resultado depois (o batch volta em até 24h, em
// geral bem antes). Vantagem: metade do preço, mesmo modelo e MESMO effort — sem
// perda de qualidade. Fluxo, todo dirigido pelo estado no próprio log:
//   status 'pending' + sem batchId  → precisa submeter
//   status 'pending' + batchId      → aguardando aquele batch
//   status ativo|rejeitado|erro     → concluído
// O varredor (sweepSelectionBatches) SUBMETE os pendentes e COLETA os prontos.
// Nunca devolve nota/feedback ao candidato; grava só no log + stats anônimos.

// Monta o corpo de uma request /v1/chat/completions p/ o batch (avaliador enxuto
// do seletivo + Bloco 1 do personagem, injetado server-side). O gabarito nunca
// sai pro candidato. Reusa o mesmo helper de mensagens do resto (system→developer).
// Transcrição do seletivo: agrupa por sessão (divisória "═══ SESSÃO N ═══" a cada
// virada) e marca ★ + {comentário} das intervenções destacadas pelo candidato.
function buildSelectionTranscript(messages, patientName) {
  const rows = [];
  let lastSession = null;
  for (const m of (messages || [])) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const s = Number.isFinite(m.session) && m.session >= 1 ? Math.floor(m.session) : 1;
    if (s !== lastSession) { rows.push(`═══════ SESSÃO ${s} ═══════`); lastSession = s; }
    const author = m.role === 'user' ? 'Candidato' : (patientName || 'Paciente');
    const star = m.highlighted ? ' ★' : '';
    const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
    rows.push(`[${author}${star}]\n${m.content}${comment}`);
  }
  return rows.join('\n\n---\n\n');
}

// Partes do input da avaliação do seletivo: o prompt enxuto + o turno do usuário
// (Bloco 1 + transcrição). Usado tanto pelo GLM (chat.completions) quanto pelo
// fallback OpenAI (responses).
function selectionEvalParts(log) {
  const char = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(log.characterId))
    || { id: log.characterId, name: log.characterName || 'Paciente' };
  const transcript = buildSelectionTranscript(log.messages, char.name || 'Paciente');
  const evalUser = {
    role: 'user',
    content: `[LOG DO ATENDIMENTO — pode conter várias sessões com o mesmo paciente]\nPersonagem: ${char.name || 'Paciente'}\nLegenda: "═══ SESSÃO N ═══" separa as sessões (acompanhamento ao longo do tempo — avalie também a evolução entre elas); "★" marca uma intervenção que o próprio candidato destacou e a linha "{...}" logo abaixo é a justificativa dele.\n\n${transcript}`,
  };
  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: char.id } });
  const inputTurns = withBloco1([evalUser], bloco1);
  return { prompt: loadSelecaoEvaluatorPrompt(), inputTurns };
}

// Extrai nota + avaliação limpa do texto do avaliador (mesma régua do resto):
// tira o bloco [notas-supervisor] e calcula a nota em código (scoring.js).
function parseSelectionEval(rawText) {
  const { clean, criteria } = extractSupervisorNotes(rawText || '');
  let score = null;
  if (criteria) {
    const computed = finalScoreFromCriteria(criteria);
    if (computed !== null) score = computed;
  }
  return { evaluation: clean, criteriaScores: criteria, score };
}

// Cria um File (multipart) a partir do JSONL do batch, sem tocar em disco.
function toBatchFile(jsonl) {
  const O = require('openai');
  const toFile = O.toFile || (O.default && O.default.toFile);
  return toFile(Buffer.from(jsonl, 'utf-8'), 'selecao-batch.jsonl', { type: 'application/jsonl' });
}

let selectionEvalRunning = false;

// Avalia UM log do seletivo, SÍNCRONO, em background: GLM 5.2/high; FALLBACK
// gpt-5.4/medium se o GLM falhar (rate limit/instabilidade). z.ai não tem Batch
// API, então roda direto (1 requisição por candidato). Grava status/score/
// criteriaScores/evaluation (+ o raciocínio, pro avaliador ler) no log + append
// no selection-stats.json. NUNCA volta ao candidato — nem nota, nem raciocínio
// (o /finish já respondeu só o agradecimento).
async function evaluateSelectionSync(log) {
  const { prompt, inputTurns } = selectionEvalParts(log);
  let content = '';
  let reasoning = ''; // raciocínio do avaliador — visível só ao avaliador/admin (de graça: o GLM devolve em reasoning_content)
  try {
    const sProvider = providerForModel(SELECAO_EVAL_MODEL);
    const sClient = getClientForProvider(sProvider);
    if (!sClient) throw new Error(`${sProvider} indisponível`);
    const body = buildChatBody({
      provider: sProvider, model: SELECAO_EVAL_MODEL, effort: SELECAO_EVAL_EFFORT,
      maxTokens: 64000, messages: buildOpenAIMessages(prompt, inputTurns),
    });
    const resp = await sClient.chat.completions.create(body);
    const msg = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
    content = msg.content || '';
    reasoning = aiIndependente.extractReasoning(msg); // GLM (z.ai) devolve o thinking aqui, sem custo extra
    if (!content.trim()) throw new Error('resposta vazia');
  } catch (glmErr) {
    console.error(`[selecao] ${SELECAO_EVAL_MODEL} falhou → fallback ${OPENAI_SIM_MODEL}/${OPENAI_SIM_EFFORT}:`, glmErr.message);
    try {
      const openai = getOpenAI();
      if (!openai) throw new Error('OpenAI indisponível');
      // summary:'auto' pede o RESUMO do raciocínio (gpt-5.4 emite; o "mini" não).
      const resp = await openai.responses.create({
        model: OPENAI_SIM_MODEL, reasoning: { effort: OPENAI_SIM_EFFORT, summary: 'auto' },
        max_output_tokens: 64000, instructions: prompt, input: inputTurns,
      });
      content = resp.output_text || '';
      reasoning = aiIndependente.extractResponsesReasoning(resp);
    } catch (fbErr) {
      console.error('[selecao] fallback também falhou:', fbErr.message);
    }
  }
  const { evaluation, criteriaScores, score } = parseSelectionEval(content);
  const st = score == null ? 'erro' : (score >= SELECTION_ACTIVE_THRESHOLD ? 'ativo' : 'rejeitado');
  let appended = null;
  await withFileLock('selection-logs.json', async () => {
    const arr = readJSON('selection-logs.json');
    const i = arr.findIndex((l) => l && l.id === log.id);
    if (i === -1) return;
    arr[i] = {
      ...arr[i], status: st, score, criteriaScores,
      evaluation: clampStr(evaluation, LOG_MAX_EVAL_LEN),
      reasoning: clampStr(reasoning, LOG_MAX_EVAL_LEN),
    };
    if (score != null) appended = { timestamp: arr[i].timestamp, score, status: st };
    writeJSON('selection-logs.json', arr);
  });
  if (appended) {
    await withFileLock('selection-stats.json', async () => {
      const stats = readJSON('selection-stats.json');
      stats.push(appended);
      writeJSON('selection-stats.json', stats);
    });
  }
  // TRI: o candidato entra com rating fixo 50 e o personagem aprende. Depois de
  // persistir a nota, e só com nota válida — avaliação com erro não é sinal.
  if (score != null) {
    await registrarTriAnonimo('selecao', log.characterId, score);
  }
  console.log(`[selecao] avaliado ${log.id}: nota=${score} status=${st}`);
}

// Reprocessa logs 'pending' que sobraram (ex.: restart no meio de uma avaliação).
// Roda no boot + a cada intervalo. Guard reentrante.
async function processPendingSelectionLogs() {
  if (selectionEvalRunning) return;
  selectionEvalRunning = true;
  try {
    const pending = readJSON('selection-logs.json').filter((l) => l && l.status === 'pending');
    for (const log of pending) {
      try { await evaluateSelectionSync(log); } catch (e) { console.error('[selecao] pendente falhou:', e.message); }
    }
  } finally {
    selectionEvalRunning = false;
  }
}

// ============================================================================
// COMPETITIVO — avaliação ASSÍNCRONA via OpenAI Batch API (GPT 5.5 high)
// O aluno finaliza e recebe só um agradecimento; a nota + feedback + MMR entram no
// log dele em até 24h. O log aparece JÁ como 'pendente' em Minhas Sessões (fica em
// logs.json com evaluationPending:true) e é o próprio "job" do batch.
// ============================================================================
function buildCompetitiveEvalBody(log) {
  const char = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(log.itemId));
  const patientName = log.itemTitle || (char && char.name) || 'Paciente';
  const transcript = transcriptFromMessages(log.messages || [], log.userName || 'Aluno', patientName);
  const evalUser = { role: 'user', content: `[LOG DO ATENDIMENTO]\nSessão: Competitivo\nPersonagem: ${patientName}\n\n${transcript}` };
  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: log.itemId } });
  const inputTurns = withBloco1([evalUser], bloco1);
  return {
    model: OPENAI_COMP_MODEL,
    reasoning_effort: OPENAI_COMP_EFFORT,
    max_completion_tokens: 64000,
    messages: buildOpenAIMessages(loadAvaliacaoPrompt(), inputTurns),
  };
}

let competitiveSweepRunning = false;

// Submete os logs competitivos pendentes (evaluationPending && !evalBatchId).
async function submitCompetitiveBatches(openai) {
  const pending = readJSON('logs.json').filter((l) => l && l.mode === 'competitive' && l.evaluationPending && !l.evalBatchId);
  if (!pending.length) return;
  const lines = [];
  const ids = [];
  for (const log of pending) {
    let body;
    try { body = buildCompetitiveEvalBody(log); } catch (e) { console.error('[comp-batch] corpo:', e.message); continue; }
    lines.push(JSON.stringify({ custom_id: log.id, method: 'POST', url: '/v1/chat/completions', body }));
    ids.push(log.id);
  }
  if (!lines.length) return;
  const file = await openai.files.create({ file: await toBatchFile(lines.join('\n') + '\n'), purpose: 'batch' });
  const batch = await openai.batches.create({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' });
  await withFileLock('logs.json', async () => {
    const arr = readJSON('logs.json');
    for (const l of arr) {
      if (ids.includes(l.id) && l.evaluationPending && !l.evalBatchId) { l.evalBatchId = batch.id; l.evalBatchAt = new Date().toISOString(); }
    }
    writeJSON('logs.json', arr);
  });
  console.log(`[comp-batch] submetidos ${ids.length} competitivo(s) no batch ${batch.id}`);
}

// Coleta os batches prontos: grava nota/feedback no log, zera o pending e aplica o MMR.
async function collectCompetitiveBatches(openai) {
  const withBatch = readJSON('logs.json').filter((l) => l && l.evaluationPending && l.evalBatchId);
  if (!withBatch.length) return;
  const batchIds = [...new Set(withBatch.map((l) => l.evalBatchId))];
  for (const bid of batchIds) {
    let batch;
    try { batch = await openai.batches.retrieve(bid); } catch (e) { console.error('[comp-batch] retrieve:', e.message); continue; }

    if (batch.status === 'completed') {
      const results = new Map();
      if (batch.output_file_id) {
        const text = await (await openai.files.content(batch.output_file_id)).text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const out = obj.response && obj.response.body && obj.response.body.choices;
            results.set(obj.custom_id, (out && out[0] && out[0].message && out[0].message.content) || '');
          } catch {}
        }
      }
      await withFileLock('logs.json', async () => {
        const arr = readJSON('logs.json');
        let mmr = null; let mmrChanged = false;
        for (const l of arr) {
          if (l.evalBatchId !== bid || !l.evaluationPending) continue;
          if (results.has(l.id) && results.get(l.id)) {
            const { evaluation, criteriaScores, score } = parseSelectionEval(results.get(l.id));
            l.evaluation = clampStr(evaluation, LOG_MAX_EVAL_LEN);
            l.criteriaScores = criteriaScores;
            l.score = score;
            l.evaluationPending = false;
            // MMR (mesmo gate do /api/logs): nota numérica + itemId + usuário real.
            if (Number.isFinite(score) && l.itemId && l.userId && !String(l.userId).startsWith('visitor-')) {
              if (!mmr) mmr = readMMR();
              const { player, character, result } = mmrEngine.updateMatch(mmr.players[l.userId], mmr.characters[l.itemId], score);
              mmr.players[l.userId] = player; mmr.characters[l.itemId] = character; mmrChanged = true;
              if (!result.calibratingBefore) bumpTriFonte(mmr, l.itemId, 'competitivo');
              l.mmrBefore = Math.round(result.P_before); l.mmrAfter = Math.round(result.P_after);
            }
          } else {
            l.evaluationPending = false; l.evalError = 'sem resultado no batch';
          }
        }
        writeJSON('logs.json', arr);
        if (mmrChanged) writeMMR(mmr);
      });
      console.log(`[comp-batch] batch ${bid} completo: ${results.size} avaliado(s)`);
    } else if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batch.status)) {
      await withFileLock('logs.json', async () => {
        const arr = readJSON('logs.json');
        for (const l of arr) { if (l.evalBatchId === bid && l.evaluationPending) { l.evaluationPending = false; l.evalError = `batch ${batch.status}`; } }
        writeJSON('logs.json', arr);
      });
      console.log(`[comp-batch] batch ${bid} ${batch.status} — competitivo(s) marcados com erro`);
    }
  }
}

async function sweepCompetitiveBatches() {
  if (competitiveSweepRunning) return;
  const openai = getOpenAI();
  if (!openai) return;
  competitiveSweepRunning = true;
  try {
    await collectCompetitiveBatches(openai);
    await submitCompetitiveBatches(openai);
  } catch (e) {
    console.error('[comp-batch] sweep erro:', e.message);
  } finally {
    competitiveSweepRunning = false;
  }
}

// POST /api/competitive/finish — salva o log competitivo PENDENTE em logs.json e
// dispara o batch. Responde na hora (o aluno vê só o agradecimento; nota em 24h).
app.post('/api/competitive/finish', requireAuth, writeLimiter, async (req, res) => {
  if (req.user.role === 'visitor') return res.status(403).json({ error: 'Competitivo não disponível para visitantes.' });
  const b = req.body || {};
  const itemId = b.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId é obrigatório.' });
  const rawMessages = Array.isArray(b.messages) ? b.messages : [];
  if (!rawMessages.length) return res.status(400).json({ error: 'Sessão sem mensagens.' });
  const cleanMessages = rawMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(0, LOG_MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: clampStr(m.content, LOG_MAX_MESSAGE_LEN), highlighted: !!m.highlighted, comment: clampStr(m.comment, 2000) }));
  const freeChar = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(itemId));
  const log = {
    id: 'log' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    timestamp: new Date().toISOString(),
    type: 'freeplay',
    mode: 'competitive',
    itemId,
    itemTitle: clampStr(b.itemTitle || (freeChar && freeChar.name) || '', LOG_MAX_TITLE),
    durationSeconds: Number.isFinite(b.durationSeconds) ? Math.max(0, Math.floor(b.durationSeconds)) : 0,
    score: null,
    criteriaScores: null,
    evaluation: '',
    evaluationPending: true,
    evalBatchId: null,
    messages: cleanMessages,
    userId: req.user.id,
    userName: req.user.name,
  };
  await withFileLock('logs.json', async () => {
    const arr = readJSON('logs.json');
    arr.push(log);
    writeJSON('logs.json', arr);
  });
  // Responde na hora — o aluno vê só o agradecimento ("nota em até 24h").
  res.json({ ok: true, pending: true, logId: log.id });
  // Dispara o batch já (submete este log). O collect roda no boot + intervalo.
  sweepCompetitiveBatches().catch(() => {});
});

// 1) Senha — só destrava a UI do formulário. A senha é revalidada no /iniciar.
app.post('/api/selecao/senha', selecaoLimiter, (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (!senhaSelecaoConfere(pw)) return res.status(401).json({ error: 'Senha incorreta.' });
  res.json({ ok: true });
});

// 2) Iniciar — valida senha + campos + termo; dedup 15 dias por WhatsApp; sorteia
// personagem do Treinamento; emite o JWT do candidato com o characterId + dados.
app.post('/api/selecao/iniciar', selecaoLimiter, (req, res) => {
  const b = req.body || {};
  if (!senhaSelecaoConfere(b.password)) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  const nome = clampStr(b.nome, 200).trim();
  const email = clampStr(b.email, 200).trim();
  const whatsapp = clampStr(b.whatsapp, 40).trim();
  const faculdade = clampStr(b.faculdade, 200).trim();
  const periodo = clampStr(b.periodo, 100).trim();
  if (!nome || !email || !whatsapp || !faculdade || !periodo) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }
  if (b.consent !== true) {
    return res.status(400).json({ error: 'É necessário aceitar o termo de consentimento.' });
  }
  const wa = normalizeWhatsapp(whatsapp);
  if (wa.length < 10) {
    return res.status(400).json({ error: 'Informe um número de WhatsApp válido, com DDD.' });
  }

  // Dedup: 1 avaliação por WhatsApp a cada 15 dias. Baseado nos logs de seleção
  // (que duram 15 dias) + checagem explícita de tempo, pra não depender do prune.
  pruneExpiredSelectionLogs();
  const logs = readJSON('selection-logs.json');
  const lastTs = logs
    .filter((l) => l && normalizeWhatsapp(l.candidate && l.candidate.whatsapp) === wa)
    .map((l) => new Date(l.timestamp || 0).getTime())
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, c) => c - a)[0];
  if (lastTs) {
    const daysLeft = Math.max(1, Math.ceil((lastTs + SELECTION_LOG_TTL_MS - Date.now()) / (24 * 60 * 60 * 1000)));
    return res.status(403).json({
      error: `Ainda faltam ${daysLeft} dias para você tentar realizar a avaliação novamente`,
      daysLeft,
    });
  }

  // Personagem sorteado a cada início (os mesmos do modo Treinamento).
  const chars = readJSON('freeplay-characters.json');
  if (!Array.isArray(chars) || chars.length === 0) {
    return res.status(500).json({ error: 'Nenhum personagem disponível no momento.' });
  }
  const c = chars[Math.floor(Math.random() * chars.length)];

  const candidate = { nome, email, whatsapp, faculdade, periodo };
  const sessionId = 'sel-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  const token = jwt.sign(
    { sub: sessionId, role: 'candidate', characterId: String(c.id), candidate },
    JWT_SECRET,
    { expiresIn: SELECAO_TOKEN_TTL },
  );
  // NUNCA devolve specificInstruction/evaluationCriteria — só o público do card.
  res.json({
    token,
    character: {
      id: String(c.id),
      name: c.name,
      age: c.age,
      description: c.description,
      photoIcon: c.photoIcon || '',
      photoFull: c.photoFull || '',
    },
  });
});

// 3) Chat do candidato (paciente). O characterId vem do JWT (candidato NÃO escolhe
// o caso). Monta o prompt do paciente server-side, igual ao /api/chat freeplay.
app.post('/api/selecao/chat', requireCandidate, aiLimiter, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages deve ser uma lista' });
  }
  const c = readJSON('freeplay-characters.json').find((x) => String(x.id) === String(req.candidate.characterId));
  if (!c) return res.status(404).json({ error: 'Personagem não encontrado' });
  const openai = getOpenAI();
  if (!openai) {
    return res.json({
      role: 'assistant',
      content: '[Modo demonstração — API Key não configurada] Olá, sou o personagem desta simulação. Como posso ajudá-lo nesta sessão?',
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
    const { text, usage } = await openaiComplete({
      openai,
      model: PATIENT_MODEL,
      effort: PATIENT_EFFORT,
      systemPrompt: buildFreeplayPrompt(c.specificInstruction),
      messages,
      maxCompletionTokens: 1500 + 2000,
    });
    logOpenAIUsage('Seleção paciente', PATIENT_MODEL, usage);
    res.json({ role: 'assistant', content: text });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'seletivo/chat-paciente',
      { extra: { modelo: PATIENT_MODEL } }));
  }
});

// 4) Finalizar — grava o log completo (avaliação pendente) e responde JÁ com o
// agradecimento. A avaliação roda depois via BATCH API (assíncrona). Preserva
// destaque(★)/comentário e o nº de sessão de cada mensagem, pra ver a evolução do
// candidato ao longo do acompanhamento. Nunca devolve nota/feedback ao candidato.
app.post('/api/selecao/finish', requireCandidate, async (req, res) => {
  const b = req.body || {};
  const sessionId = req.candidate.sub;
  const cleanMessages = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(0, LOG_MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: clampStr(m.content, LOG_MAX_MESSAGE_LEN),
      highlighted: !!m.highlighted,
      comment: clampStr(m.comment, 2000),
      session: Number.isFinite(m.session) && m.session >= 1 ? Math.min(Math.floor(m.session), SELECAO_MAX_SESSIONS) : 1,
    }));
  const sessionCount = cleanMessages.reduce((mx, m) => Math.max(mx, m.session || 1), 1);
  const durationSeconds = Number.isFinite(b.durationSeconds) ? Math.max(0, Math.floor(b.durationSeconds)) : 0;

  const chars = readJSON('freeplay-characters.json');
  const c = chars.find((x) => String(x.id) === String(req.candidate.characterId))
    || { id: req.candidate.characterId, name: 'Paciente' };

  // Idempotência: um segundo finish da mesma sessão não regrava (nem duplica stats).
  const existing = readJSON('selection-logs.json');
  if (existing.some((l) => l && l.sessionId === sessionId)) {
    return res.json({ ok: true });
  }

  const timestamp = new Date().toISOString();
  const log = {
    id: 'sellog-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    sessionId,
    timestamp,
    candidate: req.candidate.candidate || {},
    characterId: String(c.id),
    characterName: c.name || 'Paciente',
    durationSeconds,
    sessionCount,
    messages: cleanMessages,
    status: 'pending', // pending → ativo | rejeitado | erro
    score: null,
    criteriaScores: null,
    evaluation: '',
  };
  await withFileLock('selection-logs.json', async () => {
    const arr = readJSON('selection-logs.json');
    if (arr.some((l) => l && l.sessionId === sessionId)) return;
    arr.push(log);
    writeJSON('selection-logs.json', arr);
  });

  // Responde imediatamente — o candidato vê o agradecimento sem esperar a IA.
  res.json({ ok: true });

  // Avaliação SÍNCRONA no GLM (background, fire-and-forget). z.ai não tem Batch
  // API; roda direto e grava o resultado no log do avaliador. Nunca volta ao
  // candidato. Se sobrar 'pending' (crash), o processPendingSelectionLogs recupera.
  evaluateSelectionSync(log).catch((e) => console.error('[selecao] avaliação falhou:', e.message));
});

// 5) Logs de avaliações — avaliador/admin. Poda os expirados (15d) e lista todos.
app.get('/api/selecao/logs', requireAuth, requireRole('evaluator', 'admin'), (req, res) => {
  pruneExpiredSelectionLogs();
  const logs = readJSON('selection-logs.json');
  const sorted = [...logs].sort((a, c) => new Date(c.timestamp || 0) - new Date(a.timestamp || 0));
  res.json(sorted.map((l) => ({
    ...l,
    expiresAt: l.timestamp ? new Date(new Date(l.timestamp).getTime() + SELECTION_LOG_TTL_MS).toISOString() : null,
  })));
});

// 6) Dashboard — avaliador/admin. Agrega selection-stats.json (anônimo, permanente)
// no período pedido: ativos (nota ≥ 40), rejeitados (nota < 40) e média das notas.
app.get('/api/selecao/dashboard', requireAuth, requireRole('evaluator', 'admin'), (req, res) => {
  const range = ['day', 'week', 'month', 'year'].includes(req.query.range) ? req.query.range : 'month';
  const spanMs = ({ day: 1, week: 7, month: 30, year: 365 }[range]) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - spanMs;
  const stats = readJSON('selection-stats.json').filter((s) => {
    const t = new Date((s && s.timestamp) || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  const scored = stats.filter((s) => Number.isFinite(Number(s.score)));
  const activeCount = scored.filter((s) => Number(s.score) >= SELECTION_ACTIVE_THRESHOLD).length;
  const rejectedCount = scored.filter((s) => Number(s.score) < SELECTION_ACTIVE_THRESHOLD).length;
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, s) => a + Number(s.score), 0) / scored.length)
    : null;
  res.json({ range, total: scored.length, activeCount, rejectedCount, avgScore, threshold: SELECTION_ACTIVE_THRESHOLD });
});

// 6b) TRI dos personagens — quais casos são mais difíceis. A dificuldade é
// ÚNICA e vem de todas as fontes juntas (competitivo + seletivo + visitante):
// é assim que o sistema separa "respondente fraco" de "personagem difícil".
// A dashboard do seletivo é só onde isso é lido primeiro.
//
// Cumulativo, sem recorte por período: a estimativa se acumula atendimento a
// atendimento, e filtrar por data devolveria um número diferente do que o
// engine está de fato usando.
app.get('/api/tri/personagens', requireAuth, requireRole('evaluator', 'admin'), (req, res) => {
  const mmr = readMMR();
  const fontes = mmr.charSources || {};
  const catalogo = readJSON('freeplay-characters.json');

  const characters = catalogo.map((c) => {
    const st = mmr.characters[String(c.id)];
    const n = (st && Number.isFinite(st.n_D)) ? st.n_D : 0;
    const avg = st ? mmrEngine.characterAvgScore(st) : null;
    return {
      id: String(c.id),
      name: c.name || 'Personagem',
      difficulty: mmrEngine.characterDifficulty(st),
      // Distância da baseline: diz se o personagem já se afastou do ponto de
      // partida ou se ainda está em 50 por falta de dado.
      delta: Math.round((st && Number.isFinite(st.D) ? st.D : mmrEngine.D0) - mmrEngine.D0),
      n,
      avgScore: avg == null ? null : Math.round(avg),
      // De onde vieram os atendimentos deste personagem.
      fontes: fontes[String(c.id)] || {},
      // Só a partir de CHAR_MATURE_AT o engine liga a regressão; abaixo disso o
      // número é indicativo e a tela precisa dizer isso.
      madura: n >= mmrEngine.CHAR_MATURE_AT,
    };
  });

  // Mais difícil primeiro. Personagem sem nenhum atendimento vai pro fim: está
  // em 50 por ausência de dado, não por ser mediano.
  characters.sort((a, b) => (b.n > 0) - (a.n > 0) || b.difficulty - a.difficulty);

  // Rating aprendido de cada população anônima — é o número que mostra o
  // sistema funcionando: se os candidatos são mais fracos, isto fica < 50 e a
  // dificuldade deixa de ser inflada por eles.
  const populacoes = TRI_POOLS.map((p) => {
    const st = mmr.anonPlayers && mmr.anonPlayers[p];
    return {
      pool: p,
      rating: st ? Math.round(st.P) : mmrEngine.P0,
      n: st ? st.n : 0,
      calibrando: !st || st.n < mmrEngine.CALIBRATION_MATCHES,
      peso: TRI_PESOS[p],
    };
  });

  res.json({
    baseline: mmrEngine.D0,
    min: mmrEngine.D_MIN,
    max: mmrEngine.D_MAX,
    maturaEm: mmrEngine.CHAR_MATURE_AT,
    ratingInicial: mmrEngine.P0,
    totalAtendimentos: characters.reduce((a, c) => a + c.n, 0),
    populacoes,
    characters,
  });
});

// ============================================================================
// AVALIAÇÃO INDEPENDENTE — laboratório de pricing (supervisor/admin)
// ----------------------------------------------------------------------------
// Alterna PROMPT (v16-2 / v18-25 / pipeline v25), MODELO (5.5 / 5.4 / 5.4-mini) e
// EFFORT (low/medium/high); roda SÍNCRONO ou via BATCH API (50% off) com fila.
// Isolado: só LÊ os prompts; não toca simulação, processo seletivo nem os
// avaliadores de produção. Resultado unificado + instrumentação de custo.
// ============================================================================
// Modelos selecionáveis: id pinado + PROVEDOR (openai | glm/z.ai) + efforts
// válidos daquele modelo + se suporta Batch API. GLM (z.ai) só na Independente,
// síncrono (z.ai não expõe Batch API); o caching por prefixo funciona igual.
const AVAL_MODELOS = {
  'gpt-5.5': { id: 'gpt-5.5-2026-04-23', provider: 'openai', efforts: ['low', 'medium', 'high'], batch: true },
  'gpt-5.4': { id: 'gpt-5.4-2026-03-05', provider: 'openai', efforts: ['low', 'medium', 'high'], batch: true },
  'gpt-5.4-mini': { id: 'gpt-5.4-mini-2026-03-17', provider: 'openai', efforts: ['low', 'medium', 'high'], batch: true },
  'glm-5.2': { id: 'glm-5.2', provider: 'glm', efforts: ['disabled', 'high', 'max'], batch: false },
};

// Cliente do GLM (z.ai) — OpenAI-compatível. Base própria + GLM_API_KEY. Usado
// pelos avaliadores de Treinamento/Seletivo, pela Avaliação Independente e pela
// reflexão da Antessala; o resto do app continua no getOpenAI().
function getGLM() {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) return null;
  const OpenAI = require('openai').OpenAI || require('openai').default || require('openai');
  // maxRetries: o SDK reenvia 429/5xx com backoff exponencial (respeita o
  // Retry-After da z.ai). Conta nova tem rate limit apertado, daí a folga.
  return new OpenAI({ apiKey, baseURL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4', maxRetries: 5 });
}
function getClientForProvider(provider) {
  if (provider === 'glm') return getGLM();
  if (provider === 'anthropic') return getAnthropic();
  return getOpenAI();
}

// Roda o avaliador escolhido SÍNCRONO e devolve o resultado unificado.
async function runIndependenteSync({ client, provider, evaluator, model, effort, bloco1, log }) {
  if (evaluator === 'v25') {
    return runAvaliacaoIndependente({ openai: client, provider, bloco1, log, model, effort });
  }
  // GLM (z.ai): chat.completions — devolve o raciocínio em message.reasoning_content.
  if (provider === 'glm') {
    const body = aiIndependente.buildSingleEvalBody({ evaluatorId: evaluator, bloco1, log, model, effort, provider });
    const resp = await client.chat.completions.create(body);
    const msg = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
    console.log(`[aval-usage] GLM ${model} effort=${effort} usage=`, JSON.stringify(resp.usage || null));
    return aiIndependente.finalizeSingle({
      evaluatorId: evaluator,
      text: msg.content || '',
      reasoning: aiIndependente.extractReasoning(msg),
      usage: resp.usage || null,
      model, effort, batch: false,
    });
  }
  // GPT (OpenAI): Responses API em STREAMING pra capturar o RESUMO do raciocínio —
  // mesmo caminho da aba de produção. A OpenAI entrega o resumo nos eventos
  // reasoning_summary_text.delta (no não-streaming ele frequentemente vem vazio).
  // Consumimos o stream no SERVIDOR e devolvemos o resultado montado (sem SSE ao
  // cliente). max_output_tokens é teto (reasoning + saída visível saem dele).
  const args = aiIndependente.buildSingleEvalResponsesArgs({ evaluatorId: evaluator, bloco1, log, model, effort });
  const stream = await client.responses.create({ ...args, stream: true });
  let text = '';
  let reasoning = '';
  let usage = null;
  for await (const ev of stream) {
    if (ev.type === 'response.output_text.delta') {
      if (ev.delta) text += ev.delta;
    } else if (ev.type === 'response.reasoning_summary_text.delta') {
      if (ev.delta) reasoning += ev.delta;
    } else if (ev.type === 'response.reasoning_summary_part.added') {
      if (reasoning) reasoning += '\n\n'; // separa partes do resumo
    } else if (ev.type === 'response.completed') {
      usage = (ev.response && ev.response.usage) || null;
    }
  }
  console.log(`[aval-usage] GPT ${model} effort=${effort} usage=`, JSON.stringify(usage || null));
  return aiIndependente.finalizeSingle({
    evaluatorId: evaluator,
    text,
    reasoning: reasoning.trim(),
    usage,
    model, effort, batch: false,
  });
}

// Resposta/entry unificada (todos os avaliadores). `partes` só v25; `notasDetalhe` só single.
function buildAvalResponse(entry, result) {
  return {
    id: entry ? entry.id : null,
    casoNome: entry ? entry.casoNome : '',
    evaluator: result.evaluator,
    notaFinal: result.notaFinal,
    considerados: result.considerados != null ? result.considerados : null,
    partes: result.partes || null,
    notas: result.notas || null,
    notasDetalhe: result.notasDetalhe || null,
    corpoSintetizador: result.corpoSintetizador || null,
    feedbackAluno: result.feedbackAluno || null,
    reasoning: result.reasoning || null, // raciocínio do supervisor (single; GLM devolve, GPT não)
    instrumentacao: result.instrumentacao || null,
  };
}

// Persiste o resultado em avaliacao-v25.json (store de todos os 3 avaliadores).
async function persistAvaliacaoResult({ user, casoId, casoNome, evaluator, model, effort, batch, result }) {
  const entry = {
    id: 'av25-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    userId: user.id,
    userName: user.name || '',
    casoId, casoNome, evaluator, model, effort, batch: !!batch,
    notaFinal: result.notaFinal,
    considerados: result.considerados != null ? result.considerados : null,
    partes: result.partes || null,
    notas: result.notas || null,
    notasDetalhe: result.notasDetalhe || null,
    corpoSintetizador: result.corpoSintetizador || null,
    feedbackAluno: result.feedbackAluno || null,
    reasoning: result.reasoning || null,
    instrumentacao: result.instrumentacao || null,
  };
  await withFileLock('avaliacao-v25.json', async () => {
    const store = readJSON('avaliacao-v25.json', []);
    store.push(entry);
    writeJSON('avaliacao-v25.json', store);
  });
  return entry;
}

// Enfileira um job em batch: monta as requests (1 p/ single, 14 p/ v25), submete
// à Batch API e grava o job em avaliacao-fila.json (status 'processing').
async function enqueueAvaliacaoBatch({ openai, user, evaluator, model, modelKey, effort, provider, bloco1, log, casoId, casoNome }) {
  const jobId = 'avjob-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  let requests;
  if (evaluator === 'v25') {
    requests = buildV25NodeRequests({ bloco1, log, model, effort, provider }).map((n) => ({
      custom_id: `${jobId}::${n.num}`, method: 'POST', url: '/v1/chat/completions', body: n.body,
    }));
  } else {
    requests = [{
      custom_id: `${jobId}::0`, method: 'POST', url: '/v1/chat/completions',
      body: aiIndependente.buildSingleEvalBody({ evaluatorId: evaluator, bloco1, log, model, effort, provider }),
    }];
  }
  const jsonl = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = await openai.files.create({ file: await toBatchFile(jsonl), purpose: 'batch' });
  const batchObj = await openai.batches.create({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' });

  const job = {
    id: jobId, createdAt: new Date().toISOString(),
    userId: user.id, userName: user.name || '',
    casoId, casoNome, evaluator, model, modelKey, effort, provider, batch: true,
    status: 'processing', batchId: batchObj.id, requestCount: requests.length,
    log, // necessário p/ o sintetizador do v25 no coletor (removido quando termina)
    result: null, error: null,
  };
  await withFileLock('avaliacao-fila.json', async () => {
    const arr = readJSON('avaliacao-fila.json');
    arr.push(job);
    writeJSON('avaliacao-fila.json', arr);
  });
  console.log(`[aval-batch] job ${jobId} (${evaluator}/${model}/${effort}) submetido em batch ${batchObj.id} (${requests.length} req)`);
  return job;
}

async function markAvalJob(jobId, patch) {
  await withFileLock('avaliacao-fila.json', async () => {
    const arr = readJSON('avaliacao-fila.json');
    const i = arr.findIndex((j) => j && j.id === jobId);
    if (i === -1) return;
    arr[i] = { ...arr[i], ...patch };
    if (patch.status === 'completed' || patch.status === 'error') delete arr[i].log; // libera o log grande
    writeJSON('avaliacao-fila.json', arr);
  });
}

// Modo síncrono via JOB LOCAL (não é a Batch API da OpenAI): a chamada ao
// modelo roda em background, fora do ciclo request/response, então a rota
// devolve o jobId na hora e nunca esbarra no timeout de 100s do Cloudflare —
// mesmo se o avaliador demorar bastante (GLM effort high/max, v18-25/v25 com
// prompt grande). O cliente faz polling em /fila igual ao batch real, só que
// aqui não há desconto de 50% nem espera de horas: termina assim que o modelo
// responde. Bug corrigido: antes disso, batch:false fazia `await
// runIndependenteSync` direto na resposta HTTP e o Cloudflare cortava com 524
// antes da origem terminar.
async function enqueueAvaliacaoLocal({ client, provider, user, evaluator, model, modelKey, effort, bloco1, log, casoId, casoNome }) {
  const jobId = 'avjob-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const job = {
    id: jobId, createdAt: new Date().toISOString(),
    userId: user.id, userName: user.name || '',
    casoId, casoNome, evaluator, model, modelKey, effort, provider, batch: false, local: true,
    status: 'processing', result: null, error: null,
  };
  await withFileLock('avaliacao-fila.json', async () => {
    const arr = readJSON('avaliacao-fila.json');
    arr.push(job);
    writeJSON('avaliacao-fila.json', arr);
  });
  runIndependenteSync({ client, provider, evaluator, model, effort, bloco1, log })
    .then(async (result) => {
      const entry = await persistAvaliacaoResult({ user, casoId, casoNome, evaluator, model, effort, batch: false, result });
      await markAvalJob(jobId, { status: 'completed', completedAt: new Date().toISOString(), result: buildAvalResponse(entry, result) });
      console.log(`[aval-local] job ${jobId} (${evaluator}) completo: nota=${result.notaFinal}`);
    })
    .catch(async (e) => {
      // Job assíncrono: ninguém está esperando uma resposta HTTP, então o
      // painel de Logs de Erro é o único lugar onde essa falha aparece.
      registrarErro(null, e, 'avaliação-independente/job-local', { extra: { jobId, evaluator, model, effort } });
      await markAvalJob(jobId, { status: 'error', error: e.message });
    });
  console.log(`[aval-local] job ${jobId} (${evaluator}/${model}/${effort}) iniciado em background`);
  return job;
}

let avalSweepRunning = false;
// Coleta os batches da Avaliação Independente que ficaram prontos.
async function sweepAvaliacaoBatches() {
  if (avalSweepRunning) return;
  const openai = getOpenAI();
  if (!openai) return;
  avalSweepRunning = true;
  try {
    const jobs = readJSON('avaliacao-fila.json').filter((j) => j && j.status === 'processing' && j.batchId);
    for (const job of jobs) {
      const client = getClientForProvider(job.provider || 'openai');
      if (!client) continue; // provedor sem chave configurada
      let batchObj;
      try { batchObj = await client.batches.retrieve(job.batchId); } catch (e) { console.error('[aval-batch] retrieve:', e.message); continue; }

      if (batchObj.status === 'completed') {
        const outputs = new Map(); // sufixo do custom_id → { text, usage }
        if (batchObj.output_file_id) {
          const text = await (await client.files.content(batchObj.output_file_id)).text();
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              const suffix = String(o.custom_id).split('::')[1];
              const body = o.response && o.response.body;
              const msg = (body && body.choices && body.choices[0] && body.choices[0].message) || {};
              outputs.set(suffix, { text: msg.content || '', reasoning: aiIndependente.extractReasoning(msg), usage: (body && body.usage) || null });
            } catch {}
          }
        }
        try {
          let result;
          if (job.evaluator === 'v25') {
            const nodeOutputs = [];
            for (const [suffix, out] of outputs) nodeOutputs.push({ num: Number(suffix), text: out.text, usage: out.usage });
            result = await finalizeV25({ openai: client, provider: job.provider || 'openai', log: job.log, model: job.model, effort: job.effort, nodeOutputs, batch: true });
          } else {
            const out = outputs.get('0') || { text: '', usage: null };
            result = aiIndependente.finalizeSingle({ evaluatorId: job.evaluator, text: out.text, reasoning: out.reasoning, usage: out.usage, model: job.model, effort: job.effort, batch: true });
          }
          const entry = await persistAvaliacaoResult({
            user: { id: job.userId, name: job.userName },
            casoId: job.casoId, casoNome: job.casoNome, evaluator: job.evaluator, model: job.model, effort: job.effort, batch: true, result,
          });
          await markAvalJob(job.id, { status: 'completed', completedAt: new Date().toISOString(), result: buildAvalResponse(entry, result) });
          console.log(`[aval-batch] job ${job.id} (${job.evaluator}) completo: nota=${result.notaFinal}`);
        } catch (e) {
          registrarErro(null, e, 'avaliação-independente/job-batch', { extra: { jobId: job.id, evaluator: job.evaluator, model: job.model } });
          await markAvalJob(job.id, { status: 'error', error: e.message });
        }
      } else if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batchObj.status)) {
        await markAvalJob(job.id, { status: 'error', error: `batch ${batchObj.status}` });
        console.log(`[aval-batch] job ${job.id} ${batchObj.status}`);
      }
      // validating/in_progress/finalizing → segue 'processing', checa na próxima varredura.
    }
  } catch (e) {
    console.error('[aval-batch] sweep erro:', e.message);
  } finally {
    avalSweepRunning = false;
  }
}

app.post('/api/avaliacao-independente', requireAuth, requireRole('supervisor', 'admin'), aiLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const log = clampStr(b.log, 200000).trim();
    const casoId = b.casoId;
    const evaluator = b.evaluator || 'v25';
    const modelKey = b.model || 'gpt-5.5';
    const effort = b.effort || 'medium';
    const batch = b.batch === true;

    if (!log) return res.status(400).json({ error: 'Cole ou envie a transcrição da sessão.' });
    if (!casoId) return res.status(400).json({ error: 'Selecione um caso (necessário para o Bloco 1).' });
    if (!aiIndependente.isValidEvaluator(evaluator)) return res.status(400).json({ error: 'Avaliador inválido.' });
    const modelInfo = AVAL_MODELOS[modelKey];
    if (!modelInfo) return res.status(400).json({ error: 'Modelo inválido (gpt-5.5 | gpt-5.4 | gpt-5.4-mini | glm-5.2).' });
    const model = modelInfo.id;
    const provider = modelInfo.provider;
    if (!modelInfo.efforts.includes(effort)) {
      return res.status(400).json({ error: `Effort inválido para ${modelKey} (${modelInfo.efforts.join(' | ')}).` });
    }
    if (batch && !modelInfo.batch) {
      return res.status(400).json({ error: `Batch não disponível para ${modelKey} (o provedor não expõe Batch API). Rode em modo síncrono — o caching continua ativo.` });
    }

    const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: casoId } });
    if (!bloco1) return res.status(400).json({ error: 'O caso selecionado não tem Bloco 1 (critério de correção) configurado.' });

    const client = getClientForProvider(provider);
    if (!client) {
      const which = provider === 'glm' ? 'GLM_API_KEY (z.ai)' : 'OPENAI_API_KEY';
      return res.status(503).json({ error: `Avaliação independente indisponível: ${which} não configurada.` });
    }

    const freeChar = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(casoId));
    const casoNome = freeChar ? freeChar.name : '';

    if (batch) {
      const job = await enqueueAvaliacaoBatch({ openai: client, user: req.user, evaluator, model, modelKey, effort, provider, bloco1, log, casoId, casoNome });
      return res.json({ queued: true, jobId: job.id, status: job.status });
    }

    // Não-batch: roda como job LOCAL em background (ver enqueueAvaliacaoLocal) —
    // nunca bloqueia a resposta HTTP, então nunca esbarra no timeout do Cloudflare.
    const job = await enqueueAvaliacaoLocal({ client, provider, user: req.user, evaluator, model, modelKey, effort, bloco1, log, casoId, casoNome });
    return res.json({ queued: true, jobId: job.id, status: job.status, local: true });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json(falhou(req, err, 'avaliação-independente'));
    }
  }
});

// Fila de avaliações (jobs em batch). Supervisor vê os próprios; admin vê todos.
app.get('/api/avaliacao-independente/fila', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const jobs = readJSON('avaliacao-fila.json')
    .filter((j) => j && (req.user.role === 'admin' || j.userId === req.user.id))
    .sort((a, c) => new Date(c.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50)
    .map((j) => ({
      id: j.id, createdAt: j.createdAt, completedAt: j.completedAt || null,
      casoNome: j.casoNome, evaluator: j.evaluator, model: j.model, modelKey: j.modelKey,
      effort: j.effort, status: j.status, error: j.error || null,
      result: j.result || null, // já é o buildAvalResponse quando completo
    }));
  res.json(jobs);
});

// ============================================================================
// SIMULAÇÃO INDEPENDENTE — laboratório de pricing do PACIENTE (supervisor/admin)
// ----------------------------------------------------------------------------
// Conversa com o personagem trocando MODELO e EFFORT, mostrando o custo REAL de
// CADA turno em tempo real (a Avaliação Independente só mostra o custo no fim,
// porque lá é uma chamada só). SEM avaliador, sem log, sem gamificação: o
// laboratório é só sobre custo × qualidade da fala do paciente.
// Usa o MESMO prompt do personagem da produção (resolveChatSystemPrompt), então o
// que você lê aqui é o que o aluno leria — com o modelo que você escolheu.
// ============================================================================

// Catálogo dos modelos + preços (fonte única: server/simulacao-independente.js).
app.get('/api/simulacao-independente/modelos', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  res.json({ modelos: simIndependente.simCatalogo(), maxTokens: simIndependente.SIM_MAX_TOKENS });
});

// Cliente do provedor pedido. Anthropic entra SÓ aqui (o resto do app é
// OpenAI/GLM) — é um dos candidatos do teste de custo × qualidade do paciente.
function getClientForSimProvider(provider) {
  if (provider === 'anthropic') return getAnthropic();
  if (provider === 'glm') return getGLM();
  return getOpenAI();
}
function simProviderKeyName(provider) {
  if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (provider === 'glm') return 'GLM_API_KEY (z.ai)';
  return 'OPENAI_API_KEY';
}

app.post('/api/simulacao-independente/chat', requireAuth, requireRole('supervisor', 'admin'), aiLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const casoId = b.casoId;
    const modelKey = b.model;
    const effort = b.effort;

    if (!casoId) return res.status(400).json({ error: 'Selecione o personagem.' });
    if (!simIndependente.isValidSimModel(modelKey)) return res.status(400).json({ error: 'Modelo inválido.' });
    const info = simIndependente.simModelInfo(modelKey);
    if (!info.efforts.includes(effort)) {
      return res.status(400).json({ error: `Effort inválido para ${info.label} (${info.efforts.join(' | ')}).` });
    }

    const turns = simIndependente.normalizeTurns(b.messages);
    if (!turns.length) return res.status(400).json({ error: 'messages não contém turnos válidos (user/assistant).' });
    if (turns[0].role !== 'user') return res.status(400).json({ error: 'A conversa precisa começar com um turno do usuário.' });

    // Prompt do personagem resolvido server-side, igual à produção — o cliente
    // nunca manda systemPrompt.
    const resolved = resolveChatSystemPrompt({ context: { type: 'freeplay', itemId: casoId }, user: req.user });
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const client = getClientForSimProvider(info.provider);
    if (!client) {
      return res.status(503).json({ error: `Indisponível: ${simProviderKeyName(info.provider)} não configurada.` });
    }

    const t0 = Date.now();
    let text = '';
    let usage = null;
    if (info.provider === 'anthropic') {
      const args = simIndependente.buildSimAnthropicArgs({
        model: info.id, effort, systemPrompt: resolved.systemPrompt, turns, thinking: info.thinking,
      });
      const resp = await client.messages.create(args);
      text = simIndependente.extractSimText('anthropic', resp);
      usage = resp.usage || null;
    } else {
      const body = simIndependente.buildSimChatBody({
        provider: info.provider, model: info.id, effort,
        systemPrompt: resolved.systemPrompt, turns, thinking: info.thinking,
      });
      const resp = await client.chat.completions.create(body);
      text = simIndependente.extractSimText(info.provider, resp);
      usage = resp.usage || null;
    }
    const latenciaMs = Date.now() - t0;

    const totais = simIndependente.normalizeSimUsage(info.provider, usage);
    const custo = simIndependente.computeSimCost(modelKey, totais);
    console.log(
      `[sim-indep] ${info.id} effort=${effort} ${latenciaMs}ms in=${totais.input} cacheR=${totais.cacheRead} cacheW=${totais.cacheWrite} out=${totais.output} usd=${custo ? custo.usd.toFixed(6) : 'n/d'}`,
    );

    res.json({
      role: 'assistant',
      content: text,
      turno: {
        modelKey, model: info.id, provider: info.provider, effort, latenciaMs,
        totais, custo, // custo === null quando o modelo não está na tabela de preços
      },
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json(falhou(req, err, 'simulação-independente',
        { extra: { modelo: (req.body && req.body.model) || null, effort: (req.body && req.body.effort) || null } }));
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
    res.status(500).json(falhou(req, err, 'transcrição/whisper',
      { message: '😵‍💫 Não consegui transcrever o áudio. Tente de novo.' }));
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

// Detecta conquistas recém-desbloqueadas (ainda não notificadas) e dispara uma
// notificação in-app para cada uma. Mantém em achievement-unlocks.json o
// registro das já notificadas (por usuário). Na PRIMEIRA vez que vê um usuário,
// só grava a baseline SEM notificar — evita uma enxurrada retroativa de tudo que
// ele já tinha desbloqueado. Idempotente: chamar duas vezes não duplica avisos.
function notifyNewAchievements(userId, unlockedSet, claimedMap = {}) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const store = readJSON('achievement-unlocks.json', {});
  const current = [...unlockedSet];
  const prev = store[userId];
  if (!Array.isArray(prev)) {
    store[userId] = current; // baseline silenciosa na 1ª vez
    writeJSON('achievement-unlocks.json', store);
    return;
  }
  const seen = new Set(prev);
  const fresh = current.filter((id) => !seen.has(id));
  if (!fresh.length) return;
  for (const id of fresh) {
    if (claimedMap[id]) continue; // já resgatada — não há o que avisar
    const def = ACHIEVEMENT_DEFS.find((d) => d.id === id);
    if (!def) continue;
    pushNotification(userId, {
      type: 'achievement_unlocked',
      achievementId: id,
      title: def.title,
      tier: def.tier,
      icon: def.icon,
    });
  }
  store[userId] = current; // tudo que está desbloqueado agora vira "visto"
  writeJSON('achievement-unlocks.json', store);
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
    // Relê e remapeia sob lock (o arquivo pode ter mudado durante a chamada à
    // IA). A IA ficou FORA do lock; aqui só o trecho rápido re-lê→aplica→grava.
    const target = await withFileLock('duels.json', () => {
      const fresh = readDuels();
      const t = fresh.find((d) => d.id === duel.id) || duel;
      if (comp) {
        t.result = {
          winner: comp.winner === 'A' ? 'challenger' : comp.winner === 'B' ? 'opponent' : 'draw',
          scoreChallenger: comp.scoreA,
          scoreOpponent: comp.scoreB,
          criteriaChallenger: comp.criteriaChallenger,
          criteriaOpponent: comp.criteriaOpponent,
          evaluation: evaluationClean,
          evaluatedAt: new Date().toISOString(),
        };
        t.status = 'completed';
        // MMR PvP (só duelo competitivo entre dois usuários cadastrados).
        applyDuelMmr(t, comp);
      } else {
        t.result = { winner: null, scoreChallenger: null, scoreOpponent: null, evaluation: evaluationClean, evaluatedAt: new Date().toISOString(), error: 'Não foi possível extrair as notas da avaliação.' };
        t.status = 'completed';
      }
      t.updatedAt = new Date().toISOString();
      writeDuels(fresh);
      return t;
    });

    // Notifica os dois lados reais com o resultado (visitantes ficam de fora).
    notifyDuelResult(target);
    return res.json(sanitizeDuelForUser(target, req.user));
  } catch (err) {
    const corpo = falhou(req, err, 'duelo/avaliação', { extra: { dueloId: duel.id } });
    await withFileLock('duels.json', () => {
      const fresh = readDuels();
      const t = fresh.find((d) => d.id === duel.id) || duel;
      t.status = 'pending'; // volta a pendente pra permitir retry
      writeDuels(fresh);
    });
    return res.status(500).json(corpo);
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
// título de recompensa daquela entrada do banco).
//
// EXCLUSIVIDADE (regra do dono, 2026-07-31): a missão diária e a sidequest do
// supervisor NUNCA rodam juntas. Sidequest ativa desliga a diária; sem sidequest,
// a diária assume o lugar. O aluno nunca fica sem missão, mas nunca tem as duas.
// Ver resolveTrainingMission — é por lá que todo consumidor deve passar.
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
// Missão diária ATIVA para o usuário: a do dia, se (1) ele não tem sidequest do
// supervisor e (2) ainda não a concluiu. O gate da sidequest está DENTRO daqui de
// propósito: assim nenhum consumidor — presente ou futuro — consegue ligar a
// diária por engano enquanto existe sidequest ativa.
function getActiveDailyMission(userId) {
  if (getActiveSidequest(userId)) return null; // sidequest tem prioridade absoluta
  const dm = getDailyMission();
  if (!dm) return null;
  if (hasCompletedReward(userId, dm.rewardTitleId)) return null;
  return dm;
}

// Missão do Treinamento: UMA ou OUTRA, nunca as duas. Fonte única de verdade —
// prompt do avaliador, conclusão pós-sessão e /api/me/daily-mission passam aqui.
// Devolve { sidequest, daily } com no máximo um dos dois preenchido.
function resolveTrainingMission(userId) {
  const sidequest = getActiveSidequest(userId);
  if (sidequest) return { sidequest, daily: null };
  return { sidequest: null, daily: getActiveDailyMission(userId) };
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
  // Avisa o aluno no sino (com som) que recebeu uma nova sidequest. A missão
  // diária NÃO passa por aqui (é rotação global), então só a atribuída notifica.
  pushNotification(userId, {
    type: 'sidequest_assigned',
    sidequestId: def.id,
    title: def.title,
    rewardTitleLabel: def.rewardTitleLabel,
    assignedByName: req.user.name || req.user.username,
  });
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
// Com sidequest do supervisor ativa a diária fica DESLIGADA (uma ou outra — ver
// resolveTrainingMission): responde mission null + pausedBySidequest, e a tela
// mostra só a sidequest.
app.get('/api/me/daily-mission', requireAuth, (req, res) => {
  if (req.user.role !== 'visitor' && getActiveSidequest(req.user.id)) {
    return res.json({ mission: null, completed: false, pausedBySidequest: true });
  }
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

  const messages = cleanDesafioMessages(body.messages);
  if (!messages.length) {
    return res.status(400).json({ error: 'A sessão precisa ter ao menos uma mensagem.' });
  }

  const isVisitor = req.user.role === 'visitor';

  // Reivindica sob lock: read-check-write serializado (vira Titular se a posição
  // estiver vaga). Sem await dentro do lock — a avaliação demorada roda depois.
  const claim = await withFileLock('desafio.json', () => {
    const data = readDesafio();
    if (data.titulares[char.id]) {
      return { conflict: true, titular: publicTitular(data.titulares[char.id]) };
    }
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
    return { conflict: false, titular: publicTitular(data.titulares[char.id]) };
  });

  if (claim.conflict) {
    return res.status(409).json({
      error: 'Alguém já reivindicou este Titular enquanto você atendia. Vá pra desafiar.',
      titular: claim.titular,
    });
  }

  const titularPublic = claim.titular;

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
    const { error: msgFalha } = falhou(req, err, 'desafio/reivindicar');
    // A reivindicação já foi gravada; só sinaliza que a avaliação falhou.
    try {
      res.write(`data: ${JSON.stringify({
        done: true,
        kind: 'claimed',
        evaluation: '',
        error: `A reivindicação foi registrada, mas a avaliação falhou. ${msgFalha}`,
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
    try { res.write(`data: ${JSON.stringify(falhou(req, err, 'desafio/avaliação'))}\n\n`); } catch {}
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
  // Atualização de estado sob lock: a IA (demorada) já rodou FORA do lock; aqui
  // só o trecho rápido re-lê→aplica→grava o desafio.json.
  newTitular = await withFileLock('desafio.json', () => {
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
      // Histórico de titularidade (Vingança/Destronador): desafiante tomou a
      // posição do titular anterior. Visitante não entra no histórico.
      if (!isVisitor) {
        appendDesafioHistory({ characterId: char.id, characterName: char.name, fromUserId: titular.userId || null, toUserId: req.user.id, reason: 'desafio' });
      }
      return fresh.titulares[char.id];
    }
    // Titular permaneceu: só atualiza lastDefendedAt.
    const fresh = readDesafio();
    if (fresh.titulares[char.id]) {
      fresh.titulares[char.id].lastDefendedAt = new Date().toISOString();
      writeDesafio(fresh);
      return fresh.titulares[char.id];
    }
    return titular;
  });

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

// Digital Asset Links — vincula o app Android (TWA) a esta origem pra que o
// WebView abra em tela cheia, sem a barra do navegador. Dirigido por env vars
// (preenchidas só depois de gerar/assinar o APK): enquanto não configurado,
// responde [] — JSON válido, apenas "nenhum app vinculado ainda".
//   TWA_PACKAGE_NAME              ex: br.org.allos.twa
//   TWA_SHA256_CERT_FINGERPRINTS  fingerprint(s) SHA-256 do certificado de
//                                 assinatura, separados por vírgula (chave de
//                                 upload + a do Play App Signing, se usar Play).
// Precisa vir ANTES do catch-all do SPA (senão devolveria o index.html).
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = process.env.TWA_PACKAGE_NAME;
  const fingerprints = (process.env.TWA_SHA256_CERT_FINGERPRINTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pkg || !fingerprints.length) return res.json([]);
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: pkg,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

// ============================================================
// --- Antessala (pré-supervisão) ---
// O aluno (therapist) monta, antes da supervisão, um "mapa de caso": título,
// objetivo, fatos hierarquizados, saídas clínicas, armadilhas, conceitos e
// direções. Um registro por mapa em antessala.json. O supervisor lê os mapas
// ENTREGUES dos alunos que supervisiona (leitura longitudinal do raciocínio).
//
// Princípio da ferramenta: a IA (endpoint /reflect) age sobre a FORMA do
// pensamento — só faz perguntas maiêuticas, nunca gera conteúdo clínico. Por
// isso o system prompt vive no servidor (server/antessala.js), fora do alcance
// do cliente. Ver briefing-mapa-pre-supervisao.md.
// ============================================================

const ANTESSALA_FILE = 'antessala.json';
// Aviso de política de dados: o mapa fala de um paciente REAL (sem campo de
// identificação). O front orienta a não escrever nome/dado identificável; aqui
// só limitamos tamanho, não conteúdo.
const ANT_MAX_FATOS = 40;
const ANT_MAX_CHILDREN = 200; // variações/armadilhas/conceitos/relações/direções

function antGenId() {
  return crypto.randomBytes(5).toString('hex');
}
function antClampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function antClampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Escrita (criar/editar/entregar/excluir) é restrita a therapist (aluno) e admin
// via requireRole nas rotas — supervisor apenas lê, e o visitante (efêmero) não
// participa (o mapa é longitudinal por aluno).
//
// Leitura de um mapa: o dono (qualquer status), o admin, ou o supervisor do dono
// (só quando o mapa foi entregue). Espelha o escopo por teacherId de /api/logs.
function canReadAntessalaCase(user, c) {
  if (!user || !c) return false;
  if (user.role === 'admin') return true;
  if (c.ownerId === user.id) return true;
  if (user.role === 'supervisor' && c.status === 'delivered') {
    const users = readJSON('users.json');
    const owner = users.find((u) => u.id === c.ownerId);
    return !!(owner && owner.teacherId === user.id);
  }
  return false;
}

// Aceita só a forma conhecida do documento, coagindo tipos, limitando tamanhos e
// descartando referências órfãs (variação de um fato inexistente etc.).
function sanitizeAntessalaDoc(b) {
  b = b && typeof b === 'object' ? b : {};
  const fatos = (Array.isArray(b.fatos) ? b.fatos : []).slice(0, ANT_MAX_FATOS).map((f) => ({
    id: antClampStr(f && f.id, 40) || antGenId(),
    texto: antClampStr(f && f.texto, 1000),
    centralidade: antClampInt(f && f.centralidade, 1, 5, 3),
  }));
  const fatoIds = new Set(fatos.map((f) => f.id));

  const variacoes = (Array.isArray(b.variacoes) ? b.variacoes : []).slice(0, ANT_MAX_CHILDREN)
    .map((v) => ({ id: antClampStr(v && v.id, 40) || antGenId(), fatoId: antClampStr(v && v.fatoId, 40), texto: antClampStr(v && v.texto, 1000) }))
    .filter((v) => fatoIds.has(v.fatoId));
  const varIds = new Set(variacoes.map((v) => v.id));

  const pitfalls = (Array.isArray(b.pitfalls) ? b.pitfalls : []).slice(0, ANT_MAX_CHILDREN)
    .map((p) => ({ id: antClampStr(p && p.id, 40) || antGenId(), variacaoId: antClampStr(p && p.variacaoId, 40), texto: antClampStr(p && p.texto, 1000), flagged: !!(p && p.flagged) }))
    .filter((p) => varIds.has(p.variacaoId));

  const conceitos = (Array.isArray(b.conceitos) ? b.conceitos : []).slice(0, ANT_MAX_CHILDREN)
    .map((c) => ({ id: antClampStr(c && c.id, 40) || antGenId(), fatoId: antClampStr(c && c.fatoId, 40), texto: antClampStr(c && c.texto, 1000), tipo: antClampStr(c && c.tipo, 200) }))
    .filter((c) => fatoIds.has(c.fatoId));

  const relacoes = (Array.isArray(b.relacoes) ? b.relacoes : []).slice(0, ANT_MAX_CHILDREN)
    .map((r) => ({ id: antClampStr(r && r.id, 40) || antGenId(), origem: antClampStr(r && r.origem, 40), destino: antClampStr(r && r.destino, 40), descricao: antClampStr(r && r.descricao, 300) }))
    .filter((r) => fatoIds.has(r.origem) && fatoIds.has(r.destino));

  const direcoes = (Array.isArray(b.direcoes) ? b.direcoes : []).slice(0, ANT_MAX_CHILDREN)
    .map((d) => ({ id: antClampStr(d && d.id, 40) || antGenId(), texto: antClampStr(d && d.texto, 1000) }));

  return {
    titulo: antClampStr(b.titulo, 200),
    business: antClampStr(b.business, 2000),
    fatos, relacoes, variacoes, pitfalls, conceitos, direcoes,
  };
}

// Resumo pra listagens (sem o corpo completo do mapa).
function antessalaSummary(c) {
  return {
    id: c.id,
    ownerId: c.ownerId,
    ownerName: c.ownerName,
    titulo: c.titulo || '',
    status: c.status,
    fatosCount: Array.isArray(c.fatos) ? c.fatos.length : 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    deliveredAt: c.deliveredAt || null,
  };
}

// Modelo da camada de reflexão: GLM 5.2 (z.ai) em effort HIGH, por decisão do
// dono — mesmo avaliador/effort do Treinamento e do Seletivo. Env-overridável
// (trocar p/ 'gpt-*' reverte pro OpenAI; provider derivado do prefixo). GLM 5.2
// aceita disabled|high|max; ficamos no 'high' (não 'max').
const ANTESSALA_MODEL = process.env.ANTESSALA_MODEL || 'glm-5.2';
const ANTESSALA_EFFORT = process.env.ANTESSALA_EFFORT || 'high';

// Chamada de reflexão: GLM 5.2. Se o GLM falhar (rate limit/instabilidade),
// cai no mini da OpenAI pra que o aluno não fique sem as perguntas — mesmo
// padrão de fallback do avaliador de Treinamento. Sem nenhuma chave, devolve
// null (o endpoint responde "IA indisponível" sem quebrar o resto).
async function callAntessalaReflection(system, userText) {
  const provider = providerForModel(ANTESSALA_MODEL);
  const client = getClientForProvider(provider);
  if (client) {
    try {
      const body = buildChatBody({
        provider, model: ANTESSALA_MODEL, effort: ANTESSALA_EFFORT, maxTokens: 8000,
        messages: [{ role: 'developer', content: system }, { role: 'user', content: userText }],
      });
      const resp = await client.chat.completions.create(body);
      const text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '').trim();
      if (text) return text;
      throw new Error('resposta vazia');
    } catch (err) {
      console.error(`[antessala/reflect] ${ANTESSALA_MODEL} falhou → fallback OpenAI mini:`, err.message);
    }
  }
  const openai = getOpenAI();
  if (openai) {
    const { text } = await openaiComplete({
      openai,
      model: OPENAI_EXERCISE_MODEL,
      effort: 'low',
      systemPrompt: system,
      messages: [{ role: 'user', content: userText }],
      maxCompletionTokens: 4000,
    });
    return (text || '').trim();
  }
  return null;
}

// GET /api/antessala — mapas do próprio aluno (resumos, mais recentes primeiro).
app.get('/api/antessala', requireAuth, requireRole('therapist', 'admin'), (req, res) => {
  const all = readJSON(ANTESSALA_FILE, []);
  const mine = all
    .filter((c) => c.ownerId === req.user.id)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  res.json(mine.map(antessalaSummary));
});

// GET /api/antessala/supervisor — mapas ENTREGUES dos alunos supervisionados
// (admin vê todos). Congelados; agrupáveis por aluno no front pra leitura
// longitudinal. Registrado ANTES de /:id.
app.get('/api/antessala/supervisor', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const all = readJSON(ANTESSALA_FILE, []);
  const users = readJSON('users.json');
  let visible;
  if (req.user.role === 'admin') {
    visible = all.filter((c) => c.status === 'delivered');
  } else {
    const myStudents = new Set(
      users.filter((u) => u.role === 'therapist' && u.teacherId === req.user.id).map((u) => u.id),
    );
    visible = all.filter((c) => c.status === 'delivered' && myStudents.has(c.ownerId));
  }
  visible.sort((a, b) => new Date(b.deliveredAt || b.updatedAt || 0) - new Date(a.deliveredAt || a.updatedAt || 0));
  res.json(visible.map(antessalaSummary));
});

// POST /api/antessala/reflect — camada maiêutica. { step, doc } → perguntas.
// O system prompt é montado no servidor (papel travado). Registrado ANTES de /:id.
app.post('/api/antessala/reflect', requireAuth, requireRole('therapist', 'admin'), aiLimiter, async (req, res) => {
  const step = Number(req.body && req.body.step);
  if (!Number.isInteger(step) || step < 1 || step > 7) {
    return res.status(400).json({ error: 'step inválido (1 a 7)' });
  }
  const doc = sanitizeAntessalaDoc(req.body && req.body.doc);
  const { system, userText } = buildAntessalaReflection(step, doc);
  try {
    const text = await callAntessalaReflection(system, userText);
    if (text == null) {
      return res.status(503).json({ error: 'Reflexão indisponível (IA não configurada).' });
    }
    // Só as perguntas (uma por linha) — normaliza tirando marcadores de lista.
    const questions = text
      .split('\n')
      .map((l) => l.replace(/^[-•\d.\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 6);
    res.json({ questions, text });
  } catch (err) {
    console.error('[antessala/reflect]', err.message);
    res.status(502).json({ error: 'Não consegui gerar as perguntas agora. Tente de novo em instantes.' });
  }
});

// POST /api/antessala — cria um mapa novo (rascunho).
app.post('/api/antessala', requireAuth, requireRole('therapist', 'admin'), writeLimiter, async (req, res) => {
  const doc = sanitizeAntessalaDoc(req.body);
  const now = new Date().toISOString();
  const record = {
    id: antGenId() + antGenId(),
    ownerId: req.user.id,
    ownerName: req.user.name || req.user.username || '—',
    ...doc,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    deliveredAt: null,
  };
  await withFileLock(ANTESSALA_FILE, async () => {
    const all = readJSON(ANTESSALA_FILE, []);
    all.push(record);
    writeJSON(ANTESSALA_FILE, all);
  });
  res.status(201).json(record);
});

// GET /api/antessala/:id — mapa completo. Dono (qualquer status), supervisor do
// dono (só entregue) ou admin.
app.get('/api/antessala/:id', requireAuth, (req, res) => {
  const all = readJSON(ANTESSALA_FILE, []);
  const c = all.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Mapa não encontrado' });
  if (!canReadAntessalaCase(req.user, c)) return res.status(403).json({ error: 'Acesso negado' });
  res.json(c);
});

// PUT /api/antessala/:id — atualiza o mapa. Só o dono, e só enquanto rascunho
// (depois de entregue, não é mais editável).
app.put('/api/antessala/:id', requireAuth, requireRole('therapist', 'admin'), writeLimiter, async (req, res) => {
  const doc = sanitizeAntessalaDoc(req.body);
  let out = null;
  let status = 200;
  await withFileLock(ANTESSALA_FILE, async () => {
    const all = readJSON(ANTESSALA_FILE, []);
    const idx = all.findIndex((x) => x.id === req.params.id);
    if (idx === -1) { status = 404; out = { error: 'Mapa não encontrado' }; return; }
    const c = all[idx];
    if (c.ownerId !== req.user.id && req.user.role !== 'admin') { status = 403; out = { error: 'Acesso negado' }; return; }
    if (c.status === 'delivered') { status = 409; out = { error: 'Mapa já entregue — não pode mais ser editado.' }; return; }
    all[idx] = { ...c, ...doc, updatedAt: new Date().toISOString() };
    writeJSON(ANTESSALA_FILE, all);
    out = all[idx];
  });
  res.status(status).json(out);
});

// POST /api/antessala/:id/deliver — entrega para a supervisão (torna o mapa
// não editável).
app.post('/api/antessala/:id/deliver', requireAuth, requireRole('therapist', 'admin'), writeLimiter, async (req, res) => {
  let out = null;
  let status = 200;
  await withFileLock(ANTESSALA_FILE, async () => {
    const all = readJSON(ANTESSALA_FILE, []);
    const idx = all.findIndex((x) => x.id === req.params.id);
    if (idx === -1) { status = 404; out = { error: 'Mapa não encontrado' }; return; }
    const c = all[idx];
    if (c.ownerId !== req.user.id && req.user.role !== 'admin') { status = 403; out = { error: 'Acesso negado' }; return; }
    if (c.status === 'delivered') { out = c; return; } // idempotente
    const now = new Date().toISOString();
    all[idx] = { ...c, status: 'delivered', deliveredAt: now, updatedAt: now };
    writeJSON(ANTESSALA_FILE, all);
    out = all[idx];
  });
  res.status(status).json(out);
});

// DELETE /api/antessala/:id — dono (só rascunho) ou admin (qualquer).
app.delete('/api/antessala/:id', requireAuth, requireRole('therapist', 'admin'), writeLimiter, async (req, res) => {
  let out = null;
  let status = 200;
  await withFileLock(ANTESSALA_FILE, async () => {
    const all = readJSON(ANTESSALA_FILE, []);
    const idx = all.findIndex((x) => x.id === req.params.id);
    if (idx === -1) { status = 404; out = { error: 'Mapa não encontrado' }; return; }
    const c = all[idx];
    const isOwner = c.ownerId === req.user.id;
    const isAdminUser = req.user.role === 'admin';
    if (!isOwner && !isAdminUser) { status = 403; out = { error: 'Acesso negado' }; return; }
    if (c.status === 'delivered' && !isAdminUser) { status = 409; out = { error: 'Mapa já entregue — não pode ser excluído.' }; return; }
    all.splice(idx, 1);
    writeJSON(ANTESSALA_FILE, all);
    out = { ok: true };
  });
  res.status(status).json(out);
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
  const removedSel = pruneExpiredSelectionLogs();
  if (removedSel > 0) console.log(`[selecao] ${removedSel} log(s) de seleção expirado(s) (>${SELECTION_LOG_TTL_DAYS} dias) removido(s) no boot.`);
  setInterval(() => {
    const n = pruneExpiredLogs();
    if (n > 0) console.log(`[logs] ${n} log(s) expirado(s) removido(s).`);
    const ns = pruneExpiredSelectionLogs();
    if (ns > 0) console.log(`[selecao] ${ns} log(s) de seleção expirado(s) removido(s).`);
  }, 6 * 60 * 60 * 1000).unref();

  // Processo Seletivo (GLM síncrono): reprocessa avaliações 'pending' que sobraram
  // de um restart; depois checa periodicamente.
  processPendingSelectionLogs().catch(() => {});
  setInterval(() => { processPendingSelectionLogs().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  // Competitivo (Batch API GPT 5.5): submete os logs pendentes e coleta os prontos.
  sweepCompetitiveBatches().catch(() => {});
  setInterval(() => { sweepCompetitiveBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  // Avaliação Independente (Batch API): coleta os jobs da fila que ficaram prontos.
  sweepAvaliacaoBatches().catch(() => {});
  setInterval(() => { sweepAvaliacaoBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor Allos rodando na porta ${PORT}`));
}

module.exports = app;
