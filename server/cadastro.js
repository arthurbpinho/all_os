// Regras de conta e de cadastro público — lógica PURA (sem express, sem disco).
//
// Mora fora do index.js por dois motivos: o index já passa de 9 mil linhas, e
// estas regras são as que mais merecem teste direto (política de senha, nome
// reservado, token de confirmação). Segue o mesmo padrão de scoring.js e
// neuro-tests.js: módulo puro aqui, rotas lá.

const crypto = require('crypto');

// --- Nomes de usuário ---

// A comparação de username no login SEMPRE passa por aqui. Sem isso, `Admin` e
// `admin` são contas diferentes — inofensivo enquanto só o admin cria conta,
// impersonação pura assim que o cadastro abre pro público.
function normalizeUsername(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function normalizeEmail(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Nomes que ninguém pode registrar: ou se passam pela equipe, ou colidem com
// rota/identidade do próprio produto. Comparados já normalizados.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrador', 'administrator', 'root', 'superuser', 'sysadmin',
  'allos', 'all_os', 'allos_os', 'alloss', 'associacaoallos', 'associacao-allos',
  'suporte', 'support', 'ajuda', 'contato', 'atendimento', 'sac',
  'equipe', 'staff', 'moderador', 'moderator', 'mod', 'oficial', 'official',
  'sistema', 'system', 'bot', 'api', 'null', 'undefined', 'anonimo', 'anonymous',
  'visitante', 'visitor', 'convidado', 'guest',
  'suporteallos', 'allosoficial', 'allossuporte', 'naoresponda', 'noreply', 'no-reply',
  'supervisor', 'professor', 'avaliador', 'terapeuta', 'aluno',
]);

function isReservedUsername(username) {
  return RESERVED_USERNAMES.has(normalizeUsername(username));
}

// --- E-mail ---

// Deliberadamente frouxo. Validar e-mail por regex é uma armadilha conhecida
// (a gramática real do RFC 5322 aceita coisas absurdas e regex "completa" acaba
// rejeitando endereço legítimo). Quem realmente valida é o link de confirmação:
// se o e-mail não existe, a conta nunca nasce. Aqui só barramos digitação
// obviamente quebrada, antes de gastar um envio.
const EMAIL_REGEX = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function isEmailValido(email) {
  const e = normalizeEmail(email);
  return e.length >= 6 && e.length <= 254 && EMAIL_REGEX.test(e);
}

// --- Política de senha ---
//
// Piso por perfil: supervisor e admin alcançam dados de TODOS os alunos, então
// exigem mais. As regras de composição (letra + número + especial + não conter
// o username) valem para todo mundo, não só pro cadastro público — seria
// esquisito o aluno que se cadastra sozinho ter senha mais forte que a conta
// de supervisor criada pelo admin.
const PASSWORD_MIN = 8;
const PASSWORD_MIN_PRIVILEGIADO = 12;

function senhaMinimaPara(role) {
  return (role === 'admin' || role === 'supervisor') ? PASSWORD_MIN_PRIVILEGIADO : PASSWORD_MIN;
}

const RE_LETRA = /[A-Za-zÀ-ÖØ-öø-ÿ]/;
const RE_DIGITO = /[0-9]/;
// Conjunto explícito em vez de /[^A-Za-z0-9]/: com a negação, "á" contaria como
// caractere especial, o que não é o que a tela promete ao usuário.
const RE_ESPECIAL = /[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|`~]/;

// As que aparecem em toda lista de vazamento e as "espertas" deste contexto.
// Comparada com a senha inteira normalizada — não é substring, pra não recusar
// uma senha longa e boa só porque contém "senha" no meio.
const SENHAS_PROIBIDAS = new Set([
  '12345678', '123456789', '1234567890', 'senha123', 'senha1234', 'password',
  'password1', 'password123', 'qwertyui', 'qwerty123', 'abc12345', 'admin123',
  'allos123', 'allos2025', 'allos2026', 'mudar123', 'trocar123', 'psicologia',
  'psicologia1', 'psicologo123', '1q2w3e4r', 'aaaaaaaa', '11111111',
]);

// Compara contra a blocklist tolerando o disfarce óbvio: só minúsculas, sem os
// não-alfanuméricos das pontas, e sem nenhum não-alfanumérico. Assim
// "senha1234", "Senha1234!" e "s.e.n.h.a.1.2.3.4" caem na mesma peneira.
function ehSenhaComum(senha) {
  const lower = String(senha).toLowerCase();
  const candidatos = [
    lower,
    lower.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''),
    lower.replace(/[^a-z0-9]/g, ''),
  ];
  return candidatos.some((c) => SENHAS_PROIBIDAS.has(c));
}

// Devolve a mensagem de erro, ou null se a senha serve.
// `username` é opcional: quando vem, a senha não pode contê-lo (nem o contrário).
function validarSenha(senha, role, username) {
  const s = String(senha == null ? '' : senha);
  const min = senhaMinimaPara(role);

  if (s.length < min) {
    const extra = min === PASSWORD_MIN_PRIVILEGIADO ? ' (contas de supervisor e admin exigem mais)' : '';
    return `Senha deve ter ao menos ${min} caracteres${extra}`;
  }
  // Teto: bcrypt trunca em 72 BYTES silenciosamente. Sem este limite, o pedaço
  // digitado além disso não protege nada e a pessoa acha que protege.
  if (Buffer.byteLength(s, 'utf8') > 72) {
    return 'Senha longa demais (máximo 72 caracteres)';
  }
  // A blocklist vem ANTES da composição de propósito. Se viesse depois, ela
  // seria praticamente código morto (nenhuma senha da lista tem caractere
  // especial, então nunca chegaria até aqui) e, pior, a pessoa com "senha1234"
  // receberia "falta um caractere especial" e digitaria "senha1234!" — que
  // continua sendo a primeira tentativa de qualquer ataque.
  if (ehSenhaComum(s)) return 'Senha muito comum — escolha outra';

  if (!RE_LETRA.test(s)) return 'Senha deve conter ao menos 1 letra';
  if (!RE_DIGITO.test(s)) return 'Senha deve conter ao menos 1 número';
  if (!RE_ESPECIAL.test(s)) return 'Senha deve conter ao menos 1 caractere especial (ex: ! @ # $ % & * -)';

  if (username) {
    const u = normalizeUsername(username);
    if (u.length >= 3 && s.toLowerCase().includes(u)) {
      return 'Senha não pode conter o seu nome de usuário';
    }
  }
  return null;
}

// --- "Como conheceu a plataforma" ---
//
// `detalhe: true` = o canal tem pergunta aberta junto ("quem?" / "qual
// faculdade?"). O catálogo vive aqui pra que servidor e testes concordem com a
// tela sobre quais valores existem — o cliente manda o id, nunca o rótulo.
const ORIGENS = [
  { id: 'indicacao_allos', label: 'Indicação de alguém da Allos', detalhe: true,  detalheLabel: 'Quem indicou?' },
  { id: 'instagram',       label: 'Instagram',                     detalhe: false },
  { id: 'youtube',         label: 'YouTube',                       detalhe: false },
  { id: 'site',            label: 'Site',                          detalhe: false },
  { id: 'formacao',        label: 'Plataforma de formação gravada', detalhe: false },
  { id: 'faculdade',       label: 'Colega de faculdade',           detalhe: true,  detalheLabel: 'Qual faculdade?' },
];

function origemPorId(id) {
  return ORIGENS.find((o) => o.id === id) || null;
}

// --- Tokens de confirmação de e-mail e de redefinição de senha ---
//
// O token viaja no link; em disco guardamos só o SHA-256. Assim um vazamento do
// pending-registrations.json / password-resets.json não entrega nenhum link
// utilizável. SHA-256 puro basta aqui (ao contrário de senha): o segredo tem
// 256 bits de entropia, não há o que quebrar por força bruta.
const TOKEN_BYTES = 32;

function novoToken(ttlMs) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Comparação em tempo constante. Os dois lados são hex de 64 chars; se o
// tamanho não bate, nem chega no timingSafeEqual (que lança nesse caso).
function tokenHashIgual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function expirado(registro, agora = Date.now()) {
  if (!registro || !registro.expiresAt) return true;
  const t = Date.parse(registro.expiresAt);
  return !Number.isFinite(t) || t <= agora;
}

// Remove pendências vencidas. Chamada em toda leitura dos arquivos de token —
// eles são pequenos e reescritos inteiros, então não precisa de rotina de
// limpeza agendada.
function removerExpirados(lista, agora = Date.now()) {
  return (Array.isArray(lista) ? lista : []).filter((r) => !expirado(r, agora));
}

// --- Validação do formulário de cadastro público ---
//
// `usernamesEmUso` / `emailsEmUso`: Sets já normalizados, montados pelo chamador
// a partir de users.json + pendências. Devolve { errors, dados }: `dados` só vem
// preenchido quando errors está vazio.
const NOME_MIN = 2;
const NOME_MAX = 80;
const usernameRegex = /^[a-zA-Z0-9._-]{3,32}$/;

function validarCadastroPayload(body, { usernamesEmUso = new Set(), termosVersao = '1' } = {}) {
  const b = body || {};
  const errors = [];

  const username = String(b.username == null ? '' : b.username).trim();
  const usernameLower = normalizeUsername(username);
  if (!usernameRegex.test(username)) {
    errors.push('Nome de usuário inválido (3 a 32 caracteres, apenas letras, números, ponto, hífen e sublinhado)');
  } else if (isReservedUsername(usernameLower)) {
    errors.push('Este nome de usuário não está disponível');
  } else if (usernamesEmUso.has(usernameLower)) {
    errors.push('Este nome de usuário já está em uso');
  }

  const nome = String(b.name == null ? '' : b.name).trim().replace(/\s+/g, ' ');
  if (nome.length < NOME_MIN || nome.length > NOME_MAX) {
    errors.push('Informe seu nome e sobrenome');
  } else if (!nome.includes(' ')) {
    errors.push('Informe nome e sobrenome');
  }

  const email = normalizeEmail(b.email);
  if (!isEmailValido(email)) {
    errors.push('E-mail inválido');
  }

  // Senha: valida contra o piso do perfil que a conta VAI ter (external = 8).
  const erroSenha = validarSenha(b.password, 'external', username);
  if (erroSenha) errors.push(erroSenha);

  // Origem é opcional (não estava marcada como obrigatória no formulário), mas
  // se vier tem que ser um id do catálogo — e o detalhe é exigido nos dois
  // canais que perguntam "quem?" / "qual faculdade?".
  let origem = null;
  if (b.origem && String(b.origem).trim()) {
    const def = origemPorId(String(b.origem).trim());
    if (!def) {
      errors.push('Opção inválida em "como conheceu a plataforma"');
    } else {
      const detalhe = String(b.origemDetalhe == null ? '' : b.origemDetalhe).trim().slice(0, 120);
      if (def.detalhe && !detalhe) {
        errors.push(`Preencha: ${def.detalheLabel}`);
      } else {
        origem = { canal: def.id, detalhe: def.detalhe ? detalhe : '' };
      }
    }
  }

  // Consentimento. O aceite dos termos é obrigatório; os dois de comunicação
  // são opt-in independentes (bases legais distintas na LGPD) e por isso ficam
  // registrados separados, não num único "aceito tudo".
  if (b.aceiteTermos !== true) {
    errors.push('É necessário aceitar os termos de uso e a política de privacidade');
  }

  if (errors.length) return { errors, dados: null };

  return {
    errors: [],
    dados: {
      username,
      usernameLower,
      name: nome,
      email,
      origem,
      // Booleano puro não serve de prova de consentimento: a LGPD pede saber
      // QUANDO e a QUE versão do documento a pessoa disse sim.
      consentimento: {
        termos: { aceito: true, em: new Date().toISOString(), versao: String(termosVersao) },
      },
      updateAllOS: b.newsletterAllOS === true,
      updateAllos: b.newsletterAllos === true,
    },
  };
}

module.exports = {
  normalizeUsername,
  normalizeEmail,
  isReservedUsername,
  RESERVED_USERNAMES,
  isEmailValido,
  PASSWORD_MIN,
  PASSWORD_MIN_PRIVILEGIADO,
  senhaMinimaPara,
  validarSenha,
  ORIGENS,
  origemPorId,
  novoToken,
  hashToken,
  tokenHashIgual,
  expirado,
  removerExpirados,
  validarCadastroPayload,
  usernameRegex,
};
