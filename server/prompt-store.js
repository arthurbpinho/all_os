// Cópia em memória dos prompts do banco (tabela prompt_arquivos).
//
// Por que em memória: o avaliador monta os prompts de forma SÍNCRONA
// (loadAssets, chamado em muitos pontos), e os prompts mudam só quando o admin
// grava pelo painel. Então o banco é a verdade e esta cópia é o que o código lê:
// carregada inteira no boot (prompt-files.iniciar) e atualizada a cada gravação,
// que passa sempre pelo prompt-files.
//
// Vale porque o app roda em UMA instância (CLAUDE.md §2). Com duas, uma gravação
// numa não chegaria à memória da outra — escalar horizontalmente exige trocar
// isto por leitura no banco ou por um aviso entre instâncias (LISTEN/NOTIFY).
//
// Sem dependências de propósito: o avaliador-pipeline lê daqui, e o
// prompt-files (que depende do avaliador-pipeline) escreve aqui.

const arquivos = new Map(); // caminho → { conteudo, atualizadoEm }

function carregar(lista) {
  arquivos.clear();
  for (const a of lista) arquivos.set(a.caminho, { conteudo: a.conteudo, atualizadoEm: a.atualizadoEm });
}

function definir(caminho, conteudo, atualizadoEm) {
  arquivos.set(caminho, { conteudo, atualizadoEm: atualizadoEm || new Date().toISOString() });
}

function remover(caminho) {
  arquivos.delete(caminho);
}

function ler(caminho) {
  const a = arquivos.get(caminho);
  return a ? a.conteudo : null;
}

// Para quem não tem o que fazer sem o prompt (o avaliador): o erro diz qual falta.
function lerObrigatorio(caminho) {
  const conteudo = ler(caminho);
  if (conteudo == null) throw new Error(`Prompt não encontrado no banco: ${caminho}`);
  return conteudo;
}

function listar() {
  return [...arquivos.entries()].map(([caminho, a]) => ({ caminho, ...a }));
}

module.exports = { carregar, definir, remover, ler, lerObrigatorio, listar };
