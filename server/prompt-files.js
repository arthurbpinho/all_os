// Gestão dos .md do PROMPTS_DIR (volume persistente) para o editor da
// Administração → Prompts.
//
// Contexto: os prompts do avaliador/entrevistador saíram do git (dados
// sensíveis — critérios de nota, gabaritos) e vivem só no volume. Isso resolveu
// o vazamento, mas tirou o que o git dava de graça: histórico e revisão. Como
// agora dá para editá-los pelo navegador, este módulo repõe as duas travas:
//
//   1. BACKUP a cada gravação. Antes de sobrescrever, a versão atual é copiada
//      para DATA_DIR/prompt-backups/ (fora do PROMPTS_DIR de propósito, senão
//      os backups apareceriam na própria listagem de prompts). Guarda as
//      MAX_BACKUPS últimas por arquivo e permite restaurar.
//   2. VALIDAÇÃO antes de gravar. Para os arquivos com contrato conhecido, o
//      conteúdo passa pelo MESMO parser que a produção usa (parseMontado /
//      parseSintetizador / parseCriteria). Um Ctrl+V que quebre um marcador é
//      recusado na hora, com a mensagem do parser, em vez de virar erro só
//      quando alguém rodar uma avaliação.
//
// O que este módulo NÃO faz: controle de acesso. As rotas em index.js são
// admin-only (requireAuth + requireRole('admin')) — este arquivo assume que
// quem chega aqui já passou por lá.

const fs = require('fs');
const path = require('path');
const { DATA_DIR, PROMPTS_DIR } = require('./paths');
const { parseMontado, parseSintetizador, parseCriteria, parseMissao, slotsCasoDe, slotsSintetizadorDe, PIPELINE_VERSIONS } = require('./avaliador-pipeline');

// Pastas de primeiro nível do PROMPTS_DIR. São as duas famílias de prompt que o
// app lê (e as que o boot semeia). Um arquivo NOVO só pode nascer dentro delas:
// o volume é do app, não um disco livre — e um caminho digitado errado no painel
// vira erro na hora, em vez de um .md órfão que ninguém lê.
const PROMPT_ROOTS = ['avaliacao', 'entrevistador'];
// Profundidade máxima de um caminho novo: raiz + subpasta + arquivo
// (ex.: avaliacao/v29/criterios-no-v29.md). Nada mais fundo que isso existe hoje.
const MAX_NEW_PATH_SEGMENTS = 3;

const BACKUPS_DIR = path.join(DATA_DIR, 'prompt-backups');
const MAX_BACKUPS = 20;
// Teto de tamanho do .md (o maior prompt real tem ~30 KB; 512 KB é folga larga
// e ainda barra colagem acidental de um arquivo inteiro errado).
const MAX_PROMPT_BYTES = 512 * 1024;

// Caminho absoluto de um .md dentro do PROMPTS_DIR, ou null se inválido
// (traversal, fora do diretório, ou extensão diferente de .md).
function resolvePromptPath(relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(PROMPTS_DIR, clean);
  if (resolved !== PROMPTS_DIR && !resolved.startsWith(PROMPTS_DIR + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith('.md')) return null;
  return resolved;
}

// Caminho relativo normalizado (barras normais), como aparece na listagem.
function relOf(absPath) {
  return path.relative(PROMPTS_DIR, absPath).split(path.sep).join('/');
}

// Todos os .md do volume, recursivo, ordenados.
function listPromptFiles() {
  function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (entry.name.toLowerCase().endsWith('.md')) return [full];
      return [];
    });
  }
  return walk(PROMPTS_DIR)
    .map((full) => {
      const st = fs.statSync(full);
      return { path: relOf(full), size: st.size, updatedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

// --- Validação -------------------------------------------------------------

// Contratos que o código realmente depende. A chave é o caminho relativo; o
// valor roda o parser de produção e estoura com a mensagem dele. Arquivo fora
// desta tabela passa só pelas checagens genéricas (não-vazio, tamanho) — não
// invento contrato para prompt cujo formato o código não lê.
//
// Os .md de cada VERSÃO do pipeline (v29 e o modo progressão) têm contrato
// conhecido — são montados pelo mesmo parser da produção. A pasta vem de
// PIPELINE_VERSIONS (`dir`), então uma versão nova entra aqui sozinha, sem
// editar esta tabela.
const VALIDATORS = {};
for (const cfg of Object.values(PIPELINE_VERSIONS)) {
  const slotsCaso = slotsCasoDe(cfg);
  const base = `avaliacao/${cfg.dir}/`;
  VALIDATORS[base + cfg.montado] = (content) => {
    parseMontado(content, cfg.montado, slotsCaso);
  };
  VALIDATORS[base + cfg.sintetizador] = (content) => {
    // Os slots EXTRAS da versão entram na validação (o sintetizador do modo
    // progressão usa {{ATENDIMENTO_1}}, {{MISSAO}} e {{MISSAO_VEREDITO}}) —
    // sem isto o parser recusaria o próprio arquivo da produção.
    parseSintetizador(content, cfg.sintetizador, slotsSintetizadorDe(cfg));
  };
  // Nó da missão (só o modo progressão tem).
  if (cfg.missao) {
    VALIDATORS[base + cfg.missao] = (content) => {
      parseMissao(content, cfg.missao, slotsCaso);
    };
  }
  // Versão que LÊ os critérios de outra (o modo progressão usa a grade do v29)
  // não tem .md de critérios na pasta dela — o validador pertence à versão dona
  // do arquivo, e registrá-lo aqui criaria um caminho que não existe no volume.
  if (!cfg.criteriosDe) {
    VALIDATORS[base + cfg.criterios] = (content) => {
      const criteria = parseCriteria(content);
      if (criteria.length !== cfg.nCriterios) {
        throw new Error(`Esperava ${cfg.nCriterios} critérios (com nome e linha curta), encontrei ${criteria.length}.`);
      }
    };
  }
}

// Valida o conteúdo para um caminho. Devolve { ok } ou { ok:false, error }.
function validatePromptContent(relPath, content) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'Conteúdo vazio.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, error: `Conteúdo grande demais (máx. ${Math.round(MAX_PROMPT_BYTES / 1024)} KB).` };
  }
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const validate = VALIDATORS[rel];
  if (!validate) return { ok: true, validado: false };
  try {
    validate(content);
    return { ok: true, validado: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Política para CRIAR um .md que ainda não existe no volume (o "Novo arquivo" do
// painel e o --criar do script). O resolvePromptPath já barra traversal e
// extensão; aqui vem o resto: onde pode nascer, quão fundo, e nome de segmento
// sem surpresa (nada começando com ponto, nada de caractere exótico). Devolve
// { ok } ou { ok:false, error } com a mensagem que o admin lê.
function validateNewPromptPath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!resolvePromptPath(rel)) {
    return { ok: false, error: 'Caminho inválido: precisa ser um .md dentro da pasta de prompts, sem ".." no meio.' };
  }
  const segs = rel.split('/');
  if (segs.length < 2 || segs.length > MAX_NEW_PATH_SEGMENTS) {
    return { ok: false, error: `O caminho precisa ter entre 2 e ${MAX_NEW_PATH_SEGMENTS} partes, começando pela pasta (ex.: avaliacao/v28/criterios-no-v28.md).` };
  }
  if (!PROMPT_ROOTS.includes(segs[0])) {
    return { ok: false, error: `Arquivo novo só pode ser criado dentro de ${PROMPT_ROOTS.join('/ ou ')}/ — o caminho começou com "${segs[0]}".` };
  }
  for (const seg of segs) {
    if (!seg || seg.startsWith('.')) return { ok: false, error: 'Cada parte do caminho precisa ter nome e não pode começar com ponto.' };
    if (seg.length > 80) return { ok: false, error: 'Cada parte do caminho tem de caber em 80 caracteres.' };
    // Letras (com acento), números, espaço e - _ . ( ) — o suficiente para os
    // nomes que já existem ("avaliador 18", "v29-progressao") e nada além.
    if (!/^[\p{L}\p{N} ._()-]+$/u.test(seg)) {
      return { ok: false, error: `"${seg}" tem caractere que não vale em nome de pasta ou arquivo aqui (use letras, números, espaço, ponto, hífen, sublinhado ou parênteses).` };
    }
  }
  return { ok: true };
}

// Se o arquivo tem contrato verificado (aparece na UI para o admin saber que a
// gravação vai passar por conferência).
function hasValidator(relPath) {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, String(relPath || '').replace(/\\/g, '/'));
}

// --- Backups ---------------------------------------------------------------

// Uma pasta por arquivo, nomeada com o caminho relativo encodado — vira um
// nome só, sem barras, então não recria a árvore nem abre porta para traversal.
function backupDirFor(relPath) {
  return path.join(BACKUPS_DIR, encodeURIComponent(relPath));
}

// Copia a versão ATUAL do arquivo para o histórico e poda as mais antigas.
// Devolve o id da versão criada (ou null se o arquivo ainda não existia).
function backupPrompt(relPath) {
  const abs = resolvePromptPath(relPath);
  if (!abs || !fs.existsSync(abs)) return null;
  const dir = backupDirFor(relPath);
  fs.mkdirSync(dir, { recursive: true });

  // id = timestamp ISO com os dois-pontos trocados (nome de arquivo válido em
  // qualquer sistema) — ordena cronologicamente por nome.
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(abs, path.join(dir, id + '.md'));

  const versoes = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  for (const velha of versoes.slice(0, Math.max(0, versoes.length - MAX_BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, velha)); } catch {}
  }
  return id;
}

// Histórico de um arquivo, mais recente primeiro.
function listBackups(relPath) {
  const dir = backupDirFor(relPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { id: f.replace(/\.md$/, ''), createdAt: st.mtime.toISOString(), size: st.size };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Id de versão é sempre gerado por nós (timestamp): nada de barra, ponto-ponto
// ou separador — a checagem barra qualquer coisa fora desse formato.
function isValidBackupId(id) {
  return /^[0-9TZ-]{10,40}$/.test(String(id || ''));
}

function readBackup(relPath, id) {
  if (!isValidBackupId(id)) return null;
  const file = path.join(backupDirFor(relPath), id + '.md');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf-8');
}

module.exports = {
  BACKUPS_DIR,
  MAX_BACKUPS,
  PROMPT_ROOTS,
  resolvePromptPath,
  validateNewPromptPath,
  relOf,
  listPromptFiles,
  validatePromptContent,
  hasValidator,
  backupPrompt,
  listBackups,
  readBackup,
};
