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
const { SEED_DATA_DIR, DATA_DIR, PROMPTS_DIR } = require('./paths');
const { runAvaliacaoIndependente, buildPipelineNodeRequests, finalizePipeline, buildChatBody, clearAssetsCache, estimarTokens } = require('./avaliacao-v25');
const batchFila = require('./batch-fila');
const aiIndependente = require('./avaliacao-independente');
const promptFiles = require('./prompt-files');
const simIndependente = require('./simulacao-independente');
const benchmark = require('./benchmark-simulacao');
const aiModels = require('./ai-models');
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
const webpush = require('web-push');
const contas = require('./cadastro');
const sessionQuota = require('./session-quota');
const mailer = require('./email');
const turnstile = require('./turnstile');

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
//   challenges.cloudflare → captcha do cadastro (Turnstile). Precisa dos TRÊS:
//                          script-src (api.js), frame-src (o desafio roda em
//                          iframe) e connect-src (a validação do widget). Sem
//                          frame-src explícito o iframe cai no default-src
//                          'self' e é bloqueado sem erro visível na tela.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"], // trava clickjacking do painel admin
      'form-action': ["'self'"],
      'script-src': ["'self'", 'https://challenges.cloudflare.com'],
      'script-src-attr': ["'none'"],
      'frame-src': ["'self'", 'https://challenges.cloudflare.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'connect-src': ["'self'", 'https://challenges.cloudflare.com'],
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

// O relatório do benchmark (/benchmarkpaciente) é montado ANTES do CORS de
// propósito, e as rotas são registradas neste router lá embaixo, onde as
// dependências (JWT, limiters) já existem.
//
// Motivo: o helmet manda Referrer-Policy: no-referrer no app inteiro, e pela
// spec do Fetch um form POST partindo de uma página com essa política envia
// `Origin: null`. O allowlist abaixo rejeita esse valor (`new URL('null')`
// lança), então o login pela senha morria com 500 em produção. Como a página é
// mesmo-origem e não expõe API, o caminho certo é o CORS nem ver essa rota —
// e não afrouxar o allowlist pra aceitar `null`, que valeria pra todo mundo.
const benchmarkRouter = express.Router();
app.use('/benchmarkpaciente', benchmarkRouter);

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
// (DATA_DIR/SEED_DATA_DIR vêm de ./paths, compartilhado com avaliacao-independente.js e avaliacao-v25.js.)
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

// PROMPTS_DIR guarda os .md do avaliador/entrevistador — dados sensíveis
// (critérios de nota, gabaritos), por isso NÃO ficam versionados no git.
// Semeia UMA VEZ a partir da cópia local em avaliacao/ e entrevistador/ (que
// continuam existindo em disco, só não versionadas); depois disso o volume
// persistente é a fonte e sobrevive a redeploys mesmo sem os arquivos no git.
// Atualizações subsequentes vão pelas rotas /api/admin/prompts, não por git push.
if (!fs.existsSync(PROMPTS_DIR)) {
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  for (const name of promptFiles.PROMPT_ROOTS) {
    const src = path.join(__dirname, '..', name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(PROMPTS_DIR, name), { recursive: true });
  }
}

// Fotos de paciente enviadas pelo admin ficam no volume persistente (DATA_DIR),
// não no repo — assim sobrevivem a redeploys do Railway. Servidas em
// /patient-photos. (As 6 fotos "de fábrica" continuam vindo de /profiles_icon.)
const PATIENT_PHOTOS_DIR = path.join(DATA_DIR, 'patient-photos');
if (!fs.existsSync(PATIENT_PHOTOS_DIR)) fs.mkdirSync(PATIENT_PHOTOS_DIR, { recursive: true });
app.use('/patient-photos', express.static(PATIENT_PHOTOS_DIR, { maxAge: '7d' }));

// Mesma ideia para o avatar da IA de cada exercício da Trilha ("a bolinha" no
// chat) — o admin escolhe a foto no editor do exercício (AdminExercises).
const EXERCISE_PHOTOS_DIR = path.join(DATA_DIR, 'exercise-photos');
if (!fs.existsSync(EXERCISE_PHOTOS_DIR)) fs.mkdirSync(EXERCISE_PHOTOS_DIR, { recursive: true });
app.use('/exercise-photos', express.static(EXERCISE_PHOTOS_DIR, { maxAge: '7d' }));

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
  // Só conta tentativa que FALHOU. Sem isso, numa faculdade ou clínica atrás de
  // um NAT só, o 11º aluno que digitou a senha CERTA levava "Muitas tentativas".
  // Contra brute-force o que importa é o teto de erros, não o de acertos.
  skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});
// Cadastro público e recuperação de senha: cada request aqui dispara um e-mail
// pela caixa da Allos, que tem cota diária no Exchange Online e reputação de
// domínio a perder. Teto baixo e por IP, além do captcha.
const cadastroLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  // 10 e não 5: numa faculdade a turma toda sai pelo mesmo IP, e 5 trancaria a
  // sexta pessoa da sala. O que realmente segura o abuso aqui é o captcha e a
  // confirmação por e-mail — este teto é só pra conter enxurrada.
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas tentativas de cadastro. Tente novamente mais tarde.' },
});
const emailLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas solicitações. Tente novamente mais tarde.' },
});
// Mesma ideia, para a rota autenticada de troca de e-mail: chaveia por USUÁRIO,
// não por IP — numa clínica ou faculdade o IP é compartilhado, e uma pessoa
// mexendo no e-mail não deve gastar a cota das outras.
const emailAuthLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: 'Muitas solicitações. Tente novamente mais tarde.' },
});
// Consulta de disponibilidade de nome de usuário: sem e-mail no caminho, então
// o teto é generoso (a tela consulta enquanto a pessoa digita), mas existe pra
// não virar ferramenta de varredura da base de usernames.
const checagemLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas consultas. Aguarde um momento.' },
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
// Leitura pública de uma discussão da Comunidade (a única rota do app que
// responde sem sessão nenhuma). Chaveia por IP e é generoso de propósito: um
// link circulando num grupo grande é o uso ESPERADO, e numa faculdade a turma
// toda sai pelo mesmo IP. O teto existe só pra que a rota não vire um
// amplificador barato — cada request lê e parseia o comunidade.json inteiro.
const comunidadePublicaLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
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
// Piso por perfil (8; supervisor e admin 12, porque alcançam dados de TODOS os
// alunos) + composição: 1 letra, 1 número, 1 caractere especial, não conter o
// próprio username, e fora da lista de senhas óbvias. A regra de composição
// nasceu com o cadastro público, mas vale pra todo mundo — seria esquisito o
// aluno que se cadastra sozinho ter senha mais forte que a conta de supervisor
// criada pelo admin.
//
// A implementação é pura e vive em cadastro.js, com teste direto.
const { senhaMinimaPara, validarSenha } = contas;

// --- Atraso progressivo por CONTA nas tentativas de login ---
// O loginLimiter é por IP. Quem tem muitos IPs (botnet, VPN, Tor) ataca uma
// conta específica sem teto nenhum, porque cada IP traz 10 tentativas novas.
// Um contador por username fecha essa brecha.
//
// Por que ATRASO e não bloqueio: bloquear a conta transformaria isso numa arma
// — bastaria errar a senha de um aluno de propósito pra trancá-lo pra fora.
// O atraso encarece o ataque (que precisa de milhares de tentativas) sem
// impedir a pessoa certa de entrar.
//
// A chave é o username NORMALIZADO (minúsculas). Sem isso, alternar maiúsculas
// (`admin`, `Admin`, `ADMIN`) daria um contador de atraso novo a cada variação —
// tentativas de graça pro atacante.
const falhasLogin = new Map(); // usernameLower -> { count, last }
const FALHA_JANELA_MS = 15 * 60 * 1000;
const FALHA_TOLERANCIA = 3;      // as 3 primeiras não atrasam — typo acontece
const FALHA_ATRASO_MAX_MS = 5000;
// Teto de entradas: a chave vem do atacante, e um spray com milhares de
// usernames aleatórios dentro da mesma janela de 15 min faria o Map crescer sem
// limite. Ao estourar, descarta as mais antigas — quem está sob ataque de
// verdade é uma conta só, e essa continua no Map por ser a mais recente.
const FALHA_MAX_ENTRADAS = 10000;

function limparFalhasVelhas() {
  const cutoff = Date.now() - FALHA_JANELA_MS;
  for (const [k, v] of falhasLogin) if (v.last < cutoff) falhasLogin.delete(k);
  if (falhasLogin.size > FALHA_MAX_ENTRADAS) {
    // Map itera em ordem de inserção; as primeiras são as mais antigas.
    const excedente = falhasLogin.size - FALHA_MAX_ENTRADAS;
    let i = 0;
    for (const k of falhasLogin.keys()) {
      if (i++ >= excedente) break;
      falhasLogin.delete(k);
    }
  }
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
console.log('[startup] VAPID_PUBLIC_KEY  =', envDiag('VAPID_PUBLIC_KEY'), '(Web Push)');
console.log('[startup] GRAPH_TENANT_ID    =', envDiag('GRAPH_TENANT_ID'), '(e-mail via Microsoft 365 / Graph)');
console.log('[startup] GRAPH_CLIENT_ID    =', envDiag('GRAPH_CLIENT_ID'));
console.log('[startup] GRAPH_CLIENT_SECRET=', envDiag('GRAPH_CLIENT_SECRET'));
console.log('[startup] MAIL_FROM          =', envDiag('MAIL_FROM'), '→ e-mail', mailer.estaConfigurado() ? 'ATIVO' : 'DESLIGADO (links vão pro stdout)');
console.log('[startup] APP_BASE_URL       =', envDiag('APP_BASE_URL'), '(base dos links de confirmação — sem ela o link sai relativo e não funciona)');
console.log('[startup] TURNSTILE_SITE_KEY =', envDiag('TURNSTILE_SITE_KEY'), '→ captcha', turnstile.estaConfigurado() ? 'ATIVO' : 'DESLIGADO (cadastro aceita sem captcha)');
console.log('[startup] DATA_DIR          =', envDiag('DATA_DIR'), '→ resolved:', DATA_DIR);
console.log('[startup] PORT              =', envDiag('PORT'));
console.log('[startup] env keys count    =', Object.keys(process.env).length);
// Lista nomes de envs que CONTÊM "JWT" ou "SECRET" — pega typos como "jwt_secret" / "JWTSECRET"
const jwtish = Object.keys(process.env).filter((k) => /jwt|secret/i.test(k));
console.log('[startup] env keys com JWT/SECRET no nome:', jwtish.length ? jwtish.join(', ') : '(nenhum)');

// Web Push (VAPID): sem as duas chaves, sendWebPushToUser() vira no-op — o sino
// in-app (notifications.json) continua funcionando normalmente, só não sai
// notificação do SO. Gerar o par com `node -e "console.log(require('web-push').generateVAPIDKeys())"`.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ti@allos.org.br';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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
  // Exercícios (as antigas sidequests) ligados por padrão: quem nunca abriu o
  // Perfil continua recebendo o objetivo no atendimento, como sempre recebeu.
  sidequestsEnabled: true,
  // Abordagem teórica declarada pela pessoa. Campo EM DESENVOLVIMENTO na tela:
  // existe para a pesquisa em psicologia comparada, e por ora só o admin edita.
  abordagem: '',
};

// 'evaluator' (Avaliador) acompanha o Processo Seletivo (Dashboard + Logs de
// avaliações). Conta real criada pelo admin, como as demais.
//
// 'external' (Aluno Externo) é o ÚNICO papel que pode nascer de auto-cadastro
// (POST /api/cadastro + confirmação por e-mail). Todos os outros continuam
// exclusivos do admin. Na prática ele usa a plataforma como o aluno interno:
// a diferença é não pressupor vínculo com a Allos, então nasce sem supervisor
// (teacherId null) — mas o campo continua válido e o admin pode vincular
// depois, e aí a Antessala passa a funcionar pra ele como pra qualquer aluno.
const VALID_ROLES = ['therapist', 'supervisor', 'admin', 'evaluator', 'external'];

// Papéis que a Trilha/Treino tratam como aluno. Usado nas checagens de
// permissão pra não precisar listar os dois papéis em cada ponto.
const ROLES_ALUNO = ['therapist', 'external'];
function isAluno(role) { return ROLES_ALUNO.includes(role); }

function hashPasswordSync(plain) {
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

// Hash descartável contra o qual o login compara quando o usuário NÃO existe,
// pra que os dois caminhos gastem o mesmo tempo (ver POST /api/login). O valor
// em si é irrelevante — nenhuma senha jamais bate com ele.
const HASH_ISCA = hashPasswordSync(crypto.randomBytes(32).toString('hex'));

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

// Migração one-shot para o cadastro público: campos que passaram a ser
// obrigatórios no modelo de conta.
//
//   usernameLower / emailLower — login e checagem de duplicidade passaram a ser
//     case-insensitive. Enquanto só o admin criava conta isso era detalhe; com
//     cadastro aberto, `Admin` seria uma conta LIVRE se a comparação continuasse
//     sensível a maiúsculas (impersonação no ranking, na Comunidade, no Duelo).
//   tokenVersion — permite revogar JWT (ver signToken).
//   emailVerified — contas criadas pelo admin entram como verificadas: o
//     endereço foi digitado por quem já é de confiança. Só o auto-cadastro
//     precisa provar o e-mail por link.
(function migrateContasCadastroPublico() {
  const users = readJSON('users.json');
  let dirty = false;
  const vistos = new Map(); // usernameLower -> username original
  for (const u of users) {
    const lower = contas.normalizeUsername(u.username);
    if (u.usernameLower !== lower) { u.usernameLower = lower; dirty = true; }
    const emailLower = contas.normalizeEmail(u.email);
    if ((u.emailLower || '') !== emailLower) { u.emailLower = emailLower; dirty = true; }
    if (typeof u.tokenVersion !== 'number') { u.tokenVersion = 0; dirty = true; }
    if (typeof u.emailVerified !== 'boolean') { u.emailVerified = !!emailLower; dirty = true; }

    // Colisão pré-existente: duas contas cujos usernames só diferem no caixa.
    // O login de ambas fica ambíguo, então NENHUMA das duas entra (ver
    // acharPorUsernameUnico) — mas o resto da plataforma continua de pé.
    //
    // Isto já foi `process.exit(1)`, e o raio estava errado: duas contas
    // duplicadas derrubavam o app inteiro num loop de restart, e a única tela
    // capaz de renomear uma delas (Administração → Contas) morria junto. Fechar
    // as duas contas é a mesma proteção com o custo proporcional.
    if (vistos.has(lower)) {
      console.error(`[contas] CONFLITO: "${vistos.get(lower)}" e "${u.username}" só diferem em maiúsculas. As duas ficam SEM LOGIN até um admin renomear uma em Administração → Contas.`);
    }
    vistos.set(lower, u.username);
  }
  if (dirty) {
    writeJSON('users.json', users);
    console.log('[migration] contas normalizadas (usernameLower/emailLower/tokenVersion/emailVerified).');
  }
})();

// Busca de usuário por nome, ignorando maiúsculas. Todo lookup de login passa
// por aqui — nunca compare `u.username === entrada` direto.
function acharPorUsername(users, username) {
  const lower = contas.normalizeUsername(username);
  if (!lower) return null;
  return users.find((u) => (u.usernameLower || contas.normalizeUsername(u.username)) === lower) || null;
}

// Como acharPorUsername, mas avisa quando MAIS DE UMA conta responde pelo mesmo
// nome ignorando maiúsculas. Nesse estado não dá pra saber de quem é a senha
// que chegou, então o login das duas é recusado.
//
// A checagem é feita a cada tentativa, e não uma vez no boot: assim, no instante
// em que o admin renomeia uma das contas, a outra volta a entrar — sem restart.
function acharPorUsernameUnico(users, username) {
  const lower = contas.normalizeUsername(username);
  if (!lower) return { user: null, ambiguo: false };
  const achados = users.filter(
    (u) => (u.usernameLower || contas.normalizeUsername(u.username)) === lower,
  );
  return { user: achados[0] || null, ambiguo: achados.length > 1 };
}

function acharPorEmail(users, email) {
  const lower = contas.normalizeEmail(email);
  if (!lower) return null;
  return users.find((u) => (u.emailLower || contas.normalizeEmail(u.email)) === lower) || null;
}

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

// Comunidade: o feed de discussões e a configuração da moderação. Ficam em
// arquivos separados porque a config (avatares + banimentos) é lida em toda
// requisição e escrita só pelo admin — no mesmo arquivo, cada comentário
// reescreveria a lista de banimentos junto.
if (!fs.existsSync(path.join(DATA_DIR, 'comunidade.json'))) {
  writeJSON('comunidade.json', { nextId: 1, discussions: [] });
}
if (!fs.existsSync(path.join(DATA_DIR, 'comunidade-config.json'))) {
  writeJSON('comunidade-config.json', { institutionAvatar: null, visitorAvatars: [], bans: {} });
}

// Assinaturas de Web Push por usuário — { <userId>: [ {endpoint, keys, ua,
// createdAt} ] }. Array porque a mesma pessoa pode assinar em vários
// dispositivos (celular + PC). Cap de 10 por usuário em POST /api/push/subscribe.
if (!fs.existsSync(path.join(DATA_DIR, 'push-subscriptions.json'))) {
  writeJSON('push-subscriptions.json', {});
}

// Sidequests: missões clínicas que o supervisor atribui a um aluno e que viram
// o objetivo principal no Treinamento (avaliadas pelo avaliador de progressão).
//  - bank: catálogo reutilizável de sidequests (definições).
//  - active: { <studentId>: <sidequest atribuída> } — no máx. 1 ativa por aluno.
//  - completed: { <studentId>: [ <sidequest concluída + recompensa> ] }.
// O Competitivo (MMR) ignora sidequests inteiramente.
//
// O ARQUIVO NÃO É VERSIONADO: `active` e `completed` guardam conteúdo de sessão
// de aluno (a justificativa da conclusão descreve o atendimento), e isso não
// pode viver no git. O banco inicial, que é conteúdo autoral do admin e não
// dado de ninguém, mora aqui embaixo e semeia o arquivo no primeiro boot; daí
// em diante o admin edita pela tela de Terapeutas.
const SIDEQUEST_BANK_SEED = [
  {
    id: 'sq-1779721725367-bfdb0b',
    title: 'Sustentar o Silêncio',
    description: 'Em ao menos um momento, sustente o silêncio com excelência, de maneira que o paciente mude a atitude a partir do silêncio sustentado, e isso ajude a progredir com o caso.',
    rewardTitleId: 'qt-sq-1779721725367-bfdb0b',
    rewardTitleLabel: 'Terapeuta Silencioso',
    rewardTitleTier: 'quest',
    createdBy: null,
    createdByName: 'Administrador',
    createdAt: '2026-05-25T15:08:45.367Z',
  },
];
if (!fs.existsSync(path.join(DATA_DIR, 'sidequests.json'))) {
  writeJSON('sidequests.json', { bank: SIDEQUEST_BANK_SEED, active: {}, completed: {} });
}

// Recordes por paciente (👑): mapa { <characterId>: { score, userId, userName,
// userPhoto, at } } com a MAIOR nota já tirada naquele paciente no modo
// COMPETITIVO. Vive fora de logs.json de propósito: os logs expiram em 30 dias
// e o recorde é permanente. Só leitura no front — escrito em POST /api/logs.
if (!fs.existsSync(path.join(DATA_DIR, 'character-records.json'))) {
  writeJSON('character-records.json', {});
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
  if (isAluno(safe.role) && safe.teacherId) {
    try {
      const users = readJSON('users.json');
      const teacher = users.find((t) => t.id === safe.teacherId);
      if (teacher && teacher.name) safe.teacherName = teacher.name;
    } catch {}
  }
  return safe;
}

// `tv` = tokenVersion. Sem ele o JWT era irrevogável: trocar a senha NÃO
// derrubava o token que já tinha vazado, e o atacante ficava dentro por até 7
// dias depois de a pessoa reagir. Agora toda troca/reset de senha incrementa o
// tokenVersion do usuário, e requireAuth recusa qualquer token com o valor
// antigo. É também a peça que um "sair de todos os dispositivos" usaria, se um
// dia essa opção entrar na tela de Perfil.
//
// Tokens emitidos antes desta mudança não têm `tv`, e usuários antigos não têm
// tokenVersion — os dois lados viram 0 na comparação, então ninguém é deslogado
// no deploy.
function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, username: user.username, tv: user.tokenVersion || 0 },
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
    // Revogação: senha trocada (ou "sair de todos os dispositivos") incrementa
    // o tokenVersion, o que invalida na hora todo token já emitido.
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Sessão expirada' });
    }
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
  const chaveFalha = contas.normalizeUsername(username);
  const atraso = SKIP_RATE_LIMIT ? 0 : atrasoLoginMs(chaveFalha);
  if (atraso > 0) await new Promise((r) => setTimeout(r, atraso));

  const users = readJSON('users.json');
  const { user, ambiguo } = acharPorUsernameUnico(users, username);
  // Duas contas com o mesmo nome ignorando maiúsculas: não há como saber de quem
  // é a senha, então nenhuma das duas entra até um admin renomear uma. O bcrypt
  // roda mesmo assim, pra este caminho custar o mesmo que os outros.
  if (ambiguo) {
    await bcrypt.compare(String(password), HASH_ISCA);
    return res.status(409).json({
      error: 'Este nome de usuário está duplicado na base e o acesso está suspenso por segurança. Fale com a administração.',
    });
  }
  // Bcrypt SEMPRE, inclusive quando o usuário não existe — comparando contra um
  // hash-isca. A mensagem de erro já era genérica, mas o relógio entregava quem
  // existe: conta inexistente respondia na hora, conta real esperava o bcrypt
  // (~80ms). Agora os dois caminhos custam o mesmo.
  const ok = user && user.passwordHash
    ? await bcrypt.compare(String(password), user.passwordHash)
    : (await bcrypt.compare(String(password), HASH_ISCA), false);
  if (!ok) {
    registrarFalhaLogin(chaveFalha);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  limparFalhasLogin(chaveFalha); // acertou: zera o contador
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
  const erroSenha = validarSenha(newPassword, req.user.role, req.user.username);
  if (erroSenha) return res.status(400).json({ error: erroSenha.replace('Senha deve', 'Nova senha deve') });
  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash || '');
  // 400, não 401: o cliente (api.js) trata TODO 401 como sessão expirada e
  // desloga na hora (ver onSessionExpired em App.jsx) — 401 é certo pro
  // requireAuth (token inválido), mas aqui só a senha está errada, a sessão
  // continua válida. Achado ao testar a exclusão de conta, que tinha o mesmo
  // bug (ver DELETE /api/me) — corrigido igual aqui e em /api/me/email.
  if (!ok) return res.status(400).json({ error: 'Senha atual incorreta' });
  const users = readJSON('users.json');
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  users[idx].tokenVersion = (users[idx].tokenVersion || 0) + 1;
  writeJSON('users.json', users);
  // O token que o cliente está usando ACABOU de ser invalidado pelo bump acima,
  // senão a própria tela que trocou a senha cairia no 401 do requireAuth.
  const token = signToken(users[idx]);
  if (users[idx].emailLower && users[idx].emailVerified) {
    mailer.enviarAvisoSenhaAlterada({ to: users[idx].email, nome: users[idx].name }).catch(() => {});
  }
  res.json({ ok: true, token });
});

// Exclusão da PRÓPRIA conta. Distinta da exclusão de DADOS (política de
// privacidade): isto aqui derruba o login e some da lista de usuários — os
// logs, conquistas e conversas já gravados continuam em disco, e a exclusão
// deles é sob pedido por e-mail a suporte@allos.org.br (rastro auditável,
// evita que um clique excluam provas de avaliação em disputa).
//
// Exige a senha atual pra uma sessão roubada não conseguir apagar a conta
// sozinha. Bloqueada pra admin (o painel já bloqueia o admin excluir a si
// mesmo, mesma razão: evita lockout) e pra supervisor com alunos vinculados
// (eles ficariam órfãos).
//
// Senha errada aqui é 400, NÃO 401: o cliente (api.js) trata TODO 401 como
// sessão expirada e desloga na hora (ver onSessionExpired em App.jsx) — 401
// faz sentido pro middleware requireAuth (token inválido), mas usado aqui
// derrubaria a sessão de quem só digitou a senha errada tentando confirmar a
// exclusão, quando o esperado é mostrar "senha incorreta" e deixar tentar de
// novo. (/api/me/password e /api/me/email têm o mesmo 401 nesse mesmo lugar —
// bug pré-existente, fora do escopo deste endpoint novo.)
app.delete('/api/me', requireAuth, async (req, res) => {
  if (req.user.isVisitor) {
    return res.status(400).json({ error: 'Sessão de visitante não tem conta para excluir.' });
  }
  if (req.user.role === 'admin') {
    return res.status(400).json({ error: 'Conta de administrador não pode ser autoexcluída — peça a outro admin.' });
  }
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Confirme sua senha atual.' });
  const ok = await bcrypt.compare(String(password), req.user.passwordHash || '');
  if (!ok) return res.status(400).json({ error: 'Senha incorreta.' });

  const users = readJSON('users.json');
  if (req.user.role === 'supervisor') {
    const linked = users.filter((u) => u.teacherId === req.user.id);
    if (linked.length > 0) {
      return res.status(400).json({
        error: `Você tem ${linked.length} aluno(s) vinculado(s). Peça a um administrador para reatribuí-los antes de excluir sua conta.`,
      });
    }
  }
  const idx = users.findIndex((u) => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
  users.splice(idx, 1);
  writeJSON('users.json', users);
  res.json({ ok: true });
});


// ---------------------------------------------------------------------------
// Cadastro público de Aluno Externo
// ---------------------------------------------------------------------------
//
// 'external' é o ÚNICO papel que nasce sem admin. O portão não é o captcha nem
// o rate limit — é a CONFIRMAÇÃO POR E-MAIL: enquanto o link não é clicado, não
// existe usuário nenhum em users.json, só uma pendência descartável.
//
// Anti-enumeração: nome de usuário indisponível a tela PRECISA dizer (é um
// seletor de nome, e a lista de usernames já é pública no ranking). E-mail, não:
// "e-mail já cadastrado" confirmaria pra um estranho que fulano tem conta. Por
// isso a resposta é sempre a mesma, e quem descobre a diferença é o DONO do
// endereço, pelo e-mail que recebe.

const PENDENTES_FILE = 'pending-registrations.json';   // cadastros aguardando confirmação
const TROCAS_EMAIL_FILE = 'email-changes.json';        // trocas de e-mail aguardando confirmação
const RESETS_FILE = 'password-resets.json';            // pedidos de nova senha

const TTL_CONFIRMACAO_MS = 48 * 60 * 60 * 1000; // 48h
const TTL_RESET_MS = 60 * 60 * 1000;            // 1h — janela curta, é o link mais perigoso

// Versão do par termos de uso + política de privacidade aceita no cadastro.
// Registrada em cada consentimento: a LGPD pede saber a QUE texto a pessoa disse
// sim, não só que disse. Ao publicar uma revisão, incremente aqui.
const TERMOS_VERSAO = process.env.TERMOS_VERSAO || '1';

// Interruptor de emergência: se o cadastro virar alvo de abuso, desligue pela
// env sem precisar de deploy de código.
const CADASTRO_ABERTO = process.env.CADASTRO_EXTERNO_ABERTO !== 'false';

// URLs dos documentos legais. Por padrão apontam para as páginas dentro do
// próprio app (client/src/pages/TermosDeUso.jsx e PoliticaPrivacidade.jsx) —
// caminho relativo, então funciona em qualquer domínio que sirva o app. As
// envs seguem existindo pra sobrescrever com um link externo (ex.: PDF
// hospedado fora), sem precisar de deploy de código.
const TERMOS_URL = process.env.TERMOS_URL || '/termos-de-uso';
const PRIVACIDADE_URL = process.env.PRIVACIDADE_URL || '/politica-de-privacidade';

// Toda leitura já poda o que venceu — os três arquivos são pequenos e
// reescritos inteiros, então não precisa de rotina de limpeza agendada.
function lerPendencias(file) {
  return contas.removerExpirados(readJSON(file, []));
}

// Configuração pública consumida pelo cliente no boot. Fica fora do build do
// Vite de propósito: acoplar a site key do captcha ao build significa rebuild
// toda vez que a chave muda, e é o tipo de coisa que quebra no pior momento.
app.get('/api/config', (req, res) => {
  res.json({
    cadastroAberto: CADASTRO_ABERTO,
    turnstileSiteKey: turnstile.siteKey(),
    termosVersao: TERMOS_VERSAO,
    termosUrl: TERMOS_URL,
    privacidadeUrl: PRIVACIDADE_URL,
    origens: contas.ORIGENS,
    // A tela precisa saber se "esqueci minha senha" tem como funcionar: sem
    // e-mail configurado, o link nunca chegaria e o botão só frustaria.
    emailAtivo: mailer.estaConfigurado(),
  });
});

// Disponibilidade do nome de usuário, pra tela avisar enquanto a pessoa digita.
app.get('/api/cadastro/disponibilidade', checagemLimiter, (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!contas.usernameRegex.test(username)) {
    return res.json({ disponivel: false, motivo: 'formato' });
  }
  if (contas.isReservedUsername(username)) {
    return res.json({ disponivel: false, motivo: 'reservado' });
  }
  const lower = contas.normalizeUsername(username);
  const users = readJSON('users.json');
  const pendentes = lerPendencias(PENDENTES_FILE);
  const emUso = !!acharPorUsername(users, username) || pendentes.some((r) => r.usernameLower === lower);
  res.json({ disponivel: !emUso, motivo: emUso ? 'em-uso' : null });
});

app.post('/api/cadastro', cadastroLimiter, async (req, res) => {
  if (!CADASTRO_ABERTO) {
    return res.status(403).json({ error: 'O cadastro está temporariamente fechado.' });
  }

  // Captcha ANTES de qualquer trabalho: é o mais barato de todos os checks e o
  // que descarta bot burro sem tocar em disco.
  const captcha = await turnstile.verificar(req.body && req.body.turnstileToken, clientIp(req));
  if (!captcha.ok) {
    return res.status(400).json({ error: 'Não foi possível validar o captcha. Recarregue a página e tente de novo.' });
  }

  try {
    const resultado = await withFileLock(PENDENTES_FILE, async () => {
      const users = readJSON('users.json');
      const pendentes = lerPendencias(PENDENTES_FILE);

      // Um username pendente também "segura" o nome durante as 48h, senão duas
      // pessoas se cadastrariam com o mesmo nome e a segunda só descobriria na
      // hora de confirmar.
      const usernamesEmUso = new Set([
        ...users.map((u) => u.usernameLower || contas.normalizeUsername(u.username)),
        ...pendentes.map((r) => r.usernameLower),
      ]);

      const { errors, dados } = contas.validarCadastroPayload(req.body, {
        usernamesEmUso,
        termosVersao: TERMOS_VERSAO,
      });
      if (errors.length) return { status: 400, body: { error: errors.join('; ') } };

      // --- A partir daqui a resposta é SEMPRE a mesma (anti-enumeração) ---
      const donoDoEmail = acharPorEmail(users, dados.email);
      if (donoDoEmail) {
        // Nenhuma pendência é criada. Quem descobre que já existe conta é o dono
        // do endereço, pelo e-mail — não quem preencheu o formulário.
        return { status: 200, body: { ok: true }, avisarJaCadastrado: donoDoEmail };
      }

      // Pendência anterior com o mesmo e-mail é SUBSTITUÍDA: o caso comum é a
      // própria pessoa refazendo o cadastro depois de errar o nome de usuário.
      // Não vira brecha porque o link continua indo só pro dono do endereço, e o
      // e-mail diz qual nome de usuário está sendo confirmado.
      const restantes = pendentes.filter((r) => r.emailLower !== dados.email);
      const { token, tokenHash, expiresAt } = contas.novoToken(TTL_CONFIRMACAO_MS);

      restantes.push({
        tokenHash,
        expiresAt,
        criadoEm: new Date().toISOString(),
        username: dados.username,
        usernameLower: dados.usernameLower,
        emailLower: dados.email,
        name: dados.name,
        email: dados.email,
        // Já entra hasheada: uma pendência é um arquivo como outro qualquer, e
        // senha em texto puro em disco não se justifica em nenhuma janela.
        passwordHash: await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS),
        origem: dados.origem,
        consentimento: dados.consentimento,
        updateAllOS: dados.updateAllOS,
        updateAllos: dados.updateAllos,
        ip: clientIp(req),
      });
      writeJSON(PENDENTES_FILE, restantes);

      return { status: 200, body: { ok: true }, enviarConfirmacao: { token, dados } };
    });

    // E-mail FORA do lock: é chamada de rede e seguraria o arquivo por segundos.
    if (resultado.avisarJaCadastrado) {
      mailer.enviarEmailJaCadastrado({
        to: resultado.avisarJaCadastrado.email,
        username: resultado.avisarJaCadastrado.username,
      }).catch(() => {});
    }
    if (resultado.enviarConfirmacao) {
      const { token, dados } = resultado.enviarConfirmacao;
      const envio = await mailer.enviarConfirmacaoCadastro({
        to: dados.email,
        nome: dados.name,
        username: dados.username,
        token,
      });
      if (!envio.ok && !envio.skipped) {
        registrarErro(req, new Error(envio.erro || 'envio falhou'), 'cadastro/email-confirmacao', { status: 200 });
      }
    }
    return res.status(resultado.status).json(resultado.body);
  } catch (err) {
    return res.status(500).json(falhou(req, err, 'cadastro/criar'));
  }
});

// Reenvio do link de confirmação. Resposta genérica pelo mesmo motivo do
// cadastro: não confirma se existe pendência para aquele endereço.
app.post('/api/cadastro/reenviar', emailLimiter, async (req, res) => {
  const email = contas.normalizeEmail(req.body && req.body.email);
  if (!contas.isEmailValido(email)) return res.status(400).json({ error: 'E-mail inválido' });

  try {
    const envio = await withFileLock(PENDENTES_FILE, async () => {
      const pendentes = lerPendencias(PENDENTES_FILE);
      const idx = pendentes.findIndex((r) => r.emailLower === email);
      if (idx === -1) return null;
      // Token NOVO a cada reenvio: o anterior deixa de valer, então um link
      // antigo que tenha vazado (encaminhado, print) morre aqui.
      const { token, tokenHash, expiresAt } = contas.novoToken(TTL_CONFIRMACAO_MS);
      pendentes[idx] = { ...pendentes[idx], tokenHash, expiresAt };
      writeJSON(PENDENTES_FILE, pendentes);
      return { token, nome: pendentes[idx].name, username: pendentes[idx].username, to: pendentes[idx].email };
    });

    if (envio) {
      await mailer.enviarConfirmacaoCadastro({ to: envio.to, nome: envio.nome, username: envio.username, token: envio.token });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'cadastro/reenviar'));
  }
});

// Confirmação do link do e-mail. Atende os DOIS fluxos que mandam esse link
// (cadastro novo e troca de e-mail) porque a tela é a mesma e o token não diz
// de qual tipo é — procura primeiro nas pendências de cadastro, depois nas de
// troca.
// Limiter generoso de propósito: esta rota não envia e-mail, e o token tem 256
// bits de entropia — não existe força bruta a conter. Um teto apertado aqui só
// trancaria a segunda turma de alunos confirmando pelo wi-fi da faculdade.
app.post('/api/confirmar-email', checagemLimiter, async (req, res) => {
  const token = req.body && req.body.token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Link inválido.' });
  }
  const alvo = contas.hashToken(token);
  const INVALIDO = { error: 'Link inválido ou expirado. Peça um novo.' };

  try {
    // --- 1. Cadastro novo ---
    const criado = await withFileLock('users.json', async () => {
      const pendentes = lerPendencias(PENDENTES_FILE);
      const reg = pendentes.find((r) => contas.tokenHashIgual(r.tokenHash, alvo));
      if (!reg) return null;

      const users = readJSON('users.json');
      // Revalida DENTRO do lock: entre o cadastro e o clique no link (até 48h) o
      // admin pode ter criado uma conta com esse mesmo nome ou e-mail.
      if (acharPorUsername(users, reg.username)) {
        return { conflito: 'O nome de usuário escolhido não está mais disponível. Refaça o cadastro com outro nome.' };
      }
      if (acharPorEmail(users, reg.emailLower)) {
        return { conflito: 'Este e-mail já pertence a uma conta. Use "Esqueci minha senha" para entrar.' };
      }

      const novo = {
        id: nextUserId(users),
        username: reg.username,
        usernameLower: reg.usernameLower,
        name: reg.name,
        role: 'external',
        // Nasce sem supervisor. O admin pode vincular depois pela tela de
        // Contas, e aí a Antessala passa a valer pra ele como pra qualquer aluno.
        teacherId: null,
        passwordHash: reg.passwordHash,
        tokenVersion: 0,
        ...DEFAULT_PROFILE,
        email: reg.email,
        emailLower: reg.emailLower,
        emailVerified: true,
        origem: reg.origem,
        consentimento: reg.consentimento,
        updateAllOS: !!reg.updateAllOS,
        updateAllos: !!reg.updateAllos,
        criadoEm: new Date().toISOString(),
      };
      users.push(novo);
      writeJSON('users.json', users);
      // Consome a pendência usada e qualquer outra do mesmo e-mail/nome.
      writeJSON(PENDENTES_FILE, pendentes.filter(
        (r) => r.tokenHash !== reg.tokenHash && r.emailLower !== reg.emailLower && r.usernameLower !== reg.usernameLower
      ));
      return { user: novo };
    });

    if (criado && criado.conflito) return res.status(409).json({ error: criado.conflito });
    if (criado && criado.user) {
      // Entra já logado: a pessoa acabou de provar que é dona do e-mail, mandar
      // digitar a senha de novo agora só adiciona atrito.
      return res.json({
        tipo: 'cadastro',
        token: signToken(criado.user),
        user: publicUser(criado.user),
      });
    }

    // --- 2. Troca de e-mail de uma conta existente ---
    const trocado = await withFileLock('users.json', async () => {
      const trocas = lerPendencias(TROCAS_EMAIL_FILE);
      const reg = trocas.find((r) => contas.tokenHashIgual(r.tokenHash, alvo));
      if (!reg) return null;

      const users = readJSON('users.json');
      const idx = users.findIndex((u) => u.id === reg.userId);
      if (idx === -1) return { conflito: 'Conta não encontrada.' };
      const dono = acharPorEmail(users, reg.emailLower);
      if (dono && dono.id !== reg.userId) {
        return { conflito: 'Este e-mail já pertence a outra conta.' };
      }
      users[idx] = { ...users[idx], email: reg.email, emailLower: reg.emailLower, emailVerified: true };
      writeJSON('users.json', users);
      writeJSON(TROCAS_EMAIL_FILE, trocas.filter((r) => r.userId !== reg.userId));
      return { user: users[idx] };
    });

    if (trocado && trocado.conflito) return res.status(409).json({ error: trocado.conflito });
    if (trocado && trocado.user) {
      return res.json({ tipo: 'troca-email', email: trocado.user.email });
    }

    return res.status(400).json(INVALIDO);
  } catch (err) {
    res.status(500).json(falhou(req, err, 'cadastro/confirmar'));
  }
});

// ---------------------------------------------------------------------------
// Recuperação de senha
// ---------------------------------------------------------------------------

app.post('/api/senha/esqueci', emailLimiter, async (req, res) => {
  const email = contas.normalizeEmail(req.body && req.body.email);
  // 200 mesmo com e-mail malformado seria mentira inútil (não vaza nada dizer
  // que "abc" não é e-mail), então esse caso é 400 normal.
  if (!contas.isEmailValido(email)) return res.status(400).json({ error: 'E-mail inválido' });

  const captcha = await turnstile.verificar(req.body && req.body.turnstileToken, clientIp(req));
  if (!captcha.ok) {
    return res.status(400).json({ error: 'Não foi possível validar o captcha. Recarregue a página e tente de novo.' });
  }

  try {
    const envio = await withFileLock(RESETS_FILE, async () => {
      const users = readJSON('users.json');
      const user = acharPorEmail(users, email);
      // Endereço sem conta: NADA é enviado. É de propósito — o padrão de mandar
      // "não há conta com este e-mail" transformaria a rota num disparador de
      // mensagem para endereços arbitrários, gastando a cota da caixa da Allos e
      // a reputação do domínio. A resposta da API é 200 nos dois casos, então
      // pela API a diferença continua invisível.
      if (!user || !user.emailVerified) return null;
      // Visitante não tem conta; papéis privilegiados também usam este fluxo
      // normalmente — o piso de senha continua sendo o do perfil.

      const resets = contas.removerExpirados(readJSON(RESETS_FILE, []));
      const { token, tokenHash, expiresAt } = contas.novoToken(TTL_RESET_MS);
      // Um pedido por conta: pedir de novo invalida o link anterior.
      const outros = resets.filter((r) => r.userId !== user.id);
      outros.push({ tokenHash, expiresAt, userId: user.id, criadoEm: new Date().toISOString(), ip: clientIp(req) });
      writeJSON(RESETS_FILE, outros);
      return { to: user.email, nome: user.name, token };
    });

    if (envio) {
      await mailer.enviarRedefinicaoSenha(envio);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'senha/esqueci'));
  }
});

app.post('/api/senha/redefinir', emailLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Link inválido.' });
  const alvo = contas.hashToken(token);

  try {
    const feito = await withFileLock('users.json', async () => {
      const resets = contas.removerExpirados(readJSON(RESETS_FILE, []));
      const reg = resets.find((r) => contas.tokenHashIgual(r.tokenHash, alvo));
      if (!reg) return { invalido: true };

      const users = readJSON('users.json');
      const idx = users.findIndex((u) => u.id === reg.userId);
      if (idx === -1) return { invalido: true };

      // Piso e composição pelo perfil e nome de quem está sendo redefinido.
      const erro = validarSenha(newPassword, users[idx].role, users[idx].username);
      if (erro) return { erroSenha: erro };

      users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
      // Derruba todas as sessões: se o motivo do reset foi invasão, o token do
      // invasor tem que morrer junto com a senha dele.
      users[idx].tokenVersion = (users[idx].tokenVersion || 0) + 1;
      writeJSON('users.json', users);
      // Uso único: o link consumido some, e os outros pedidos da mesma conta também.
      writeJSON(RESETS_FILE, resets.filter((r) => r.userId !== reg.userId));
      return { user: users[idx] };
    });

    if (feito.invalido) return res.status(400).json({ error: 'Link inválido ou expirado. Peça um novo.' });
    if (feito.erroSenha) return res.status(400).json({ error: feito.erroSenha.replace('Senha deve', 'Nova senha deve') });

    mailer.enviarAvisoSenhaAlterada({ to: feito.user.email, nome: feito.user.name }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'senha/redefinir'));
  }
});

// ---------------------------------------------------------------------------
// Troca de e-mail do próprio usuário
// ---------------------------------------------------------------------------
//
// Substitui a edição direta do campo `email` no PUT /api/users/:id, que era um
// caminho de sequestro de conta: bastava uma sessão roubada pra apontar o e-mail
// pra si, pedir reset e ficar com a conta. Aqui exige a senha atual, confirma o
// endereço novo por link e AVISA o antigo.
app.post('/api/me/email', requireAuth, emailAuthLimiter, async (req, res) => {
  if (req.user.role === 'visitor') {
    return res.status(403).json({ error: 'Visitante não tem conta para alterar.' });
  }
  const { senhaAtual, novoEmail } = req.body || {};
  const email = contas.normalizeEmail(novoEmail);
  if (!contas.isEmailValido(email)) return res.status(400).json({ error: 'E-mail inválido' });
  if (email === (req.user.emailLower || '')) {
    return res.status(400).json({ error: 'Este já é o e-mail da sua conta.' });
  }
  // Senha atual: sem isso, uma sessão roubada trocaria o e-mail sozinha.
  const ok = await bcrypt.compare(String(senhaAtual || ''), req.user.passwordHash || '');
  // 400, não 401 — ver o mesmo comentário em /api/me/password.
  if (!ok) return res.status(400).json({ error: 'Senha atual incorreta' });

  try {
    const pedido = await withFileLock(TROCAS_EMAIL_FILE, async () => {
      const users = readJSON('users.json');
      const dono = acharPorEmail(users, email);
      if (dono && dono.id !== req.user.id) {
        return { conflito: 'Este e-mail já está em uso por outra conta.' };
      }
      const trocas = contas.removerExpirados(readJSON(TROCAS_EMAIL_FILE, []));
      const { token, tokenHash, expiresAt } = contas.novoToken(TTL_CONFIRMACAO_MS);
      const outros = trocas.filter((r) => r.userId !== req.user.id);
      outros.push({ tokenHash, expiresAt, userId: req.user.id, email, emailLower: email, criadoEm: new Date().toISOString() });
      writeJSON(TROCAS_EMAIL_FILE, outros);
      return { token };
    });

    if (pedido.conflito) return res.status(409).json({ error: pedido.conflito });

    await mailer.enviarConfirmacaoTrocaEmail({ to: email, nome: req.user.name, token: pedido.token });
    // Alarme no endereço antigo. Não pede ação — só dá à pessoa a chance de
    // reagir se a troca não partiu dela.
    if (req.user.emailLower && req.user.emailVerified) {
      mailer.enviarAvisoTrocaEmail({ to: req.user.email, novoEmail: email }).catch(() => {});
    }
    res.json({ ok: true, aguardandoConfirmacao: email });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'me/email'));
  }
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
  //
  // `email` NÃO entra aqui de propósito. Ele virou âncora do "esqueci minha
  // senha": deixar trocar direto seria sequestro de conta em dois passos —
  // troco pro meu endereço, peço reset, recebo a senha. A troca passa por
  // POST /api/me/email, que confirma o endereço novo por link e avisa o antigo.
  const allowed = ['name', 'gender', 'profilePhoto', 'updateAllOS', 'updateAllos', 'visualDescription', 'shareAppearance', 'sidequestsEnabled', 'abordagem'];
  const patch = {};
  for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
  // Os dois campos novos vêm de controles simples da tela, mas o endpoint é
  // público a qualquer cliente — normaliza em vez de confiar no formato.
  if ('sidequestsEnabled' in patch) patch.sidequestsEnabled = !!patch.sidequestsEnabled;
  if ('abordagem' in patch) patch.abordagem = clampStr(String(patch.abordagem ?? '').trim(), 120);
  users[idx] = { ...users[idx], ...patch };
  writeJSON('users.json', users);
  res.json(publicUser(users[idx]));
});

// --- Admin: gestão de contas ---
const usernameRegex = /^[a-zA-Z0-9._-]{3,32}$/;

// Id de conta nova. MONOTÔNICO: nunca devolve um id que já pertenceu a alguém.
//
// Antes isto era `max(ids) + 1`, e o máximo CAI quando a conta de id mais alto é
// excluída — então o próximo cadastro (inclusive o auto-cadastro público)
// recebia o id da conta apagada e herdava tudo que é indexado por userId: os
// logs das sessões e as avaliações, o MMR, as notificações, as conquistas. Na
// Comunidade era pior ainda: o "Conta removida" voltava a exibir um nome, o da
// pessoa NOVA, sobre os textos da antiga.
//
// O contador vive em counters.json sob a chave reservada `__meta` (as demais
// chaves do arquivo são userIds, que são numéricos — não há como colidir) e só
// sobe. `Math.max` com o maior id em disco cobre a primeira execução e qualquer
// conta criada fora deste caminho.
//
// Chamar SEMPRE dentro do lock de users.json: sem isso dois cadastros
// simultâneos leem o mesmo contador e nascem com o mesmo id.
function nextUserId(users) {
  // Filtra apenas IDs numéricos. Se algum user legacy tiver id não-numérico
  // (ex: visitor-xxx persistido por erro), o Number() retorna NaN — antes,
  // isso corrompia o maxNumeric e o próximo user virava "NaN".
  const maxNumeric = users.reduce((max, u) => {
    const n = Number(u.id);
    if (!Number.isFinite(n)) return max;
    return n > max ? n : max;
  }, 0);
  const counters = readJSON('counters.json', {});
  const meta = (counters.__meta && typeof counters.__meta === 'object') ? counters.__meta : {};
  const ultimo = Number.isFinite(meta.lastUserId) ? meta.lastUserId : 0;
  const proximo = Math.max(maxNumeric, ultimo) + 1;
  counters.__meta = { ...meta, lastUserId: proximo };
  writeJSON('counters.json', counters);
  return String(proximo);
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
    // Ignorando maiúsculas: `Joao` e `joao` não podem coexistir (ver
    // migrateContasCadastroPublico).
    const dup = acharPorUsername(users, username);
    if (dup && (!currentUser || dup.id !== currentUser.id)) errors.push('Usuário já existe');
  }
  // Piso depende do perfil sendo criado/editado (ver validarSenha). O username
  // vai junto porque a senha não pode contê-lo.
  if (!isUpdate && !body.password) {
    errors.push(`Senha deve ter ao menos ${senhaMinimaPara(role)} caracteres`);
  } else if (body.password !== undefined && body.password !== '') {
    const erroSenha = validarSenha(body.password, role, username);
    if (erroSenha) errors.push(erroSenha);
  }
  // E-mail: opcional numa conta criada pelo admin, mas se vier tem que ser
  // válido e único — é a âncora do "esqueci minha senha", e dois donos pro
  // mesmo endereço tornariam o reset ambíguo.
  //
  // Só valida quando o endereço realmente MUDA. Antes desta versão o campo era
  // texto livre, então pode haver conta antiga com e-mail malformado em disco;
  // validar em toda edição impediria o admin de mexer no nome ou na foto dessas
  // contas até arrumar o e-mail, o que não é problema dele naquele momento.
  const emailNovo = contas.normalizeEmail(body.email);
  const emailMudou = body.email !== undefined
    && (!currentUser || emailNovo !== contas.normalizeEmail(currentUser.email));
  if (emailMudou && emailNovo !== '') {
    if (!contas.isEmailValido(emailNovo)) {
      errors.push('E-mail inválido');
    } else {
      const dono = acharPorEmail(users, emailNovo);
      if (dono && (!currentUser || dono.id !== currentUser.id)) {
        errors.push('Este e-mail já está em uso por outra conta');
      }
    }
  }
  if (!isUpdate && !VALID_ROLES.includes(role)) {
    errors.push('Função inválida');
  }
  // Aluno INTERNO exige supervisor (é o que "interno" significa aqui). Aluno
  // EXTERNO nasce sem — mas o vínculo continua válido, e o admin pode criar
  // depois pela tela de Contas; a partir daí ele usa a Antessala como qualquer
  // aluno.
  if (role === 'therapist' && !teacherId) {
    errors.push('Aluno deve estar vinculado a um professor');
  }
  if (isAluno(role) && teacherId) {
    const t = users.find(u => u.id === teacherId);
    if (!t || t.role !== 'supervisor') errors.push('Professor inválido');
  }
  if (role && !isAluno(role) && teacherId) {
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
  const username = req.body.username.trim();
  const email = contas.normalizeEmail(req.body.email);
  const newUser = {
    id: nextUserId(users),
    username,
    usernameLower: contas.normalizeUsername(username),
    name: (req.body.name || req.body.username).trim(),
    role,
    teacherId: isAluno(role) ? (req.body.teacherId || null) : null,
    passwordHash: await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS),
    tokenVersion: 0,
    ...DEFAULT_PROFILE,
    gender: req.body.gender || '',
    email,
    emailLower: email,
    // Endereço digitado pelo admin — não passa por link de confirmação.
    emailVerified: !!email,
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
    ...(req.body.email !== undefined ? { email: contas.normalizeEmail(req.body.email) } : {}),
    ...(req.body.gender !== undefined ? { gender: req.body.gender } : {}),
    ...(req.body.profilePhoto !== undefined ? { profilePhoto: req.body.profilePhoto } : {}),
  };
  merged.usernameLower = contas.normalizeUsername(merged.username);
  merged.emailLower = contas.normalizeEmail(merged.email);
  // Trocado pelo admin, entra já verificado (mesma lógica da criação).
  if (req.body.email !== undefined && merged.emailLower !== (current.emailLower || '')) {
    merged.emailVerified = !!merged.emailLower;
  }

  // teacherId só faz sentido para aluno (interno ou externo)
  if (isAluno(merged.role)) {
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
    const erroSenha = validarSenha(req.body.password, merged.role, merged.username);
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    merged.passwordHash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);
    // Derruba as sessões abertas do usuário (ver signToken).
    merged.tokenVersion = (current.tokenVersion || 0) + 1;
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
  const erroSenha = validarSenha(newPassword, users[idx].role, users[idx].username);
  if (erroSenha) return res.status(400).json({ error: erroSenha });
  users[idx].passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  // Sessões abertas com a senha antiga morrem aqui — é justamente o cenário em
  // que o admin reseta porque a conta pode estar comprometida.
  users[idx].tokenVersion = (users[idx].tokenVersion || 0) + 1;
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
      comunidade: readJSON('comunidade.json', { nextId: 1, discussions: [] }),
      // A config leva os banimentos junto: restaurar um backup sem eles
      // desbanaria todo mundo em silêncio.
      comunidadeConfig: readJSON('comunidade-config.json', {}),
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
  // Aluno externo entra na mesma lista: pro supervisor, um aluno vinculado a
  // ele é um aluno — interno ou não. O externo sem vínculo (o caso comum) tem
  // teacherId null e simplesmente não aparece pra nenhum supervisor.
  const list = req.user.role === 'admin'
    ? users.filter(u => isAluno(u.role))
    : users.filter(u => isAluno(u.role) && u.teacherId === req.user.id);
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

  // ---------- OURO (valem título de perfil) ----------
  { id: 'consistente',        icon: '≡', title: 'Consistente',        description: 'Jogou uma partida ranqueada sem alterar o seu MMR.',                      tier: 'gold' },
  { id: 'simulacao_complete', icon: '◇', title: 'Repertório Clínico', description: 'Concluiu todos os personagens da Simulação.',                             tier: 'gold' },
  { id: 'excelencia',         icon: '★', title: 'Excelência Técnica', description: 'Atingiu pontuação maior ou igual a 90 em uma sessão.',                    tier: 'gold' },
  { id: 'perfeicao',          icon: '✪', title: 'Perfeição',          description: 'Tirou nota 100 em uma sessão.',                                           tier: 'gold' },
  { id: 'meteu_o_lacan',      icon: '⊛', title: 'Meteu o Lacan',      description: 'Tirou 80 ou mais em uma sessão com até 10 mensagens.',                    tier: 'gold' },
  { id: 'estrelinha',         icon: '✶', title: 'Estrelinha',         description: 'Marcou 1000 mensagens como destaque.',                                    tier: 'gold', target: 1000 },
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

// Cálculo unificado das conquistas. Retorna { unlocked:Set, progress:{} }.
// `unlocked` = critério cumprido (resgatável); `progress[id]` = valor atual das
// que têm meta (barra de progresso no front).
function computeAchievements(ctx) {
  const { userLogs, streak, freeplay, duels, micUses, profilePhoto, dailyStreakBest, userId } = ctx;
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

  const views = userRankedDuelViews(duels, userId);
  const rankedWins = views.filter((v) => v.won).length;
  progress.duelista = rankedWins;
  if (rankedWins >= 10) add('duelista');

  let cur = 0, bestStreak = 0;
  for (const v of views) { if (v.won) { cur += 1; bestStreak = Math.max(bestStreak, cur); } else { cur = 0; } }
  progress.invicto = bestStreak;
  if (bestStreak >= 5) add('invicto');

  if (views.some((v) => v.won && Number.isFinite(v.oppBefore) && Number.isFinite(v.myBefore) && (v.oppBefore - v.myBefore) >= 30)) add('davi_golias');

  return { unlocked, progress };
}

// Monta o contexto e roda computeAchievements para um usuário. Centraliza a
// leitura das várias fontes (logs, duelos, contadores, foto de perfil).
function achievementsForUser(userId, userLogs, streak, freeplay) {
  return computeAchievements({
    userLogs,
    streak,
    freeplay,
    duels: readDuels(),
    micUses: getMicUses(userId),
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
      description: `Exercício concluído: ${q.title}`,
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
const ENTREVISTADOR_DIR = path.join(PROMPTS_DIR, 'entrevistador');

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

// --- Administração dos prompts (PROMPTS_DIR) ---
// Os .md de avaliacao/ e entrevistador/ saíram do git (dados sensíveis: critérios
// de nota, gabaritos) e passaram a viver só no volume persistente (PROMPTS_DIR).
// Essas rotas substituem o antigo fluxo "edita o .md → git push → deploy": agora
// a atualização é feita por aqui (admin-only, tela Administração → Prompts ou
// scripts/upload-prompt.js), com o conteúdo indo direto pro volume.
//
// Como o git deixou de ser o histórico desses arquivos, toda gravação passa por
// duas travas de server/prompt-files.js: VALIDAÇÃO (o rascunho tem de passar no
// mesmo parser que a produção usa) e BACKUP (a versão anterior é copiada, e dá
// pra restaurar). Caminho validado contra traversal e restrito a .md.
app.get('/api/admin/prompts', requireAuth, requireRole('admin'), (req, res) => {
  const files = promptFiles.listPromptFiles().map((f) => ({ ...f, validado: promptFiles.hasValidator(f.path) }));
  res.json({
    // `files` como lista de objetos; `paths` mantém o formato antigo (só os
    // caminhos) para quem já consumia esta rota.
    files,
    paths: files.map((f) => f.path),
  });
});

app.get('/api/admin/prompts/*', requireAuth, requireRole('admin'), (req, res) => {
  const rel = req.params[0];
  const target = promptFiles.resolvePromptPath(rel);
  if (!target || !fs.existsSync(target)) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  const st = fs.statSync(target);
  res.json({
    path: rel,
    content: fs.readFileSync(target, 'utf-8'),
    updatedAt: st.mtime.toISOString(),
    validado: promptFiles.hasValidator(rel),
    versoes: promptFiles.listBackups(rel),
  });
});

// `criar:true` no corpo CRIA um .md que ainda não existe no volume (e a pasta
// dele). Sem isso não havia como levar uma versão nova de prompt para produção:
// os .md saíram do git, o volume não é semeado depois do primeiro boot, e esta
// rota só sabia sobrescrever — o que obrigava a rodar script de terminal a cada
// versão nova de avaliador.
//
// As duas intenções são separadas de propósito, e nenhuma faz o trabalho da
// outra por engano:
//   sem a flag  → é EDIÇÃO. Caminho que não existe dá 404 (um erro de digitação
//                 não vira arquivo órfão que ninguém lê).
//   criar:true  → é CRIAÇÃO. Caminho que já existe dá 409 em vez de sobrescrever
//                 (um caminho novo que colide com um prompt no ar não o apaga),
//                 e o caminho passa pela política de validateNewPromptPath.
app.put('/api/admin/prompts/*', requireAuth, requireRole('admin'), (req, res) => {
  const rel = req.params[0];
  const target = promptFiles.resolvePromptPath(rel);
  if (!target) return res.status(400).json({ error: 'Caminho inválido.' });
  const { content, criar } = req.body || {};
  const existe = fs.existsSync(target);
  if (criar === true) {
    if (existe) return res.status(409).json({ error: 'Já existe um arquivo nesse caminho — abra-o na lista para editar.' });
    const politica = promptFiles.validateNewPromptPath(rel);
    if (!politica.ok) return res.status(400).json({ error: politica.error });
  } else if (!existe) {
    return res.status(404).json({ error: 'Arquivo não encontrado — use "Novo arquivo" para criá-lo no volume.' });
  }

  // Valida ANTES de tocar no arquivo: prompt quebrado é recusado aqui, não na
  // hora em que um aluno rodar uma avaliação.
  const v = promptFiles.validatePromptContent(rel, content);
  if (!v.ok) return res.status(400).json({ error: v.error });

  const versaoAnterior = promptFiles.backupPrompt(rel); // null quando é criação
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
  clearAssetsCache(); // o pipeline memoiza os .md — sem isto o servidor serviria a versão velha
  console.log(`[prompts] ${rel} ${existe ? 'atualizado' : 'CRIADO'} por ${req.user.username} (backup: ${versaoAnterior || 'nenhum'})`);
  res.json({ ok: true, criado: !existe, validado: !!v.validado, versaoAnterior, versoes: promptFiles.listBackups(rel) });
});

// Histórico de versões de um arquivo (as MAX_BACKUPS últimas gravações).
app.get('/api/admin/prompt-versions', requireAuth, requireRole('admin'), (req, res) => {
  const rel = String(req.query.path || '');
  if (!promptFiles.resolvePromptPath(rel)) return res.status(400).json({ error: 'Caminho inválido.' });
  res.json({ path: rel, versoes: promptFiles.listBackups(rel) });
});

// Conteúdo de uma versão antiga (para conferir antes de restaurar).
app.get('/api/admin/prompt-versions/:id', requireAuth, requireRole('admin'), (req, res) => {
  const rel = String(req.query.path || '');
  if (!promptFiles.resolvePromptPath(rel)) return res.status(400).json({ error: 'Caminho inválido.' });
  const content = promptFiles.readBackup(rel, req.params.id);
  if (content == null) return res.status(404).json({ error: 'Versão não encontrada.' });
  res.json({ path: rel, id: req.params.id, content });
});

// Restaura uma versão antiga. A versão ATUAL vira backup antes — restaurar por
// engano também tem volta.
app.post('/api/admin/prompt-versions/:id/restaurar', requireAuth, requireRole('admin'), (req, res) => {
  const rel = String((req.body && req.body.path) || '');
  const target = promptFiles.resolvePromptPath(rel);
  if (!target || !fs.existsSync(target)) return res.status(400).json({ error: 'Caminho inválido.' });
  const content = promptFiles.readBackup(rel, req.params.id);
  if (content == null) return res.status(404).json({ error: 'Versão não encontrada.' });

  const v = promptFiles.validatePromptContent(rel, content);
  if (!v.ok) return res.status(400).json({ error: `A versão guardada não passa na validação atual: ${v.error}` });

  promptFiles.backupPrompt(rel);
  fs.writeFileSync(target, content, 'utf-8');
  clearAssetsCache();
  console.log(`[prompts] ${rel} restaurado para a versão ${req.params.id} por ${req.user.username}`);
  res.json({ ok: true, content, versoes: promptFiles.listBackups(rel) });
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
  removeExercisePhotoFiles(req.params.id); // limpa o avatar do volume junto
  res.json({ ok: true });
});

function removeExercisePhotoFiles(id) {
  for (const suf of ['-icon.jpg', '-full.jpg']) {
    try {
      const p = path.join(EXERCISE_PHOTOS_DIR, id + suf);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignora */ }
  }
}

// Avatar da IA do exercício ("a bolinha" no chat da Trilha) — mesmo esquema da
// foto de paciente: o cliente recorta no canvas e manda icon+full já prontos
// como JPEG data URL; o servidor só grava os bytes. `clear:true` remove.
app.put('/api/exercises/:id/photo', requireAuth, requireRole('admin'), writeLimiter, (req, res) => {
  const exercises = readJSON('exercises.json');
  const idx = exercises.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });

  if (req.body && req.body.clear) {
    removeExercisePhotoFiles(req.params.id);
    delete exercises[idx].photoIcon;
    delete exercises[idx].photoFull;
    writeJSON('exercises.json', exercises);
    return res.json(exercises[idx]);
  }

  const icon = decodeImageDataUrl(req.body && req.body.icon);
  const full = decodeImageDataUrl(req.body && req.body.full);
  if (!icon || !full) return res.status(400).json({ error: 'Envie a foto (icon e full) como data URL de imagem.' });
  const MAX = 6 * 1024 * 1024; // bytes por arquivo
  if (icon.length > MAX || full.length > MAX) return res.status(413).json({ error: 'Imagem muito grande.' });

  try {
    fs.writeFileSync(path.join(EXERCISE_PHOTOS_DIR, `${req.params.id}-icon.jpg`), icon);
    fs.writeFileSync(path.join(EXERCISE_PHOTOS_DIR, `${req.params.id}-full.jpg`), full);
  } catch (err) {
    return res.status(500).json(falhou(req, err, 'admin/gravar-avatar-exercicio',
      { extra: { exercicioId: req.params.id } }));
  }
  // ?v=<ts> quebra o cache do navegador quando a foto muda.
  const v = Date.now();
  exercises[idx].photoIcon = `/exercise-photos/${req.params.id}-icon.jpg?v=${v}`;
  exercises[idx].photoFull = `/exercise-photos/${req.params.id}-full.jpg?v=${v}`;
  writeJSON('exercises.json', exercises);
  res.json(exercises[idx]);
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

// --- Recorde 👑 por paciente (maior nota do Competitivo) ---
// Substituiu o Modo Desafio: o 👑 no card não é mais uma disputa à parte, é só a
// MAIOR nota que alguém já tirou naquele paciente no modo Competitivo. Mora fora
// de logs.json porque os logs expiram em 30 dias e o recorde é permanente.
function readCharacterRecords() {
  const data = readJSON('character-records.json', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function writeCharacterRecords(data) {
  writeJSON('character-records.json', data);
}
// Snapshot público: nota + quem tirou. Sem userId — o card não precisa e não vale
// expor id de aluno pra turma inteira.
function publicRecord(r) {
  if (!r || !Number.isFinite(r.score)) return null;
  return {
    score: r.score,
    userName: r.userName || 'Aluno',
    userPhoto: r.userPhoto || null,
    at: r.at || null,
  };
}
// Registra a nota como recorde do paciente se ela superar a atual. Empate NÃO
// troca o dono (quem chegou primeiro fica com o 👑). `holder` é { userId, userName }
// — a foto é buscada em users.json na hora (visitante não tem, e nem entra aqui).
function updateCharacterRecord(characterId, score, holder) {
  if (!characterId || !Number.isFinite(score) || !holder || !holder.userId) return null;
  const records = readCharacterRecords();
  const cur = records[characterId];
  if (cur && Number.isFinite(cur.score) && cur.score >= score) return null;
  const photo = (readJSON('users.json').find((u) => u.id === holder.userId) || {}).profilePhoto || null;
  records[characterId] = {
    score,
    userId: holder.userId,
    userName: holder.userName || 'Aluno',
    userPhoto: photo,
    at: new Date().toISOString(),
  };
  writeCharacterRecords(records);
  return records[characterId];
}

// Backfill one-shot: semeia os recordes com as notas competitivas que já estão
// em logs.json (antes desta funcionalidade existir). Idempotente via marker.
(function migrateCharacterRecords() {
  const migrations = readJSON('migrations.json', {});
  if (migrations.character_records_backfill) return;
  const records = readCharacterRecords();
  let seeded = 0;
  for (const l of readJSON('logs.json')) {
    if (l.type !== 'freeplay' || l.mode !== 'competitive') continue;
    if (!l.itemId || !Number.isFinite(l.score)) continue;
    const cur = records[l.itemId];
    if (cur && Number.isFinite(cur.score) && cur.score >= l.score) continue;
    records[l.itemId] = {
      score: l.score,
      userId: l.userId || null,
      userName: l.userName || 'Aluno',
      userPhoto: null,
      at: l.timestamp || null,
    };
    seeded++;
  }
  if (seeded > 0) writeCharacterRecords(records);
  migrations.character_records_backfill = new Date().toISOString();
  writeJSON('migrations.json', migrations);
  console.log(`[migration] recordes 👑 semeados a partir de ${seeded} log(s) competitivo(s).`);
})();

app.get('/api/freeplay', requireAuth, (req, res) => {
  const list = readJSON('freeplay-characters.json');
  const mmr = readMMR();
  const records = readCharacterRecords();
  // "Paciente em Destaque": o ÚLTIMO personagem cadastrado (a lista é gravada em
  // ordem de inserção). É só um truque de front — o card ganha fundo amarelo no
  // Competitivo pra puxar atenção e calibrar o TRI do personagem novo, que ainda
  // tem poucas partidas. Nada de regra de jogo depende disso.
  const featuredId = list.length ? list[list.length - 1].id : null;
  // Dificuldade do MMR é aberta (alunos + admin) — exibida nos cards do modo
  // competitivo e no painel admin. Personagem nunca jogado mostra a baseline 50.
  const withExtras = (base, c) => ({
    ...base,
    difficulty: mmrEngine.characterDifficulty(mmr.characters[c.id]),
    competitiveMatches: (mmr.characters[c.id] && mmr.characters[c.id].n_D) || 0,
    record: publicRecord(records[c.id]),
    featured: c.id === featuredId,
  });
  res.json(
    list.map((c) => withExtras(isAdmin(req.user) ? c : publicFreeplayChar(c), c)),
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
  // Aluno (interno ou externo) e visitante recebem o log SEM esse campo.
  const isStudent = isAluno(req.user.role) || req.user.role === 'visitor';
  const serve = (arr) => {
    const decorated = decorateLogs(arr);
    if (!isStudent) return decorated;
    return decorated.map(({ criteriaScores, ...rest }) => rest);
  };

  // Aluno e visitante: só os próprios.
  if (isAluno(req.user.role) || req.user.role === 'visitor') {
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
      users.filter(u => isAluno(u.role) && u.teacherId === req.user.id).map(u => u.id)
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

// --- Notas internas por critério na saída do avaliador ---
// Duas gerações de formato convivem aqui, e a extração aceita as duas:
//
//   v18.25 (atual, avaliacao/avaliador 18/*) → bloco `[notas]` NO INÍCIO, uma
//     linha por critério ("N: nota" ou "N: NA"; no comparativo do Duelo as
//     chaves são A1..A15 / B1..B15), depois a linha `[feedback]` e o corpo. As
//     notas vêm ANTES da prosa de propósito (anti-compressão: o número nasce da
//     avaliação fria, antes de a escrita amolecê-lo).
//   v15/v16 (logs antigos) → prosa + `[notas-supervisor]` no FIM, com JSON
//     (ou Base64 de linhas "N:nota", nas primeiras versões).
//
// Em qualquer um dos dois, as notas são de SUPERVISOR/ADMIN — nunca do aluno. No
// save extraímos (vão pro criteriaScores, que o GET esconde do aluno) e gravamos
// a avaliação só com o texto que o aluno pode ler.
//
// Saudação: os avaliadores v18.25 não escrevem saudação — a especificação deles
// diz que "o sistema monta a mensagem" —, então é aqui que ela entra, quando o
// texto é o que o aluno vai ler. ESPELHO: client/src/prompts.js repete o mesmo
// texto (o aluno vê a avaliação na tela antes de o log ser salvo). Mudou aqui,
// mude lá.
const EVAL_GREETING = [
  'Trate este feedback como pré-correção — ponto de partida para conversa com seu supervisor e colegas, não veredicto.',
  '',
  'Tenho acesso apenas ao que você escreveu, não ao que você pensou. Use o botão de estrela para descrever seu raciocínio clínico nas falas em que ele importa — isso me ajuda a diferenciar decisões clínicas conscientes de erros por falta de percepção.',
].join('\n');

// Uma linha do bloco [notas]: "12: 8", "10: NA", "A1: 7" (comparativo).
const V18_NOTE_LINE = /^[^\S\n]*([AB]?\d{1,2})[^\S\n]*:[^\S\n]*(NA|[-+]?\d+(?:[.,]\d+)?)[^\S\n]*$/i;

function parseSupervisorPayload(payload) {
  if (!payload) return null;
  // 1) JSON direto (v15/v16)
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const n = Number(String(v).replace(',', '.'));
        if (Number.isFinite(n)) out[String(k).trim().toUpperCase()] = n;
      }
      if (Object.keys(out).length) return out;
    }
  } catch {}
  // 2) Base64 (v15 original) ou texto puro de linhas "N: nota" (retrocompat).
  //    Uma linha pode trazer VÁRIOS pares ("A1: 7  A2: 8  …"): era o formato que
  //    o comparativo v2 pedia, em duas linhas. A linha só conta quando é feita
  //    exclusivamente de pares — assim prosa solta no payload não vira nota.
  let lines = payload;
  if (!payload.includes(':') && /^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    try { lines = Buffer.from(payload, 'base64').toString('utf-8'); } catch {}
  }
  const PAIR = /([AB]?\d{1,2})[^\S\n]*:[^\S\n]*([-+]?\d+(?:[.,]\d+)?)/gi;
  const out = {};
  for (const line of lines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^(?:[^\S\n]*[AB]?\d{1,2}[^\S\n]*:[^\S\n]*[-+]?\d+(?:[.,]\d+)?[^\S\n]*)+$/i.test(line)) continue;
    for (const m of line.matchAll(PAIR)) out[m[1].toUpperCase()] = Number(m[2].replace(',', '.'));
  }
  return Object.keys(out).length ? out : null;
}

// Formato v18.25: `[notas]` → linhas de nota → `[feedback]` → corpo. Retorna
// null quando nenhum dos dois marcadores aparece (aí o texto é de outra geração).
// `NA` é preservado como string: finalScoreFromCriteria o descarta (NaN) e a
// tabela do supervisor não mostra a linha.
function parseV18EvaluatorOutput(text) {
  // Marcadores só valem em linha própria — um "[feedback]" solto no meio de uma
  // frase (ou dentro do log que o aluno colou) não pode cortar o texto.
  const notasMatch = text.match(/(?:^|\r?\n)[^\S\n]*\[notas\][^\S\n]*\r?\n/i);
  const fbMatch = text.match(/(?:^|\r?\n)[^\S\n]*\[feedback\][^\S\n]*(?:\r?\n|$)/i);
  if (!notasMatch && !fbMatch) return null;
  let criteria = null;
  // Fim do bloco de notas: o marcador [feedback], quando vem depois; senão, a
  // primeira linha que não é linha de nota nem linha vazia. O segundo caso cobre
  // o modelo que esquece o [feedback] — aí o corpo começa ali, e devolvê-lo é
  // muito melhor que devolver feedback vazio.
  let notesEnd = text.length;
  if (notasMatch) {
    const start = notasMatch.index + notasMatch[0].length;
    const hardEnd = fbMatch && fbMatch.index > notasMatch.index ? fbMatch.index : text.length;
    const out = {};
    let cursor = start;
    for (const line of text.slice(start, hardEnd).split(/\r?\n/)) {
      const lm = line.match(V18_NOTE_LINE);
      if (!lm) {
        if (line.trim() === '') { cursor += line.length + 1; continue; }
        break;
      }
      out[lm[1].toUpperCase()] = /^na$/i.test(lm[2]) ? 'NA' : Number(lm[2].replace(',', '.'));
      cursor += line.length + 1;
    }
    if (Object.keys(out).length) criteria = out;
    notesEnd = Math.min(cursor, hardEnd);
  }
  let feedback;
  if (fbMatch) feedback = text.slice(fbMatch.index + fbMatch[0].length);
  else if (notasMatch) feedback = text.slice(notesEnd);
  else feedback = text;
  // Defesa: se o modelo emitiu o bloco de notas fora de ordem (depois do corpo),
  // ele não pode sobrar no texto do aluno.
  feedback = feedback.replace(/(?:^|\r?\n)[^\S\n]*\[notas\][^\S\n]*\r?\n[\s\S]*$/i, '').trim();
  return { criteria, feedback };
}

// { clean, criteria }. `clean` é o texto sem os blocos de máquina — com a
// saudação prefixada quando o destino é o aluno (greeting) e o avaliador é v18.25.
function extractSupervisorNotes(evaluation, { greeting = true } = {}) {
  const text = typeof evaluation === 'string' ? evaluation : '';
  const v18 = parseV18EvaluatorOutput(text);
  if (v18) {
    const clean = greeting && v18.feedback ? `${EVAL_GREETING}\n\n${v18.feedback}` : v18.feedback;
    return { clean, criteria: v18.criteria };
  }
  // Legado: (--- opcional) + [notas-supervisor] + payload até o fim do texto.
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
  // [notas] (avaliadores v18.25) ou [notas-supervisor] (logs antigos). A IA não emite a nota
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

  // Atendimento finalizado: fecha a sessão daquela chave na cota do Aluno
  // Externo. O slot já gasto continua contando; o que muda é que reabrir aquele
  // paciente passa a custar um slot novo, em vez de seguir de graça pra sempre.
  // Best-effort — falhar aqui não pode derrubar o salvamento do log.
  closeSessionQuota(req.user, sessionQuota.sessionKey({ type: log.type, itemId: log.itemId }))
    .catch(() => {});

  // "Sua avaliação está pronta" — atualiza (não duplica) a notificação "na
  // fila" disparada no início de /api/evaluate (mesmo refId 'eval:'+userId).
  // Competitivo fica de fora: chega aqui só por esta rota quando NÃO é
  // competitivo — o competitivo tem seu próprio ciclo fila→pronta em
  // /api/competitive/finish + finalizeCompetitiveEvals. Sem evaluation/score
  // não há o que anunciar (ex.: Simulação Livre do visitante, sem avaliador).
  if (mode !== 'competitive' && (log.evaluation || Number.isFinite(log.score))) {
    upsertEvaluationNotification(req.user.id, 'eval:' + req.user.id, {
      type: 'evaluation_ready',
      message: `Sua avaliação${log.itemTitle ? ` de "${log.itemTitle}"` : ''} está pronta.`,
    });
  }

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

    // Recorde 👑 do paciente: mesma porta de entrada do MMR (competitivo, nota
    // numérica, usuário real). Best-effort — nada aqui derruba a submissão.
    try {
      updateCharacterRecord(log.itemId, log.score, { userId: req.user.id, userName: req.user.name });
    } catch (err) {
      console.error('updateCharacterRecord falhou:', err.message);
    }
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

// Admin: remove uma entrada de feedback (ex.: teste do próprio admin).
app.delete('/api/admin/feedback/:id', requireAuth, requireRole('admin'), (req, res) => {
  const all = readJSON('feedback.json', []);
  const next = all.filter((f) => f.id !== req.params.id);
  if (next.length === all.length) return res.status(404).json({ error: 'Feedback não encontrado.' });
  writeJSON('feedback.json', next);
  res.json({ ok: true });
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

// --- Suporte (mensagem do usuário para a administração) ---
// A pessoa escreve na página /suporte e a mensagem cai no MESMO painel dos Logs
// de Erro do admin, com `where: 'suporte/mensagem'` — é o único canal de leitura
// diária que o admin já tem, então a mensagem chega onde ele olha. Não é erro:
// vai com `status: null` (a tela não mostra "HTTP …" nessas entradas) e o próprio
// texto do usuário é a mensagem da entrada. Devolvemos o código ao usuário porque é
// por ele que o admin acha o recado (mesma ponte do `falhou()`).
//
// Provisório por decisão do dono ("depois melhoramos isso"): o passo natural é
// uma caixa de entrada própria, com status de atendido/respondido.
const SUPORTE_MAX_SUBJECT = 120;
// 1000 é o teto do campo `message` da entrada de erro (buildErrorEntry corta aí).
// Manter o limite igual evita truncar o recado sem avisar ninguém — a tela mostra
// o contador e o servidor recusa acima disso.
const SUPORTE_MAX_MESSAGE = 1000;

app.post('/api/suporte', requireAuth, writeLimiter, (req, res) => {
  const body = req.body || {};
  const subject = clampStr(body.subject, SUPORTE_MAX_SUBJECT).trim();
  const message = String(body.message == null ? '' : body.message).trim();
  if (!message) return res.status(400).json({ error: 'Escreva a sua mensagem.' });
  if (message.length > SUPORTE_MAX_MESSAGE) {
    return res.status(400).json({ error: `A mensagem passa de ${SUPORTE_MAX_MESSAGE} caracteres. Resuma um pouco.` });
  }

  // registrarErro aceita qualquer objeto com `message` — reusamos a trilha
  // inteira (redação de segredo, poda por idade/teto, código curto, stdout).
  const id = registrarErro(
    req,
    { message, name: 'MensagemDeSuporte' },
    'suporte/mensagem',
    { status: null, extra: { assunto: subject || '(sem assunto)', autor: req.user.name || req.user.username || '—' } },
  );
  res.json({ ok: true, codigo: id });
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
  // Os recordes 👑 dos pacientes são notas do avaliador antigo — caem junto.
  writeCharacterRecords({});
  console.log(`[admin] Ranking resetado por ${req.user.username}: ${clearedScores} nota(s) zerada(s), progresso e recordes limpos.`);
  res.json({ ok: true, clearedScores });
});

// --- Configurações globais da plataforma (settings.json) ---
// Chaves controladas pelo admin (tela Administração → Modelos de IA):
//   visitorEvaluationEnabled — liga a avaliação para VISITANTES (via Simulação
//     Livre, o único modo que o visitante acessa). Default FALSE: no dia a dia o
//     visitante joga sem avaliação (não queima tokens nem expõe a IA). O dono
//     liga durante palestras/eventos e desliga depois.
//   aiModels — modelo do avaliador e do paciente POR CATEGORIA do app (ver
//     server/ai-models.js e aiCategoryDefaults). Categoria sem escolha usa o
//     padrão do sistema.
//   visitorEvaluationModel — LEGADO da época em que só o visitante escolhia
//     modelo (a escolha morava na aba Contas). Continua sendo lido como PADRÃO da
//     categoria "visitante" pra não perder o que já estava configurado.
function readSettings() {
  return readJSON('settings.json', {});
}
function visitorEvaluationEnabled() {
  return readSettings().visitorEvaluationEnabled === true;
}

// Configurações visíveis ao cliente — QUALQUER usuário autenticado (inclusive
// visitante: o EchoSession precisa saber se deve rodar a avaliação do visitante).
// visitorEvaluationModel é LEGADO: a escolha do modelo virou a categoria
// "Visitante" em Administração → Modelos de IA. Continua sendo respondido (e
// dizendo a verdade sobre o que roda) pra não quebrar cliente antigo em cache.
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    visitorEvaluationEnabled: visitorEvaluationEnabled(),
    visitorEvaluationModel: evaluatorSpecFor('visitante').preset || VISITOR_EVAL_MODEL_DEFAULT,
  });
});

// Toggle das flags (admin-only).
app.put('/api/admin/settings', requireAuth, requireRole('admin'), (req, res) => {
  const cur = readSettings();
  const body = req.body || {};
  if (typeof body.visitorEvaluationEnabled === 'boolean') {
    cur.visitorEvaluationEnabled = body.visitorEvaluationEnabled;
  }
  if (typeof body.visitorEvaluationModel === 'string') {
    cur.visitorEvaluationModel = VISITOR_EVAL_MODELS[body.visitorEvaluationModel]
      ? body.visitorEvaluationModel
      : VISITOR_EVAL_MODEL_DEFAULT;
  }
  writeJSON('settings.json', cur);
  console.log(`[admin] settings atualizado por ${req.user.username}: visitorEvaluationEnabled=${cur.visitorEvaluationEnabled === true} visitorEvaluationModel=${cur.visitorEvaluationModel || VISITOR_EVAL_MODEL_DEFAULT}`);
  res.json({
    visitorEvaluationEnabled: cur.visitorEvaluationEnabled === true,
    visitorEvaluationModel: VISITOR_EVAL_MODELS[cur.visitorEvaluationModel] ? cur.visitorEvaluationModel : VISITOR_EVAL_MODEL_DEFAULT,
  });
});

// --- Modelos de IA por categoria (admin-only) -------------------------------
// GET devolve as opções + o que cada categoria está rodando agora (spec efetivo,
// já resolvido: escolha do admin ou padrão do sistema). PUT grava UMA categoria
// por vez; `null` em um campo limpa a escolha e volta ao padrão.
app.get('/api/admin/ai-models', requireAuth, requireRole('admin'), (req, res) => {
  res.json(aiModels.catalogo({ settings: readSettings(), fallbacks: aiCategoryDefaults() }));
});

app.put('/api/admin/ai-models', requireAuth, requireRole('admin'), (req, res) => {
  const { categoria, evaluator, patient, global: escopoGlobal } = req.body || {};
  const cur = readSettings();

  // `global: true` grava o PADRÃO DE TODAS as categorias de uma vez (quem tem
  // escolha própria continua com ela — ver precedência em ai-models.js).
  if (escopoGlobal === true) {
    const g = aiModels.applyGlobalChoice(cur, { evaluator, patient });
    if (!g.ok) return res.status(400).json({ error: g.error });
    cur.aiModelsGlobal = g.aiModelsGlobal;
    writeJSON('settings.json', cur);
    console.log(`[admin] padrão global de modelos por ${req.user.username}: avaliador=${cur.aiModelsGlobal.evaluator || '—'} paciente=${cur.aiModelsGlobal.patient || '—'}`);
    return res.json(aiModels.catalogo({ settings: cur, fallbacks: aiCategoryDefaults() }));
  }

  const aplicado = aiModels.applyCategoryChoice(cur, categoria, { evaluator, patient });
  if (!aplicado.ok) return res.status(400).json({ error: aplicado.error });
  cur.aiModels = aplicado.aiModels;
  writeJSON('settings.json', cur);
  const ev = evaluatorSpecFor(categoria);
  console.log(`[admin] modelos de IA (${categoria}) por ${req.user.username}: avaliador=${ev.model}/${ev.effort}${ev.batch ? ' (batch)' : ''}`);
  res.json(aiModels.catalogo({ settings: cur, fallbacks: aiCategoryDefaults() }));
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
//  - OpenAI GPT-5.x (reasoning): avaliador (v18.25), avaliador de duelo e
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
// Avaliador (v18.25 + duelo) roda no gpt-5.5. O entrevistador segue no full 5.4
// (HEAVY) — geração de prompt de paciente é menos sensível a custo.
const OPENAI_EVAL_MODEL = process.env.OPENAI_EVAL_MODEL || 'gpt-5.5-2026-04-23';
const OPENAI_HEAVY_MODEL = process.env.OPENAI_HEAVY_MODEL || 'gpt-5.4-2026-03-05';
// reasoning_effort por caminho. Avaliador em 'medium' — o default da família
// GPT-5.x (setado explícito p/ não depender de defaults da API e manter o
// summary). O canal de raciocínio OCULTO mantém o cruzamento gabarito × log fora
// da prosa que o ALUNO lê (Echo/ChatSession); NÃO zerar o canal (ir abaixo de
// minimal), senão reabre o vazamento do Bloco 1 — causa-raiz do bug do Opus (v15).
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

// --- PADRÕES dos avaliadores de produção (escolhidos pelo dono em 2026-07) ---
// ATENÇÃO (2026-08): estas consts deixaram de ser a palavra final. Hoje elas são
// o PADRÃO de cada categoria (ver aiCategoryDefaults) e o admin pode sobrepor
// cada uma na tela Administração → Modelos de IA, em runtime. Ou seja: as regras
// abaixo descrevem o default, não uma garantia.
//
// O que MUDOU de invariante para default (não confie mais nisso como absoluto):
//   - "GPT como avaliador sempre vai de Batch" virou escolha: o admin pode pôr
//     GPT num modo síncrono (Treinamento, Visitante, Duelo, Neuro), e aí
//     roda a preço cheio, sem os 50% do batch. A tela avisa disso.
//   - "SELECAO_EVAL_MODEL precisa apontar pra OpenAI" não vale mais: escolher GLM
//     no Seletivo/Competitivo desliga o batch e a avaliação vai pelo caminho
//     síncrono em background (runSelectionEvalsWithoutBatch / o do Competitivo).
//   - O Duelo continua SEM fallback pro GPT no caminho de FALHA (isso segue
//     valendo), mas o admin pode escolher GPT como primário dele.
//
// TREINAMENTO (freeplay training): GLM 5.2/high; FALLBACK pra gpt-5.4/medium (o
// SIM acima) se o primário falhar. SELETIVO e COMPETITIVO: gpt-5.5/high em BATCH
// (ninguém espera a nota na tela). Provider é derivado do prefixo do modelo.
const TRAINING_EVAL_MODEL = process.env.TRAINING_EVAL_MODEL || 'glm-5.2';
const TRAINING_EVAL_EFFORT = process.env.TRAINING_EVAL_EFFORT || 'high';
const SELECAO_EVAL_MODEL = process.env.SELECAO_EVAL_MODEL || 'gpt-5.5-2026-04-23';
const SELECAO_EVAL_EFFORT = process.env.SELECAO_EVAL_EFFORT || 'high';
const OPENAI_COMP_MODEL = process.env.OPENAI_COMP_MODEL || 'gpt-5.5-2026-04-23';
const OPENAI_COMP_EFFORT = process.env.OPENAI_COMP_EFFORT || 'high';
// DUELO (avaliação comparativa): GLM 5.2/high por padrão. O resultado sai na hora
// pros dois alunos, então esta categoria nunca vai de batch, qualquer que seja o
// modelo — e não há fallback pro GPT quando o primário falha.
const DUEL_EVAL_MODEL = process.env.DUEL_EVAL_MODEL || 'glm-5.2';
const DUEL_EVAL_EFFORT = process.env.DUEL_EVAL_EFFORT || 'high';
function providerForModel(m) {
  return String(m || '').startsWith('glm') ? 'glm' : 'openai';
}

// LEGADO: as duas opções de avaliador de visitante da época em que essa escolha
// morava na aba Contas (chave visitorEvaluationModel em settings.json). Hoje a
// escolha é a categoria "visitante" em Administração → Modelos de IA, com as 3
// opções de sempre; isto sobrevive só para (a) traduzir a escolha antiga no
// PADRÃO daquela categoria (ver aiCategoryDefaults) e (b) manter o contrato do
// PUT /api/admin/settings pra cliente antigo em cache. Não usar em código novo.
const VISITOR_EVAL_MODEL_DEFAULT = 'glm-5.2';
const VISITOR_EVAL_MODELS = {
  'glm-5.2': { model: 'glm-5.2', provider: 'glm', effort: 'high' },
  'gpt-5.5': { model: OPENAI_COMP_MODEL, provider: 'openai', effort: 'high' },
};

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

// --- Modelos por CATEGORIA (tela Administração → Modelos de IA) -------------
// O admin escolhe, por categoria do app, qual IA avalia e qual interpreta o
// paciente (ver server/ai-models.js). Enquanto ele NÃO escolhe, vale o padrão
// abaixo — que é exatamente o comportamento das consts de env de sempre, modelo
// E effort. Ligar a tela, por si só, não muda nada.
//
// A Trilha fica FORA disto: lá a escolha é por exercício
// (TRILHA_EXERCISE_MODELS/TRILHA_CHAT_MODELS acima) e é controle próprio do
// editor de exercícios.
function patientDefaultSpec() {
  return { model: PATIENT_MODEL, provider: 'openai', effort: PATIENT_EFFORT };
}

// Padrão de cada categoria. Lido a cada chamada (não no boot) porque o padrão do
// Visitante ainda considera a escolha ANTIGA de modelo (visitorEvaluationModel,
// que vivia na aba Contas) — quem já tinha configurado ali não perde a escolha.
function aiCategoryDefaults() {
  const legadoVisitante = VISITOR_EVAL_MODELS[readSettings().visitorEvaluationModel]
    || VISITOR_EVAL_MODELS[VISITOR_EVAL_MODEL_DEFAULT];
  const paciente = patientDefaultSpec();
  const ev = (model, effort) => ({ model, provider: providerForModel(model), effort });
  return {
    treinamento: { evaluator: ev(TRAINING_EVAL_MODEL, TRAINING_EVAL_EFFORT), patient: paciente },
    competitivo: { evaluator: ev(OPENAI_COMP_MODEL, OPENAI_COMP_EFFORT), patient: paciente },
    seletivo: { evaluator: ev(SELECAO_EVAL_MODEL, SELECAO_EVAL_EFFORT), patient: paciente },
    visitante: { evaluator: { ...legadoVisitante }, patient: paciente },
    duelo: { evaluator: ev(DUEL_EVAL_MODEL, DUEL_EVAL_EFFORT), patient: paciente },
    neuro: { evaluator: ev(OPENAI_NEURO_MODEL, OPENAI_NEURO_EFFORT), patient: paciente },
    avaliacaoManual: { evaluator: ev(OPENAI_EVAL_MODEL, OPENAI_EVAL_EFFORT), patient: paciente },
  };
}

// Spec do AVALIADOR da categoria: { preset, label, model, provider, effort,
// batch, fonte }. `batch` só vem true onde a categoria comporta assincronia E o
// provedor tem Batch API — então escolher GLM no Competitivo/Seletivo desliga o
// batch em vez de bloquear a opção (aí a avaliação roda síncrona em background).
function evaluatorSpecFor(categoria) {
  return aiModels.resolveEvaluator(categoria, readSettings(), aiCategoryDefaults()[categoria].evaluator);
}

// Spec do PACIENTE simulado da categoria (conversa ao vivo, nunca batch).
function patientSpecFor(categoria) {
  return aiModels.resolvePatient(categoria, readSettings(), aiCategoryDefaults()[categoria].patient);
}

// Rede de segurança OpenAI pro avaliador: quando o modelo escolhido é de outro
// provedor e a chamada falha (rate limit/instabilidade/sem key), refaz aqui pra
// o aluno nunca ficar sem nota. Se o padrão da categoria já é OpenAI, usa ele;
// senão cai no SIM (gpt-5.4/medium), que é o fallback histórico do Treinamento.
function evaluatorOpenaiFallback(categoria) {
  const padrao = aiCategoryDefaults()[categoria].evaluator;
  if (padrao.provider === 'openai') return { model: padrao.model, effort: padrao.effort };
  return { model: OPENAI_SIM_MODEL, effort: OPENAI_SIM_EFFORT };
}

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

// Um turno do PACIENTE simulado, no modelo que a categoria manda (ver
// patientSpecFor). Concentra aqui o que difere entre provedores pra as duas
// rotas de paciente (/api/chat e /api/selecao/chat) não duplicarem a lógica:
//   OpenAI    → chat.completions com reasoning_effort
//   GLM       → chat.completions com thinking/reasoning_effort (via buildChatBody)
//   Anthropic → Messages API, com cache_control explícito (não é automático lá)
// FALLBACK pro paciente padrão (gpt-5.4-mini) sempre que o provedor alternativo
// falhar: numa conversa ao vivo, ficar sem resposta é pior que trocar de modelo.
// Devolve o provedor/modelo que REALMENTE respondeu, pra o usage ser normalizado
// e logado certo.
async function runPatientTurn({ spec, systemPrompt, messages, maxTokens, label }) {
  const fallback = async () => {
    const openai = getOpenAI();
    if (!openai) throw new Error('OpenAI indisponível');
    const { text, usage } = await openaiComplete({
      openai, model: PATIENT_MODEL, effort: PATIENT_EFFORT,
      systemPrompt, messages, maxCompletionTokens: maxTokens,
    });
    return { text, usage, provider: 'openai', model: PATIENT_MODEL };
  };

  if (spec.provider === 'openai') {
    const openai = getOpenAI();
    if (!openai) throw new Error('OpenAI indisponível');
    // Paciente COM raciocínio (Sol/Luna em high): max_completion_tokens é teto
    // de reasoning + fala, e o teto do paciente é curto (~3,5k). Sem folga, o
    // modelo pensa até o limite e devolve content vazio — o aluno veria uma
    // resposta em branco. A folga não custa nada quando não é usada (só se paga
    // o gerado); com effort 'none' o teto continua o de sempre.
    const semRaciocinio = spec.effort === 'none' || spec.effort === 'disabled' || !spec.effort;
    const { text, usage } = await openaiComplete({
      openai, model: spec.model, effort: spec.effort,
      systemPrompt, messages, maxCompletionTokens: semRaciocinio ? maxTokens : maxTokens + 8000,
    });
    if ((text && text.trim()) || spec.model === PATIENT_MODEL) {
      return { text, usage, provider: 'openai', model: spec.model };
    }
    // Vazio mesmo com folga (ou recusa silenciosa): cai no paciente padrão em
    // vez de entregar uma fala em branco na conversa. (Se o modelo JÁ era o
    // padrão, repetir a mesma chamada não ajudaria — devolve o que veio.)
    console.warn(`[paciente] ${label || 'chat'}: ${spec.model} devolveu vazio — caindo no ${PATIENT_MODEL}`);
    return fallback();
  }

  try {
    const client = getClientForProvider(spec.provider);
    if (!client) throw new Error(`${spec.provider} indisponível`);
    let text;
    let usage;
    if (spec.provider === 'anthropic') {
      const resp = await client.messages.create(buildAnthropicArgs({
        model: spec.model, effort: spec.effort, systemPrompt,
        turns: normalizeMessagesForAnthropic(messages), maxTokens,
      }));
      text = extractAnthropicText(resp);
      usage = resp.usage || null;
    } else {
      const resp = await client.chat.completions.create(buildChatBody({
        provider: spec.provider, model: spec.model, effort: spec.effort,
        maxTokens, messages: buildOpenAIMessages(systemPrompt, messages),
      }));
      text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
      usage = resp.usage || null;
    }
    if (!String(text || '').trim()) throw new Error('resposta vazia');
    return { text, usage, provider: spec.provider, model: spec.model };
  } catch (err) {
    console.error(`[${label}] ${spec.model} falhou → fallback ${PATIENT_MODEL}:`, err.message);
    return fallback();
  }
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

// --- Cota diária de sessões do Aluno Externo ---
// Regra e janela em server/session-quota.js. Aqui fica só o I/O:
// external-session-starts.json = { "<userId>": [<timestamp ms>, ...] }.

const SESSION_STARTS_FILE = 'external-session-starts.json';

function readSessionStarts() {
  return readJSON(SESSION_STARTS_FILE, {});
}

// Estado da cota de um usuário do JWT. Papel sem cota devolve o mesmo shape,
// com enabled:false — a UI não precisa saber quem tem limite.
function sessionQuotaFor(user) {
  if (!sessionQuota.hasSessionQuota(user && user.role)) return sessionQuota.unlimitedState();
  return sessionQuota.quotaState(readSessionStarts()[user.id]);
}

// Cobra um slot para a CHAVE de sessão (tipo+paciente). Sob lock porque é
// ler→modificar→gravar: dois cliques em "Iniciar" ao mesmo tempo não podem
// virar um registro só.
//
// Se a chave já está aberta, não cobra nada — é a conversa em andamento. Quem
// decide isso é o registro do servidor, NUNCA o histórico que veio no corpo da
// requisição (ver a nota em session-quota.js sobre o bypass que isso fecha).
//
// Devolve { ok, state }: `ok` diz se ESTA abertura foi autorizada, e não se
// ainda sobra cota — a terceira sessão é liberada e já deixa o estado esgotado.
async function consumeSessionQuota(user, key) {
  return withFileLock(SESSION_STARTS_FILE, () => {
    const all = readSessionStarts();
    if (sessionQuota.hasOpenSession(all[user.id], key)) {
      return { ok: true, state: sessionQuota.quotaState(all[user.id]) };
    }
    const antes = sessionQuota.quotaState(all[user.id]);
    if (antes.blocked) return { ok: false, state: antes };
    all[user.id] = sessionQuota.registerStart(all[user.id], key);
    writeJSON(SESSION_STARTS_FILE, all);
    return { ok: true, state: sessionQuota.quotaState(all[user.id]) };
  });
}

// Fecha a sessão daquela chave quando o atendimento é finalizado (log salvo).
// O slot continua gasto; o que muda é que reabrir aquele paciente passa a
// custar um slot novo, em vez de continuar de graça pra sempre.
async function closeSessionQuota(user, key) {
  if (!sessionQuota.hasSessionQuota(user && user.role) || !key) return;
  await withFileLock(SESSION_STARTS_FILE, () => {
    const all = readSessionStarts();
    if (!all[user.id]) return;
    all[user.id] = sessionQuota.closeSession(all[user.id], key);
    writeJSON(SESSION_STARTS_FILE, all);
  });
}

// O cliente consulta ANTES de abrir a sessão pra já mostrar o aviso em vez de
// entrar num chat que o servidor vai barrar no primeiro turno.
//
// Aceita ?type=&itemId= — a sessão que ele está prestes a abrir. Sem isso a
// resposta seria "bloqueado" para quem esgotou a cota mas está RETOMANDO um
// atendimento já aberto, e a tela o impediria de terminar o que começou (o
// /api/chat deixaria passar, porque lá a chave aberta é isenta).
app.get('/api/session-quota', requireAuth, (req, res) => {
  const estado = sessionQuotaFor(req.user);
  const chave = sessionQuota.sessionKey({ type: req.query.type, itemId: req.query.itemId });
  if (estado.blocked && chave && sessionQuota.hasOpenSession(readSessionStarts()[req.user.id], chave)) {
    return res.json({ ...estado, blocked: false });
  }
  res.json(estado);
});

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

  // Cota do Aluno Externo: 3 atendimentos por 24h. O slot é cobrado ao ABRIR uma
  // sessão — e quem decide o que é "abrir" é o registro do servidor (a chave
  // tipo+paciente já está aberta?), nunca o histórico que veio no corpo. Conversa
  // em andamento passa direto, pra ninguém ficar preso no meio do atendimento.
  // Esta é a trava de verdade; o modal do cliente é só cortesia.
  if (sessionQuota.hasSessionQuota(req.user.role)) {
    const cota = await consumeSessionQuota(req.user, sessionQuota.sessionKey(context));
    if (!cota.ok) {
      return res.status(429).json({ error: cota.state.message, sessionQuota: cota.state });
    }
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

  // --- Paciente/Personagem ---------------------------------------------------
  // Duas origens de escolha, que não se misturam:
  //   TRILHA  → por EXERCÍCIO (chatModel, ver TRILHA_CHAT_MODELS). Controle
  //             próprio do editor de exercícios; a tela de Modelos de IA não
  //             mexe nele.
  //   O RESTO → por CATEGORIA (Administração → Modelos de IA). O cliente manda a
  //             dica em context.category, e ela passa por
  //             isClientPatientCategory: aceita só os modos que o usuário de fato
  //             inicia na interface (treino/competitivo/duelo).
  //             'seletivo' fica de fora de propósito — senão um aluno poderia
  //             rodar o paciente daquela categoria (possivelmente mais caro) nos
  //             treinos dele. Visitante e neuro são derivados AQUI: role e
  //             context.type são fatos, não dica do cliente.
  // O personagem responde direto, SEM reasoning (menos no preset GLM). Prompt
  // caching da OpenAI é automático no prefixo (>1024 tokens), então o system +
  // histórico (chat de 50-100 turnos) é cacheado sozinho a partir do 2º turno.
  const isExerciseChat = !!(context && context.type === 'exercise');
  const patientCategory = req.user.role === 'visitor' ? 'visitante'
    : (context && context.type === 'neuro') ? 'neuro'
      : aiModels.isClientPatientCategory(context && context.category) ? context.category
        : 'treinamento';
  const chatModelSpec = isExerciseChat
    ? (TRILHA_CHAT_MODELS[resolved.chatModelKey] || TRILHA_CHAT_MODELS[TRILHA_CHAT_MODEL_DEFAULT])
    : patientSpecFor(patientCategory);

  // Modo demonstração: sem cliente pro provedor escolhido E sem OpenAI (que é o
  // fallback de qualquer paciente), não há como responder — devolve a fala
  // padrão em vez de estourar 500.
  if (!getClientForProvider(chatModelSpec.provider) && !getOpenAI()) {
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
    const turno = await runPatientTurn({
      spec: chatModelSpec,
      systemPrompt: resolved.systemPrompt,
      messages,
      maxTokens: tokenCap + 2000,
      label: isExerciseChat ? 'chat trilha' : `chat ${patientCategory}`,
    });
    // Custo dos Logs da Trilha: usage normalizado por provedor (ver
    // normalizeUsage) — o cliente só acumula e repassa, nunca calcula preço.
    // O log usa o normalizado (e não logOpenAIUsage) porque aqui pode ter
    // respondido GLM ou Anthropic, cujos campos de usage têm outros nomes.
    const uso = normalizeUsage(turno.provider, turno.usage);
    console.log(
      `Chat paciente (${turno.model} · ${isExerciseChat ? 'trilha' : patientCategory}): cached=${uso.cacheRead} in=${uso.input} out=${uso.output}`,
    );
    res.json({ role: 'assistant', content: turno.text, usage: uso });
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
// FAMÍLIA v18.25: todos os avaliadores de produção vivem em
// `avaliacao/avaliador 18/`, derivados do mesmo base (avaliador-v18-25.md) com a
// adaptação de cada modo. Saída única em todos: bloco `[notas]` (15 critérios,
// 1–10 ou NA) no início, `[feedback]` + corpo depois. Os prompts v15/v16
// continuam em `avaliacao/`
// só como referência e para o laboratório da Avaliação Independente.
const AVALIACAO_DIR = path.join(PROMPTS_DIR, 'avaliacao');
const AVALIACAO_18_DIR = path.join(AVALIACAO_DIR, 'avaliador 18');

function loadEvaluatorFile(fileName) {
  const promptFile = path.join(AVALIACAO_18_DIR, fileName);
  if (!fs.existsSync(promptFile)) {
    throw new Error(`Prompt do avaliador não encontrado em ${promptFile}`);
  }
  return fs.readFileSync(promptFile, 'utf-8');
}

// Avaliador individual (Treinamento sem progressão, Competitivo, avaliação
// manual): 15 critérios em 6 grupos, nota final calculada no
// scoring.js a partir do bloco [notas].
function loadAvaliacaoPrompt() {
  return loadEvaluatorFile('avaliador-v18-25.md');
}

// Avaliador dedicado do Processo Seletivo: "só-nota", saída curta e direcionada ao
// AVALIADOR (síntese + pontos fortes/fracos + observações), sem o feedback longo
// ao aluno. Mesma régua e mesmos 15 critérios do individual, mas system menor
// (~13k vs ~25k) → corta input; saída curta → corta prosa.
function loadSelecaoEvaluatorPrompt() {
  return loadEvaluatorFile('avaliador-v18-25-processo-seletivo.md');
}

// Avaliador dedicado da Neuroavaliação: sessão única, 4 critérios próprios
// (acolhimento, entrevista, hipótese diagnóstica, bateria de testes) na régua e
// no formato de saída do v18.25. Único modo em que o gabarito diagnóstico pode
// (e deve) ser explicitado ao aluno no feedback.
function loadNeuroEvaluatorPrompt() {
  return loadEvaluatorFile('avaliador-v18-25-neuro.md');
}

// Avaliador comparativo (Duelo): recebe os dois logs do mesmo caso e devolve a
// análise comparativa + bloco [notas] com A1..A15 / B1..B15.
function loadComparativoPrompt() {
  return loadEvaluatorFile('avaliador-v18-25-duelo.md');
}

// Avaliador de progressão: compara dois logs (Atendimento 1 e 2) do mesmo paciente.
// Atendimento 2 é o objeto da avaliação; Atendimento 1 é referência contextual.
// Também é o avaliador das missões (sidequest / missão diária).
function loadProgressaoPrompt() {
  return loadEvaluatorFile('avaliador-v18-25-progressao.md');
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

  // Fora da Trilha, o modelo vem da CATEGORIA (Administração → Modelos de IA):
  // treino/progressão, visitante, neuro ou avaliação manual. O cliente sinaliza
  // o modo em context.mode; sem mode (aba Avaliar Sessão) cai em avaliacaoManual.
  const isFreeSim = !!(context && context.type === 'freeplay' && context.mode === 'training');
  // Trilha (exercícios): modelo é ESCOLHIDO POR EXERCÍCIO (admin, ver
  // TRILHA_EXERCISE_MODELS/evaluatorModel) e NÃO passa pelas categorias — é
  // controle próprio do editor de exercícios. Não entra no progressionMode (que
  // é exclusivo do freeplay/treinamento).
  const isExercise = !!(context && context.type === 'exercise');
  const exerciseModelSpec = isExercise
    ? (TRILHA_EXERCISE_MODELS[resolved.evaluatorModelKey] || TRILHA_EXERCISE_MODELS[TRILHA_EXERCISE_MODEL_DEFAULT])
    : null;
  // Neuro tem categoria própria, fora da régua do treino.
  const isNeuroEval = !!(context && context.type === 'neuro');
  const evalCategory = isExercise ? null
    : req.user.role === 'visitor' ? 'visitante'
      : isNeuroEval ? 'neuro'
        : isFreeSim ? 'treinamento' : 'avaliacaoManual';
  // Spec efetivo da categoria (escolha do admin ou padrão do sistema).
  const categorySpec = evalCategory ? evaluatorSpecFor(evalCategory) : null;
  // Provedor que não é OpenAI (GLM hoje; Claude só via Trilha) roda BUFFERED:
  // uma chamada chat.completions, resposta escrita de uma vez no SSE — a UI já
  // mostra a tela "avaliando", então não perde nada, e o heartbeat segura a
  // conexão. Vale pra Trilha (escolha por exercício) e pra qualquer categoria em
  // que o admin escolheu GLM. FALLBACK pro OpenAI se o provedor falhar.
  const isExerciseAltProvider = isExercise && exerciseModelSpec.provider !== 'openai';
  const isCategoryAltProvider = !!(categorySpec && categorySpec.provider !== 'openai');
  // evalModel/evalEffort = o caminho OpenAI. Quando o primário já é OpenAI, é o
  // próprio primário; quando é GLM, é a rede de segurança do fallback.
  const categoryFallback = evalCategory ? evaluatorOpenaiFallback(evalCategory) : null;
  let systemPrompt = resolved.systemPrompt;
  let evalModel = isExercise
    ? (isExerciseAltProvider ? OPENAI_EXERCISE_MODEL : exerciseModelSpec.model)
    : (isCategoryAltProvider ? categoryFallback.model : categorySpec.model);
  let evalEffort = isExercise
    ? (isExerciseAltProvider ? OPENAI_EXERCISE_EFFORT : exerciseModelSpec.effort)
    : (isCategoryAltProvider ? categoryFallback.effort : categorySpec.effort);
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
        const prevSection = buildPreviousEvalSection(getPreviousFeedback(req.user.id, context.itemId));
        if (prevSection) content += `${prevSection}\n---\n\n`;
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

  // Exercício da Trilha com avaliador OpenAI (mini/5.4/5.5): SEMPRE em Batch —
  // decisão do dono (custo antes de velocidade aqui; GLM/Claude continuam
  // síncronos, ver isExerciseAltProvider). Enfileira e devolve JSON comum (sem
  // SSE); o cliente troca sozinho pra polling (ver api.evaluate/pollTrilhaEvalBatch
  // no client) em GET /api/trilha/evaluate-batch/:jobId. sweepTrilhaEvalBatches()
  // já dispara a submissão agora — o coletor de boot cobre o resto.
  if (isExercise && !isExerciseAltProvider) {
    const job = {
      id: 'trilha-batch-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      userId: req.user.id,
      itemId: context.itemId,
      model: evalModel,
      effort: evalEffort,
      systemPrompt,
      inputTurns,
      status: 'processing',
      batchId: null,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    await withFileLock('trilha-eval-queue.json', async () => {
      const arr = readJSON('trilha-eval-queue.json');
      arr.push(job);
      writeJSON('trilha-eval-queue.json', arr);
    });
    sweepTrilhaEvalBatches().catch(() => {});
    upsertEvaluationNotification(req.user.id, 'trilha-job:' + job.id, {
      type: 'evaluation_queued',
      message: EVAL_QUEUED_MESSAGE,
    });
    return res.json({ pending: true, jobId: job.id });
  }

  // "Sua avaliação está na fila" pra todo mundo que chega até aqui (Treinamento,
  // Neuro, Trilha síncrona GLM/Claude): mesmo sendo síncrono no servidor, a
  // chamada ao avaliador leva 30-90s+ (ver evaluator-prompts-and-streaming), e o
  // "pronta" só sai quando o cliente salva o log em POST /api/logs — então há um
  // intervalo real em que vale avisar (ex.: aluno minimiza o app no celular).
  // refId por usuário (não por sessão): não há um id compartilhado entre esta
  // requisição SSE e o POST /api/logs que vem depois sem plumbing extra no
  // client; um slot por usuário é suficiente (o pior caso de duas avaliações
  // simultâneas do mesmo aluno só reusa a mesma linha, sem quebrar nada).
  if (isFreeSim || isNeuroEval || isExercise) {
    upsertEvaluationNotification(req.user.id, 'eval:' + req.user.id, {
      type: 'evaluation_queued',
      message: EVAL_QUEUED_MESSAGE,
    });
  }

  // Reasoning visível: SÓ pra supervisor/admin e SÓ quando o cliente pede (aba
  // Avaliar Sessão). O resumo do raciocínio referencia o Bloco 1 — jamais pode
  // chegar ao aluno. O gate é por ROLE no servidor: a rota /avaliacao não tem
  // guard de role no cliente (só o link some do nav), então não dá pra confiar
  // no front. Aluno nunca recebe os eventos `data:{reasoning}`.
  const canSeeReasoning = !!(req.user && (req.user.role === 'supervisor' || req.user.role === 'admin'));
  const streamReasoning = canSeeReasoning && showReasoning === true;

  try {
    // Avaliador v18.25 no GPT-5.4 (reasoning) via Responses API. O modelo cruza
    // Bloco 1 × log e pontua os 15 critérios no canal de reasoning OCULTO — não
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
      if (isCategoryAltProvider) {
        // Categoria com avaliador de OUTRO provedor (GLM 5.2 — o único fora da
        // OpenAI nas opções de avaliador). Roda BUFFERED: uma chamada
        // chat.completions e a resposta inteira de uma vez no SSE. A UI já mostra
        // a tela "avaliando", então não perde nada, e o heartbeat acima segura a
        // conexão. É o padrão histórico do Treinamento, agora valendo pra
        // qualquer categoria onde o admin escolheu GLM. FALLBACK: se falhar
        // (rate limit/instabilidade/sem key), refaz no OpenAI de segurança
        // (evalModel/evalEffort) — o aluno sempre recebe nota+feedback.
        let full = '';
        const tProvider = categorySpec.provider;
        const tClient = getClientForProvider(tProvider);
        try {
          if (!tClient) throw new Error(`${tProvider} indisponível`);
          const body = buildChatBody({
            provider: tProvider, model: categorySpec.model, effort: categorySpec.effort,
            maxTokens: 64000, messages: [{ role: 'developer', content: systemPrompt }, ...inputTurns],
          });
          const resp = await tClient.chat.completions.create(body);
          full = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
          if (!full.trim()) throw new Error('resposta vazia');
          usage = resp.usage || null;
          usageProvider = tProvider;
          usageModel = categorySpec.model;
          console.log(`Evaluate (${categorySpec.model} · ${evalCategory}${progressionMode ? '+progressão' : ''})`);
        } catch (glmErr) {
          console.error(`[evaluate ${evalCategory}] ${categorySpec.model} falhou → fallback ${evalModel}/${evalEffort}:`, glmErr.message);
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
        `Evaluate (${usageModel}${progressionMode ? ' · progressão' + (sidequestActive ? '+sidequest' : '') : (isExercise ? ' · trilha' : ` · ${evalCategory}`)}): cached=${normalizedUsage.cacheRead} in=${normalizedUsage.input} out=${normalizedUsage.output}`,
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
// Default vem da env var (compat com quem nunca trocou); qualquer avaliador/admin
// pode trocar em runtime pela tela (fica salva em settings.json, sobrevive a
// redeploy — env var nunca é regravada em disco).
const SELECAO_PASSWORD_DEFAULT = process.env.SELECAO_PASSWORD || 'allos01';
function selecaoPasswordAtual() {
  const s = readSettings();
  return typeof s.selecaoPassword === 'string' && s.selecaoPassword ? s.selecaoPassword : SELECAO_PASSWORD_DEFAULT;
}

// Comparação em tempo constante: com `!==`, o tempo de resposta vaza quantos
// caracteres iniciais bateram. Não é o vetor mais provável aqui, mas custa 4 linhas.
function senhaSelecaoConfere(entrada) {
  const a = Buffer.from(String(entrada == null ? '' : entrada), 'utf8');
  const b = Buffer.from(selecaoPasswordAtual(), 'utf8');
  // timingSafeEqual exige buffers do mesmo tamanho; compara contra si mesmo
  // pra não responder mais rápido só porque o comprimento difere.
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}
// Secret de M2M pro backup externo (Google Apps Script) puxar os logs antes da
// poda de 15 dias. Deliberadamente separado do JWT: quem chama é um script
// agendado, sem sessão de usuário — não faz sentido reautenticar a cada corrida.
// Vazio = endpoint desligado (nenhum backup configurado ainda).
const SELECAO_EXPORT_SECRET = process.env.SELECAO_EXPORT_SECRET || '';
function selecaoExportSecretConfere(informado) {
  if (!SELECAO_EXPORT_SECRET) return false;
  const a = Buffer.from(String(informado == null ? '' : informado), 'utf8');
  const b = Buffer.from(SELECAO_EXPORT_SECRET, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}
function requireSelecaoExportSecret(req, res, next) {
  if (!SELECAO_EXPORT_SECRET) return res.status(503).json({ error: 'Backup do Processo Seletivo não configurado (SELECAO_EXPORT_SECRET ausente).' });
  if (!selecaoExportSecretConfere(req.get('X-Export-Secret'))) return res.status(401).json({ error: 'Não autorizado.' });
  next();
}
// Slug de nome de arquivo (mesmo padrão do buildDuelExport).
function selecaoExportSlug(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const SELECTION_LOG_TTL_DAYS = 15; // regra "1 avaliação por WhatsApp a cada 15 dias"
const SELECTION_LOG_TTL_MS = SELECTION_LOG_TTL_DAYS * 24 * 60 * 60 * 1000;
// Nota mínima p/ contar como candidato ATIVO. Subiu de 40 pra 55 junto com a
// migração pro avaliador v18.25: o seletivo roda no GPT-5.5 (batch), que pontua
// mais alto que o GLM em que o corte de 40 foi calibrado, então o mesmo 40
// deixaria passar candidato mediano. Muda só a etiqueta ativo/rejeitado e a
// contagem da dashboard — a nota em si não se move, e logs já avaliados
// conservam o status que receberam na época.
const SELECTION_ACTIVE_THRESHOLD = 55;
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

const SELECAO_STATUS_LABEL = { ativo: 'Ativo', rejeitado: 'Rejeitado', pending: 'Em avaliação (lote)', erro: 'Erro' };

// Texto completo (log + avaliação) de um candidato, no MESMO formato que o
// avaliador já baixa em "Tudo" na tela de Logs (client/SelecaoLogs.jsx). Usado
// pelo backup externo (Google Apps Script), que salva isto num .txt no Drive
// antes do TTL de 15 dias apagar o log original.
function buildSelectionExportText(log) {
  const c = log.candidate || {};
  const transcript = buildSelectionTranscript(log.messages, log.characterName);
  const logStr = [
    'PROCESSO SELETIVO — LOG DO ATENDIMENTO', '',
    `Candidato: ${c.nome || '—'}`,
    `E-mail: ${c.email || '—'}`,
    `WhatsApp: ${c.whatsapp || '—'}`,
    `Faculdade: ${c.faculdade || '—'}`,
    `Período: ${c.periodo || '—'}`,
    `Caso: ${log.characterName || '—'}`,
    `Data: ${log.timestamp ? new Date(log.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`, '',
    transcript || '(sem mensagens)',
  ].join('\n');

  const hasEval = log.status === 'ativo' || log.status === 'rejeitado' || log.score != null;
  if (!hasEval) return logStr;

  const evalBody = [
    `Nota final: ${log.score == null ? '—' : `${log.score}/100`}`,
    `Status: ${SELECAO_STATUS_LABEL[log.status] || log.status}`, '',
    (log.evaluation || '').trim() || '(sem texto de avaliação)',
  ].join('\n');
  return `${logStr}\n\n===========================\nAVALIAÇÃO DA IA\n===========================\n\n${evalBody}`;
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
// tira o bloco de notas e calcula a nota em código (scoring.js). Sem saudação —
// quem lê é o recrutador, e o candidato nunca vê nota nem feedback.
function parseSelectionEval(rawText) {
  const { clean, criteria } = extractSupervisorNotes(rawText || '', { greeting: false });
  let score = null;
  if (criteria) {
    const computed = finalScoreFromCriteria(criteria);
    if (computed !== null) score = computed;
  }
  return { evaluation: clean, criteriaScores: criteria, score };
}

// ============================================================================
// FILA LOCAL NA FRENTE DA BATCH API
// ----------------------------------------------------------------------------
// A OpenAI limita, por (organização, modelo), quantos tokens podem estar
// ENFILEIRADOS em batches ao mesmo tempo — e conta o TETO de cada requisição
// (input + max_completion_tokens), não o que ela vai gastar. Quando o teto
// estoura, `batches.create` responde 200 e o batch morre depois, na validação,
// com `token_limit_exceeded`.
//
// Os QUATRO modos que usam batch (Seletivo, Competitivo, Trilha e Avaliação
// Independente) dividem esse mesmo teto, então a contabilidade tem de ser
// compartilhada: é o que este ledger faz. Cada batch submetido entra com a sua
// estimativa de tokens; sai quando o batch termina (ou quando envelhece além da
// janela de 24h, caso o coletor tenha perdido o desfecho).
//
// A régua de decisão está em server/batch-fila.js (pura, testada). Aqui mora só
// o I/O: ler o ledger, gravar, e responder "cabe agora?".
const LEDGER_FILE = 'batch-ledger.json';

// Tokens que este conjunto de corpos de requisição vai RESERVAR na fila.
function tokensDoLote(bodies) {
  return bodies.reduce((soma, body) => soma + batchFila.tokensDaRequisicao(body, estimarTokens), 0);
}

// Quanto do teto do modelo já está ocupado por batches em voo (de qualquer modo).
function tokensEmVoo(model) {
  return batchFila.tokensEmVooDe(readJSON(LEDGER_FILE, []), model);
}

// Cabe um lote de `tokens` deste modelo agora?
function cabeNaFilaDaOpenAI(model, tokens) {
  return batchFila.temVaga({ model, tokens, tokensEmVoo: tokensEmVoo(model) });
}

// Registra um batch recém-criado como ocupante da fila.
async function registrarBatchEmVoo({ batchId, model, tokens, modo }) {
  await withFileLock(LEDGER_FILE, async () => {
    const arr = readJSON(LEDGER_FILE, []).filter((e) => e && !batchFila.ledgerExpirado(e));
    arr.push({ batchId, model, tokens, modo, criadoEm: new Date().toISOString() });
    writeJSON(LEDGER_FILE, arr);
  });
}

// Libera a vaga: chamado assim que um batch chega a estado terminal. Sem isto o
// ledger só esvaziaria pela idade (26h) e a fila ficaria artificialmente cheia.
async function liberarBatchDaFila(batchId) {
  await withFileLock(LEDGER_FILE, async () => {
    const arr = readJSON(LEDGER_FILE, []);
    const restante = arr.filter((e) => e && e.batchId !== batchId && !batchFila.ledgerExpirado(e));
    if (restante.length !== arr.length) writeJSON(LEDGER_FILE, restante);
  });
}

// Cria o batch a partir dos corpos já montados, com a vaga já conferida por quem
// chama. Devolve o objeto do batch e deixa o ledger em dia.
async function criarBatchRegistrado({ openai, requests, model, modo }) {
  const jsonl = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const file = await openai.files.create({ file: await toBatchFile(jsonl), purpose: 'batch' });
  const batch = await openai.batches.create({ input_file_id: file.id, endpoint: '/v1/chat/completions', completion_window: '24h' });
  await registrarBatchEmVoo({ batchId: batch.id, model, tokens: tokensDoLote(requests.map((r) => r.body)), modo });
  return batch;
}

// Submete os pendentes de um modo em LOTES que caibam na fila da OpenAI, na
// ordem de chegada. `itens` é [{ id, body }]; devolve um Map id → batchId com
// os que entraram AGORA. O que não coube não é perdido nem marcado: fica
// pendente e volta no próximo ciclo do sweep (a cada 3 minutos) — é a fila
// esperando vaga, que é o comportamento que 20 pessoas submetendo ao mesmo
// tempo precisam ter.
async function submeterPendentesEmLotes({ openai, itens, model, modo, rotulo }) {
  const destino = new Map();
  if (!itens.length) return destino;
  const comTokens = itens.map((it) => ({ ...it, tokens: batchFila.tokensDaRequisicao(it.body, estimarTokens) }));
  const lotes = batchFila.dividirEmLotes({ itens: comTokens, model, tokensEmVoo: tokensEmVoo(model) });

  for (const lote of lotes) {
    const requests = lote.map((it) => ({ custom_id: String(it.id), method: 'POST', url: '/v1/chat/completions', body: it.body }));
    let batch;
    try {
      batch = await criarBatchRegistrado({ openai, requests, model, modo });
    } catch (e) {
      // Recusa na própria criação (429, indisponibilidade): os itens deste lote
      // continuam pendentes e tentam de novo no próximo ciclo.
      console.error(`[${modo}] criação do batch falhou (${lote.length} ${rotulo} seguem na fila):`, e.message);
      break;
    }
    for (const it of lote) destino.set(it.id, batch.id);
    console.log(`[${modo}] submetidos ${lote.length} ${rotulo} no batch ${batch.id}`);
  }

  const esperando = itens.length - destino.size;
  if (esperando > 0) {
    console.log(`[${modo}] ${esperando} ${rotulo} sem vaga na fila da OpenAI agora — voltam no próximo ciclo`);
  }
  return destino;
}

// Desfecho de um batch que não completou, já com a vaga liberada e o teto
// aprendido (quando a recusa revelou o número). Devolve o que o coletor do modo
// deve fazer: 'espera' | 'retenta' | 'erro' (ver batch-fila.js).
async function fecharBatchQueFalhou({ batchObj, model, tentativas = 0, modo }) {
  const r = batchFila.classificarFalha(batchObj, tentativas);
  if (r.teto && batchFila.aprenderTeto(model, r.teto)) {
    console.log(`[batch-fila] teto de ${model} aprendido com a recusa: ${r.teto.toLocaleString('pt-BR')} tokens enfileirados`);
  }
  await liberarBatchDaFila(batchObj.id);
  console.log(`[${modo}] batch ${batchObj.id} ${batchObj.status} → ${r.acao}${r.motivo ? ' — ' + r.motivo : ''}`);
  return r;
}

// Cria um File (multipart) a partir do JSONL do batch, sem tocar em disco.
function toBatchFile(jsonl) {
  const O = require('openai');
  const toFile = O.toFile || (O.default && O.default.toFile);
  return toFile(Buffer.from(jsonl, 'utf-8'), 'selecao-batch.jsonl', { type: 'application/jsonl' });
}

// Avaliação do Seletivo em BATCH — o candidato nunca vê nota nem raciocínio (o
// /finish já respondeu só o agradecimento), então pode esperar as até 24h do
// batch e ganhar os 50% de desconto. Só vale para modelo OpenAI: quando o admin
// escolhe GLM na categoria, `spec.batch` vem false e a avaliação vai pelo
// caminho síncrono em background (ver runPendingEvalsWithoutBatch).
function buildSelectionEvalBody(log, spec) {
  const { prompt, inputTurns } = selectionEvalParts(log);
  return {
    model: spec.model,
    reasoning_effort: spec.effort,
    max_completion_tokens: 64000,
    messages: buildOpenAIMessages(prompt, inputTurns),
  };
}

// Avaliação SÍNCRONA de um item pendente, para quando o modelo escolhido não tem
// Batch API (GLM). Roda em background no mesmo sweep: nada na UX muda — quem
// finalizou já saiu sem nota e ela entra no log quando chegar; por este caminho
// só chega mais rápido, sem o desconto do batch.
async function runEvalWithoutBatch({ spec, systemPrompt, inputTurns }) {
  // Só chat.completions aqui (OpenAI e GLM). A Anthropic usa a Messages API, com
  // outra forma — se algum dia Claude entrar em EVALUATOR_PRESETS, este caminho
  // precisa do buildAnthropicArgs (como runPatientTurn faz). Falha explícita em
  // vez de um TypeError obscuro em `client.chat`.
  if (spec.provider === 'anthropic') {
    throw new Error('avaliação sem batch não suporta Anthropic (usaria a Messages API)');
  }
  const client = getClientForProvider(spec.provider);
  if (!client) throw new Error(`${spec.provider} indisponível`);
  const resp = await client.chat.completions.create(buildChatBody({
    provider: spec.provider, model: spec.model, effort: spec.effort,
    maxTokens: 64000, messages: buildOpenAIMessages(systemPrompt, inputTurns),
  }));
  const text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || '';
  if (!String(text).trim()) throw new Error('resposta vazia');
  // normalizeUsage (e não logOpenAIUsage): este caminho roda GLM, cujo usage tem
  // outros nomes de campo e sub-reporta o thinking em completion_tokens.
  const uso = normalizeUsage(spec.provider, resp.usage || null);
  console.log(`Avaliação sem batch (${spec.model}): cached=${uso.cacheRead} in=${uso.input} out=${uso.output}`);
  return text;
}

// Quantas vezes tentamos o caminho síncrono antes de desistir e marcar erro.
// Batch que falha marca erro na hora; aqui a falha costuma ser transitória
// (rate limit da z.ai, instabilidade), então vale retentar nos sweeps seguintes.
const EVAL_SYNC_MAX_ATTEMPTS = 3;

let selectionSweepRunning = false;

// Submete os logs do seletivo pendentes (status 'pending' && !evalBatchId).
// Só roda quando o avaliador da categoria tem Batch API; com GLM escolhido, quem
// avalia é runSelectionEvalsWithoutBatch.
async function submitSelectionBatches(openai) {
  const spec = evaluatorSpecFor('seletivo');
  if (!spec.batch) return;
  const pending = readJSON('selection-logs.json').filter((l) => l && l.status === 'pending' && !l.evalBatchId);
  if (!pending.length) return;
  const itens = [];
  for (const log of pending) {
    try { itens.push({ id: log.id, body: buildSelectionEvalBody(log, spec) }); }
    catch (e) { console.error('[selecao-batch] corpo:', e.message); }
  }
  const destino = await submeterPendentesEmLotes({ openai, itens, model: spec.model, modo: 'selecao-batch', rotulo: 'candidato(s)' });
  if (!destino.size) return;
  await withFileLock('selection-logs.json', async () => {
    const arr = readJSON('selection-logs.json');
    for (const l of arr) {
      const bid = destino.get(l.id);
      if (bid && l.status === 'pending' && !l.evalBatchId) { l.evalBatchId = bid; l.evalBatchAt = new Date().toISOString(); }
    }
    writeJSON('selection-logs.json', arr);
  });
}

// Fecha os logs do seletivo com o texto do avaliador: status/score/
// criteriaScores/evaluation no log + append no selection-stats.json + TRI. É o
// MESMO caminho para batch e para o síncrono (só muda de onde veio o texto), pra
// não existirem duas versões da régua ativo/rejeitado.
//
// `ids` = os logs que estavam nesta rodada; quem não tem texto em `results` é
// marcado com erro usando a mensagem `motivoSemResultado`. O raciocínio fica
// vazio — chat.completions não devolve o texto do reasoning (só a contagem).
async function finalizeSelectionEvals(ids, results, motivoSemResultado) {
  const alvo = new Set(ids.map(String));
  const appendedList = [];
  const triList = [];
  await withFileLock('selection-logs.json', async () => {
    const arr = readJSON('selection-logs.json');
    for (const l of arr) {
      if (!alvo.has(String(l.id)) || l.status !== 'pending') continue;
      if (results.has(l.id) && results.get(l.id)) {
        const { evaluation, criteriaScores, score } = parseSelectionEval(results.get(l.id));
        const st = score == null ? 'erro' : (score >= SELECTION_ACTIVE_THRESHOLD ? 'ativo' : 'rejeitado');
        l.status = st;
        l.score = score;
        l.criteriaScores = criteriaScores;
        l.evaluation = clampStr(evaluation, LOG_MAX_EVAL_LEN);
        l.reasoning = '';
        if (score != null) {
          appendedList.push({ timestamp: l.timestamp, score, status: st });
          triList.push({ characterId: l.characterId, score });
        }
      } else {
        l.status = 'erro'; l.evalError = motivoSemResultado;
      }
    }
    writeJSON('selection-logs.json', arr);
  });
  if (appendedList.length) {
    await withFileLock('selection-stats.json', async () => {
      const stats = readJSON('selection-stats.json');
      stats.push(...appendedList);
      writeJSON('selection-stats.json', stats);
    });
  }
  // TRI: o candidato entra com rating fixo 50 e o personagem aprende. Só
  // com nota válida — avaliação com erro não é sinal.
  for (const t of triList) {
    await registrarTriAnonimo('selecao', t.characterId, t.score);
  }
}

// Seletivo com avaliador SEM Batch API (GLM): avalia um pendente por vez, em
// background. Falha transitória não queima o candidato — conta a tentativa e
// tenta de novo no próximo sweep, marcando erro só depois de EVAL_SYNC_MAX_ATTEMPTS.
async function runSelectionEvalsWithoutBatch() {
  const spec = evaluatorSpecFor('seletivo');
  if (spec.batch) return;
  const pending = readJSON('selection-logs.json').filter((l) => l && l.status === 'pending' && !l.evalBatchId);
  for (const log of pending) {
    try {
      const { prompt, inputTurns } = selectionEvalParts(log);
      const text = await runEvalWithoutBatch({ spec, systemPrompt: prompt, inputTurns });
      await finalizeSelectionEvals([log.id], new Map([[log.id, text]]), 'sem resultado');
      console.log(`[selecao-sync] candidato ${log.id} avaliado em ${spec.model} (sem batch)`);
    } catch (e) {
      const tentativas = (Number(log.evalAttempts) || 0) + 1;
      const desistiu = tentativas >= EVAL_SYNC_MAX_ATTEMPTS;
      await withFileLock('selection-logs.json', async () => {
        const arr = readJSON('selection-logs.json');
        const alvo = arr.find((l) => String(l.id) === String(log.id) && l.status === 'pending');
        if (!alvo) return;
        alvo.evalAttempts = tentativas;
        if (desistiu) { alvo.status = 'erro'; alvo.evalError = `avaliação síncrona falhou: ${e.message}`; }
        writeJSON('selection-logs.json', arr);
      });
      console.error(`[selecao-sync] ${log.id} falhou (tentativa ${tentativas}/${EVAL_SYNC_MAX_ATTEMPTS})${desistiu ? ' — marcado com erro' : ''}:`, e.message);
    }
  }
}

// Coleta os batches prontos e fecha os logs (ver finalizeSelectionEvals).
async function collectSelectionBatches(openai) {
  const withBatch = readJSON('selection-logs.json').filter((l) => l && l.status === 'pending' && l.evalBatchId);
  if (!withBatch.length) return;
  const batchIds = [...new Set(withBatch.map((l) => l.evalBatchId))];
  for (const bid of batchIds) {
    let batch;
    try { batch = await openai.batches.retrieve(bid); } catch (e) { console.error('[selecao-batch] retrieve:', e.message); continue; }

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
      const idsDoBatch = withBatch.filter((l) => l.evalBatchId === bid).map((l) => l.id);
      await liberarBatchDaFila(bid);
      await finalizeSelectionEvals(idsDoBatch, results, 'sem resultado no batch');
      console.log(`[selecao-batch] batch ${bid} completo: ${results.size} candidato(s)`);
    } else if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batch.status)) {
      // Fila cheia ou falha passageira devolve o candidato para a fila em vez de
      // queimá-lo: sem evalBatchId ele volta a ser "pendente" e o próximo ciclo
      // resubmete. Só vira erro o que não tem volta.
      const tentativas = Math.max(0, ...withBatch.filter((l) => l.evalBatchId === bid).map((l) => Number(l.evalBatchTentativas) || 0));
      const r = await fecharBatchQueFalhou({ batchObj: batch, model: evaluatorSpecFor('seletivo').model, tentativas, modo: 'selecao-batch' });
      await withFileLock('selection-logs.json', async () => {
        const arr = readJSON('selection-logs.json');
        for (const l of arr) {
          if (l.evalBatchId !== bid || l.status !== 'pending') continue;
          if (r.acao === 'erro') { l.status = 'erro'; l.evalError = r.motivo; continue; }
          l.evalBatchId = null;
          l.evalBatchEspera = r.motivo;
          if (r.acao === 'retenta') l.evalBatchTentativas = (Number(l.evalBatchTentativas) || 0) + 1;
        }
        writeJSON('selection-logs.json', arr);
      });
    }
  }
}

// Um sweep cobre os dois caminhos: coleta/submete batches (quando o avaliador é
// OpenAI) e avalia os pendentes de forma síncrona (quando é GLM). A parte de
// batch exige a chave da OpenAI; a síncrona não — daí o `if` só em volta dela, e
// não em volta do sweep inteiro (senão trocar pra GLM sem OPENAI_API_KEY deixaria
// os candidatos pendentes pra sempre). Coletar SEMPRE roda quando há chave, pra
// fechar batch antigo mesmo depois de o admin trocar o modelo pra GLM.
async function sweepSelectionBatches() {
  if (selectionSweepRunning) return;
  selectionSweepRunning = true;
  try {
    const openai = getOpenAI();
    if (openai) {
      await collectSelectionBatches(openai);
      await submitSelectionBatches(openai);
    }
    await runSelectionEvalsWithoutBatch();
  } catch (e) {
    console.error('[selecao-batch] sweep erro:', e.message);
  } finally {
    selectionSweepRunning = false;
  }
}

// ============================================================================
// COMPETITIVO — avaliação ASSÍNCRONA via OpenAI Batch API (GPT 5.5 high)
// O aluno finaliza e recebe só um agradecimento; a nota + feedback + MMR entram no
// log dele em até 24h. O log aparece JÁ como 'pendente' em Minhas Sessões (fica em
// logs.json com evaluationPending:true) e é o próprio "job" do batch.
// ============================================================================
// Partes do input da avaliação do competitivo (prompt + Bloco 1 + transcrição) —
// compartilhado pelo batch e pelo caminho síncrono.
function competitiveEvalParts(log) {
  const char = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(log.itemId));
  const patientName = log.itemTitle || (char && char.name) || 'Paciente';
  const transcript = transcriptFromMessages(log.messages || [], log.userName || 'Aluno', patientName);
  const evalUser = { role: 'user', content: `[LOG DO ATENDIMENTO]\nSessão: Competitivo\nPersonagem: ${patientName}\n\n${transcript}` };
  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: log.itemId } });
  return { prompt: loadAvaliacaoPrompt(), inputTurns: withBloco1([evalUser], bloco1) };
}

function buildCompetitiveEvalBody(log, spec) {
  const { prompt, inputTurns } = competitiveEvalParts(log);
  return {
    model: spec.model,
    reasoning_effort: spec.effort,
    max_completion_tokens: 64000,
    messages: buildOpenAIMessages(prompt, inputTurns),
  };
}

let competitiveSweepRunning = false;

// Submete os logs competitivos pendentes (evaluationPending && !evalBatchId).
// Só quando o avaliador da categoria tem Batch API — com GLM escolhido quem
// avalia é runCompetitiveEvalsWithoutBatch.
async function submitCompetitiveBatches(openai) {
  const spec = evaluatorSpecFor('competitivo');
  if (!spec.batch) return;
  const pending = readJSON('logs.json').filter((l) => l && l.mode === 'competitive' && l.evaluationPending && !l.evalBatchId);
  if (!pending.length) return;
  const itens = [];
  for (const log of pending) {
    try { itens.push({ id: log.id, body: buildCompetitiveEvalBody(log, spec) }); }
    catch (e) { console.error('[comp-batch] corpo:', e.message); }
  }
  const destino = await submeterPendentesEmLotes({ openai, itens, model: spec.model, modo: 'comp-batch', rotulo: 'competitivo(s)' });
  if (!destino.size) return;
  await withFileLock('logs.json', async () => {
    const arr = readJSON('logs.json');
    for (const l of arr) {
      const bid = destino.get(l.id);
      if (bid && l.evaluationPending && !l.evalBatchId) { l.evalBatchId = bid; l.evalBatchAt = new Date().toISOString(); }
    }
    writeJSON('logs.json', arr);
  });
}

// Fecha os logs competitivos com o texto do avaliador: nota/feedback no log,
// zera o pending e aplica o MMR. MESMO caminho para batch e para o síncrono, pra
// o gate do MMR existir num só lugar.
async function finalizeCompetitiveEvals(ids, results, motivoSemResultado) {
  const alvo = new Set(ids.map(String));
  const ready = []; // { userId, refId, itemTitle } — notificados DEPOIS do lock (ver fim da função)
  await withFileLock('logs.json', async () => {
    const arr = readJSON('logs.json');
    let mmr = null; let mmrChanged = false;
    for (const l of arr) {
      if (!alvo.has(String(l.id)) || !l.evaluationPending) continue;
      if (results.has(l.id) && results.get(l.id)) {
        const { evaluation, criteriaScores, score } = parseSelectionEval(results.get(l.id));
        l.evaluation = clampStr(evaluation, LOG_MAX_EVAL_LEN);
        l.criteriaScores = criteriaScores;
        l.score = score;
        l.evaluationPending = false;
        if (l.userId) ready.push({ userId: l.userId, refId: 'log:' + l.id, itemTitle: l.itemTitle });
        // MMR (mesmo gate do /api/logs): nota numérica + itemId + usuário real.
        if (Number.isFinite(score) && l.itemId && l.userId && !String(l.userId).startsWith('visitor-')) {
          if (!mmr) mmr = readMMR();
          const { player, character, result } = mmrEngine.updateMatch(mmr.players[l.userId], mmr.characters[l.itemId], score);
          mmr.players[l.userId] = player; mmr.characters[l.itemId] = character; mmrChanged = true;
          if (!result.calibratingBefore) bumpTriFonte(mmr, l.itemId, 'competitivo');
          l.mmrBefore = Math.round(result.P_before); l.mmrAfter = Math.round(result.P_after);
          // Recorde 👑 do paciente — mesmo gate do MMR. Este é o caminho normal
          // do Competitivo (a nota só existe depois da avaliação assíncrona).
          try {
            updateCharacterRecord(l.itemId, score, { userId: l.userId, userName: l.userName });
          } catch (err) {
            console.error('updateCharacterRecord (batch) falhou:', err.message);
          }
        }
      } else {
        l.evaluationPending = false; l.evalError = motivoSemResultado;
      }
    }
    writeJSON('logs.json', arr);
    if (mmrChanged) writeMMR(mmr);
  });
  for (const r of ready) {
    upsertEvaluationNotification(r.userId, r.refId, {
      type: 'evaluation_ready',
      message: `Sua avaliação${r.itemTitle ? ` de "${r.itemTitle}"` : ''} está pronta.`,
    });
  }
}

// Competitivo com avaliador SEM Batch API (GLM): avalia um pendente por vez, em
// background. O aluno já viu "nota em até 24h", então por aqui só chega antes.
// Falha transitória retenta no próximo sweep (ver EVAL_SYNC_MAX_ATTEMPTS).
async function runCompetitiveEvalsWithoutBatch() {
  const spec = evaluatorSpecFor('competitivo');
  if (spec.batch) return;
  const pending = readJSON('logs.json').filter((l) => l && l.mode === 'competitive' && l.evaluationPending && !l.evalBatchId);
  for (const log of pending) {
    try {
      const { prompt, inputTurns } = competitiveEvalParts(log);
      const text = await runEvalWithoutBatch({ spec, systemPrompt: prompt, inputTurns });
      await finalizeCompetitiveEvals([log.id], new Map([[log.id, text]]), 'sem resultado');
      console.log(`[comp-sync] log ${log.id} avaliado em ${spec.model} (sem batch)`);
    } catch (e) {
      const tentativas = (Number(log.evalAttempts) || 0) + 1;
      const desistiu = tentativas >= EVAL_SYNC_MAX_ATTEMPTS;
      await withFileLock('logs.json', async () => {
        const arr = readJSON('logs.json');
        const alvo = arr.find((l) => String(l.id) === String(log.id) && l.evaluationPending);
        if (!alvo) return;
        alvo.evalAttempts = tentativas;
        if (desistiu) { alvo.evaluationPending = false; alvo.evalError = `avaliação síncrona falhou: ${e.message}`; }
        writeJSON('logs.json', arr);
      });
      console.error(`[comp-sync] ${log.id} falhou (tentativa ${tentativas}/${EVAL_SYNC_MAX_ATTEMPTS})${desistiu ? ' — marcado com erro' : ''}:`, e.message);
    }
  }
}

// Coleta os batches prontos e fecha os logs (ver finalizeCompetitiveEvals).
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
      const idsDoBatch = withBatch.filter((l) => l.evalBatchId === bid).map((l) => l.id);
      await liberarBatchDaFila(bid);
      await finalizeCompetitiveEvals(idsDoBatch, results, 'sem resultado no batch');
      console.log(`[comp-batch] batch ${bid} completo: ${results.size} avaliado(s)`);
    } else if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batch.status)) {
      // O aluno já saiu da sessão com "sua nota sai em até 24h". Fila cheia não
      // pode transformar isso em "sem nota": limpar o evalBatchId devolve o log
      // ao conjunto de pendentes, e o próximo ciclo tenta de novo.
      const tentativas = Math.max(0, ...withBatch.filter((l) => l.evalBatchId === bid).map((l) => Number(l.evalBatchTentativas) || 0));
      const r = await fecharBatchQueFalhou({ batchObj: batch, model: evaluatorSpecFor('competitivo').model, tentativas, modo: 'comp-batch' });
      await withFileLock('logs.json', async () => {
        const arr = readJSON('logs.json');
        for (const l of arr) {
          if (l.evalBatchId !== bid || !l.evaluationPending) continue;
          if (r.acao === 'erro') { l.evaluationPending = false; l.evalError = r.motivo; continue; }
          l.evalBatchId = null;
          l.evalBatchEspera = r.motivo;
          if (r.acao === 'retenta') l.evalBatchTentativas = (Number(l.evalBatchTentativas) || 0) + 1;
        }
        writeJSON('logs.json', arr);
      });
    }
  }
}

// Mesma estrutura do sweep do Seletivo: batch só com chave da OpenAI, síncrono
// sempre (senão trocar pra GLM deixaria os pendentes parados pra sempre).
async function sweepCompetitiveBatches() {
  if (competitiveSweepRunning) return;
  competitiveSweepRunning = true;
  try {
    const openai = getOpenAI();
    if (openai) {
      await collectCompetitiveBatches(openai);
      await submitCompetitiveBatches(openai);
    }
    await runCompetitiveEvalsWithoutBatch();
  } catch (e) {
    console.error('[comp-batch] sweep erro:', e.message);
  } finally {
    competitiveSweepRunning = false;
  }
}

// ============================================================================
// TRILHA (exercícios) — avaliador OpenAI (mini/5.4/5.5) SEMPRE em Batch. Fila
// própria (trilha-eval-queue.json) porque o job carrega prompt+turnos inteiros
// (o exercício não tem "log" prévio como logs.json/selection-logs.json). O
// aluno vê "Calculando a nota final" (ChatSession) até o poll do cliente trazer
// o resultado — pode levar minutos a até 24h, mesma natureza do Competitivo.
// ============================================================================
function buildTrilhaEvalBody(job) {
  return {
    model: job.model,
    reasoning_effort: job.effort,
    max_completion_tokens: 64000,
    messages: buildOpenAIMessages(job.systemPrompt, job.inputTurns),
  };
}

let trilhaEvalSweepRunning = false;

// Submete os jobs pendentes (status 'processing' && !batchId).
async function submitTrilhaEvalBatches(openai) {
  const pending = readJSON('trilha-eval-queue.json').filter((j) => j && j.status === 'processing' && !j.batchId);
  if (!pending.length) return;
  // O teto de tokens enfileirados é POR MODELO, e cada exercício escolhe o seu
  // avaliador — então os pendentes vão agrupados por modelo, cada grupo com o
  // seu próprio orçamento de fila.
  const porModelo = new Map();
  for (const job of pending) {
    let body;
    try { body = buildTrilhaEvalBody(job); } catch (e) { console.error('[trilha-batch] corpo:', e.message); continue; }
    if (!porModelo.has(job.model)) porModelo.set(job.model, []);
    porModelo.get(job.model).push({ id: job.id, body });
  }
  const destino = new Map();
  for (const [modelo, itens] of porModelo) {
    const enviados = await submeterPendentesEmLotes({ openai, itens, model: modelo, modo: 'trilha-batch', rotulo: 'exercício(s)' });
    for (const [id, bid] of enviados) destino.set(id, bid);
  }
  if (!destino.size) return;
  await withFileLock('trilha-eval-queue.json', async () => {
    const arr = readJSON('trilha-eval-queue.json');
    for (const j of arr) {
      const bid = destino.get(j.id);
      if (bid && j.status === 'processing' && !j.batchId) { j.batchId = bid; j.batchAt = new Date().toISOString(); }
    }
    writeJSON('trilha-eval-queue.json', arr);
  });
}

// Coleta os batches prontos: grava o resultado (content + usage normalizado) no job.
async function collectTrilhaEvalBatches(openai) {
  const withBatch = readJSON('trilha-eval-queue.json').filter((j) => j && j.status === 'processing' && j.batchId);
  if (!withBatch.length) return;
  const batchIds = [...new Set(withBatch.map((j) => j.batchId))];
  for (const bid of batchIds) {
    let batch;
    try { batch = await openai.batches.retrieve(bid); } catch (e) { console.error('[trilha-batch] retrieve:', e.message); continue; }

    if (batch.status === 'completed') {
      const contents = new Map();
      const usages = new Map();
      if (batch.output_file_id) {
        const text = await (await openai.files.content(batch.output_file_id)).text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const respBody = obj.response && obj.response.body;
            const out = respBody && respBody.choices;
            contents.set(obj.custom_id, (out && out[0] && out[0].message && out[0].message.content) || '');
            if (respBody && respBody.usage) usages.set(obj.custom_id, respBody.usage);
          } catch {}
        }
      }
      const ready = []; // { userId, refId, itemId } — notificados DEPOIS do lock
      await withFileLock('trilha-eval-queue.json', async () => {
        const arr = readJSON('trilha-eval-queue.json');
        for (const j of arr) {
          if (j.batchId !== bid || j.status !== 'processing') continue;
          if (contents.has(j.id) && contents.get(j.id)) {
            const rawUsage = usages.get(j.id) || null;
            j.status = 'completed';
            j.result = { content: contents.get(j.id), usage: rawUsage ? normalizeUsage('openai', rawUsage) : null };
            if (j.userId) ready.push({ userId: j.userId, refId: 'trilha-job:' + j.id, itemId: j.itemId });
          } else {
            j.status = 'error'; j.error = 'sem resultado no batch';
          }
        }
        writeJSON('trilha-eval-queue.json', arr);
      });
      if (ready.length) {
        const exercises = readJSON('exercises.json');
        for (const r of ready) {
          const ex = exercises.find((e) => String(e.id) === String(r.itemId));
          upsertEvaluationNotification(r.userId, r.refId, {
            type: 'evaluation_ready',
            message: `Sua avaliação${ex ? ` de "${ex.title}"` : ''} está pronta.`,
          });
        }
      }
      await liberarBatchDaFila(bid);
      console.log(`[trilha-batch] batch ${bid} completo: ${contents.size} exercício(s)`);
    } else if (['failed', 'expired', 'cancelled', 'cancelling'].includes(batch.status)) {
      // Mesma regra dos outros modos: sem batchId o job volta a ser pendente e
      // o próximo ciclo resubmete. O aluno continua vendo "processing".
      const doBatch = withBatch.filter((j) => j.batchId === bid);
      const tentativas = Math.max(0, ...doBatch.map((j) => Number(j.batchTentativas) || 0));
      const r = await fecharBatchQueFalhou({ batchObj: batch, model: (doBatch[0] && doBatch[0].model) || '', tentativas, modo: 'trilha-batch' });
      await withFileLock('trilha-eval-queue.json', async () => {
        const arr = readJSON('trilha-eval-queue.json');
        for (const j of arr) {
          if (j.batchId !== bid || j.status !== 'processing') continue;
          if (r.acao === 'erro') { j.status = 'error'; j.error = r.motivo; continue; }
          j.batchId = null;
          j.batchEspera = r.motivo;
          if (r.acao === 'retenta') j.batchTentativas = (Number(j.batchTentativas) || 0) + 1;
        }
        writeJSON('trilha-eval-queue.json', arr);
      });
    }
  }
}

async function sweepTrilhaEvalBatches() {
  if (trilhaEvalSweepRunning) return;
  const openai = getOpenAI();
  if (!openai) return;
  trilhaEvalSweepRunning = true;
  try {
    await collectTrilhaEvalBatches(openai);
    await submitTrilhaEvalBatches(openai);
  } catch (e) {
    console.error('[trilha-batch] sweep erro:', e.message);
  } finally {
    trilhaEvalSweepRunning = false;
  }
}

// Poll do cliente enquanto o job do batch não termina (ver /api/evaluate,
// branch isExercise && !isExerciseAltProvider). Só o dono do job (mesmo
// usuário que gerou a avaliação) pode ler o resultado.
app.get('/api/trilha/evaluate-batch/:jobId', requireAuth, (req, res) => {
  const arr = readJSON('trilha-eval-queue.json');
  const job = arr.find((j) => j && j.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Avaliação não encontrada.' });
  if (job.userId !== req.user.id) return res.status(403).json({ error: 'Sem acesso a esta avaliação.' });
  if (job.status === 'processing') return res.json({ status: 'processing' });
  if (job.status === 'error') return res.json({ status: 'error', error: job.error || 'Falha na avaliação em lote.' });
  return res.json({ status: 'completed', content: job.result.content, usage: job.result.usage });
});

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
  // refId = 'log:'+log.id (não 'eval:'+userId): este id sobrevive até
  // finalizeCompetitiveEvals, que é onde a notificação vira "pronta".
  upsertEvaluationNotification(req.user.id, 'log:' + log.id, {
    type: 'evaluation_queued',
    message: EVAL_QUEUED_MESSAGE,
  });
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
  // Paciente do Seletivo: modelo da categoria (Administração → Modelos de IA).
  const spec = patientSpecFor('seletivo');
  if (!getClientForProvider(spec.provider) && !getOpenAI()) {
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
    const turno = await runPatientTurn({
      spec,
      systemPrompt: buildFreeplayPrompt(c.specificInstruction),
      messages,
      maxTokens: 1500 + 2000,
      label: 'seletivo/paciente',
    });
    const uso = normalizeUsage(turno.provider, turno.usage);
    console.log(`Seleção paciente (${turno.model}): cached=${uso.cacheRead} in=${uso.input} out=${uso.output}`);
    res.json({ role: 'assistant', content: turno.text });
  } catch (err) {
    res.status(500).json(falhou(req, err, 'seletivo/chat-paciente',
      { extra: { modelo: spec.model } }));
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

  // Dispara o batch já (submete este log). O collect roda no boot + intervalo.
  sweepSelectionBatches().catch(() => {});
});

// 4b) Senha de acesso — avaliador/admin vê a senha atual + quem trocou por
// último, e pode trocá-la (fica salva em settings.json, sem precisar reiniciar
// o servidor). Rota própria (não é a /senha pública do candidato).
app.get('/api/selecao/senha-config', requireAuth, requireRole('evaluator', 'admin'), (req, res) => {
  const s = readSettings();
  res.json({
    password: selecaoPasswordAtual(),
    updatedBy: s.selecaoPasswordUpdatedBy || null,
    updatedAt: s.selecaoPasswordUpdatedAt || null,
  });
});
app.put('/api/selecao/senha-config', requireAuth, requireRole('evaluator', 'admin'), (req, res) => {
  const novaSenha = clampStr((req.body && req.body.password) || '', 60).trim();
  if (novaSenha.length < 4) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
  }
  const cur = readSettings();
  cur.selecaoPassword = novaSenha;
  cur.selecaoPasswordUpdatedBy = req.user.name || req.user.username || 'Avaliador';
  cur.selecaoPasswordUpdatedAt = new Date().toISOString();
  writeJSON('settings.json', cur);
  res.json({ ok: true, password: novaSenha, updatedBy: cur.selecaoPasswordUpdatedBy, updatedAt: cur.selecaoPasswordUpdatedAt });
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

// 5b) Backup externo (Google Apps Script) — puxa TODOS os logs vivos (log +
// avaliação, já formatados como .txt) pra salvar no Drive antes da poda de 15
// dias. M2M por secret fixo no header (X-Export-Secret), não JWT: quem chama é
// um script agendado, sem sessão de usuário. Idempotência de gravação fica a
// cargo de quem chama (o script decide o que já salvou, pelo nome do arquivo).
app.get('/api/selecao/export-all', requireSelecaoExportSecret, (req, res) => {
  pruneExpiredSelectionLogs();
  const logs = readJSON('selection-logs.json');
  const sorted = [...logs].sort((a, c) => new Date(a.timestamp || 0) - new Date(c.timestamp || 0));
  const items = sorted.map((log) => {
    const stamp = log.timestamp ? new Date(log.timestamp).toISOString().slice(0, 10) : 'sem-data';
    const slug = selecaoExportSlug(log.candidate && log.candidate.nome) || 'candidato';
    const shortId = String(log.id || '').slice(-8) || 'semid';
    return {
      id: log.id,
      filename: `processo-seletivo-${slug}-${stamp}-${shortId}.txt`,
      timestamp: log.timestamp,
      status: log.status,
      score: log.score,
      content: buildSelectionExportText(log),
    };
  });
  res.json({ generatedAt: new Date().toISOString(), count: items.length, logs: items });
});

// 6) Dashboard — avaliador/admin. Agrega selection-stats.json (anônimo, permanente)
// no período pedido: ativos e rejeitados pelo SELECTION_ACTIVE_THRESHOLD (que vai
// no payload, pra tela não repetir o número em código) e média das notas.
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
// Alterna PROMPT (v16-2 / v18-25 / pipeline v28 ou v25), MODELO (5.5 / 5.4 / 5.4-mini) e
// EFFORT (low/medium/high); roda SÍNCRONO ou via BATCH API (50% off) com fila.
// Isolado: só LÊ os prompts; não toca simulação, processo seletivo nem os
// avaliadores de produção. Resultado unificado + instrumentação de custo.
// ============================================================================
// Modelos selecionáveis: id pinado + PROVEDOR (openai | glm/z.ai) + efforts
// válidos daquele modelo + se suporta Batch API. GLM (z.ai) só na Independente,
// síncrono (z.ai não expõe Batch API); o caching por prefixo funciona igual.
const AVAL_MODELOS = {
  // GPT-5.6 Sol (família 5.6, lançada 09/07/2026) — SÓ neste laboratório por
  // enquanto, pra medir billing × benefício junto com os outros antes de cogitar
  // produção. `id` sem data: a OpenAI não publica snapshot pinado deste modelo
  // (ao contrário do 5.4/5.5), então o alias é o que existe. Reasoning vai até
  // 'max' — dois degraus acima do 5.5. 'none' fica FORA de propósito: avaliador
  // sem canal de raciocínio oculto externaliza o cruzamento com o Bloco 1 na
  // prosa (foi a causa-raiz do vazamento do v15 no Opus) e não serve pra medir
  // qualidade. Batch: suportado (50% off).
  'gpt-5.6-sol': { id: 'gpt-5.6-sol', provider: 'openai', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], batch: true },
  // Terra e Luna: mesma escada de reasoning do Sol (a doc lista none/low/medium/
  // high/xhigh/max nos três) e Batch suportado igual. 'none' fora pelo mesmo
  // motivo do Sol. O que muda entre eles é só preço — é isso que o laboratório
  // mede: se Luna, 25× mais barato que o Sol, já avalia bem o bastante.
  'gpt-5.6-terra': { id: 'gpt-5.6-terra', provider: 'openai', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], batch: true },
  'gpt-5.6-luna': { id: 'gpt-5.6-luna', provider: 'openai', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], batch: true },
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
  if (aiIndependente.isPipeline(evaluator)) {
    // v28/v28-nota e v25/v25-nota são o MESMO código de pipeline; o que muda é a
    // VERSÃO (trio de .md + regra de agregação) e a VARIANTE do prompt do nó,
    // ambas resolvidas pelo registry.
    return runAvaliacaoIndependente({
      openai: client, provider, bloco1, log, model, effort,
      version: aiIndependente.versionFor(evaluator),
      variant: aiIndependente.variantFor(evaluator),
      evaluatorId: evaluator,
    });
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

// Resposta/entry unificada (todos os avaliadores). `partes` só pipeline;
// `notasDetalhe` só single. `evaluator` sai do entry (id do alternador, ex.
// 'v28-nota'), que é o que a tela usa pra rotular a run.
function buildAvalResponse(entry, result) {
  return {
    id: entry ? entry.id : null,
    casoNome: entry ? entry.casoNome : '',
    evaluator: (entry && entry.evaluator) || result.evaluator,
    version: result.version || null, // pipeline: 'v28' | 'v25'
    variant: result.variant || null, // pipeline: 'com-feedback' | 'so-nota'
    notaFinal: result.notaFinal,
    considerados: result.considerados != null ? result.considerados : null,
    partes: result.partes || null,
    notas: result.notas || null,
    notasDetalhe: result.notasDetalhe || null,
    corpoSintetizador: result.corpoSintetizador || null,
    feedbackAluno: result.feedbackAluno || null,
    reasoning: result.reasoning || null, // raciocínio do supervisor (single; GLM devolve, GPT não)
    // Pipeline com captura (v28): o raciocínio é grande e fica em arquivo
    // próprio — aqui vai só o aviso de que há o que baixar, e a rota
    // /:id/reasoning serve o .txt. Sem `id` (resultado ainda não persistido)
    // não há de onde baixar.
    reasoningDisponivel: !!(entry && entry.reasoningDisponivel),
    instrumentacao: result.instrumentacao || null,
  };
}

// Raciocínio das runs de pipeline com captura (v28): um .txt por avaliação, em
// arquivo próprio no volume. Fora do avaliacao-v25.json de propósito — aquele
// store é lido INTEIRO a cada gravação, e somar dezenas de KB de resumo por run
// o faria crescer rápido sem que ninguém leia isso no caminho normal.
const AVAL_REASONING_DIR = path.join(DATA_DIR, 'avaliacao-reasoning');

// Nome de arquivo a partir do id da entry. O id é gerado por nós ('av25-' +
// timestamp + hex), mas a checagem fica aqui mesmo assim: é ela que garante que
// nada vindo da URL vire caminho.
function reasoningPathFor(entryId) {
  if (!/^av25-[0-9]+-[0-9a-f]{6}$/.test(String(entryId || ''))) return null;
  return path.join(AVAL_REASONING_DIR, entryId + '.txt');
}

// Persiste o resultado em avaliacao-v25.json (store de todos os avaliadores).
async function persistAvaliacaoResult({ user, casoId, casoNome, evaluator, model, effort, batch, result }) {
  const entry = {
    id: 'av25-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    userId: user.id,
    userName: user.name || '',
    casoId, casoNome, evaluator, model, effort, batch: !!batch,
    version: result.version || null, // versão do pipeline ('v28' | 'v25'); null nos single
    variant: result.variant || null,
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

  // Grava o .txt do raciocínio (quando houve) antes de indexar a entry, para o
  // botão de baixar nunca apontar para arquivo que não existe.
  const txt = (result.reasoningTxt || '').trim();
  if (txt) {
    try {
      fs.mkdirSync(AVAL_REASONING_DIR, { recursive: true });
      fs.writeFileSync(reasoningPathFor(entry.id), txt, 'utf-8');
      entry.reasoningDisponivel = true;
    } catch (e) {
      // Perder o resumo não pode derrubar a avaliação: a nota e o feedback são
      // o produto, e isto aqui é material de leitura do supervisor.
      console.error('[aval-reasoning] falha ao gravar:', e.message);
    }
  }

  await withFileLock('avaliacao-v25.json', async () => {
    const store = readJSON('avaliacao-v25.json', []);
    store.push(entry);
    writeJSON('avaliacao-v25.json', store);
  });
  return entry;
}

// As requisições de um job de avaliação: uma por critério no pipeline, uma só
// nos avaliadores de prompt único. Determinístico — é remontado igual a cada
// tentativa, o que permite reenviar um job que voltou da fila sem guardar o
// JSONL nem o arquivo da OpenAI.
function buildAvaliacaoRequests(job) {
  const { id: jobId, evaluator, model, effort, provider, bloco1, log } = job;
  if (aiIndependente.isPipeline(evaluator)) {
    return buildPipelineNodeRequests({
      bloco1, log, model, effort, provider,
      version: aiIndependente.versionFor(evaluator), variant: aiIndependente.variantFor(evaluator),
    }).map((n) => ({ custom_id: `${jobId}::${n.num}`, method: 'POST', url: '/v1/chat/completions', body: n.body }));
  }
  return [{
    custom_id: `${jobId}::0`, method: 'POST', url: '/v1/chat/completions',
    body: aiIndependente.buildSingleEvalBody({ evaluatorId: evaluator, bloco1, log, model, effort, provider }),
  }];
}

// Tenta mandar um job da fila local para a Batch API. Devolve 'entrou',
// 'sem-vaga' (o job continua em 'aguardando') ou 'erro'.
//
// Um job aqui é um batch inteiro (15 nós do pipeline ≈ 583 mil tokens
// enfileirados), então ele só sai quando cabe: sem vaga, fica em 'aguardando' e
// o próximo ciclo tenta de novo. Nada se perde — é a fila fazendo o seu papel.
async function submeterJobAvaliacao(job, client) {
  let requests;
  try {
    requests = buildAvaliacaoRequests(job);
  } catch (e) {
    await markAvalJob(job.id, { status: 'error', error: `montagem das requisições falhou: ${e.message}` });
    return 'erro';
  }
  const tokens = tokensDoLote(requests.map((r) => r.body));
  // Um job maior que o teto do modelo inteiro nunca teria vaga: esperar por ele
  // seria esperar para sempre. Vai assim mesmo, e a recusa da OpenAI vira um
  // erro visível com o motivo — melhor que um job preso na fila em silêncio.
  const cabeAlgumDia = tokens <= batchFila.espacoLivre(job.model, 0);
  if (cabeAlgumDia && !cabeNaFilaDaOpenAI(job.model, tokens)) {
    const livre = batchFila.espacoLivre(job.model, tokensEmVoo(job.model));
    console.log(`[aval-batch] job ${job.id} espera vaga: precisa de ${tokens.toLocaleString('pt-BR')} tokens, livre ${livre.toLocaleString('pt-BR')}`);
    await markAvalJob(job.id, { status: 'aguardando', espera: 'Aguardando vaga na fila de tokens da OpenAI.' });
    return 'sem-vaga';
  }
  let batchObj;
  try {
    batchObj = await criarBatchRegistrado({ openai: client, requests, model: job.model, modo: 'aval-batch' });
  } catch (e) {
    // Recusa na criação: continua 'aguardando' e tenta no próximo ciclo.
    console.error(`[aval-batch] job ${job.id} não entrou (segue na fila):`, e.message);
    await markAvalJob(job.id, { status: 'aguardando', espera: `A fila da OpenAI recusou agora (${e.message}). Nova tentativa em minutos.` });
    return 'sem-vaga';
  }
  await markAvalJob(job.id, {
    status: 'processing', batchId: batchObj.id, requestCount: requests.length,
    batchAt: new Date().toISOString(), espera: null,
  });
  console.log(`[aval-batch] job ${job.id} (${job.evaluator}/${job.model}/${job.effort}) submetido em batch ${batchObj.id} (${requests.length} req, ~${tokens.toLocaleString('pt-BR')} tokens)`);
  return 'entrou';
}

// Enfileira um job em batch. O job entra em 'aguardando' e vai para a Batch API
// assim que houver vaga no teto de tokens enfileirados do modelo — na hora, se
// a fila estiver vazia (o caso comum), ou num ciclo seguinte do sweep.
//
// Antes daqui o job era submetido direto na rota: com a fila cheia, o batch
// nascia e morria minutos depois com `token_limit_exceeded`, e a avaliação
// virava erro. Agora esperar é um estado, não uma falha.
async function enqueueAvaliacaoBatch({ openai, user, evaluator, model, modelKey, effort, provider, bloco1, log, casoId, casoNome }) {
  const jobId = 'avjob-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const job = {
    id: jobId, createdAt: new Date().toISOString(),
    userId: user.id, userName: user.name || '',
    casoId, casoNome, evaluator, model, modelKey, effort, provider, batch: true,
    status: 'aguardando', batchId: null, requestCount: 0,
    // log e bloco1 ficam no job porque as requisições são remontadas a cada
    // tentativa (e o sintetizador do pipeline precisa do log na coleta). Saem
    // quando o job termina — ver markAvalJob.
    log, bloco1,
    tentativas: 0, espera: null,
    result: null, error: null,
  };
  await withFileLock('avaliacao-fila.json', async () => {
    const arr = readJSON('avaliacao-fila.json');
    arr.push(job);
    writeJSON('avaliacao-fila.json', arr);
  });
  await submeterJobAvaliacao(job, openai);
  return readJSON('avaliacao-fila.json').find((j) => j && j.id === jobId) || job;
}

async function markAvalJob(jobId, patch) {
  await withFileLock('avaliacao-fila.json', async () => {
    const arr = readJSON('avaliacao-fila.json');
    const i = arr.findIndex((j) => j && j.id === jobId);
    if (i === -1) return;
    arr[i] = { ...arr[i], ...patch };
    // Libera o material grande só quando o job acabou de verdade: enquanto ele
    // pode voltar para a fila, log e bloco1 são o que permite remontar as
    // requisições na próxima tentativa.
    if (patch.status === 'completed' || patch.status === 'error') { delete arr[i].log; delete arr[i].bloco1; }
    writeJSON('avaliacao-fila.json', arr);
  });
}

// Modo síncrono via JOB LOCAL (não é a Batch API da OpenAI): a chamada ao
// modelo roda em background, fora do ciclo request/response, então a rota
// devolve o jobId na hora e nunca esbarra no timeout de 100s do Cloudflare —
// mesmo se o avaliador demorar bastante (GLM effort high/max, v18-25/pipeline com
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
    // (os 'aguardando' são tratados na segunda passada, depois de liberar vagas)
    for (const job of jobs) {
      const client = getClientForProvider(job.provider || 'openai');
      if (!client) continue; // provedor sem chave configurada
      let batchObj;
      try { batchObj = await client.batches.retrieve(job.batchId); } catch (e) { console.error('[aval-batch] retrieve:', e.message); continue; }

      if (batchObj.status === 'completed') {
        await liberarBatchDaFila(batchObj.id);
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
          if (aiIndependente.isPipeline(job.evaluator)) {
            const nodeOutputs = [];
            for (const [suffix, out] of outputs) nodeOutputs.push({ num: Number(suffix), text: out.text, usage: out.usage });
            result = await finalizePipeline({
              openai: client, provider: job.provider || 'openai', log: job.log, model: job.model, effort: job.effort,
              version: aiIndependente.versionFor(job.evaluator), variant: aiIndependente.variantFor(job.evaluator),
              evaluatorId: job.evaluator, nodeOutputs, batch: true,
            });
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
        // Fila cheia devolve o job para 'aguardando' e ele é resubmetido quando
        // houver vaga — a avaliação continua viva, só demora mais.
        const r = await fecharBatchQueFalhou({ batchObj, model: job.model, tentativas: Number(job.tentativas) || 0, modo: 'aval-batch' });
        if (r.acao === 'erro') {
          await markAvalJob(job.id, { status: 'error', error: r.motivo });
        } else {
          await markAvalJob(job.id, {
            status: 'aguardando', batchId: null, espera: r.motivo,
            tentativas: (Number(job.tentativas) || 0) + (r.acao === 'retenta' ? 1 : 0),
          });
        }
      }
      // validating/in_progress/finalizing → segue 'processing', checa na próxima varredura.
    }

    // Segunda passada: a fila local. Os jobs que ainda não entraram na Batch API
    // (novos sem vaga, ou devolvidos por uma recusa) tentam agora, mais velhos
    // primeiro — as vagas que a passada acima liberou já contam aqui.
    const esperando = readJSON('avaliacao-fila.json')
      .filter((j) => j && j.status === 'aguardando')
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    for (const job of esperando) {
      const client = getClientForProvider(job.provider || 'openai');
      if (!client) continue;
      const r = await submeterJobAvaliacao(job, client);
      // Sem vaga para este, os de trás também não entram — a fila é por ordem de
      // chegada, e furar a fila com um job pequeno adiaria o grande para sempre.
      // Job com defeito ('erro') não segura ninguém: segue para o próximo.
      if (r === 'sem-vaga') break;
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
    const evaluator = b.evaluator || 'v28';
    const modelKey = b.model || 'gpt-5.5';
    const effort = b.effort || 'medium';
    const batch = b.batch === true;

    if (!log) return res.status(400).json({ error: 'Cole ou envie a transcrição da sessão.' });
    if (!casoId) return res.status(400).json({ error: 'Selecione um caso (necessário para o Bloco 1).' });
    if (!aiIndependente.isValidEvaluator(evaluator)) return res.status(400).json({ error: 'Avaliador inválido.' });
    const modelInfo = AVAL_MODELOS[modelKey];
    // Lista montada do próprio registro — a mensagem não envelhece quando entra
    // ou sai um modelo do laboratório.
    if (!modelInfo) return res.status(400).json({ error: `Modelo inválido (${Object.keys(AVAL_MODELOS).join(' | ')}).` });
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

// Baixa o .txt com o resumo do raciocínio de uma avaliação (v28). Mesma regra de
// acesso da fila: supervisor vê o que rodou, admin vê tudo. Devolve texto puro —
// o cliente transforma em arquivo.
app.get('/api/avaliacao-independente/:id/reasoning', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const entry = readJSON('avaliacao-v25.json', []).find((e) => e && e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Avaliação não encontrada.' });
  if (req.user.role !== 'admin' && entry.userId !== req.user.id) {
    return res.status(403).json({ error: 'Esta avaliação é de outro usuário.' });
  }
  const file = reasoningPathFor(entry.id);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'Esta avaliação não guardou raciocínio (só o v28 em modo síncrono guarda).' });
  }
  res.type('text/plain; charset=utf-8').send(fs.readFileSync(file, 'utf-8'));
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
      // 'aguardando' = na fila LOCAL, ainda não entrou na Batch API (sem vaga no
      // teto de tokens enfileirados do modelo). `espera` diz por quê.
      espera: j.espera || null, tentativas: Number(j.tentativas) || 0,
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

// ============================================================================
// BENCHMARKING DE SIMULAÇÃO — capacidade de processamento do PACIENTE
// (supervisor/admin)
// ----------------------------------------------------------------------------
// Você sobe o log de um atendimento que já aconteceu, escolhe o aluno que
// atendeu e o personagem, e o sistema REFAZ aquele atendimento sozinho: um
// primeiro modelo extrai do log a PERSONA de quem atendeu, e essa persona
// conversa com o paciente pelo número de interações que você pedir (1 interação
// = 1 fala do paciente + 1 fala do aluno).
//
// O que se mede é o PACIENTE — custo por interação, custo total e latência de
// cada modelo candidato ao longo de um atendimento inteiro. O aluno simulado é
// instrumento, não objeto: roda sempre em gpt-5.6-luna high.
//
// NÃO HÁ AVALIAÇÃO. Nada é pontuado, nada vira log de sessão, nada toca em
// gamificação (pedido explícito do dono). O produto é custo + transcrição.
//
// Por que é JOB em background (e não uma resposta HTTP): 70 interações são 140
// chamadas em sequência, dezenas de minutos. O Cloudflare corta em 100s. Mesmo
// desenho da Avaliação Independente em modo local: a rota devolve o id na hora e
// o cliente faz polling, vendo a conversa crescer.
// ============================================================================

// Uma run por arquivo, fora do JSON da fila: a transcrição de 70 interações passa
// de 100 KB e a fila é re-lida INTEIRA a cada atualização de progresso.
const BENCH_RUNS_DIR = path.join(DATA_DIR, 'benchmark-runs');

// O id é gerado aqui ('bench-' + timestamp + hex), mas a checagem existe pra que
// nada vindo da URL possa virar caminho de arquivo.
function benchRunPathFor(id) {
  if (!/^bench-[0-9]+-[0-9a-f]{8}$/.test(String(id || ''))) return null;
  return path.join(BENCH_RUNS_DIR, id + '.json');
}
function readBenchRun(id) {
  const p = benchRunPathFor(id);
  if (!p || !fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function writeBenchRun(run) {
  const p = benchRunPathFor(run.id);
  if (!p) return;
  fs.mkdirSync(BENCH_RUNS_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(run), 'utf-8');
}

// Cancelamento pedido pela tela. Em memória de propósito: é sinal para o loop
// que está rodando NESTE processo — se o servidor reiniciar, o job morre com ele
// (e o sweep de boot marca os órfãos).
const benchCancelados = new Set();

async function markBenchJob(id, patch) {
  await withFileLock('benchmark-fila.json', async () => {
    const arr = readJSON('benchmark-fila.json');
    const i = arr.findIndex((j) => j && j.id === id);
    if (i === -1) return;
    arr[i] = { ...arr[i], ...patch };
    writeJSON('benchmark-fila.json', arr);
  });
}

// Esta pessoa já tem run ou lote em voo? Um benchmark são 2×N chamadas
// sequenciais gastando dinheiro real, e um lote multiplica isso pelos modelos:
// duplo clique não pode virar dois lotes de 70 interações. 'aguardando' conta —
// é run de lote que ainda não começou, mas vai.
async function benchOcupado(userId) {
  return readJSON('benchmark-fila.json')
    .some((j) => j && j.userId === userId && (j.status === 'processing' || j.status === 'aguardando' || j.status === 'cancelando'));
}

// Uma fala. Dois transportes:
//   · Responses API (streaming) quando queremos o RESUMO do raciocínio — é o
//     único lugar da OpenAI onde ele existe. Custo idêntico ao chat.completions
//     (mesmos preços por token; o resumo é janela para token já cobrado), e o
//     caching por prefixo continua valendo: `instructions` é o prefixo estável.
//   · chat.completions no resto — inclusive no GLM, que devolve o raciocínio em
//     `reasoning_content` sem trocar de transporte.
async function runBenchTurn({ client, modelKey, model, provider, effort, systemPrompt, turns, maxTokens, captura, rotulo }) {
  const t0 = Date.now();
  let texto = '';
  let reasoning = '';
  let usage = null;

  await benchmark.withBenchRetry(rotulo, async () => {
    texto = ''; reasoning = ''; usage = null; // zera: a tentativa anterior pode ter parcial
    if (captura && provider === 'openai') {
      const stream = await client.responses.create({
        model,
        reasoning: { effort, summary: 'auto' },
        max_output_tokens: maxTokens,
        instructions: systemPrompt, // prefixo estável → é o que a OpenAI cacheia
        input: turns.map((t) => ({ role: t.role, content: t.content })),
        stream: true,
      });
      for await (const ev of stream) {
        if (ev.type === 'response.output_text.delta') {
          if (ev.delta) texto += ev.delta;
        } else if (ev.type === 'response.reasoning_summary_text.delta') {
          if (ev.delta) reasoning += ev.delta;
        } else if (ev.type === 'response.reasoning_summary_part.added') {
          if (reasoning) reasoning += '\n\n'; // separa as partes do resumo
        } else if (ev.type === 'response.completed') {
          usage = (ev.response && ev.response.usage) || null;
        }
      }
      texto = texto.trim();
      reasoning = reasoning.trim();
      return;
    }
    const body = simIndependente.buildSimChatBody({ provider, model, effort, systemPrompt, turns });
    // O teto é o DAQUI, não o da Simulação Independente: nesta aba o effort é
    // high nos dois lados, e a folga de raciocínio precisa ser maior.
    if (provider === 'glm') body.max_tokens = maxTokens;
    else body.max_completion_tokens = maxTokens;
    const resp = await client.chat.completions.create(body);
    const msg = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
    texto = simIndependente.extractSimText(provider, resp);
    reasoning = captura ? aiIndependente.extractReasoning(msg) : '';
    usage = resp.usage || null;
  });

  const totais = benchmark.normalizeBenchUsage(provider, usage);
  return {
    modelKey, model, provider, effort,
    texto,
    reasoning,
    totais,
    custo: simIndependente.computeSimCost(modelKey, totais),
    latenciaMs: Date.now() - t0,
  };
}

// Uma fala, com UMA retentativa quando o modelo devolve texto vazio. Vazio quase
// sempre significa que o teto de tokens foi consumido pelo raciocínio: o modelo
// pensou tudo e não sobrou espaço pra falar. Duas vezes seguidas = falha real, e
// a run para com o que já tem (o parcial fica gravado e continua baixável).
async function benchTurnOuFalha(args) {
  const primeira = await runBenchTurn(args);
  if (primeira.texto) return primeira;
  console.warn(`[bench] ${args.rotulo} devolveu fala vazia — repetindo uma vez`);
  const segunda = await runBenchTurn(args);
  if (segunda.texto) return segunda;
  throw new Error(`${args.rotulo} devolveu fala vazia duas vezes (o teto de ${args.maxTokens} tokens provavelmente foi consumido pelo raciocínio).`);
}

// Roda a run inteira. Persiste depois de CADA interação, pra a tela acompanhar a
// conversa ao vivo e pra um erro no meio nunca jogar fora o que já foi pago.
async function runBenchmarkRun({ run, log, pacienteSystemPrompt, clientPaciente, clientAluno, personaPronta }) {
  const persistir = async () => {
    run.resumo = benchmark.resumoDeCustos({
      interacoes: run.interacoes,
      pacienteModelKey: run.paciente.modelKey,
      alunoModelKey: run.aluno.modelKey,
      // Persona compartilhada é custo do LOTE, não desta run — contá-la em cada
      // run somaria a mesma chamada N vezes no total do lote.
      personaTurno: run.personaCompartilhada ? null : run.personaTurno,
    });
    writeBenchRun(run);
    await markBenchJob(run.id, {
      status: run.status,
      progresso: { feitas: run.interacoes.length, total: run.interacoesPedidas },
      resumo: run.resumo,
      completedAt: run.completedAt || null,
      error: run.error || null,
    });
  };

  // ── Etapa 1: a persona do aluno sai do log enviado ────────────────────────
  // Em LOTE ela já vem pronta: uma extração serve todos os modelos, e é isso que
  // garante que todos enfrentem o MESMO aluno simulado (ver runLote).
  if (personaPronta) {
    run.persona = personaPronta.texto;
    run.personaTurno = personaPronta.turno;
    run.personaCompartilhada = true;
    await persistir();
  } else {
    const personaTurno = await benchTurnOuFalha({
      client: clientAluno,
      modelKey: run.aluno.modelKey, model: run.aluno.model, provider: run.aluno.provider, effort: run.aluno.effort,
      systemPrompt: benchmark.PERSONA_INSTRUCTION,
      turns: [{ role: 'user', content: benchmark.buildPersonaInput({ log, alunoNome: run.alunoNome, casoNome: run.casoNome }) }],
      maxTokens: benchmark.BENCH_PERSONA_MAX_TOKENS,
      captura: run.capturaAluno,
      rotulo: 'extração de persona',
    });
    run.persona = personaTurno.texto;
    run.personaTurno = { ...personaTurno, texto: undefined };
    await persistir();
  }

  const alunoSystemPrompt = benchmark.buildAlunoSystemPrompt({
    personaTexto: run.persona, alunoNome: run.alunoNome, casoNome: run.casoNome,
  });

  // ── Etapa 2: o atendimento ────────────────────────────────────────────────
  for (let n = 1; n <= run.interacoesPedidas; n++) {
    if (benchCancelado(run)) {
      run.status = 'cancelado';
      run.completedAt = new Date().toISOString();
      await persistir();
      return run;
    }

    // O paciente fala primeiro (mesmo disparo da produção: "Iniciar" oculto).
    const tp = await benchTurnOuFalha({
      client: clientPaciente,
      modelKey: run.paciente.modelKey, model: run.paciente.model, provider: run.paciente.provider, effort: run.paciente.effort,
      systemPrompt: pacienteSystemPrompt,
      turns: benchmark.historyForPatient(run.transcript),
      maxTokens: benchmark.tetoTokens(run.paciente.effort),
      captura: run.capturaPaciente,
      rotulo: `fala ${n} do paciente`,
    });
    run.transcript.push({ ator: 'paciente', texto: tp.texto });

    const ta = await benchTurnOuFalha({
      client: clientAluno,
      modelKey: run.aluno.modelKey, model: run.aluno.model, provider: run.aluno.provider, effort: run.aluno.effort,
      systemPrompt: alunoSystemPrompt,
      turns: benchmark.historyForAluno(run.transcript),
      maxTokens: benchmark.tetoTokens(run.aluno.effort),
      captura: run.capturaAluno,
      rotulo: `fala ${n} do aluno`,
    });
    run.transcript.push({ ator: 'aluno', texto: ta.texto });

    run.interacoes.push({
      n,
      paciente: { ...tp, texto: undefined },
      aluno: { ...ta, texto: undefined },
    });
    await persistir();
    console.log(
      `[bench] ${run.id} interação ${n}/${run.interacoesPedidas} — paciente `
      + `${tp.custo ? '$' + tp.custo.usd.toFixed(6) : 'n/d'} (${tp.latenciaMs}ms) · aluno ${ta.latenciaMs}ms`,
    );
  }

  run.status = 'completed';
  run.completedAt = new Date().toISOString();
  await persistir();
  return run;
}

// ── LOTE: os modelos escolhidos, no mesmo caso, com a MESMA persona ──────────
// Automatiza o fluxo que antes era manual (rodar um modelo, esperar, trocar o
// modelo, rodar de novo). Duas coisas que só o lote consegue:
//
//   1. A ficha de persona é extraída UMA vez e usada por TODOS os modelos. É o
//      que torna a comparação válida — cada modelo enfrenta exatamente o mesmo
//      aluno simulado, com a mesma forma de atender. Se cada run extraísse a sua,
//      as fichas sairiam diferentes (o modelo não é determinístico) e parte da
//      diferença medida seria do aluno, não do paciente. De brinde, custa uma
//      extração em vez de N.
//   2. Dois modos de execução (escolha de quem roda): `fila` faz um modelo por
//      vez do começo ao fim — mais lento, sem risco de TPM; `paralelo` dispara
//      todos juntos — rápido, mas o lado do ALUNO é o mesmo modelo em todas as
//      runs, então N runs simultâneas multiplicam por N a pressão sobre o TPM
//      dele. Default é `fila`.
//
// Uma run que falha NÃO derruba o lote: o erro fica registrado nela e as outras
// seguem. É o oposto do desejável num pipeline, e o certo aqui — o dinheiro já
// gasto nas outras runs não pode ir embora porque a z.ai deu 429.
const BENCH_LOTES_FILE = 'benchmark-lotes.json';

function readBenchLote(id) {
  if (!/^blote-[0-9]+-[0-9a-f]{8}$/.test(String(id || ''))) return null;
  return readJSON(BENCH_LOTES_FILE).find((l) => l && l.id === id) || null;
}
async function markLote(id, patch) {
  await withFileLock(BENCH_LOTES_FILE, async () => {
    const arr = readJSON(BENCH_LOTES_FILE);
    const i = arr.findIndex((l) => l && l.id === id);
    if (i === -1) return;
    arr[i] = { ...arr[i], ...patch };
    writeJSON(BENCH_LOTES_FILE, arr);
  });
}

// Cancelamento vale para a run e para o lote dela (a tela cancela o lote inteiro).
function benchCancelado(run) {
  return benchCancelados.has(run.id) || (run.loteId && benchCancelados.has(run.loteId));
}

async function runLoteRun({ run, log, pacienteSystemPrompt, clientPaciente, clientAluno, personaPronta }) {
  await markBenchJob(run.id, { status: 'processing' });
  run.status = 'processing';
  try {
    const feito = await runBenchmarkRun({ run, log, pacienteSystemPrompt, clientPaciente, clientAluno, personaPronta });
    console.log(`[bench] ${run.id} (${run.paciente.key}) ${feito.status} — ${feito.interacoes.length} interação(ões)`);
    return feito;
  } catch (e) {
    registrarErro(null, e, 'benchmark-simulação/lote-run', { extra: { runId: run.id, loteId: run.loteId, paciente: run.paciente.key } });
    run.status = 'error';
    run.error = e.message;
    run.completedAt = new Date().toISOString();
    try { writeBenchRun(run); } catch {}
    await markBenchJob(run.id, {
      status: 'error', error: e.message, completedAt: run.completedAt,
      progresso: { feitas: run.interacoes.length, total: run.interacoesPedidas },
      resumo: run.resumo,
    });
    return run;
  }
}

async function runLote({ lote, runs, log, pacienteSystemPrompt, clientAluno, clientePara }) {
  // Etapa 1: a persona, uma vez, para todo o lote.
  const personaTurno = await benchTurnOuFalha({
    client: clientAluno,
    modelKey: lote.aluno.modelKey, model: lote.aluno.model, provider: lote.aluno.provider, effort: lote.aluno.effort,
    systemPrompt: benchmark.PERSONA_INSTRUCTION,
    turns: [{ role: 'user', content: benchmark.buildPersonaInput({ log, alunoNome: lote.alunoNome, casoNome: lote.casoNome }) }],
    maxTokens: benchmark.BENCH_PERSONA_MAX_TOKENS,
    captura: lote.capturaAluno,
    rotulo: 'extração de persona do lote',
  });
  const personaPronta = { texto: personaTurno.texto, turno: { ...personaTurno, texto: undefined } };
  lote.persona = personaPronta.texto;
  lote.personaTurno = personaPronta.turno;
  await markLote(lote.id, { persona: lote.persona, personaTurno: lote.personaTurno });

  const executar = (run) => runLoteRun({
    run, log, pacienteSystemPrompt, clientAluno, personaPronta,
    clientPaciente: clientePara(run.paciente.provider),
  });

  if (lote.modo === 'paralelo') {
    await Promise.all(runs.map(executar));
  } else {
    for (const run of runs) {
      if (benchCancelados.has(lote.id)) {
        // Run que nunca começou não é erro: fica cancelada, sem custo nenhum.
        run.status = 'cancelado';
        run.completedAt = new Date().toISOString();
        try { writeBenchRun(run); } catch {}
        await markBenchJob(run.id, { status: 'cancelado', completedAt: run.completedAt });
        continue;
      }
      await executar(run);
    }
  }

  const finais = runs.map((r) => readBenchRun(r.id) || r);
  const cancelado = benchCancelados.has(lote.id) || finais.some((r) => r.status === 'cancelado');
  const comFalha = finais.filter((r) => r.status === 'error').length;
  const status = cancelado ? 'cancelado'
    : comFalha === finais.length ? 'error'
      : comFalha ? 'parcial' : 'completed';
  await markLote(lote.id, {
    status,
    completedAt: new Date().toISOString(),
    resumo: benchmark.resumoComparativo({ runs: finais, personaTurno: lote.personaTurno }),
    error: comFalha ? `${comFalha} de ${finais.length} modelo(s) falharam; os demais estão completos.` : null,
  });
  console.log(`[bench-lote] ${lote.id} ${status} — ${finais.length} modelo(s), ${lote.modo}`);
}

// Dispara um LOTE: um modelo por linha, mesmo caso, mesma persona.
app.post('/api/benchmark-simulacao/lote', requireAuth, requireRole('supervisor', 'admin'), aiLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const log = clampStr(b.log, 200000).trim();
    const casoId = b.casoId;
    const interacoes = Number(b.interacoes);
    const alunoNome = clampStr(b.alunoNome, 80).trim();
    const modo = b.modo || benchmark.BENCH_MODO_PADRAO;

    if (!log) return res.status(400).json({ error: 'Envie o log do atendimento que será replicado.' });
    if (log.length < 200) return res.status(400).json({ error: 'O log é curto demais para extrair a persona do aluno (mínimo 200 caracteres).' });
    if (!casoId) return res.status(400).json({ error: 'Selecione o paciente que foi atendido.' });
    const pacientes = benchmark.normalizePacientes(b.pacientes);
    if (!pacientes) {
      return res.status(400).json({ error: `Escolha ao menos um modelo de paciente válido (${Object.keys(benchmark.BENCH_PACIENTES).join(' | ')}).` });
    }
    if (!benchmark.isValidInteracoes(interacoes)) {
      return res.status(400).json({ error: `Número de interações inválido (${benchmark.BENCH_INTERACOES.join(' | ')}).` });
    }
    if (!benchmark.isValidModo(modo)) {
      return res.status(400).json({ error: `Modo inválido (${benchmark.BENCH_MODOS.join(' | ')}).` });
    }

    const resolved = resolveChatSystemPrompt({ context: { type: 'freeplay', itemId: casoId }, user: req.user });
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const aluno = benchmark.alunoPreset();
    const clientAluno = getClientForSimProvider(aluno.provider);
    if (!clientAluno) {
      return res.status(503).json({ error: `Indisponível: ${simProviderKeyName(aluno.provider)} não configurada (modelo do aluno simulado).` });
    }
    // Todos os provedores do lote precisam de chave ANTES de começar: descobrir no
    // meio que falta a do 4º modelo depois de pagar os 3 primeiros é inaceitável.
    for (const p of pacientes) {
      if (!getClientForSimProvider(p.provider)) {
        return res.status(503).json({ error: `Indisponível: ${simProviderKeyName(p.provider)} não configurada (necessária para ${p.label}).` });
      }
    }

    if (await benchOcupado(req.user.id)) {
      return res.status(409).json({ error: 'Você já tem um benchmark rodando. Espere terminar (ou cancele) antes de começar outro.' });
    }

    const freeChar = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(casoId));
    const casoNome = freeChar ? freeChar.name : '';
    const loteId = 'blote-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const criadoEm = new Date().toISOString();

    // Uma run (arquivo + job) por modelo, já criadas: a tela mostra o plano
    // inteiro desde o primeiro segundo, com as que ainda não começaram em
    // 'aguardando'.
    const runs = pacientes.map((paciente) => ({
      id: 'bench-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
      createdAt: criadoEm,
      completedAt: null,
      loteId,
      userId: req.user.id,
      userName: req.user.name || '',
      casoId, casoNome, alunoNome,
      interacoesPedidas: interacoes,
      paciente, aluno,
      capturaPaciente: benchmark.capturaResumo(paciente),
      capturaAluno: benchmark.capturaResumo(aluno),
      personaCompartilhada: true,
      status: 'aguardando',
      error: null,
      persona: '',
      personaTurno: null,
      transcript: [],
      interacoes: [],
      resumo: null,
    }));
    for (const run of runs) writeBenchRun(run);

    const lote = {
      id: loteId,
      createdAt: criadoEm,
      completedAt: null,
      userId: req.user.id,
      userName: req.user.name || '',
      casoId, casoNome, alunoNome,
      interacoes, modo,
      aluno,
      capturaAluno: benchmark.capturaResumo(aluno),
      pacientes: pacientes.map((p) => p.key),
      runIds: runs.map((r) => r.id),
      status: 'processing',
      error: null,
      persona: '',
      personaTurno: null,
      resumo: null,
    };
    await withFileLock(BENCH_LOTES_FILE, async () => {
      const arr = readJSON(BENCH_LOTES_FILE);
      arr.push(lote);
      writeJSON(BENCH_LOTES_FILE, arr);
    });
    await withFileLock('benchmark-fila.json', async () => {
      const arr = readJSON('benchmark-fila.json');
      for (const run of runs) {
        arr.push({
          id: run.id, createdAt: criadoEm, completedAt: null, loteId,
          userId: req.user.id, userName: run.userName,
          casoId, casoNome, alunoNome,
          pacienteKey: run.paciente.key, pacienteLabel: run.paciente.label,
          alunoLabel: aluno.label,
          interacoesPedidas: interacoes,
          status: 'aguardando',
          progresso: { feitas: 0, total: interacoes },
          resumo: null, error: null,
        });
      }
      writeJSON('benchmark-fila.json', arr);
    });

    runLote({ lote, runs, log, pacienteSystemPrompt: resolved.systemPrompt, clientAluno, clientePara: getClientForSimProvider })
      .catch(async (e) => {
        // Só cai aqui se a EXTRAÇÃO DE PERSONA falhar (as runs têm try/catch
        // próprio): nesse caso nenhum modelo rodou, e é isso que o lote informa.
        registrarErro(null, e, 'benchmark-simulação/lote', { extra: { loteId, modelos: lote.pacientes } });
        await markLote(loteId, { status: 'error', error: e.message, completedAt: new Date().toISOString() });
        for (const run of runs) {
          if (run.status !== 'aguardando') continue;
          run.status = 'error';
          run.error = 'A extração da persona do lote falhou: ' + e.message;
          try { writeBenchRun(run); } catch {}
          await markBenchJob(run.id, { status: 'error', error: run.error });
        }
      })
      .finally(() => {
        benchCancelados.delete(loteId);
        for (const run of runs) benchCancelados.delete(run.id);
      });

    console.log(`[bench-lote] ${loteId} iniciado: ${pacientes.length} modelo(s) × ${interacoes} interações em ${modo}`);
    res.json({ id: loteId, runIds: lote.runIds, status: 'processing' });
  } catch (err) {
    if (!res.headersSent) res.status(500).json(falhou(req, err, 'benchmark-simulação/lote'));
  }
});

// Histórico de lotes. Supervisor vê os próprios; admin vê todos.
app.get('/api/benchmark-simulacao/lotes', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const lotes = readJSON(BENCH_LOTES_FILE)
    .filter((l) => l && (req.user.role === 'admin' || l.userId === req.user.id))
    .sort((a, c) => new Date(c.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 30)
    .map((l) => ({ ...l, personaTurno: l.personaTurno ? { ...l.personaTurno, reasoning: undefined } : null }));
  res.json(lotes);
});

// Um lote + o estado de cada run dele (é o que a tela faz polling).
app.get('/api/benchmark-simulacao/lote/:id', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const lote = readBenchLote(req.params.id);
  if (!lote) return res.status(404).json({ error: 'Lote não encontrado.' });
  if (req.user.role !== 'admin' && lote.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este lote é de outro usuário.' });
  }
  const runs = (lote.runIds || []).map((id) => readBenchRun(id)).filter(Boolean);
  res.json({
    ...lote,
    personaTurno: lote.personaTurno ? { ...lote.personaTurno, reasoning: undefined } : null,
    // Sempre recalculado: enquanto o lote roda, o `resumo` gravado ainda é null.
    resumo: benchmark.resumoComparativo({ runs, personaTurno: lote.personaTurno }),
    runs: runs.map((r) => ({
      id: r.id, pacienteKey: r.paciente.key, pacienteLabel: r.paciente.label,
      status: r.status, error: r.error || null,
      progresso: { feitas: (r.interacoes || []).length, total: r.interacoesPedidas },
      resumo: r.resumo || null,
      reasoningDisponivel: benchmark.temReasoning(r),
    })),
  });
});

// Relatório comparativo do lote (.txt). Só números — nada aqui julga qualidade.
app.get('/api/benchmark-simulacao/lote/:id/relatorio', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const lote = readBenchLote(req.params.id);
  if (!lote) return res.status(404).json({ error: 'Lote não encontrado.' });
  if (req.user.role !== 'admin' && lote.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este lote é de outro usuário.' });
  }
  const runs = (lote.runIds || []).map((id) => readBenchRun(id)).filter(Boolean);
  res.type('text/plain; charset=utf-8').send(benchmark.buildLoteRelatorioTxt({ lote, runs }));
});

// Cancela o lote: a run em andamento para na próxima interação e as que ainda não
// começaram nem começam. Tudo que já rodou fica gravado e baixável.
app.post('/api/benchmark-simulacao/lote/:id/cancelar', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const lote = readBenchLote(req.params.id);
  if (!lote) return res.status(404).json({ error: 'Lote não encontrado.' });
  if (req.user.role !== 'admin' && lote.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este lote é de outro usuário.' });
  }
  if (lote.status !== 'processing') return res.status(400).json({ error: 'Este lote já terminou.' });
  benchCancelados.add(lote.id);
  await markLote(lote.id, { status: 'cancelando' });
  res.json({ ok: true, status: 'cancelando' });
});

// Catálogo da tela: pacientes em teste, opções de interações, quem é o aluno e a
// lista de alunos cadastrados (pra rotular a run e nomear a persona).
app.get('/api/benchmark-simulacao/opcoes', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const alunos = readJSON('users.json')
    .filter((u) => u && isAluno(u.role))
    .map((u) => ({ id: u.id, name: u.name || u.username }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'));
  res.json({ ...benchmark.benchCatalogo(), alunos });
});

// Dispara uma run. Devolve o id na hora; o trabalho segue em background.
app.post('/api/benchmark-simulacao', requireAuth, requireRole('supervisor', 'admin'), aiLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const log = clampStr(b.log, 200000).trim();
    const casoId = b.casoId;
    const pacienteKey = b.paciente;
    const interacoesPedidas = Number(b.interacoes);
    const alunoNome = clampStr(b.alunoNome, 80).trim();

    if (!log) return res.status(400).json({ error: 'Envie o log do atendimento que será replicado.' });
    if (log.length < 200) return res.status(400).json({ error: 'O log é curto demais para extrair a persona do aluno (mínimo 200 caracteres).' });
    if (!casoId) return res.status(400).json({ error: 'Selecione o paciente que foi atendido.' });
    const paciente = benchmark.patientPreset(pacienteKey);
    if (!paciente) {
      return res.status(400).json({ error: `Modelo de paciente inválido (${Object.keys(benchmark.BENCH_PACIENTES).join(' | ')}).` });
    }
    if (!benchmark.isValidInteracoes(interacoesPedidas)) {
      return res.status(400).json({ error: `Número de interações inválido (${benchmark.BENCH_INTERACOES.join(' | ')}).` });
    }

    // Prompt do personagem resolvido no servidor, igual à produção — o cliente
    // nunca manda systemPrompt.
    const resolved = resolveChatSystemPrompt({ context: { type: 'freeplay', itemId: casoId }, user: req.user });
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    const aluno = benchmark.alunoPreset();
    const clientPaciente = getClientForSimProvider(paciente.provider);
    if (!clientPaciente) {
      return res.status(503).json({ error: `Indisponível: ${simProviderKeyName(paciente.provider)} não configurada (modelo do paciente).` });
    }
    const clientAluno = getClientForSimProvider(aluno.provider);
    if (!clientAluno) {
      return res.status(503).json({ error: `Indisponível: ${simProviderKeyName(aluno.provider)} não configurada (modelo do aluno simulado).` });
    }

    if (await benchOcupado(req.user.id)) {
      return res.status(409).json({ error: 'Você já tem um benchmark rodando. Espere terminar (ou cancele) antes de começar outro.' });
    }

    const freeChar = readJSON('freeplay-characters.json').find((c) => String(c.id) === String(casoId));
    const casoNome = freeChar ? freeChar.name : '';
    const id = 'bench-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');

    const run = {
      id,
      createdAt: new Date().toISOString(),
      completedAt: null,
      userId: req.user.id,
      userName: req.user.name || '',
      casoId, casoNome,
      alunoNome,
      interacoesPedidas,
      paciente, aluno,
      // Resumo de raciocínio só entra quando é de graça (ver capturaResumo).
      capturaPaciente: benchmark.capturaResumo(paciente),
      capturaAluno: benchmark.capturaResumo(aluno),
      status: 'processing',
      error: null,
      persona: '',
      personaTurno: null,
      transcript: [],   // [{ ator: 'paciente'|'aluno', texto }]
      interacoes: [],   // [{ n, paciente: turno, aluno: turno }] — turno sem texto
      resumo: null,
    };
    writeBenchRun(run);

    const job = {
      id, createdAt: run.createdAt, completedAt: null,
      userId: req.user.id, userName: run.userName,
      casoId, casoNome, alunoNome,
      pacienteKey: paciente.key, pacienteLabel: paciente.label,
      alunoLabel: aluno.label,
      interacoesPedidas,
      status: 'processing',
      progresso: { feitas: 0, total: interacoesPedidas },
      resumo: null, error: null,
    };
    await withFileLock('benchmark-fila.json', async () => {
      const arr = readJSON('benchmark-fila.json');
      arr.push(job);
      writeJSON('benchmark-fila.json', arr);
    });

    runBenchmarkRun({ run, log, pacienteSystemPrompt: resolved.systemPrompt, clientPaciente, clientAluno })
      .then((r) => {
        console.log(`[bench] ${id} ${r.status} — ${r.interacoes.length} interação(ões), total ${r.resumo && r.resumo.totalUsd != null ? '$' + r.resumo.totalUsd.toFixed(6) : 'n/d'}`);
      })
      .catch(async (e) => {
        // Job assíncrono: ninguém espera resposta HTTP, então o painel de Logs de
        // Erro é o único lugar onde a falha aparece inteira. O parcial já está
        // gravado e continua baixável.
        registrarErro(null, e, 'benchmark-simulação/job', { extra: { id, paciente: paciente.key, interacoes: interacoesPedidas } });
        run.status = 'error';
        run.error = e.message;
        run.completedAt = new Date().toISOString();
        try { writeBenchRun(run); } catch {}
        await markBenchJob(id, {
          status: 'error', error: e.message, completedAt: run.completedAt,
          progresso: { feitas: run.interacoes.length, total: interacoesPedidas },
          resumo: run.resumo,
        });
      })
      .finally(() => { benchCancelados.delete(id); });

    console.log(`[bench] ${id} iniciado: ${paciente.label} × ${interacoesPedidas} interações (aluno ${aluno.label})`);
    res.json({ id, status: 'processing' });
  } catch (err) {
    if (!res.headersSent) res.status(500).json(falhou(req, err, 'benchmark-simulação'));
  }
});

// Fila/histórico de runs. Supervisor vê as próprias; admin vê todas. Registrada
// ANTES de /:id — senão 'fila' cairia no parâmetro.
app.get('/api/benchmark-simulacao/fila', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const jobs = readJSON('benchmark-fila.json')
    .filter((j) => j && (req.user.role === 'admin' || j.userId === req.user.id))
    .sort((a, c) => new Date(c.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
  res.json(jobs);
});

// Uma run inteira (transcrição + custo por interação). É o que a tela faz polling
// enquanto roda — o resumo do raciocínio NÃO vem aqui, tem endpoint próprio.
app.get('/api/benchmark-simulacao/:id', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const run = readBenchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Benchmark não encontrado.' });
  if (req.user.role !== 'admin' && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este benchmark é de outro usuário.' });
  }
  const semRaciocinio = (run.interacoes || []).map((it) => ({
    n: it.n,
    paciente: it.paciente ? { ...it.paciente, reasoning: undefined } : null,
    aluno: it.aluno ? { ...it.aluno, reasoning: undefined } : null,
  }));
  res.json({
    ...run,
    interacoes: semRaciocinio,
    personaTurno: run.personaTurno ? { ...run.personaTurno, reasoning: undefined } : null,
    reasoningDisponivel: benchmark.temReasoning(run),
  });
});

// Log completo em texto puro (a tela transforma em arquivo).
app.get('/api/benchmark-simulacao/:id/log', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const run = readBenchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Benchmark não encontrado.' });
  if (req.user.role !== 'admin' && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este benchmark é de outro usuário.' });
  }
  res.type('text/plain; charset=utf-8').send(benchmark.buildBenchLogTxt(run));
});

// Ficha de persona do aluno em texto puro. Mesma regra de acesso dos outros dois
// arquivos; 404 enquanto a extração não terminou.
app.get('/api/benchmark-simulacao/:id/persona', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const run = readBenchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Benchmark não encontrado.' });
  if (req.user.role !== 'admin' && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este benchmark é de outro usuário.' });
  }
  const txt = benchmark.buildBenchPersonaTxt(run);
  if (!txt) return res.status(404).json({ error: 'Esta run ainda não gerou a ficha de persona.' });
  res.type('text/plain; charset=utf-8').send(txt);
});

// Resumo do raciocínio — arquivo SEPARADO do log (pedido do dono). Só existe
// quando algum lado devolveu resumo sem custo extra.
app.get('/api/benchmark-simulacao/:id/reasoning', requireAuth, requireRole('supervisor', 'admin'), (req, res) => {
  const run = readBenchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Benchmark não encontrado.' });
  if (req.user.role !== 'admin' && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este benchmark é de outro usuário.' });
  }
  const txt = benchmark.buildBenchReasoningTxt(run);
  if (!txt) {
    return res.status(404).json({ error: 'Esta run não guardou raciocínio: nenhum dos dois lados devolve resumo de graça nesta configuração (effort none não pensa; modelo "mini" não tem sumarizador).' });
  }
  res.type('text/plain; charset=utf-8').send(txt);
});

// Cancela uma run em andamento. O loop para na próxima interação e o parcial fica
// gravado (com o custo do que já rodou — dinheiro gasto não desaparece do
// relatório).
app.post('/api/benchmark-simulacao/:id/cancelar', requireAuth, requireRole('supervisor', 'admin'), async (req, res) => {
  const run = readBenchRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Benchmark não encontrado.' });
  if (req.user.role !== 'admin' && run.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este benchmark é de outro usuário.' });
  }
  if (run.status !== 'processing') return res.status(400).json({ error: 'Esta run já terminou.' });
  benchCancelados.add(run.id);
  await markBenchJob(run.id, { status: 'cancelando' });
  res.json({ ok: true, status: 'cancelando' });
});

// Runs que ficaram 'processing' de um processo anterior: o loop vivia em memória,
// então um restart do servidor as deixa órfãs. Marca uma vez, no boot, pra a tela
// não ficar esperando por algo que não roda mais.
(function marcarBenchmarksOrfaos() {
  try {
    const arr = readJSON('benchmark-fila.json');
    let mudou = false;
    for (const j of arr) {
      if (j && (j.status === 'processing' || j.status === 'aguardando' || j.status === 'cancelando')) {
        j.status = 'error';
        j.error = 'Interrompido por reinício do servidor (o parcial continua baixável).';
        j.completedAt = new Date().toISOString();
        mudou = true;
        const run = readBenchRun(j.id);
        if (run && run.status === 'processing') {
          run.status = 'error';
          run.error = j.error;
          run.completedAt = j.completedAt;
          try { writeBenchRun(run); } catch {}
        }
      }
    }
    if (mudou) writeJSON('benchmark-fila.json', arr);

    const lotes = readJSON('benchmark-lotes.json');
    let mudouLote = false;
    for (const l of lotes) {
      if (l && (l.status === 'processing' || l.status === 'cancelando')) {
        l.status = 'error';
        l.error = 'Interrompido por reinício do servidor (o que rodou continua baixável).';
        l.completedAt = new Date().toISOString();
        mudouLote = true;
      }
    }
    if (mudouLote) writeJSON('benchmark-lotes.json', lotes);
  } catch (e) {
    console.error('[bench] falha ao marcar runs órfãs:', e.message);
  }
})();

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
// comparativo roda server-side, gera a análise + bloco [notas]
// (A1..A15 = challenger, B1..B15 = opponent), e o backend calcula as duas notas
// (server/scoring.js) e o vencedor. Só treino por enquanto — não toca no MMR.

const DUEL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // mesma janela dos logs
const DUEL_MAX_MESSAGES = 500;
const DUEL_MAX_MESSAGE_LEN = 20000;

function readDuels() { return readJSON('duels.json', []); }
function writeDuels(d) { writeJSON('duels.json', d); }
function readNotifications() { return readJSON('notifications.json', {}); }
function writeNotifications(n) { writeJSON('notifications.json', n); }
function readPushSubs() { return readJSON('push-subscriptions.json', {}); }
function writePushSubs(s) { writeJSON('push-subscriptions.json', s); }

// URL de destino ao clicar/tocar na notificação (in-app e push usam a mesma).
function notificationUrl(n) {
  switch (n.type) {
    case 'duel_invite': return `/duelo/aceitar/${n.duelId}`;
    case 'duel_result': return `/duelo/sessao/${n.duelId}`;
    case 'achievement_unlocked':
    case 'sidequest_completed': return '/missoes';
    case 'sidequest_assigned': return '/progressao';
    case 'evaluation_queued':
    case 'evaluation_ready': return '/logs';
    case 'comunidade_reply': return `/comunidade/discussao/${n.discussionId}`;
    default: return '/';
  }
}

// Título+corpo em TEXTO PURO pra notificação do sistema operacional (o sino
// in-app usa iconFor/bodyFor em JSX no client — aqui é o mesmo mapeamento,
// mas server-side e sem markup). `tag` agrupa no tray do SO: reenviar com o
// MESMO tag substitui a notificação anterior em vez de empilhar; `renotify`
// força o SO a alertar (som/vibração) de novo mesmo substituindo uma existente
// — é o mecanismo nativo que usamos pra "fila" → "pronta" virar update, não
// duas notificações soltas (ver upsertEvaluationNotification).
function notificationPushPayload(n) {
  const base = { tag: n.refId || n.id, renotify: true, url: notificationUrl(n) };
  switch (n.type) {
    case 'duel_invite':
      return { ...base, title: 'Novo desafio de duelo', body: `${n.fromName} te desafiou${n.characterName ? ` para atender ${n.characterName}` : ''}.` };
    case 'duel_result':
      return { ...base, title: 'Duelo finalizado', body: `Contra ${n.opponentName}: ${n.outcome === 'win' ? 'você venceu!' : n.outcome === 'loss' ? 'você perdeu.' : 'empate.'}` };
    case 'achievement_unlocked':
      return { ...base, title: 'Conquista liberada', body: n.title || '' };
    case 'sidequest_assigned':
      return { ...base, title: 'Novo exercício', body: n.title || '' };
    case 'sidequest_completed':
      return { ...base, title: 'Exercício concluído', body: n.title || '' };
    case 'admin_notice':
      return { ...base, title: n.title || 'Aviso', body: n.message || '' };
    case 'evaluation_queued':
      return { ...base, title: 'Avaliação enviada', body: n.message || '' };
    case 'evaluation_ready':
      return { ...base, title: 'Avaliação concluída', body: n.message || '' };
    case 'comunidade_reply':
      return { ...base, title: 'Nova resposta na Comunidade', body: `${n.fromName} comentou em "${n.title || 'sua discussão'}".` };
    default:
      return { ...base, title: n.title || 'Notificação', body: n.message || '' };
  }
}

// Envia a notificação via Web Push pra todos os dispositivos assinados do
// usuário. Best-effort e fire-and-forget: nunca deve atrasar nem derrubar o
// fluxo que a chamou (mesmo contrato de pushNotification). Assinatura
// expirada/revogada (404/410) é removida do store; qualquer outro erro só loga.
function sendWebPushToUser(userId, entry) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const all = readPushSubs();
  const subs = all[userId];
  if (!Array.isArray(subs) || !subs.length) return;
  const payload = JSON.stringify(notificationPushPayload(entry));
  let changed = false;
  Promise.all(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload).catch((err) => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        const idx = subs.indexOf(s);
        if (idx >= 0) { subs.splice(idx, 1); changed = true; }
      } else {
        console.warn('[push] falha ao enviar:', err && err.message);
      }
    })
  )).then(() => {
    if (changed) { all[userId] = subs; writePushSubs(all); }
  }).catch(() => {});
}

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

// Cria uma notificação para um usuário real (visitantes não recebem). Também
// dispara Web Push pros dispositivos assinados dele (mesmo sistema, best-effort).
function pushNotification(userId, notif) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const all = readNotifications();
  if (!all[userId]) all[userId] = [];
  const entry = {
    id: 'ntf-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    read: false,
    ...notif,
  };
  all[userId].unshift(entry);
  // Cap de 50 notificações por usuário pra não inchar o arquivo.
  if (all[userId].length > 50) all[userId] = all[userId].slice(0, 50);
  writeNotifications(all);
  sendWebPushToUser(userId, entry);
}

// Cria OU ATUALIZA (por refId) uma notificação — usado pro ciclo de vida de uma
// avaliação: "na fila" vira "pronta" na MESMA linha (não duas notificações
// soltas), reaproveitando o `tag`+`renotify` do Web Push pra também substituir
// a notificação do SO e alertar de novo. `read` sempre volta a false e
// `createdAt` é atualizado: é informação NOVA (a fila virou resultado),
// reordena pro topo do sino e conta de novo no polling (ver NotificationBell).
function upsertEvaluationNotification(userId, refId, notif) {
  if (!userId || String(userId).startsWith('visitor-')) return;
  const all = readNotifications();
  if (!all[userId]) all[userId] = [];
  const idx = all[userId].findIndex((n) => n.refId === refId);
  let entry;
  if (idx >= 0) {
    entry = { ...all[userId][idx], ...notif, refId, read: false, createdAt: new Date().toISOString() };
    all[userId].splice(idx, 1);
  } else {
    entry = {
      id: 'ntf-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      createdAt: new Date().toISOString(),
      read: false,
      refId,
      ...notif,
    };
  }
  all[userId].unshift(entry);
  if (all[userId].length > 50) all[userId] = all[userId].slice(0, 50);
  writeNotifications(all);
  sendWebPushToUser(userId, entry);
}

const EVAL_QUEUED_MESSAGE = 'Sua avaliação está na fila. Em até 24 horas, você receberá uma nova notificação quando sua avaliação for concluída.';

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

// Avaliação do atendimento anterior do aluno com aquele paciente, para o
// avaliador de progressão: as notas por critério + o FEEDBACK que o aluno leu.
//
// Antes daqui saía só a seção "Pontos para revisar com seu supervisor", que os
// avaliadores v15/v16 emitiam com título fixo. No v18.25 esse movimento virou um
// parágrafo sem rótulo dentro da prosa, então não há mais o que recortar — vai o
// feedback inteiro (limitado), que é a mesma informação e ainda fecha o ciclo
// melhor. `pointsToReview` continua sendo extraído quando o log é antigo e tem a
// seção, só pra não perder o destaque em quem já tem histórico.
const PREV_FEEDBACK_MAX = 8000;

function getPreviousFeedback(userId, characterId) {
  const lastLog = getLastLogForCharacter(userId, characterId);
  if (!lastLog) return { criteria: null, feedback: '', pointsToReview: '' };

  const text = lastLog.evaluation || '';
  const { criteria } = extractSupervisorNotes(text, { greeting: false });

  const pointsMatch = text.match(/pontos?\s+para\s+revisar\s+com\s+(?:seu\s+)?supervisor[:\s]*([\s\S]*?)(?:\[notas-supervisor\]|$)/i);
  const pointsToReview = pointsMatch ? pointsMatch[1].trim() : '';

  return { criteria, feedback: clampStr(text, PREV_FEEDBACK_MAX).trim(), pointsToReview };
}

// Nomes dos critérios para rotular as notas do atendimento anterior no contexto
// do avaliador de progressão. Logs antigos têm a grade de 6 critérios (v15/v16);
// os novos têm os 15 do v18.25. Sem rótulo, o avaliador leria "3: 7" sem saber de
// que dimensão se trata — e pior, leria a grade antiga como se fosse a nova.
const CRITERIA_NAMES_V18 = {
  1: 'Precisão lexical', 2: 'Construção e economia', 3: 'Modulação da intensidade clínica',
  4: 'Adequação à prontidão para mudança', 5: 'Manejo do vínculo', 6: 'Antifragilidade',
  7: 'Coerência interna', 8: 'Coerência narrativa', 9: 'Ganchos verbais', 10: 'Ganchos não-verbais',
  11: 'Profundidade vertical', 12: 'Articulação lateral', 13: 'Formulação',
  14: 'Flexibilidade', 15: 'Criatividade',
};
const CRITERIA_NAMES_V16 = {
  1: 'Construção linguística', 2: 'Relação terapêutica', 3: 'Confiança transmitida',
  4: 'Priorização', 5: 'Aprofundamento', 6: 'Flexibilidade e Criatividade',
};

// Bloco "[AVALIAÇÃO DO ATENDIMENTO 1]" do contexto de progressão. Retorna '' se
// não houver avaliação anterior aproveitável.
function buildPreviousEvalSection({ criteria, feedback, pointsToReview }) {
  const parts = [];
  if (criteria && Object.keys(criteria).length) {
    const keys = Object.keys(criteria).map((k) => Number(k)).filter(Number.isFinite);
    const legacy = keys.length > 0 && Math.max(...keys) <= 6;
    const names = legacy ? CRITERIA_NAMES_V16 : CRITERIA_NAMES_V18;
    const lines = Object.entries(criteria)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${k} · ${names[Number(k)] || 'Critério ' + k}: ${v}`)
      .join('\n');
    parts.push(
      legacy
        ? `Notas por critério (grade ANTIGA, de 6 critérios — referência grossa do nível anterior, não comparável critério a critério com a grade de 15):\n${lines}`
        : `Notas por critério (0–10):\n${lines}`,
    );
  }
  if (feedback) parts.push(`Feedback que o aluno leu:\n${feedback}`);
  else if (pointsToReview) parts.push(`Pontos para revisar com supervisor:\n${pointsToReview}`);
  if (!parts.length) return '';
  return `[AVALIAÇÃO DO ATENDIMENTO 1]\n${parts.join('\n\n')}\n`;
}

// Executa avaliação de progressão: compara Atendimento 1 (anterior) vs Atendimento 2 (novo).
// userMessages: array de mensagens da nova sessão (Log 2).
// Retorna { evaluationClean, criteria } onde criteria tem apenas as 15 notas do Atendimento 2.
async function runProgressionEvaluation(userId, characterId, userMessages) {
  const openai = getOpenAI();

  if (!openai) {
    const criteria = {};
    for (let i = 1; i <= 15; i++) criteria[i] = 0;
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

  // Avaliação do Atendimento 1 (notas por critério + feedback que o aluno leu)
  const previousFeedbackSection = buildPreviousEvalSection(getPreviousFeedback(userId, characterId));

  // Monta o conteúdo para o avaliador de progressão (Bloco 1 + atendimento 1 +
  // avaliação do 1 + atendimento 2, na ordem que o prompt v18.25 descreve).
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
  const challengerName = duel.challenger.name || 'Aluno A';
  const opponentName = duel.opponent.name || 'Aluno B';
  const logA = transcriptFromMessages(duel.challenger.messages, challengerName, duel.character.name);
  const logB = transcriptFromMessages(duel.opponent.messages, opponentName, duel.character.name);

  // Avaliador da categoria "Duelo" (Administração → Modelos de IA).
  const spec = evaluatorSpecFor('duelo');
  const provider = spec.provider;
  const client = getClientForProvider(provider);

  if (!client) {
    // Modo demonstração (sem API key): nota neutra pros dois, sem vencedor real.
    const criteria = {};
    for (let i = 1; i <= 15; i++) { criteria['A' + i] = 5; criteria['B' + i] = 5; }
    const comp = comparativeScores(criteria);
    return {
      evaluationClean: `[Modo demonstração — ${provider} indisponível] Avaliação comparativa indisponível.`,
      comp,
    };
  }

  const bloco1 = resolveBloco1({ context: { type: 'freeplay', itemId: duel.character.id } });
  const userContent =
    (bloco1 ? `[BLOCO 1 DO CASO] (referência interna do avaliador — gabarito)\n${bloco1}\n\n---\n\n` : '') +
    `[LOG DO ALUNO A — ${challengerName}]\n${logA || '(sem mensagens)'}\n\n---\n\n` +
    `[LOG DO ALUNO B — ${opponentName}]\n${logB || '(sem mensagens)'}`;

  // Avaliador comparativo em chat.completions (reasoning oculto → Bloco 1 não
  // vaza). Sempre SÍNCRONO, qualquer que seja o modelo: o resultado do duelo
  // aparece na hora, para os dois alunos, então batch está fora de questão aqui.
  const body = buildChatBody({
    provider, model: spec.model, effort: spec.effort, maxTokens: 64000,
    messages: buildOpenAIMessages(loadComparativoPrompt(), [{ role: 'user', content: userContent }]),
  });
  const resp = await client.chat.completions.create(body);
  const msg = (resp.choices && resp.choices[0] && resp.choices[0].message) || {};
  const text = msg.content || '';
  logOpenAIUsage('Duel evaluate', spec.model, resp.usage || null);
  // Sem saudação: a análise do Duelo é comparativa, escrita para os dois alunos
  // (a saudação em segunda pessoa do singular não cabe aqui).
  const { clean, criteria } = extractSupervisorNotes(text, { greeting: false });
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
    .filter((u) => isAluno(u.role) && u.id !== req.user.id)
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

// A pessoa quer receber Exercício (a antiga sidequest) no atendimento?
// Interruptor do próprio usuário, no Perfil. Vale para os DOIS tipos de
// objetivo — a sidequest do supervisor e a missão diária: da cadeira do aluno
// os dois são a mesma coisa (um objetivo que vira o foco da sessão), então
// desligar um e receber o outro no lugar não faria sentido nenhum.
//
// Ausente = ligado: contas criadas antes deste campo continuam como estavam.
function exerciciosLigados(userId) {
  if (!userId || String(userId).startsWith('visitor-')) return true;
  try {
    const u = readJSON('users.json').find((x) => x.id === userId);
    return !u || u.sidequestsEnabled !== false;
  } catch {
    return true; // na dúvida, comporta-se como antes do interruptor existir
  }
}

// Missão do Treinamento: UMA ou OUTRA, nunca as duas. Fonte única de verdade —
// prompt do avaliador, conclusão pós-sessão e /api/me/daily-mission passam aqui.
// Devolve { sidequest, daily } com no máximo um dos dois preenchido.
function resolveTrainingMission(userId) {
  if (!exerciciosLigados(userId)) return { sidequest: null, daily: null };
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
  if (!target || !isAluno(target.role)) {
    return res.status(400).json({ error: 'Sidequests só podem ser atribuídas a alunos.' });
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
  // Desligado no Perfil: a sidequest continua ATRIBUÍDA (o supervisor não a
  // perde), só não é servida — some do banner e do prompt. Religar devolve.
  const ligado = req.user.sidequestsEnabled !== false;
  res.json({
    active: ligado ? publicSidequest(data.active[req.user.id] || null) : null,
    completed: data.completed[req.user.id] || [],
    enabled: ligado,
  });
});

// Missão diária do usuário (Treinamento). Mostra a do dia + se ele já concluiu.
// Com sidequest do supervisor ativa a diária fica DESLIGADA (uma ou outra — ver
// resolveTrainingMission): responde mission null + pausedBySidequest, e a tela
// mostra só a sidequest.
app.get('/api/me/daily-mission', requireAuth, (req, res) => {
  if (req.user.role !== 'visitor' && req.user.sidequestsEnabled === false) {
    return res.json({ mission: null, completed: false, disabled: true });
  }
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

// --- Web Push (assinatura do navegador para notificação do SO, com som) ---
// Chave pública: sem auth (é pública por definição — precisa dela ANTES de
// logar, no fluxo de permissão do navegador). Vazia enquanto VAPID não está
// configurado — o client trata isso como "push indisponível" e não oferece o botão.
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, writeLimiter, (req, res) => {
  if (req.user.role === 'visitor') return res.json({ ok: true }); // visitante não recebe notificação — no-op
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Assinatura de push inválida.' });
  }
  const all = readPushSubs();
  if (!all[req.user.id]) all[req.user.id] = [];
  const list = all[req.user.id];
  const entry = {
    endpoint: sub.endpoint,
    keys: { p256dh: clampStr(sub.keys.p256dh, 300), auth: clampStr(sub.keys.auth, 100) },
    ua: clampStr(req.get('user-agent'), 300),
    createdAt: new Date().toISOString(),
  };
  const idx = list.findIndex((s) => s.endpoint === entry.endpoint);
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  // Cap por usuário — celular + PC + eventual reinstalação não deve crescer sem limite.
  if (list.length > 10) all[req.user.id] = list.slice(-10);
  writePushSubs(all);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, writeLimiter, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint === 'string' && endpoint) {
    const all = readPushSubs();
    if (Array.isArray(all[req.user.id])) {
      all[req.user.id] = all[req.user.id].filter((s) => s.endpoint !== endpoint);
      writePushSubs(all);
    }
  }
  res.json({ ok: true });
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

// Escrita (criar/editar/entregar/excluir) é restrita a aluno (interno ou
// externo) e admin. O aluno externo SEM supervisor pode montar e entregar o
// mapa normalmente — a entrega só não é vista por ninguém até o admin vinculá-lo
// a um supervisor pela tela de Contas, e a partir daí os mapas entregues
// aparecem pro supervisor como os de qualquer aluno.
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
app.get('/api/antessala', requireAuth, requireRole('therapist', 'external', 'admin'), (req, res) => {
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
      users.filter((u) => isAluno(u.role) && u.teacherId === req.user.id).map((u) => u.id),
    );
    visible = all.filter((c) => c.status === 'delivered' && myStudents.has(c.ownerId));
  }
  visible.sort((a, b) => new Date(b.deliveredAt || b.updatedAt || 0) - new Date(a.deliveredAt || a.updatedAt || 0));
  res.json(visible.map(antessalaSummary));
});

// POST /api/antessala/reflect — camada maiêutica. { step, doc } → perguntas.
// O system prompt é montado no servidor (papel travado). Registrado ANTES de /:id.
app.post('/api/antessala/reflect', requireAuth, requireRole('therapist', 'external', 'admin'), aiLimiter, async (req, res) => {
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
app.post('/api/antessala', requireAuth, requireRole('therapist', 'external', 'admin'), writeLimiter, async (req, res) => {
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
app.put('/api/antessala/:id', requireAuth, requireRole('therapist', 'external', 'admin'), writeLimiter, async (req, res) => {
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
app.post('/api/antessala/:id/deliver', requireAuth, requireRole('therapist', 'external', 'admin'), writeLimiter, async (req, res) => {
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
app.delete('/api/antessala/:id', requireAuth, requireRole('therapist', 'external', 'admin'), writeLimiter, async (req, res) => {
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

// ----------------------------------------------------------------------------
// COMUNIDADE — discussões, comentários, votos e enquetes
// ----------------------------------------------------------------------------
// Espaço de troca entre os membros + comunicação institucional da Allos. Uma
// "discussão" é o que o Reddit chama de thread: título, texto (ou enquete),
// votos e comentários.
//
// A regra de acesso que dita o desenho: TODA discussão tem link próprio
// (/comunidade/discussao/:id) que abre para QUALQUER pessoa, sem conta e sem
// sessão de visitante — é o botão "compartilhar" funcionando de verdade, com um
// link que serve para mandar no WhatsApp. Por isso GET de uma discussão é a
// única rota deste bloco sem requireAuth (usa optionalAuth, que só popula
// req.user quando há token válido). Escrever exige conta real: visitante lê
// tudo e não escreve nada.
//
// Dois arquivos no DATA_DIR:
//   comunidade.json        → { nextId, discussions: [...] }
//   comunidade-config.json → { institutionAvatar, visitorAvatars[], bans{} }
// A separação é proposital: a config é escrita só pelo admin e lida em toda
// requisição; misturá-la ao feed faria cada comentário reescrever a lista de
// banimentos junto.
const comunidade = require('./comunidade');

const COMUNIDADE_FILE = 'comunidade.json';
const COMUNIDADE_CONFIG_FILE = 'comunidade-config.json';

// Avatares da Comunidade (logo da Associação + pool do visitante) vivem no
// volume, como as fotos de paciente — sobrevivem a redeploy do Railway.
const COMUNIDADE_AVATARS_DIR = path.join(DATA_DIR, 'comunidade-avatars');
if (!fs.existsSync(COMUNIDADE_AVATARS_DIR)) fs.mkdirSync(COMUNIDADE_AVATARS_DIR, { recursive: true });
app.use('/comunidade-avatars', express.static(COMUNIDADE_AVATARS_DIR, { maxAge: '7d' }));

function readComunidade() {
  const d = readJSON(COMUNIDADE_FILE, { nextId: 1, discussions: [] });
  if (!Array.isArray(d.discussions)) d.discussions = [];
  if (!Number.isFinite(d.nextId)) d.nextId = 1;
  return d;
}
function writeComunidade(d) { writeJSON(COMUNIDADE_FILE, d); }
function readComunidadeConfig() {
  const c = readJSON(COMUNIDADE_CONFIG_FILE, {});
  return {
    institutionAvatar: c.institutionAvatar || null,
    visitorAvatars: Array.isArray(c.visitorAvatars) ? c.visitorAvatars : [],
    bans: (c.bans && typeof c.bans === 'object') ? c.bans : {},
  };
}
function writeComunidadeConfig(c) { writeJSON(COMUNIDADE_CONFIG_FILE, c); }

// Auth OPCIONAL: popula req.user quando há um token válido e segue em frente
// quando não há. É o que permite a mesma rota servir o membro logado (com o
// voto dele marcado) e quem abriu o link compartilhado sem conta nenhuma.
// Token inválido ou expirado é tratado como ausência de sessão — nunca 401:
// aqui um 401 derrubaria a leitura pública, que é justamente o ponto da rota.
function optionalAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
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
    const user = users.find((u) => u.id === payload.sub);
    if (user && (payload.tv || 0) === (user.tokenVersion || 0)) req.user = user;
  } catch { /* segue como leitor anônimo */ }
  next();
}

// Quem pode escrever AGORA: papel participante e sem banimento vigente.
// Devolve { ok } ou { ok:false, status, error } pronto pra resposta.
function podeEscrever(user, config) {
  if (!user) return { ok: false, status: 401, error: 'Crie uma conta para participar da Comunidade.' };
  if (!comunidade.podeParticipar(user.role)) {
    return { ok: false, status: 403, error: 'Crie uma conta para participar da Comunidade.' };
  }
  const ban = comunidade.banAtivo(config, user.id);
  if (ban) return { ok: false, status: 403, error: comunidade.mensagemBan(ban) };
  return { ok: true };
}

// Snapshot do autor gravado junto do post: SÓ o papel, nunca nome ou foto.
// Nome e foto vêm da conta viva a cada leitura (ver autorPublico), o que faz a
// exclusão de conta apagar de fato a identidade de quem escreveu. O papel fica
// para manter o selo coerente quando a conta some.
function autorSnapshot(user) {
  return { role: user.role };
}

function acharDiscussao(store, id) {
  return store.discussions.find((d) => String(d.id) === String(id)) || null;
}

// --- Leitura ---

// Feed. Exige sessão (inclusive a de visitante, que o app cria sozinho) porque
// é a porta de entrada dentro do app; o link público é o da discussão avulsa.
app.get('/api/comunidade', requireAuth, (req, res) => {
  const store = readComunidade();
  const config = readComunidadeConfig();
  const users = readJSON('users.json');
  const sort = req.query.sort === 'top' ? 'top' : 'recent';
  const podeVotar = podeEscrever(req.user, config);
  const ctx = { users, config, viewerId: req.user.id };
  res.json({
    discussions: comunidade.ordenarFeed(store.discussions, sort)
      .map((d) => comunidade.discussaoResumo(d, ctx)),
    canPost: podeVotar.ok,
    // A tela precisa distinguir "não pode porque é visitante" de "não pode
    // porque está suspenso" — as duas mensagens são bem diferentes.
    blockedReason: podeVotar.ok ? null : podeVotar.error,
  });
});

// Discussão avulsa — PÚBLICA de propósito (ver o comentário do topo do bloco).
app.get('/api/comunidade/:id', comunidadePublicaLimiter, optionalAuth, (req, res) => {
  const store = readComunidade();
  const d = acharDiscussao(store, req.params.id);
  if (!d) return res.status(404).json({ error: 'Discussão não encontrada.' });
  const config = readComunidadeConfig();
  const users = readJSON('users.json');
  const permissao = podeEscrever(req.user, config);
  res.json({
    discussion: comunidade.discussaoCompleta(d, {
      users, config, viewerId: req.user ? req.user.id : null, podeVotar: permissao.ok,
    }),
    canPost: permissao.ok,
    blockedReason: permissao.ok ? null : permissao.error,
    // Distingue "leitor sem sessão nenhuma" (banner de cadastro) de "visitante
    // ou suspenso" (mensagem própria). Sem isso a tela não sabe qual mostrar.
    anonymous: !req.user,
    // Só o admin vê os botões de excluir de todo mundo.
    canModerate: !!(req.user && req.user.role === 'admin'),
  });
});

// --- Escrita ---

app.post('/api/comunidade', requireAuth, writeLimiter, async (req, res) => {
  const config = readComunidadeConfig();
  const permissao = podeEscrever(req.user, config);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.error });

  const { erro, valor } = comunidade.validarDiscussao(req.body);
  if (erro) return res.status(400).json({ error: erro });

  // Publicar como Associação Allos é escolha do admin no formulário (ele também
  // participa como pessoa em discussão casual). Congelado no post: é uma decisão
  // editorial daquele texto, não um atributo da conta.
  const asInstitution = !!(req.body && req.body.asInstitution) && req.user.role === 'admin';

  const criada = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = {
      id: String(store.nextId),
      title: valor.title,
      body: valor.body,
      poll: valor.poll,
      authorId: req.user.id,
      author: autorSnapshot(req.user),
      asInstitution,
      createdAt: new Date().toISOString(),
      votes: {},
      comments: [],
    };
    store.nextId += 1;
    store.discussions.push(d);
    writeComunidade(store);
    return d;
  });

  const users = readJSON('users.json');
  res.json(comunidade.discussaoResumo(criada, { users, config, viewerId: req.user.id }));
});

// Excluir discussão: o autor tira a própria, o admin tira qualquer uma
// (moderação mora nos próprios posts, não numa tela separada).
app.delete('/api/comunidade/:id', requireAuth, async (req, res) => {
  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    if (req.user.role !== 'admin' && d.authorId !== req.user.id) {
      return { status: 403, error: 'Você só pode excluir as suas discussões.' };
    }
    store.discussions = store.discussions.filter((x) => String(x.id) !== String(d.id));
    writeComunidade(store);
    return { ok: true };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
  res.json({ ok: true });
});

app.post('/api/comunidade/:id/vote', requireAuth, writeLimiter, async (req, res) => {
  const config = readComunidadeConfig();
  const permissao = podeEscrever(req.user, config);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.error });

  const valor = comunidade.normalizarVoto(req.body && req.body.value);
  if (valor === null) return res.status(400).json({ error: 'Voto inválido.' });

  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    d.votes = comunidade.aplicarVoto(d.votes, req.user.id, valor);
    writeComunidade(store);
    return { score: comunidade.score(d.votes), myVote: comunidade.meuVoto(d.votes, req.user.id) };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
  res.json(resultado);
});

// Voto na enquete. Escolha única e trocável: gravamos o id da opção por usuário,
// então revotar substitui em vez de somar (não existe "desvotar" — mandar o
// mesmo id de novo mantém o voto, o que evita zerar por duplo clique).
app.post('/api/comunidade/:id/poll', requireAuth, writeLimiter, async (req, res) => {
  const config = readComunidadeConfig();
  const permissao = podeEscrever(req.user, config);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.error });

  const optionId = String((req.body && req.body.optionId) || '');
  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    if (!d.poll) return { status: 400, error: 'Esta discussão não tem enquete.' };
    if (!d.poll.options.some((o) => o.id === optionId)) {
      return { status: 400, error: 'Opção inválida.' };
    }
    if (!d.poll.votes || typeof d.poll.votes !== 'object') d.poll.votes = {};
    d.poll.votes[req.user.id] = optionId;
    writeComunidade(store);
    return { poll: comunidade.enquetePublica(d.poll, req.user.id, true) };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
  res.json(resultado);
});

// Comentar. `parentId` responde a um comentário — e só a UM nível: responder a
// uma resposta reancora na raiz dela. Sem isso a indentação cresce sem fim e a
// leitura no celular quebra.
app.post('/api/comunidade/:id/comentarios', requireAuth, writeLimiter, async (req, res) => {
  const config = readComunidadeConfig();
  const permissao = podeEscrever(req.user, config);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.error });

  const { erro, valor } = comunidade.validarComentario(req.body);
  if (erro) return res.status(400).json({ error: erro });
  const asInstitution = !!(req.body && req.body.asInstitution) && req.user.role === 'admin';

  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    if (!Array.isArray(d.comments)) d.comments = [];
    if (d.comments.length >= comunidade.MAX_COMMENTS_POR_DISCUSSAO) {
      return { status: 400, error: 'Esta discussão atingiu o limite de comentários.' };
    }

    let parentId = null;
    const pedido = req.body && req.body.parentId;
    if (pedido) {
      const pai = d.comments.find((c) => c.id === String(pedido));
      if (!pai) return { status: 400, error: 'O comentário respondido não existe mais.' };
      parentId = pai.parentId || pai.id; // reancora na raiz: só um nível
    }

    const c = {
      id: 'c' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      body: valor.body,
      parentId,
      authorId: req.user.id,
      author: autorSnapshot(req.user),
      asInstitution,
      createdAt: new Date().toISOString(),
      votes: {},
    };
    d.comments.push(c);
    writeComunidade(store);
    return { discussao: d };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });

  // Avisa quem vai querer saber: o dono da discussão e, numa resposta, o dono do
  // comentário respondido. Nunca a si mesmo, e nunca duas vezes pra mesma pessoa.
  const d = resultado.discussao;
  const novo = d.comments[d.comments.length - 1];
  const alvos = new Set();
  if (d.authorId && d.authorId !== req.user.id) alvos.add(d.authorId);
  if (novo.parentId) {
    const pai = d.comments.find((c) => c.id === novo.parentId);
    if (pai && pai.authorId && pai.authorId !== req.user.id) alvos.add(pai.authorId);
  }
  for (const uid of alvos) {
    pushNotification(uid, {
      type: 'comunidade_reply',
      discussionId: d.id,
      title: d.title,
      fromName: asInstitution ? comunidade.INSTITUTION_NAME : (req.user.name || ''),
    });
  }

  const users = readJSON('users.json');
  res.json(comunidade.discussaoCompleta(d, {
    users, config, viewerId: req.user.id, podeVotar: true,
  }));
});

app.post('/api/comunidade/:id/comentarios/:cid/vote', requireAuth, writeLimiter, async (req, res) => {
  const config = readComunidadeConfig();
  const permissao = podeEscrever(req.user, config);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.error });

  const valor = comunidade.normalizarVoto(req.body && req.body.value);
  if (valor === null) return res.status(400).json({ error: 'Voto inválido.' });

  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    const c = (d.comments || []).find((x) => x.id === req.params.cid);
    if (!c) return { status: 404, error: 'Comentário não encontrado.' };
    c.votes = comunidade.aplicarVoto(c.votes, req.user.id, valor);
    writeComunidade(store);
    return { score: comunidade.score(c.votes), myVote: comunidade.meuVoto(c.votes, req.user.id) };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
  res.json(resultado);
});

// Excluir comentário. Vira lápide (deleted) em vez de sumir: se ele tinha
// respostas, apagá-lo de vez deixaria as respostas órfãs e sem contexto. A
// projeção esconde a lápide quando não sobrou nenhuma resposta pendurada.
app.delete('/api/comunidade/:id/comentarios/:cid', requireAuth, async (req, res) => {
  const resultado = await withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    const d = acharDiscussao(store, req.params.id);
    if (!d) return { status: 404, error: 'Discussão não encontrada.' };
    const c = (d.comments || []).find((x) => x.id === req.params.cid);
    if (!c) return { status: 404, error: 'Comentário não encontrado.' };
    if (req.user.role !== 'admin' && c.authorId !== req.user.id) {
      return { status: 403, error: 'Você só pode excluir os seus comentários.' };
    }
    c.deleted = true;
    c.body = '';
    delete c.author;
    writeComunidade(store);
    return { ok: true };
  });
  if (resultado.error) return res.status(resultado.status).json({ error: resultado.error });
  res.json({ ok: true });
});

// --- Administração da Comunidade (admin apenas) ---

// Painel: config de avatares + banimentos vigentes + quem já publicou algo
// (é essa lista que alimenta o seletor de "banir usuário" — banir quem nunca
// escreveu não tem uso, e listar a base inteira aqui seria vazamento à toa).
app.get('/api/admin/comunidade', requireAuth, requireRole('admin'), (req, res) => {
  const store = readComunidade();
  const config = readComunidadeConfig();
  const users = readJSON('users.json');
  const agora = Date.now();

  const contagem = new Map(); // userId -> { discussions, comments }
  const bump = (id, campo) => {
    if (!id) return;
    if (!contagem.has(id)) contagem.set(id, { discussions: 0, comments: 0 });
    contagem.get(id)[campo] += 1;
  };
  for (const d of store.discussions) {
    bump(d.authorId, 'discussions');
    for (const c of (d.comments || [])) if (!c.deleted) bump(c.authorId, 'comments');
  }

  const autores = [...contagem.entries()].map(([id, n]) => {
    const u = users.find((x) => x.id === id) || null;
    const ban = comunidade.banAtivo(config, id, agora);
    return {
      id,
      name: u ? u.name : 'Conta removida',
      username: u ? u.username : '',
      role: u ? u.role : null,
      discussions: n.discussions,
      comments: n.comments,
      ban: ban ? { until: ban.until, reason: ban.reason || '' } : null,
    };
  }).sort((a, b) => (b.discussions + b.comments) - (a.discussions + a.comments));

  res.json({
    institutionAvatar: config.institutionAvatar,
    visitorAvatars: config.visitorAvatars,
    maxVisitorAvatars: comunidade.MAX_AVATARES_VISITANTE,
    autores,
    bans: Object.entries(config.bans)
      .filter(([id]) => comunidade.banAtivo(config, id, agora))
      .map(([id, b]) => {
        const u = users.find((x) => x.id === id) || null;
        return { userId: id, name: u ? u.name : 'Conta removida', until: b.until, reason: b.reason || '' };
      }),
  });
});

// Avatar da Associação Allos (o que aparece nas publicações institucionais).
// Mesmo contrato da foto de paciente: o cliente manda o JPEG já recortado como
// data URL, o servidor só grava os bytes. `clear:true` remove.
app.put('/api/admin/comunidade/avatar-instituicao', requireAuth, requireRole('admin'), writeLimiter, (req, res) => {
  const config = readComunidadeConfig();
  const arquivo = path.join(COMUNIDADE_AVATARS_DIR, 'instituicao.jpg');

  if (req.body && req.body.clear) {
    try { if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo); } catch { /* ignora */ }
    config.institutionAvatar = null;
    writeComunidadeConfig(config);
    return res.json({ institutionAvatar: null });
  }

  const img = decodeImageDataUrl(req.body && req.body.image);
  if (!img) return res.status(400).json({ error: 'Envie a imagem como data URL (JPEG, PNG ou WebP).' });
  if (img.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Imagem muito grande.' });
  try {
    fs.writeFileSync(arquivo, img);
  } catch (err) {
    return res.status(500).json(falhou(req, err, 'admin/comunidade-avatar-instituicao'));
  }
  config.institutionAvatar = `/comunidade-avatars/instituicao.jpg?v=${Date.now()}`;
  writeComunidadeConfig(config);
  res.json({ institutionAvatar: config.institutionAvatar });
});

// Pool de avatares do visitante (até 10). Cada visitante recebe um deles de
// forma estável dentro da sessão dele. Groundwork: hoje visitante só LÊ a
// Comunidade, então a pool ainda não aparece em lugar nenhum — o admin já pode
// montá-la para quando a participação sem conta for liberada.
app.post('/api/admin/comunidade/avatar-visitante', requireAuth, requireRole('admin'), writeLimiter, (req, res) => {
  const config = readComunidadeConfig();
  if (config.visitorAvatars.length >= comunidade.MAX_AVATARES_VISITANTE) {
    return res.status(400).json({ error: `A pool aceita no máximo ${comunidade.MAX_AVATARES_VISITANTE} imagens.` });
  }
  const img = decodeImageDataUrl(req.body && req.body.image);
  if (!img) return res.status(400).json({ error: 'Envie a imagem como data URL (JPEG, PNG ou WebP).' });
  if (img.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Imagem muito grande.' });

  const id = 'v' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  try {
    fs.writeFileSync(path.join(COMUNIDADE_AVATARS_DIR, `${id}.jpg`), img);
  } catch (err) {
    return res.status(500).json(falhou(req, err, 'admin/comunidade-avatar-visitante'));
  }
  config.visitorAvatars.push({ id, url: `/comunidade-avatars/${id}.jpg` });
  writeComunidadeConfig(config);
  res.json({ visitorAvatars: config.visitorAvatars });
});

app.delete('/api/admin/comunidade/avatar-visitante/:id', requireAuth, requireRole('admin'), (req, res) => {
  const config = readComunidadeConfig();
  // O id compõe o nome do arquivo — sem esta checagem, um ".." na URL viraria
  // unlink fora da pasta.
  if (!/^[A-Za-z0-9]+$/.test(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const antes = config.visitorAvatars.length;
  config.visitorAvatars = config.visitorAvatars.filter((a) => a.id !== req.params.id);
  if (config.visitorAvatars.length === antes) return res.status(404).json({ error: 'Imagem não encontrada.' });
  try {
    const p = path.join(COMUNIDADE_AVATARS_DIR, `${req.params.id}.jpg`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignora */ }
  writeComunidadeConfig(config);
  res.json({ visitorAvatars: config.visitorAvatars });
});

const BAN_MAX_DIAS = 3650; // 10 anos: na prática "permanente", mas com data

// Banir por N dias. `purge:true` apaga junto TUDO que a pessoa publicou —
// é o caso de spam, em que deixar o conteúdo no ar esvazia o banimento.
app.post('/api/admin/comunidade/ban', requireAuth, requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const userId = String(body.userId || '');
  const dias = Math.round(Number(body.days));
  if (!userId) return res.status(400).json({ error: 'Informe o usuário.' });
  if (!Number.isFinite(dias) || dias < 1 || dias > BAN_MAX_DIAS) {
    return res.status(400).json({ error: `Informe a duração em dias (1 a ${BAN_MAX_DIAS}).` });
  }
  const users = readJSON('users.json');
  const alvo = users.find((u) => u.id === userId);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (alvo.role === 'admin') return res.status(400).json({ error: 'Não dá para banir um administrador.' });

  const config = readComunidadeConfig();
  config.bans[userId] = {
    until: new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString(),
    reason: clampStr(body.reason, 300).trim(),
    by: req.user.id,
    at: new Date().toISOString(),
  };
  writeComunidadeConfig(config);

  let removidos = 0;
  if (body.purge) removidos = await purgarConteudo(userId);
  res.json({ ok: true, until: config.bans[userId].until, removidos });
});

app.delete('/api/admin/comunidade/ban/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const config = readComunidadeConfig();
  if (!config.bans[req.params.userId]) return res.status(404).json({ error: 'Este usuário não está banido.' });
  delete config.bans[req.params.userId];
  writeComunidadeConfig(config);
  res.json({ ok: true });
});

// Apaga conteúdo de um usuário: tudo (`ids` ausente) ou só as discussões
// listadas em `ids`. Comentários viram lápide pelo mesmo motivo do DELETE
// avulso — as respostas pendentes deles precisam continuar legíveis.
async function purgarConteudo(userId, ids = null) {
  const alvo = ids ? new Set(ids.map(String)) : null;
  return withFileLock(COMUNIDADE_FILE, () => {
    const store = readComunidade();
    let n = 0;
    store.discussions = store.discussions.filter((d) => {
      if (d.authorId === userId && (!alvo || alvo.has(String(d.id)))) { n += 1; return false; }
      return true;
    });
    if (!alvo) {
      for (const d of store.discussions) {
        for (const c of (d.comments || [])) {
          if (c.authorId === userId && !c.deleted) {
            c.deleted = true; c.body = ''; delete c.author; n += 1;
          }
        }
      }
    }
    writeComunidade(store);
    return n;
  });
}

// Lista o que um usuário publicou, para o admin escolher o que apagar.
app.get('/api/admin/comunidade/usuario/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const store = readComunidade();
  const minhas = store.discussions
    .filter((d) => d.authorId === req.params.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((d) => ({
      id: d.id,
      title: d.title,
      createdAt: d.createdAt,
      score: comunidade.score(d.votes),
      commentCount: (d.comments || []).filter((c) => !c.deleted).length,
    }));
  const comentarios = [];
  for (const d of store.discussions) {
    for (const c of (d.comments || [])) {
      if (c.authorId === req.params.userId && !c.deleted) {
        comentarios.push({
          id: c.id, discussionId: d.id, discussionTitle: d.title,
          body: clampStr(c.body, 300), createdAt: c.createdAt,
        });
      }
    }
  }
  comentarios.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ discussions: minhas, comments: comentarios });
});

app.post('/api/admin/comunidade/purgar', requireAuth, requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const userId = String(body.userId || '');
  if (!userId) return res.status(400).json({ error: 'Informe o usuário.' });
  const ids = Array.isArray(body.discussionIds) ? body.discussionIds : null;
  const removidos = await purgarConteudo(userId, ids);
  res.json({ ok: true, removidos });
});


// ============================================================================
// BENCHMARK DO PACIENTE SIMULADO — relatório estático atrás de senha
// ----------------------------------------------------------------------------
// Link fixo (/benchmarkpaciente) pra circular o relatório do benchmark com quem
// precisa lê-lo, sem criar conta. NÃO é área do app: é UM arquivo HTML
// autocontido em public/, servido atrás de uma senha compartilhada.
//
// O arquivo é gerado fora do repo (a pasta avaliacao/ é gitignorada por conter
// os logs brutos e os prompts dos personagens); pro deploy, só a página final
// é copiada pra public/.
// ============================================================================
const BENCHMARK_HTML = path.join(__dirname, '..', 'public', 'benchmark-paciente.html');
// Senha compartilhada. Mesmo espírito da do processo seletivo: vai por mensagem
// pra quem vai ler e só destrava um relatório interno — não protege dado
// pessoal. Quem segura força bruta é o benchmarkLimiter.
const BENCHMARK_PASSWORD = process.env.BENCHMARK_PASSWORD || 'albires1';
const BENCHMARK_COOKIE = 'benchmark_acesso';
const BENCHMARK_TTL_H = 12;

function senhaBenchmarkConfere(entrada) {
  const a = Buffer.from(String(entrada == null ? '' : entrada), 'utf8');
  const b = Buffer.from(BENCHMARK_PASSWORD, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(a, a); return false; }
  return crypto.timingSafeEqual(a, b);
}

// O app não usa cookie-parser (nenhuma outra rota precisa de cookie), então o
// header é lido na mão em vez de puxar dependência nova só por isto.
function lerCookie(req, nome) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const parte of raw.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) {
      try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function benchmarkLiberado(req) {
  const tok = lerCookie(req, BENCHMARK_COOKIE);
  if (!tok) return false;
  try {
    const p = jwt.verify(tok, JWT_SECRET);
    return p && p.scope === 'benchmark';
  } catch { return false; }
}

// O CSP global do app é script-src 'self', que bloquearia o script inline do
// relatório (os botões de download). Em vez de afrouxar a política do app
// inteiro, esta rota manda um CSP próprio liberando SÓ o hash daquele script —
// se o relatório for regerado e o script mudar, o hash muda junto e nada
// silenciosamente deixa de valer. O hash é calculado uma vez, na primeira
// visita, e recalculado se o arquivo for trocado (mtime muda).
let _bmHashCache = { mtime: 0, hashes: [] };
function hashesDoRelatorio() {
  let st;
  try { st = fs.statSync(BENCHMARK_HTML); } catch { return []; }
  if (st.mtimeMs === _bmHashCache.mtime) return _bmHashCache.hashes;
  const html = fs.readFileSync(BENCHMARK_HTML, 'utf8');
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`
  );
  _bmHashCache = { mtime: st.mtimeMs, hashes };
  return hashes;
}

function cspDoRelatorio() {
  const scripts = ["'self'", ...hashesDoRelatorio()].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scripts}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    // O download monta um Blob e clica num <a download>. Esta combinação foi
    // verificada em navegador com o CSP aplicado: sem blob: aqui, os botões
    // de exportação morrem calados.
    "media-src 'self' blob:",
    "connect-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join('; ');
}

const benchmarkLimiter = SKIP_RATE_LIMIT ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
});

function paginaSenhaBenchmark({ erro } = {}) {
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Benchmark do paciente simulado — Allos</title>
<style>
:root{color-scheme:light dark;--bg:#F4F5F8;--card:#fff;--ink:#171A21;--muted:#6B7383;
  --rule:#DCE0E7;--accent:#1F4FD8;--crit:#AE2317}
@media (prefers-color-scheme:dark){:root{--bg:#0D1015;--card:#14181F;--ink:#E7EAF0;
  --muted:#8F98A8;--rule:#252B35;--accent:#88A6FF;--crit:#F1786C}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:var(--bg);color:var(--ink);padding:24px;
  font-family:"Segoe UI",system-ui,-apple-system,sans-serif}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;
  padding:36px 34px;max-width:420px;width:100%}
.eyebrow{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);
  margin:0 0 14px;font-family:ui-monospace,monospace}
h1{font-family:Georgia,serif;font-weight:500;font-size:1.6rem;line-height:1.2;margin:0 0 10px}
p.sub{color:var(--muted);font-size:.94rem;line-height:1.55;margin:0 0 24px}
label{display:block;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);margin-bottom:7px;font-family:ui-monospace,monospace}
input{width:100%;padding:11px 13px;font-size:1rem;border:1px solid var(--rule);
  border-radius:5px;background:var(--bg);color:var(--ink);font-family:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
button{width:100%;margin-top:16px;padding:12px;font-size:.96rem;font-weight:600;
  background:var(--accent);color:#fff;border:0;border-radius:5px;cursor:pointer;
  font-family:inherit}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.erro{background:color-mix(in srgb,var(--crit) 12%,transparent);color:var(--crit);
  border:1px solid color-mix(in srgb,var(--crit) 35%,transparent);border-radius:5px;
  padding:10px 12px;font-size:.9rem;margin-bottom:18px}
</style></head><body>
<main class="card">
  <p class="eyebrow">Allos · acesso restrito</p>
  <h1>Benchmark do paciente simulado</h1>
  <p class="sub">Relatório de escolha do modelo de IA que opera o paciente simulado.
     Informe a senha de acesso para ler.</p>
  ${erro ? `<p class="erro">${erro}</p>` : ''}
  <form method="POST" action="/benchmarkpaciente" autocomplete="off">
    <label for="senha">Senha de acesso</label>
    <input id="senha" name="senha" type="password" required autofocus
           autocomplete="current-password" enterkeyhint="go">
    <button type="submit">Ver o relatório</button>
  </form>
</main></body></html>`;
}

// O relatório é privado: nada de cache compartilhado nem indexação.
function enviaRelatorio(req, res) {
  if (!fs.existsSync(BENCHMARK_HTML)) {
    return res.status(503).type('html').send(paginaSenhaBenchmark({
      erro: 'O relatório ainda não foi publicado nesta instância.',
    }));
  }
  res.setHeader('Content-Security-Policy', cspDoRelatorio());
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').sendFile(BENCHMARK_HTML);
}

benchmarkRouter.get('/', benchmarkLimiter, (req, res) => {
  if (benchmarkLiberado(req)) return enviaRelatorio(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(paginaSenhaBenchmark());
});

benchmarkRouter.post('/', benchmarkLimiter,
  express.urlencoded({ extended: false, limit: '2kb' }),
  (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!senhaBenchmarkConfere(req.body && req.body.senha)) {
      return res.status(401).type('html').send(paginaSenhaBenchmark({
        erro: 'Senha incorreta. Confira e tente de novo.',
      }));
    }
    const token = jwt.sign({ scope: 'benchmark' }, JWT_SECRET, { expiresIn: `${BENCHMARK_TTL_H}h` });
    res.cookie(BENCHMARK_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: BENCHMARK_TTL_H * 60 * 60 * 1000,
      path: '/benchmarkpaciente',
    });
    // PRG: redireciona pro GET pra que dar F5 não reenvie a senha.
    res.redirect(303, '/benchmarkpaciente');
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

  // Processo Seletivo (Batch API GPT 5.5): submete os candidatos pendentes e
  // coleta os prontos — mesmo padrão do Competitivo.
  sweepSelectionBatches().catch(() => {});
  setInterval(() => { sweepSelectionBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  // Competitivo (Batch API GPT 5.5): submete os logs pendentes e coleta os prontos.
  sweepCompetitiveBatches().catch(() => {});
  setInterval(() => { sweepCompetitiveBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  // Avaliação Independente (Batch API): coleta os jobs da fila que ficaram prontos.
  sweepAvaliacaoBatches().catch(() => {});
  setInterval(() => { sweepAvaliacaoBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  // Trilha (Batch API — avaliador OpenAI escolhido no exercício): coleta e submete.
  sweepTrilhaEvalBatches().catch(() => {});
  setInterval(() => { sweepTrilhaEvalBatches().catch(() => {}); }, SELECAO_BATCH_POLL_MS).unref();

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Servidor Allos rodando na porta ${PORT}`));
}

module.exports = app;
