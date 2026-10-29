// Modelos de IA por categoria (Administração → Modelos de IA).
//
// O que estes testes protegem, além do CRUD:
//   1. ligar a tela não muda comportamento nenhum — categoria sem escolha
//      continua no modelo/effort das envs de sempre (fonte 'padrao');
//   2. só há presets OpenAI (Anthropic e GLM saíram em 2026-10), e uma escolha
//      antiga de GLM/Claude guardada no banco cai no padrão em vez de quebrar;
//   3. batch nunca aparece onde alguém está esperando a nota na tela;
//   4. a Trilha não entra aqui (tem controle próprio, por exercício).

const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');
const aiModels = require('../server/ai-models');

function cat(body, key) {
  return body.categorias.find((c) => c.key === key);
}

describe('Modelos de IA por categoria (/api/admin/ai-models)', () => {
  beforeEach(() => resetData());

  it('exige autenticação e é admin-only', async () => {
    expect((await request(app).get('/api/admin/ai-models')).status).toBe(401);

    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/admin/ai-models').set(authHeader(aluno))).status).toBe(403);

    const prof = await loginAs('prof');
    expect((await request(app).get('/api/admin/ai-models').set(authHeader(prof))).status).toBe(403);

    const visitante = await loginVisitor();
    expect((await request(app).get('/api/admin/ai-models').set(authHeader(visitante))).status).toBe(403);
  });

  it('PUT também é admin-only', async () => {
    const aluno = await loginAs('aluno');
    const res = await request(app).put('/api/admin/ai-models').set(authHeader(aluno))
      .send({ categoria: 'competitivo', evaluator: 'gpt-5.5' });
    expect(res.status).toBe(403);
  });

  it('sem escolha nenhuma, toda categoria roda o padrão do sistema', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    expect(res.status).toBe(200);

    for (const c of res.body.categorias) {
      expect(c.avaliador.fonte).toBe('padrao');
      expect(c.avaliador.model).toBeTruthy();
      expect(c.avaliador.effort).toBeTruthy();
      if (c.temPaciente) expect(c.paciente.fonte).toBe('padrao');
    }
    // Os padrões de hoje. As SEIS categorias do AVALIADOR OFICIAL (v34) rodam no
    // mesmo modelo e no mesmo effort — e isso não é economia de configuração:
    // nota de modos diferentes é comparada no ranking e no MMR, e duas réguas
    // iguais em modelos diferentes não produzem números comparáveis. O Duelo foi
    // o último a entrar, quando saiu do avaliador comparativo próprio.
    for (const categoria of ['treinamento', 'competitivo', 'seletivo', 'visitante', 'avaliacaoManual', 'duelo']) {
      expect(cat(res.body, categoria).avaliador.model).toBe('gpt-5.6-luna');
      expect(cat(res.body, categoria).avaliador.effort).toBe('high');
    }
    // O Neuro é o único fora do pipeline, com grade própria — e o único cujo
    // avaliador tem outro padrão.
    expect(cat(res.body, 'neuro').avaliador.model).toBe('gpt-5.4-2026-03-05');
    expect(cat(res.body, 'neuro').avaliador.effort).toBe('low');
    // Paciente: o mini de sempre, sem raciocínio.
    expect(cat(res.body, 'treinamento').paciente.model).toBe('gpt-5.4-mini-2026-03-17');
    expect(cat(res.body, 'treinamento').paciente.effort).toBe('none');
  });

  it('a Trilha não é uma categoria desta tela (controle próprio, por exercício)', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    const chaves = res.body.categorias.map((c) => c.key);
    expect(chaves).not.toContain('trilha');
    expect(chaves).not.toContain('exercicio');

    const put = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'trilha', evaluator: 'gpt-5.5' });
    expect(put.status).toBe(400);
  });

  it('as opções são as 3 do avaliador e as 4 do paciente, todas OpenAI', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    // O 5.4 saiu da lista do AVALIADOR (pedido do dono): ficam os dois 5.6 e o
    // 5.5. No paciente o 5.4 continua, mas em effort none. GLM e Claude saíram.
    expect(res.body.avaliadorOpcoes.map((o) => o.key)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5']);
    expect(res.body.pacienteOpcoes.map((o) => o.key))
      .toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.4-mini', 'gpt-5.4']);
    for (const o of [...res.body.avaliadorOpcoes, ...res.body.pacienteOpcoes]) expect(o.provider).toBe('openai');
    // Todo avaliador em 'high'; no paciente só Sol e Luna raciocinam.
    for (const o of res.body.avaliadorOpcoes) expect(o.effort).toBe('high');
    const pacientePorKey = Object.fromEntries(res.body.pacienteOpcoes.map((o) => [o.key, o]));
    expect(pacientePorKey['gpt-5.4-mini'].effort).toBe('none');
    expect(pacientePorKey['gpt-5.4'].effort).toBe('none');
    expect(pacientePorKey['gpt-5.6-sol'].effort).toBe('high');
    expect(pacientePorKey['gpt-5.6-luna'].effort).toBe('high');
  });

  it('escolher um modelo persiste, marca fonte admin e reflete no GET', async () => {
    const admin = await loginAs('admin');
    const put = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'treinamento', evaluator: 'gpt-5.6-luna', patient: 'gpt-5.4' });
    expect(put.status).toBe(200);
    expect(cat(put.body, 'treinamento').avaliador.preset).toBe('gpt-5.6-luna');
    expect(cat(put.body, 'treinamento').avaliador.fonte).toBe('admin');
    expect(cat(put.body, 'treinamento').paciente.preset).toBe('gpt-5.4');
    expect(cat(put.body, 'treinamento').paciente.provider).toBe('openai');

    const get = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    expect(cat(get.body, 'treinamento').avaliador.model).toBe('gpt-5.6-luna');
    expect(cat(get.body, 'treinamento').avaliador.effort).toBe('high');
    // Não contamina as outras categorias.
    expect(cat(get.body, 'competitivo').avaliador.fonte).toBe('padrao');
  });

  it('null limpa a escolha e volta ao padrão do sistema', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'neuro', evaluator: 'gpt-5.6-sol' });
    const antes = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    expect(cat(antes.body, 'neuro').avaliador.fonte).toBe('admin');

    const limpo = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'neuro', evaluator: null });
    expect(cat(limpo.body, 'neuro').avaliador.fonte).toBe('padrao');
    expect(cat(limpo.body, 'neuro').avaliador.effort).toBe('low'); // effort original de volta
  });

  it('mexer só no paciente não derruba a escolha do avaliador', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'competitivo', evaluator: 'gpt-5.6-sol' });
    const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'competitivo', patient: 'gpt-5.6-luna' });
    expect(cat(res.body, 'competitivo').avaliador.preset).toBe('gpt-5.6-sol');
    expect(cat(res.body, 'competitivo').paciente.preset).toBe('gpt-5.6-luna');
  });

  it('rejeita categoria e preset inválidos sem gravar nada', async () => {
    const admin = await loginAs('admin');
    expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'inexistente', evaluator: 'gpt-5.5' })).status).toBe(400);
    expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'competitivo', evaluator: 'dall-e-mega' })).status).toBe(400);
    // Modelo de paciente no campo de avaliador não vale (listas diferentes).
    expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'competitivo', evaluator: 'gpt-5.4-mini' })).status).toBe(400);

    const get = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    expect(cat(get.body, 'competitivo').avaliador.fonte).toBe('padrao');
  });

  it('categoria sem paciente simulado recusa a escolha de paciente', async () => {
    const admin = await loginAs('admin');
    const get = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
    expect(cat(get.body, 'avaliacaoManual').temPaciente).toBe(false);
    expect(cat(get.body, 'avaliacaoManual').paciente).toBeNull();

    const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'avaliacaoManual', patient: 'gpt-5.4-mini' });
    expect(res.status).toBe(400);
  });

  // Padrão global: uma escolha que vale para todas as categorias, para não ter
  // de configurar uma por uma. Precedência: categoria > global > padrão do sistema.
  describe('padrão global (todas as categorias)', () => {
    it('vale para todas as categorias de uma vez, sem escrever escolha por categoria', async () => {
      const admin = await loginAs('admin');
      const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'gpt-5.6-sol', patient: 'gpt-5.6-luna' });
      expect(res.status).toBe(200);
      expect(res.body.padraoGlobal.evaluator).toBe('gpt-5.6-sol');
      expect(res.body.padraoGlobal.patient).toBe('gpt-5.6-luna');

      for (const c of res.body.categorias) {
        expect(c.avaliador.fonte).toBe('global');
        expect(c.avaliador.model).toBe('gpt-5.6-sol');
        expect(c.avaliador.effort).toBe('high');
        if (c.temPaciente) {
          expect(c.paciente.fonte).toBe('global');
          expect(c.paciente.model).toBe('gpt-5.6-luna');
        }
      }
      // Não virou escolha por categoria: o mapa por categoria segue vazio.
      expect(aiModels.readCategoryChoices({ aiModels: {} })).toEqual({});
    });

    it('a escolha da categoria vence o global, e limpá-la devolve ao global', async () => {
      const admin = await loginAs('admin');
      await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'gpt-5.6-luna' });
      const comEscolha = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ categoria: 'competitivo', evaluator: 'gpt-5.6-sol' });
      expect(cat(comEscolha.body, 'competitivo').avaliador.fonte).toBe('admin');
      expect(cat(comEscolha.body, 'competitivo').avaliador.model).toBe('gpt-5.6-sol');
      expect(cat(comEscolha.body, 'duelo').avaliador.model).toBe('gpt-5.6-luna'); // segue o global

      const limpo = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ categoria: 'competitivo', evaluator: null });
      expect(cat(limpo.body, 'competitivo').avaliador.fonte).toBe('global');
      expect(cat(limpo.body, 'competitivo').avaliador.model).toBe('gpt-5.6-luna');
    });

    it('limpar o global devolve tudo ao padrão do sistema (effort próprio incluso)', async () => {
      const admin = await loginAs('admin');
      await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'gpt-5.6-sol' });
      const limpo = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: null });
      expect(limpo.body.padraoGlobal.evaluator).toBe('');
      expect(cat(limpo.body, 'neuro').avaliador.fonte).toBe('padrao');
      expect(cat(limpo.body, 'neuro').avaliador.effort).toBe('low');
    });

    it('preset inválido no global é recusado, e o batch continua sendo por categoria', async () => {
      const admin = await loginAs('admin');
      expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'dall-e-mega' })).status).toBe(400);
      // Paciente no campo de avaliador também não cola.
      expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'gpt-5.4-mini' })).status).toBe(400);

      const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ global: true, evaluator: 'gpt-5.6-sol' });
      expect(cat(res.body, 'competitivo').avaliador.batch).toBe(true);  // categoria comporta
      expect(cat(res.body, 'treinamento').avaliador.batch).toBe(false); // categoria não comporta
    });

    it('global também é admin-only', async () => {
      const prof = await loginAs('prof');
      const res = await request(app).put('/api/admin/ai-models').set(authHeader(prof))
        .send({ global: true, evaluator: 'gpt-5.5' });
      expect(res.status).toBe(403);
    });
  });

  describe('batch', () => {
    it('só Competitivo e Processo Seletivo comportam batch', async () => {
      const admin = await loginAs('admin');
      const res = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
      const comBatch = res.body.categorias.filter((c) => c.batchCapable).map((c) => c.key);
      expect(comBatch.sort()).toEqual(['competitivo', 'seletivo']);
      // E vêm ligadas por padrão (o padrão delas é OpenAI).
      expect(cat(res.body, 'competitivo').avaliador.batch).toBe(true);
      expect(cat(res.body, 'seletivo').avaliador.batch).toBe(true);
    });

    it('toda opção de avaliador mantém o batch nas categorias que comportam', async () => {
      const admin = await loginAs('admin');
      for (const categoria of ['competitivo', 'seletivo']) {
        for (const evaluator of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5']) {
          const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
            .send({ categoria, evaluator });
          expect(cat(res.body, categoria).avaliador.batch).toBe(true);
        }
      }
    });

    it('categoria que mostra a nota na hora nunca vai de batch, nem em GPT', async () => {
      const admin = await loginAs('admin');
      for (const categoria of ['treinamento', 'visitante', 'duelo', 'neuro', 'avaliacaoManual']) {
        const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
          .send({ categoria, evaluator: 'gpt-5.5' });
        expect(cat(res.body, categoria).avaliador.batch).toBe(false);
      }
    });

    it('paciente nunca vai de batch (é conversa ao vivo)', async () => {
      const admin = await loginAs('admin');
      const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ categoria: 'competitivo', patient: 'gpt-5.4' });
      expect(cat(res.body, 'competitivo').paciente.batch).toBe(false);
    });
  });

  describe('visitante: a escolha de modelo vive na categoria, não mais na aba Contas', () => {
    it('a chave de modelo que saiu do contrato não desvia o padrão do visitante', async () => {
      const admin = await loginAs('admin');
      await request(app).put('/api/admin/settings').set(authHeader(admin))
        .send({ visitorEvaluationModel: 'gpt-5.5' }); // ignorada

      const res = await request(app).get('/api/admin/ai-models').set(authHeader(admin));
      const visitante = cat(res.body, 'visitante');
      // Visitante entrou no avaliador oficial junto com todo mundo.
      expect(visitante.avaliador.model).toBe('gpt-5.6-luna');
      expect(visitante.avaliador.fonte).toBe('padrao');
    });

    it('a escolha nova vence o legado', async () => {
      const admin = await loginAs('admin');
      await request(app).put('/api/admin/settings').set(authHeader(admin))
        .send({ visitorEvaluationModel: 'gpt-5.5' });
      const res = await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ categoria: 'visitante', evaluator: 'gpt-5.6-sol' });
      expect(cat(res.body, 'visitante').avaliador.model).toBe('gpt-5.6-sol');
      expect(cat(res.body, 'visitante').avaliador.fonte).toBe('admin');
    });

    it('GET /api/settings informa o modelo que roda de fato pro visitante', async () => {
      const admin = await loginAs('admin');
      await request(app).put('/api/admin/ai-models').set(authHeader(admin))
        .send({ categoria: 'visitante', evaluator: 'gpt-5.5' });

      const aluno = await loginAs('aluno');
      const res = await request(app).get('/api/settings').set(authHeader(aluno));
      expect(res.body.avaliadorModelo).toBe('gpt-5.5-2026-04-23');
    });
  });
});

// O módulo puro, sem HTTP — as invariantes que o resolve tem de garantir.
describe('ai-models (resolve puro)', () => {
  const padraoAvaliador = { model: 'gpt-5.6-luna', provider: 'openai', effort: 'high' };

  it('escolha inválida em settings.json é ignorada (cai no padrão)', () => {
    const spec = aiModels.resolveEvaluator(
      'competitivo',
      { aiModels: { competitivo: { evaluator: 'modelo-que-nao-existe' } } },
      padraoAvaliador,
    );
    expect(spec.fonte).toBe('padrao');
    expect(spec.model).toBe('gpt-5.6-luna');
  });

  // GLM e Claude saíram em 2026-10, mas o banco de produção pode ainda guardar a
  // escolha antiga. Ela tem de cair no padrão (e não virar um provedor sem
  // cliente), tanto por categoria quanto no padrão global.
  it('escolha antiga de GLM/Claude guardada no banco cai no padrão OpenAI', () => {
    const settings = {
      aiModels: { competitivo: { evaluator: 'glm-5.2', patient: 'claude-sonnet-5' } },
      aiModelsGlobal: { evaluator: 'glm-5.2', patient: 'glm-5.2' },
    };
    expect(aiModels.readCategoryChoices(settings)).toEqual({});
    expect(aiModels.readGlobalChoice(settings)).toEqual({});
    const av = aiModels.resolveEvaluator('competitivo', settings, padraoAvaliador);
    expect(av.fonte).toBe('padrao');
    expect(av.provider).toBe('openai');
    const pac = aiModels.resolvePatient('competitivo', settings, { model: 'gpt-5.4-mini-2026-03-17', provider: 'openai', effort: 'none' });
    expect(pac.fonte).toBe('padrao');
    expect(pac.provider).toBe('openai');
  });

  it('readCategoryChoices descarta categoria desconhecida e lixo', () => {
    const limpo = aiModels.readCategoryChoices({
      aiModels: {
        competitivo: { evaluator: 'gpt-5.5' },
        naoExiste: { evaluator: 'gpt-5.5' },
        seletivo: { evaluator: 'nope' },
        duelo: 'string-em-vez-de-objeto',
        avaliacaoManual: { patient: 'gpt-5.4-mini' }, // categoria sem paciente
      },
    });
    expect(limpo).toEqual({ competitivo: { evaluator: 'gpt-5.5' } });
  });

  it('casa o preset pelo prefixo do modelo, sobrevivendo à troca de pin', () => {
    const spec = aiModels.resolveEvaluator('neuro', {}, {
      model: 'gpt-5.5-9999-99-99', provider: 'openai', effort: 'low',
    });
    expect(spec.preset).toBe('gpt-5.5');
    expect(spec.model).toBe('gpt-5.5-9999-99-99'); // o modelo real não é reescrito
    expect(spec.effort).toBe('low');
  });

  // Modelo que não é preset nenhum (ex.: o gpt-5.4 do padrão do neuro, que saiu
  // da lista do avaliador): roda igual, só não casa nenhum item do select.
  it('padrão fora da lista de presets continua rodando, sem preset equivalente', () => {
    const spec = aiModels.resolveEvaluator('neuro', {}, {
      model: 'gpt-5.4-2026-03-05', provider: 'openai', effort: 'low',
    });
    expect(spec.preset).toBeNull();
    expect(spec.model).toBe('gpt-5.4-2026-03-05');
    expect(spec.fonte).toBe('padrao');
  });

  it('categoria desconhecida explode em vez de silenciosamente virar outra', () => {
    expect(() => aiModels.resolveEvaluator('trilha', {}, padraoAvaliador)).toThrow();
    expect(() => aiModels.resolvePatient('avaliacaoManual', {}, padraoAvaliador)).toThrow();
  });

  it('isPatientCategory só aceita categoria com paciente', () => {
    expect(aiModels.isPatientCategory('competitivo')).toBe(true);
    expect(aiModels.isPatientCategory('avaliacaoManual')).toBe(false);
    expect(aiModels.isPatientCategory('trilha')).toBe(false);
    expect(aiModels.isPatientCategory(undefined)).toBe(false);
  });

  // A dica do cliente é mais restrita que "categoria com paciente": só os modos
  // que o usuário logado realmente inicia na interface. Sem isso, um aluno podia
  // declarar 'seletivo' e rodar o paciente daquela categoria (possivelmente mais
  // caro) nos treinos dele.
  it('isClientPatientCategory recusa seletivo, visitante e neuro', () => {
    expect(aiModels.isClientPatientCategory('treinamento')).toBe(true);
    expect(aiModels.isClientPatientCategory('competitivo')).toBe(true);
    expect(aiModels.isClientPatientCategory('duelo')).toBe(true);
    // Derivadas no servidor ou de rota própria — nunca vindas do cliente.
    expect(aiModels.isClientPatientCategory('seletivo')).toBe(false);
    expect(aiModels.isClientPatientCategory('visitante')).toBe(false);
    expect(aiModels.isClientPatientCategory('neuro')).toBe(false);
    expect(aiModels.isClientPatientCategory('avaliacaoManual')).toBe(false);
    expect(aiModels.isClientPatientCategory(undefined)).toBe(false);
  });
});

// Modo demonstração (sem nenhuma API key, como roda a suite): trocar o paciente
// pra um provedor sem chave não pode virar 500 na cara do aluno.
describe('paciente por categoria em modo demonstração', () => {
  beforeEach(() => resetData());

  it('/api/chat responde a fala padrão mesmo com outro paciente escolhido', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/ai-models').set(authHeader(admin))
      .send({ categoria: 'treinamento', patient: 'gpt-5.6-sol' });

    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/chat').set(authHeader(aluno))
      .send({
        messages: [{ role: 'user', content: 'oi' }],
        context: { type: 'freeplay', itemId: 'fp-test-1', category: 'treinamento' },
      });
    expect(res.status).toBe(200);
    expect(res.body.content).toMatch(/Modo demonstração/);
  });

  it('GLM e Claude não são mais aceitos como escolha', async () => {
    const admin = await loginAs('admin');
    for (const corpo of [
      { categoria: 'treinamento', patient: 'claude-sonnet-5' },
      { categoria: 'competitivo', evaluator: 'glm-5.2' },
      { global: true, patient: 'glm-5.2' },
    ]) {
      expect((await request(app).put('/api/admin/ai-models').set(authHeader(admin)).send(corpo)).status).toBe(400);
    }
  });

  it('category inválida vinda do cliente não quebra nada (cai em treinamento)', async () => {
    const aluno = await loginAs('aluno');
    const res = await request(app).post('/api/chat').set(authHeader(aluno))
      .send({
        messages: [{ role: 'user', content: 'oi' }],
        context: { type: 'freeplay', itemId: 'fp-test-1', category: 'avaliacaoManual' },
      });
    expect(res.status).toBe(200);
    expect(res.body.content).toMatch(/Modo demonstração/);
  });

  // Nota: não há teste HTTP de "aluno declarando category: 'seletivo'" porque em
  // modo demonstração ele não discrimina — com ou sem a regra, toda resposta cai
  // na fala de demonstração, então o teste passaria pelo motivo errado. Quem
  // cobre a regra é o unitário isClientPatientCategory acima.

  it('category do cliente não dá acesso ao neuro (gate por role continua valendo)', async () => {
    const visitante = await loginVisitor();
    const res = await request(app).post('/api/chat').set(authHeader(visitante))
      .send({
        messages: [{ role: 'user', content: 'oi' }],
        context: { type: 'neuro', itemId: 'nr-test-1', category: 'treinamento' },
      });
    expect(res.status).toBe(403);
  });
});
