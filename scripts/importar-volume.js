#!/usr/bin/env node
// Importa a cópia da pasta /data do volume do sistema antigo para o banco.
// Roda UMA vez, na virada, ANTES do primeiro boot do app novo (o boot cria o
// admin inicial, e aí o banco já não está vazio).
//
// Uso:
//   DATABASE_URL=postgres://... node scripts/importar-volume.js /caminho/da/copia/data
//   DATABASE_URL=postgres://... node scripts/importar-volume.js /caminho/da/copia/data --limpar
//
// --limpar apaga os dados do banco (menos os prompts) e importa de novo. Serve
// para repetir o ensaio; em produção, só se você souber o que está apagando.
//
// Ver VIRADA.md para o passo a passo completo.

require('dotenv').config();
const fs = require('fs');
const db = require('../server/db');
const { importarVolume, relatorioEmTexto } = require('../server/importar-volume');

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const limpar = args.includes('--limpar');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error('Uso: node scripts/importar-volume.js <pasta com os .json do volume> [--limpar]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Defina DATABASE_URL.');
    process.exit(1);
  }
  console.log(`Banco: ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`Pasta: ${dir}${limpar ? '  (com --limpar)' : ''}`);

  await db.iniciar(); // aplica as migrações
  const relatorio = await importarVolume({ pool: db.getPool(), dir, limpar });
  console.log('');
  console.log(relatorioEmTexto(relatorio));
}

main()
  .catch((e) => {
    console.error('\nA importação parou:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.closePool());
