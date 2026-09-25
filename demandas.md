# Demandas — Migração para PostgreSQL

Documento vivo. Registra o que **já foi decidido**. O que ainda está em aberto
vive em [perguntas.md](perguntas.md).

Última atualização: 2026-08-24

---

## 1. Contexto e motivação

O sistema hoje persiste tudo em **arquivos JSON em disco** (`DATA_DIR`, 29
arquivos), lidos e gravados inteiros por `readJSON`/`writeJSON` em
`server/index.js`. Isso gerou dois problemas **já vividos em produção**:

- **Perda de dados.**
- **Race condition** — dois requests leem o arquivo inteiro, alteram sua parte
  em memória e gravam inteiro; o segundo a gravar **sobrescreve** a alteração do
  primeiro. Não há erro nenhum: o dado simplesmente evapora.

> Nota técnica: `writeJSON` **já faz escrita atômica** (grava `.tmp` + `rename`),
> então o problema nunca foi arquivo corrompido pela metade — é
> *read-modify-write perdido*. Só separar cada registro em sua própria linha
> resolve isso.

---

## 2. Decisões fechadas

### 2.1 Banco: PostgreSQL no Neon
Confirmado. Usuário já tem experiência prévia com Neon/Postgres.

### 2.2 Backend continua em Node.js — Django foi descartado
Avaliado e descartado. O backend atual tem **13.127 linhas**, **137 rotas**,
**40 pontos de integração** com OpenAI/Anthropic e **26 pontos de streaming
(SSE)**, tudo funcionando em produção. Reescrever em Django significaria jogar
fora código testado para reconstruir a mesma coisa, **sem ganhar nada do que
motivou a migração** — race condition se resolve com transação do Postgres, e
Node fala com Postgres igual ao Django.

Agravantes específicos deste projeto:
- Hoje o Express serve API **e** estáticos na mesma origem, o que elimina CORS
  em produção. Separar reintroduz CORS — e o repo já tem um commit recente
  corrigindo justamente um bug de CORS.
- Streaming, batch API e prompt caching são a parte mais chata de portar, e são
  exatamente o que sustenta o custo de IA que se quer melhorar.
- Passaria a manter dois ecossistemas (`package.json` + `requirements.txt`),
  dois deploys, dois runtimes — o frontend continua Node de qualquer forma.

### 2.3 Acesso ao banco: SQL puro (driver `pg`)
Sem ORM, sem Knex, sem Drizzle. Decisão do usuário.

### 2.4 Estratégia de migração: Caminho B — tabelas reais
Escolhido em vez do caminho incremental. Cada entidade vira uma tabela de
verdade, com uma linha por registro. É o **único** caminho que resolve a race
condition: enquanto o dado for um documento único, dois alunos continuam
disputando a mesma escrita.

Custo aceito: as ~281 chamadas de `readJSON`/`writeJSON` viram queries e boa
parte das 137 rotas muda.

### 2.4.1 Projeto dividido em duas fases — **decisão estruturante**

**Fase 1 — só o banco. Nenhuma função do sistema muda.**
O sistema continua fazendo exatamente o que faz hoje; só o armazenamento sai do
JSON e vai para o Postgres. Nada de aluno Allos, grupo, temporada, ranking
separado ou tier de IA.

**Fase 2 — features novas.** Aluno Allos × externo e tudo que decorre disso.

Por que isso importa: a fase 1 passa a ter um **critério de sucesso objetivo**
(o sistema se comporta igual) em vez de depender de decisões de produto que
ainda serão validadas com o chefe. E destrava o trabalho — as perguntas sobre
grupo, temporada e ranking **deixam de bloquear** a migração.

### 2.4.2 A única exceção deliberada ao "não muda nada"

"Não mudar nenhuma função" **não pode** incluir a race condition — ela é
comportamento atual, e é justamente o bug que motivou o projeto.

Se a fase 1 fosse fiel demais (ler a coleção inteira, alterar em memória,
regravar inteira), ela **reproduziria o bug em cima do Postgres** e o projeto
não entregaria nada.

Regra da fase 1: **preservar o comportamento *visível*, corrigir a *forma de
escrever*.** Toda escrita passa a ser dirigida à linha afetada
(`UPDATE ... WHERE id = ...`), dentro de transação quando envolve mais de uma
tabela — nunca "regrava a coleção toda".

### 2.5 Escopo: **não** haverá modelagem em grafos
Avaliado e descartado. A hipótese era que grafos reduziriam custo de IA. Não
reduzem:
- **Grafo da trilha** (pré-requisitos): cabe em duas colunas numa tabela comum.
  Não economiza token nenhum.
- **Grafo de conhecimento do paciente** (mandar só o trecho relevante ao modelo):
  economizaria de fato, mas é RAG — a parte mais difícil do sistema — e arrisca a
  consistência narrativa do paciente simulado, que é o produto.
- **Grafo de similaridade entre casos** (reaproveitar avaliação): reciclar nota
  entre alunos é inaceitável numa plataforma de avaliação.

**Custo de IA fica fora deste projeto** e será tratado separadamente. Trocar
JSON por Postgres não altera, por si só, nenhum token enviado ao modelo.

---

## 3. Papéis de usuário — o que o código realmente tem

> ⚠️ **Atualização 2026-09-14 — SUPERADO PARCIALMENTE.** Depois do `git pull`
> que trouxe ~15 commits novos, a equipe entregou `CLAUDE.md` na raiz do
> repo, escrito **especificamente para quem for migrar a persistência** — ele
> agora é a fonte primária para mapa de dados, papéis e regras a preservar
> (§5 de lá). O levantamento abaixo é de antes disso e tem duas correções
> confirmadas por `CLAUDE.md`:
>
> - **`evaluator` NÃO é papel morto.** `CLAUDE.md` linha 21: é o avaliador
>   externo do Processo Seletivo. A recomendação de remover (que estava em
>   perguntas.md A6) não vale mais.
> - **A distinção aluno Allos × externo deixou de ser 100% inexistente.**
>   Existe hoje um role `external` (aluno externo) com **auto-cadastro** já
>   em produção (`b4ee089 feat(cadastro): auto-cadastro de Aluno Externo`) e
>   cota de 3 sessões/24h (`external-session-starts.json`). O que **ainda**
>   não existe: grupo, ranking separado, temporada, tier de IA por categoria
>   — os itens de B1-B9 em perguntas.md continuam de fato em aberto.

Levantado em `server/index.js`, não presumido:

```
VALID_ROLES = ['therapist', 'supervisor', 'admin', 'evaluator', 'external']
```

| Nome de negócio | `role` no código | Observação |
|---|---|---|
| Admin           | `admin`      | |
| Professor       | `supervisor` | |
| Aluno (interno) | `therapist`  | |
| Aluno externo   | `external`   | **novo desde set/2026** — auto-cadastro, cota de sessões |
| Avaliador externo | `evaluator` | Processo Seletivo — confirmado ativo, não remover |

Achados que ainda valem:

- **`visitor` é o papel mais checado do sistema e não está em
  `VALID_ROLES`** — visitante é efêmero, não vive em `users.json`, existe só
  no JWT (token de 2h). Mudou de porta de entrada: hoje só nasce pelo link de
  convite de duelo, não mais pelo login geral (`CLAUDE.md` §6).
- `teacherId` (vínculo aluno↔professor) e `candidate` (processo seletivo)
  continuam existindo como antes.
- **Ruído a ignorar**: `role: 'user'`, `role: 'assistant'`, `role: 'developer'`
  são papéis de *mensagem* das APIs de IA, não papéis de usuário. Não entram
  na modelagem.

---

## 4. Aluno Allos × Aluno externo

> ⚠️ **SUPERADA em 2026-09-15 — ver §16.** O cliente decidiu que a única
> diferença entre Allos e externo é o controle de acesso configurado pelo admin
> (§16.2), com tudo liberado no deploy. O desenho abaixo (flag `is_allos`,
> tabela de extensão, tier de IA por categoria de aluno, ranking separado) não
> vale mais. Grupo virou tags atribuídas pelo admin (§16.4); temporada segue a
> definir. Fica registrado para histórico.

### 4.1 Desenho recomendado: flag + tabela de extensão
`users` ganha `is_allos BOOLEAN`, e os campos exclusivos vivem numa tabela
`alunos_allos (user_id PK, ...)`.

Motivo: a flag deixa as 137 rotas testarem a categoria **barato, sem JOIN**,
enquanto os campos extras ficam isolados — o banco garante que aluno externo
não carrega dado que não deveria ter, em vez de acumular coluna nula em `users`.

*(Pendente de confirmação — ver perguntas.md.)*

### 4.2 Diferenças de comportamento levantadas até agora
- Aluno Allos pertence a um **grupo** (conceito novo — não existe no código hoje).
- Aluno Allos tem **pontuação a mais**.
- **Ranking separado**: só entre alunos Allos.
- **Temporadas** ("semanas") exclusivas para alunos Allos.
- **Duelos**: possivelmente exclusivos de alunos Allos.
- **Tier de IA diferente** (melhor ou pior) por categoria de aluno.

### 4.3 Restrição de desenho: tier de IA **não** é campo do usuário
A escolha de modelo **já é configurável em runtime** hoje, mas é **global por
categoria de uso**, vive em `settings.json` e é resolvida a cada chamada
(`server/ai-models.js`). A trilha tem controle próprio, **por exercício**.

Logo, "aluno Allos usa IA melhor" se implementa mudando a função que **resolve**
o modelo — que passaria a considerar categoria de uso **e** tier do aluno.
Guardar `modelo_preferido` na tabela do aluno seria um erro: espalharia a decisão
de modelo por lugares que já competem entre si.

### 4.4 ~~Restrição de desenho: temporada precisa nascer na modelagem~~
> **Sem efeito desde 23/09/2026 (§22.2): não haverá temporadas.** O Ranking é um
> lugar onde se entra e se vê quem tem o melhor MMR, com filtro por tag — sem
> período e sem zeragem. Nenhum `season_id` entra nas tabelas.

O texto original, mantido como registro do que se temia: se "semanas"
significasse temporada/season, `season_id` teria de entrar nas tabelas de MMR e
duelo desde já, porque introduzir temporada depois, sobre dados acumulados, seria
uma migração cara e evitável. Com a decisão de não ter temporadas, a restrição
deixa de existir.

---

## 5. Estado atual do ranking (o que existe hoje)

- **Um** endpoint `/api/ranking` e **um** MMR global (`server/mmr.js`, 324
  linhas; `mmr.json`).
- Duelos já são um subsistema grande: 10 rotas em `server/index.js`.
- Existe reset de ranking por admin (`/api/admin/ranking/reset`).

Separar o ranking exige decidir se MMR é **uma linha por aluno** ou **uma linha
por aluno por liga/temporada**. → ver perguntas.md

---

## 6. Rede de proteção: a suíte de testes já existente

O projeto tem **34 arquivos de teste, 7.362 linhas** (`tests/`), cobrindo auth,
duelos, MMR, trilha, achievements, segurança, seleção e um `regression.test.js`
de 414 linhas.

Isso define o **critério de aceite da fase 1**:

> A suíte inteira passa, **sem alterar os arquivos de teste** (exceto o harness
> `tests/helpers.js`, que troca a semeadura de disco por banco).

Se um teste precisar mudar para passar, ou o comportamento mudou (viola a fase 1)
ou o teste dependia de detalhe de armazenamento — e aí a mudança precisa ser
justificada caso a caso.

### 6.1 Impacto no harness de teste
Hoje `tests/helpers.js` cria um `DATA_DIR` temporário com `fs.mkdtempSync` e
semeia arquivos JSON. Com Postgres isso precisa virar um **banco isolado por
arquivo de teste** — porque `vitest.config.js` roda os 34 arquivos em **forks
paralelos** (`pool: 'forks'`, `singleFork: false`). Sem isolamento, os testes
disputam as mesmas tabelas e passam a falhar de forma intermitente.
→ ver perguntas.md

---

## 7. Aluno pode mudar de categoria — decidido

Um aluno **pode** mudar de categoria (externo ↔ Allos) e **leva consigo** MMR,
pontuação e recordes 👑. Não há reset.

Consequência para a modelagem (fase 2): como nada é destruído na troca, o MMR
não precisa ser versionado por liga para preservar histórico. Continua pendente
apenas se haverá **rankings separados** — e, se houver, como um rating construído
numa população aparece na outra. *(Resposta a validar com o chefe.)*

---

## 8. Ambiente e infraestrutura (levantado, não presumido)

| Item | Estado |
|---|---|
| Produção | **Railway**, builder NIXPACKS (`railway.json`), volume persistente em `/data` |
| Banco alvo | **Neon** (PostgreSQL) |
| Docker na máquina do dev | **instalado e ativo** (v29.6.2) |
| `psql` na máquina | **instalado** |
| CI (GitHub Actions ou similar) | **não existe** |
| Dockerfile / docker-compose no repo | **não existem** |

### 8.1 Decidido: Postgres local em Docker para a suíte de testes
Resolve a pergunta A2. Com Docker disponível, é a melhor das três opções
avaliadas:

- **isolamento real** entre os 34 arquivos de teste, que continuam rodando em
  **paralelo** (`pool: 'forks'`) — sem isso a suíte fica intermitente;
- **rápido** — não depende de rede;
- **não consome conexão do Neon**, nem arrisca tocar em dado real.

Railway usa NIXPACKS e não Docker no deploy, então um container local de teste
não interfere em produção.

Implica adicionar ao repo um `docker-compose.yml` só para desenvolvimento e
adaptar `tests/helpers.js` (hoje `fs.mkdtempSync` + seed de JSON) para criar um
**schema isolado por arquivo de teste**.

### 8.2 Risco registrado: não há CI
Sem `.github/workflows`, o único portão de qualidade é lembrar de rodar
`npm test` antes do push. Numa migração que toca **281 pontos de escrita** e
cuja garantia principal é "a suíte passa igual", isso é frágil.

Não bloqueia a fase 1, mas fica registrado: um workflow mínimo que suba o
Postgres de teste e rode `npm test` a cada push transformaria o critério de
aceite em algo automático em vez de manual.

### 8.3 Perda de isolamento entre dev e produção — atenção
Hoje, com JSON, o ambiente local é isolado **por natureza**: `DATA_DIR` aponta
para `server/data/` e não há como estragar produção sem querer.

Com Postgres isso deixa de ser verdade: uma `DATABASE_URL` local apontando para
o banco do Railway faz um teste manual ou um script de migração **mexer em dados
reais de aluno**. → ver perguntas.md A7.

---

## 9. Dados de produção: podem ser perdidos, **exceto os prompts**

### 9.1 Decidido: um banco só, mexendo direto em produção
Decisão do usuário, tomada com o contexto abaixo.

Os usuários que existem hoje **não são usuários reais**: são terapeutas que
toparam testar a ferramenta. Históricos, progresso e ranking acumulado **podem
ser perdidos** — não há dado de negócio a preservar.

Isso torna a decisão defensável: sem dado real, um branch de desenvolvimento
separado no Neon vira cerimônia sem objeto, e o script de importação deixa de ser
o ponto de maior risco do projeto (não há o que importar que valha).

> Ressalva registrada: some o isolamento que o JSON dava de graça (`DATA_DIR`
> local × volume do Railway). A partir da migração, uma `DATABASE_URL` apontando
> para o lugar errado alcança produção direto. Aceito conscientemente porque o
> conteúdo é descartável — **menos os prompts (§9.2)**.

### 9.2 🚨 Os prompts são o ativo insubstituível — e hoje existem em UM lugar só

Declarado pelo usuário: *"o que não pode ser perdido são os prompts"*.

Estado atual, levantado no código:

- Os `.md` do avaliador/entrevistador **saíram do git de propósito** (contêm
  critérios de nota e gabaritos — dados sensíveis).
- Vivem **apenas** no `PROMPTS_DIR`, dentro do volume persistente do Railway.
- A semeadura inicial (`server/index.js`) só roda **se `PROMPTS_DIR` não
  existir** — não é uma cópia que se regenere.
- Há backup interno (`prompt-backups/`, últimas 20 por arquivo), mas ele mora
  **no mesmo volume**. Não protege contra a perda do volume.

**Risco direto desta migração:** se durante a mudança de infra o volume for
desmontado, recriado, ou `DATA_DIR` mudar de valor, **os prompts somem sem
origem de restauração**.

### 9.3 Ação obrigatória antes de encostar no banco
**Tirar uma cópia do `PROMPTS_DIR` para fora do Railway.** O procedimento já está
no `DEPLOY.md` (seção "Backup recomendado"):

```
railway run bash
tar czf /tmp/prompts-backup.tar.gz /data/prompts
```

...e trazer o arquivo para fora (o DEPLOY.md sugere `base64` + cópia local).

Isso vale **independente da migração** — hoje o ativo mais valioso da Allos não
tem cópia fora de um único volume.

### 9.4 Consequência: prompts saem na frente
Como históricos são descartáveis e prompts são críticos, a ordem natural do
trabalho muda: **a parte de prompts é a que exige mais cuidado da fase 1**, e a
de progresso/ranking/logs é a que permite ser mais rápida.

---

## 10. Banco de versões de prompt (pedido novo)

Pedido: uma tela onde o admin sobe uma versão de prompt (ex.: v30), cria outras
depois, e **elege qual é a padrão**.

### 10.1 O que JÁ existe — levantado, não presumido

**a) Editor de prompts com histórico** (`server/prompt-files.js`, 7 rotas em
`server/index.js`, todas admin-only):
- listar, ler e gravar os `.md` pelo navegador;
- **backup automático** a cada gravação (últimas 20 por arquivo) e rota de
  **restauração**;
- **validação antes de gravar**: o conteúdo passa pelo mesmo parser da produção
  (`parseMontado` / `parseSintetizador` / `parseCriteria`), então um Ctrl+V que
  quebre um marcador é recusado na hora.

**b) Múltiplas versões coexistindo** (`PIPELINE_VERSIONS`, `avaliacao-v25.js`):
v25, v28 etc., cada uma com pasta e conjunto próprios (`montado`, `criterios`,
`sintetizador`) e parâmetros próprios (nº de critérios, captura de reasoning,
formato de saída). Há `DEFAULT_VERSION`.

### 10.2 O que FALTA — a diferença que importa

O que existe é **histórico linear** (desfazer para trás) + **versões definidas em
código**. O que foi pedido é **versão como entidade gerenciável**.

Concretamente, duas decisões estão **hardcoded** hoje:

| Hoje | Pedido |
|---|---|
| Criar a v30 = programador edita `PIPELINE_VERSIONS` e faz deploy | Admin cria pelo navegador |
| Trocar a padrão = mudar `DEFAULT_VERSION` no código e fazer deploy | Admin elege a padrão pela tela |

**Não é construir do zero** — a estrutura de múltiplas versões já funciona. É
tirar essas duas decisões do código e passá-las para o banco.

### 10.3 Decisão: seguir o modelo que o sistema já usa
Confirmado pelo usuário: aproveitar o desenho existente em vez de inventar outro.
Ou seja, a configuração continua com o mesmo formato de `PIPELINE_VERSIONS`
(cada versão com seus arquivos e parâmetros) — só que **persistida em tabela** e
editável, em vez de constante no código.

> Aviso de desenho: quando essa configuração sair do código, o parser
> (`parseMontado` etc.) passa a receber conteúdo que **nunca passou por revisão
> de programador**. A validação já existente em `prompt-files.js` deixa de ser
> conveniência e vira a **única** trava contra uma versão quebrada entrar em
> produção. Ela precisa continuar rodando no caminho de criação de versão nova,
> não só na edição de arquivo.

### 10.4 Fase 1 ou fase 2?
Isto é **feature nova** — pela regra da §2.4.1 seria fase 2. Mas o usuário
declarou os prompts como o ativo crítico, o que puxa o assunto para perto.
→ ver perguntas.md A8.

### 10.5 Decisão: estrutura "LTS/estrutura_prompt" — substitui v25/v28 por completo

Supera a ideia da §10.3 de só replicar `PIPELINE_VERSIONS` no banco. A equipe
do usuário vai entregar, até a semana seguinte a esta decisão, a definição de
como o prompt deve ser estruturado (chamada internamente de
**"LTS/estrutura_prompt"**) — por exemplo, "o prompt é dividido em 3
critérios". O schema do banco de prompts será desenhado **espelhando
exatamente essa estrutura** assim que ela chegar (se são 3 critérios, o banco
tem 3 partes; se mudar, o schema muda).

Fluxo decidido para `/admin/prompts`:
1. A equipe do usuário entrega um **monoprompt** (texto único, ainda não
   dividido).
2. O **admin divide manualmente** esse monoprompt nos campos da tela — um
   campo por parte da estrutura (ex.: um campo por critério). **Não é o
   código nem uma IA quem faz esse split** — decisão explícita do usuário,
   para não introduzir um parser automático ou uma chamada de IA extra nesse
   caminho.
3. Cada parte é gravada na coluna/linha correspondente da estrutura no banco.
4. A eleição de "qual versão é a padrão agora" segue o mesmo padrão que já
   existe em `/admin/modelos` (`server/ai-models.js` — escolha por categoria +
   um padrão global, editável em runtime) — reaproveitado, não reinventado.

**As versões atuais (v25, v28) somem do banco** quando a estrutura nova
entrar — não ficam guardadas como histórico somente-leitura. Consequência
direta: avaliações antigas geradas por v25/v28 continuam existindo como
registro (a nota já foi calculada e salva), mas **não há mais como reabrir ou
reexecutar o prompt que gerou aquela nota** depois da virada — ver
perguntas.md P5 sobre se cada avaliação deve registrar a versão que a gerou
(fica ainda mais importante dado que a versão em si não sobrevive).

**Bloqueio registrado:** o schema real (nomes de campo, quantas partes,
validação de cada uma) só pode ser desenhado depois que a "LTS/estrutura_prompt"
chegar da equipe do usuário. Até lá, A9 (perguntas.md) fica pendente dessa
entrega externa, não é uma decisão que se feche antes.

---

## 11. Prompts vão para o banco — decidido

Decisão do usuário: *"prefiro que os prompts tenham backups"*.

Consequência: os `.md` de avaliação/entrevistador **saem do volume e vão para o
banco**. São texto, não binário (o maior tem ~30 KB), então não há o problema
clássico de guardar arquivo grande em base.

Ganhos:
- deixam de depender de um volume que pode ser desmontado;
- entram no *point-in-time recovery* do Neon;
- passam a ter cópia sempre que o banco for copiado.

**Limite honesto:** estar no banco **não é, por si só, um backup**. Se alguém
apagar a linha errada, o banco replica o apagamento. Proteção real precisa de
três camadas (versão imutável + PITR + export externo) — ver perguntas.md A10.

Fotos e `.txt` de reasoning **não** acompanham essa decisão por padrão — são
binários/volumosos. Ver perguntas.md A3.

⚠️ **Se algo permanecer em disco, o volume do Railway NÃO pode ser desligado
após a migração.**

---

## 12. Achados que sustentam o projeto (evidência, não opinião)

### 12.1 A race condition está documentada no próprio código
`server/index.js:2753` descreve a atualização do MMR como:

> *"Atualização atômica do mmr.json (read-modify-write na mesma request)."*

Read-modify-write é exatamente o oposto de atômico **entre requests
concorrentes**. Dois alunos terminando uma sessão competitiva ao mesmo tempo: um
lê o MMR, o outro lê o mesmo MMR, os dois gravam — **o segundo apaga o primeiro**.
Sem erro, sem log. É o bug que motivou o projeto, com endereço.

### 12.2 Os prompts estão em um único lugar no mundo
- `.gitignore` linhas 43-44 excluem `avaliacao/` e `entrevistador/`;
- essas pastas **não existem** na máquina do desenvolvedor (nunca foram
  clonadas);
- a semeadura do `PROMPTS_DIR` só roda **se a pasta não existir** — não é cópia
  que se regenere;
- `prompt-backups/` fica **no mesmo volume** que protegeria.

Ou seja: o ativo mais valioso da Allos tem **uma cópia só**, no volume do
Railway, e a migração mexe justamente nessa infra.

### 12.3 Geração de IDs tem o mesmo bug de concorrência
Os IDs são criados por `Date.now()` (45 usos) e por "maior id + 1"
(`server/index.js:2022`). Ambos colidem sob concorrência — mesma família de
problema da race condition. Em Postgres isso é resolvido de graça
(`BIGSERIAL`/`UUID`). Ver perguntas.md A11.

### 12.4 Já existe uma rota de export completo
`server/index.js:1271` baixa progresso, logs, conquistas, sessões ativas, MMR,
duelos e notificações num único JSON. É um caminho de backup **já pronto**, sem
Railway CLI — útil antes da virada, mesmo com os dados sendo descartáveis.

---

## 13. Ordem de implementação e status (atualizado 2026-09-15)

Legenda: ✅ feito · 🟡 feito em parte · ⬜ falta. **Subido em 2026-09-18**: a
branch `feat/postgres-fase1` está no fork
`github.com/PauloHenriqueL/all_os` (commit `dfe12de`, 121 arquivos). O `origin`
segue apontando para `arthurbpinho/all_os` (upstream) e **não** recebeu nada; o
fork foi adicionado como remote `fork`. Os prompts continuam fora do git — as
cópias soltas `v34.md` e `lts.md` na raiz entraram no `.gitignore` antes do
push, porque os dois repositórios são públicos (§9.2).

### 13.1 Fase 1 — migração para o PostgreSQL

| # | Etapa | Status | Onde |
|---|---|---|---|
| 1 | Cópia dos prompts fora do Railway | ✅ | Os `.md` do v34, neuro e entrevistador estão na máquina do usuário (`avaliacao/`, `entrevistador/`, `server/data/prompts/`), validados pelo parser de produção. Fora do git (§9, `.gitignore`). |
| 2 | Export completo dos dados atuais | ⬜ | ~~Decidido começar limpo~~ — **mudou em 15/09 (§18): os dados atuais são importados**, então a cópia da pasta `/data` inteira é obrigatória, não opcional. O export pela rota (§12.4) fica como garantia adicional; o que alimenta a virada é `scripts/importar-volume.js` (`VIRADA.md`). |
| 3 | Postgres local em Docker | ✅ | `docker-compose.yml` — Postgres 17 (mesma versão do Neon), porta 5433, `npm run db:up`. |
| 4 | Infra do banco no app | ✅ | `server/db.js`, runner de migrações `server/db/migrate.js`, migrações no boot, `DATABASE_URL` obrigatória (fail-closed), `rota()` + tratador de erro final. |
| 5 | Testes com schema isolado por arquivo | ✅ | `tests/helpers.js`, `tests/db-helpers.js`, `tests/global-setup.js`. |
| 6 | **Contas e autenticação** | ✅ | `001_contas.sql`, `server/repos/contas.js`, todas as rotas de conta ligadas ao banco: login, sessão, cadastro público, nova senha, troca de e-mail, perfil, tela de Contas. |
| 7 | Exclusão lógica de conta | ✅ | `002_contas_exclusao_logica.sql` (§15). |
| 8 | **Logs e progresso** | ✅ | `003_logs_progresso.sql`, `server/repos/logs.js`, `server/repos/progresso.js`, ligados a todas as rotas. |
| 9 | MMR, recordes 👑 e duelos | ✅ | `004_mmr_duelos.sql`, `server/repos/mmr.js`, `server/repos/duelos.js`. Cada partida trava só o paciente e os jogadores dela. Teste do TRI (§16.7) em `tests/db-repo-mmr.test.js`. Ver §17. |
| 10 | Prompts e versões no banco | ✅ | `005_prompts.sql`, `server/repos/prompts.js`, `server/prompt-store.js`. Histórico imutável e critérios como linhas identificadas pelo nome (§16.6). Ver §17. |
| 11 | Sessões ativas e filas | ✅ | `006_sessoes_filas.sql`: sessões ativas com uma linha por mensagem e expiração de 15 dias, cota do externo, ledger da Batch API e filas das ferramentas internas. Ver §17. |
| 12 | O resto | ✅ | `007` a `009`: notificações, push, conquistas, contadores, logs de erro, feedback, configurações, pool de fotos, sidequests, antessala, Processo Seletivo e Comunidade. **Ficaram em arquivo** os catálogos de conteúdo (§17.4). |
| 13 | Segurança do login e do cadastro | ✅ | Verificado de ponta a ponta, com 4 correções: `tests/seguranca-login.test.js` e `tests/seguranca-limites.test.js`. Ver §17.3. |
| 14 | Virada em produção | ⬜ | Neon (Postgres 17) + projeto novo no Railway, com o sistema em JSON ainda no ar e os usuários migrando para o novo (perguntas.md A13). **Manter o volume** para fotos e reasoning (A3). |

**Critério de aceite de cada etapa** (§6): a suíte inteira passa. Os testes só
mudam quando a mudança se justifica caso a caso, e cada mudança fica registrada.
Até aqui foram: 6 arquivos que liam o `users.json` direto passaram a ler do
banco, 9 `resetData()` ganharam `await`, `username-conflito.test.js` foi removido
(o caso de nome duplicado só na caixa não pode mais existir), e o teste de
exclusão virou o de exclusão lógica. Estado atual: **722 testes passando, 0
falhas.**

### 13.2 Fase 2 — demandas novas (§16)

Ordem sugerida, com a dependência que justifica cada posição:

| # | Demanda | Depende de | § | Status |
|---|---|---|---|---|
| A | Controle de acesso (matriz Allos × externo × visitante, cadeado, bloqueio no servidor) | — | 16.2 | ✅ §19 |
| B | IA do externo e limites semanais em dinheiro e tokens, com notificação ao estourar | A (a configuração mora na tela de Acessos) | 16.3 | ✅ §19 |
| C | Gráfico de critérios da sessão e do perfil | Fase 1 #8 (logs no banco) e A (quais modos alimentam o perfil) | 16.5 | ✅ §19 |
| D | Critérios dinâmicos: "Adicionar critério", nome como identidade, pergunta de reset ao editar | Fase 1 #10 (prompts no banco) | 16.6 | ✅ §19 |
| E | Tags de terapeutas; depois, filtro do ranking e dos logs por tag | Fase 1 #6 (contas) e #8 (logs) | 16.4 | ✅ §19 |
| F | ~~Temporadas~~ | — | 4.4 | ❌ **descartada em 23/09 (§22.2)**: o Ranking é MMR + filtro por tag, sem período |

A fase 2 pode começar antes da virada: tudo roda no banco de dev.

### 13.3 Perguntas que seguem em aberto

Decididas em §18: semana do limite (janela deslizante de 7 dias), gráfico para o
próprio aluno (sim, só os números). Para depois: temporadas (B2) e comunidade
(P11). Seguem abertas:

- ~~Campos extras do aluno Allos / "mais pontuação" (B6)~~ → respondida (§20).
- ~~Premissas da §19.6~~ → confirmadas (§20).

Nada mais aberto além de temporadas e comunidade, que ficaram para depois.

---

## 14. Atualização 2026-09-14 — `git pull` trouxe a LTS pronta + `CLAUDE.md`

Depois de ~15 commits novos (o `main` estava parado desde 20/08), dois achados
mudam partes deste documento.

### 14.1 `CLAUDE.md` é agora a fonte primária do mapa de dados

A equipe escreveu `CLAUDE.md` na raiz do repo **especificamente para quem for
migrar a persistência** — mapeia todo arquivo JSON, campos, relações e, mais
importante, as **regras que o banco precisa preservar** (§5 de lá): IDs de
conta nunca reemitidos, unicidade case-insensitive de username/e-mail, tokens
guardados só como hash, retenção por tipo de dado, sigilo por papel. Onde
`CLAUDE.md` e este documento divergirem, `CLAUDE.md` vence — ele reflete o
código atual, este documento tem partes de antes do pull (ver §3, corrigida).

### 14.2 A "LTS/estrutura_prompt" (perguntas.md A9) já foi entregue — é o v34

Não é mais uma entrega pendente da equipe. `server/avaliador-pipeline.js` e
`server/avaliacao-oficial.js` mostram que o **v34** já é, desde set/2026, **a
régua única de todos os modos de sessão** (exceto Neuroavaliação e Trilha, que
ficam fora por desenho próprio). As réguas antigas citadas em §2.5/§10 (v25,
v28) e outras que nem chegaram a ser discutidas aqui (v29, v31, v32, v43) já
saíram do código por completo — o `avaliacao-v25.js` antigo nem existe mais.

**Arquitetura real** (substitui a hipótese de §10.3):

- Cada avaliação roda **9 chamadas de IA**: 8 nós em paralelo (um por
  critério) + 1 sintetizador. Cada nó devolve 5 "qualidades"
  (integridade/autoria/potência/calibração/excepcionalidade), cada uma
  `plena|parcial|ausente`. A nota é **somada em código**
  (`plena=2, parcial=1, ausente=0`, 0–10 por critério, média×10 = nota
  final) — a IA nunca soma nem escreve nota.
- Por versão (`v34`, `v34-progressao`, `v34-duelo`), um conjunto fixo de
  arquivos no volume: `prompt-no-<versão>-montado.md`, `criterios-no-v34.md`
  (**compartilhado** entre as três via `criteriosDe: 'v34'`),
  `sintetizador-<versão>.md`, e `missao-v34-progressao.md` só na progressão.
- Isso **confirma a opção (a)** da tabela em §10 (guardar caminho +
  conteúdo), não a (b) de entidade genérica — o schema é simples: uma tabela
  de versões (com FK opcional `criterios_de` para outra versão) + uma tabela
  de arquivos por versão (`papel` ∈ montado/critérios/sintetizador/missão).
- `nCriterios: 8` é fixo e validado no boot — mudar a contagem de critérios
  continua sendo deploy, não tela de admin.

**Novo achado que entra no schema:** `avaliacoes-criterios/<id>.json` — um
arquivo por avaliação com as 8 análises completas (o "gabarito lido"), hoje
só acessível a supervisor/admin. Precisa virar tabela própria com controle de
acesso por papel — é dado tão sensível quanto o prompt em si.

### 14.3 Módulo novo, não mapeado antes: Comunidade

`comunidade.json` + `comunidade-config.json` — fórum com discussões,
comentários em árvore de 1 nível, votos, enquetes, fixar no topo, edição pelo
admin e banimento com prazo. Não existia em nenhuma conversa anterior. Entra
na fase 1 como qualquer outra tabela, mas tem perguntas de retenção e
moderação em aberto → perguntas.md P11.

### 14.4 Consequência para a ordem de trabalho (§13)

A etapa de prompts no banco (§13.1, #10) passa a ter uma referência concreta
(o `PIPELINE_VERSIONS` do v34) em vez de uma estrutura hipotética — reduz
risco, não muda a ordem.

---

## 15. Exclusão de conta — decidido: exclusão lógica (2026-09-14)

Hoje, no JSON, excluir a conta (`DELETE /api/me` ou tela de Contas) tira a
pessoa do `users.json`, mas **mantém os logs, conquistas e conversas no disco**
— a exclusão de dados é por pedido a suporte@allos.org.br. Com os logs virando
tabela ligada à conta, havia três caminhos; o escolhido foi o 1:

1. **Exclusão lógica** ✅ — a conta vira uma "lápide": a linha fica, com o mesmo
   id (que logs, duelos e MMR referenciam), e perde tudo que identifica a pessoa:
   nome, e-mail, senha, foto, descrição, origem e aceite dos termos.
2. ~~Exclusão física com o vínculo dos logs anulado.~~
3. ~~Exclusão física em cascata (apaga os logs junto).~~

Como ficou (migração `002_contas_exclusao_logica.sql`, `server/repos/contas.js`):

- **Para o app, a conta excluída não existe:** nenhuma busca, edição, login ou
  troca de senha a alcança. Na Comunidade o autor aparece como "Conta removida",
  igual a hoje.
- **Nome e e-mail ficam livres** para um cadastro novo, que recebe outro id — o
  id da lápide nunca volta (regra do `CLAUDE.md` §5.2).
- Pedidos pendentes de nova senha e de troca de e-mail saem junto.
- Professor com aluno ativo vinculado continua sem poder ser excluído.

**A exclusão de DADOS (logs, conversas) segue fora do app**, por pedido ao
suporte, como hoje. Se um dia ela entrar no app, é uma operação separada desta.

---

## 16. Novas demandas do cliente (2026-09-15)

Respostas e pedidos do cliente, confirmados com o usuário. **Substituem** o
desenho da §4 (flag `is_allos` + tabela de extensão, tier de IA por categoria):
a diferença Allos × externo passa a ser só o controle de acesso abaixo.

### 16.1 Allos × externo — respostas fechadas

| Pergunta (perguntas.md) | Resposta |
|---|---|
| Existe diferença entre Allos e externo? | **Só pelo controle de acesso** (§16.2), decidido pelo admin em produção. **No deploy nasce tudo liberado para todo mundo.** |
| B4 · Duelo é exclusivo da Allos? | **Não.** Duelo é para todos: Allos × externo, Allos × visitante, por link de convite. |
| B7 · Como o externo entra? | **Pela tela de login, no botão de cadastro** (auto-cadastro, já existe). |
| B9 · O que o externo não pode fazer? | **Nada, por padrão** — pode tudo que a Allos pode, salvo o que o admin restringir. |
| B1 · Rankings separados? | **Não. Um ranking só**, com todo mundo. |
| B5 · Qual IA o externo usa? | **O admin escolhe** o modelo padrão do externo na tela de Acessos (§16.3). |
| B7 · Externo paga? | **Nunca.** O sistema não cobra ninguém, nem externo nem Allos. |
| B7 · Existe professor externo? | **Não.** Todo professor é da Allos. |
| B3 / B2 · Grupo e temporada | **Continuam existindo.** Grupo virou tags (§16.4); temporada segue a definir (B2). |

No código: Allos = papel `therapist`, externo = `external` (ver §3).

### 16.2 Controle de acesso por funcionalidade (tela "Acessos")

Tela do admin com a matriz **funcionalidade × perfil**, com três colunas:
**Terapeuta da Allos**, **Terapeuta externo** e **Visitante**. Para cada
funcionalidade o admin marca quem pode usar.

- **Referência pronta:** o sistema Genus Praxis
  (`projetos/allos/genus_praxis`) já tem essa tela —
  `client/src/pages/AdminFeatures.jsx` e o catálogo em `server/features.js`.
  O que vale trazer de lá: o catálogo de funcionalidades no **servidor** (a tela
  não conhece nenhuma por nome), o **cadeado** no menu com uma mensagem
  configurável, e o **bloqueio no servidor** — digitar o endereço na mão não
  contorna.
  No servidor, o ponto de verdade é um middleware `requireFeature` com a mesma
  lista; e uma funcionalidade nova adicionada num deploy é completada com o
  padrão (`normalizeFeatureAccess`), então o sistema nunca fica em estado
  indefinido.
- **No deploy, tudo marcado** para os três perfis. **Atenção à diferença:** no
  Genus Praxis o visitante nasce com TUDO bloqueado (`defaults` em
  `server/features.js`); aqui o cliente pediu o contrário. Não copiar os padrões
  de lá.
- Admin e professor não aparecem na matriz: o acesso deles vem do papel.
- A tela de Acessos também guarda as configurações das §16.3 (IA e limites do
  externo) e §16.5 (quais atendimentos alimentam o gráfico do perfil).
- O catálogo de funcionalidades do all_os ainda precisa ser levantado
  (Competitivo, Duelo, Progressão, Objetivos, Logs sociais, Trilha, Antessala,
  Neuro, Comunidade…). Não é o mesmo do Genus Praxis.

### 16.3 IA e limite de gasto do terapeuta externo

Configurados **na tela de Acessos**:

- **Modelo de IA padrão do externo**, escolhido pelo admin.
- **Limite semanal por aluno externo**, em **dinheiro e em tokens** — os dois
  existem e valem juntos: bate o que chegar primeiro.
- **Ao estourar**, a pessoa recebe uma **notificação** para entrar em contato
  com o suporte, e não consegue gastar mais até a janela virar.
- **Convive com a cota que já existe** (3 sessões a cada 24h do externo, em
  `server/session-quota.js`). Os dois limites se somam; nenhum substitui o outro.

**Trocar de modelo muda o que cada limite significa** — e é por isso que os dois
existem juntos:

- O limite em **dinheiro** é o que protege o orçamento: continua valendo igual
  com qualquer modelo. Num modelo mais caro, a mesma verba compra menos tokens.
- O limite em **tokens** é o que protege contra uso abusivo independentemente de
  preço: num modelo barato, uma verba pequena ainda compraria muitos tokens.

Recomendação de desenho: **trocar o modelo não altera os limites sozinho**. A
tela mostra ao lado dos campos o equivalente com o modelo escolhido ("com o
modelo X, US$ Y ≈ Z tokens"), para o admin ver o efeito da troca e decidir se
ajusta. O custo de cada chamada já é calculado hoje (tabela de preços em
`server/avaliador-pipeline.js`), então o gasto acumulado pode ser medido com
a mesma conta.

A confirmar: "semana" é **janela deslizante de 7 dias** (como a cota de
sessões) ou **semana do calendário**, que zera num dia fixo.

### 16.4 Grupos (tags) de terapeutas

- O admin **cria tags livres** (ex.: "neuropsicólogo", "psicanalista").
- Na tela de Contas, **aplica uma ou mais tags** a cada terapeuta.
- **Futuro:** filtrar o **ranking** e os **logs** por tag.
- Substitui o "grupo" da §4 e da pergunta B3: não é turma nem vínculo com
  professor, é um rótulo que o admin atribui.

### 16.5 Critérios de avaliação no perfil e na sessão

**Dados:** o sistema já guarda a nota de cada critério em todo atendimento
avaliado (`criteriaScores` no log, e as análises completas em
`avaliacoes-criterios/`). Nada novo a registrar — é mostrar o que existe.

**Gráfico da sessão:** logo depois de um atendimento avaliado, o terapeuta vê o
gráfico poligonal (octógono enquanto houver 8 critérios) **daquela conversa
específica** — as notas de cada critério daquele log. Não é o do perfil.

**Gráfico do perfil:** na tela de perfil, o mesmo gráfico com o **acumulado** do
terapeuta em cada critério, calculado a partir das notas já guardadas (média das
notas daquele critério nos atendimentos que alimentam o perfil).

**Quais atendimentos alimentam o perfil** (Treinamento, Competitivo, Duelo,
Progressão…) é **configurável pelo admin na tela de Acessos**.

**Sigilo:** o aluno já vê a nota total e o feedback; as notas **por critério**
hoje são só de supervisor e admin (`CLAUDE.md` §5.1, `podeVerCriterios`). Mostrar
o gráfico ao próprio aluno **muda essa regra** para os números por critério. As
ANÁLISES por critério (o texto escrito com o gabarito à vista) continuam só de
supervisor e admin.

### 16.6 Critérios dinâmicos (8 hoje, 12 depois)

Hoje o número de critérios é fixo no código (`nCriterios: 8` em
`PIPELINE_VERSIONS`, `server/avaliador-pipeline.js`), num `.md` único dividido
por seções numeradas. A demanda:

- **O número de critérios vem do que o admin cadastrar**, não do código. O
  avaliador roda um nó por critério cadastrado, e o gráfico vira um polígono com
  tantos lados quantos critérios existirem.
- Na tela de Prompts, **"Adicionar critério"** abre uma caixa para o texto
  **daquele critério só** — o sistema não precisa adivinhar onde um critério
  termina e o outro começa.
- **O critério é identificado pelo NOME.** Mesmo nome = mesmo critério, e o
  histórico continua.
- **Critério novo começa do zero** para todo mundo.
- **Ao editar um critério existente**, o sistema **pergunta ao admin**: resetar o
  histórico desse critério para todos os usuários, ou manter os valores. Existe
  porque a edição pode ser só de português, e aí resetar seria perder dado à toa.
- Depende dos prompts no banco (§10.5 e §14.2): os critérios passam a ser linhas,
  não seções de um arquivo.

### 16.7 Dificuldade do paciente (TRI) — garantir que funcione

Regra pedida: depois de o terapeuta X atender o paciente Y e tirar a nota W, a
dificuldade de Y é atualizada **levando em conta o nível de X**. MMR alto e nota
baixa = paciente difícil, a dificuldade sobe (e o contrário).

**Isso já está implementado** em `server/mmr.js` (`updateMatch`): a nota
esperada sai da diferença entre o MMR do terapeuta e a dificuldade do paciente,
e a dificuldade anda na direção da diferença entre esperada e real
(`deltaD = 0.1 × (esperada − real)`). Pontos que a demanda precisa cobrir:

- **Teste explícito do cenário descrito** (MMR alto + nota baixa → dificuldade
  sobe; MMR baixo + nota alta → desce).
- Nas **3 primeiras partidas de um terapeuta** (calibração) a dificuldade **não
  muda** — é de propósito (sinal ruidoso), mas precisa estar documentado.
- Hoje roda **no Competitivo** (e no duelo, por `processDuel`). Estender a outros
  modos não foi pedido.
- Garantir que continua funcionando **depois da migração do MMR para o banco**.

**Status (2026-09-15):** ✅ coberto por `tests/tri-dificuldade.test.js` (§20.3).

### 16.8 Segurança da tela de login e do cadastro

Testar e verificar a segurança do login e do auto-cadastro, de ponta a ponta.
O fluxo existe e tem testes (`tests/cadastro.test.js`, `tests/auth.test.js`),
mas a verificação pedida vai além: enumeração de contas, força bruta e atraso
progressivo, captcha, confirmação por e-mail, redefinição de senha, revogação de
sessão, cabeçalhos de segurança. Em produção ela depende de configuração que em
dev está desligada: **e-mail** (Microsoft Graph — sem ele o link não chega),
**captcha** (Turnstile — sem ele o cadastro aceita sem captcha) e
**`APP_BASE_URL`** (sem ele o link do e-mail sai relativo).

---

## 17. Fase 1, etapas 9 a 13 — o que foi feito e decidido (2026-09-15)

Tudo na branch local `feat/postgres-fase1`, **sem commit e sem push**. Suíte:
**815 testes passando, 0 falhas** (eram 722 no fim da etapa 8).

### 17.1 Migrações e onde cada arquivo foi parar

| Migração | Substitui |
|---|---|
| `004_mmr_duelos.sql` | `mmr.json`, `character-records.json`, `duels.json` |
| `005_prompts.sql` | `PROMPTS_DIR` do volume e `prompt-backups/` |
| `006_sessoes_filas.sql` | `active-sessions.json`, `external-session-starts.json`, `batch-ledger.json`, `trilha-eval-queue.json`, `avaliacao-fila.json`, `avaliacao-v25.json`, `benchmark-fila.json`, `benchmark-lotes.json` |
| `007_notificacoes_gamificacao_operacao.sql` | `notifications.json`, `push-subscriptions.json`, `achievements.json`, `achievement-unlocks.json`, `counters.json`, `daily-missions.json`, `error-logs.json`, `feedback.json`, `settings.json`, `avatar-pool.json` |
| `008_sidequests_antessala.sql` | `sidequests.json`, `antessala.json` |
| `009_selecao_comunidade.sql` | `selection-logs.json`, `selection-stats.json`, `comunidade.json`, `comunidade-config.json` |

Cada gravação agora trava só a linha afetada. Toda escrita "lê o arquivo
inteiro → altera → regrava" virou transação sobre o item (§2.4.2).

### 17.2 Decisões de desenho

- **Documento em JSONB onde o dado já é um documento aninhado** que a tela lê
  e grava inteiro: duelo, discussão da Comunidade, mapa da Antessala, log do
  Processo Seletivo, jobs das ferramentas internas. As chaves de busca (dono,
  status, datas, batch) viram colunas indexadas. As transcrições do duelo e do
  seletivo ficam no documento, e não em linhas: são enviadas uma vez, no fim, e
  sempre lidas junto. A regra "uma linha por mensagem" vale para a conversa ao
  vivo, que são as sessões ativas.
- **Cópia em memória para o que é lido de forma síncrona e muda pouco**: prompts,
  configurações do admin (modelo de IA por categoria, senha do seletivo, pool de
  fotos, config da Comunidade) e sidequests. O banco é a verdade; a memória é
  carregada no boot e atualizada a cada gravação. ⚠️ **Isso exige UMA instância
  do app**, como já era com os arquivos (CLAUDE.md §2). Escalar para duas exige
  trocar essas cópias por leitura no banco ou por aviso entre instâncias
  (LISTEN/NOTIFY).
- **Prompts:** o histórico (`prompt_versoes`) é somente-inserção, garantido por
  gatilho no banco, e sem o teto de 20 versões. No primeiro boot com banco, os
  `.md` que estiverem no volume de produção entram sozinhos (o volume não é
  alterado). Réguas antigas (v25, v28, v29…) não são importadas.
- **Critérios (§16.6):** tabela `criterios`, identificados pelo **nome** dentro da
  régua. Hoje as linhas são derivadas do `.md` de critérios a cada gravação, e o
  avaliador continua lendo o `.md`. Critério que some fica `ativo = false`. Nome
  repetido é recusado pelo painel. A fase 2 ("Adicionar critério") passa a editar
  as linhas direto, sem migrar os prompts de novo.
- **TRI (§16.7):** testado no banco — MMR alto com nota baixa sobe a dificuldade,
  MMR baixo com nota alta desce, a calibração não mexe, e partidas simultâneas no
  mesmo paciente contam as duas.
- **Retenções que viraram poda no banco:** logs 30 dias, duelos 30, sessões ativas
  15, logs do seletivo 15, erros 30 dias e no máximo 500, ledger 26 horas.
- **Migrações one-shot que liam JSON antigo foram retiradas** (pool de avatar da
  Comunidade, limpeza de prompts de réguas antigas): com o começo limpo
  (perguntas.md P1), não há dado antigo a converter.

### 17.3 Segurança do login e do cadastro (§16.8)

**Verificado e coberto por teste:**
- Conta inexistente, senha errada e conta excluída respondem igual (401), e o
  tempo de resposta também, pelo hash-isca.
- Token sem assinatura, com outro segredo, vencido, de outro tipo (candidato do
  seletivo, vale de duelo) ou de conta excluída não abre sessão. O papel vem da
  conta viva: rebaixada, a pessoa perde o acesso com o mesmo token.
- Trocar ou redefinir a senha derruba as sessões.
- Links de e-mail: guardados só como hash; o de nova senha vale uma vez e vence em
  1h; o de confirmação vence em 48h; um não serve no lugar do outro; reenviar
  mata o link anterior; endereço sem conta não recebe nada e a resposta é igual.
- Cabeçalhos: CSP com `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS de
  1 ano, `nosniff`, `Referrer-Policy: no-referrer`, sem `X-Powered-By`.
- **Limites de tentativa, ligados de propósito num arquivo próprio**: 10 erros de
  login por IP em 15 min (acertos não contam); atraso progressivo por conta, de
  qualquer IP; 10 cadastros e 8 pedidos de nova senha por IP por hora; 30 tokens
  de visitante por IP em 15 min.

**Corrigido nesta etapa:**
1. **Memória:** o contador de falhas de login usava o nome digitado inteiro como
   chave, sem teto de tamanho (o JSON aceita 10 MB). Um ataque com nomes enormes
   de muitos IPs esgotaria a memória. Agora a chave tem no máximo 64 caracteres,
   e nome maior que qualquer username possível nem vai ao banco.
2. **Senha gigante no bcrypt:** o bcrypt só usa 72 bytes mas processava a string
   toda. A comparação agora usa até 256 caracteres, e nenhuma senha válida muda.
3. **CORS:** origem de fora virava erro 500 **e uma entrada no painel de Logs de
   Erro** a cada request. Como o painel guarda só as 500 mais recentes, repetir a
   request apagava os erros reais. Agora é 403 direto, sem registro.
4. **Login só aceita texto:** `{"username": ["admin"]}` era convertido para
   `"admin"`.

**Pendente, e depende da virada (§17.5):**
- ⚠️ **IP real atrás do Cloudflare.** Todo limite pré-login é por IP, e o app lê o
  IP do cabeçalho `CF-Connecting-IP`. Isso só é confiável quando o tráfego passa
  pelo Cloudflare. **Pelo domínio `*.up.railway.app` o cabeçalho é forjável e os
  limites caem.** No projeto novo do Railway: usar só o domínio próprio atrás do
  Cloudflare e não publicar o domínio do Railway. Se isso não for possível, o app
  precisa passar a aceitar o cabeçalho só vindo das faixas de IP do Cloudflare.
- Em produção, conferir que **e-mail (Graph), captcha (Turnstile) e
  `APP_BASE_URL`** estão configurados. Sem o captcha o cadastro aceita sem
  desafio; sem o e-mail nenhuma conta nasce.

### 17.4 O que continua em arquivo

- ~~**Catálogos de conteúdo**~~ — `freeplay-characters.json`, `exercises.json`,
  `neuro-characters.json`, `trilha-skills.json`. **Resolvido na mesma noite:
  foram para o banco** (`catalogo_itens`, migração `015_catalogo`) — ver §20.4.
  Só as fotos dos pacientes e dos exercícios continuam em disco.
- **No volume (arquivos, não linhas):** fotos (pacientes, perfil, pool, Comunidade),
  detalhe por critério de cada avaliação (`avaliacoes-criterios/`), raciocínio da
  Avaliação Independente (`avaliacao-reasoning/`) e transcrições do benchmark
  (`benchmark-runs/`). **O volume continua obrigatório** (§11, A3).

### 17.5 Para a virada (#14) e o export (#2) — a fazer com o usuário

- [ ] Export completo do sistema atual (#2) e cópia dos prompts do volume de
      produção para fora do Railway (§9.3), antes de qualquer mudança.
- [x] ~~Decidir os catálogos de conteúdo (§17.4).~~ → **no banco** (§20.4).
- [ ] Rodar `scripts/importar-volume.js` sobre a cópia de `/data` **antes do
      primeiro boot** do app novo (§18.1, `VIRADA.md` §3).
- [ ] Neon com Postgres 17; `DATABASE_URL` no projeto novo do Railway.
- [ ] Projeto novo com **o mesmo volume montado em `/data`**: é de lá que os
      prompts de produção entram no banco no primeiro boot, e onde ficam as fotos.
- [ ] **Uma instância só** (§17.2).
- [ ] Domínio próprio atrás do Cloudflare; domínio do Railway fora de circulação (§17.3).
- [ ] E-mail, captcha e `APP_BASE_URL` configurados (§17.3).
- [ ] Depois do primeiro boot: conferir em Administração → Prompts que os prompts de
      produção estão lá e que a avaliação roda.
- [x] ~~Commit e push para o fork `PauloHenriqueL/all_os`~~ → feito em 2026-09-18
      (branch `feat/postgres-fase1`, commit `dfe12de`).

---

## 18. Decisões de 2026-09-15 (tarde)

| Pergunta | Decisão |
|---|---|
| Começar limpo ou importar? | **Importar os dados atuais.** Substitui perguntas.md P1 e a nota da §13.1 #2. Script: `scripts/importar-volume.js` (§18.1). |
| Catálogos (pacientes, exercícios, neuro, trilha) no banco? | ~~Depois da virada.~~ **Mudou na mesma noite: vão para o banco já** (§20.4). |
| Semana do limite do externo (§16.3) | **Janela deslizante de 7 dias**, como a cota de sessões. |
| Comunidade (retenção e moderação) e temporadas | **Ficam para depois.** |
| O aluno vê as próprias notas por critério? (§16.5) | **Sim.** Muda a regra de `CLAUDE.md` §5.1 **só para os números por critério**: as ANÁLISES (o texto escrito com o gabarito à vista) continuam só de supervisor e admin. |

### 18.1 Importação do volume

A importação lê uma cópia da **pasta `/data` inteira** (não o export da tela, que
não traz sidequests, Processo Seletivo, configurações, feedback e filas) e roda
**antes do primeiro boot** do app novo. Detalhes e passo a passo em `VIRADA.md`.

---

## 19. Fase 2 — o que foi construído (2026-09-15)

Tudo no banco de dev, com testes; suíte completa verde (867 testes) e build do
cliente ok. Nada commitado.

Migrações novas: `010_tags`, `011_logs_nomes_criterios`, `012_uso_ia`,
`013_criterios_historico`. As tabelas novas entram no importador
(`TABELAS_DE_DADOS`) e no TRUNCATE dos testes.

### 19.1 A · Acessos (§16.2)

- Catálogo em `server/acessos.js` (13 funcionalidades × 3 perfis); matriz em
  `configuracoes` (chave `acessos`), nasce tudo liberado.
- Trava no servidor: `requireFeature` nas rotas e checagem por contexto em
  `/api/chat` e `/api/evaluate`. No cliente: cadeado no menu, tela de bloqueio e
  mensagem configurável. Tela: Administração → Acessos.

### 19.2 B · Modelo e limite semanal do Terapeuta externo (§16.3)

- Na tela de Acessos: modelo do **paciente** e do **avaliador** do externo
  (presets de `ai-models.js`; em branco = modelo da categoria) e limite em
  **US$** e/ou **tokens** por **7 dias corridos** (janela deslizante). Vale o
  que chegar primeiro.
- Cada chamada de IA do externo grava uma linha em `uso_ia` (turno do paciente
  e avaliação inteira, com custo pela tabela de preços). Linhas com mais de 30
  dias são podadas no boot.
- Estourou: `/api/chat`, `/api/evaluate`, `/api/transcribe` e a reflexão da
  Antessala respondem 429 com a mensagem e `renovaEm`; os admins recebem **um**
  aviso no sino por estouro (`uso_ia_alertas`).
- A tela mostra quantos tokens o limite em dólar compra em cada modelo (só
  entrada / só saída) e o uso de cada externo na janela.
- Convive com a cota de 3 sessões/24h, que não mudou.

### 19.3 C · Notas por critério para o aluno e gráficos (§16.5)

- O aluno recebe `criteriaScores` e `criteriaNames` no `GET /api/logs` quando
  "Notas por critério e gráfico" está liberado para o perfil. Continua sem
  `evalPartsId`, e `GET /api/logs/:id/criterios` (as análises) segue 403.
- O log grava o **nome** de cada critério na avaliação (`criteria_names`), no
  síncrono e no lote do Competitivo. Logs antigos caem nos nomes atuais da régua.
- Gráfico de radar em SVG puro (`RadarCriterios`) na aba Avaliação de cada log e
  no Perfil (média por critério, `GET /api/me/criterios`). Quais modos entram na
  média (Treinamento, Competitivo, Trilha, Neuro) é configurado em Acessos;
  padrão: Treinamento + Competitivo.

### 19.4 D · Critérios dinâmicos (§16.6)

- `nCriterios: 8` saiu; agora vale de **3 a 16** critérios
  (`server/limites-criterios.js`).
- Em Administração → Prompts, painel **Critérios da régua**: adicionar e editar
  critério (nome, linha curta, descrição) sem abrir o .md. O servidor monta o
  arquivo (`server/criterios-md.js`), relê no parser da produção e grava como
  edição comum, com versão anterior no histórico.
- Editar exige escolher **manter** (notas antigas seguem na média; num
  renomeio, o nome antigo vai para `nomes_anteriores`) ou **zerar** (a média
  recomeça em `historico_desde`). Critério novo começa sem notas.

### 19.5 E · Tags (§16.4)

- Tabelas `tags` (nome único sem caixa) e `user_tags`. Em Contas: card para
  criar, renomear e excluir, marcação por pessoa no formulário e coluna na
  tabela.
- Filtro por tag no Ranking (para todos) e nos Logs de supervisão.

### 19.6 Premissas — confirmadas em 2026-09-15 (ver §20)

1. A matriz de Acessos **só restringe**: marcar não abre o que o papel não
   alcançava (telas em desenvolvimento seguem só do admin; o visitante segue só
   com o duelo por link).
2. O limite semanal vale **só para o Terapeuta externo**; Allos e visitante não
   têm limite de gasto.
3. Com o limite estourado, o externo fica sem chat, avaliação, transcrição e
   reflexão da Antessala até a janela liberar. Uma avaliação **já em andamento**
   termina.
4. O **paciente** escolhido para o externo vale em todo chat dele (Treinamento,
   Competitivo, Duelo, Neuro), menos na Trilha, que escolhe por exercício. O
   **avaliador** escolhido vale onde a nota sai na hora (Treinamento e Neuro); o Competitivo em lote e o Duelo seguem com o avaliador da
   categoria, porque ali a avaliação não é de uma pessoa só.
5. Os textos dos prompts que citam "os oito critérios" (título do .md,
   sintetizador) **não são reescritos sozinhos**. O título do arquivo de
   critérios acompanha a contagem; o resto o admin ajusta em Prompts.
6. O filtro por tag do Ranking é visível a todos os alunos (a lista de nomes das
   tags não é sigilosa).

---

## 20. Decisões e entregas de 2026-09-15 (noite)

Suíte completa: **896 testes verdes** (71 arquivos); build do cliente ok. Nada
commitado. Migrações novas: `014_prompts_semente`, `015_catalogo`.

### 20.0 Respostas do usuário

| Tema | Decisão |
|---|---|
| Premissa 1 — Acessos só restringe | **Fazer o recomendado:** fica como está (só restringe). |
| Premissa 2 — quem tem limite de IA | **Só o Terapeuta externo.** |
| Premissa 3 — onde vale o modelo do externo | **Está certo** como na §19.6. |
| Premissa 4 — prompts que citam "oito critérios" | **Devem se ajustar sozinhos** → §20.1. |
| Premissa 5 — filtro de tag no Ranking | **Qualquer aluno vê.** |
| B6 — campos extras / "mais pontuação" | **Nenhum campo novo.** Ficam os que existem; o "mais" é o gráfico octogonal dos critérios (§19.3). |
| Prompts atualizados | Textos atualizados **e** entregues ao banco pela semeadura → §20.2. |
| TRI | Teste explícito → §20.3. |
| Catálogos | **No banco agora**, não depois da virada → §20.4. |

### 20.1 Prompts que se ajustam à quantidade de critérios

A solução tem três camadas, da mais forte para a mais fraca:

1. **Slots da régua** (`server/avaliador-pipeline.js`, `SLOTS_REGUA`):
   `{{N_CRITERIOS}}` (algarismo), `{{N_CRITERIOS_EXTENSO}}` (por extenso) e
   `{{LISTA_CRITERIOS}}` (número, nome e linha curta de cada um). Preenchidos no
   `loadAssets`, uma vez por versão, em todos os blocos (nó, sintetizador,
   missão). O texto só muda quando a régua muda, então o cache de prompt dos
   provedores continua valendo. Os parsers os aceitam e seguem recusando slot
   inventado.
2. **Textos sem número** nos prompts de semente do v34: os três cabeçalhos que
   diziam "oito nós" e a nota do octógono no `.md` de critérios foram
   reescritos, e o `.md` de critérios ganhou a orientação de usar os slots. O
   título ("Os N critérios") o painel já atualiza ao adicionar critério.
3. **Aviso no painel** (Prompts → Critérios da régua): lista, por arquivo e
   linha, qualquer trecho dos prompts do pipeline que escreva a quantidade à
   mão ("oito critérios", "oito nós", "octógono"…). Um teste impede que os
   prompts de semente voltem a fazê-lo.

Nenhum dos trechos com número ia ao modelo (estavam nas seções "Como usar",
antes do `## [METACOMANDO]`); a mudança é preventiva e de documentação.

### 20.2 Semeadura que atualiza prompts

Migração `014_prompts_semente.sql`: `prompt_arquivos.semente_hash` guarda o hash
do texto entregue pela semente. No boot (`promptsRepo.semear`):

- caminho novo → insere;
- banco com o texto da semente anterior (ninguém editou pelo painel) e semente
  nova diferente → **atualiza**, com a versão velha em `prompt_versoes`
  (motivo novo: `semente`);
- banco editado pelo admin → **preserva** e registra no log.

Fontes, na ordem: `DATA_DIR/prompts` (volume) e depois `avaliacao/` /
`entrevistador/` da máquina. Os prompts continuam **fora do git**; na produção
eles chegam pelo volume (`VIRADA.md` §3b). Localmente as duas cópias foram
atualizadas e o banco de dev recebe os textos novos no próximo boot.

### 20.3 TRI (§16.7)

`tests/tri-dificuldade.test.js`, 14 testes, sem divergência entre regra e código:

- motor puro: MMR alto + nota baixa → dificuldade sobe; MMR baixo + nota alta →
  desce; nota igual à esperada → não muda; em calibração (menos de 3 partidas)
  → não muda, e a 4ª partida já ajusta; magnitude `0,1 × (esperada − real)`
  conferida em várias combinações e com paciente "maduro"; piso 10 e teto 90;
- ponta a ponta pelo Competitivo (`POST /api/logs`, modo demonstração): a
  dificuldade gravada em `mmr_characters` muda na direção certa, persiste e é a
  que o `GET /api/freeplay` mostra; calibração também pelo banco.

`server/mmr.js` ganhou só comentário explicando a regra e por que a calibração
não mexe na dificuldade. O duelo usa o mesmo cálculo e não ganhou teste próprio.

### 20.4 Catálogos no banco

- Migração `015_catalogo.sql`: `catalogo_itens (tipo, id, ordem, doc JSONB)`,
  tipos `freeplay`, `neuro`, `exercicios`, `trilha_skills`. Documento JSONB
  porque cada catálogo tem campos próprios e o app sempre lê a lista inteira;
  `ordem` preserva a ordem de cadastro (o "Paciente em Destaque" é o último).
- `server/catalogo.js`: cópia em memória (as leituras continuam síncronas) e
  `atualizar(tipo, fn)`, que serializa as gravações de um catálogo — com o banco
  há um `await` no meio do "lê → altera → grava", e sem a fila duas edições
  simultâneas do admin perderiam uma. Item sem id ou com id repetido é recusado.
- Todas as rotas de admin dos quatro catálogos (criar, editar, excluir, foto)
  gravam pelo banco; as leituras usam a cópia em memória.
- **Primeira carga:** no boot, cada catálogo ainda não semeado vem do arquivo do
  volume (ou, sem ele, dos padrões de exemplo), uma vez só (marca em
  `configuracoes`). Um catálogo que o admin esvaziou não volta.
- **Importação:** `scripts/importar-volume.js` leva os quatro arquivos, com a
  marca de semeado.
- **Fotos continuam em disco** (`patient-photos/`, `exercise-photos/`).

### 20.5 Lacunas fechadas (2026-09-17)

Quatro pontas soltas do que a §19 entregou:

1. **Gráfico da sessão na tela pós-atendimento** (§16.5 pedia "logo depois do
   atendimento avaliado", e ele só existia em Minhas Sessões e no Perfil). A
   resposta do `POST /api/logs` passou a seguir a MESMA regra de sigilo do GET:
   o aluno leva as próprias notas por critério quando "Notas por critério e
   gráfico" está liberado, e nunca a chave das análises (`evalPartsId` vai
   `null`). O `EchoSession` desenha o radar logo abaixo da nota final.
2. **O aluno externo vê quanto já gastou**, no Perfil: barras de US$ e de tokens
   contra o limite dos 7 dias, e o aviso de quando volta a caber. Antes ele só
   descobria o limite ao ser barrado.
3. **Supervisor vê o gráfico de critérios do aluno**: botão "Gráfico de
   critérios" em cada terapeuta nos Logs de Supervisão, carregado sob demanda
   (`GET /api/me/criterios?userId=`, que já autorizava pelo vínculo).
4. **TRI no duelo**: três testes em `tests/tri-dificuldade.test.js` — o duelo
   ranqueado move a dificuldade como duas partidas em sequência (A, depois B); e
   nem calibração nem nota abaixo do piso anti-smurf (25) tocam no paciente.

Suíte: **902 testes verdes**; build do cliente ok.

---

## 21. Virada — execução (2026-09-22)

Primeira sessão de execução do `VIRADA.md`. O passo a passo detalhado vive lá;
aqui ficam as **decisões** e os **achados** que mudam o que estava escrito.

### 21.1 Decisão D1 — `JWT_SECRET` e VAPID: os mesmos

**Os mesmos da produção atual na virada; rotacionar o `JWT_SECRET` depois**, com
o sistema antigo fora do ar. Razão principal: os dois sistemas convivem no ar
durante a migração, e secrets diferentes deslogariam quem transitasse entre eles
— na semana de mais suporte. Detalhe e evidência no `VIRADA.md` §4.3.

Fecha a última pergunta em aberto da §13.3 que não era "para depois".

### 21.2 Etapa #2 da §13.1 — **feita**

A cópia do volume (`⬜` desde o início) saiu em 22/09: **9,8 MB → 3,3 MB**
comprimidos, tirados pelo **Console do painel do Railway** (sem instalar CLI),
baixados pelo painel **Files** e guardados em **três lugares** — disco, pen drive
e o Drive da Allos.

Verificado no pacote: `gzip -t` ok, 199 entradas, raiz `data/`, **os 10 `.md` de
prompt** (v34, v34-progressao, v34-duelo, avaliador 18 do neuro, entrevistador) e
os **4 catálogos**.

**Correção do que estava escrito:** o `VIRADA.md` e o `DEPLOY.md` mandavam usar
`railway run bash` para pegar o volume. Isso **não funciona** — `railway run`
executa na máquina de quem chama, com as variáveis do Railway injetadas, e não
enxerga o `/data` do container. Corrigido no `VIRADA.md`; **o `DEPLOY.md` segue
errado** (junto com outras defasagens: não cita `DATABASE_URL`, cita
`OPENAI_CHAT_MODEL`, que não existe mais, e manda usar um `.env.example` que não
está no repo).

### 21.3 Cobertura do importador — conferida contra o volume real

Os 30 `.json` que `server/importar-volume.js` lê estão cobertos, e os 4 catálogos
entram por `ARQUIVOS_CATALOGO`. Três arquivos que ele leria **nunca existiram em
produção** (`benchmark-fila.json`, `benchmark-lotes.json`,
`trilha-eval-queue.json`): são filas de ferramenta interna que só nascem no
primeiro uso, e arquivo ausente entra com o valor padrão.

Três arquivos do volume **não são lidos por ninguém** — nem pelo importador, nem
pelo `server/`: `desafio.json`, `desafio-history.json` e `updates.json`. Resto de
funcionalidade antiga. Não precisam migrar.

### 21.4 Banco no Neon

Postgres **17.11**, região **AWS us-east-2 (Ohio)**, endpoint **direto**.

- **Ohio foi mantido conscientemente**, embora `us-east-1` (Virgínia) fique ao
  lado do `us-east4` do Railway. Custo: ~10–15 ms por consulta em produção.
- 🔴 **Endpoint direto, não o `-pooler`.** O achado da sessão: o `-pooler` é
  PgBouncer em modo transação, e o runner de migrações segura um **advisory lock
  de sessão** (`server/db/migrate.js`, que já documenta precisar de conexão
  dedicada). Sob o pooler, a proteção contra dois processos migrando ao mesmo
  tempo sumiria **em silêncio**.
- **Object storage desligado** na criação: o app não usa bucket; as fotos ficam
  no volume do Railway.
- A connection string mora em `~/.neon-url` (`chmod 600`, fora do repositório) e
  entra nos comandos por substituição. **Não vai para o `.env`** — esse arquivo é
  lido pelo app e pela suíte a cada execução local, e o `npm run dev` passaria a
  falar com produção.

### 21.5 Importação — em andamento ao fim da sessão

`scripts/importar-volume.js` rodando contra o Neon vazio. ~2.900 inserções
(51 contas, 29 logs, 2.789 mensagens, 2 duelos, 1 log do seletivo).

**A importação é lenta por latência, não por volume:** ela insere um registro por
vez, e do Brasil até Ohio a latência medida foi de **639 ms por consulta** — algo
como 25 min no total. Em produção quem fala com o banco é o Railway, na mesma
costa. Vale anotar para ninguém achar que travou.

### 21.6 Ambiente de desenvolvimento, arrumado no caminho

O `.env` estava com **dois blocos colados** (dev e produção) e quatro variáveis
duplicadas — `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD` e o par VAPID. Como o dotenv
faz a **última** vencer, o dev estava rodando com o secret e o VAPID **reais de
produção**, e com `DATA_DIR=/data` e `APP_BASE_URL` apontando para o site no ar.

Separado em 22/09: `.env` só de desenvolvimento (sem chaves de IA nem de e-mail —
modo demonstração, nenhuma chamada paga e nenhum e-mail real sai da máquina) e
`.env.producao` com os valores reais, que **não é lido pelo app** e serve só para
colar no Railway. O `.gitignore` passou a cobrir `.env.*`, `data-backup*.tar.gz`
e `data/`.

Também nasceu `scripts/seed-demo-terapeuta.js`: cria um terapeuta com histórico
inventado (13 atendimentos avaliados, radar de critérios, MMR pelo motor de
verdade) para demonstrar o produto sem chamar IA. **Recusa rodar se a
`DATABASE_URL` não for local** — um seed desses em produção entra no ranking e
alimenta o TRI dos pacientes reais com notas falsas.

### 21.7 O que falta, em ordem

1. ⏳ Terminar a importação e **ler o relatório**.
2. ⬜ Prompts atualizados para o volume (`VIRADA.md` §3b) — **comparando antes**
   com os de produção, para não perder edição feita pelo painel.
3. ⬜ Projeto novo no Railway: volume em `/data`, variáveis (com a D1), uma
   réplica, `DATABASE_URL`.
4. ⬜ Domínio atrás do Cloudflare e `/api/admin/diagnostico-ip`.
5. ⬜ Conferência do `VIRADA.md` §6.
6. ⬜ Rotacionar o `JWT_SECRET` depois de o sistema antigo sair do ar (D1).
7. ⬜ Corrigir o `DEPLOY.md` (§21.2).
8. ⬜ Rodar a suíte: os 902 verdes são de 17/09 e **não há CI** (§8.2).

---

## 22. Decisões e entregas de 2026-09-23

### 22.1 Escopo da importação — decisão do dono

Para o banco novo sobem: **contas, contadores, catálogos (pacientes, neuro,
exercícios, Trilha), configurações, estatísticas anônimas do Seletivo, MMR das
contas, TRI dos personagens e os recordes 👑**.

**Não sobem:** `logs.json`, `duels.json`, `active-sessions.json`,
`selection-logs.json`, as filas de avaliação e o `progress.json` — tudo que
carrega **transcrição de atendimento**. A pasta reduzida é `data-parcial/`
(fora do git); o importador trata arquivo ausente com o valor padrão, então
basta não incluí-lo.

Consequências aceitas: Minhas Sessões, o radar do perfil e os Logs de Supervisão
nascem vazios. O **Ranking não é afetado** — ele se monta com contas + MMR e não
lê os logs.

O que se preservou ao subir o `mmr.json`: a dificuldade já medida de 8 pacientes
(46 a 52, uma delas com 12 partidas). Sem isso, todos voltariam a 50 e a
calibração recomeçaria do zero.

Efeito colateral bom: sem as 2.789 mensagens, a importação caiu de ~25 minutos
para segundos.

### 22.2 Ranking — **não haverá temporadas**

Substitui a §4.4 e a linha F da §13.2. O Ranking é **um lugar onde se entra e se
vê quem tem o melhor MMR, com filtro por tag** (Turma X, Turma Y). Não há
período, não há zeragem, não há histórico por temporada. A pergunta B2 de
`perguntas.md` fica sem efeito.

### 22.3 `POST /api/logs` passou a gravar `criteriaNames`

**O problema:** só o avaliador oficial (v34) gravava os nomes dos critérios junto
com as notas. Os outros caminhos (bloco `[notas-supervisor]`, logs de texto)
mandavam só os números, e a tela caía numa lista FIXA do cliente
(`labelsForCriteria`). Enquanto a régua tinha os 8 nomes de sempre, passava
despercebido — mas com "Adicionar critério" (§16.6) o admin renomeia, e a tela da
sessão mostraria o nome antigo enquanto o Perfil, que resolve pela régua,
mostraria o novo.

**A correção** (`nomesDaReguaPara`, em `server/index.js`) carimba os nomes da
régua ativa, com duas guardas:

- **só em `freeplay`** — Neuro tem régua própria (v18.25) e a Trilha tem
  critérios próprios; carimbar o v34 neles trocaria um rótulo errado por outro;
- **só quando os números das notas batem exatamente com os da régua** — melhor
  ficar sem nome (e cair no fallback de hoje) do que somar a nota de um critério
  ao nome de outro. É a mesma regra que `criterios-perfil.js` já aplicava.

Verificado nas três situações: freeplay com 8 notas carimba; neuro não; freeplay
com 6 notas não.

### 22.4 Peso do TRI virou configuração do admin (§16.7)

O quanto uma população anônima move a dificuldade dos pacientes era só variável
de ambiente (`TRI_PESO_SELECAO`, `TRI_PESO_VISITANTE`), e ajustar exigia deploy.
É um **parâmetro de calibração**, que só se afina com dados reais na mão.

Agora está em **Administração → Acessos**, por população, de **0 a 1**:

- **0** desliga a influência daquela população no TRI;
- **1** a iguala à de um aluno cadastrado, que é a referência fixa;
- o teto é 1 porque acima disso a população anônima pesaria MAIS que a pessoa
  conhecida, invertendo a razão de o peso existir.

As variáveis de ambiente continuam, como **padrão de fábrica** para quem nunca
tocou na tela. O valor é lido **a cada atendimento**, então vale já no próximo —
e **não recalcula** as dificuldades já medidas.

Novo: `POOLS_TRI` e `normalizarPesosTri` em `server/acessos.js` (módulo puro),
`pesosTri` em `lerAcessos()`, campo no `PUT /api/admin/acessos`, seção na tela
`AdminAcessos.jsx`, teste em `tests/tri-peso-acessos.test.js`.

### 22.5 Bug que eu mesmo introduzi no `.gitignore`, corrigido

A regra `data/` que entrou em 22/09 para excluir a cópia do volume casava com
**qualquer** pasta chamada `data` em qualquer nível — inclusive `server/data/`, a
semente do repositório. Corrigido para `/data/` e `/data-parcial/` (barra na
frente = só na raiz). Fica o registro: em `.gitignore`, padrão sem barra inicial
é recursivo.

### 22.6 Documentação

- **`MMR.md`** (novo): a fórmula completa — as duas grandezas, os 6 passos de uma
  partida, exemplo numérico conferido, calibração, regressão do paciente, duelo,
  camada anônima com os pesos, persistência, concorrência, constantes, cobertura
  de testes e perguntas frequentes.
- **`DEPLOY.md`**: estava desatualizado e com uma instrução que não funciona.
  Corrigidos: `DATABASE_URL` (ausente, e é fail-closed) com o aviso do endpoint
  direto; `OPENAI_CHAT_MODEL` (não existe mais) trocado pelas senhas a rotacionar
  e pelo `CONFIAR_CF_CONNECTING_IP`; a referência a um `.env.example` que não
  existe; e o `railway run bash` do backup, que **não enxerga o `/data`** —
  substituído pelo Console + painel Files.

### 22.7 Testes — **não rodados**, por pedido do dono

`tests/tri-peso-acessos.test.js` foi escrito mas **não executado**, e a suíte não
roda desde 17/09. Rodar antes de qualquer deploy.

### 22.8 Suíte rodada e 6 bugs corrigidos (2026-09-23)

A suíte rodou pela primeira vez desde 17/09. **5 falhas** e, na revisão do
próprio diff, **mais 5 defeitos** que os testes não pegariam. Todos corrigidos;
estado final: **73 arquivos, 921 testes verdes** e build do cliente ok.

**1. Referência órfã derrubava o painel de TRI.** Ao renomear `TRI_PESOS` para
`TRI_PESOS_PADRAO` (§22.4) ficou um uso para trás em `/api/tri/personagens`, que
passou a devolver **500**. Foi o que as 5 falhas de `tri.test.js` acusaram — o
teste existente fez o trabalho dele. A rota agora lê o peso da configuração do
admin, que é o valor que ela precisa mostrar.

**2. Seed de demonstração apagava o MMR de todo mundo.** 🔴
`scripts/seed-demo-terapeuta.js` usava `mmrRepo.importar()`, que **TRUNCA**
`mmr_players`, `mmr_characters` e `mmr_anon_players` antes de inserir. Num banco
restaurado do volume — o alvo natural do script — isso apagaria o MMR de todas as
contas, a dificuldade medida de todos os pacientes e as populações do TRI. Agora
usa `mmrRepo.aplicar`, o mesmo caminho de uma partida real. Verificado: dois
terapeutas semeados em sequência coexistem, e os personagens mantêm o TRI.

**3. Peso 0 congelava a população em vez de só desligar a influência.** O
`return` antecipado pulava o `aplicar` inteiro, então o rating da população
parava de aprender. Religar o peso mais tarde retomaria de um rating que nunca
aprendeu — exatamente a inflação do D que a camada anônima existe para evitar.
Agora a população continua aprendendo e o **personagem não é gravado**: devolvê-lo
o gravaria com `n_D` a mais e um ponto novo no histórico da regressão, ou seja,
a população moldaria o D por outro caminho.

**4. `Number(env) || padrao` engolia o 0.** `TRI_PESO_SELECAO=0` caía no 0,35 em
vez de desligar. 0 aqui não é "não informado".

**5. Campo vazio desligava o TRI em silêncio.** `Number(null)`, `Number('')` e
`Number(undefined)` são **0**, e 0 significa "desligado". Um campo apagado na tela
desligaria o ajuste de dificuldade em vez de voltar ao padrão. Foi **o teste novo
que pegou**. `normalizarPeso` agora testa vazio ANTES do `Number()`; zero
digitado continua valendo zero, e a tela avisa "vazio: salva o padrão do sistema".

**6. Consulta sem guarda podia perder o atendimento do aluno.** A busca dos nomes
da régua (§22.3) é a primeira ida ao banco no `POST /api/logs`; uma falha
transitória devolveria 500 e o aluno perderia a sessão terminada. Agora em
`try/catch`: sem os nomes o log é salvo do mesmo jeito e o erro vai para o painel.

**Menores, no mesmo lote:** a consulta de critérios do seed não filtrava por
régua e assumia exatamente 8 critérios (quebraria com o "Adicionar critério" que
esta própria branch entrega); e o comentário do campo de peso prometia aceitar
vírgula, que `<input type="number">` descarta.

**Testes novos:** `tests/tri-peso-acessos.test.js` (14 casos — saneamento dos
pesos e o comportamento de peso 0 no motor) e `tests/log-criterio-nomes.test.js`
(5 casos — o carimbo dos nomes e as duas guardas).

---

## 23. Decisões do dono e entregas (2026-09-23, tarde)

### 23.1 Fase 4 — **volume novo, com a cópia restaurada**

O projeto novo do Railway **não** compartilha o `all_os-volume` com o antigo.
Razão técnica: os prompts atualizados do v34 usam `{{N_CRITERIOS}}`,
`{{N_CRITERIOS_EXTENSO}}` e `{{LISTA_CRITERIOS}}`, e quem os substitui é
`server/avaliador-pipeline.js` — que **só existe nesta branch**. Verificado: o
`main` não tem nenhuma ocorrência. Com volume compartilhado, copiar os prompts
novos mudaria os prompts do sistema que ainda está no ar, que não sabe lê-los.

Com volume próprio, a Fase 4 é feita antes de subir o app, sem janela, e o plano
de volta fica limpo: o projeto antigo segue intocado até ser desligado.

### 23.2 Remover critério = **desativar** (coluna `ativo`)

Fecha a demanda do administrador (§22 da lista de pendências). O critério **sai
da régua e das próximas avaliações**, mas a linha em `criterios` fica com
`ativo = false`: nome, `historico_desde` e `nomes_anteriores` continuam lá.

Por que não apagar: o gráfico do perfil junta critério pelo **nome**
(`server/criterios-perfil.js`), então apagar a linha deixaria as notas antigas
órfãs. E a nota final é `soma ÷ (nº de critérios × 10)` — mudar a base sem mais
faria o ranking e o MMR misturarem duas réguas.

**Como funciona.** O arquivo `.md` da régua continua sendo a fonte da verdade:
`removerCriterio` (em `server/criterios-md.js`) tira o bloco e a linha curta,
**renumera os que sobram** e atualiza o título; ao gravar, a sincronização
(`sincronizarCriterios`) marca como inativo tudo que não está mais no arquivo.
O mecanismo já existia — faltava a operação.

Detalhes que a implementação garante:

- **Renumera.** A numeração é posicional (é o lado do polígono do gráfico), não a
  identidade — essa é o nome. Deixar buraco desenharia um gráfico com um lado
  faltando.
- **Piso de 3 critérios** (`limites-criterios.js`), recusado com mensagem clara.
- **Repor com o mesmo nome reativa a MESMA linha**, com o mesmo `id` e o
  histórico junto. Coberto por teste.
- Nome do admin pode ter caractere de RegExp; o módulo escapa antes de renumerar.
- Na tela (Administração → Prompts → Critérios da régua): botão **Desativar** com
  confirmação em duas etapas, desabilitado no mínimo, e a mensagem diz o que
  acontece com as notas já dadas.

`DELETE /api/admin/criterios/:num`, só admin. 11 casos em
`tests/criterios-remover.test.js`.

### 23.3 Conta renomeada na importação

`Victor.toscano` → `Victor.toscano-39` (colisão só de maiúsculas). **A pessoa já
foi avisada** pelo dono. Nada a fazer.

### 23.4 `ESTADO.md` — o ponto de partida de quem retoma

Este documento cresceu para ~1.400 linhas e é histórico: bom para saber **por
que** algo é como é, ruim para saber **onde paramos**. Criado o `ESTADO.md`, que
responde só isto: o que está feito, o que falta para o deploy (com os comandos),
as decisões fechadas que não se rediscutem, como subir o ambiente local de
demonstração e as pontas soltas conhecidas.

O `CLAUDE.md` — que é o arquivo lido em toda sessão nova — aponta para ele logo
no cabeçalho, e ganhou a §6b com as mudanças de 23/09 e três convenções que
custaram tempo nesta sessão: os testes usam `require` e as globais do vitest;
não há CI; e em `.gitignore` padrão sem barra inicial é recursivo.

---

## 24. Reforma do MMR e TRI por critério + política de retenção

> **Em andamento na branch `feat/postgres-fase1` (2026-09-24).** §24.0 (retenção)
> completo. §24.1–§24.5 no servidor: migrações 016+017 escritas, motor
> `server/mmr.js` reescrito por critério, `server/repos/mmr.js` ajustado (recorde
> aceita `origem` + `userId` null), wrappers `aplicarPartidaCompetitiva`,
> `registrarTriAnonimo` e `applyDuelMmr` migrados, rotas `/api/logs` e
> `/api/tri/personagens` adaptadas, recorde 👑 do seletivo criado (spec §9),
> `mmr_delta` no log gravado (spec §12). Falta: testes reescritos (os antigos
> quebram por definição — spec §16), front das 5 telas da §10 (perfil/radar,
> ranking, ficha, duelo, dashboard do seletivo), `MMR.md` reescrito, marcar
> `ESTADO.md`. Nada foi commitado ainda.

Duas mudanças acopladas: (i) o motor de MMR e TRI passa a ser **por critério**
(spec do Alan em `MMR-por-criterio.md` da branch de trabalho — resumida em §24.1)
e (ii) o banco vira **persistente e contínuo** para dados de aluno (§24.0).

A prioridade zero é (ii): a retenção sai antes, porque a reforma do MMR pressupõe
um histórico que não expira. Só então o motor é reescrito.

### 24.0 Prioridade zero — nenhum dado de aluno é mais apagado

Decisão do dono: `logs`, `duels`, `selecao_logs` e a Comunidade passam a ser
**persistentes**. A retenção descrita em CLAUDE.md §5.5 (logs 30d, duelos 30d,
seletivo 15d) **sai**. Motivo: o banco é para ser contínuo, e o histórico do
aluno precisa estar disponível para o supervisor e para o próprio aluno sem
janela.

**O que NÃO muda.** Credenciais em voo — `pending_registrations` (48h),
`password_resets` (1h), `email_changes` (48h) — continuam com TTL curto. São
hashes de credencial, não dado do aluno; manter para sempre é risco de
segurança (token capturado num backup vazado vira porta de entrada).

**O que precisa mexer** (mapeamento real do código — não existe `server/jobs.js`;
as podas moram nos repos e são chamadas por wrappers no `index.js`, disparados
no boot e por rotas de admin):

- **Logs (30d).** `LOG_TTL_DAYS` em [server/index.js:3545](server/index.js#L3545);
  `podarLogsVencidos` em [server/index.js:3557](server/index.js#L3557); a
  implementação em [server/repos/logs.js:300](server/repos/logs.js#L300)
  (`podarVencidos`). Remover a constante e o wrapper, e deixar de chamar
  `logsRepo.podarVencidos` no boot. A função no repo pode ficar (nunca chamada)
  ou ser removida junto — recomendo remover, para não deixar arma carregada.
  A rota que expõe o TTL para o front (`GET /api/…/ttl`, linha 3612) devolve
  `null` ou some.
- **Duelos (30d).** `DUEL_TTL_MS` em [server/index.js:8920](server/index.js#L8920);
  `podarDueisVencidos` em [server/index.js:8999](server/index.js#L8999); repo em
  [server/repos/duelos.js:89](server/repos/duelos.js#L89). Mesmo tratamento.
- **Seletivo (15d).** `SELECTION_LOG_TTL_DAYS` em
  [server/index.js:6179](server/index.js#L6179); poda em
  [server/index.js:6216](server/index.js#L6216) e no boot em
  [server/index.js:11462](server/index.js#L11462); repo em
  [server/repos/selecao.js:99](server/repos/selecao.js#L99). **Cuidado:** a mesma
  constante `SELECTION_LOG_TTL_MS` também é a **janela de dedup por WhatsApp**
  ("1 avaliação por WhatsApp a cada 15 dias", usada em
  [server/index.js:7236](server/index.js#L7236) e no `expiresAt` exposto ao
  front em [server/index.js:7404](server/index.js#L7404)). A janela de dedup
  **fica** (é regra de negócio); só a **exclusão do registro** sai. Ou seja:
  renomear a constante para `SELECTION_DEDUP_WHATSAPP_MS`, remover a chamada de
  `selecaoRepo.podarVencidos`, e ajustar o `expiresAt` (agora não expira — o
  campo some ou vira `null`).
- **`server/repos/contas.js:529` (`podarVencidos`) FICA.** Poda
  `pending_registrations`, `password_resets` e `email_changes` — hashes de
  credencial em voo (§24.0 acima). É segurança, não retenção de dado do aluno.
- **CLAUDE.md §5.5** — reescrever a política de retenção (só credenciais em
  voo têm TTL agora).
- **Índices por data de criação** (`duels_criado_em_idx`,
  `selecao_logs_criado_em_idx`, `logs (timestamp)`) perdem a razão original
  (serviam à poda), mas continuam úteis para listagens ordenadas — mantêm.
- **Janelas do motor MMR (§12 da spec) NÃO são "logs".** Os teto de 200 pontos
  por critério × caso e de 10 pontos por critério × aluno são janelas do
  estimador — o mais antigo sai quando entra um novo. Nada muda aí.

Ordem: essa mudança entra numa migração/PR próprio **antes** da reforma do MMR.

### 24.1 O que a reforma do MMR pede (resumo)

Hoje o MMR do aluno (P) e a dificuldade do caso (D) são calculados sobre a
**nota total** da avaliação. A reforma passa tudo para **por critério** (`P_c`,
`D_c`), introduz uma **nota ponderada** (`N_c = S_c + (D_c − 50)`, sem teto e
sem piso, recalculada na exibição a partir do D atual), e corrige bugs
conhecidos da fórmula antiga (spec §3.9 e §4): sai o `S_aj = 50 + (S − S_esp)`,
sai a inclinação genérica 0,5, sai o intercepto livre da regressão, sai o peso
reduzido do seletivo/visitante sobre o D, sai o bloqueio do D durante a
calibração.

Totais (nota total ponderada, MMR total, D total) deixam de ter conta própria e
passam a ser **derivação** dos valores por critério — a mesma agregação linear
do `server/scoring.js` (soma × 100 ÷ base).

**Regras novas de entrada de avaliação (spec §3.1):**

- Avaliação de conta admin não move nada.
- Nota total bruta < 25 não move o D (não conta como movimento), mas move o P.
- Critério que a IA não devolveu é pulado só para aquele critério.

**Recorde 👑** passa a considerar o Processo Seletivo (spec §9): candidato pode
bater recorde, e o nome exibido é o do formulário. Visitante e admin continuam
fora.

**Recomeço.** Todo o estado do motor (`mmr_players`, `mmr_characters`,
`mmr_anon_players`) recomeça em P=50/D=50 por critério. Os recordes 👑 são
mantidos. Nada é preservado do estado antigo do MMR — os valores atuais foram
calculados com a fórmula enviesada e não valem como semente.

**Fora da reforma:** Neuro (critérios próprios, nunca moveu MMR), Trilha e
Progressão (verificado no código: `mmrRepo.aplicar` só é chamado em Competitivo,
Duelo e populações anônimas do Seletivo/Visitante).

### 24.2 Impacto no schema do PostgreSQL

**Tabelas cujo schema NÃO muda** (só o conteúdo do JSONB):

- `mmr_players (user_id, estado JSONB, atualizado_em)`
- `mmr_characters (character_id, estado JSONB, fontes JSONB, atualizado_em)`
- `mmr_anon_players (pool, estado JSONB, atualizado_em)`

O motor (`server/mmr.js`) é dono do formato do `estado` — o comentário da
migração 004 já registra essa separação. A reforma reescreve o motor e o
formato do JSONB por dentro; o schema fica intacto. `mmrRepo.aplicar`
(server/repos/mmr.js) continua fazendo o mesmo: `INSERT ... ON CONFLICT DO
NOTHING` para criar a linha vazia, `SELECT ... FOR UPDATE` para travar, o
motor calcula, `UPDATE` grava. A concorrência do estado por critério é a mesma
do estado atual — linha por caso, linha por aluno.

**Tabelas que mudam:**

`character_records` — hoje `user_id BIGINT REFERENCES users(id)`. Candidato do
Seletivo não existe em `users`, então:

- Remover a FK de `user_id` (fica `TEXT` ou `BIGINT` nullable sem `REFERENCES`,
  como `duels.challenger_id`);
- Coluna nova `origem TEXT NOT NULL DEFAULT 'competitivo'` com valores
  `'competitivo' | 'selecao'`;
- `user_name` continua sendo a exibição; para candidato, o registro **copia**
  o nome de `selecao_logs.doc.candidate.nome` no momento em que o recorde é
  batido (não depende de join com `selecao_logs` — a spec §9 permite isso, e
  garante que a ficha do caso continua funcionando mesmo se a origem sumir).

`logs` — coluna nova `mmr_delta JSONB`. A spec §12 pede que cada avaliação
guarde "MMR antes e depois, por critério e total". A janela de `mmr_players`
guarda "MMR de antes" só para as últimas 10 avaliações; depois disso a
informação se perde. Com a persistência da §24.0 valendo, faz ainda mais
sentido guardar essa auditoria completa no próprio log.

`logs.criteria_scores` — hoje é `{"1": nota, "2": nota, …}` com chave
posicional. A spec §17 pede id **estável** do critério. Migração: passa a ser
`{"<criterios.id>": nota}` (id do banco). Logs velhos ficam com chave
posicional; o front reconstrói a identidade via `criteria_names` (coluna já
existe desde a migração 011) + join com `criterios.nome`. **Não há backfill em
massa** — a migração adiciona; os logs novos entram no formato novo.

`mmr_characters.fontes` — hoje é global por caso
(`{competitivo: 12, selecao: 3, visitante: 1}`). A spec §12 pede a contagem
**por critério** ("quantos movimentos do D vieram de cada origem", dentro do
bloco caso × critério). Vira `{[criterioId]: {competitivo, selecao, visitante}}`.
Motivo: com D por critério, um caso pode ter só o competitivo movendo o critério
"manejo do vínculo" enquanto o seletivo domina "interpretação"; a dashboard de
TRI precisa ver isso separado.

**Tabelas sem mudança:**

`selecao_logs` — o nome do candidato mora em `doc.candidate.nome`, que é lido
no momento do recorde e copiado para `character_records`.

`criterios`, `criterios_historico` (via colunas `historico_desde` e
`nomes_anteriores` na migração 013) — identidade dos critérios já está
estruturada. A reforma passa a usar `criterios.id` como chave dentro do JSONB
do motor, o que casa naturalmente com o schema atual.

`duels` — o `doc` continua sendo lido inteiro; a soma-zero por critério da
spec §7 acontece no motor, dentro do JSONB de `mmr_players` dos dois lados.

### 24.3 Formato do JSONB novo (esboço não-normativo)

O motor é dono desta forma; o esboço abaixo só orienta a implementação.

```
mmr_players.estado = {
  nEntradas: 42,                    // qtd de avaliações que entraram no sistema
                                    // (§6: inclui as < 25, que movem o P)
  criterios: {
    "<criterioId>": {
      P: 62.3,                      // MMR atual do critério (0–100)
      n: 8,                         // qtd de avaliações do aluno nesse critério
      janela: [                     // 10 mais recentes (§3.7)
        { N: 71, D_antes: 55, P_antes: 60 },
        ...
      ]
    },
    ...
  }
}

mmr_characters.estado = {
  criterios: {
    "<criterioId>": {
      D: 63.1,                      // dificuldade atual do critério (10–90)
      n_D: 12,                      // movimentos do D nesse critério
      beta: 1.0,                    // inclinação da regressão (0,5–1,5)
      historico: [                  // 200 pontos (§4)
        { P: 60, D_antes: 61, S: 72 },
        ...
      ]
    },
    ...
  }
}

mmr_characters.fontes = {
  "<criterioId>": { competitivo: 5, selecao: 2, visitante: 0 },
  ...
}

mmr_anon_players.estado = { ... }   // mesmo shape de mmr_players.estado
```

### 24.4 Migrações necessárias

Duas migrações SQL + um PR de código:

1. **PR "retenção" (antes de tudo)** — remover jobs de poda em `server/jobs.js`
   (`logs`, `duels`, `selecao_logs`), reescrever CLAUDE.md §5.5. Sem SQL. Vai
   sozinho, é uma decisão de política.

2. **`016_mmr_por_criterio.sql`** — schema:
   - `ALTER TABLE character_records DROP CONSTRAINT` da FK, `ADD COLUMN origem TEXT`;
   - `ALTER TABLE logs ADD COLUMN mmr_delta JSONB`;
   - Nada em `mmr_players`/`mmr_characters`/`mmr_anon_players` (o formato do
     JSONB muda pelo código, não pelo SQL).

3. **`017_mmr_reset.sql`** — reset one-shot, rodado no deploy que vira a chave
   da fórmula nova:
   - `TRUNCATE mmr_players`;
   - `TRUNCATE mmr_characters`;
   - `TRUNCATE mmr_anon_players`;
   - **Não toca** em `character_records` (spec §11);
   - **Não** preserva o estado antigo (decisão do dono: os valores foram
     calculados com fórmula enviesada e não valem para nada).

Marcadores em `migrations.json` (agora tabela `db_migracoes`) para garantir
que o reset roda uma única vez.

### 24.5 O que fica fora da reforma

- **Neuro.** Critérios próprios (`server/neuro-characters.js`), nunca moveu
  MMR/TRI. Segue com a régua dele.
- **Trilha.** Progresso em `progress.json` (agora tabela `progresso`), sem MMR.
- **Progressão.** Idem — não chama `mmrRepo.aplicar`.
- **`server/scoring.js`.** A spec §14 confirma: a nota final continua sendo
  código, não IA. O `scoring.js` só é chamado por Neuro e por logs antigos
  (comentário no próprio arquivo diz isso). Fica intocado.

### 24.6 Plano em fases

1. **Retenção** (§24.0) — PR próprio, sem depender de mais nada.
2. **Migração `016`** — schema novo.
3. **Motor `server/mmr.js`** — reescrita completa, seguindo a spec §3 a §7.
   Fica puro e testável, como está hoje.
4. **Repositório `server/repos/mmr.js`** — ajustes pequenos: `newPlayer` /
   `newCharacter` / `newAnonPopulation` passam a devolver o formato novo; o
   `aplicar` não muda de contrato; snapshot/importar passam a serializar/ler
   o formato novo.
5. **Testes.** Os testes atuais que verificam as fórmulas antigas quebram por
   definição (spec §16, aviso final). Reescrever com os 16 critérios de aceite
   da spec.
6. **Front.** Perfil, ranking, ficha do caso, tela do duelo, tela do
   avaliador do seletivo (nota ponderada visível para supervisor/avaliador —
   spec §8 e §10). Aluno nunca vê nota > 10; MMR do perfil pode passar de 10.
7. **Migração `017` + deploy** — reset, virada da chave, ranking recomeça.
8. **Atualizar `MMR.md` e `ESTADO.md`.**

### 24.7 Verificado no código (spec §17)

Antes de fechar a análise, os pontos que a spec pediu para conferir:

- **`server/scoring.js` é linear.** Confirmado: `sum / (vals.length * 10) * 100`,
  arredondado. Sem regra não linear (sem teto, sem critério eliminatório, sem
  penalidade). O aviso da spec §18 fica registrado: se um dia a agregação
  ganhar regra não linear, a derivação dos totais (§5) precisa ser revista.
- **Cada avaliação já guarda a nota bruta por critério.** Sim: `logs.criteria_scores`
  (JSONB) desde a migração 003. Falta migrar a **chave** para o id estável
  (§24.2).
- **Como uma conta de administrador é identificada.** `users.role = 'admin'`.
  Múltiplos pontos em `server/index.js` já usam essa forma. O motor recebe o
  `role` pela borda (ou o próprio `aplicar` recebe um flag `bloquearMotor`).
- **Onde o nome do candidato do seletivo está registrado.** `selecao_logs.doc.candidate.nome`
  (a rota do seletivo grava o formulário lá). É o valor a copiar para
  `character_records.user_name` quando o recorde é batido.
