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

// O motor por trás da regra "peso 0 = desligado". A rota que grava está em
// registrarTriAnonimo (server/index.js); aqui fica a garantia de que o engine
// não mexe no D quando o ganho é zero — e de que ele MEXERIA se o peso subisse.
describe('peso 0 no motor do TRI', () => {
  const mmr = require('../server/mmr');

  function partida(dWeight) {
    // População fora da calibração: com n < 3 o D nem seria tocado, e o teste
    // não distinguiria "peso 0" de "ainda calibrando".
    const pop = { P: 50, n: 10, W: [{ S_aj: 50, D: 50, P: 50 }] };
    const char = { D: 50, n_D: 10, alpha: null, beta: null, history: [] };
    return mmr.updateMatch(pop, char, 20, { dWeight });
  }

  it('com peso 0 a dificuldade não anda', () => {
    const r = partida(0);
    expect(r.result.D_after).toBe(r.result.D_before);
  });

  it('com peso 0,35 a dificuldade anda', () => {
    const r = partida(0.35);
    expect(r.result.D_after).toBeGreaterThan(r.result.D_before);
  });

  // É por isso que registrarTriAnonimo não devolve o personagem quando o peso é
  // 0: o engine ainda incrementa n_D e empilha o ponto da regressão, então
  // gravá-lo deixaria a população moldando o D por outro caminho.
  it('mesmo com peso 0 o engine conta a partida no personagem — por isso ele não é gravado', () => {
    const r = partida(0);
    expect(r.character.n_D).toBe(11);
    expect(r.character.history).toHaveLength(1);
  });

  it('o rating da população aprende mesmo com peso 0', () => {
    const r = partida(0);
    expect(r.result.P_after).not.toBe(r.result.P_before);
  });
});
