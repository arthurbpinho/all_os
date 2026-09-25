// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');
const criteriosMd = require('../server/criterios-md');
const LIMITES = require('../server/limites-criterios');

// Desativar critério (demandas.md §23). O critério sai do arquivo da régua e das
// próximas avaliações, mas a linha em `criterios` fica com ativo = false: nome,
// histórico e nomes anteriores continuam, então as notas já dadas seguem
// casando no gráfico do perfil, que junta critério pelo NOME.

function reguaCom(nomes) {
  const blocos = nomes.map((n, i) => `## ${i + 1} · ${n}\n\nDescrição de ${n}.`).join('\n\n');
  const linhas = nomes.map((n, i) => `${i + 1}. **${n}**: linha curta de ${n}.`).join('\n');
  return `# Régua de teste · Os ${nomes.length} critérios\n\n## Como usar\n\nTexto qualquer.\n\n---\n\n${blocos}\n\n---\n\n## Linha curta de cada critério\n\n${linhas}\n`;
}

const CINCO = ['Alfa', 'Beta', 'Gama', 'Delta', 'Épsilon'];

describe('removerCriterio (server/criterios-md.js)', () => {
  it('tira o critério e renumera os que sobram', () => {
    const r = criteriosMd.removerCriterio(reguaCom(CINCO), 3);
    expect(r.ok).toBe(true);
    expect(r.removido.nome).toBe('Gama');
    expect(criteriosMd.lerCriterios(r.raw).map((c) => `${c.num}·${c.nome}`))
      .toEqual(['1·Alfa', '2·Beta', '3·Delta', '4·Épsilon']);
  });

  it('a linha curta do removido sai junto, e as outras acompanham a numeração', () => {
    const r = criteriosMd.removerCriterio(reguaCom(CINCO), 2);
    expect(r.raw).not.toContain('**Beta**');
    expect(r.raw).toContain('2. **Gama**');
    expect(r.raw).toContain('4. **Épsilon**');
  });

  it('o título acompanha a contagem', () => {
    const r = criteriosMd.removerCriterio(reguaCom(CINCO), 1);
    expect(r.raw.split('\n')[0]).toContain('Os 4 critérios');
  });

  it('remover o primeiro e o último também funciona', () => {
    expect(criteriosMd.lerCriterios(criteriosMd.removerCriterio(reguaCom(CINCO), 1).raw).map((c) => c.nome))
      .toEqual(['Beta', 'Gama', 'Delta', 'Épsilon']);
    expect(criteriosMd.lerCriterios(criteriosMd.removerCriterio(reguaCom(CINCO), 5).raw).map((c) => c.nome))
      .toEqual(['Alfa', 'Beta', 'Gama', 'Delta']);
  });

  // Menos que o mínimo não faz radar nem avaliação que valha (limites-criterios.js).
  it('recusa quando a régua está no mínimo', () => {
    const minima = reguaCom(CINCO.slice(0, LIMITES.min));
    const r = criteriosMd.removerCriterio(minima, 1);
    expect(r.ok).toBe(false);
    expect(r.erro).toContain(String(LIMITES.min));
  });

  it('critério inexistente devolve naoExiste', () => {
    const r = criteriosMd.removerCriterio(reguaCom(CINCO), 99);
    expect(r.ok).toBe(false);
    expect(r.naoExiste).toBe(true);
  });

  // Nome do admin pode ter caracteres de RegExp; o módulo escapa antes de montar
  // os padrões de renumeração.
  it('nome com caractere especial não quebra a renumeração', () => {
    const nomes = ['Alfa (a)', 'Beta [b]', 'Gama.', 'Delta+', 'Épsilon?'];
    const r = criteriosMd.removerCriterio(reguaCom(nomes), 2);
    expect(r.ok).toBe(true);
    expect(criteriosMd.lerCriterios(r.raw).map((c) => `${c.num}·${c.nome}`))
      .toEqual(['1·Alfa (a)', '2·Gama.', '3·Delta+', '4·Épsilon?']);
  });
});

describe('DELETE /api/admin/criterios/:num', () => {
  beforeEach(() => resetData());

  it('só admin desativa', async () => {
    const aluno = await loginAs('aluno');
    const r = await request(app).delete('/api/admin/criterios/8').set(authHeader(aluno));
    expect(r.status).toBe(403);
  });

  it('o critério sai da régua ativa mas a linha continua no banco, inativa', async () => {
    const admin = await loginAs('admin');
    const antes = await request(app).get('/api/admin/criterios').set(authHeader(admin));
    const alvo = antes.body.criterios[antes.body.criterios.length - 1];

    const r = await request(app).delete(`/api/admin/criterios/${alvo.num}`).set(authHeader(admin));
    expect(r.status).toBe(200);
    expect(r.body.removido.nome).toBe(alvo.nome);
    // A régua que o painel mostra perdeu um critério...
    expect(r.body.criterios).toHaveLength(antes.body.criterios.length - 1);
    expect(r.body.criterios.map((c) => c.nome)).not.toContain(alvo.nome);

    // ...mas a LINHA continua no banco, inativa. É o que preserva o histórico:
    // o gráfico do perfil junta critério pelo nome, então as notas já dadas
    // continuam encontrando a identidade delas.
    const { rows } = await db.query(
      'SELECT nome, ativo FROM criterios WHERE lower(nome) = lower($1)', [alvo.nome],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ativo).toBe(false);
  });

  it('repor com o mesmo nome reativa a MESMA linha, com o histórico junto', async () => {
    const admin = await loginAs('admin');
    const antes = await request(app).get('/api/admin/criterios').set(authHeader(admin));
    const alvo = antes.body.criterios[antes.body.criterios.length - 1];
    const idAntes = (await db.query('SELECT id FROM criterios WHERE lower(nome) = lower($1)', [alvo.nome])).rows[0].id;

    await request(app).delete(`/api/admin/criterios/${alvo.num}`).set(authHeader(admin));
    const voltou = await request(app).post('/api/admin/criterios').set(authHeader(admin)).send({
      nome: alvo.nome, linhaCurta: alvo.linhaCurta, descricao: 'Descrição reposta.',
    });
    expect(voltou.status).toBe(200);

    const { rows } = await db.query('SELECT id, ativo FROM criterios WHERE lower(nome) = lower($1)', [alvo.nome]);
    expect(rows).toHaveLength(1);          // não nasceu uma linha nova
    expect(String(rows[0].id)).toBe(String(idAntes));
    expect(rows[0].ativo).toBe(true);
  });

  it('critério inexistente devolve 404', async () => {
    const admin = await loginAs('admin');
    const r = await request(app).delete('/api/admin/criterios/99').set(authHeader(admin));
    expect(r.status).toBe(404);
  });
});
