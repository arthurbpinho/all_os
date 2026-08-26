// Cadastro público de Aluno Externo + endurecimento do login que veio com ele.
//
// O que este arquivo garante, em ordem de importância:
//   1. nenhum caminho de auto-cadastro cria conta que não seja 'external';
//   2. nenhuma conta nasce sem o e-mail confirmado por link;
//   3. `Admin` não é uma conta livre só por causa da maiúscula;
//   4. trocar a senha derruba os tokens antigos.
const { app, request, resetData, loginAs, authHeader, TEST_PASSWORD, DATA_DIR } = require('./helpers');
const fs = require('fs');
const path = require('path');
const contas = require('../server/cadastro');
const mailer = require('../server/email');

// O token do link só existe em texto no e-mail (em disco fica o SHA-256), então
// é de lá que o teste tira. Sem Graph configurado, os envios ficam na captura em
// memória do módulo — ver emailsCapturados().
function tokenDoUltimoEmail(assuntoContem) {
  const enviados = mailer.emailsCapturados().reverse();
  const alvo = enviados.find((e) => e.subject.includes(assuntoContem));
  if (!alvo) throw new Error(`Nenhum e-mail com "${assuntoContem}" nos ${enviados.length} capturados`);
  const m = /token=([A-Za-z0-9_-]+)/.exec(alvo.text || '');
  if (!m) throw new Error('E-mail sem token no corpo: ' + alvo.text);
  return m[1];
}
function assuntosEnviados() {
  return mailer.emailsCapturados().map((e) => e.subject);
}
function lerJSON(file, fallback) {
  const p = path.join(DATA_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
}

// Domínio .invalid é RESERVADO pela RFC 6761: nunca resolve e nunca aceita
// e-mail. Antes estes fixtures usavam "@exemplo.org", que é um domínio REAL, de
// terceiros, com MX ativo — e num momento em que o .env estava configurado a
// suíte entregou mensagens de teste no servidor de outra pessoa. Endereço de
// teste tem que ser comprovadamente inexistente, não só improvável.
const CADASTRO_OK = {
  username: 'ana.externa',
  name: 'Ana Souza',
  email: 'ana@exemplo.invalid',
  password: 'Ab1@cdef',
  origem: 'faculdade',
  origemDetalhe: 'PUC-SP',
  aceiteTermos: true,
  newsletterAllOS: true,
  newsletterAllos: false,
};

function limpar() {
  resetData();
  mailer.limparCapturados();
}

// ---------------------------------------------------------------------------
describe('política de senha (unitário)', () => {
  it('exige comprimento, letra, número e caractere especial', () => {
    expect(contas.validarSenha('Ab1@cde', 'external')).toMatch(/ao menos 8/);
    expect(contas.validarSenha('Ab1@cdefghi', 'admin')).toMatch(/ao menos 12/);
    expect(contas.validarSenha('abcdefg@', 'external')).toMatch(/1 número/);
    expect(contas.validarSenha('1234567@', 'external')).toMatch(/1 letra/);
    expect(contas.validarSenha('abcdefg1', 'external')).toMatch(/caractere especial/);
    expect(contas.validarSenha('Ab1@cdef', 'external')).toBeNull();
  });

  it('recusa a senha que contém o nome de usuário, em qualquer caixa', () => {
    expect(contas.validarSenha('MARCIA@2026', 'external', 'marcia')).toMatch(/nome de usuário/i);
    expect(contas.validarSenha('x-marcia-1@', 'external', 'Marcia')).toMatch(/nome de usuário/i);
    expect(contas.validarSenha('Ab1@cdef', 'external', 'marcia')).toBeNull();
  });

  it('recusa senha comum mesmo disfarçada com pontuação', () => {
    for (const s of ['senha1234', 'Senha1234!', '!allos2026', 's.e.n.h.a.1.2.3.4']) {
      expect(contas.validarSenha(s, 'external')).toMatch(/muito comum/i);
    }
  });

  // bcrypt trunca em 72 BYTES sem avisar: além disso, o que a pessoa digitou não
  // protege nada e ela acha que protege.
  it('recusa senha acima de 72 bytes', () => {
    expect(contas.validarSenha('Ab1@' + 'x'.repeat(80), 'external')).toMatch(/longa demais/);
  });
});

describe('nomes de usuário reservados e normalização', () => {
  it('bloqueia nomes que se passam pela equipe', () => {
    for (const n of ['admin', 'ADMIN', 'Suporte', 'allos', 'moderador', 'no-reply']) {
      expect(contas.isReservedUsername(n)).toBe(true);
    }
    expect(contas.isReservedUsername('ana.externa')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('login endurecido', () => {
  beforeEach(limpar);

  // Esta era a brecha central de abrir o cadastro: `admin` existe, então
  // `Admin` seria uma conta LIVRE se a comparação continuasse sensível a caixa.
  it('login ignora maiúsculas no nome de usuário', async () => {
    for (const variante of ['admin', 'Admin', 'ADMIN', ' admin ']) {
      const res = await request(app).post('/api/login').send({ username: variante, password: TEST_PASSWORD });
      expect(res.status, `variante ${JSON.stringify(variante)}`).toBe(200);
      expect(res.body.user.username).toBe('admin');
    }
  });

  it('admin não consegue criar conta que colide só na caixa', async () => {
    const token = await loginAs('admin');
    const res = await request(app).post('/api/admin/users').set(authHeader(token))
      .send({ username: 'ALUNO', name: 'Colisão', role: 'therapist', teacherId: '2', password: 'Ab1@cdef' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já existe/i);
  });

  // Antes, o JWT era irrevogável: trocar a senha não derrubava o token vazado.
  it('trocar a senha invalida os tokens antigos e devolve um novo', async () => {
    const antigo = await loginAs('aluno');
    const res = await request(app).post('/api/me/password').set(authHeader(antigo))
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Nova@Senha1' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');

    const comAntigo = await request(app).get('/api/me').set(authHeader(antigo));
    expect(comAntigo.status).toBe(401);

    const comNovo = await request(app).get('/api/me').set(authHeader(res.body.token));
    expect(comNovo.status).toBe(200);
  });

  it('reset pelo admin também derruba a sessão aberta do aluno', async () => {
    const doAluno = await loginAs('aluno');
    const admin = await loginAs('admin');
    await request(app).post('/api/admin/users/3/reset-password').set(authHeader(admin))
      .send({ newPassword: 'Outra@Senha1' });
    expect((await request(app).get('/api/me').set(authHeader(doAluno))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('cadastro de Aluno Externo', () => {
  beforeEach(limpar);

  it('cria a conta só depois da confirmação por e-mail', async () => {
    const res = await request(app).post('/api/cadastro').send(CADASTRO_OK);
    expect(res.status).toBe(200);

    // Nada em users.json ainda — só uma pendência descartável.
    expect(lerJSON('users.json', []).some((u) => u.username === 'ana.externa')).toBe(false);
    expect(lerJSON('pending-registrations.json', []).length).toBe(1);
    // Em disco fica só o hash do token, nunca o token.
    const pend = lerJSON('pending-registrations.json', [])[0];
    expect(pend.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pend.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(pend)).not.toContain(CADASTRO_OK.password);

    const token = tokenDoUltimoEmail('Confirme seu cadastro');
    const conf = await request(app).post('/api/confirmar-email').send({ token });
    expect(conf.status).toBe(200);
    expect(conf.body.tipo).toBe('cadastro');
    // Entra logado — acabou de provar que é dono do e-mail.
    expect(conf.body.token).toBeTypeOf('string');

    const criado = lerJSON('users.json', []).find((u) => u.username === 'ana.externa');
    expect(criado.role).toBe('external');
    expect(criado.teacherId).toBeNull();
    expect(criado.emailVerified).toBe(true);
    expect(criado.origem).toEqual({ canal: 'faculdade', detalhe: 'PUC-SP' });
    // Consentimento com data e versão, não só um booleano (LGPD).
    expect(criado.consentimento.termos.aceito).toBe(true);
    expect(criado.consentimento.termos.em).toBeTypeOf('string');
    expect(criado.consentimento.termos.versao).toBeTypeOf('string');
    expect(criado.updateAllOS).toBe(true);
    expect(criado.updateAllos).toBe(false);

    // E o token devolvido serve pra usar o app.
    const me = await request(app).get('/api/me').set(authHeader(conf.body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('external');
    expect(me.body.user.passwordHash).toBeUndefined();

    // A pendência foi consumida — o link não vale duas vezes.
    expect(lerJSON('pending-registrations.json', []).length).toBe(0);
    expect((await request(app).post('/api/confirmar-email').send({ token })).status).toBe(400);
  });

  // O ponto mais importante do arquivo: nenhum campo do formulário pode
  // escolher o papel da conta.
  it('ignora role, teacherId e id vindos do corpo da request', async () => {
    const res = await request(app).post('/api/cadastro').send({
      ...CADASTRO_OK, role: 'admin', teacherId: '2', id: '1', emailVerified: true, tokenVersion: 99,
    });
    expect(res.status).toBe(200);
    const token = tokenDoUltimoEmail('Confirme seu cadastro');
    await request(app).post('/api/confirmar-email').send({ token });

    const criado = lerJSON('users.json', []).find((u) => u.username === 'ana.externa');
    expect(criado.role).toBe('external');
    expect(criado.teacherId).toBeNull();
    expect(criado.id).not.toBe('1');
    expect(criado.tokenVersion).toBe(0);
    // E a conta admin original continua intacta.
    expect(lerJSON('users.json', []).find((u) => u.id === '1').role).toBe('admin');
  });

  it('recusa nome reservado, nome em uso, senha fraca e falta de aceite dos termos', async () => {
    const casos = [
      [{ username: 'suporte' }, /não está disponível/i],
      [{ username: 'ALUNO2' }, /já está em uso/i],      // colide com 'aluno2' ignorando a caixa
      [{ username: 'Supervisor' }, /não está disponível/i], // rótulo de papel também é reservado
      [{ password: 'fraca' }, /ao menos 8/],
      [{ aceiteTermos: false }, /termos de uso/i],
      [{ email: 'nao-e-email' }, /E-mail inválido/i],
      [{ name: 'Ana' }, /nome e sobrenome/i],
      [{ origem: 'faculdade', origemDetalhe: '' }, /Qual faculdade/i],
      [{ origem: 'inventada' }, /Opção inválida/i],
    ];
    for (const [patch, esperado] of casos) {
      const res = await request(app).post('/api/cadastro').send({ ...CADASTRO_OK, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error, JSON.stringify(patch)).toMatch(esperado);
    }
    expect(lerJSON('pending-registrations.json', []).length).toBe(0);
  });

  // Anti-enumeração: quem preenche o formulário não pode descobrir que aquele
  // e-mail já tem conta. Quem descobre é o DONO do endereço, pelo e-mail.
  it('e-mail já cadastrado responde igual a um cadastro novo, e avisa o dono', async () => {
    const admin = await loginAs('admin');
    await request(app).post('/api/admin/users').set(authHeader(admin))
      .send({ username: 'joao', name: 'João Alves', role: 'therapist', teacherId: '2', password: 'Ab1@cdef', email: 'joao@exemplo.invalid' });
    mailer.limparCapturados();

    const res = await request(app).post('/api/cadastro').send({ ...CADASTRO_OK, email: 'joao@exemplo.invalid' });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    // Nenhuma pendência criada, e o aviso foi pro dono do endereço.
    expect(lerJSON('pending-registrations.json', []).length).toBe(0);
    expect(assuntosEnviados().join('|')).toMatch(/Tentativa de cadastro/);
  });

  it('nome de usuário fica reservado enquanto a pendência não vence', async () => {
    await request(app).post('/api/cadastro').send(CADASTRO_OK);
    const outro = await request(app).post('/api/cadastro').send({ ...CADASTRO_OK, email: 'outra@exemplo.invalid' });
    expect(outro.status).toBe(400);
    expect(outro.body.error).toMatch(/já está em uso/i);
  });

  it('disponibilidade do nome de usuário', async () => {
    const chk = (u) => request(app).get('/api/cadastro/disponibilidade').query({ username: u });
    expect((await chk('ana.externa')).body).toEqual({ disponivel: true, motivo: null });
    expect((await chk('aluno2')).body.motivo).toBe('em-uso');
    expect((await chk('ALUNO2')).body.motivo).toBe('em-uso');
    expect((await chk('admin')).body.motivo).toBe('reservado');
    // Rótulo de papel é reservado antes de ser "em uso" — a checagem de
    // reservado vem primeiro, e é a resposta mais útil pra tela.
    expect((await chk('aluno')).body.motivo).toBe('reservado');
    expect((await chk('a$')).body.motivo).toBe('formato');
  });

  it('confirmar com token inválido ou vazio não cria nada', async () => {
    for (const body of [{}, { token: '' }, { token: 'lixo' }, { token: 'a'.repeat(43) }]) {
      const res = await request(app).post('/api/confirmar-email').send(body);
      expect(res.status).toBe(400);
    }
    expect(lerJSON('users.json', []).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('recuperação de senha', () => {
  beforeEach(limpar);

  async function comEmail(email = 'aluno@exemplo.invalid') {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/users/3').set(authHeader(admin)).send({ email });
    mailer.limparCapturados();
    return email;
  }

  it('fluxo completo: pede, redefine, senha antiga morre e sessões caem', async () => {
    const email = await comEmail();
    const sessaoAntiga = await loginAs('aluno');

    expect((await request(app).post('/api/senha/esqueci').send({ email })).status).toBe(200);
    const token = tokenDoUltimoEmail('Redefinir sua senha');

    const red = await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Nova@Senha1' });
    expect(red.status).toBe(200);

    expect((await request(app).post('/api/login').send({ username: 'aluno', password: TEST_PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/login').send({ username: 'aluno', password: 'Nova@Senha1' })).status).toBe(200);
    // Se o reset foi por invasão, o token do invasor tem que morrer com a senha.
    expect((await request(app).get('/api/me').set(authHeader(sessaoAntiga))).status).toBe(401);
    // Uso único.
    expect((await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Outra@Senha1' })).status).toBe(400);
  });

  it('e-mail sem conta: resposta idêntica e NENHUM e-mail enviado', async () => {
    const res = await request(app).post('/api/senha/esqueci').send({ email: 'ninguem@exemplo.invalid' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // De propósito: mandar "não há conta com este e-mail" viraria um disparador
    // de mensagem pra endereço arbitrário, gastando a cota da caixa da Allos.
    expect(mailer.emailsCapturados()).toHaveLength(0);
  });

  it('a senha nova respeita o piso do perfil de quem está redefinindo', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/users/1').set(authHeader(admin)).send({ email: 'admin@exemplo.invalid' });
    mailer.limparCapturados();
    await request(app).post('/api/senha/esqueci').send({ email: 'admin@exemplo.invalid' });
    const token = tokenDoUltimoEmail('Redefinir sua senha');
    const res = await request(app).post('/api/senha/redefinir').send({ token, newPassword: 'Ab1@cdef' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ao menos 12/);
  });

  it('novo pedido invalida o link anterior', async () => {
    const email = await comEmail();
    await request(app).post('/api/senha/esqueci').send({ email });
    const primeiro = tokenDoUltimoEmail('Redefinir sua senha');
    mailer.limparCapturados();
    await request(app).post('/api/senha/esqueci').send({ email });
    const segundo = tokenDoUltimoEmail('Redefinir sua senha');
    expect(segundo).not.toBe(primeiro);
    expect((await request(app).post('/api/senha/redefinir').send({ token: primeiro, newPassword: 'Nova@Senha1' })).status).toBe(400);
    expect((await request(app).post('/api/senha/redefinir').send({ token: segundo, newPassword: 'Nova@Senha1' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('troca de e-mail do próprio usuário', () => {
  beforeEach(limpar);

  // Era o caminho de sequestro: uma sessão roubada apontava o e-mail pra si,
  // pedia reset e ficava com a conta.
  it('PUT /api/users/:id não altera mais o e-mail', async () => {
    const token = await loginAs('aluno');
    const res = await request(app).put('/api/users/3').set(authHeader(token))
      .send({ name: 'Aluno Renomeado', email: 'invasor@exemplo.invalid' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aluno Renomeado');
    expect(res.body.email || '').not.toBe('invasor@exemplo.invalid');
  });

  it('exige a senha atual e confirma o endereço novo por link', async () => {
    const token = await loginAs('aluno');

    const semSenha = await request(app).post('/api/me/email').set(authHeader(token))
      .send({ novoEmail: 'novo@exemplo.invalid', senhaAtual: 'errada' });
    expect(semSenha.status).toBe(401);

    const ok = await request(app).post('/api/me/email').set(authHeader(token))
      .send({ novoEmail: 'novo@exemplo.invalid', senhaAtual: TEST_PASSWORD });
    expect(ok.status).toBe(200);
    // Ainda NÃO trocou — só depois de confirmar.
    expect(lerJSON('users.json', []).find((u) => u.id === '3').emailLower || '').not.toBe('novo@exemplo.invalid');

    const linkToken = tokenDoUltimoEmail('Confirme seu novo e-mail');
    const conf = await request(app).post('/api/confirmar-email').send({ token: linkToken });
    expect(conf.status).toBe(200);
    expect(conf.body.tipo).toBe('troca-email');

    const atualizado = lerJSON('users.json', []).find((u) => u.id === '3');
    expect(atualizado.emailLower).toBe('novo@exemplo.invalid');
    expect(atualizado.emailVerified).toBe(true);
  });

  // O campo era texto livre antes desta versão, então pode haver conta antiga com
  // e-mail malformado. Validar em toda edição travaria o admin fora dessas
  // contas até ele arrumar um campo que não é o assunto dele naquele momento.
  it('admin edita conta com e-mail legado malformado sem ser barrado', async () => {
    const fs = require('fs');
    const path = require('path');
    const arquivo = path.join(DATA_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
    users.find((u) => u.id === '3').email = 'isso nao e um email';
    fs.writeFileSync(arquivo, JSON.stringify(users, null, 2));

    const admin = await loginAs('admin');
    const res = await request(app).put('/api/admin/users/3').set(authHeader(admin))
      .send({ name: 'Aluno Renomeado' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aluno Renomeado');

    // Mas trocar PARA um e-mail inválido continua sendo recusado.
    const ruim = await request(app).put('/api/admin/users/3').set(authHeader(admin))
      .send({ email: 'outro invalido' });
    expect(ruim.status).toBe(400);
    expect(ruim.body.error).toMatch(/E-mail inválido/i);
  });

  it('recusa e-mail que já pertence a outra conta', async () => {
    const admin = await loginAs('admin');
    await request(app).put('/api/admin/users/5').set(authHeader(admin)).send({ email: 'ocupado@exemplo.invalid' });
    const token = await loginAs('aluno');
    const res = await request(app).post('/api/me/email').set(authHeader(token))
      .send({ novoEmail: 'ocupado@exemplo.invalid', senhaAtual: TEST_PASSWORD });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('permissões do Aluno Externo', () => {
  beforeEach(limpar);

  async function criarExterno() {
    await request(app).post('/api/cadastro').send(CADASTRO_OK);
    const token = tokenDoUltimoEmail('Confirme seu cadastro');
    const conf = await request(app).post('/api/confirmar-email').send({ token });
    return conf.body.token;
  }

  it('usa a plataforma como aluno, mas não alcança rota de supervisor nem de admin', async () => {
    const token = await criarExterno();
    expect((await request(app).get('/api/antessala').set(authHeader(token))).status).toBe(200);
    expect((await request(app).get('/api/duel/opponents').set(authHeader(token))).status).toBe(200);
    expect((await request(app).get('/api/admin/users').set(authHeader(token))).status).toBe(403);
    expect((await request(app).get('/api/teacher/students').set(authHeader(token))).status).toBe(403);
    expect((await request(app).get('/api/antessala/supervisor').set(authHeader(token))).status).toBe(403);
    expect((await request(app).get('/api/admin/export').set(authHeader(token))).status).toBe(403);
  });

  it('recebe log só o próprio e sem as notas por critério', async () => {
    const token = await criarExterno();
    const res = await request(app).get('/api/logs').set(authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.every((l) => !('criteriaScores' in l))).toBe(true);
  });

  // Nasce sem supervisor, mas o vínculo continua sendo possível — foi a opção
  // escolhida no desenho do papel.
  it('admin pode vincular o aluno externo a um supervisor depois', async () => {
    await criarExterno();
    const admin = await loginAs('admin');
    const externo = lerJSON('users.json', []).find((u) => u.username === 'ana.externa');

    const res = await request(app).put(`/api/admin/users/${externo.id}`).set(authHeader(admin))
      .send({ teacherId: '2' });
    expect(res.status).toBe(200);
    expect(res.body.teacherId).toBe('2');
    expect(res.body.teacherName).toBe('Professor A');

    // E aí ele aparece na lista de alunos daquele supervisor.
    const prof = await loginAs('prof');
    const alunos = await request(app).get('/api/teacher/students').set(authHeader(prof));
    expect(alunos.body.map((u) => u.username)).toContain('ana.externa');
  });
});
