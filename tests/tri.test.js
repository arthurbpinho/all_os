// TRI — dificuldade dos personagens, alimentada por TODAS as fontes juntas:
// competitivo (alunos com MMR próprio), processo seletivo e visitante.
//
// A propriedade central do sistema é a justiça: respondentes de níveis
// diferentes devem convergir para a MESMA estimativa de dificuldade. Quem não
// tem conta (candidato, visitante) entra como uma "população" — um jogador
// persistente que começa em 50 e aprende o nível real do grupo.
const { app, request, resetData, loginAs, loginVisitor, authHeader, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');
const mmr = require('../server/mmr');

describe('TRI — engine: peso do ajuste de dificuldade', () => {
  // Jogador fora da calibração, senão o engine nem toca no D.
  const veterano = () => ({ P: 50, n: 10, W: [{ S_aj: 50, D: 50, P: 50 }] });

  it('dWeight escala o passo do D sem mudar a direção', () => {
    const cheio = mmr.updateMatch(veterano(), undefined, 20);
    const parcial = mmr.updateMatch(veterano(), undefined, 20, { dWeight: 0.35 });

    const dCheio = cheio.character.D - mmr.D0;
    const dParcial = parcial.character.D - mmr.D0;

    expect(dCheio).toBeGreaterThan(0);            // nota baixa → mais difícil
    expect(dParcial).toBeGreaterThan(0);          // mesma direção
    expect(dParcial).toBeLessThan(dCheio);        // passo menor
    expect(dParcial).toBeCloseTo(dCheio * 0.35, 6);
  });

  it('dWeight ausente equivale a peso 1 (competitivo inalterado)', () => {
    const semOpts = mmr.updateMatch(veterano(), undefined, 20);
    const comUm = mmr.updateMatch(veterano(), undefined, 20, { dWeight: 1 });
    expect(semOpts.character.D).toBe(comUm.character.D);
  });

  it('população anônima nasce como jogador comum em 50', () => {
    const pop = mmr.newAnonPopulation();
    expect(pop.P).toBe(mmr.P0);
    expect(pop.n).toBe(0);
  });

  // O motivo de a população ser um jogador que APRENDE, e não um rating fixo:
  // se o grupo é mais fraco, o rating dele cai e o sistema para de confundir
  // "respondente fraco" com "personagem difícil".
  it('população fraca converge para rating abaixo de 50', () => {
    let pop = mmr.newAnonPopulation();
    let char;
    for (let i = 0; i < 40; i++) {
      const out = mmr.updateMatch(pop, char, 25, { dWeight: 0.35 });
      pop = out.player;
      char = out.character;
    }
    expect(pop.P).toBeLessThan(mmr.P0);
  });

  // ESTA é a razão de as fontes ficarem juntas, e é a propriedade que o
  // sistema de fato entrega: a ORDENAÇÃO de dificuldade é recuperada mesmo
  // com grupos de níveis muito diferentes atendendo os mesmos personagens.
  //
  // Sobre a escala: este engine ancora o rating em 50 (P converge para a média
  // dos S_aj, que é recentrada em 50 a cada partida). Consequência prática — o
  // D estimado é COMPRIMIDO em relação à dificuldade real e os ratings dos
  // grupos separam pouco em valor absoluto. Isso já valia para o competitivo;
  // não veio da unificação. Por isso a tela apresenta o número como
  // comparação ENTRE casos, e não como medida absoluta.
  it('recupera a ordem de dificuldade com grupos de níveis opostos', () => {
    const REAL = { facil: 35, medio: 55, dificil: 75 };
    // A nota sai do próprio modelo do engine, com o nível REAL do grupo: é
    // assim que se simula "cada um atende de acordo com o que sabe".
    const nota = (nivel, dReal) => mmr.clamp(50 + 0.5 * (nivel - dReal), 0, 100);

    const chars = { facil: undefined, medio: undefined, dificil: undefined };
    let fortes = mmr.newAnonPopulation();   // alunos treinados
    let fracos = mmr.newAnonPopulation();   // candidatos do seletivo

    for (let i = 0; i < 300; i++) {
      for (const k of Object.keys(REAL)) {
        let o = mmr.updateMatch(fortes, chars[k], nota(80, REAL[k]), { dWeight: 1 });
        fortes = o.player; chars[k] = o.character;
        o = mmr.updateMatch(fracos, chars[k], nota(30, REAL[k]), { dWeight: 0.35 });
        fracos = o.player; chars[k] = o.character;
      }
    }

    // O grupo mais forte fica acima do mais fraco (separação existe)...
    expect(fortes.P).toBeGreaterThan(fracos.P);
    // ...e a ordem de dificuldade dos personagens é a verdadeira.
    expect(chars.dificil.D).toBeGreaterThan(chars.medio.D);
    expect(chars.medio.D).toBeGreaterThan(chars.facil.D);
  });

  it('characterAvgScore devolve a média das notas registradas', () => {
    let char;
    let pop = { P: 50, n: 10, W: [{ S_aj: 50, D: 50, P: 50 }] };
    for (const nota of [40, 60, 80]) {
      const out = mmr.updateMatch(pop, char, nota);
      pop = out.player; char = out.character;
    }
    expect(Math.round(mmr.characterAvgScore(char))).toBe(60);
    expect(mmr.characterAvgScore(mmr.newCharacter())).toBeNull();
  });
});

describe('TRI — dificuldade compartilhada entre as fontes', () => {
  beforeEach(() => resetData());

  const arquivo = () => path.join(DATA_DIR, 'mmr.json');
  const lerMmr = () => JSON.parse(fs.readFileSync(arquivo(), 'utf-8'));
  function escreverMmr(data) {
    fs.writeFileSync(arquivo(), JSON.stringify(data, null, 2));
  }

  // Semeia um personagem já com dificuldade e uma população já calibrada,
  // simulando um sistema em uso. A suite roda em modo demo (sem chaves de IA),
  // então a avaliação do seletivo não fecha ponta a ponta aqui.
  function semear({ D = 50, n_D = 0, popN = 10 } = {}) {
    escreverMmr({
      players: {},
      characters: { 'fp-test-1': { D, n_D, alpha: null, beta: null, history: [] } },
      anonPlayers: { selecao: { P: 50, n: popN, W: [{ S_aj: 50, D: 50, P: 50 }] } },
      charSources: {},
    });
  }

  it('o seletivo escreve na MESMA dificuldade que o competitivo lê', async () => {
    semear({ D: 50, n_D: 5 });
    const antes = lerMmr().characters['fp-test-1'].D;

    // Simula o efeito de um atendimento de candidato com nota baixa.
    const atual = lerMmr();
    const out = mmr.updateMatch(
      atual.anonPlayers.selecao, atual.characters['fp-test-1'], 20, { dWeight: 0.35 },
    );
    atual.characters['fp-test-1'] = out.character;
    atual.anonPlayers.selecao = out.player;
    escreverMmr(atual);

    const admin = await loginAs('admin');
    const res = await request(app).get('/api/tri/personagens').set(authHeader(admin));
    const c = res.body.characters.find((x) => x.id === 'fp-test-1');

    // Não há pool separada: o número exposto é o do mmr.json compartilhado.
    expect(c.difficulty).toBe(Math.round(lerMmr().characters['fp-test-1'].D));
    expect(lerMmr().characters['fp-test-1'].D).toBeGreaterThan(antes);
  });

  it('personagem sem atendimento sai na baseline', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/tri/personagens').set(authHeader(admin));
    expect(res.status).toBe(200);
    expect(res.body.baseline).toBe(50);
    expect(res.body.ratingInicial).toBe(50);
    const c = res.body.characters.find((x) => x.id === 'fp-test-1');
    expect(c.difficulty).toBe(50);
    expect(c.n).toBe(0);
    expect(c.madura).toBe(false);
  });

  it('ordena do mais difícil pro mais fácil, com os sem dado no fim', async () => {
    semear({ D: 72, n_D: 8 });
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/tri/personagens').set(authHeader(admin));
    expect(res.body.characters[0].id).toBe('fp-test-1');
    expect(res.body.characters[0].difficulty).toBe(72);
    expect(res.body.characters[0].delta).toBe(22);
    expect(res.body.totalAtendimentos).toBe(8);
  });

  it('expõe o rating aprendido de cada população anônima', async () => {
    semear({ popN: 10 });
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/tri/personagens').set(authHeader(admin));

    const sel = res.body.populacoes.find((p) => p.pool === 'selecao');
    expect(sel.n).toBe(10);
    expect(sel.calibrando).toBe(false);
    expect(sel.peso).toBeLessThan(1); // seletivo pesa menos que aluno real

    // A pool do visitante existe mesmo antes de a avaliação ser ligada.
    const vis = res.body.populacoes.find((p) => p.pool === 'visitante');
    expect(vis.n).toBe(0);
    expect(vis.calibrando).toBe(true);
  });

  it('restrito a avaliador e admin', async () => {
    for (const quem of ['aluno', 'prof']) {
      const token = await loginAs(quem);
      const res = await request(app).get('/api/tri/personagens').set(authHeader(token));
      expect(res.status).toBe(403);
    }
    const visitante = await loginVisitor();
    const res = await request(app).get('/api/tri/personagens').set(authHeader(visitante));
    expect(res.status).toBe(403);
  });
});
