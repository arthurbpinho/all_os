// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');

// POST /api/logs grava os NOMES dos critérios junto com as notas.
//
// Antes, só o avaliador oficial (v34) os gravava; os outros caminhos mandavam
// só os números e a tela caía numa lista FIXA do cliente (labelsForCriteria).
// Enquanto a régua tinha os 8 nomes de sempre isso passava despercebido — mas
// com "Adicionar critério" (demandas.md §16.6) o admin renomeia, e a tela da
// sessão mostraria o nome antigo enquanto o Perfil, que resolve pela régua,
// mostraria o novo.

// Bloco que o avaliador de texto emite: as notas por critério no fim do feedback.
function comNotas(notas) {
  return `Devolutiva do atendimento.\n\n[notas-supervisor]\n${JSON.stringify(notas)}`;
}
const OITO = { 1: 8, 2: 7, 3: 9, 4: 8, 5: 6, 6: 7, 7: 7, 8: 5 };

describe('POST /api/logs — nomes dos critérios', () => {
  beforeEach(() => resetData());

  async function criar(body) {
    const aluno = await loginAs('aluno');
    const r = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      itemId: 'fp-test-1', itemTitle: 'Sofia Test', durationSeconds: 60,
      messages: [{ role: 'user', content: 'oi' }],
      ...body,
    });
    expect(r.status).toBe(200);
    return r.body;
  }

  it('carimba os nomes da régua quando as notas vêm do bloco de texto', async () => {
    const log = await criar({ type: 'freeplay', mode: 'training', evaluation: comNotas(OITO) });
    expect(log.criteriaScores['1']).toBe(8);
    expect(Object.keys(log.criteriaNames)).toHaveLength(8);
    // Os nomes vêm da régua no banco, não de uma lista escrita no código.
    for (const nome of Object.values(log.criteriaNames)) {
      expect(typeof nome).toBe('string');
      expect(nome.trim()).not.toBe('');
    }
  });

  // Neuro roda a régua própria do v18.25, e a Trilha tem critérios próprios:
  // carimbar os nomes do v34 neles trocaria um rótulo errado por outro.
  it('NÃO carimba em neuro', async () => {
    const log = await criar({ type: 'neuro', itemId: 'nr-test-1', evaluation: comNotas(OITO) });
    expect(log.criteriaScores).toBeTruthy();
    expect(log.criteriaNames == null).toBe(true);
  });

  // Melhor ficar sem nome (e cair no fallback de hoje) do que somar a nota de um
  // critério ao nome de outro. Mesma regra de server/criterios-perfil.js.
  it('NÃO carimba quando os números não batem com a régua', async () => {
    const log = await criar({
      type: 'freeplay', mode: 'training',
      evaluation: comNotas({ 1: 8, 2: 7, 3: 9, 4: 8, 5: 6, 6: 7 }), // 6, não 8
    });
    expect(Object.keys(log.criteriaScores)).toHaveLength(6);
    expect(log.criteriaNames == null).toBe(true);
  });

  it('log sem notas por critério não ganha nomes', async () => {
    const log = await criar({ type: 'freeplay', mode: 'training', evaluation: 'Só o texto.' });
    expect(log.criteriaNames == null).toBe(true);
  });

  it('os nomes sobrevivem à releitura do log pelo aluno', async () => {
    const aluno = await loginAs('aluno');
    const criado = await request(app).post('/api/logs').set(authHeader(aluno)).send({
      type: 'freeplay', mode: 'training', itemId: 'fp-test-1', itemTitle: 'Sofia Test',
      durationSeconds: 60, messages: [{ role: 'user', content: 'oi' }],
      evaluation: comNotas(OITO),
    });
    const meus = await request(app).get('/api/logs').set(authHeader(aluno));
    const meu = meus.body.find((l) => l.id === criado.body.id);
    expect(Object.keys(meu.criteriaNames)).toHaveLength(8);
  });
});
