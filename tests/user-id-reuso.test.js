const { app, request, resetData, authHeader, DATA_DIR } = require('./helpers');
const mailer = require('../server/email');
const fs = require('fs'); const path = require('path');

function tokenDoEmail(a){const e=mailer.emailsCapturados().reverse().find(x=>x.subject.includes(a));return /token=([A-Za-z0-9_-]+)/.exec(e.text)[1];}
async function cadastrar(username, email){
  await request(app).post('/api/cadastro').send({ username, name:'Fulano Silva', email,
    password:'Ab1@cdef', origem:'instagram', aceiteTermos:true });
  const c = await request(app).post('/api/confirmar-email').send({ token: tokenDoEmail('Confirme seu cadastro') });
  return c.body;
}

beforeEach(resetData);

// REGRESSÃO. `nextUserId` era max(ids)+1, e o máximo CAI quando a conta de id
// mais alto é excluída: o cadastro seguinte reciclava o id e herdava os logs, o
// MMR, as notificações e as conquistas de quem tinha saído. Hoje o contador é
// monotônico (counters.json → __meta.lastUserId) e nunca reemite um id.
test('id de conta excluída NUNCA é reemitido para outra pessoa', async () => {
  // Vítima se cadastra e produz uma sessão com conteúdo clínico.
  const vitima = await cadastrar('vitima', 'vitima@exemplo.invalid');
  const idVitima = vitima.user.id;

  await request(app).post('/api/logs').set(authHeader(vitima.token)).send({
    type:'freeplay', itemId:'fp-test-1', itemTitle:'Sofia Test',
    messages:[{ role:'user', content:'CONTEUDO CLINICO SENSIVEL DA VITIMA' }],
    evaluation:'Avaliação da vítima', score: 8,
  }).expect(200);

  // Ela exclui a conta pelo Perfil.
  await request(app).delete('/api/me').set(authHeader(vitima.token))
    .send({ password:'Ab1@cdef' }).expect(200);

  // Qualquer pessoa se cadastra depois — e recebe o MESMO id.
  const proximo = await cadastrar('proximo', 'proximo@exemplo.invalid');
  expect(proximo.user.id).not.toBe(idVitima);

  // E, com id próprio, não enxerga nada do histórico de quem saiu.
  const meusLogs = await request(app).get(`/api/logs?userId=${proximo.user.id}`)
    .set(authHeader(proximo.token));
  expect(JSON.stringify(meusLogs.body)).not.toContain('CONTEUDO CLINICO SENSIVEL DA VITIMA');

  // Nem pedindo o id da vítima na mão.
  const bisbilhotando = await request(app).get(`/api/logs?userId=${idVitima}`)
    .set(authHeader(proximo.token));
  expect(JSON.stringify(bisbilhotando.body)).not.toContain('CONTEUDO CLINICO SENSIVEL DA VITIMA');

  // E o id continua fora de circulação depois de mais um cadastro.
  const terceiro = await cadastrar('terceiro', 'terceiro@exemplo.invalid');
  expect(terceiro.user.id).not.toBe(idVitima);
  expect(terceiro.user.id).not.toBe(proximo.user.id);
});
