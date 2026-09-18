// Caminhos compartilhados entre módulos do servidor.
//
// DATA_DIR: volume persistente (Railway, via env) ou server/data em dev.
// PROMPTS_DIR: dentro do DATA_DIR — onde moravam os .md do avaliador/entrevistador
// antes de irem para o banco (005_prompts.sql). Hoje é só uma ORIGEM da
// semeadura: no boot, o que estiver aqui e ainda não estiver no banco entra (ver
// semearPrompts() em server/index.js). Continua servindo para validar caminho
// de prompt (resolvePromptPath).
const path = require('path');

const SEED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : SEED_DATA_DIR;

const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');

module.exports = { SEED_DATA_DIR, DATA_DIR, PROMPTS_DIR };
