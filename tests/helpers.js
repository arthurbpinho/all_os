// Helpers de teste compartilhados.
//
// IMPORTANTE: as envs precisam ser setadas ANTES do require do server/index.js,
// porque o servidor faz validação fail-closed no boot (JWT_SECRET, ADMIN_INITIAL_PASSWORD).
// Por isso esse módulo deve ser o PRIMEIRO require de qualquer arquivo de teste.

const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');

// --- Setup de env (antes do require do app) ---
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'allos-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'a'.repeat(48);          // 48 chars — passa no fail-closed
process.env.ADMIN_INITIAL_PASSWORD = 'testpass1234'; // 12+ chars
process.env.DATA_DIR = DATA_DIR;
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

// O require do app DEVE vir depois das envs acima.
const app = require('../server/index.js');
const request = require('supertest');

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

function resetData() {
  // Limpa tudo do DATA_DIR e repopula com dados fixos por teste.
  for (const f of fs.readdirSync(DATA_DIR)) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch {}
  }
  const writes = {
    'users.json': defaultUsers(),
    'exercises.json': defaultExercises(),
    'freeplay-characters.json': defaultFreeplay(),
    'neuro-characters.json': defaultNeuro(),
    'progress.json': {},
    'logs.json': [],
    'achievements.json': {},
    'active-sessions.json': {},
  };
  for (const [file, data] of Object.entries(writes)) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  }
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

module.exports = {
  app,
  request,
  resetData,
  loginAs,
  loginVisitor,
  authHeader,
  TEST_PASSWORD,
  DATA_DIR,
};
