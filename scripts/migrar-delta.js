#!/usr/bin/env node
// Migração DELTA da cópia do volume antigo (/data em JSON) para um banco que já
// tem dados. Ver server/migrar-delta.js para as regras e demandas.md §26 para as
// decisões. A pasta de origem é só lida.
//
// Uso:
//   DATABASE_URL="$(cat ~/.neon-url-teste)" node scripts/migrar-delta.js <pasta data> --alvo=<ep-…> [--dry-run]
//
// --alvo é obrigatório e precisa bater com o host do DATABASE_URL (o "ep-…" do
// Neon, ou "local" para 127.0.0.1/localhost). Existe para ninguém gravar no
// banco errado por engano. Este script NÃO lê o .env de propósito: sem a
// variável na frente do comando, ele para, em vez de cair no Postgres local.
//
// --dry-run roda tudo e desfaz a transação no fim: o relatório mostra o que
// mudaria. Os rejeitados (com o motivo) vão para um .jsonl em ~/allos-backups/,
// ou para o caminho de --rejeitados=<arquivo>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { migrarDelta, relatorioEmTexto } = require('../server/migrar-delta');

function opcao(args, nome) {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const alvo = opcao(args, 'alvo');
  if (!dir || !fs.existsSync(path.join(dir, 'users.json'))) {
    console.error('Uso: node scripts/migrar-delta.js <pasta com os .json do volume> --alvo=<ep-…|local> [--dry-run] [--rejeitados=<arquivo>]');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Defina DATABASE_URL na frente do comando (o .env não é lido).');
    process.exit(1);
  }
  let host;
  try { host = new URL(url).hostname; } catch { console.error('DATABASE_URL inválida.'); process.exit(1); }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const endpoint = local ? 'local' : host.split('.')[0].replace(/-pooler$/, '');
  if (!alvo || alvo !== endpoint) {
    console.error(`--alvo=${alvo || '(faltando)'} não bate com o banco do DATABASE_URL (${endpoint}). Nada foi feito.`);
    process.exit(1);
  }
  if (host.includes('-pooler')) {
    console.error('Use o endpoint DIRETO do Neon, não o -pooler (VIRADA.md §2).');
    process.exit(1);
  }

  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const rejeitados = opcao(args, 'rejeitados')
    || path.join(os.homedir(), 'allos-backups', `rejeitados-${endpoint}-${carimbo}${dryRun ? '-dry-run' : ''}.jsonl`);

  console.log(`Banco: ${host}${dryRun ? '  (SIMULAÇÃO: --dry-run)' : ''}`);
  console.log(`Pasta: ${path.resolve(dir)} (só leitura)`);
  console.log('');

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const t0 = Date.now();
    const rel = await migrarDelta({
      pool, dir, dryRun,
      log: (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${msg}`),
    });
    console.log('');
    console.log(relatorioEmTexto(rel));
    console.log('');
    console.log('Origem (sha256):');
    for (const [f, h] of Object.entries(rel.hashes)) console.log(`  ${h}  ${f}`);
    if (rel.rejeitados.length) {
      fs.mkdirSync(path.dirname(rejeitados), { recursive: true, mode: 0o700 });
      fs.writeFileSync(rejeitados, rel.rejeitados.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
      console.log(`\nRejeitados: ${rel.rejeitados.length} → ${rejeitados}`);
    }
    if (!dryRun) {
      console.log('\nReinicie o serviço do app: catálogo, configurações e sidequests ficam em memória e só são relidos no boot.');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('\nA migração parou e nada foi gravado (a transação foi desfeita):', e.message);
  process.exitCode = 1;
});
