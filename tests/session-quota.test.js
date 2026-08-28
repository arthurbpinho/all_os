// Cota diária de sessões do Aluno Externo: 3 atendimentos por 24h.
//
// O que este arquivo garante:
//   1. o slot é cobrado ao ABRIR a sessão, não ao finalizar;
//   2. a 4ª abertura em 24h é barrada com a mensagem combinada;
//   3. continuar (ou retomar) uma sessão já aberta nunca é barrado;
//   4. nenhum outro papel ganhou limite junto.
const { app, request, resetData, loginAs, authHeader, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');
const mailer = require('../server/email');
const quota = require('../server/session-quota');

const CADASTRO_OK = {
  username: 'ana.externa',
  name: 'Ana Souza',
  email: 'ana@exemplo.invalid',
  password: 'Ab1@cdef',
  origem: 'faculdade',
  origemDetalhe: 'PUC-SP',
  aceiteTermos: true,
};

function tokenDoEmail(assuntoContem) {
  const alvo = mailer.emailsCapturados().reverse().find((e) => e.subject.includes(assuntoContem));
  if (!alvo) throw new Error('E-mail não capturado: ' + assuntoContem);
  return /token=([A-Za-z0-9_-]+)/.exec(alvo.text)[1];
}

async function loginExterno() {
  await request(app).post('/api/cadastro').send(CADASTRO_OK);
  const conf = await request(app).post('/api/confirmar-email')
    .send({ token: tokenDoEmail('Confirme seu cadastro') });
  return conf.body.token;
}

// Abre uma sessão. O paciente é o parâmetro porque é ele que identifica a
// sessão para a cota — o servidor cobra por chave tipo+paciente, não por
// "quantas mensagens vieram no corpo" (ver session-quota.js).
function abrirSessao(token, paciente = 'fp-test-1') {
  return request(app).post('/api/chat').set(authHeader(token))
    .send({ messages: [{ role: 'user', content: 'Iniciar' }], context: { type: 'freeplay', itemId: paciente } });
}

// Continua uma sessão já aberta (histórico junto).
function continuarSessao(token, paciente = 'fp-test-1') {
  return request(app).post('/api/chat').set(authHeader(token)).send({
    messages: [
      { role: 'user', content: 'Iniciar' },
      { role: 'assistant', content: 'Oi.' },
      { role: 'user', content: 'Como você está?' },
    ],
    context: { type: 'freeplay', itemId: paciente },
  });
}

// Finaliza o atendimento (salva o log). É o que fecha a sessão daquela chave.
function finalizarSessao(token, paciente = 'fp-test-1') {
  return request(app).post('/api/logs').set(authHeader(token)).send({
    type: 'freeplay', itemId: paciente, itemTitle: 'Sofia Test',
    messages: [{ role: 'user', content: 'oi' }],
  });
}

// ---------------------------------------------------------------------------
describe('session-quota (unitário)', () => {
  const AGORA = Date.parse('2026-08-27T12:00:00Z');
  const HORA = 60 * 60 * 1000;

  it('só o Aluno Externo tem cota', () => {
    expect(quota.hasSessionQuota('external')).toBe(true);
    for (const r of ['therapist', 'supervisor', 'admin', 'evaluator', 'visitor']) {
      expect(quota.hasSessionQuota(r)).toBe(false);
    }
  });

  it('conta 3 aberturas e bloqueia a 4ª', () => {
    let starts = [];
    for (let i = 0; i < 3; i++) {
      expect(quota.quotaState(starts, AGORA).blocked).toBe(false);
      starts = quota.registerStart(starts, `freeplay:p${i}`, AGORA);
    }
    const cheio = quota.quotaState(starts, AGORA);
    expect(cheio.used).toBe(3);
    expect(cheio.remaining).toBe(0);
    expect(cheio.blocked).toBe(true);
    expect(cheio.message).toBe(
      'Limitamos o uso de alunos externos para 3 sessões. Em 24 horas você conseguirá acessar novamente.',
    );
  });

  // Janela DESLIZANTE: o que libera o próximo slot é a abertura mais antiga
  // completar 24h, não a virada do dia.
  it('libera o slot 24h depois da abertura mais antiga', () => {
    const starts = [AGORA - 25 * HORA, AGORA - 23 * HORA, AGORA - 1 * HORA];
    const st = quota.quotaState(starts, AGORA);
    expect(st.used).toBe(2);           // a de 25h atrás saiu da janela
    expect(st.blocked).toBe(false);
    expect(st.resetAt).toBe(new Date(AGORA - 23 * HORA + 24 * HORA).toISOString());
  });

  it('ignora lixo na lista de aberturas', () => {
    expect(quota.quotaState([null, 'abacaxi', undefined, NaN], AGORA).used).toBe(0);
    expect(quota.quotaState('não é lista', AGORA).used).toBe(0);
  });

  // A identidade da sessão vem do CONTEXTO (tipo+paciente), nunca do histórico
  // que o cliente envia — foi assim que um corpo com uma mensagem de enchimento
  // conseguia pular a cota inteira.
  it('deriva a chave da sessão do contexto', () => {
    expect(quota.sessionKey({ type: 'freeplay', itemId: 'fp-1' })).toBe('freeplay:fp-1');
    expect(quota.sessionKey({ type: 'freeplay' })).toBe(null);
    expect(quota.sessionKey(null)).toBe(null);
  });

  it('chave já aberta não cobra de novo; fechá-la faz a próxima cobrar', () => {
    let starts = quota.registerStart([], 'freeplay:a', AGORA);
    expect(quota.hasOpenSession(starts, 'freeplay:a', AGORA)).toBe(true);
    expect(quota.hasOpenSession(starts, 'freeplay:b', AGORA)).toBe(false);

    starts = quota.closeSession(starts, 'freeplay:a', AGORA);
    expect(quota.hasOpenSession(starts, 'freeplay:a', AGORA)).toBe(false);
    // Fechar NÃO devolve o slot: ele já foi gasto.
    expect(quota.quotaState(starts, AGORA).used).toBe(1);
  });

  it('aceita o formato antigo (timestamp solto) sem invalidar a cota em curso', () => {
    const antigo = [AGORA - 3600_000, AGORA - 1800_000];
    expect(quota.quotaState(antigo, AGORA).used).toBe(2);
    // Sem chave gravada, nada conta como "aberto" — o próximo chat cobra.
    expect(quota.hasOpenSession(antigo, 'freeplay:a', AGORA)).toBe(false);
  });

  it('papel sem cota tem o mesmo shape, desligado', () => {
    const st = quota.unlimitedState();
    expect(st.enabled).toBe(false);
    expect(st.blocked).toBe(false);
    expect(st.limit).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('cota de sessões na API', () => {
  beforeEach(() => {
    resetData();
    mailer.limparCapturados();
    // A cota conta sessões DISTINTAS (chave tipo+paciente), então o teste
    // precisa de mais de um paciente. A fixture padrão traz só o fp-test-1.
    const chars = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'freeplay-characters.json'), 'utf-8'));
    for (const n of [2, 3, 4, 9]) {
      chars.push({ ...chars[0], id: `fp-test-${n}`, name: `Paciente ${n}` });
    }
    fs.writeFileSync(path.join(DATA_DIR, 'freeplay-characters.json'), JSON.stringify(chars, null, 2));
  });

  it('deixa abrir 3 sessões e barra a 4ª com a mensagem combinada', async () => {
    const token = await loginExterno();

    for (const p of ['fp-test-1', 'fp-test-2', 'fp-test-3']) {
      const res = await abrirSessao(token, p);
      expect(res.status).toBe(200);
    }

    const quarta = await abrirSessao(token, 'fp-test-4');
    expect(quarta.status).toBe(429);
    expect(quarta.body.error).toBe(
      'Limitamos o uso de alunos externos para 3 sessões. Em 24 horas você conseguirá acessar novamente.',
    );
    expect(quarta.body.sessionQuota.blocked).toBe(true);
    expect(quarta.body.sessionQuota.resetAt).toBeTruthy();
  });

  // Ninguém pode ficar preso no meio de um atendimento: o slot daquela sessão
  // já foi cobrado na abertura.
  it('não barra a continuação de uma sessão já aberta', async () => {
    const token = await loginExterno();
    for (const p of ['fp-test-1', 'fp-test-2', 'fp-test-3']) await abrirSessao(token, p);

    const res = await continuarSessao(token, 'fp-test-1');
    expect(res.status).toBe(200);
  });

  // REGRESSÃO. A versão anterior decidia "é uma sessão nova?" contando as
  // mensagens do corpo da requisição, então bastava mandar uma mensagem de
  // enchimento antes da real pra nunca ser cobrado. Hoje quem decide é o
  // registro do servidor, e o corpo não muda nada.
  it('histórico forjado no corpo não pula a cota', async () => {
    const token = await loginExterno();
    for (const p of ['fp-test-1', 'fp-test-2', 'fp-test-3']) await abrirSessao(token, p);

    const forjado = await request(app).post('/api/chat').set(authHeader(token)).send({
      messages: [
        { role: 'user', content: '.' },          // enchimento
        { role: 'user', content: 'Iniciar' },    // o turno de verdade
      ],
      context: { type: 'freeplay', itemId: 'fp-test-9' }, // paciente novo
    });
    expect(forjado.status).toBe(429);
  });

  // Finalizar o atendimento fecha a chave: reabrir aquele paciente é uma
  // sessão nova e custa um slot — senão o mesmo paciente valeria pra sempre.
  it('reabrir um paciente já finalizado cobra um slot novo', async () => {
    const token = await loginExterno();
    await abrirSessao(token, 'fp-test-1');
    await finalizarSessao(token, 'fp-test-1');
    await abrirSessao(token, 'fp-test-1');   // 2º slot
    await finalizarSessao(token, 'fp-test-1');
    await abrirSessao(token, 'fp-test-1');   // 3º slot
    await finalizarSessao(token, 'fp-test-1');

    const st = await request(app).get('/api/session-quota').set(authHeader(token));
    expect(st.body).toMatchObject({ used: 3, remaining: 0, blocked: true });
    expect((await abrirSessao(token, 'fp-test-1')).status).toBe(429);
  });

  it('GET /api/session-quota reflete o consumo do aluno externo', async () => {
    const token = await loginExterno();
    const antes = await request(app).get('/api/session-quota').set(authHeader(token));
    expect(antes.body).toMatchObject({ enabled: true, limit: 3, used: 0, remaining: 3, blocked: false });

    await abrirSessao(token);
    const depois = await request(app).get('/api/session-quota').set(authHeader(token));
    expect(depois.body).toMatchObject({ used: 1, remaining: 2, blocked: false });
  });

  // A tela consulta a cota ANTES de montar o chat. Sem o contexto da sessão, a
  // resposta "bloqueado" impediria de RETOMAR um atendimento já aberto — que o
  // /api/chat libera. Os dois lados precisam concordar.
  it('a consulta prévia libera a retomada de uma sessão já aberta', async () => {
    const token = await loginExterno();
    for (const p of ['fp-test-1', 'fp-test-2', 'fp-test-3']) await abrirSessao(token, p);

    const semContexto = await request(app).get('/api/session-quota').set(authHeader(token));
    expect(semContexto.body.blocked).toBe(true);

    const retomando = await request(app)
      .get('/api/session-quota?type=freeplay&itemId=fp-test-1').set(authHeader(token));
    expect(retomando.body.blocked).toBe(false);
    expect((await continuarSessao(token, 'fp-test-1')).status).toBe(200); // e o chat concorda

    const novo = await request(app)
      .get('/api/session-quota?type=freeplay&itemId=fp-test-9').set(authHeader(token));
    expect(novo.body.blocked).toBe(true);
    expect((await abrirSessao(token, 'fp-test-9')).status).toBe(429);     // e o chat concorda
  });

  it('aluno interno não tem cota e abre quantas sessões quiser', async () => {
    const token = await loginAs('aluno');
    const st = await request(app).get('/api/session-quota').set(authHeader(token));
    expect(st.body.enabled).toBe(false);

    for (let i = 0; i < 5; i++) {
      expect((await abrirSessao(token)).status).toBe(200);
    }
    const arquivo = path.join(DATA_DIR, 'external-session-starts.json');
    // Nada é registrado para quem não tem cota.
    const registro = fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, 'utf-8')) : {};
    expect(registro['3']).toBeUndefined();
  });

  // A cota é por conta, não global: um externo esgotado não trava o outro.
  it('a contagem é por usuário', async () => {
    const ana = await loginExterno();
    for (const p of ['fp-test-1', 'fp-test-2', 'fp-test-3']) await abrirSessao(ana, p);
    expect((await abrirSessao(ana, 'fp-test-4')).status).toBe(429);

    mailer.limparCapturados();
    await request(app).post('/api/cadastro').send({ ...CADASTRO_OK, username: 'bruno.externo', email: 'bruno@exemplo.invalid' });
    const conf = await request(app).post('/api/confirmar-email')
      .send({ token: tokenDoEmail('Confirme seu cadastro') });
    expect((await abrirSessao(conf.body.token)).status).toBe(200);
  });
});
