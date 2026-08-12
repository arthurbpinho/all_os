// Caminhos compartilhados entre módulos do servidor.
//
// DATA_DIR: volume persistente (Railway, via env) ou server/data em dev.
// PROMPTS_DIR: dentro do DATA_DIR — guarda os .md do avaliador/entrevistador,
// que são dados sensíveis (critérios de nota, gabaritos) e por isso NÃO ficam
// no git. Ver seedPromptsDir() em server/index.js para a semeadura inicial e
// as rotas /api/admin/prompts para atualizar depois (o git deixou de ser o
// canal de deploy desses arquivos).
const path = require('path');

const SEED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : SEED_DATA_DIR;

const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');

module.exports = { SEED_DATA_DIR, DATA_DIR, PROMPTS_DIR };
