// Antessala (pré-supervisão) — camada de reflexão da IA.
//
// Este módulo concentra a LÓGICA da camada maiêutica: o system prompt travado,
// as orientações por etapa, as notas estruturais determinísticas e a montagem
// do texto de usuário. Fica no servidor (não no cliente) justamente pra que o
// papel da IA NÃO seja adulterável — é isso que garante o princípio inviolável
// da ferramenta: a IA age sobre a FORMA do pensamento do aluno, nunca sobre o
// CONTEÚDO clínico. Ela pergunta, aponta lacuna e conta padrão; nunca sugere
// fato, saída, risco, conceito, autor ou conduta.
//
// As funções aqui são puras (sem I/O) — o index.js chama buildReflectionPrompt
// e faz a chamada ao modelo com os helpers de IA que já existem lá.

// System prompt (papel travado). Preservado em espírito do protótipo/briefing.
const SYSTEM_BASE = `Você é um assistente de pré-supervisão de uma clínica-escola de psicologia. Seu único papel é maiêutico: fazer perguntas que levem o aluno a refletir melhor sobre aquilo que ELE MESMO escreveu.

REGRA ABSOLUTA E INVIOLÁVEL: você nunca fornece conteúdo clínico. Você não sugere um fato, uma saída clínica, um risco, um conceito, um autor, uma técnica ou uma conduta. Você não introduz nenhum termo clínico que o aluno já não tenha escrito. Se você perceber que está prestes a dizer ao aluno o que pensar do caso, pare e transforme aquilo numa pergunta que devolva a decisão a ele.

O que você PODE fazer:
- Devolver ao aluno as palavras dele e pedir que aprofunde.
- Apontar lacunas estruturais do método (um objetivo sem objeto, uma saída sem risco, um fato sem relação).
- Notar padrões contando o que está escrito (por exemplo: as três saídas deste fato começam com o mesmo verbo).
- Perguntar por coerência entre etapas.

O que você NUNCA faz:
- Dizer o que investigar, confrontar, explorar ou propor.
- Nomear o risco de uma saída. Perguntar "e se o vínculo romper?" já entrega a resposta. O certo é "você escreveu confrontar; que risco você vê em confrontar aqui?".
- Introduzir um conceito, autor ou escola.
- Elogiar, avaliar ou julgar a qualidade clínica do que o aluno escreveu.

Responda com 2 a 4 perguntas curtas e diretas, em português do Brasil, uma por linha, sem preâmbulo e sem fechamento. Só as perguntas.`;

// Orientação específica por etapa (1 a 7).
const GUIA = {
  1: `O aluno deu um título criativo. Pergunte o que nesse título é central e o que é periférico no caso, e se existe uma imagem mais precisa do que está em jogo. Não sugira títulos.`,
  2: `O aluno formula o que fará com o caso. A forma boa é operação mais objeto: um verbo de ação clínica somado àquilo sobre o que ele recai. Se faltar o objeto, se o verbo for genérico demais, ou se houver várias ações embutidas sem escolha, aponte isso como pergunta. Não diga qual verbo ou objeto usar.`,
  3: `O aluno organizou fatos por centralidade e ligou alguns por relações causais. Pergunte sobre fatos que ficaram sem nenhuma relação, sobre centralidades que parecem não conversar com o objetivo, e sobre relações que ele afirmou sem explicar. Não sugira fatos nem relações novas.`,
  4: `O aluno abriu saídas clínicas para cada fato. Se as saídas de um mesmo fato fizerem todas o mesmo tipo de movimento clínico, provoque o aluno a buscar uma saída que faça um movimento incompatível com as outras. Trabalhe apontando a repetição que você conta nos dados; nunca diga qual saída acrescentar.`,
  5: `Para cada saída, o aluno tenta antever o risco de execução embutido nela. Todo verbo costuma carregar o perigo do próprio excesso. Onde faltar risco, pergunte qual seria, citando o verbo que o aluno usou. Nunca nomeie o risco por ele.`,
  6: `O aluno ancora conceitos teóricos no caso. Pergunte se o conceito citado está de fato conectado ao fato ou se é um rótulo solto, e como ele operaria na conduta. Não sugira autores nem conceitos.`,
  7: `O aluno ordenou o que fará na próxima sessão. A ordem é a prioridade. Pergunte se a primeira direção é mesmo a mais urgente, se a ordem reflete o que o mapa mostra, e se alguma direção importante ficou de fora. Não sugira direções.`,
};

const ETAPA_NOMES = {
  1: 'Título',
  2: 'O que você vai fazer',
  3: 'Prioridade',
  4: 'Variações',
  5: 'Armadilhas',
  6: 'Conceitos',
  7: 'Direções',
};

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function nmeFato(doc, id) {
  return (arr(doc.fatos).find((f) => f.id === id)?.texto || '…').slice(0, 40);
}

// Serializa o documento do aluno num texto legível pra IA. Nunca inventa nada:
// só reflete o que o aluno escreveu.
function dumpDoc(doc) {
  const fatos = arr(doc.fatos);
  const variacoes = arr(doc.variacoes);
  const pitfalls = arr(doc.pitfalls);
  const conceitos = arr(doc.conceitos);
  const relacoes = arr(doc.relacoes);
  const direcoes = arr(doc.direcoes);

  let s = `Título: ${doc.titulo || '(vazio)'}\nObjetivo (o que fará com o caso): ${doc.business || '(vazio)'}\n\nFatos:`;
  if (!fatos.length) s += ' (nenhum)';
  fatos.forEach((f) => {
    s += `\n- [centralidade ${f.centralidade}] ${f.texto || '(sem texto)'}`;
    const vs = variacoes.filter((v) => v.fatoId === f.id);
    vs.forEach((v) => {
      s += `\n    saída: ${v.texto || '(sem texto)'}`;
      const ps = pitfalls.filter((p) => p.variacaoId === v.id);
      ps.forEach((p) => {
        s += `\n        armadilha: ${p.flagged ? '(marcada como não enxergada)' : (p.texto || '(sem texto)')}`;
      });
      if (!ps.length) s += `\n        armadilha: (nenhuma)`;
    });
    const cs = conceitos.filter((c) => c.fatoId === f.id);
    cs.forEach((c) => { s += `\n    conceito: ${c.texto || '(sem texto)'}${c.tipo ? ' · ' + c.tipo : ''}`; });
  });
  s += `\n\nRelações causais:`;
  if (!relacoes.length) s += ' (nenhuma)';
  relacoes.forEach((r) => { s += `\n- ${nmeFato(doc, r.origem)} →(${r.descricao || '?'}) ${nmeFato(doc, r.destino)}`; });
  s += `\n\nDireções para a próxima sessão:`;
  if (!direcoes.length) s += ' (nenhuma)';
  direcoes.forEach((d, i) => { s += `\n${i + 1}. ${d.texto || '(sem texto)'}`; });
  return s;
}

// Notas estruturais determinísticas: o que o CÓDIGO conta (modelos contam mal).
// Passadas ao modelo como VERDADE, pra ele apenas formular a pergunta em cima.
function structuralNotes(step, doc) {
  const out = [];
  const fatos = arr(doc.fatos);
  const variacoes = arr(doc.variacoes);
  const pitfalls = arr(doc.pitfalls);
  const relacoes = arr(doc.relacoes);

  if (step === 3) {
    const semRel = fatos.filter((f) => !relacoes.some((r) => r.origem === f.id || r.destino === f.id));
    if (semRel.length) out.push(`Fatos sem nenhuma relação: ${semRel.map((f) => `"${f.texto}"`).join(', ')}.`);
  }
  if (step === 4) {
    fatos.forEach((f) => {
      const vs = variacoes.filter((v) => v.fatoId === f.id);
      if (vs.length === 0) out.push(`O fato "${f.texto}" ainda não tem nenhuma saída.`);
      if (vs.length === 1) out.push(`O fato "${f.texto}" tem só uma saída.`);
      const verbos = vs.map((v) => (v.texto || '').trim().split(/\s+/)[0]?.toLowerCase()).filter(Boolean);
      const rep = verbos.filter((v, i) => verbos.indexOf(v) !== i);
      if (rep.length) out.push(`No fato "${f.texto}", saídas repetem o verbo inicial "${rep[0]}".`);
    });
  }
  if (step === 5) {
    const semPf = variacoes.filter((v) => !pitfalls.some((p) => p.variacaoId === v.id));
    if (semPf.length) out.push(`Saídas sem nenhuma armadilha: ${semPf.map((v) => `"${v.texto}"`).join(', ')}.`);
    const flagged = pitfalls.filter((p) => p.flagged).length;
    if (flagged) out.push(`${flagged} armadilha(s) marcada(s) como não enxergada(s).`);
  }
  return out.join('\n');
}

// Monta { system, userText } pra chamada de reflexão de uma etapa.
function buildReflectionPrompt(step, doc) {
  const n = Number(step);
  const nome = ETAPA_NOMES[n] || `Etapa ${n}`;
  const system = SYSTEM_BASE + '\n\nOrientação para esta etapa:\n' + (GUIA[n] || '');
  const notes = structuralNotes(n, doc);
  const userText =
    `Etapa atual: ${n} — ${nome}. Foque APENAS nesta etapa.\n\n` +
    `Conteúdo do aluno até agora:\n${dumpDoc(doc)}\n\n` +
    (notes ? `Fatos estruturais verdadeiros (use-os nas perguntas, sem inventar outros):\n${notes}\n\n` : '') +
    `Gere as perguntas maiêuticas para a etapa ${n}.`;
  return { system, userText };
}

module.exports = { buildReflectionPrompt, structuralNotes, dumpDoc, SYSTEM_BASE, GUIA };
