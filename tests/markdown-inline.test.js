// Formatação inline de markdown na EXIBIÇÃO (client/src/markdownInline.js).
//
// O caso que originou o módulo: a fala do paciente chegava como
// `Oi. *senta na cadeira examinando a sala*` e o aluno lia os asteriscos crus.
// Os testes aqui protegem as duas pontas do risco: marcação que TEM de virar
// formatação, e marcação falsa (asterisco de multiplicação, bullet de lista,
// snake_case) que NÃO pode virar — porque nesse caso o texto do modelo
// desapareceria da tela.
//
// O módulo é ESM (código de cliente), daí o import dinâmico.
let parseInline;
let stripInline;

beforeAll(async () => {
  const mod = await import('../client/src/markdownInline.js');
  parseInline = mod.parseInline;
  stripInline = mod.stripInline;
});

// Helper de leitura: 'texto' puro, '*it*', '**bo**', '~ta~', '`co`'.
function resumo(tokens) {
  return tokens.map((t) => {
    if (t.code) return '`' + t.text + '`';
    if (t.bold && t.italic) return '***' + t.text + '***';
    if (t.bold) return '**' + t.text + '**';
    if (t.italic) return '*' + t.text + '*';
    if (t.strike) return '~' + t.text + '~';
    return t.text;
  }).join('|');
}

describe('markdownInline — o que TEM de virar formatação', () => {
  it('a fala do paciente: ação entre asteriscos vira itálico', () => {
    expect(resumo(parseInline('Oi. *senta na cadeira examinando a sala*')))
      .toBe('Oi. |*senta na cadeira examinando a sala*');
  });

  it('negrito, itálico, tachado e código', () => {
    expect(resumo(parseInline('**forte**'))).toBe('**forte**');
    expect(resumo(parseInline('*leve*'))).toBe('*leve*');
    expect(resumo(parseInline('_leve_'))).toBe('*leve*');
    expect(resumo(parseInline('__forte__'))).toBe('**forte**');
    expect(resumo(parseInline('~~cortado~~'))).toBe('~cortado~');
    expect(resumo(parseInline('`literal`'))).toBe('`literal`');
  });

  it('os dois juntos, aninhados ou em três asteriscos', () => {
    expect(resumo(parseInline('***tudo***'))).toBe('***tudo***');
    expect(resumo(parseInline('**forte com *leve* dentro**')))
      .toBe('**forte com **|***leve***|** dentro**');
  });

  it('vários trechos na mesma fala', () => {
    expect(resumo(parseInline('*ri* e depois **chora** de novo')))
      .toBe('*ri*| e depois |**chora**| de novo');
  });

  it('não engole o texto: o conteúdo sempre sobrevive inteiro', () => {
    const entradas = [
      'Oi. *senta* e **respira**',
      '2 * 3 * 4 = 24',
      'arquivo_de_teste_final.txt',
      '**',
      '*',
      'a ** b * c _ d',
      '`código sem fim',
      '*abre e não fecha',
    ];
    for (const e of entradas) {
      expect(stripInline(e).replace(/[*_~`]/g, '')).toBe(e.replace(/[*_~`]/g, ''));
    }
  });
});

describe('markdownInline — o que NÃO pode virar formatação', () => {
  it('asterisco de multiplicação e de bullet fica literal', () => {
    // Espaço logo depois do marcador = não é ênfase.
    expect(resumo(parseInline('2 * 3 * 4'))).toBe('2 * 3 * 4');
    expect(resumo(parseInline('* primeiro item'))).toBe('* primeiro item');
    expect(resumo(parseInline('Custa 5 ** 2 reais'))).toBe('Custa 5 ** 2 reais');
  });

  it('underscore no meio de palavra é underscore (snake_case intacto)', () => {
    expect(resumo(parseInline('rode o benchmark_simulacao_test agora')))
      .toBe('rode o benchmark_simulacao_test agora');
    expect(resumo(parseInline('gpt-5.6-luna_high'))).toBe('gpt-5.6-luna_high');
  });

  it('marcador sem par fica na tela como texto', () => {
    expect(resumo(parseInline('*abre e nunca fecha'))).toBe('*abre e nunca fecha');
    expect(resumo(parseInline('fecha sem abrir*'))).toBe('fecha sem abrir*');
    expect(resumo(parseInline('**meio negrito'))).toBe('**meio negrito');
  });

  it('ênfase NÃO atravessa quebra de linha', () => {
    // Sem essa regra, um asterisco solto no começo de um parágrafo transformaria
    // metade da mensagem em itálico.
    expect(resumo(parseInline('*solto no fim da linha\noutra linha aqui')))
      .toBe('*solto no fim da linha\noutra linha aqui');
    expect(resumo(parseInline('**forte na linha 1\ne fecha na 2**')))
      .toBe('**forte na linha 1\ne fecha na 2**');
  });

  it('marcador vazio e espaço interno não abrem ênfase', () => {
    expect(resumo(parseInline('****'))).toBe('****');
    expect(resumo(parseInline('** vazio com espaço**'))).toBe('** vazio com espaço**');
    expect(resumo(parseInline('*texto solto *'))).toBe('*texto solto *');
  });
});

describe('markdownInline — bordas', () => {
  it('entrada vazia, nula ou não-string não quebra', () => {
    expect(parseInline('')).toEqual([]);
    expect(parseInline(null)).toEqual([]);
    expect(parseInline(undefined)).toEqual([]);
    expect(resumo(parseInline(42))).toBe('42');
  });

  it('quebras de linha e espaços são preservados byte a byte', () => {
    // O CSS do container (white-space: pre-wrap) é que os exibe — o parser não
    // pode normalizar nada, senão o parágrafo do paciente colapsa.
    const t = 'linha 1\n\n  linha 3 com dois espaços à frente\n';
    expect(stripInline(t)).toBe(t);
  });

  it('tokens vizinhos com as mesmas marcas são fundidos', () => {
    // Menos nós no DOM em transcrição longa.
    expect(parseInline('abc')).toHaveLength(1);
    expect(parseInline('a*b*c')).toHaveLength(3);
  });

  it('não produz HTML: o token é dado, nunca markup', () => {
    const tokens = parseInline('<script>alert(1)</script> **e negrito**');
    expect(tokens[0].text).toContain('<script>');
    expect(tokens.some((t) => t.bold)).toBe(true);
    // Nenhum campo além de text/marcas — nada que possa virar innerHTML.
    for (const t of tokens) {
      expect(Object.keys(t).every((k) => ['text', 'bold', 'italic', 'strike', 'code'].includes(k))).toBe(true);
    }
  });
});
