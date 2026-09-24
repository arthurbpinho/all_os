// Semeia um terapeuta de DEMONSTRAÇÃO com histórico de atendimentos avaliados,
// para mostrar o perfil (gráfico de critérios, ranking, MMR) sem chamar IA.
//
// Não é dado real: os atendimentos são inventados, curtos e marcados no texto da
// avaliação. Serve para apresentar a plataforma numa máquina de desenvolvimento.
//
//   node scripts/seed-demo-terapeuta.js [--usuario nome] [--senha senha] [--limpar]
//
// Só roda com DATABASE_URL apontando para um banco LOCAL: um seed destes em
// produção mistura conta falsa com conta real no ranking e no MMR.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { getPool, closePool, query } = require('../server/db');
const { criarRepoContas } = require('../server/repos/contas');
const { criarRepoLogs } = require('../server/repos/logs');
const { criarRepoMmr } = require('../server/repos/mmr');
const engine = require('../server/mmr');
const { finalScoreFromCriteria } = require('../server/scoring');
const criteriosMd = require('../server/criterios-md');

// --- Argumentos --------------------------------------------------------

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const USUARIO = arg('usuario', 'terapeuta.demo');
const SENHA = arg('senha', 'demo1234');
const NOME = arg('nome', 'Marina Ribeiro (demo)');
const LIMPAR = process.argv.includes('--limpar');

// Trava de segurança: o banco tem de ser local. Um seed destes no Neon entra no
// ranking e no MMR de produção junto com as contas reais.
function exigirBancoLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('DATABASE_URL ausente.');
  const host = (url.match(/@([^:/?]+)/) || [])[1] || '';
  const local = ['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host);
  if (!local) {
    throw new Error(
      `Recusado: DATABASE_URL aponta para "${host}", que não é um banco local. ` +
      'Este script é só para demonstração em desenvolvimento.',
    );
  }
}

// --- O histórico inventado ---------------------------------------------

// Perfil da terapeuta: forte no vínculo e na escuta, fraca em priorizar e em
// fechar a lógica do caso. É isso que dá forma ao radar — um octógono achatado
// de um lado é o que torna o gráfico legível numa demonstração.
//
// Cada linha é [notas dos 8 critérios], na ordem da régua. Nota de 0 a 10.
const SESSOES = [
  { dias: 41, item: 'fp1', modo: 'training',    notas: [7, 6, 6, 6, 4, 5, 5, 3] },
  { dias: 37, item: 'fp2', modo: 'training',    notas: [7, 5, 7, 6, 5, 5, 4, 4] },
  { dias: 34, item: 'fp1', modo: 'competitive', notas: [8, 6, 7, 7, 5, 6, 5, 4] },
  { dias: 30, item: 'fp2', modo: 'training',    notas: [8, 7, 8, 7, 5, 6, 6, 4] },
  { dias: 27, item: 'fp1', modo: 'training',    notas: [8, 6, 8, 7, 6, 6, 5, 5] },
  { dias: 24, item: 'fp2', modo: 'competitive', notas: [9, 7, 8, 8, 6, 7, 6, 5] },
  { dias: 20, item: 'fp1', modo: 'training',    notas: [8, 7, 8, 8, 6, 7, 6, 5] },
  { dias: 17, item: 'fp2', modo: 'training',    notas: [9, 8, 9, 8, 7, 7, 7, 5] },
  { dias: 14, item: 'fp1', modo: 'competitive', notas: [9, 7, 9, 8, 7, 8, 7, 6] },
  { dias: 11, item: 'fp2', modo: 'training',    notas: [9, 8, 9, 9, 7, 8, 7, 6] },
  { dias: 7,  item: 'fp1', modo: 'competitive', notas: [9, 8, 9, 9, 8, 8, 8, 6] },
  { dias: 4,  item: 'fp2', modo: 'training',    notas: [10, 8, 9, 9, 8, 8, 8, 7] },
  { dias: 2,  item: 'fp1', modo: 'competitive', notas: [9, 9, 10, 9, 8, 9, 8, 7] },
];

// Transcrição curta: o suficiente para a tela da sessão não abrir vazia. Não
// pretende parecer um atendimento de verdade — e diz isso.
function transcricao(nomePaciente) {
  return [
    { role: 'assistant', content: `Oi... eu sou ${nomePaciente}. Pra ser sincero(a), nem sei bem por onde começar.` },
    { role: 'user', content: 'Tudo bem. Comece por onde fizer sentido pra você — eu acompanho.' },
    { role: 'assistant', content: 'Tem sido difícil dormir. Fico repassando as mesmas coisas a noite inteira.' },
    { role: 'user', content: 'Quando você diz "as mesmas coisas", o que costuma vir primeiro?' },
    { role: 'assistant', content: 'Geralmente o trabalho. E aí emenda na minha mãe, e não para mais.' },
    { role: 'user', content: 'Percebi que os dois assuntos vêm colados. Isso acontece sempre?' },
    { role: 'assistant', content: 'Acho que sim. Nunca tinha reparado desse jeito.' },
    { role: 'user', content: 'Vamos ficar um pouco nisso. Nosso tempo está acabando, mas retomamos na próxima.' },
  ];
}

const AVALIACAO = [
  '**[Sessão de demonstração — texto fictício, não gerado por IA.]**',
  '',
  'O vínculo se estabelece rápido e a escuta sustenta o silêncio sem correr para',
  'preencher. A devolução que conecta trabalho e mãe é o melhor momento da sessão.',
  '',
  'O que ainda pesa: o material aparece em abundância e a escolha do que perseguir',
  'fica para o fim, quando já não há tempo de aprofundar. Priorizar mais cedo é o',
  'ponto de crescimento mais claro deste histórico.',
].join('\n');

// --- Execução ----------------------------------------------------------

async function main() {
  exigirBancoLocal();
  const pool = getPool();
  const contas = criarRepoContas(pool);
  const logs = criarRepoLogs(pool);
  const mmr = criarRepoMmr(pool);

  // Critérios da régua ativa: o gráfico casa critério pelo NOME, então o log
  // precisa gravar os nomes junto (server/criterios-perfil.js).
  // Filtra pela régua do avaliador oficial: outras réguas (ou uma futura) têm os
  // próprios critérios, e misturá-las produziria nomes fora de ordem.
  const { rows: criterios } = await query(
    'SELECT ordem, nome FROM criterios WHERE ativo AND regua = $1 ORDER BY ordem',
    [criteriosMd.REGUA],
  );
  if (!criterios.length) throw new Error('Nenhum critério ativo na tabela `criterios` — suba o servidor uma vez antes.');
  const criteriaNames = Object.fromEntries(criterios.map((c) => [String(c.ordem), c.nome]));

  // Pacientes do catálogo, para o log apontar para item que existe.
  const { rows: pacientes } = await query(
    "SELECT id, doc->>'name' AS nome FROM catalogo_itens WHERE tipo = 'freeplay'",
  );
  if (pacientes.length < 2) throw new Error('O catálogo precisa de pelo menos 2 pacientes freeplay.');
  const nomeDoPaciente = Object.fromEntries(pacientes.map((p) => [p.id, p.nome || p.id]));
  // As sessões abaixo falam em 'fp1'/'fp2'; aqui isso vira os dois primeiros
  // pacientes que o catálogo REALMENTE tem, quaisquer que sejam os ids. Sem
  // isso, o seed gravaria logs apontando para paciente inexistente e a tela
  // mostraria o id cru no lugar do nome.
  const alvo = { fp1: pacientes[0].id, fp2: pacientes[1].id };

  const existente = await contas.porUsername(USUARIO);
  if (existente && !LIMPAR) {
    console.log(`A conta "${USUARIO}" já existe (id ${existente.id}). Use --limpar para refazer o histórico.`);
    return;
  }

  let conta = existente;
  if (existente && LIMPAR) {
    await query('DELETE FROM logs WHERE user_id = $1', [existente.id]);
    await query('DELETE FROM mmr_players WHERE user_id = $1', [existente.id]);
    await query('DELETE FROM character_records WHERE user_id = $1', [existente.id]);
    console.log(`Histórico anterior de "${USUARIO}" apagado.`);
  } else {
    conta = await contas.criar({
      username: USUARIO,
      name: NOME,
      role: 'therapist',
      email: `${USUARIO}@exemplo.invalid`,
      emailVerified: true,
      teacherId: null,
      gender: 'feminino',
      abordagem: 'Psicanálise',
      sidequestsEnabled: true,
      passwordHash: bcrypt.hashSync(SENHA, 10),
    });
    console.log(`Conta criada: ${USUARIO} (id ${conta.id}), papel therapist.`);
  }

  // O MMR vai pelo MESMO caminho de uma partida de verdade: `mmr.aplicar`, que
  // trava o paciente e o jogador numa transação e grava só o que o cálculo
  // devolve.
  //
  // NÃO use `mmr.importar` aqui: ele TRUNCA mmr_players, mmr_characters e
  // mmr_anon_players antes de inserir. Num banco que já tem gente — e o alvo
  // natural deste seed é um banco restaurado do volume — isso apagaria o MMR de
  // todo mundo, a dificuldade de todos os pacientes e as populações do TRI.
  let jogador = null;
  const agora = Date.now();
  let criados = 0;

  for (const s of SESSOES) {
    s.item = alvo[s.item] || s.item;
    // O perfil de notas tem 8 valores (a régua de origem). Se o admin
    // acrescentou critérios, o perfil se repete ciclicamente — o seed acompanha
    // a régua que existe, em vez de gravar notas de 8 posições com nomes de N.
    const notas = Object.fromEntries(
      criterios.map((c, i) => [String(c.ordem), s.notas[i % s.notas.length]]),
    );
    const score = finalScoreFromCriteria(notas);
    const quando = new Date(agora - s.dias * 24 * 60 * 60 * 1000);
    const id = `demo-${conta.id}-${s.dias}`;

    let mmrBefore = null;
    let mmrAfter = null;
    if (s.modo === 'competitive') {
      const r = await mmr.aplicar(
        { characterId: s.item, userIds: [String(conta.id)], fonte: 'competitivo' },
        ({ players, character }) => {
          const out = engine.updateMatch(players[String(conta.id)], character, score);
          jogador = out.player;
          return {
            players: { [String(conta.id)]: out.player },
            character: out.character,
            contarFonte: !out.result.calibratingBefore,
            result: out.result,
          };
        },
      );
      mmrBefore = Math.round(r.P_before);
      mmrAfter = Math.round(r.P_after);
    }

    await logs.criar({
      id,
      timestamp: quando.toISOString(),
      userId: String(conta.id),
      userName: NOME,
      type: 'freeplay',
      mode: s.modo,
      itemId: s.item,
      itemTitle: nomeDoPaciente[s.item] || s.item,
      durationSeconds: 1500 + (s.dias % 7) * 120,
      score,
      criteriaScores: notas,
      criteriaNames,
      evaluation: AVALIACAO,
      evalVersion: 'v34',
      evaluationPending: false,
      messages: transcricao(nomeDoPaciente[s.item] || 'o paciente'),
      ...(mmrBefore === null ? {} : { mmrBefore, mmrAfter }),
    });
    criados += 1;
  }

  // Recorde 👑 do melhor competitivo, para o card do paciente não ficar vazio.
  const notasDe = (s) => Object.fromEntries(
    criterios.map((c, i) => [String(c.ordem), s.notas[i % s.notas.length]]),
  );
  const melhor = SESSOES
    .filter((s) => s.modo === 'competitive')
    .map((s) => ({ item: s.item, score: finalScoreFromCriteria(notasDe(s)) }))
    .sort((a, b) => b.score - a.score)[0];
  if (melhor) {
    await mmr.registrarRecorde(melhor.item, melhor.score, {
      userId: String(conta.id), userName: NOME, userPhoto: '',
    });
  }

  const medias = criterios.map((c, i) => {
    const soma = SESSOES.reduce((a, s) => a + s.notas[i % s.notas.length], 0);
    return `  ${String(c.nome).padEnd(26)} ${(soma / SESSOES.length).toFixed(1)}`;
  });

  console.log(`\n${criados} atendimentos avaliados gravados.`);
  console.log(jogador
    ? `MMR final: ${Math.round(jogador.P)} (${jogador.n} partidas competitivas).`
    : 'Sem partidas competitivas nesta série.');
  console.log(`Recorde 👑: ${melhor.score} em ${nomeDoPaciente[melhor.item] || melhor.item}.`);
  console.log('\nMédia por critério (o que o radar vai desenhar):');
  console.log(medias.join('\n'));
  console.log(`\nEntre com  usuário: ${USUARIO}  ·  senha: ${SENHA}`);
}

main()
  .catch((e) => { console.error(`\n${e.message}`); process.exitCode = 1; })
  .finally(() => closePool());
