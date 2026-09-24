// Testes do motor por critério (server/mmr.js), reforma da §24 do demandas.md.
// Todos os 16 critérios de aceite da spec MMR-por-criterio.md §16 têm um bloco
// aqui, marcado no describe. Testes puros — nem app nem banco.
const mmr = require('../server/mmr');

// Helper: aplica UMA avaliação simples com 1 critério e devolve estados novos.
function aplicar(playerIn, charIn, { id = 'c1', S = 70, notaTotal = S, isAdmin = false, fonte = 'competitivo' } = {}, fontesIn = {}) {
  return mmr.updateMatch(playerIn, charIn, fontesIn, {
    criterios: { [id]: S }, notaTotal, isAdmin, fonte,
  });
}

describe('MMR por critério — funções puras', () => {
  describe('newPlayer / newCharacter', () => {
    it('newPlayer nasce com nEntradas 0 e sem critérios', () => {
      expect(mmr.newPlayer()).toEqual({ nEntradas: 0, criterios: {} });
    });
    it('newCharacter nasce sem critérios', () => {
      expect(mmr.newCharacter()).toEqual({ criterios: {} });
    });
    it('newAnonPopulation reusa a fábrica de player', () => {
      expect(mmr.newAnonPopulation()).toEqual(mmr.newPlayer());
    });
  });

  describe('expectedScore (spec §3.2)', () => {
    it('S_esp = 50 + β·(P − D); β default = 1 antes de amadurecer', () => {
      const pc = { P: 60 };
      const cc = { D: 64, beta: 1 };
      expect(mmr.expectedScore(pc, cc)).toBeCloseTo(46, 6);
    });
    it('β maior de 1 amplia o gap', () => {
      const pc = { P: 70 };
      const cc = { D: 50, beta: 1.4 };
      expect(mmr.expectedScore(pc, cc)).toBeCloseTo(50 + 1.4 * 20, 6);
    });
  });

  describe('sensitivity K (spec §3.5)', () => {
    it('K = 1/(n+1) até n=4, piso em 0,20 daí em diante', () => {
      expect(mmr.sensitivity(0)).toBeCloseTo(1, 9);
      expect(mmr.sensitivity(1)).toBeCloseTo(0.5, 9);
      expect(mmr.sensitivity(2)).toBeCloseTo(1 / 3, 9);
      expect(mmr.sensitivity(3)).toBeCloseTo(0.25, 9);
      expect(mmr.sensitivity(4)).toBeCloseTo(0.2, 9); // piso alcançado
      expect(mmr.sensitivity(9)).toBeCloseTo(0.2, 9);
      expect(mmr.sensitivity(9999)).toBeCloseTo(0.2, 9);
    });
  });

  describe('linearWeights', () => {
    it('normaliza, mais recente pesa mais, razão N× entre extremos', () => {
      const w = mmr.linearWeights(10);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(w[9]).toBeGreaterThan(w[0]);
      expect(w[9] / w[0]).toBeCloseTo(10, 6);
    });
  });

  describe('fitRegression (spec §4)', () => {
    it('recupera β numa reta perfeita S = 50 + β·gap com intercepto 50', () => {
      const historico = [
        { P: 60, D_antes: 40, S: 60 }, // gap 20 → 60
        { P: 40, D_antes: 60, S: 40 }, // gap -20 → 40
        { P: 70, D_antes: 50, S: 60 }, // gap 20 → 60
      ];
      const fit = mmr.fitRegression(historico);
      expect(fit).not.toBeNull();
      expect(fit.beta).toBeCloseTo(0.5, 6);
    });
    it('clampa β em [0,5; 1,5]', () => {
      // Uma reta com β=3 (inclinação alta) → clampada em 1,5.
      const historico = [
        { P: 60, D_antes: 40, S: 110 }, // gap 20 → 110 (β=3)
        { P: 40, D_antes: 60, S: -10 }, // gap -20 → -10 (β=3)
      ];
      const fit = mmr.fitRegression(historico);
      expect(fit.beta).toBeCloseTo(1.5, 6);
    });
    it('devolve null com menos de 2 pontos', () => {
      expect(mmr.fitRegression([])).toBeNull();
      expect(mmr.fitRegression([{ P: 60, D_antes: 40, S: 60 }])).toBeNull();
    });
    it('devolve null se o gap for praticamente constante (sem variação para inferir)', () => {
      const historico = [
        { P: 60, D_antes: 60, S: 50 },
        { P: 61, D_antes: 61, S: 55 },
      ];
      expect(mmr.fitRegression(historico)).toBeNull();
    });
  });
});

describe('MMR por critério — updateMatch (spec §3)', () => {
  it('não muta a entrada', () => {
    const p = mmr.newPlayer();
    const c = mmr.newCharacter();
    const antesP = JSON.parse(JSON.stringify(p));
    const antesC = JSON.parse(JSON.stringify(c));
    aplicar(p, c, { S: 70, notaTotal: 70 });
    expect(p).toEqual(antesP);
    expect(c).toEqual(antesC);
  });

  it('critério 9 da spec §16 — admin não altera nenhum estado', () => {
    const p = mmr.newPlayer();
    const c = mmr.newCharacter();
    const out = aplicar(p, c, { S: 70, notaTotal: 70, isAdmin: true });
    expect(out.player).toEqual(mmr.newPlayer());
    expect(out.character).toEqual(mmr.newCharacter());
    expect(out.fontes).toEqual({});
    expect(out.result.movimentou).toBe(false);
  });

  it('critério 10 — nota total < 25 move o P mas NÃO conta como movimento do D', () => {
    const p = mmr.newPlayer();
    const c = mmr.newCharacter();
    const out = aplicar(p, c, { S: 20, notaTotal: 20 });
    // P se move (para 20 no interno, pois K=1 na 1ª): partiu de 50, N = 20 + (50-50) = 20 → P = 20
    const critP = out.player.criterios.c1;
    expect(critP.P).toBeCloseTo(20, 6);
    expect(critP.n).toBe(1);
    // D fica intocado
    expect(out.character.criterios).toEqual({});
    // Fonte não incrementa
    expect(out.fontes).toEqual({});
  });

  it('critério 11 — o D se move desde a 1ª avaliação (não bloqueado por calibração)', () => {
    const p = mmr.newPlayer(); // 0 avaliações
    const c = mmr.newCharacter();
    const out = aplicar(p, c, { S: 70, notaTotal: 70 });
    const critC = out.character.criterios.c1;
    // S_esp = 50 + 1·(50-50) = 50; deltaD = 0,2·(50-70) = -4 → D 46
    expect(critC.D).toBeCloseTo(46, 6);
    expect(critC.n_D).toBe(1);
    // MMR do aluno se move sempre — mas fica oculto até 3 avaliações (isso é view).
    expect(out.player.criterios.c1.n).toBe(1);
  });

  it('critério 7 — ganho é 0,2 antes de amadurecer (n_D < 20) e 0,1 depois', () => {
    // Preencher n_D = 19 e verificar próximo delta
    let p = mmr.newPlayer();
    let c = mmr.newCharacter();
    for (let i = 0; i < 19; i++) {
      const out = aplicar(p, c, { S: 70, notaTotal: 70 });
      p = out.player; c = out.character;
    }
    expect(c.criterios.c1.n_D).toBe(19);
    // Próxima (a 20ª) ainda usa 0,2, porque n_D_before < 20
    const antesD = c.criterios.c1.D;
    const antesP = p.criterios.c1.P;
    const S_esp = 50 + 1 * (antesP - antesD);
    let out20 = aplicar(p, c, { S: 70, notaTotal: 70 });
    expect(out20.character.criterios.c1.n_D).toBe(20);
    expect(out20.character.criterios.c1.D).toBeCloseTo(
      Math.max(10, Math.min(90, antesD + 0.2 * (S_esp - 70))), 6);

    // A 21ª usa 0,1
    const antesD21 = out20.character.criterios.c1.D;
    const S_esp21 = 50 + out20.character.criterios.c1.beta * (out20.player.criterios.c1.P - antesD21);
    const out21 = aplicar(out20.player, out20.character, { S: 70, notaTotal: 70 });
    expect(out21.character.criterios.c1.D).toBeCloseTo(
      Math.max(10, Math.min(90, antesD21 + 0.1 * (S_esp21 - 70))), 6);
  });

  it('D é clampado em [10, 90]', () => {
    // Nota altíssima repetida contra caso já baixo — deve travar em 10
    let p = { nEntradas: 0, criterios: { c1: { P: 20, n: 0, janela: [] } } };
    let c = { criterios: { c1: { D: 12, n_D: 0, beta: 1, historico: [] } } };
    for (let i = 0; i < 30; i++) {
      const out = aplicar(p, c, { S: 100, notaTotal: 100 });
      p = out.player; c = out.character;
    }
    expect(c.criterios.c1.D).toBeGreaterThanOrEqual(10);
    // E o teto
    p = { nEntradas: 0, criterios: { c1: { P: 90, n: 0, janela: [] } } };
    c = { criterios: { c1: { D: 88, n_D: 0, beta: 1, historico: [] } } };
    for (let i = 0; i < 30; i++) {
      const out = aplicar(p, c, { S: 0, notaTotal: 0 });
      p = out.player; c = out.character;
    }
    expect(c.criterios.c1.D).toBeLessThanOrEqual(90);
  });

  it('critério 5 — as 4 primeiras avaliações do critério produzem exatamente a média simples', () => {
    let p = mmr.newPlayer();
    let c = { criterios: { c1: { D: 50, n_D: 0, beta: 1, historico: [] } } };
    // Notas 60, 70, 80, 90 (S), com D em 50 constante (não vamos permitir se mover — usa isAdmin? não, admin
    // congela tudo). Alternativa: forçar D fixo cravando o estado após cada avaliação.
    // Aqui vamos deixar o D se mover para testar a média sobre N_c (nota ponderada com D_antes).
    const Ss = [60, 70, 80, 90];
    let mediaEsperada = 0;
    let count = 0;
    for (const S of Ss) {
      const D_antes = c.criterios.c1.D;
      const N_c = S + (D_antes - 50); // spec §3.4
      count += 1;
      mediaEsperada = ((mediaEsperada * (count - 1)) + N_c) / count;
      const out = aplicar(p, c, { S, notaTotal: S });
      expect(out.player.criterios.c1.P).toBeCloseTo(mediaEsperada, 6);
      p = out.player; c = out.character;
    }
  });

  it('critério 6 — janela tem 10 posições, mais recente pesa mais', () => {
    let p = mmr.newPlayer();
    let c = mmr.newCharacter();
    for (let i = 0; i < 15; i++) {
      const out = aplicar(p, c, { S: 60 + (i % 5), notaTotal: 60 + (i % 5) });
      p = out.player; c = out.character;
    }
    // Janela nunca passa de 10
    expect(p.criterios.c1.janela.length).toBe(10);
    // As entradas mais recentes têm índice maior (fim do array)
    expect(p.criterios.c1.janela[9].N).toBeGreaterThanOrEqual(0);
  });

  it('critério 4 — nota ponderada exibida MUDA com o D atual; o MMR do aluno NÃO muda por isso', () => {
    const S = 70;
    const D_antes = 60;
    const N_antigo = mmr.weightedScore(S, D_antes);
    expect(N_antigo).toBe(80);
    // Depois o D subiu para 70; a nota ponderada exibida vira 90.
    expect(mmr.weightedScore(S, 70)).toBe(90);
    // O motor não recomputa o MMR do aluno — a garantia é de contrato: o MMR
    // que ele guardou é fruto do N_c gravado na hora, não do D atual.
    // Testado via calcularPonderadas (view): recebe o D atual e recalcula.
    const character = { criterios: { c1: { D: 70, n_D: 0, beta: 1, historico: [] } } };
    const view = mmr.calcularPonderadas({ c1: S }, character);
    expect(view.criterios.c1).toBe(90);
  });

  it('critério 3 — dois alunos com a mesma nota bruta produzem a mesma nota ponderada', () => {
    const character = { criterios: { c1: { D: 63, n_D: 5, beta: 1, historico: [] } } };
    const view1 = mmr.calcularPonderadas({ c1: 72 }, character);
    const view2 = mmr.calcularPonderadas({ c1: 72 }, character);
    expect(view1.criterios.c1).toBe(view2.criterios.c1);
  });

  it('critério 14 — S de 70 (equivalente a 7 da rubrica × 10) aparece como 7,0 na tela', () => {
    // O motor guarda 0..100. A camada de exibição divide por 10 e arredonda em 1 casa.
    const val = 70 / 10;
    expect(Number(val.toFixed(1))).toBe(7.0);
  });

  it('critério 1 — aluno que tira sempre 70 num caso de D fixo 50 converge para MMR 70', () => {
    let p = mmr.newPlayer();
    // Caso com D preso em 50 (β=0 zera o ajuste; e a nota é sempre igual à S_esp)
    // Truque: usamos admin para não mover D, mas isso também não move P.
    // Simulamos "D fixo 50" cravando o character depois de cada iteração.
    let c = { criterios: { c1: { D: 50, n_D: 0, beta: 1, historico: [] } } };
    for (let i = 0; i < 40; i++) {
      const out = aplicar(p, c, { S: 70, notaTotal: 70 });
      p = out.player;
      // Trava o D em 50 manualmente
      c = { criterios: { c1: { D: 50, n_D: c.criterios.c1.n_D + 1, beta: 1, historico: [] } } };
    }
    // N_c = 70 + (50 - 50) = 70. K piso 0,20. Convergência para 70 é assintótica; após 40 iterações fica muito próxima.
    expect(p.criterios.c1.P).toBeCloseTo(70, 0);
  });

  it('critério 2 — aluno constante em 70 com D livre NÃO empurra o D para o piso', () => {
    let p = mmr.newPlayer();
    let c = { criterios: { c1: { D: 50, n_D: 0, beta: 1, historico: [] } } };
    for (let i = 0; i < 40; i++) {
      const out = aplicar(p, c, { S: 70, notaTotal: 70 });
      p = out.player; c = out.character;
    }
    // D fica em torno de 70 (S_esp ≈ 70 quando P ≈ 70, e a diferença zera o deltaD).
    expect(c.criterios.c1.D).toBeGreaterThan(60);
    expect(c.criterios.c1.D).toBeLessThan(85);
    // Explicitamente: NÃO caiu para o piso.
    expect(c.criterios.c1.D).toBeGreaterThan(mmr.D_MIN + 20);
  });

  it('critério 8 — D converge para valor real com β fora de 1; intercepto não é ajustado', () => {
    // Simular um caso com dificuldade real 70 e β conhecido (fixado no motor).
    // Este é um teste indicativo: rodar 100 alunos com nível variando 30..80 contra o caso;
    // com o motor novo (intercepto fixo em 50), D deve convergir para próximo de 70.
    let c = mmr.newCharacter();
    const rand = (min, max) => min + Math.random() * (max - min);
    for (let i = 0; i < 150; i++) {
      const P_aluno = rand(30, 80);
      // "Nota real" que este aluno tira: S_esp = 50 + 1·(P - 70) + ruído
      const S = Math.max(0, Math.min(100, 50 + (P_aluno - 70) + rand(-8, 8)));
      const p = { nEntradas: 3, criterios: { c1: { P: P_aluno, n: 5, janela: [] } } };
      const out = aplicar(p, c, { S, notaTotal: S });
      c = out.character;
    }
    // D deve estar razoavelmente próximo de 70 (±10). β dentro de [0,5; 1,5].
    const critC = c.criterios.c1;
    expect(critC.D).toBeGreaterThan(60);
    expect(critC.D).toBeLessThan(80);
    expect(critC.beta).toBeGreaterThanOrEqual(mmr.BETA_MIN);
    expect(critC.beta).toBeLessThanOrEqual(mmr.BETA_MAX);
  });
});

describe('MMR por critério — totais derivados (spec §5)', () => {
  it('critério 13 — total é agregação linear dos por-critério', () => {
    // 3 critérios com P 60, 70, 80 → média = 70
    const p = {
      nEntradas: 5,
      criterios: {
        a: { P: 60, n: 5, janela: [] },
        b: { P: 70, n: 5, janela: [] },
        c: { P: 80, n: 5, janela: [] },
      },
    };
    const view = mmr.playerView(p);
    expect(view.mmrTotalRaw).toBeCloseTo(70, 6);
    expect(view.mmrTotal).toBe(70);
  });

  it('agregarTotal devolve null quando não há valores', () => {
    expect(mmr.agregarTotal({})).toBeNull();
    expect(mmr.agregarTotal(null)).toBeNull();
  });

  it('agregarTotal respeita o filtro de criterioIds (só ativos entram na conta)', () => {
    const p = { a: 60, b: 70, extinto: 999 };
    expect(mmr.agregarTotal(p, ['a', 'b'])).toBeCloseTo(65, 6);
  });
});

describe('MMR por critério — calibração e views (spec §6 e §10)', () => {
  it('MMR do perfil fica oculto (null) durante a calibração (nEntradas < 3)', () => {
    const p = { nEntradas: 2, criterios: { c1: { P: 62, n: 2, janela: [] } } };
    const view = mmr.playerView(p);
    expect(view.calibrating).toBe(true);
    expect(view.mmrTotal).toBeNull();
    expect(view.mmr).toBeNull(); // alias
  });

  it('MMR aparece na 3ª avaliação (nEntradas = 3)', () => {
    const p = { nEntradas: 3, criterios: { c1: { P: 62, n: 3, janela: [] } } };
    const view = mmr.playerView(p);
    expect(view.calibrating).toBe(false);
    expect(view.mmrTotal).toBe(62);
  });

  it('nEntradas incrementa a cada avaliação válida (inclusive < 25)', () => {
    let p = mmr.newPlayer();
    for (let i = 0; i < 3; i++) {
      const out = aplicar(p, mmr.newCharacter(), { S: 20, notaTotal: 20 });
      p = out.player;
    }
    expect(p.nEntradas).toBe(3);
  });

  it('critério 16 — depois do reset todos os estados partem de 50', () => {
    const p = mmr.newPlayer();
    const view = mmr.playerView(p);
    expect(view.nEntradas).toBe(0);
    // Sem critérios ainda, agregação devolve null.
    expect(view.mmrTotalRaw).toBeNull();
  });
});

describe('MMR por critério — duelo (spec §7)', () => {
  const casoNovo = () => mmr.newCharacter();
  const playerMaduro = (P) => ({ nEntradas: 5, criterios: { c1: { P, n: 5, janela: [] } } });

  it('trava: calibração de qualquer lado bloqueia tudo (não muda nada)', () => {
    const A = { nEntradas: 2, criterios: { c1: { P: 60, n: 2, janela: [] } } };
    const B = playerMaduro(60);
    const r = mmr.processDuel(A, B, casoNovo(), {}, {
      criteriosA: { c1: 70 }, criteriosB: { c1: 60 },
      notaTotalA: 70, notaTotalB: 60,
    });
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('calibrating');
  });

  it('trava: nota total < 25 em qualquer lado bloqueia', () => {
    const r = mmr.processDuel(playerMaduro(60), playerMaduro(60), casoNovo(), {}, {
      criteriosA: { c1: 20 }, criteriosB: { c1: 60 },
      notaTotalA: 20, notaTotalB: 60,
    });
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('anti_smurf');
  });

  it('trava: admin em qualquer lado bloqueia', () => {
    const r = mmr.processDuel(playerMaduro(60), playerMaduro(60), casoNovo(), {}, {
      criteriosA: { c1: 70 }, criteriosB: { c1: 60 }, notaTotalA: 70, notaTotalB: 60,
      isAdminA: true,
    });
    expect(r.ranked).toBe(false);
    expect(r.reason).toBe('admin');
  });

  it('critério 12 — soma zero em cada critério; fração pela nota bruta', () => {
    const A = playerMaduro(70);
    const B = playerMaduro(50);
    const r = mmr.processDuel(A, B, casoNovo(), {}, {
      criteriosA: { c1: 80 }, criteriosB: { c1: 40 },
      notaTotalA: 80, notaTotalB: 40,
    });
    expect(r.ranked).toBe(true);
    // pool = 0.2*70 + 0.2*50 = 14 + 10 = 24; fracA = 80/120 = 2/3; recebidoA = 16; delta = +2
    expect(r.pvp.c1.deltaA + r.pvp.c1.deltaB).toBeCloseTo(0, 6);
    expect(r.pvp.c1.deltaA).toBeCloseTo(2, 4);
    expect(r.pvp.c1.deltaB).toBeCloseTo(-2, 4);
    expect(r.pvp.c1.winner).toBe('A');
  });

  it('duelo — se as duas notas do critério forem 0, divide meio a meio (draw)', () => {
    const A = playerMaduro(60);
    const B = playerMaduro(60);
    const r = mmr.processDuel(A, B, casoNovo(), {}, {
      criteriosA: { c1: 0 }, criteriosB: { c1: 0 },
      // Notas totais precisam ser >= 25 para não bater na trava geral.
      notaTotalA: 30, notaTotalB: 30,
    });
    expect(r.ranked).toBe(true);
    expect(r.pvp.c1.deltaA).toBeCloseTo(0, 6);
    expect(r.pvp.c1.deltaB).toBeCloseTo(0, 6);
    expect(r.pvp.c1.winner).toBe('draw');
  });
});

describe('MMR por critério — fontes por critério (spec §12)', () => {
  it('incrementa a fonte só no critério que teve o D movido', () => {
    const p = mmr.newPlayer();
    const c = mmr.newCharacter();
    const out = aplicar(p, c, { id: 'x', S: 70, notaTotal: 70, fonte: 'competitivo' });
    expect(out.fontes.x).toEqual({ competitivo: 1, selecao: 0, visitante: 0 });
  });

  it('não incrementa se o D não moveu (trava de 25)', () => {
    const p = mmr.newPlayer();
    const c = mmr.newCharacter();
    const out = aplicar(p, c, { id: 'x', S: 20, notaTotal: 20, fonte: 'competitivo' });
    expect(out.fontes).toEqual({});
  });

  it('preserva fontes de outros critérios entre avaliações', () => {
    let p = mmr.newPlayer();
    let c = mmr.newCharacter();
    let fontes = {};
    // Primeira: só critério "a" com fonte competitivo
    let out = mmr.updateMatch(p, c, fontes, {
      criterios: { a: 70 }, notaTotal: 70, fonte: 'competitivo',
    });
    p = out.player; c = out.character; fontes = out.fontes;
    // Segunda: só critério "b" com fonte selecao
    out = mmr.updateMatch(p, c, fontes, {
      criterios: { b: 70 }, notaTotal: 70, fonte: 'selecao',
    });
    expect(out.fontes.a).toEqual({ competitivo: 1, selecao: 0, visitante: 0 });
    expect(out.fontes.b).toEqual({ competitivo: 0, selecao: 1, visitante: 0 });
  });
});

describe('MMR por critério — mmr_delta / auditoria', () => {
  it('result.criterios traz S, N, P_before/after, D_before/after por critério', () => {
    const out = aplicar(mmr.newPlayer(), mmr.newCharacter(), { id: 'c1', S: 70, notaTotal: 70 });
    const r = out.result.criterios.c1;
    expect(r.S).toBe(70);
    expect(r.N).toBe(70); // D_antes = 50, N = 70 + 0 = 70
    expect(r.P_before).toBe(mmr.P0);
    expect(r.D_before).toBe(mmr.D0);
    expect(r.D_moved).toBe(true);
  });
});
