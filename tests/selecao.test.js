// Processo Seletivo — fluxo do candidato (link fixo + senha), role avaliador,
// dedup por WhatsApp (15 dias) e a invariante de segurança: nota/avaliação NUNCA
// voltam ao candidato. Roda em modo demo (sem OPENAI_API_KEY), então a avaliação
// server-side não gera nota — o que basta pra checar a estrutura e o não-vazamento.
const { app, request, resetData, loginAs, authHeader, db } = require('./helpers');

// Default de SELECAO_PASSWORD no server. Constante única: a senha é trocada de
// tempos em tempos e antes ela estava repetida em três lugares deste arquivo.
const SENHA = '***REMOVIDO***';

const CAMPOS = {
  password: SENHA,
  nome: 'Ana Silva',
  email: 'ana@exemplo.com',
  whatsapp: '(11) 91234-5678',
  faculdade: 'USP',
  periodo: '7º',
  abordagem: 'Psicanalista',
  consent: true,
  feedbackIA: false,
};

describe('Processo Seletivo', () => {
  beforeEach(() => resetData());

  it('admin cria conta de avaliador; avaliador acessa dashboard e logs', async () => {
    const adminToken = await loginAs('admin');
    const create = await request(app)
      .post('/api/admin/users')
      .set(authHeader(adminToken))
      .send({ username: 'aval1', name: 'Avaliador Um', role: 'evaluator', password: 'Aval@pass123' });
    expect(create.status).toBe(200);
    expect(create.body.role).toBe('evaluator');

    const avalToken = await loginAs('aval1', 'Aval@pass123');
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
      .send({ username: 'aval2', name: 'Avaliador Dois', role: 'evaluator', password: 'Aval@pass123' });
    expect(create.status).toBe(200);
    const avalToken = await loginAs('aval2', 'Aval@pass123');

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

  // Envelhece todos os logs do seletivo, na coluna e no documento (a tela lê o
  // `timestamp` do documento; o bloqueio consulta a coluna).
  async function envelhecerLogs(dias) {
    const iso = new Date(Date.now() - dias * 86400000).toISOString();
    await db.query(
      `UPDATE selecao_logs SET criado_em = $1::timestamptz, doc = jsonb_set(doc, '{timestamp}', to_jsonb($1::text))`,
      [iso],
    );
  }

  async function fazerAvaliacao(campos = CAMPOS) {
    const s = await request(app).post('/api/selecao/iniciar').send(campos);
    expect(s.status).toBe(200);
    await request(app).post('/api/selecao/finish').set(authHeader(s.body.token))
      .send({ messages: [{ role: 'user', content: 'oi' }], durationSeconds: 10 });
  }

  it('bloqueio de 15 dias por WhatsApp (§25): mesmo número, mesmo formatado diferente, é recusado', async () => {
    await fazerAvaliacao();

    const again = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, whatsapp: '11912345678' });
    expect(again.status).toBe(403);
    expect(again.body.daysLeft).toBe(15);
    expect(again.body.error).toBe('Ainda faltam 15 dias para você tentar realizar a avaliação novamente');
    expect(again.body.token).toBeUndefined();

    // Número diferente passa.
    const other = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, whatsapp: '(21) 99999-0000' });
    expect(other.status).toBe(200);
  });

  it('bloqueio vence em 15 dias: os logs são persistentes, mas o antigo não bloqueia mais', async () => {
    await fazerAvaliacao();

    await envelhecerLogs(14);
    const umDia = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(umDia.status).toBe(403);
    expect(umDia.body.daysLeft).toBe(1);
    expect(umDia.body.error).toBe('Ainda falta 1 dia para você tentar realizar a avaliação novamente');

    await envelhecerLogs(16);
    const liberado = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(liberado.status).toBe(200);

    // O log antigo continua na lista do avaliador, sem botão de nova chance.
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(await loginAs('admin')));
    expect(logs.body).toHaveLength(1);
    expect(logs.body[0].bloqueiaAte).toBeNull();
  });

  it('nova chance: avaliador libera e o mesmo WhatsApp passa a poder refazer UMA vez', async () => {
    // 1ª avaliação → o WhatsApp fica bloqueado.
    await fazerAvaliacao();
    const bloqueado = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(bloqueado.status).toBe(403);

    // O log que bloqueia diz até quando.
    const avalToken = await loginAs('admin');
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(avalToken));
    const logId = logs.body[0].id;
    const ate = new Date(logs.body[0].bloqueiaAte).getTime() - new Date(logs.body[0].timestamp).getTime();
    expect(Math.round(ate / 86400000)).toBe(15);

    // O avaliador libera aquele log.
    const chance = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`).set(authHeader(avalToken));
    expect(chance.status).toBe(200);
    expect(chance.body.novaChance.por).toBe('Admin');
    expect(typeof chance.body.novaChance.em).toBe('string');

    // Agora passa — e o log liberado continua lá, com a marca e sem bloquear.
    const liberado = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(liberado.status).toBe(200);
    const depois = await request(app).get('/api/selecao/logs').set(authHeader(avalToken));
    const perdoado = depois.body.find((l) => l.id === logId);
    expect(perdoado.novaChance).toEqual(chance.body.novaChance);
    expect(perdoado.bloqueiaAte).toBeNull();

    // É UMA chance, não um passe livre: a tentativa nova nasce sem a marca e
    // volta a bloquear assim que for finalizada.
    await request(app).post('/api/selecao/finish').set(authHeader(liberado.body.token))
      .send({ messages: [{ role: 'user', content: 'de novo' }], durationSeconds: 10 });
    const bloqueadoDeNovo = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(bloqueadoDeNovo.status).toBe(403);
  });

  it('nova chance: idempotente, 404 em log inexistente e fechada para aluno e anônimo', async () => {
    await fazerAvaliacao();
    const adminToken = await loginAs('admin');
    const logId = (await request(app).get('/api/selecao/logs').set(authHeader(adminToken))).body[0].id;

    const primeira = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`).set(authHeader(adminToken));
    const segunda = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`).set(authHeader(adminToken));
    expect(segunda.status).toBe(200);
    // Clicar duas vezes não reescreve quem liberou nem quando.
    expect(segunda.body.novaChance).toEqual(primeira.body.novaChance);

    const inexistente = await request(app).post('/api/selecao/logs/sellog-nao-existe/nova-chance').set(authHeader(adminToken));
    expect(inexistente.status).toBe(404);

    const aluno = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`).set(authHeader(await loginAs('aluno')));
    expect(aluno.status).toBe(403);
    const anonimo = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`);
    expect(anonimo.status).toBe(401);
  });

  it('avaliador (papel evaluator) também concede a nova chance', async () => {
    const adminToken = await loginAs('admin');
    await request(app).post('/api/admin/users').set(authHeader(adminToken))
      .send({ username: 'aval1', name: 'Avaliador Um', role: 'evaluator', password: 'Aval@pass123' });
    await fazerAvaliacao();
    const avalToken = await loginAs('aval1', 'Aval@pass123');
    const logId = (await request(app).get('/api/selecao/logs').set(authHeader(avalToken))).body[0].id;

    const chance = await request(app).post(`/api/selecao/logs/${logId}/nova-chance`).set(authHeader(avalToken));
    expect(chance.status).toBe(200);
    expect(chance.body.novaChance.por).toBe('Avaliador Um');
  });

  // O token tem de sobreviver à prova inteira: ele nasce no /iniciar, mas o
  // cronômetro de 2 horas (client/src/pages/ProcessoSeletivo.jsx) só começa no
  // "Começar simulação", e a pessoa ainda pode pausar com a aba fechada. Se o TTL
  // encostar nas 2 horas, o finish volta "Sessão expirada" e o atendimento
  // inteiro se perde — por isso o número é testado, e não só comentado.
  it('token do candidato dura mais que o cronômetro da prova (2 horas)', async () => {
    const start = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(start.status).toBe(200);
    const { exp, iat } = require('jsonwebtoken').decode(start.body.token);
    const duracaoHoras = (exp - iat) / 3600;
    expect(duracaoHoras).toBe(4);
    expect(duracaoHoras).toBeGreaterThan(2);
  });

  it('abordagem da psicologia: obrigatória, só das opções, e chega ao avaliador e à exportação', async () => {
    const { abordagem, ...semAbordagem } = CAMPOS;
    const faltando = await request(app).post('/api/selecao/iniciar').send(semAbordagem);
    expect(faltando.status).toBe(400);
    expect(faltando.body.error).toBe('Escolha com qual abordagem da psicologia você mais se identifica.');
    const inventada = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, abordagem: 'Behaviorismo radical' });
    expect(inventada.status).toBe(400);

    const s = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, abordagem: 'Não tenho ainda / prefiro não informar / outra' });
    expect(s.status).toBe(200);
    await request(app).post('/api/selecao/finish').set(authHeader(s.body.token))
      .send({ messages: [{ role: 'user', content: 'oi' }], durationSeconds: 10 });
    const logs = await request(app).get('/api/selecao/logs').set(authHeader(await loginAs('admin')));
    expect(logs.body[0].candidate.abordagem).toBe('Não tenho ainda / prefiro não informar / outra');
    const exp = await request(app).get('/api/selecao/export-all').set('X-Export-Secret', 'test-export-secret');
    expect(exp.body.logs[0].content).toContain('Abordagem: Não tenho ainda / prefiro não informar / outra');
  });

  it('a lista de abordagens do formulário é a mesma que o servidor aceita', () => {
    const fs = require('fs');
    const path = require('path');
    const lista = (arquivo, nome) => {
      const src = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
      const ini = src.indexOf(`const ${nome} = [`);
      return [...src.slice(ini, src.indexOf('];', ini)).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    };
    const servidor = lista('server/index.js', 'SELECAO_ABORDAGENS');
    expect(servidor).toHaveLength(11);
    expect(lista('client/src/pages/ProcessoSeletivo.jsx', 'ABORDAGENS')).toEqual(servidor);
  });

  it('export-all: exige o secret certo (M2M, sem JWT) e devolve log+avaliação em texto por candidato', async () => {
    const start = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    await request(app).post('/api/selecao/finish').set(authHeader(start.body.token))
      .send({ messages: [{ role: 'assistant', content: 'Oi.' }, { role: 'user', content: 'Tudo bem?' }], durationSeconds: 60 });

    const semHeader = await request(app).get('/api/selecao/export-all');
    expect(semHeader.status).toBe(401);

    const secretErrado = await request(app).get('/api/selecao/export-all').set('X-Export-Secret', 'chute-errado');
    expect(secretErrado.status).toBe(401);

    const ok = await request(app).get('/api/selecao/export-all').set('X-Export-Secret', 'test-export-secret');
    expect(ok.status).toBe(200);
    expect(ok.body.count).toBe(1);
    const item = ok.body.logs[0];
    expect(item.filename).toMatch(/^processo-seletivo-ana-silva-\d{4}-\d{2}-\d{2}-[0-9a-f-]+\.txt$/);
    expect(item.content).toMatch(/Candidato: Ana Silva/);
    expect(item.content).toMatch(/E-mail: ana@exemplo\.com/);
    expect(item.content).toMatch(/Tudo bem\?/);
    // Sem avaliação ainda (modo demo/pending) — não deve aparecer a seção de avaliação.
    expect(item.content).not.toMatch(/AVALIAÇÃO DA IA/);
  });

  it('requireCandidate: token de usuário normal não acessa o chat do candidato', async () => {
    const adminToken = await loginAs('admin');
    const chat = await request(app).post('/api/selecao/chat').set(authHeader(adminToken)).send({ messages: [] });
    expect(chat.status).toBe(403);
  });
});
