// Semeia candidatos FICTÍCIOS do Processo Seletivo, para a tela
// /selecao/logs e o dashboard não ficarem vazios numa demonstração.
//
//   node scripts/seed-demo-selecao.js [--quantos 12] [--limpar]
//
// Os dados reais do Seletivo não foram importados de propósito (os logs do
// candidato contêm a transcrição da simulação). Este script põe no lugar
// candidatos inventados, com nome, e-mail e WhatsApp claramente falsos.
//
// Só roda com DATABASE_URL apontando para um banco LOCAL.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getPool, closePool, query } = require('../server/db');
const { criarRepoSelecao } = require('../server/repos/selecao');

function arg(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const QUANTOS = Math.max(1, Math.min(60, Number(arg('quantos', 12)) || 12));
const LIMPAR = process.argv.includes('--limpar');

function exigirBancoLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url) throw new Error('DATABASE_URL ausente.');
  const host = (url.match(/@([^:/?]+)/) || [])[1] || '';
  if (!['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(host)) {
    throw new Error(`Recusado: DATABASE_URL aponta para "${host}", que não é um banco local.`);
  }
}

// Nomes inventados. O domínio .invalid é reservado por RFC justamente para
// isso: nenhum e-mail daqui pode existir de verdade.
const NOMES = [
  'Beatriz Almeida', 'Caio Fernandes', 'Daniela Moraes', 'Eduardo Pires',
  'Fernanda Rocha', 'Gustavo Lemos', 'Helena Barros', 'Igor Nascimento',
  'Juliana Teixeira', 'Kleber Antunes', 'Larissa Prado', 'Marcelo Vieira',
  'Natália Campos', 'Otávio Rezende', 'Priscila Duarte', 'Rafael Coutinho',
];
const FACULDADES = [
  'UFMG', 'PUC Minas', 'UFRJ', 'USP', 'Newton Paiva', 'UNA', 'UFSJ', 'Estácio',
];
const PERIODOS = ['6º', '7º', '8º', '9º', '10º'];

// Transcrição curta e marcada. Não imita atendimento real.
function transcricao(nomePaciente) {
  return [
    { role: 'assistant', content: `Oi, eu sou ${nomePaciente}. Vim porque não estou dando conta das coisas.` },
    { role: 'user', content: 'Me conta um pouco sobre isso — o que tem pesado mais?' },
    { role: 'assistant', content: 'O trabalho. E em casa também, mas o trabalho é o que mais aperta.' },
    { role: 'user', content: 'Quando você diz que não está dando conta, como isso aparece no seu dia?' },
    { role: 'assistant', content: 'Eu travo. Fico olhando a tela e não sai nada.' },
    { role: 'user', content: 'E o que passa pela sua cabeça nesses momentos em que você trava?' },
    { role: 'assistant', content: 'Que eu vou ser descoberto. Que uma hora vão ver que eu não sei nada.' },
    { role: 'user', content: 'Isso soa pesado de carregar sozinho. Vamos ficar um pouco nesse ponto.' },
  ];
}

const AVALIACAO = (nota) => [
  '**[Candidato de demonstração — texto fictício, não gerado por IA.]**',
  '',
  nota >= 70
    ? 'A escuta sustenta o tempo do candidato e as perguntas abrem material novo em vez de fechar. A devolução final nomeia o que apareceu sem interpretar além do que o material permite.'
    : nota >= 40
      ? 'Há intenção clínica clara e momentos de boa escuta, mas as perguntas se repetem e o material que aparece não é aproveitado. O encerramento chega antes de organizar o que foi dito.'
      : 'A conversa se mantém no nível social: as perguntas buscam informação, não experiência. O que o paciente traz de mais significativo passa sem ser recolhido.',
].join('\n');

// Pesos: a maioria passa, uns poucos ficam pendentes. Reflete a forma da
// distribuição real sem copiar dado nenhum.
function sortearNota(i) {
  const faixa = i % 5;
  if (faixa === 0) return 30 + (i % 9);        // rejeitado (< 40)
  if (faixa === 1) return 45 + (i % 12);
  if (faixa === 2) return 58 + (i % 15);
  if (faixa === 3) return 70 + (i % 14);
  return 80 + (i % 12);
}

async function main() {
  exigirBancoLocal();
  const pool = getPool();
  const selecao = criarRepoSelecao(pool);

  const { rows: pacientes } = await query(
    "SELECT id, doc->>'name' AS nome FROM catalogo_itens WHERE tipo = 'freeplay' ORDER BY ordem",
  );
  if (!pacientes.length) throw new Error('Catálogo de pacientes vazio — importe o catálogo antes.');

  if (LIMPAR) {
    const r = await query("DELETE FROM selecao_logs WHERE id LIKE 'sellog-demo-%'");
    console.log(`${r.rowCount} candidato(s) de demonstração anterior(es) apagado(s).`);
  }

  const agora = Date.now();
  let criados = 0;
  const porStatus = { ativo: 0, rejeitado: 0, pending: 0 };

  for (let i = 0; i < QUANTOS; i++) {
    const nome = NOMES[i % NOMES.length];
    const paciente = pacientes[i % pacientes.length];
    // Um a cada seis fica pendente: é o estado real de quem acabou de terminar
    // e ainda espera o lote da Batch API.
    const pendente = i % 6 === 5;
    const nota = sortearNota(i);
    const status = pendente ? 'pending' : (nota >= 40 ? 'ativo' : 'rejeitado');
    porStatus[status] += 1;

    // Espalhados nos últimos 14 dias (a retenção do Seletivo é de 15).
    const quando = new Date(agora - Math.round((i / QUANTOS) * 13 + 0.5) * 24 * 60 * 60 * 1000);
    const primeiroNome = nome.split(' ')[0].toLowerCase();

    const doc = {
      id: `sellog-demo-${i + 1}`,
      sessionId: `selsess-demo-${i + 1}`,
      timestamp: quando.toISOString(),
      candidate: {
        nome,
        email: `${primeiroNome}.demo@exemplo.invalid`,
        whatsapp: `31900000${String(i + 10).padStart(3, '0')}`,
        faculdade: FACULDADES[i % FACULDADES.length],
        periodo: PERIODOS[i % PERIODOS.length],
      },
      characterId: paciente.id,
      characterName: paciente.nome,
      messages: transcricao(paciente.nome),
      sessionCount: 1 + (i % 2),
      durationSeconds: 1200 + (i % 11) * 180,
      status,
      score: pendente ? null : nota,
      criteriaScores: pendente ? null : Object.fromEntries(
        Array.from({ length: 8 }, (_, k) => [String(k + 1), Math.max(0, Math.min(10, Math.round(nota / 10) + ((k % 3) - 1)))]),
      ),
      evaluation: pendente ? '' : AVALIACAO(nota),
      evalVersion: 'v34',
      feedbackIA: i % 3 === 0,
      ...(pendente ? { evalBatchId: `batch_demo_${i + 1}` } : {}),
      ...(i % 3 === 0 && !pendente
        ? { feedbackEmail: { estado: 'enviado', em: new Date(quando.getTime() + 3600000).toISOString() } }
        : {}),
    };

    if (await selecao.criar(doc, doc.candidate.whatsapp)) criados += 1;
  }

  console.log(`\n${criados} candidato(s) de demonstração criado(s).`);
  console.log(`  ativos     : ${porStatus.ativo}`);
  console.log(`  rejeitados : ${porStatus.rejeitado}`);
  console.log(`  pendentes  : ${porStatus.pending}`);
  console.log('\nVeja em  /selecao/logs  (admin, supervisor ou avaliador).');
}

main()
  .catch((e) => { console.error(`\n${e.message}`); process.exitCode = 1; })
  .finally(() => closePool());
