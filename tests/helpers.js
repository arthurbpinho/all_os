// Helpers de teste compartilhados.
//
// IMPORTANTE: as envs precisam ser setadas ANTES do require do server/index.js,
// porque o servidor faz validação fail-closed no boot (JWT_SECRET, ADMIN_INITIAL_PASSWORD).
// Por isso esse módulo deve ser o PRIMEIRO require de qualquer arquivo de teste.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// --- Setup de env (antes do require do app) ---
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(48);          // 48 chars — passa no fail-closed
process.env.ADMIN_INITIAL_PASSWORD = 'testpass1234'; // 12+ chars
process.env.DATA_DIR = DATA_DIR;
// Banco: um schema por arquivo de teste. Os arquivos rodam em forks paralelos
// (vitest.config.js) e, no mesmo schema, disputariam as mesmas tabelas. O app
// cria o schema e aplica as migrações no boot (ver server/db.js, iniciar).
const { URL_TESTE } = require('./db-helpers');
if (!URL_TESTE) {
  throw new Error('TEST_DATABASE_URL ausente: suba o banco de teste com `npm run db:up`.');
}
const DB_SCHEMA = `teste_${crypto.randomBytes(6).toString('hex')}`;
process.env.DATABASE_URL = URL_TESTE;
process.env.DATABASE_SCHEMA = DB_SCHEMA;
process.env.SELECAO_EXPORT_SECRET = 'test-export-secret'; // backup externo (Apps Script)
// Força modo demo (sem chamar Anthropic/OpenAI/GLM). Setar pra '' em vez de
// delete — se deletar, o dotenv.config() do server/index.js re-injeta do .env
// real (e a suite passaria a bater na rede: ex. a reflexão da Antessala usa GLM).
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.GLM_API_KEY = '';
// Limitador de TPM desligado nos testes: eles não falam com a rede, e o
// limitador dormiria esperando a janela de 60s abrir.
process.env.AVALIACAO_V25_TPM_LIMITER = '0';
// E-mail e captcha DESLIGADOS na suite. Mesmo motivo do '' acima em vez de
// delete: o dotenv.config() do server/index.js re-injeta o .env real, e com ele
// configurado a suite mandaria e-mail de verdade pela caixa da Allos (para
// endereços fictícios, que viram bounce) e bateria no Cloudflare a cada teste
// de cadastro. Com as envs vazias, o mailer captura em memória — que é como os
// testes leem o token do link — e o captcha é pulado.
process.env.GRAPH_TENANT_ID = '';
process.env.GRAPH_CLIENT_ID = '';
process.env.GRAPH_CLIENT_SECRET = '';
process.env.GRAPH_CERT_KEY_FILE = '';
process.env.GRAPH_CERT_PRIVATE_KEY = '';
process.env.GRAPH_CERT_THUMBPRINT = '';
process.env.MAIL_FROM = '';
process.env.TURNSTILE_SITE_KEY = '';
process.env.TURNSTILE_SECRET_KEY = '';

// O require do app DEVE vir depois das envs acima.
const app = require('../server/index.js');
const request = require('supertest');
const db = require('../server/db');
const contasRepo = require('../server/repos/contas').criarRepoContas(db.getPool());

// Todo arquivo de teste espera o boot do banco (migrações, admin e prompts)
// antes do primeiro teste. Há testes que usam o avaliador direto, sem passar por
// uma rota nem pelo resetData, e os prompts dele só existem depois do boot.
beforeAll(() => app.__test.bancoPronto);

// Fim do arquivo de teste: apaga o schema dele e fecha as conexões. Um schema
// que sobre de uma execução interrompida é apagado pelo tests/global-setup.js.
afterAll(async () => {
  const db = require('../server/db');
  try {
    await db.query(`DROP SCHEMA IF EXISTS ${DB_SCHEMA} CASCADE`);
  } finally {
    await db.closePool();
  }
});

// --- Seed data ---
const TEST_PASSWORD = 'testpass1234';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4); // rounds baixos pra acelerar suite

function defaultUsers() {
  const base = (id, username, name, role, teacherId = null) => ({
    id, username, name, role, teacherId,
    passwordHash: TEST_HASH,
    gender: '', email: '', profilePhoto: '',
    updateAllOS: false, updateAllos: false,
  });
  return [
    base('1', 'admin', 'Admin', 'admin'),
    base('2', 'prof', 'Professor A', 'supervisor'),
    base('3', 'aluno', 'Aluno A', 'therapist', '2'), // vinculado a prof
    base('4', 'prof2', 'Professor B', 'supervisor'),
    base('5', 'aluno2', 'Aluno B', 'therapist', '4'), // de outro professor
  ];
}

function defaultExercises() {
  return [
    {
      id: 'ex-test-1', title: 'Test Exercise',
      description: 'Desc public', skillId: 1, difficulty: 'iniciante',
      specificInstruction: 'PROMPT_SECRETO_EXERCISE_NAO_VAZAR',
      evaluatorPrompt: 'EVAL_PROMPT_SECRETO_NAO_VAZAR',
    },
    {
      id: 'ex-test-2', title: 'Exercise sem evaluator',
      description: 'Desc 2', skillId: 2, difficulty: 'intermediario',
      specificInstruction: 'OUTRO_PROMPT_SECRETO',
    },
  ];
}

function defaultFreeplay() {
  return [
    {
      id: 'fp-test-1', name: 'Sofia Test', age: 25,
      description: 'Public desc',
      assistantId: '',
      specificInstruction: 'FP_PROMPT_SECRETO_NAO_VAZAR',
    },
  ];
}

function defaultNeuro() {
  return [
    {
      id: 'nr-test-1', name: 'Beatriz Test', age: 32,
      description: 'Public desc',
      diagnosis: 'DIAGNOSTICO_SECRETO_NAO_VAZAR',
      assistantId: '',
      specificInstruction: 'NEURO_PROMPT_SECRETO_NAO_VAZAR',
    },
  ];
}

// Contas vão para o banco; o resto continua em arquivo no DATA_DIR. É async por
// causa do banco — chame com `await` (ou devolva a promise ao beforeEach).
async function resetData() {
  // Limpa tudo do DATA_DIR (fotos e o que ainda é arquivo).
  for (const f of fs.readdirSync(DATA_DIR)) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {}
  }

  // O boot do app (migrações + admin inicial) precisa ter terminado antes.
  await app.__test.bancoPronto;
  // Catálogos no banco (e na cópia em memória), com dados fixos por teste. A
  // Trilha começa sem competências, como começava sem o arquivo.
  await app.__test.definirCatalogo('exercicios', defaultExercises());
  await app.__test.definirCatalogo('freeplay', defaultFreeplay());
  await app.__test.definirCatalogo('neuro', defaultNeuro());
  await app.__test.definirCatalogo('trilha_skills', []);
  // RESTART IDENTITY só existe aqui: em produção um id nunca volta. As contas
  // semeadas têm id fixo ('1'..'5'), que os testes usam direto.
  // Logs e progresso entram na lista explicitamente: os de visitante não têm FK
  // para users, e o CASCADE sozinho não os alcançaria.
  await db.query(`TRUNCATE users, pending_registrations, password_resets, email_changes,
                  logs, log_messages, progress, mmr_players, mmr_characters, mmr_anon_players,
                  character_records, duels, sessoes_ativas, sessao_ativa_mensagens, cota_sessoes,
                  batches_em_voo, jobs, configuracoes, erros, feedback, sidequests_banco,
                  sidequests_ativas, sidequests_concluidas, antessala_mapas, selecao_logs,
                  selecao_estatisticas, comunidade_discussoes, tags, user_tags, uso_ia, uso_ia_alertas RESTART IDENTITY CASCADE`);
  await contasRepo.importar(defaultUsers());
  // As configurações do admin (settings, pool de fotos) eram arquivos no topo do
  // DATA_DIR e morriam a cada reset; no banco elas têm uma cópia em memória, que
  // precisa acompanhar o TRUNCATE.
  await app.__test.recarregarConfig();
}

async function loginAs(username, password = TEST_PASSWORD) {
  const res = await request(app).post('/api/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(`Login falhou (${username}): ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

async function loginVisitor() {
  const res = await request(app).post('/api/login/visitor').send({});
  if (res.status !== 200) {
    throw new Error(`Login visitor falhou: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

// Contas no formato do antigo users.json (ver server/repos/contas.js).
function lerUsuarios() {
  return contasRepo.listar();
}

// Acrescenta contas com id fixo, além das semeadas por resetData.
function inserirUsuarios(usuarios) {
  return contasRepo.importar(usuarios);
}

// Cadastros públicos aguardando confirmação, com as chaves que o JSON usava.
async function lerCadastrosPendentes() {
  const { rows } = await db.query(
    `SELECT token_hash AS "tokenHash", password_hash AS "passwordHash", username, name, email
     FROM pending_registrations ORDER BY criado_em`,
  );
  return rows;
}

module.exports = {
  app,
  request,
  resetData,
  loginAs,
  loginVisitor,
  authHeader,
  lerUsuarios,
  inserirUsuarios,
  lerCadastrosPendentes,
  db,
  TEST_PASSWORD,
  DATA_DIR,
};
