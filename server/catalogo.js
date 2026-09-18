// Catálogos em memória, com o banco como fonte da verdade (demandas.md §20).
//
// O app lê os catálogos de forma SÍNCRONA em dezenas de lugares (montar o
// prompt do paciente, o Bloco 1, o card do Competitivo…), como lia os arquivos.
// Por isso a cópia em memória: carregada no boot e trocada a cada gravação. Vale
// o mesmo que para os prompts e as configurações: uma instância só do app.
//
// `ler` devolve uma CÓPIA: o código de sempre altera a lista lida antes de
// gravar, e alterar a cópia em memória por engano mudaria o catálogo sem passar
// pelo banco.
//
// `atualizar` serializa as gravações de um mesmo catálogo. Com arquivo, o
// "lê → altera → grava" rodava inteiro de forma síncrona e duas edições nunca se
// intercalavam; com o banco há um `await` no meio, e sem a fila duas edições
// simultâneas do admin perderiam uma delas.

const fs = require('fs');
const path = require('path');
const { TIPOS } = require('./repos/catalogo');

// Arquivo de cada catálogo no volume antigo (semeadura e importação).
const ARQUIVOS = {
  freeplay: 'freeplay-characters.json',
  neuro: 'neuro-characters.json',
  exercicios: 'exercises.json',
  trilha_skills: 'trilha-skills.json',
};

function criarCatalogo(repo) {
  const cache = new Map(TIPOS.map((t) => [t, []]));
  const filas = new Map();

  function conferir(tipo) {
    if (!cache.has(tipo)) throw new Error(`Catálogo desconhecido: ${tipo}`);
  }

  async function carregar() {
    const todos = await repo.todos();
    for (const t of TIPOS) cache.set(t, todos[t] || []);
  }

  function ler(tipo) {
    conferir(tipo);
    return structuredClone(cache.get(tipo));
  }

  // `fn(lista)` recebe uma cópia e devolve { lista?, valor? }. Com `lista`, ela
  // é gravada no banco e vira a cópia em memória; sem, nada é gravado (ex.: 404).
  // Devolve `valor`.
  function atualizar(tipo, fn) {
    conferir(tipo);
    const anterior = filas.get(tipo) || Promise.resolve();
    const esta = anterior.then(async () => {
      const r = (await fn(ler(tipo))) || {};
      if (r.lista) {
        await repo.substituir(tipo, r.lista);
        cache.set(tipo, structuredClone(r.lista));
      }
      return r.valor;
    });
    // A fila segue mesmo que esta gravação falhe; quem chamou recebe o erro.
    filas.set(tipo, esta.catch(() => {}));
    return esta;
  }

  function definir(tipo, lista) {
    return atualizar(tipo, () => ({ lista }));
  }

  // Primeira carga no boot: de cada catálogo que ainda não foi semeado, lê o
  // arquivo do volume (dado de produção) ou, sem ele, usa o padrão. Arquivo
  // ilegível não derruba o boot: o catálogo fica sem semear e o erro sai no log.
  async function semearDoVolume(dataDir, padroes = {}) {
    const semeados = [];
    for (const tipo of TIPOS) {
      if (await repo.jaSemeado(tipo)) continue;
      const arquivo = path.join(dataDir, ARQUIVOS[tipo]);
      let lista = padroes[tipo] || [];
      if (fs.existsSync(arquivo)) {
        try {
          lista = JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
        } catch (e) {
          console.error(`[catalogo] ${ARQUIVOS[tipo]} ilegível, catálogo ${tipo} não semeado:`, e.message);
          continue;
        }
      }
      if (await repo.semearUmaVez(tipo, lista)) semeados.push(`${tipo} (${lista.length})`);
    }
    return semeados;
  }

  return { carregar, ler, atualizar, definir, semearDoVolume };
}

module.exports = { criarCatalogo, ARQUIVOS, TIPOS };
