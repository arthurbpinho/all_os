// Gestão dos prompts do avaliador/entrevistador para o editor da
// Administração → Prompts.
//
// Contexto: os prompts saíram do git (dados sensíveis — critérios de nota,
// gabaritos). Moravam num volume; hoje moram no BANCO (005_prompts.sql,
// server/repos/prompts.js), com uma cópia em memória que o avaliador lê
// (server/prompt-store.js). Continuam identificados pelo caminho de antes
// ("avaliacao/v34/criterios-no-v34.md"). Este módulo repõe as duas travas que o
// git dava:
//
//   1. HISTÓRICO a cada gravação. Antes de sobrescrever, restaurar ou excluir, a
//      versão no ar vai para prompt_versoes, que é somente-inserção. Permite
//      restaurar qualquer versão.
//   2. VALIDAÇÃO antes de gravar. Para os arquivos com contrato conhecido, o
//      conteúdo passa pelo MESMO parser que a produção usa (parseMontado /
//      parseSintetizador / parseCriteria). Um Ctrl+V que quebre um marcador é
//      recusado na hora, com a mensagem do parser, em vez de virar erro só
//      quando alguém rodar uma avaliação.
//
// O que este módulo NÃO faz: controle de acesso. As rotas em index.js são
// admin-only (requireAuth + requireRole('admin')) — este arquivo assume que
// quem chega aqui já passou por lá.

const path = require('path');
const { PROMPTS_DIR } = require('./paths');
const store = require('./prompt-store');
const {
  parseMontado, parseSintetizador, parseCriteria, parseMissao,
  slotsCasoDe, slotsSintetizadorDe, slotsLogDe, clearAssetsCache,
  PIPELINE_VERSIONS,
} = require('./avaliador-pipeline');

// As duas famílias de prompt que o app lê. Um arquivo NOVO só pode nascer dentro
// delas: um caminho digitado errado no painel vira erro na hora, em vez de um
// prompt órfão que ninguém lê.
const PROMPT_ROOTS = ['avaliacao', 'entrevistador'];
// Profundidade máxima de um caminho novo: raiz + subpasta + arquivo
// (ex.: avaliacao/v34/criterios-no-v34.md). Nada mais fundo que isso existe hoje.
const MAX_NEW_PATH_SEGMENTS = 3;

// Teto de tamanho do .md (o maior prompt real tem ~30 KB; 512 KB é folga larga
// e ainda barra colagem acidental de um arquivo inteiro errado).
const MAX_PROMPT_BYTES = 512 * 1024;

let repo = null;

// Carrega os prompts do banco para a memória e deriva as linhas de critério.
// Chamado no boot, depois da semeadura.
async function iniciar(repoPrompts) {
  repo = repoPrompts;
  await recarregar();
  for (const [caminho, regua] of Object.entries(CRITERIOS_POR_CAMINHO)) {
    const conteudo = store.ler(caminho);
    if (conteudo == null) continue;
    try {
      await repo.derivarCriterios(regua, parseCriteria(conteudo));
    } catch (e) {
      // Um .md de critérios quebrado não pode derrubar o boot: o avaliador
      // acusa o erro quando for usado, que é o comportamento de sempre.
      console.error(`[prompts] não deu para derivar os critérios de ${caminho}:`, e.message);
    }
  }
}

// Relê tudo do banco. Existe para quem mexe no banco por fora do painel (testes).
async function recarregar() {
  store.carregar(await repo.todos());
  clearAssetsCache();
}

function repoOuFalha() {
  if (!repo) throw new Error('Prompts ainda não carregados do banco (prompt-files.iniciar).');
  return repo;
}

// Caminho normalizado (barras normais, sem barra inicial).
function normalizar(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

// Confere que o caminho é um .md dentro da árvore de prompts (sem traversal).
// Devolve o caminho absoluto equivalente, ou null se inválido. O absoluto não é
// mais lido de lugar nenhum — é a mesma checagem de antes, que as rotas usam
// como "caminho válido?".
function resolvePromptPath(relPath) {
  const clean = normalizar(relPath);
  const resolved = path.resolve(PROMPTS_DIR, clean);
  if (resolved !== PROMPTS_DIR && !resolved.startsWith(PROMPTS_DIR + path.sep)) return null;
  if (!resolved.toLowerCase().endsWith('.md')) return null;
  return resolved;
}

// Caminho relativo normalizado (barras normais), como aparece na listagem.
function relOf(absPath) {
  return path.relative(PROMPTS_DIR, absPath).split(path.sep).join('/');
}

// Conteúdo de um prompt, ou null. Síncrono: sai da cópia em memória.
function lerPrompt(relPath) {
  return store.ler(normalizar(relPath));
}

// Todos os prompts, ordenados.
function listPromptFiles() {
  return store.listar()
    .map((a) => ({ path: a.caminho, size: Buffer.byteLength(a.conteudo, 'utf8'), updatedAt: a.atualizadoEm }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// --- Validação -------------------------------------------------------------

// Contratos que o código realmente depende. A chave é o caminho relativo; o
// valor roda o parser de produção e estoura com a mensagem dele. Arquivo fora
// desta tabela passa só pelas checagens genéricas (não-vazio, tamanho) — não
// invento contrato para prompt cujo formato o código não lê.
//
// Os .md de cada ENTRADA do pipeline (v34, progressão e duelo) têm contrato
// conhecido — são montados pelo mesmo parser da produção. A pasta vem de
// PIPELINE_VERSIONS (`dir`), então uma versão nova entra aqui sozinha, sem
// editar esta tabela.
const VALIDATORS = {};
// O .md de critérios de cada régua dona dos critérios → id da régua. Gravar um
// deles também atualiza as linhas da tabela `criterios`.
const CRITERIOS_POR_CAMINHO = {};
for (const cfg of Object.values(PIPELINE_VERSIONS)) {
  const slotsCaso = slotsCasoDe(cfg);
  const base = `avaliacao/${cfg.dir}/`;
  VALIDATORS[base + cfg.montado] = (content) => {
    parseMontado(content, cfg.montado, slotsCaso);
  };
  VALIDATORS[base + cfg.sintetizador] = (content) => {
    // Os slots da versão entram na validação — sem isto o parser recusaria o
    // próprio arquivo da produção. São de dois tipos: os de LOG, que mudam com a
    // entrada ({{LOG}} nas individuais, os dois logs e os dois nomes no duelo), e
    // os EXTRAS, que só a progressão tem ({{ATENDIMENTO_1}}, {{MISSAO}} e
    // {{MISSAO_VEREDITO}}).
    parseSintetizador(content, cfg.sintetizador, slotsSintetizadorDe(cfg), slotsLogDe(cfg));
  };
  // Nó da missão (só o modo progressão tem).
  if (cfg.missao) {
    VALIDATORS[base + cfg.missao] = (content) => {
      parseMissao(content, cfg.missao, slotsCaso);
    };
  }
  // Versão que LÊ os critérios de outra (progressão e duelo usam a grade do v34)
  // não tem .md de critérios na pasta dela — o validador pertence à versão dona
  // do arquivo, e registrá-lo aqui criaria um caminho que não existe.
  if (!cfg.criteriosDe) {
    CRITERIOS_POR_CAMINHO[base + cfg.criterios] = cfg.id;
    VALIDATORS[base + cfg.criterios] = (content) => {
      const criteria = parseCriteria(content);
      const limites = require('./limites-criterios');
      if (criteria.length < limites.min || criteria.length > limites.max) {
        throw new Error(`Esperava de ${limites.min} a ${limites.max} critérios (com nome e linha curta), encontrei ${criteria.length}.`);
      }
      // O nome é a identidade do critério (demandas.md §16.6): dois com o mesmo
      // nome seriam o mesmo critério, e o segundo apagaria o primeiro.
      const nomes = criteria.map((c) => c.nome.toLowerCase());
      const repetido = nomes.find((n, i) => nomes.indexOf(n) !== i);
      if (repetido) throw new Error(`Dois critérios com o mesmo nome ("${repetido}"): o nome identifica o critério.`);
    };
  }
}

// Valida o conteúdo para um caminho. Devolve { ok } ou { ok:false, error }.
function validatePromptContent(relPath, content) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'Conteúdo vazio.' };
  if (Buffer.byteLength(content, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, error: `Conteúdo grande demais (máx. ${Math.round(MAX_PROMPT_BYTES / 1024)} KB).` };
  }
  const validate = VALIDATORS[normalizar(relPath)];
  if (!validate) return { ok: true, validado: false };
  try {
    validate(content);
    return { ok: true, validado: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Política para CRIAR um prompt que ainda não existe (o "Novo arquivo" do
// painel e o --criar do script). O resolvePromptPath já barra traversal e
// extensão; aqui vem o resto: onde pode nascer, quão fundo, e nome de segmento
// sem surpresa (nada começando com ponto, nada de caractere exótico). Devolve
// { ok } ou { ok:false, error } com a mensagem que o admin lê.
function validateNewPromptPath(relPath) {
  const rel = normalizar(relPath);
  if (!resolvePromptPath(rel)) {
    return { ok: false, error: 'Caminho inválido: precisa ser um .md dentro da pasta de prompts, sem ".." no meio.' };
  }
  const segs = rel.split('/');
  if (segs.length < 2 || segs.length > MAX_NEW_PATH_SEGMENTS) {
    return { ok: false, error: `O caminho precisa ter entre 2 e ${MAX_NEW_PATH_SEGMENTS} partes, começando pela pasta (ex.: avaliacao/v34/criterios-no-v34.md).` };
  }
  if (!PROMPT_ROOTS.includes(segs[0])) {
    return { ok: false, error: `Arquivo novo só pode ser criado dentro de ${PROMPT_ROOTS.join('/ ou ')}/ — o caminho começou com "${segs[0]}".` };
  }
  for (const seg of segs) {
    if (!seg || seg.startsWith('.')) return { ok: false, error: 'Cada parte do caminho precisa ter nome e não pode começar com ponto.' };
    if (seg.length > 80) return { ok: false, error: 'Cada parte do caminho tem de caber em 80 caracteres.' };
    // Letras (com acento), números, espaço e - _ . ( ) — o suficiente para os
    // nomes que já existem ("avaliador 18", "v34-progressao") e nada além.
    if (!/^[\p{L}\p{N} ._()-]+$/u.test(seg)) {
      return { ok: false, error: `"${seg}" tem caractere que não vale em nome de pasta ou arquivo aqui (use letras, números, espaço, ponto, hífen, sublinhado ou parênteses).` };
    }
  }
  return { ok: true };
}

// Se o arquivo tem contrato verificado (aparece na UI para o admin saber que a
// gravação vai passar por conferência).
function hasValidator(relPath) {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, normalizar(relPath));
}

// --- Prompts EM USO (não podem ser excluídos) ------------------------------
//
// O painel tem exclusão para o admin limpar prompts de réguas e modos que
// saíram do app, que ninguém lê e que só poluem a listagem. O risco óbvio disso
// é apagar por engano um prompt que a produção lê — aí a avaliação quebra para
// todo mundo.
//
// Por isso a exclusão tem uma allowlist invertida: tudo pode sair, MENOS o que
// o código aponta. A lista é DERIVADA, não escrita à mão — sai de
// PIPELINE_VERSIONS (as três entradas do avaliador oficial) mais os dois
// avaliadores que vivem fora do pipeline.
//
// (O `criteriosDe` é o motivo de `criterios` entrar pela pasta DONA do arquivo:
// progressão e duelo leem o do v34, e o caminho que existe é um só.)
const EM_USO = new Set();
for (const cfg of Object.values(PIPELINE_VERSIONS)) {
  const base = `avaliacao/${cfg.dir}/`;
  EM_USO.add(base + cfg.montado);
  EM_USO.add(base + cfg.sintetizador);
  if (cfg.missao) EM_USO.add(base + cfg.missao);
  if (!cfg.criteriosDe) EM_USO.add(base + cfg.criterios);
}
// Fora do pipeline, e é por isso que estão escritos aqui: o avaliador de Neuro
// (grade própria de 4 critérios) e o do entrevistador. Os dois são lidos por
// caminho fixo no index.js — se um deles for renomeado lá, tem de mudar aqui
// junto, e o teste que confere "todo prompt em uso existe" acusa.
EM_USO.add('avaliacao/avaliador 18/avaliador-v18-25-neuro.md');
EM_USO.add('entrevistador/promptentrevistador.md');

// O caminho é lido por algum código vivo? A UI usa isto para não oferecer o
// botão, e a rota para recusar — as duas pontas, porque a primeira é
// conveniência e a segunda é a trava.
function isPromptEmUso(relPath) {
  return EM_USO.has(normalizar(relPath));
}

// Os caminhos em uso, para o teste conferir que todos existem de fato.
function promptsEmUso() {
  return [...EM_USO];
}

// --- Gravação --------------------------------------------------------------

// Grava um prompt JÁ VALIDADO pela rota. `criar: true` só cria (nunca
// sobrescreve); sem ela só edita (nunca cria). Devolve
//   { ok: true, criado, versaoAnterior }  ou  { ok: false, motivo: 'existe' | 'nao-existe' }.
async function salvarPrompt(relPath, content, { autor, criar = false, motivo = 'edicao' } = {}) {
  const r = repoOuFalha();
  const rel = normalizar(relPath);
  const regua = CRITERIOS_POR_CAMINHO[rel];
  const criterios = regua ? { regua, lista: parseCriteria(content) } : undefined;

  if (criar) {
    const criado = await r.criar(rel, content, autor, { criterios });
    if (!criado) return { ok: false, motivo: 'existe' };
    store.definir(rel, content, criado.atualizadoEm);
    clearAssetsCache();
    return { ok: true, criado: true, versaoAnterior: null };
  }
  const gravado = await r.gravar(rel, content, autor, { motivo, criterios });
  if (!gravado) return { ok: false, motivo: 'nao-existe' };
  store.definir(rel, content, gravado.atualizadoEm);
  // O pipeline memoiza os prompts montados — sem isto o servidor serviria a versão velha.
  clearAssetsCache();
  return { ok: true, criado: false, versaoAnterior: gravado.versaoAnterior };
}

// Exclui um prompt, com o conteúdo guardado no histórico antes — excluir por
// engano tem volta pelo mesmo lugar que uma gravação ruim tem.
//
// Devolve { ok } ou { ok:false, error } — nunca lança por regra de negócio,
// porque a rota traduz isto direto para o admin.
async function deletePrompt(relPath, autor) {
  const rel = normalizar(relPath);
  if (!resolvePromptPath(rel)) return { ok: false, error: 'Caminho inválido.' };
  if (store.ler(rel) == null) return { ok: false, error: 'Arquivo não encontrado.' };
  if (isPromptEmUso(rel)) {
    return { ok: false, error: 'Este prompt está EM USO pelo app — apagá-lo quebraria a avaliação. Para trocar o conteúdo, edite o arquivo.' };
  }
  const r = await repoOuFalha().excluir(rel, autor);
  store.remover(rel);
  clearAssetsCache();
  if (!r) return { ok: false, error: 'Arquivo não encontrado.' };
  return { ok: true, versaoAnterior: r.versaoAnterior };
}

// --- Histórico -------------------------------------------------------------

// Histórico de um arquivo, mais recente primeiro.
async function listBackups(relPath) {
  return repoOuFalha().versoes(normalizar(relPath));
}

// Id de versão é o id numérico da linha em prompt_versoes.
function isValidBackupId(id) {
  return /^[0-9]{1,18}$/.test(String(id || ''));
}

async function readBackup(relPath, id) {
  if (!isValidBackupId(id)) return null;
  return repoOuFalha().versao(normalizar(relPath), id);
}

module.exports = {
  iniciar,
  recarregar,
  isPromptEmUso,
  promptsEmUso,
  deletePrompt,
  PROMPT_ROOTS,
  resolvePromptPath,
  validateNewPromptPath,
  relOf,
  lerPrompt,
  listPromptFiles,
  validatePromptContent,
  hasValidator,
  salvarPrompt,
  listBackups,
  readBackup,
};
