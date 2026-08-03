// Endurecimento de segurança feito antes de expor o app em domínio próprio.
// Cobre: política de senha por perfil, mensagens de erro genéricas + painel de
// Logs de Erro, e o export sem credenciais.
const { app, request, resetData, loginAs, loginVisitor, authHeader } = require('./helpers');

describe('segurança — política de senha', () => {
  beforeEach(() => resetData());

  // O piso era 6 pra todo mundo. Pior: o boot exige 12 no ADMIN_INITIAL_PASSWORD
  // e o admin podia trocar depois por uma de 6, esvaziando a exigência.
  it('aluno: recusa senha curta e aceita a partir de 8', async () => {
    const admin = await loginAs('admin');
    const criar = (password) => request(app).post('/api/admin/users').set(authHeader(admin))
      .send({ username: `novo${password.length}`, name: 'Novo', role: 'therapist', teacherId: '2', password });

    const curta = await criar('1234567');       // 7
    expect(curta.status).toBe(400);
    expect(curta.body.error).toMatch(/ao menos 8/);

    const ok = await criar('12345678');         // 8
    expect(ok.status).toBe(200);
  });

  it('supervisor e admin exigem 12 caracteres', async () => {
    const admin = await loginAs('admin');
    const criar = (role, password) => request(app).post('/api/admin/users').set(authHeader(admin))
      .send({ username: `u${role}${password.length}`, name: 'Novo', role, password });

    for (const role of ['supervisor', 'admin']) {
      const oito = await criar(role, '12345678');       // passaria pra aluno
      expect(oito.status).toBe(400);
      expect(oito.body.error).toMatch(/ao menos 12/);

      const doze = await criar(role, '123456789012');
      expect(doze.status).toBe(200);
    }
  });

  it('admin não consegue rebaixar a própria senha para 8 pela tela de Perfil', async () => {
    const admin = await loginAs('admin');
    const res = await request(app).post('/api/me/password').set(authHeader(admin))
      .send({ currentPassword: 'testpass1234', newPassword: '12345678' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ao menos 12/);
  });

  it('reset de senha pelo admin respeita o piso do perfil ALVO', async () => {
    const admin = await loginAs('admin');
    // Alvo é o professor (id 2) → piso 12, mesmo quem reseta sendo admin.
    const curta = await request(app).post('/api/admin/users/2/reset-password').set(authHeader(admin))
      .send({ newPassword: '12345678' });
    expect(curta.status).toBe(400);
    expect(curta.body.error).toMatch(/ao menos 12/);

    // Aluno (id 3) → piso 8.
    const aluno = await request(app).post('/api/admin/users/3/reset-password').set(authHeader(admin))
      .send({ newPassword: '12345678' });
    expect(aluno.status).toBe(200);
  });
});

describe('segurança — erro genérico + Logs de Erro', () => {
  const fs = require('fs');
  const path = require('path');
  const { DATA_DIR } = require('./helpers');
  const { userFacingError, buildErrorEntry, ERROR_LOG_FILE } = require('../server/error-log');

  beforeEach(() => resetData());

  // Semeia o painel direto no DATA_DIR. A suite roda em modo demo (sem chaves
  // de IA), onde os handlers respondem 200 com conteúdo simulado em vez de
  // estourar — então não dá pra provocar uma falha real de provedor aqui.
  function semearErro(extra = {}) {
    const entry = {
      ...buildErrorEntry({
        err: Object.assign(new Error('OpenAI 429: quota exceeded for org-abc'), { name: 'RateLimitError' }),
        req: { method: 'POST', originalUrl: '/api/chat', user: { id: '3', username: 'aluno', role: 'therapist' } },
        where: 'chat/paciente',
      }),
      ...extra,
    };
    fs.writeFileSync(path.join(DATA_DIR, ERROR_LOG_FILE), JSON.stringify([entry], null, 2));
    return entry;
  }

  it('a resposta ao usuário leva mensagem genérica + código, sem o erro cru', () => {
    const corpo = userFacingError('err-teste-123');
    expect(corpo.errorId).toBe('err-teste-123');
    expect(corpo.error).toContain('código err-teste-123');
    expect(corpo.error).toContain('😵‍💫');
    // O que NÃO pode vazar: provedor, modelo, chave, caminho de disco.
    expect(corpo.error).not.toMatch(/openai|anthropic|api[_-]?key|\/data\//i);
  });

  // Guarda de regressão: impede que alguém volte a concatenar err.message numa
  // resposta. É o descuido exato que criou o vazamento em 24 lugares.
  it('nenhum handler monta resposta de erro a partir de err.message', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf-8');
    const suspeitas = fonte.split('\n')
      .map((linha, i) => ({ linha: linha.trim(), n: i + 1 }))
      .filter(({ linha }) => /error:\s*['"`].*['"`]\s*\+.*\b(err|e)\b\s*(&&|\.|\?)/.test(linha));
    expect(suspeitas.map((s) => `${s.n}: ${s.linha}`)).toEqual([]);
  });

  it('admin vê a entrada completa: mensagem real, quem, onde e quando', async () => {
    const semeado = semearErro();
    const admin = await loginAs('admin');
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    expect(painel.status).toBe(200);

    const entrada = painel.body.errors.find((e) => e.id === semeado.id);
    expect(entrada).toBeTruthy();
    expect(entrada.message).toContain('quota exceeded'); // aqui SIM vai o erro real
    expect(entrada.where).toBe('chat/paciente');         // onde
    expect(entrada.actor.username).toBe('aluno');        // quem
    expect(entrada.path).toBe('/api/chat');              // rota
    expect(entrada.timestamp).toBeTruthy();              // quando
    expect(painel.body.meta.max).toBeGreaterThan(0);
  });

  it('o painel é só do admin', async () => {
    for (const quem of ['aluno', 'prof']) {
      const token = await loginAs(quem);
      const res = await request(app).get('/api/admin/error-logs').set(authHeader(token));
      expect(res.status).toBe(403);
    }
    const visitante = await loginVisitor();
    const res = await request(app).get('/api/admin/error-logs').set(authHeader(visitante));
    expect(res.status).toBe(403);

    // E ninguém além do admin apaga o histórico.
    const aluno = await loginAs('aluno');
    const del = await request(app).delete('/api/admin/error-logs').set(authHeader(aluno));
    expect(del.status).toBe(403);
  });

  it('admin consegue limpar o painel', async () => {
    semearErro();
    const admin = await loginAs('admin');
    const limpo = await request(app).delete('/api/admin/error-logs').set(authHeader(admin));
    expect(limpo.status).toBe(200);
    expect(limpo.body.removidos).toBe(1);
    const painel = await request(app).get('/api/admin/error-logs').set(authHeader(admin));
    expect(painel.body.errors.length).toBe(0);
  });
});

describe('atualizações do sistema — só equipe', () => {
  beforeEach(() => resetData());

  // Notas de versão são comunicação interna de desenvolvimento. O painel some
  // no cliente pra aluno/visitante, e o endpoint fecha junto — esconder só na
  // tela deixaria o conteúdo acessível a qualquer sessão.
  it('admin e supervisor leem; aluno e visitante recebem 403', async () => {
    for (const quem of ['admin', 'prof']) {
      const token = await loginAs(quem);
      const res = await request(app).get('/api/updates').set(authHeader(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
    const aluno = await loginAs('aluno');
    expect((await request(app).get('/api/updates').set(authHeader(aluno))).status).toBe(403);

    const visitante = await loginVisitor();
    expect((await request(app).get('/api/updates').set(authHeader(visitante))).status).toBe(403);
  });
});

describe('segurança — redação de segredo no registro de erro', () => {
  // O painel é lido por humanos e pode ser copiado pra fora. Provedores de IA
  // às vezes ecoam trechos da request na mensagem de erro.
  const { redact, appendError, buildErrorEntry, MAX_ENTRIES } = require('../server/error-log');

  it('mascara chaves de API e Bearer token', () => {
    expect(redact('falhou com sk-abc123def456ghi789')).not.toContain('abc123def456');
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redact('api_key=super-secreto-1234')).toContain('[REDIGIDO]');
  });

  it('preserva o texto útil do erro', () => {
    expect(redact('Request timed out after 60s')).toBe('Request timed out after 60s');
  });

  it('respeita o teto de entradas (o arquivo é reescrito inteiro a cada erro)', () => {
    let lista = [];
    for (let i = 0; i < MAX_ENTRIES + 25; i++) {
      lista = appendError(lista, buildErrorEntry({ err: new Error(`erro ${i}`), where: 'teste' }));
    }
    expect(lista.length).toBe(MAX_ENTRIES);
    // Mais recente primeiro.
    expect(lista[0].message).toContain(`erro ${MAX_ENTRIES + 24}`);
  });
});
