// Fila local na frente da Batch API (server/batch-fila.js) — a régua que decide
// quem entra agora, quem espera e quem vira erro de verdade.
//
// O caso que deu origem a isto: seis runs do pipeline disparadas em 25 segundos
// em 26/08/2026. Três entraram; as outras três voltaram com
// `token_limit_exceeded` ("Limit: 2,000,000 enqueued tokens") e o coletor as
// marcava como erro definitivo — aluno sem nota por um teto que se resolve
// esperando. Aqui trava-se o contrário: fila cheia é ESPERA, não erro.
const fila = require('../server/batch-fila');

// Recusa por fila cheia, no formato que a OpenAI devolve em batches.retrieve.
function batchFilaCheia(limite = '2,000,000') {
  return {
    status: 'failed',
    errors: { object: 'list', data: [{
      code: 'token_limit_exceeded',
      message: `Enqueued token limit reached for gpt-5.6-luna in organization org-X. Limit: ${limite} enqueued tokens. Please try again once some in_progress batches have been completed.`,
    }] },
  };
}

const estimar = (s) => Math.ceil(String(s || '').length / 3.5);

describe('Fila de batch — classificação da falha', () => {
  beforeEach(() => fila._resetTetos());

  it('fila cheia é espera: não conta tentativa e não vira erro', () => {
    const r = fila.classificarFalha(batchFilaCheia(), 0);
    expect(r.acao).toBe('espera');
    expect(r.motivo).toMatch(/Enqueued token limit/);
    expect(r.teto).toBe(2000000);
  });

  it('fila cheia continua espera mesmo depois de muitas tentativas', () => {
    // É o ponto do desenho: esperar é a solução, então não há orçamento de
    // tentativas a estourar. Uma avaliação pode ficar na fila o tempo que for.
    const r = fila.classificarFalha(batchFilaCheia(), 50);
    expect(r.acao).toBe('espera');
  });

  it('expirado volta para a fila (faltou tempo, não deu erro)', () => {
    const r = fila.classificarFalha({ status: 'expired' }, 0);
    expect(r.acao).toBe('retenta');
    expect(r.expirou).toBe(true);
  });

  it('cancelado é decisão humana e não volta sozinho', () => {
    expect(fila.classificarFalha({ status: 'cancelled' }, 0).acao).toBe('erro');
  });

  it('transitório comum retenta até o teto de tentativas e então desiste', () => {
    const erro = { status: 'failed', errors: { data: [{ code: 'server_error', message: 'oops' }] } };
    expect(fila.classificarFalha(erro, 0).acao).toBe('retenta');
    const ultimo = fila.classificarFalha(erro, fila.MAX_TENTATIVAS - 1);
    expect(ultimo.acao).toBe('erro');
    expect(ultimo.motivo).toMatch(/desistiu após/);
  });

  it('erro de payload é definitivo e carrega a mensagem da OpenAI', () => {
    const erro = { status: 'failed', errors: { data: [{ code: 'invalid_request', message: 'model não existe' }] } };
    const r = fila.classificarFalha(erro, 0);
    expect(r.acao).toBe('erro');
    expect(r.motivo).toBe('model não existe');
  });

  it('falha sem errors[] ainda produz uma mensagem utilizável', () => {
    expect(fila.classificarFalha({ status: 'failed' }, 0).motivo).toBe('batch failed');
  });
});

describe('Fila de batch — teto por modelo', () => {
  beforeEach(() => fila._resetTetos());

  it('lê o teto da mensagem de recusa, com separador de milhar', () => {
    expect(fila.extrairTetoDaMensagem('Limit: 2,000,000 enqueued tokens')).toBe(2000000);
    expect(fila.extrairTetoDaMensagem('Limit: 90,000 enqueued tokens.')).toBe(90000);
    expect(fila.extrairTetoDaMensagem('nada disso aqui')).toBe(null);
  });

  it('o teto aprendido na recusa passa a valer para as próximas decisões', () => {
    // Antes de aprender, vale o palpite conservador da tabela.
    expect(fila.tetoDoModelo('gpt-5.5-2026-04-23')).toBe(2000000);
    fila.aprenderTeto('gpt-5.5', 300000);
    expect(fila.tetoDoModelo('gpt-5.5-2026-04-23')).toBe(300000);
    // E não contamina outro modelo.
    expect(fila.tetoDoModelo('gpt-5.6-luna')).toBe(2000000);
  });
});

describe('Fila de batch — quanto cabe', () => {
  beforeEach(() => fila._resetTetos());

  it('a requisição reserva input + TETO de saída, não o que vai gastar', () => {
    // 350 chars ≈ 100 tokens de input, e um teto de 16k que a OpenAI reserva
    // inteiro mesmo que o nó devolva quatro linhas.
    const body = { messages: [{ role: 'user', content: 'x'.repeat(350) }], max_completion_tokens: 16000 };
    expect(fila.tokensDaRequisicao(body, estimar)).toBe(16100);
    // GLM/outros usam max_tokens; a conta é a mesma.
    const glm = { messages: [{ role: 'user', content: 'x'.repeat(350) }], max_tokens: 8000 };
    expect(fila.tokensDaRequisicao(glm, estimar)).toBe(8100);
  });

  it('espaço livre desconta o que está em voo e guarda a margem de segurança', () => {
    const teto = 2000000 * fila.FATOR_SEGURANCA;
    expect(fila.espacoLivre('gpt-5.6-luna', 0)).toBe(Math.floor(teto));
    expect(fila.espacoLivre('gpt-5.6-luna', 1000000)).toBe(Math.floor(teto) - 1000000);
    expect(fila.espacoLivre('gpt-5.6-luna', 99999999)).toBe(0);
  });

  it('soma o que está em voo só do modelo pedido, ignorando entradas velhas', () => {
    const agora = Date.now();
    const ledger = [
      { batchId: 'b1', model: 'gpt-5.6-luna', tokens: 500000, criadoEm: new Date(agora - 1000).toISOString() },
      { batchId: 'b2', model: 'gpt-5.6-luna', tokens: 500000, criadoEm: new Date(agora - 1000).toISOString() },
      { batchId: 'b3', model: 'gpt-5.5', tokens: 900000, criadoEm: new Date(agora - 1000).toISOString() },
      // Mais velha que a janela de 24h: o batch já não ocupa fila nenhuma.
      { batchId: 'b4', model: 'gpt-5.6-luna', tokens: 700000, criadoEm: new Date(agora - 30 * 60 * 60 * 1000).toISOString() },
    ];
    expect(fila.tokensEmVooDe(ledger, 'gpt-5.6-luna', agora)).toBe(1000000);
    expect(fila.tokensEmVooDe(ledger, 'gpt-5.5', agora)).toBe(900000);
    expect(fila.tokensEmVooDe(ledger, 'gpt-5.4', agora)).toBe(0);
  });
});

describe('Fila de batch — divisão em lotes', () => {
  beforeEach(() => fila._resetTetos());
  const itens = (n, tokens) => Array.from({ length: n }, (_, i) => ({ id: 'i' + i, tokens }));

  it('20 pendentes de 64k viram um lote só quando cabem', () => {
    // O caso da Trilha: 20 alunos × (input + teto de 64k).
    const lotes = fila.dividirEmLotes({ itens: itens(20, 70000), model: 'gpt-5.6-luna', tokensEmVoo: 0 });
    expect(lotes.length).toBe(1);
    expect(lotes[0].length).toBe(20);
  });

  it('corta no espaço livre e deixa o resto para o próximo ciclo', () => {
    // Livre = 1.7M (85% de 2M). Cabem 24 itens de 70k (1,68M); o 25º não cabe.
    const lotes = fila.dividirEmLotes({ itens: itens(40, 70000), model: 'gpt-5.6-luna', tokensEmVoo: 0 });
    const enviados = lotes.reduce((s, l) => s + l.length, 0);
    expect(enviados).toBe(24);
    expect(enviados).toBeLessThan(40);
  });

  it('com a fila quase cheia, não manda nada — ninguém é descartado', () => {
    const lotes = fila.dividirEmLotes({ itens: itens(5, 500000), model: 'gpt-5.6-luna', tokensEmVoo: 1690000 });
    expect(lotes).toEqual([]);
  });

  it('item maior que o teto do modelo vai sozinho, para a recusa ser explícita', () => {
    // Não pode ficar preso para sempre esperando um espaço que nunca existe.
    const lotes = fila.dividirEmLotes({ itens: [{ id: 'gigante', tokens: 5000000 }, { id: 'normal', tokens: 1000 }], model: 'gpt-5.6-luna', tokensEmVoo: 0 });
    expect(lotes.length).toBe(1);
    expect(lotes[0]).toEqual([{ id: 'gigante', tokens: 5000000 }]);
  });

  it('respeita o teto de itens por lote quando pedido', () => {
    const lotes = fila.dividirEmLotes({ itens: itens(10, 1000), model: 'gpt-5.6-luna', tokensEmVoo: 0, maxItensPorLote: 3 });
    expect(lotes.map((l) => l.length)).toEqual([3, 3, 3, 1]);
  });
});
