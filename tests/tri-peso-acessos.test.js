// Peso do TRI por população, editável em Administração → Acessos.
//
// O número era só variável de ambiente (TRI_PESO_SELECAO), o que obrigava um
// deploy para ajustar um parâmetro que só se afina com dados reais na mão.
// Aqui ficam as regras do saneamento; o efeito no engine está em
// tests/tri-dificuldade.test.js.

const acessos = require('../server/acessos');

const PADROES = { selecao: 0.35, visitante: 0.5 };

describe('pesos do TRI na tela de Acessos', () => {
  it('sem nada gravado, usa os padrões de ambiente', () => {
    expect(acessos.normalizarPesosTri(null, PADROES)).toEqual({ selecao: 0.35, visitante: 0.5 });
    expect(acessos.normalizarPesosTri({}, PADROES)).toEqual({ selecao: 0.35, visitante: 0.5 });
  });

  it('a população que o admin não tocou fica no padrão', () => {
    expect(acessos.normalizarPesosTri({ selecao: 0.8 }, PADROES))
      .toEqual({ selecao: 0.8, visitante: 0.5 });
  });

  // O teto é 1 porque é o peso de um aluno cadastrado: acima disso a população
  // anônima pesaria MAIS que a pessoa conhecida, invertendo a razão de o peso
  // existir.
  it('corta acima de 1 e abaixo de 0', () => {
    expect(acessos.normalizarPesosTri({ selecao: 9, visitante: -3 }, PADROES))
      .toEqual({ selecao: 1, visitante: 0 });
  });

  it('aceita 0 — é como o admin desliga aquela população', () => {
    expect(acessos.normalizarPesosTri({ selecao: 0 }, PADROES).selecao).toBe(0);
  });

  it('arredonda para duas casas', () => {
    expect(acessos.normalizarPesosTri({ selecao: 0.336 }, PADROES).selecao).toBe(0.34);
  });

  it('valor não numérico cai no padrão, em vez de virar NaN no ajuste do D', () => {
    expect(acessos.normalizarPesosTri({ selecao: 'abc' }, PADROES).selecao).toBe(0.35);
  });

  // Number(null), Number(undefined via '') e Number('') são 0 — e 0 aqui
  // significa "desligado". Campo apagado na tela tem de voltar ao padrão, não
  // desligar o TRI em silêncio.
  it('campo vazio volta ao padrão; zero DIGITADO continua desligando', () => {
    expect(acessos.normalizarPesosTri({ selecao: null }, PADROES).selecao).toBe(0.35);
    expect(acessos.normalizarPesosTri({ selecao: '' }, PADROES).selecao).toBe(0.35);
    expect(acessos.normalizarPesosTri({ selecao: '   ' }, PADROES).selecao).toBe(0.35);
    expect(acessos.normalizarPesosTri({ selecao: 0 }, PADROES).selecao).toBe(0);
    expect(acessos.normalizarPesosTri({ selecao: '0' }, PADROES).selecao).toBe(0);
  });

  // A tela manda texto (ver AdminAcessos.jsx): é o servidor que converte.
  it('aceita o texto que vem do formulário', () => {
    expect(acessos.normalizarPesosTri({ selecao: '0.6' }, PADROES).selecao).toBe(0.6);
    expect(acessos.normalizarPesosTri({ selecao: '1' }, PADROES).selecao).toBe(1);
  });

  it('chave desconhecida é descartada', () => {
    expect(acessos.normalizarPesosTri({ inventada: 0.9 }, PADROES))
      .toEqual({ selecao: 0.35, visitante: 0.5 });
  });

  it('o catálogo tem as duas populações do TRI', () => {
    expect(acessos.POOL_TRI_KEYS).toEqual(['selecao', 'visitante']);
    for (const p of acessos.POOLS_TRI) {
      expect(p.label).toBeTruthy();
      expect(p.descricao).toBeTruthy();
    }
  });
});

// Após a reforma do §24 (MMR por critério), o peso do TRI virou um GATE
// aplicado no wrapper `registrarTriAnonimo` (server/index.js), não mais um
// dWeight que escala o ajuste do D dentro do motor. As populações do seletivo
// e do visitante têm o MESMO peso sobre o D dos alunos (spec §15); o peso do
// admin em Acessos só decide se aquela população contribui ou não. Motor por
// critério: peso 0 → wrapper NÃO grava character/fontes; peso > 0 → grava
// tudo, e a população continua aprendendo o próprio rating nos dois casos.
describe('peso 0: efeito de gate no motor por critério', () => {
  const mmr = require('../server/mmr');

  function partida() {
    // População fora da calibração: se estivesse calibrando, o teste não
    // distinguiria "gate desligado" de "ainda calibrando" — mas com o motor
    // novo a calibração não bloqueia mais o D (spec §6), então basta um
    // estado com nEntradas alto para o motor mover D e P na mesma partida.
    const pop = { nEntradas: 10, criterios: { c1: { P: 50, n: 10, janela: [] } } };
    const char = { criterios: { c1: { D: 50, n_D: 10, beta: 1, historico: [] } } };
    return mmr.updateMatch(pop, char, {}, {
      criterios: { c1: 20 }, notaTotal: 20, fonte: 'selecao',
    });
  }

  it('motor sempre mexe no D e no P — quem cliva "peso 0 = desligado" é o wrapper', () => {
    const r = partida();
    // O motor não sabe do peso: para ele, se a nota total não trava a partida
    // (>= 25 é o critério, e aqui 20 travaria — mas o pipeline por critério
    // ainda move o P). Verificamos que a partida foi processada.
    expect(r.result.movimentou).toBe(true);
    // Com nota total 20 (< 25), a trava de 25 bloqueia o D — este é o
    // bloqueio via nota total, independente do peso.
    expect(r.character.criterios.c1.D).toBe(50); // trava-25 não deixou mover
    // O P mesmo assim se moveu (spec §3.1: nota < 25 move o P, não o D).
    expect(r.player.criterios.c1.P).not.toBe(50);
  });

  it('sem a trava de 25, o D anda; é o wrapper que decide se grava (peso > 0) ou não (peso 0)', () => {
    const pop = { nEntradas: 10, criterios: { c1: { P: 50, n: 10, janela: [] } } };
    const char = { criterios: { c1: { D: 50, n_D: 10, beta: 1, historico: [] } } };
    const r = mmr.updateMatch(pop, char, {}, {
      criterios: { c1: 80 }, notaTotal: 80, fonte: 'selecao',
    });
    // D andou para baixo (aluno tirou nota alta contra a expectativa)
    expect(r.character.criterios.c1.D).not.toBe(50);
    // Este é o retorno do motor. Com peso 0 no admin, `registrarTriAnonimo`
    // (server/index.js) descarta `character` e `fontes` antes de gravar,
    // preservando o D antigo no banco. Com peso > 0, grava.
  });
});
