// Formatação inline de markdown para EXIBIÇÃO.
//
// Por que existe: os modelos escrevem naturalmente em markdown, então a fala do
// paciente chega como `Oi. *senta na cadeira examinando a sala*` e o aluno lia os
// asteriscos crus na tela. Aqui os marcadores viram formatação de verdade —
// itálico, negrito, tachado, monoespaçado — em todo lugar do all_OS que mostra
// prosa gerada por IA (falas, avaliação, feedback, transcrições).
//
// O que NÃO muda: o texto CRU continua sendo o que é salvo, copiado e baixado
// (os .txt são montados a partir de `content`, não daqui). A formatação é só a
// camada de leitura — quem baixa o log recebe os marcadores como sempre.
//
// Escopo deliberado: só marcação INLINE. Nada de título, lista, tabela ou link,
// que exigiriam mexer na estrutura de bloco de umas quinze telas. Nenhuma
// dependência nova, e nenhum HTML injetado: a saída é uma lista de tokens que o
// <RichText> transforma em elementos React (então texto do modelo nunca vira
// markup executável).
//
// Sem lookbehind em regex de propósito: o app é PWA e roda em iPhone antigo, onde
// `(?<!…)` não existe. O varredor é manual.

// Delimitadores, do mais longo para o mais curto (a ordem é a precedência: `***`
// tem de ser testado antes de `**`, que tem de vir antes de `*`).
const DELIMITADORES = [
  { abre: '***', marcas: { bold: true, italic: true } },
  { abre: '___', marcas: { bold: true, italic: true } },
  { abre: '**', marcas: { bold: true } },
  { abre: '__', marcas: { bold: true } },
  { abre: '~~', marcas: { strike: true } },
  { abre: '*', marcas: { italic: true } },
  { abre: '_', marcas: { italic: true } },
];

function ehEspaco(ch) {
  return ch === undefined || /\s/.test(ch);
}
// Letra ou número em qualquer alfabeto — é o teste de "estou no meio de uma
// palavra?", que protege `snake_case` e `nome_do_arquivo` de virarem itálico.
function ehLetraOuNumero(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}
// Delimitador da família do underscore: só vale em borda de palavra.
function ehUnderscore(d) {
  return d.abre[0] === '_';
}

// Um delimitador pode ABRIR na posição i?
function delimitadorEm(s, i) {
  for (const d of DELIMITADORES) {
    if (!s.startsWith(d.abre, i)) continue;
    const depois = s[i + d.abre.length];
    // `** texto**` não é negrito (espaço logo após o marcador), e `* item` de
    // lista também não. `****` idem: o caractere seguinte é o próprio marcador.
    if (ehEspaco(depois) || depois === d.abre[0]) continue;
    // Underscore no meio de palavra é underscore, não ênfase.
    if (ehUnderscore(d) && ehLetraOuNumero(s[i - 1])) continue;
    return d;
  }
  return null;
}

// Onde este delimitador FECHA, procurando a partir de `de`. -1 se não fecha.
function acharFechamento(s, de, d) {
  const len = d.abre.length;
  for (let j = de; j <= s.length - len; j++) {
    // Ênfase não atravessa linha: um `*` solto no começo de um parágrafo não
    // pode engolir o resto da mensagem inteira.
    if (s[j] === '\n') return -1;
    if (!s.startsWith(d.abre, j)) continue;
    if (j === de) continue;                    // conteúdo vazio
    if (ehEspaco(s[j - 1])) continue;          // `*texto *` não fecha
    // Marcador de um caractere não fecha em cima de um par (`*a**b*`).
    if (len === 1 && s[j + 1] === d.abre[0]) continue;
    if (ehUnderscore(d) && ehLetraOuNumero(s[j + len])) continue;
    return j;
  }
  return -1;
}

// Fim de um trecho de código `assim`. Não atravessa linha.
function acharFimCodigo(s, de) {
  for (let j = de; j < s.length; j++) {
    if (s[j] === '\n') return -1;
    if (s[j] === '`') return j === de ? -1 : j;
  }
  return -1;
}

// Junta o token ao anterior quando as marcas são idênticas — menos nós no DOM e
// saída mais fácil de asseverar em teste.
function empurrar(tokens, token) {
  if (!token.text) return;
  const ultimo = tokens[tokens.length - 1];
  if (ultimo
    && !!ultimo.bold === !!token.bold
    && !!ultimo.italic === !!token.italic
    && !!ultimo.strike === !!token.strike
    && !!ultimo.code === !!token.code) {
    ultimo.text += token.text;
    return;
  }
  tokens.push(token);
}

/**
 * Quebra o texto em tokens `{ text, bold?, italic?, strike?, code? }`.
 * Marcador sem par fica como texto literal — nunca desaparece da tela.
 */
export function parseInline(texto, marcasHerdadas) {
  const s = texto == null ? '' : String(texto);
  const base = marcasHerdadas || {};
  const tokens = [];
  let buffer = '';
  const despejar = () => {
    if (buffer) { empurrar(tokens, { text: buffer, ...base }); buffer = ''; }
  };

  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      const fim = acharFimCodigo(s, i + 1);
      if (fim > 0) {
        despejar();
        empurrar(tokens, { text: s.slice(i + 1, fim), ...base, code: true });
        i = fim + 1;
        continue;
      }
    }
    const d = delimitadorEm(s, i);
    if (d) {
      const fim = acharFechamento(s, i + d.abre.length, d);
      if (fim > 0) {
        despejar();
        // Recursão: `**negrito com *itálico* dentro**` acumula as duas marcas.
        for (const t of parseInline(s.slice(i + d.abre.length, fim), { ...base, ...d.marcas })) {
          empurrar(tokens, t);
        }
        i = fim + d.abre.length;
        continue;
      }
    }
    buffer += s[i];
    i += 1;
  }
  despejar();
  return tokens;
}

/**
 * Texto sem NENHUMA marcação (para title=, aria-label, placeholder e outros
 * lugares que só aceitam string). Não é o texto do log: aqui os marcadores são
 * removidos, não preservados.
 */
export function stripInline(texto) {
  return parseInline(texto).map((t) => t.text).join('');
}

export default parseInline;
