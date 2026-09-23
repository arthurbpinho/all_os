// "Adicionar critério" e editar critério sem abrir o .md (demandas.md §16.6) —
// lógica PURA sobre o texto do arquivo de critérios da régua.
//
// O arquivo continua sendo a fonte da verdade (é o que o nó lê no slot
// {{CRITÉRIO}}); estas funções só montam o texto novo. Quem grava é a rota, pelo
// mesmo caminho de uma edição no painel de Prompts: valida no parser da
// produção e guarda a versão anterior no histórico.
//
// Anatomia do arquivo (ver parseCriteria em avaliador-pipeline.js):
//   ## 1 · Nome            ← um bloco por critério, até o próximo "## " ou "---"
//   (descrição)
//   ---
//   ## Linha curta de cada critério
//   1. **Nome**: linha curta.

const { parseCriteria, PIPELINE_VERSIONS } = require('./avaliador-pipeline');
const LIMITES = require('./limites-criterios');

const CFG = PIPELINE_VERSIONS.v34;
const REGUA = CFG.id;
const CAMINHO = `avaliacao/${CFG.dir}/${CFG.criterios}`;
// Pastas de prompt das entradas do pipeline (v34, progressão, duelo).
const PASTAS_PIPELINE = Object.values(PIPELINE_VERSIONS).map((c) => `avaliacao/${c.dir}/`);
const MAX = { nome: 60, linhaCurta: 300, descricao: 8000 };

// Critérios do texto, com a descrição SEM o cabeçalho "## N · Nome" (é o que o
// admin edita; o cabeçalho o código remonta).
function lerCriterios(raw) {
  return parseCriteria(String(raw || '')).map((c) => ({
    ...c,
    corpo: c.descricao.replace(/^## [^\n]*\n?/, '').replace(/^\s*\n/, '').trim(),
  }));
}

// Campos saneados, ou { erro }. Tudo que quebraria o parser é recusado aqui,
// com uma mensagem que o admin entende, em vez de um "encontrei 8 critérios".
function sanear({ nome, linhaCurta, descricao } = {}) {
  const n = String(nome == null ? '' : nome).trim().replace(/\s+/g, ' ');
  const l = String(linhaCurta == null ? '' : linhaCurta).trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  const d = String(descricao == null ? '' : descricao).replace(/\r\n/g, '\n').trim();
  if (!n) return { erro: 'Dê um nome ao critério.' };
  if (n.length > MAX.nome) return { erro: `O nome pode ter até ${MAX.nome} caracteres.` };
  if (/[*#·]/.test(n)) return { erro: 'O nome não pode ter *, # nem ·.' };
  if (!l) return { erro: 'Escreva a linha curta: é ela que o sintetizador lê.' };
  if (l.length > MAX.linhaCurta) return { erro: `A linha curta pode ter até ${MAX.linhaCurta} caracteres.` };
  if (!d) return { erro: 'Escreva a descrição do critério: é o que o nó lê para avaliar.' };
  if (d.length > MAX.descricao) return { erro: `A descrição pode ter até ${MAX.descricao} caracteres.` };
  if (/^(#{1,2} |---\s*$)/m.test(d)) {
    return { erro: 'A descrição não pode ter linhas começando com "# ", "## " ou "---": elas separam os critérios no arquivo.' };
  }
  return { campos: { nome: n, linhaCurta: l, descricao: d } };
}

const bloco = (num, c) => `## ${num} · ${c.nome}\n\n${c.descricao}`;
const linha = (num, c) => `${num}. **${c.nome}**: ${c.linhaCurta}.`;

function nomeEmUso(criterios, nome, excetoNum) {
  const k = nome.toLocaleLowerCase('pt-BR');
  return criterios.some((c) => c.num !== excetoNum && c.nome.toLocaleLowerCase('pt-BR') === k);
}

// O título "· Os 8 critérios" acompanha a contagem, quando o arquivo o tem.
function atualizarTitulo(raw, total) {
  return raw.replace(/^(# [^\n]*?·\s*Os\s+)\d+(\s+critérios)/m, `$1${total}$2`);
}

// { ok, raw, num } | { ok: false, erro }
function adicionarCriterio(raw, dados) {
  const texto = String(raw || '');
  const s = sanear(dados);
  if (s.erro) return { ok: false, erro: s.erro };
  const atuais = parseCriteria(texto);
  if (atuais.length >= LIMITES.max) return { ok: false, erro: `A régua já tem ${LIMITES.max} critérios, o máximo.` };
  if (nomeEmUso(atuais, s.campos.nome)) return { ok: false, erro: `Já existe um critério chamado "${s.campos.nome}".` };

  const lc = texto.indexOf('## Linha curta');
  if (lc === -1) return { ok: false, erro: 'O arquivo de critérios não tem a seção "## Linha curta"; edite-o em Prompts.' };
  const num = atuais.length ? Math.max(...atuais.map((c) => c.num)) + 1 : 1;

  // O bloco novo entra depois do último critério, antes do "---" que abre a
  // seção de linhas curtas.
  const antes = texto.slice(0, lc);
  const sep = antes.match(/\n---[^\S\n]*\n\s*$/);
  const corpoAntes = (sep ? antes.slice(0, antes.length - sep[0].length) : antes).replace(/\s+$/, '');
  const novoAntes = `${corpoAntes}\n\n${bloco(num, s.campos)}\n\n${sep ? '---\n\n' : ''}`;
  const novoDepois = `${texto.slice(lc).replace(/\s+$/, '')}\n${linha(num, s.campos)}\n`;
  const novo = atualizarTitulo(novoAntes + novoDepois, atuais.length + 1);
  return conferir(novo, num, s.campos, atuais.length + 1);
}

// { ok, raw, num, anterior } | { ok: false, erro, naoExiste? }
function editarCriterio(raw, num, dados) {
  const texto = String(raw || '');
  const n = Number(num);
  const s = sanear(dados);
  if (s.erro) return { ok: false, erro: s.erro };
  const atuais = parseCriteria(texto);
  const alvo = atuais.find((c) => c.num === n);
  if (!alvo) return { ok: false, naoExiste: true, erro: 'Critério não encontrado.' };
  if (nomeEmUso(atuais, s.campos.nome, n)) return { ok: false, erro: `Já existe um critério chamado "${s.campos.nome}".` };

  const i = texto.indexOf(alvo.descricao);
  const lc = texto.indexOf('## Linha curta');
  if (i === -1 || lc === -1 || i > lc) return { ok: false, erro: 'Não achei o bloco do critério no arquivo; edite-o em Prompts.' };
  let novo = texto.slice(0, i) + bloco(n, s.campos) + texto.slice(i + alvo.descricao.length);
  const lc2 = novo.indexOf('## Linha curta');
  const reLinha = new RegExp(`^${n}\\.\\s+\\*\\*.+$`, 'm');
  const secao = novo.slice(lc2);
  if (!reLinha.test(secao)) return { ok: false, erro: 'Não achei a linha curta do critério no arquivo; edite-o em Prompts.' };
  novo = novo.slice(0, lc2) + secao.replace(reLinha, () => linha(n, s.campos));
  const r = conferir(novo, n, s.campos, atuais.length);
  return r.ok ? { ...r, anterior: { nome: alvo.nome, linhaCurta: alvo.linhaCurta } } : r;
}

// Escapa um nome para entrar numa RegExp (os nomes vêm do admin).
const re = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// { ok, raw, removido } | { ok: false, erro, naoExiste? }
//
// DESATIVAR, não apagar. O critério sai do arquivo, e a sincronização
// (server/repos/prompts.js, sincronizarCriterios) marca a linha dele em
// `criterios` com ativo = false em vez de removê-la: o nome, o histórico e os
// nomes anteriores continuam lá, então as notas já dadas seguem casando no
// gráfico do perfil. Voltar é colocá-lo de novo com o mesmo nome.
//
// Os que sobram são RENUMERADOS. A numeração é posicional — é o lado do polígono
// do gráfico —, e não a identidade do critério (essa é o nome). Deixar buraco
// desenharia um gráfico com um lado faltando.
function removerCriterio(raw, num) {
  const texto = String(raw || '');
  const n = Number(num);
  const atuais = parseCriteria(texto);
  const alvo = atuais.find((c) => c.num === n);
  if (!alvo) return { ok: false, naoExiste: true, erro: 'Critério não encontrado.' };
  if (atuais.length <= LIMITES.min) {
    return { ok: false, erro: `A régua precisa de pelo menos ${LIMITES.min} critérios; esta tem ${atuais.length}.` };
  }

  const lc = texto.indexOf('## Linha curta');
  const i = texto.indexOf(alvo.descricao);
  if (i === -1 || lc === -1 || i > lc) {
    return { ok: false, erro: 'Não achei o bloco do critério no arquivo; edite-o em Prompts.' };
  }

  // Tira o bloco e fecha o buraco de linhas em branco que ele deixa.
  let novo = (texto.slice(0, i) + texto.slice(i + alvo.descricao.length)).replace(/\n{3,}/g, '\n\n');

  // Tira a linha curta correspondente.
  const lc2 = novo.indexOf('## Linha curta');
  const reLinha = new RegExp(`^${n}\\.\\s+\\*\\*${re(alvo.nome)}\\*\\*.*$\\n?`, 'm');
  const secao = novo.slice(lc2);
  if (!reLinha.test(secao)) {
    return { ok: false, erro: 'Não achei a linha curta do critério no arquivo; edite-o em Prompts.' };
  }
  novo = novo.slice(0, lc2) + secao.replace(reLinha, '');

  // Renumera os que sobraram. Em ordem crescente de propósito: como todos os
  // números só DIMINUEM, quando o 4 vira 3 o antigo 3 já virou 2 — nenhum
  // número colide com um que ainda não foi trocado.
  const restantes = atuais.filter((c) => c.num !== n);
  restantes.forEach((c, idx) => {
    const novoNum = idx + 1;
    if (c.num === novoNum) return;
    novo = novo.replace(new RegExp(`^## ${c.num} · ${re(c.nome)}[^\\S\\n]*$`, 'm'), `## ${novoNum} · ${c.nome}`);
    novo = novo.replace(new RegExp(`^${c.num}\\.\\s+\\*\\*${re(c.nome)}\\*\\*`, 'm'), `${novoNum}. **${c.nome}**`);
  });

  novo = atualizarTitulo(novo, restantes.length);

  // Mesma desconfiança de `conferir`: relê no parser da produção e só aceita se
  // sobraram exatamente os critérios certos, na ordem certa.
  const lidos = parseCriteria(novo);
  const esperado = restantes.map((c) => c.nome);
  if (lidos.length !== esperado.length || lidos.some((c, idx) => c.nome !== esperado[idx] || c.num !== idx + 1)) {
    return { ok: false, erro: 'O arquivo de critérios tem um formato que não consegui editar com segurança; edite-o em Prompts.' };
  }
  return { ok: true, raw: novo, removido: { nome: alvo.nome, num: n } };
}

// Relê o texto montado no parser da produção: se o critério não voltar igual,
// o arquivo tinha alguma forma que estas funções não previram, e é melhor
// recusar do que gravar uma régua que perdeu um critério.
function conferir(novo, num, campos, total) {
  const lidos = parseCriteria(novo);
  const c = lidos.find((x) => x.num === num);
  if (lidos.length !== total || !c || c.nome !== campos.nome || c.linhaCurta !== campos.linhaCurta) {
    return { ok: false, erro: 'O arquivo de critérios tem um formato que não consegui editar com segurança; edite-o em Prompts.' };
  }
  return { ok: true, raw: novo, num };
}

// Trechos de prompt que escrevem a quantidade de critérios À MÃO ("os oito
// critérios", "oito nós", "octógono"). Não trava nada: é o aviso que o painel
// mostra, para o admin trocar o número pelos slots {{N_CRITERIOS}},
// {{N_CRITERIOS_EXTENSO}} ou {{LISTA_CRITERIOS}}, que o código preenche. Títulos
// ("# ...") ficam de fora — o do arquivo de critérios o painel já atualiza.
const QUANTIDADE_FIXA = /\b(?:os\s+)?(?:oito|nove|8|9)\s+(?:critérios|criterios|nós|nos de critério)\b|\boctógono\b/gi;
function citacoesDeQuantidadeFixa(prompts) {
  const out = [];
  for (const { caminho, conteudo } of prompts || []) {
    String(conteudo || '').split('\n').forEach((linha, i) => {
      if (/^#\s/.test(linha)) return;
      const achados = linha.match(QUANTIDADE_FIXA);
      if (achados) out.push({ caminho, linha: i + 1, trecho: [...new Set(achados)].join(', ') });
    });
  }
  return out;
}

module.exports = {
  REGUA, CAMINHO, PASTAS_PIPELINE, LIMITES, MAX, lerCriterios, sanear, adicionarCriterio, editarCriterio, removerCriterio, citacoesDeQuantidadeFixa,
};
