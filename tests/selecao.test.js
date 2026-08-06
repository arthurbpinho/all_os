// Processo Seletivo — fluxo do candidato (link fixo + senha), role avaliador,
// dedup por WhatsApp (15 dias) e a invariante de segurança: nota/avaliação NUNCA
// voltam ao candidato. Roda em modo demo (sem OPENAI_API_KEY), então a avaliação
// server-side não gera nota — o que basta pra checar a estrutura e o não-vazamento.
const { app, request, resetData, loginAs, authHeader } = require('./helpers');

// Default de SELECAO_PASSWORD no server. Constante única: a senha é trocada de
// tempos em tempos e antes ela estava repetida em três lugares deste arquivo.
const SENHA = 'allos01';

const CAMPOS = {
  password: SENHA,
  nome: 'Ana Silva',
  email: 'ana@exemplo.com',
  whatsapp: '(11) 91234-5678',
  faculdade: 'USP',
  periodo: '7º',
  consent: true,
};

describe('Processo Seletivo', () => {
  beforeEach(() => resetData());

  it('admin cria conta de avaliador; avaliador acessa dashboard e logs', async () => {
    const adminToken = await loginAs('admin');
    const create = await request(app)
      .post('/api/admin/users')
      .set(authHeader(adminToken))
      .send({ username: 'aval1', name: 'Avaliador Um', role: 'evaluator', password: 'avalpass123' });
    expect(create.status).toBe(200);
    expect(create.body.role).toBe('evaluator');

    const avalToken = await loginAs('aval1', 'avalpass123');
    const dash = await request(app).get('/api/selecao/dashboard').set(authHeader(avalToken));
    expect(dash.status).toBe(200);
    expect(dash.body).toMatchObject({ activeCount: 0, rejectedCount: 0, total: 0, threshold: 55 });

    const logs = await request(app).get('/api/selecao/logs').set(authHeader(avalToken));
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body)).toBe(true);
    expect(logs.body.length).toBe(0);
  });

  it('aluno NÃO acessa a área do avaliador', async () => {
    const alunoToken = await loginAs('aluno');
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(alunoToken));
    expect(logs.status).toBe(403);
    const dash = await request(app).get('/api/selecao/dashboard').set(authHeader(alunoToken));
    expect(dash.status).toBe(403);
  });

  it('senha: recusa incorreta, aceita a correta', async () => {
    const wrong = await request(app).post('/api/selecao/senha').send({ password: 'errada' });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post('/api/selecao/senha').send({ password: SENHA });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it('senha-config: avaliador troca a senha; senha antiga para de funcionar, nova passa a valer', async () => {
    const create = await request(app)
      .post('/api/admin/users')
      .set(authHeader(await loginAs('admin')))
      .send({ username: 'aval2', name: 'Avaliador Dois', role: 'evaluator', password: 'avalpass123' });
    expect(create.status).toBe(200);
    const avalToken = await loginAs('aval2', 'avalpass123');

    const before = await request(app).get('/api/selecao/senha-config').set(authHeader(avalToken));
    expect(before.status).toBe(200);
    expect(before.body.password).toBe(SENHA);
    expect(before.body.updatedBy).toBeFalsy();

    const curta = await request(app).put('/api/selecao/senha-config').set(authHeader(avalToken)).send({ password: 'ab' });
    expect(curta.status).toBe(400);

    const troca = await request(app).put('/api/selecao/senha-config').set(authHeader(avalToken)).send({ password: 'novaSenha22' });
    expect(troca.status).toBe(200);
    expect(troca.body.password).toBe('novaSenha22');
    expect(troca.body.updatedBy).toBe('Avaliador Dois');

    // Senha antiga não abre mais o formulário do candidato; a nova sim.
    const antiga = await request(app).post('/api/selecao/senha').send({ password: SENHA });
    expect(antiga.status).toBe(401);
    const nova = await request(app).post('/api/selecao/senha').send({ password: 'novaSenha22' });
    expect(nova.status).toBe(200);

    // A troca persiste e aparece pra quem consultar depois (auditoria simples).
    const after = await request(app).get('/api/selecao/senha-config').set(authHeader(avalToken));
    expect(after.body.updatedBy).toBe('Avaliador Dois');
    expect(typeof after.body.updatedAt).toBe('string');
  });

  it('senha-config: aluno não acessa (só evaluator/admin)', async () => {
    const alunoToken = await loginAs('aluno');
    const get = await request(app).get('/api/selecao/senha-config').set(authHeader(alunoToken));
    expect(get.status).toBe(403);
    const put = await request(app).put('/api/selecao/senha-config').set(authHeader(alunoToken)).send({ password: 'novaSenha22' });
    expect(put.status).toBe(403);
  });

  it('iniciar: valida campos/termo e devolve token + personagem SEM prompt secreto', async () => {
    const semCampos = await request(app).post('/api/selecao/iniciar').send({ password: SENHA, consent: true });
    expect(semCampos.status).toBe(400);

    const semConsent = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, consent: false });
    expect(semConsent.status).toBe(400);

    const senhaRuim = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, password: 'x' });
    expect(senhaRuim.status).toBe(401);

    const ok = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');
    expect(ok.body.character).toBeTruthy();
    // O personagem público nunca traz o prompt/gabarito secretos.
    expect(ok.body.character.specificInstruction).toBeUndefined();
    expect(ok.body.character.evaluationCriteria).toBeUndefined();
    expect(ok.body.character.name).toBe('Sofia Test');
  });

  it('fluxo completo: chat + finish nunca vazam nota/avaliação ao candidato', async () => {
    const start = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    const token = start.body.token;

    const chat = await request(app)
      .post('/api/selecao/chat')
      .set(authHeader(token))
      .send({ messages: [{ role: 'user', content: 'Iniciar' }] });
    expect(chat.status).toBe(200);
    expect(chat.body.role).toBe('assistant');
    expect(typeof chat.body.content).toBe('string');

    const finish = await request(app)
      .post('/api/selecao/finish')
      .set(authHeader(token))
      .send({ messages: [{ role: 'assistant', content: 'Olá.' }, { role: 'user', content: 'Como você está?' }], durationSeconds: 120 });
    expect(finish.status).toBe(200);
    expect(finish.body).toEqual({ ok: true });
    // Invariante: NADA de nota/avaliação/critérios volta ao candidato.
    expect(finish.body.score).toBeUndefined();
    expect(finish.body.evaluation).toBeUndefined();
    expect(finish.body.criteriaScores).toBeUndefined();

    // O log existe do lado do avaliador, com os dados do candidato e as mensagens.
    const adminToken = await loginAs('admin');
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(adminToken));
    expect(logs.status).toBe(200);
    expect(logs.body.length).toBe(1);
    const log = logs.body[0];
    expect(log.candidate).toMatchObject({ nome: 'Ana Silva', email: 'ana@exemplo.com', faculdade: 'USP', periodo: '7º' });
    expect(log.messages.length).toBe(2);
    expect(log.characterName).toBe('Sofia Test');
  });

  it('finish preserva o nº de sessão, o destaque (★) e o comentário das mensagens', async () => {
    const start = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    const token = start.body.token;
    await request(app).post('/api/selecao/finish').set(authHeader(token)).send({
      messages: [
        { role: 'assistant', content: 'Oi.', session: 1 },
        { role: 'user', content: 'Como você se sente?', session: 1, highlighted: true, comment: 'abertura acolhedora' },
        { role: 'assistant', content: 'Melhor esta semana.', session: 2 },
        { role: 'user', content: 'O que mudou?', session: 2 },
      ],
      durationSeconds: 300,
    });

    const adminToken = await loginAs('admin');
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(adminToken));
    const log = logs.body[0];
    expect(log.sessionCount).toBe(2);
    expect(log.messages[0].session).toBe(1);
    expect(log.messages[3].session).toBe(2);
    const hl = log.messages.find((m) => m.highlighted);
    expect(hl).toBeTruthy();
    expect(hl.comment).toBe('abertura acolhedora');
  });

  it('dedup: mesmo WhatsApp em <15 dias é bloqueado com "faltam X dias"; outro número passa', async () => {
    // 1ª avaliação completa (gera o log com o WhatsApp).
    const s1 = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    await request(app).post('/api/selecao/finish').set(authHeader(s1.body.token))
      .send({ messages: [{ role: 'user', content: 'oi' }], durationSeconds: 10 });

    // Mesmo número (formatado diferente) → bloqueado.
    const again = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, whatsapp: '11912345678' });
    expect(again.status).toBe(403);
    expect(again.body.daysLeft).toBeGreaterThan(0);
    expect(again.body.error).toMatch(/faltam .* dias/i);

    // Número diferente → permitido.
    const other = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, whatsapp: '(21) 99999-0000' });
    expect(other.status).toBe(200);
  });

  it('requireCandidate: token de usuário normal não acessa o chat do candidato', async () => {
    const adminToken = await loginAs('admin');
    const chat = await request(app).post('/api/selecao/chat').set(authHeader(adminToken)).send({ messages: [] });
    expect(chat.status).toBe(403);
  });
});
