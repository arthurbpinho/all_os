// Comunidade: discussões (threads), comentários, votos e enquetes.
//
// Este módulo é a parte PURA do recurso — validação de entrada, resolução do
// selo de autor, contagem de votos, montagem da árvore de comentários e regra
// de banimento. Nada aqui toca disco nem conhece Express; o index.js cuida das
// rotas, do readJSON/writeJSON e do withFileLock. Isso é o que deixa a suite de
// testes exercitar as regras sem subir o servidor inteiro.
//
// Formato de comunidade.json:
//   { nextId: 3, discussions: [ { id, title, body, poll, authorId, author,
//                                 asInstitution, createdAt, votes, comments } ] }
// O id é um inteiro em string ("1", "2", …) de propósito: ele vai na URL
// pública (/comunidade/discussao/1), que as pessoas compartilham por WhatsApp.
// Um uuid ali seria ilegível e impossível de ditar.

const TITLE_MAX = 200;
const BODY_MAX = 10000;
const COMMENT_MAX = 5000;
const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 10;
const POLL_OPTION_MAX = 120;
const MAX_COMMENTS_POR_DISCUSSAO = 2000;

// Papéis que NÃO participam (só leem). Visitante é a sessão anônima que o app
// cria sozinho; ele enxerga a Comunidade inteira mas não escreve nada.
function podeParticipar(role) {
  return role === 'admin' || role === 'supervisor' || role === 'evaluator'
    || role === 'therapist' || role === 'external';
}

// Selo visual do autor. É resolvido na LEITURA a partir do papel atual da
// conta (não congelado no post): quem vira supervisor amanhã passa a aparecer
// como supervisor nas discussões que já escreveu, que é o comportamento que a
// leitura institucional pede. A única coisa congelada é `asInstitution` — essa
// foi uma escolha de quem publicou, não um atributo da conta.
//
//   allos      — Associação Allos (admin publicando institucionalmente)
//   supervisor — "Supervisor da Allos"
//   recruiter  — "Recruiter da Allos" (papel evaluator, Processo Seletivo)
//   member     — membro da Allos (terapeuta; e admin publicando como pessoa)
//   external   — aluno externo, sem vínculo institucional
function authorKind(role, asInstitution) {
  if (asInstitution && role === 'admin') return 'allos';
  if (role === 'supervisor') return 'supervisor';
  if (role === 'evaluator') return 'recruiter';
  if (role === 'external') return 'external';
  if (role === 'admin' || role === 'therapist') return 'member';
  return 'external';
}

const AUTHOR_SUBTITLE = {
  allos: '',
  supervisor: 'Supervisor da Allos',
  recruiter: 'Recruiter da Allos',
  member: '',
  external: '',
};

// Rótulo do papel, para a etiqueta que aparece ao passar o mouse no avatar ou
// no nome. É separado do `kind` porque o kind é VISUAL e agrupa: admin e aluno
// da Allos são os dois `member` (mesmo anel fosco), e a etiqueta precisa
// distinguir os dois. Resolvido aqui, no servidor, pelo mesmo motivo do kind —
// a regra de papel→rótulo não deve existir em dois lugares.
const ROLE_LABEL = {
  admin: 'Administrador',
  supervisor: 'Supervisor da Allos',
  evaluator: 'Recruiter da Allos',
  therapist: 'Aluno da Allos',
  external: 'Aluno Externo',
};

const INSTITUTION_NAME = 'Associação Allos';

function clamp(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

// Normaliza texto vindo do formulário: corta o tamanho, tira espaço nas pontas
// e colapsa sequências absurdas de linhas em branco (um "enter" segurado não
// deve virar dois metros de rolagem na tela de todo mundo).
function texto(v, max) {
  return clamp(v, max).replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

// Valida o corpo de criação de discussão. Devolve {erro} ou {valor}.
function validarDiscussao(body) {
  const b = body || {};
  const title = texto(b.title, TITLE_MAX);
  const corpo = texto(b.body, BODY_MAX);
  if (title.length < 3) return { erro: 'Dê um título à discussão (mínimo 3 caracteres).' };

  let poll = null;
  if (b.poll && Array.isArray(b.poll.options)) {
    // Corta ANTES de mapear: o corpo aceita 10MB, e mapear centenas de milhares
    // de opções só pra recusar depois é trabalho que o atacante escolhe pra nós.
    if (b.poll.options.length > POLL_MAX_OPTIONS * 4) {
      return { erro: `Uma enquete aceita no máximo ${POLL_MAX_OPTIONS} opções.` };
    }
    const options = b.poll.options
      .map((o) => texto(typeof o === 'string' ? o : (o && o.text), POLL_OPTION_MAX))
      .filter((t) => t.length > 0);
    if (options.length < POLL_MIN_OPTIONS) {
      return { erro: `Uma enquete precisa de pelo menos ${POLL_MIN_OPTIONS} opções preenchidas.` };
    }
    if (options.length > POLL_MAX_OPTIONS) {
      return { erro: `Uma enquete aceita no máximo ${POLL_MAX_OPTIONS} opções.` };
    }
    const vistos = new Set();
    for (const t of options) {
      const k = t.toLowerCase();
      if (vistos.has(k)) return { erro: 'A enquete tem opções repetidas.' };
      vistos.add(k);
    }
    poll = {
      options: options.map((text, i) => ({ id: `o${i + 1}`, text })),
      // Escolha do autor no momento da criação: única (padrão) ou múltipla.
      // Fica no post e não muda depois — trocar o tipo com votos já dentro
      // mudaria o significado dos números que as pessoas já viram.
      multi: !!(b.poll && b.poll.multi),
      votes: {},
    };
  }

  // Sem enquete, o texto é o conteúdo — exigir corpo. Com enquete, as opções
  // já são o conteúdo e um corpo vazio é legítimo ("Qual horário vocês
  // preferem?" + opções).
  if (!poll && corpo.length < 3) {
    return { erro: 'Escreva o conteúdo da discussão ou adicione uma enquete.' };
  }
  return { valor: { title, body: corpo, poll } };
}

// Valida a EDIÇÃO de uma discussão (título + texto). Separado de
// validarDiscussao porque as regras não são as mesmas: aqui a enquete não é
// tocada — nem criada, nem alterada, nem removida — e por isso o texto pode
// continuar vazio se a discussão já tem enquete. Editar as opções de uma
// enquete depois de gente ter votado mudaria o significado de votos já dados.
function validarEdicao(body, discussao) {
  const b = body || {};
  const title = texto(b.title, TITLE_MAX);
  const corpo = texto(b.body, BODY_MAX);
  if (title.length < 3) return { erro: 'Dê um título à discussão (mínimo 3 caracteres).' };
  if (!discussao || !discussao.poll) {
    if (corpo.length < 3) return { erro: 'Escreva o conteúdo da discussão.' };
  }
  return { valor: { title, body: corpo } };
}

function validarComentario(body) {
  const corpo = texto(body && body.body, COMMENT_MAX);
  if (corpo.length < 1) return { erro: 'Escreva algo antes de enviar.' };
  return { valor: { body: corpo } };
}

// Voto: aceita 1, -1 e 0 (0 = desfazer). Qualquer outra coisa é recusada em vez
// de virar 0 silenciosamente — um cliente mandando "up" precisa ver o erro.
function normalizarVoto(v) {
  if (v === 1 || v === -1 || v === 0) return v;
  if (v === '1' || v === '-1' || v === '0') return Number(v);
  return null;
}

function aplicarVoto(votes, userId, valor) {
  const m = votes && typeof votes === 'object' ? votes : {};
  if (valor === 0) delete m[userId];
  else m[userId] = valor;
  return m;
}

function score(votes) {
  if (!votes || typeof votes !== 'object') return 0;
  let s = 0;
  for (const v of Object.values(votes)) s += (v === 1 ? 1 : v === -1 ? -1 : 0);
  return s;
}

function meuVoto(votes, userId) {
  if (!userId || !votes) return 0;
  const v = votes[userId];
  return v === 1 || v === -1 ? v : 0;
}

// --- Banimento ---
// Guardado em comunidade-config.json como { bans: { userId: {until, ...} } }.
// A checagem é por data e não por flag: um ban vencido simplesmente para de
// valer, sem precisar de rotina de limpeza.
function banAtivo(config, userId, agora = Date.now()) {
  const bans = (config && config.bans) || {};
  const b = bans[userId];
  if (!b || !b.until) return null;
  const t = new Date(b.until).getTime();
  if (!Number.isFinite(t) || t <= agora) return null;
  return b;
}

function mensagemBan(ban) {
  const ate = new Date(ban.until);
  const data = ate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return `Sua participação na Comunidade está suspensa até ${data}.`
    + (ban.reason ? ` Motivo: ${ban.reason}` : '');
}

// --- Projeções para o cliente ---

// Identidade exibida de um autor. Nome e foto vêm SEMPRE da conta viva em
// users.json — nunca de uma cópia gravada no post. Duas consequências, ambas
// desejadas: quem troca a foto no perfil troca em tudo que já escreveu, e quem
// exclui a conta (DELETE /api/me) some da Comunidade junto, virando "Conta
// removida" sem foto. Guardar nome/foto no post faria a exclusão de conta
// deixar rastro justamente onde ele é mais visível.
//
// O snapshot do post guarda só o `role`, que não identifica ninguém e mantém o
// selo coerente quando a conta some. Publicação institucional é a exceção que
// sobrevive à pessoa: ela é da Associação, não de quem digitou.
// `resolverFoto(userId, profilePhoto)` é injetada pelo index.js: devolve a foto
// a exibir, trocando pela pool de fotos padrão quem não tem foto própria. Vem
// de fora porque a regra de "sem foto própria" (que inclui a foto de fábrica) e
// a pool em si moram no index.js — este módulo não lê disco.
function autorPublico(item, users, config, viewerId = null, resolverFoto = null) {
  const snap = item.author || {};
  const u = users.find((x) => x.id === item.authorId) || null;
  const role = u ? u.role : snap.role;
  const kind = authorKind(role, item.asInstitution);

  if (kind === 'allos') {
    return {
      kind,
      name: INSTITUTION_NAME,
      subtitle: '',
      // Publicação institucional é da Associação: a etiqueta diz isso, e não o
      // papel de quem digitou (que aqui é deliberadamente anônimo).
      roleLabel: INSTITUTION_NAME,
      photo: (config && config.institutionAvatar) || null,
      userId: null, // publicação institucional não expõe qual admin escreveu
    };
  }
  if (!u) {
    return { kind, name: 'Conta removida', subtitle: '', roleLabel: '', photo: null, userId: null };
  }
  return {
    kind,
    name: u.name || 'Conta removida',
    subtitle: AUTHOR_SUBTITLE[kind] || '',
    roleLabel: ROLE_LABEL[u.role] || '',
    // Sem foto própria entra a da pool — é o que dá rosto ao aluno que nunca
    // subiu uma. Só na EXIBIÇÃO: nada disso é gravado no post.
    photo: (resolverFoto ? resolverFoto(item.authorId, u.profilePhoto) : u.profilePhoto) || null,
    // O id serve só para o leitor saber se o texto é dele (botão de excluir).
    // Leitor anônimo não age em nada, então não recebe — é a ponte nome→id de
    // graça que o link público não precisa entregar a quem passa na rua.
    userId: viewerId ? (item.authorId || null) : null,
  };
}

// O voto de UMA pessoa, normalizado em lista de ids. Enquete de opção única
// grava uma string ("o2") e a de múltipla escolha grava um array (["o1","o3"]);
// as duas formas convivem no mesmo arquivo porque as enquetes criadas antes da
// múltipla escolha existir continuam com string gravada — ler os dois formatos
// aqui é o que evita uma migração do comunidade.json.
function idsVotados(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

// Aplica o voto de um usuário e devolve true se a opção existe.
//
// Opção única: substitui (revotar troca; mandar o mesmo id de novo mantém o
// voto, o que evita zerar por duplo clique).
// Múltipla escolha: alterna a opção clicada. Desmarcar a última apaga a
// participação inteira — a pessoa volta a "não votou", e volta a não ver o
// resultado, que é o mesmo contrato de quem nunca clicou.
function aplicarVotoEnquete(poll, userId, optionId) {
  if (!poll || !poll.options.some((o) => o.id === optionId)) return false;
  if (!poll.votes || typeof poll.votes !== 'object') poll.votes = {};
  if (!poll.multi) {
    poll.votes[userId] = optionId;
    return true;
  }
  const atuais = idsVotados(poll.votes[userId]);
  const proximos = atuais.includes(optionId)
    ? atuais.filter((id) => id !== optionId)
    : [...atuais, optionId];
  if (proximos.length === 0) delete poll.votes[userId];
  // Reordena pela ordem das opções pra lista gravada não depender da ordem
  // de cliques (facilita comparar/depurar o JSON).
  else poll.votes[userId] = poll.options.map((o) => o.id).filter((id) => proximos.includes(id));
  return true;
}

// Enquete na visão de quem está lendo. Os percentuais só saem depois do voto
// (ou para quem não pode votar — read-only não tem como "votar depois", então
// esconder o resultado dele seria só esconder).
//
// `total` é o número de PESSOAS que votaram, nas duas modalidades, e o
// percentual de cada opção é sobre esse total. Na múltipla escolha isso faz a
// soma passar de 100%, que é o esperado: cada percentual responde "quantos dos
// que votaram marcaram esta opção?".
function enquetePublica(poll, viewerId, podeVotar) {
  if (!poll) return null;
  const votes = poll.votes || {};
  const total = Object.keys(votes).length;
  const minhas = viewerId ? idsVotados(votes[viewerId]) : [];
  const revelar = minhas.length > 0 || !podeVotar;
  return {
    options: poll.options.map((o) => {
      const count = Object.values(votes).filter((v) => idsVotados(v).includes(o.id)).length;
      return {
        id: o.id,
        text: o.text,
        ...(revelar ? { count, percent: total ? Math.round((count / total) * 100) : 0 } : {}),
      };
    }),
    total,
    multi: !!poll.multi,
    myVotes: minhas,
    // Mantido para a opção única (é o que a tela usa há mais tempo); na
    // múltipla escolha não há "o" voto, então vem null e quem lê usa myVotes.
    myVote: poll.multi ? null : (minhas[0] || null),
    revealed: revelar,
  };
}

// Comentários em árvore de UM nível: raízes ordenadas por score (empate =
// mais antigo primeiro, pra conversa não embaralhar a cada voto), e as
// respostas de cada raiz sempre em ordem cronológica — resposta é diálogo,
// reordenar por voto tornaria a leitura incoerente.
function comentariosPublicos(comments, { users, config, viewerId, resolverFoto }) {
  const lista = Array.isArray(comments) ? comments : [];
  const proj = (c) => ({
    id: c.id,
    body: c.deleted ? '' : c.body,
    deleted: !!c.deleted,
    createdAt: c.createdAt,
    author: c.deleted ? null : autorPublico(c, users, config, viewerId, resolverFoto),
    score: score(c.votes),
    myVote: meuVoto(c.votes, viewerId),
  });

  const raizes = lista.filter((c) => !c.parentId);
  const porPai = new Map();
  for (const c of lista) {
    if (!c.parentId) continue;
    if (!porPai.has(c.parentId)) porPai.set(c.parentId, []);
    porPai.get(c.parentId).push(c);
  }

  return raizes
    .slice()
    .sort((a, b) => (score(b.votes) - score(a.votes))
      || (new Date(a.createdAt) - new Date(b.createdAt)))
    .map((c) => ({
      ...proj(c),
      replies: (porPai.get(c.id) || [])
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(proj),
    }))
    // Tombstone sem resposta nenhuma não precisa ocupar espaço na tela.
    .filter((c) => !c.deleted || c.replies.length > 0);
}

// Resumo para a listagem do feed (sem comentários, sem opções de enquete).
function discussaoResumo(d, { users, config, viewerId, resolverFoto }) {
  const comentarios = Array.isArray(d.comments) ? d.comments : [];
  return {
    id: d.id,
    title: d.title,
    excerpt: clamp(d.body, 280),
    truncated: (d.body || '').length > 280,
    hasPoll: !!d.poll,
    pinned: !!d.pinned,
    createdAt: d.createdAt,
    editedAt: d.editedAt || null,
    author: autorPublico(d, users, config, viewerId, resolverFoto),
    score: score(d.votes),
    myVote: meuVoto(d.votes, viewerId),
    commentCount: comentarios.filter((c) => !c.deleted).length,
  };
}

function discussaoCompleta(d, { users, config, viewerId, podeVotar, resolverFoto }) {
  return {
    id: d.id,
    title: d.title,
    body: d.body,
    pinned: !!d.pinned,
    createdAt: d.createdAt,
    editedAt: d.editedAt || null,
    author: autorPublico(d, users, config, viewerId, resolverFoto),
    score: score(d.votes),
    myVote: meuVoto(d.votes, viewerId),
    poll: enquetePublica(d.poll, viewerId, podeVotar),
    comments: comentariosPublicos(d.comments, { users, config, viewerId, resolverFoto }),
  };
}

// Ordenação do feed. 'top' usa uma janela de 7 dias porque um placar puramente
// acumulado congela o topo da comunidade nos primeiros posts populares e some
// com quem chegou hoje; fora da janela, cai pro critério de recência.
//
// Discussão FIXADA (só admin fixa) sobe ao topo em 'recent' e é IGNORADA em
// 'top' — de propósito. "Em alta" é um placar: se o admin pudesse plantar um
// post no topo dele, a aba deixaria de dizer o que diz. Quem quer ver o que a
// comunidade está votando continua vendo exatamente isso.
function ordenarFeed(discussions, sort) {
  const lista = discussions.slice();
  if (sort === 'top') {
    const corte = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recente = (d) => new Date(d.createdAt || 0).getTime() >= corte;
    return lista.sort((a, b) => {
      if (recente(a) !== recente(b)) return recente(a) ? -1 : 1;
      return (score(b.votes) - score(a.votes))
        || (new Date(b.createdAt) - new Date(a.createdAt));
    });
  }
  // Entre as fixadas, a fixada MAIS RECENTEMENTE fica em cima: é o que dá ao
  // admin controle da ordem sem precisar de um campo de posição — fixar de novo
  // é o jeito de promover uma que já estava fixada.
  return lista.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const dif = new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0);
      if (dif) return dif;
    }
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

module.exports = {
  TITLE_MAX,
  BODY_MAX,
  COMMENT_MAX,
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_OPTION_MAX,
  MAX_COMMENTS_POR_DISCUSSAO,
  INSTITUTION_NAME,
  AUTHOR_SUBTITLE,
  ROLE_LABEL,
  podeParticipar,
  authorKind,
  validarDiscussao,
  validarEdicao,
  validarComentario,
  normalizarVoto,
  aplicarVoto,
  aplicarVotoEnquete,
  score,
  meuVoto,
  banAtivo,
  mensagemBan,
  autorPublico,
  enquetePublica,
  comentariosPublicos,
  discussaoResumo,
  discussaoCompleta,
  ordenarFeed,
};
