// Processo Seletivo — feedback prévio (IA) por e-mail.
//
// O que este arquivo garante:
//   1. a escolha Sim/Não é obrigatória no /iniciar e vai assinada no token;
//   2. só quem marcou "Sim" recebe e-mail, e só depois da avaliação terminar;
//   3. o e-mail leva o texto QUALITATIVO — nenhuma nota final ou por critério;
//   4. avaliação com erro não vira e-mail, e o desfecho do envio fica no log.
// IMPORTANTE: helpers seta as envs antes de importar o app — manter como 1º require.
const { app, request, resetData, db } = require('./helpers');
const mailer = require('../server/email');

const CAMPOS = {
  password: 'allos01',
  nome: 'Ana Silva',
  email: 'ana@exemplo.invalid',
  whatsapp: '(11) 91234-5678',
  faculdade: 'USP',
  periodo: '7º',
  consent: true,
};

// Resultado do pipeline como o batch devolveria. O corpo traz de propósito uma
// linha de nota e uma "N/10" para provar que o filtro do e-mail as derruba.
const RESULTADO = {
  notaFinal: 72,
  considerados: 1,
  partes: [{ num: 1, nome: 'Comunicação', nota: 7, analise: 'Leitura do nó.' }],
  corpoSintetizador: [
    'Você sustentou **bem** a escuta nos primeiros minutos.',
    '',
    'Nota final: 72/100',
    '',
    'Na comunicação ficou em 7/10.',
    '',
    'Na próxima sessão, *nomeie* o afeto antes de perguntar.',
  ].join('\n'),
};

// Os logs do seletivo como estão no banco, em ordem de criação.
async function lerLogs() {
  const { rows } = await db.query('SELECT doc FROM selecao_logs ORDER BY criado_em, id');
  return rows.map((r) => r.doc);
}

async function fazerExercicio(extra) {
  const start = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, ...extra });
  expect(start.status).toBe(200);
  await request(app).post('/api/selecao/finish')
    .set({ Authorization: `Bearer ${start.body.token}` })
    .send({ messages: [{ role: 'assistant', content: 'Olá.' }, { role: 'user', content: 'Como você está?' }], durationSeconds: 60 });
  return (await lerLogs()).at(-1);
}

function feedbacksEnviados() {
  return mailer.emailsCapturados().filter((e) => e.subject === 'FEEDBACK PRÉVIO (IA) - Associação Allos');
}

describe('Processo Seletivo — feedback prévio (IA)', () => {
  beforeEach(async () => { await resetData(); mailer.limparCapturados(); });

  it('a escolha Sim/Não é obrigatória e precisa ser booleana', async () => {
    const semEscolha = await request(app).post('/api/selecao/iniciar').send(CAMPOS);
    expect(semEscolha.status).toBe(400);
    const texto = await request(app).post('/api/selecao/iniciar').send({ ...CAMPOS, feedbackIA: 'sim' });
    expect(texto.status).toBe(400);
  });

  it('"Sim": ao fechar a avaliação sai o e-mail só com o texto qualitativo, sem nota', async () => {
    const log = await fazerExercicio({ feedbackIA: true });
    expect(log.feedbackIA).toBe(true);
    // Nada sai antes de a avaliação terminar.
    expect(feedbacksEnviados()).toHaveLength(0);

    await app.__test.finalizeSelectionEvals([log.id], new Map([[log.id, { result: RESULTADO }]]), 'sem resultado');

    const enviados = feedbacksEnviados();
    expect(enviados).toHaveLength(1);
    const [email] = enviados;
    expect(email.to).toBe('ana@exemplo.invalid');
    // Aviso vermelho no topo, feedback no meio, rodapé com os três links.
    expect(email.html).toContain('#c62828');
    expect(email.html.indexOf('inteligência artificial')).toBeLessThan(email.html.indexOf('sustentou'));
    expect(email.html).toContain('<strong>bem</strong>');
    expect(email.html).toContain('<em>nomeie</em>');
    expect(email.html).toContain('Como posso melhorar minhas competências clínicas?');
    expect(email.html).toContain('https://chat.whatsapp.com/JpZtYWJovU03VlrZJ5oUxQ');
    expect(email.html).toContain('https://allos.org.br/formacao');
    expect(email.html).toContain('https://treinamento.allos.org.br/cadastro');
    // Nenhuma nota, em nenhuma das versões.
    for (const corpo of [email.html, email.text]) {
      expect(corpo).not.toMatch(/nota final/i);
      expect(corpo).not.toContain('72');
      expect(corpo).not.toContain('7/10');
    }

    const depois = (await lerLogs()).find((l) => l.id === log.id);
    expect(depois.status).toBe('ativo');
    // Sem Graph configurado nos testes: fica registrado que não saiu por isso.
    expect(depois.feedbackEmail.estado).toBe('nao-configurado');
  });

  it('"Não": a avaliação fecha e nenhum e-mail é enviado', async () => {
    const log = await fazerExercicio({ feedbackIA: false });
    expect(log.feedbackIA).toBe(false);
    await app.__test.finalizeSelectionEvals([log.id], new Map([[log.id, { result: RESULTADO }]]), 'sem resultado');
    expect(feedbacksEnviados()).toHaveLength(0);
    expect((await lerLogs()).find((l) => l.id === log.id).feedbackEmail).toBeUndefined();
  });

  it('avaliação com erro não vira e-mail, mesmo com "Sim"', async () => {
    const log = await fazerExercicio({ feedbackIA: true });
    await app.__test.finalizeSelectionEvals([log.id], new Map(), 'sem resultado no batch');
    expect((await lerLogs()).find((l) => l.id === log.id).status).toBe('erro');
    expect(feedbacksEnviados()).toHaveLength(0);
  });

  it('filtro de notas derruba linhas de nota e mantém o resto', () => {
    const limpo = mailer.feedbackSemNotas('Bom começo.\n\n**Nota:** 8\n\nNota final: 64/100\n\nCritério 2: 6/10\n\nSiga assim.');
    expect(limpo).toBe('Bom começo.\n\nSiga assim.');
  });
});
