#!/usr/bin/env node
// Sobe um .md local pro PROMPTS_DIR do servidor (volume persistente), via
// /api/admin/prompts/*. Substitui o antigo fluxo "edita avaliacao/*.md → git
// push → deploy" — os prompts saíram do git (ver .gitignore), então esta é a
// forma de atualizar avaliador/entrevistador em produção depois do deploy.
//
// Uso:
//   ALLOS_BASE_URL=https://seu-app.up.railway.app \
//   ALLOS_ADMIN_USER=admin ALLOS_ADMIN_PASS=... \
//   node scripts/upload-prompt.js avaliacao/avaliador-v16-2.md
//
// O caminho remoto (relativo ao PROMPTS_DIR) é o mesmo caminho local passado
// como argumento. Por padrão só ATUALIZA arquivo que já existe no volume; para
// levar um prompt NOVO (uma versão nova do avaliador, por exemplo), passe
// --criar, que cria o arquivo e a pasta dele:
//
//   node scripts/upload-prompt.js --criar avaliacao/v28/criterios-no-v28.md

const fs = require('fs');
const path = require('path');

async function main() {
  const args = process.argv.slice(2);
  const criar = args.includes('--criar');
  const localPath = args.find((a) => !a.startsWith('--'));
  if (!localPath) {
    console.error('Uso: node scripts/upload-prompt.js [--criar] <caminho .md, ex: avaliacao/avaliador-v16-2.md>');
    process.exit(1);
  }

  const baseUrl = process.env.ALLOS_BASE_URL;
  const user = process.env.ALLOS_ADMIN_USER;
  const pass = process.env.ALLOS_ADMIN_PASS;
  if (!baseUrl || !user || !pass) {
    console.error('Defina ALLOS_BASE_URL, ALLOS_ADMIN_USER e ALLOS_ADMIN_PASS.');
    process.exit(1);
  }

  const absLocal = path.resolve(process.cwd(), localPath);
  const content = fs.readFileSync(absLocal, 'utf-8');

  // Caminho remoto = caminho local relativo à raiz do repo (avaliacao/... ou
  // entrevistador/...), com barras normais mesmo no Windows.
  const remotePath = localPath.replace(/\\/g, '/').replace(/^\.?\/*/, '');

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const loginBody = await loginRes.json();
  if (!loginRes.ok) throw new Error(`Login falhou: ${loginBody.error || loginRes.status}`);
  const token = loginBody.token;

  const putRes = await fetch(`${baseUrl}/api/admin/prompts/${remotePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content, criar }),
  });
  const putBody = await putRes.json();
  if (!putRes.ok) throw new Error(`Upload falhou: ${putBody.error || putRes.status}`);

  console.log(`OK: ${remotePath} ${putBody.criado ? 'criado' : 'atualizado'} em ${baseUrl}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
