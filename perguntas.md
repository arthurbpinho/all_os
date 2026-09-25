# Perguntas em aberto — Migração para PostgreSQL

**Documento preparado para a reunião com o chefe (dono do sistema).**

Cada pergunta tem um espaço `**Resposta:**` logo abaixo para anotação durante a
reunião. O que já está decidido vive em [demandas.md](demandas.md).

Última atualização: 2026-09-15 — respostas do cliente registradas (demandas.md
§16.1, §18 e §20). **Todas as perguntas têm resposta**; ficam **para depois** B2
(temporadas) e P11 (comunidade). P1 e A1 mudaram: **os dados atuais serão
importados**, incluindo os catálogos (§20).

Revisão anterior (2026-09-14): após o `git pull` que trouxe ~15 commits novos e
o `CLAUDE.md`. Duas respostas antigas ficaram desatualizadas — ver A6 e A9.

Legenda:
- 🔴 **Trava a fase 1** (migração) — sem isso não dá pra começar.
- 🟡 **Trava a fase 2** (features novas) — dá pra migrar antes.
- 🟢 **Não bloqueia** — decidir quando for conveniente.

**Ordem deste documento:** da pergunta que mais trava para a que menos trava —
dentro de cada nível de urgência, a ordem também segue dependência (uma
pergunta que outra referencia vem antes dela). **Exceção:** o que ainda está
sem resposta vem primeiro de tudo (seção ❗), não importa o nível de urgência
original — é o que mais precisa de tempo na reunião.

---

## ⚠️ ANTES DA REUNIÃO — LEIA ISTO

Um achado desta análise é urgente e **independe de qualquer decisão** tomada na
reunião:

> **Os prompts de avaliação (critérios de nota e gabaritos) existem hoje em UM
> único lugar no mundo: o volume do Railway.**
>
> Não estão no git (`.gitignore` linhas 43-44), não estão na máquina do Paulo
> (as pastas `avaliacao/` e `entrevistador/` nem foram clonadas), e o backup
> interno (`prompt-backups/`) fica **no mesmo volume** — então não protege
> contra a perda dele.

Se aquele volume for perdido, os critérios de avaliação da Allos vão junto, sem
origem de restauração. Isso já é verdade agora — a migração apenas mexe
justamente nessa infra. **Ver P2, logo abaixo.**

---

# ❗ SEM RESPOSTA AINDA — priorize estas na reunião

Todo o resto do documento (🔴, 🟡 restante e 🟢) já tem resposta registrada.
As 9 perguntas abaixo (bloco "aluno Allos × externo", fase 2) vieram para o
topo por estarem em branco. **Em 15/09 o cliente respondeu todas** (as
respostas estão em cada uma); a **B2** ficou para depois.

## 🟡 B1. Haverá rankings separados — e como isso convive com B0?

Foi dito que haverá "ranking só dos alunos da Allos". Hoje existe **um**
ranking e **um** MMR global.

Combinado com B0 (o aluno leva o rating ao trocar de lado):

1. Alunos Allos e externos **duelam entre si**, ou são mundos separados?
2. Se separados: quem troca de lado entra no ranking novo com um rating
   construído **contra outra população**. Isso é justo/aceitável?
3. O aluno tem **um** rating, ou um por ranking?
4. O aluno externo aparece em **algum** ranking, ou em nenhum?

**Resposta (15/09):** **Um ranking só**, com todo mundo (Allos e externo). Um
rating por pessoa. Existe filtro por **tag** no ranking (demandas.md §16.4),
que não separa populações — só mostra um recorte.

---

## 🟡 B2. "Semanas só para eles" — é temporada?

1. Temporada tem **início e fim** definidos? De quanto tempo?
2. Ao terminar, o ranking **zera**, cai um pouco (*soft reset*), ou só é
   arquivado?
3. Há premiação ou registro do campeão?
4. Aluno externo tem temporada própria, ou simplesmente não tem?

**Nota técnica:** se houver temporada, isso precisa entrar na modelagem de MMR e
duelos **desde cedo** — acrescentar depois, sobre dados acumulados, é caro.

**Resposta (15/09):** temporadas **continuam existindo, mas ficam para
depois** (demandas.md §18). A nota técnica acima segue valendo quando voltar.

---

## 🟡 B3. O que é um "grupo" de aluno Allos?

Conceito **novo** — não existe no código hoje.

1. Grupo é **turma** (ligada a um professor), **equipe** (competem juntos) ou
   **turma de entrada** (entraram na mesma época)?
2. O aluno pertence a **um** grupo ou a **vários**?
3. Grupo tem ranking próprio, ou é só rótulo organizacional?
4. Como se relaciona com o vínculo aluno↔professor que **já existe**
   (`teacherId`, 24 usos)? É a mesma coisa com outro nome, ou coexistem?

**Por que importa:** se grupo for a mesma coisa que o vínculo com o professor,
não se cria nada — reaproveita o que existe.

**Resposta (15/09):** grupo virou **tag livre** que o admin cria e aplica às
contas (uma pessoa pode ter várias). Não é turma nem o vínculo com professor,
que continua como está. Não tem ranking próprio: filtra o ranking e os logs.
**Já construído** (demandas.md §19).

---

## 🟡 B4. Duelos são exclusivos de alunos Allos?

Foi levantado como "talvez". Afeta 10 rotas já implementadas.

1. O aluno externo **não vê** a aba de duelos, ou vê e é recusado?
2. O que acontece com duelos **em andamento** de quem trocar de categoria?

**Resposta (15/09):** **Não é exclusivo.** Duelo é para todos (Allos × externo,
Allos × visitante por link). O admin pode desligar para um perfil na tela de
Acessos; aí o item aparece com cadeado e o servidor recusa criar e aceitar —
duelo já aceito pode ser terminado.

---

## 🟡 B5. Qual IA cada categoria de aluno usa?

Foi dito "talvez uma IA melhor ou pior" — as duas hipóteses foram levantadas.

1. Aluno Allos usa modelo **melhor** ou **mais barato**?
2. Vale para o **paciente simulado**, para o **avaliador**, ou ambos?
3. Vale também na **trilha**, que hoje escolhe o modelo **por exercício** e é
   deliberadamente isolada do painel global?
4. Se o externo usar um modelo mais fraco, a **nota dele é comparável** com a do
   aluno Allos? (Se não for, ranking conjunto perde sentido — liga com B1.)

**Resposta (15/09):** **o admin escolhe**, na tela de Acessos, o modelo do
paciente e o do avaliador do **terapeuta externo**, com limite semanal em
dólares e tokens (janela deslizante de 7 dias). O aluno Allos segue os modelos
por categoria de sempre. **Já construído** (demandas.md §19). Item 3: a Trilha
continua com modelo por exercício. Item 4 (nota comparável) fica como risco a
observar se o admin escolher um modelo diferente para o externo.

---

## 🟡 B6. Que campos extras o aluno Allos tem?

Nomeados até agora: **grupo** e **"mais pontuação"**.

**"Mais pontuação" precisa ser esclarecido:** é um **multiplicador** sobre a
pontuação normal, uma **moeda separada**, ou apenas o fato de pontuar em
atividades que o externo não acessa?

1. Qual das três?
2. Que outros campos existem?

**Resposta (15/09, noite):** **nenhum campo novo.** Ficam os campos que já existem
na conta, e o "mais" do aluno é o **gráfico octogonal dos critérios** (o radar da
sessão e do perfil, demandas.md §19.3) — não é multiplicador nem moeda.

---

## 🟡 B7. Como o aluno externo entra no sistema? — ITEM 2 JÁ RESPONDIDO PELO CÓDIGO

**Atualização de 14/09:** o item 2 não é mais hipotético — já foi construído
(`b4ee085 feat(cadastro): auto-cadastro de Aluno Externo`). Existe hoje um
role `external` com **auto-cadastro** e uma cota de 3 sessões/24h por conta
(`external-session-starts.json`, janela deslizante). Os itens 1, 3 e 4
continuam sem resposta.

1. Ele tem **professor vinculado**? Hoje o vínculo é peça central e o DEPLOY.md
   diz que *"cada aluno deve ser vinculado a um professor"*.
2. ~~Ele se **cadastra sozinho**, ou o admin cria a conta (como é hoje)?~~ →
   **Sozinho, já em produção.**
3. Aluno externo **paga**? Se sim, cobrança entra no escopo algum dia?
4. Um professor externo pode existir, ou professor é sempre da Allos?

**Resposta (15/09):** (1) nasce sem professor, e o admin pode vincular depois;
(2) auto-cadastro pela tela de login; (3) **nunca paga** — o sistema não cobra
ninguém; (4) **não existe professor externo**.

---

## 🟡 B8. Os alunos que existirem no dia da virada são o quê?

Todo aluno vira **Allos** ou **externo** por padrão? É o valor inicial para a
base inteira.

**Resposta (15/09, por consequência — confirmar):** com a decisão de **importar
os dados atuais** (demandas.md §18), cada conta **mantém o papel que tem hoje**:
`therapist` = Allos, `external` = externo. Nada é reclassificado na virada.

---

## 🟡 B9. O que o aluno externo NÃO pode fazer?

B1–B5 tratam de itens isolados. Vale fechar a lista de uma vez, porque cada
bloqueio vira uma verificação em várias rotas:

Marcar o que o **aluno externo** tem acesso:

- [ ] Trilha de exercícios
- [ ] Modo competitivo (freeplay com nota)
- [ ] Duelos
- [ ] Ranking (qual?)
- [ ] Avaliação neuropsicológica
- [ ] Antessala / pré-supervisão
- [ ] Missões diárias e conquistas
- [ ] Recordes 👑 de personagem
- [ ] Sidequests atribuídas por supervisor

**Resposta (15/09):** **nada, por padrão** — o externo pode tudo que a Allos
pode. Quem restringe é o admin, na tela de Acessos (matriz funcionalidade ×
perfil), que nasce toda liberada. **Já construído** (demandas.md §19).

---

# 🔴 Travam a fase 1 (migração) — resolver antes de começar

## 🔴 P2. Backup dos prompts — quem tira, quando e onde guarda?

**A pergunta mais urgente deste documento.** Ver o aviso no topo: os prompts
existem hoje em um único lugar.

1. Quem tem acesso ao Railway para tirar a cópia?
2. Pode ser feito **antes** de a migração começar?
3. Onde a cópia fica guardada, e quem pode acessá-la? (É conteúdo **sensível** —
   critérios de nota e gabaritos. Foi tirado do git exatamente por isso, então
   não pode voltar para um repositório aberto nem para um drive compartilhado
   com alunos.)
4. Depois da migração, deve haver uma **rotina periódica** de backup, em vez de
   uma cópia única?

**Resposta:**
Os prompts vão para o banco — isso já É o backup (sai do volume único, ganha
PITR do Neon). Não é necessária uma rotina manual recorrente de copiar para
outra máquina/local (ver A10 — fica só a camada 1, sem a camada 3). Ainda
assim, tirar UMA cópia do `PROMPTS_DIR` para fora do Railway antes de começar
a migração continua valendo — é custo zero e cobre o risco de o volume ser
mexido durante a própria migração, antes de o banco existir.
_____________________________________________________________________

_____________________________________________________________________

---

## 🔴 P1. Confirmar que os dados atuais são descartáveis

Paulo informou que os alunos de hoje são terapeutas testando a ferramenta e que
históricos podem ser perdidos. Como é **irreversível**, confirmar:

1. Perder o **ranking/MMR** acumulado desses testadores é aceitável?
2. Perder o **histórico de sessões e avaliações** já feitas é aceitável?
3. Perder as **contas** (todos recadastram) é aceitável, ou os logins devem ser
   preservados?
4. Alguma sessão já foi **mostrada a cliente/investidor** ou usada como material
   de divulgação, e por isso precisa sobreviver?

**Observação:** os testadores são terapeutas reais e podem ter apego ao próprio
histórico, mesmo sendo "dado de teste".

**Alternativa barata:** existe uma rota de **export completo** já pronta no
sistema (baixa progresso, logs, conquistas, MMR, duelos e notificações num único
arquivo JSON). Dá para guardar esse arquivo antes da virada, sem custo nenhum —
mesmo que nunca seja usado.

**Resposta:**
Não precisa trazer para o banco de dados o que estar no all_os hoje.

**⚠️ Substituída em 15/09 (demandas.md §18): os dados atuais SERÃO importados**
(contas, logs, MMR, duelos, conquistas, comunidade…), pelo script
`scripts/importar-volume.js`, antes do primeiro boot. Passo a passo em `VIRADA.md`.
_____________________________________________________________________

_____________________________________________________________________

---

## 🔴 A9. Como modelar os prompts no banco? — A "LTS" JÁ CHEGOU: É O v34, JÁ EM PRODUÇÃO

**Atualização de 14/09:** o que esta pergunta esperava como entrega futura da
equipe **já aconteceu, em código** — não é mais uma dependência externa.
`CLAUDE.md` §6 confirma: **"Avaliador v34 é a régua única de todos os
modos"**, e `server/avaliador-pipeline.js` já derrubou as réguas antigas
(v25, v28, v29, v31, v32 e v43) por completo. O `v34.md`/`lts.md` que você
recebeu não é uma especificação abstrata — é o prompt real de um dos nós do
pipeline v34 (a variante do modo Duelo).

**A estrutura real, já validada pelo código** (não é mais hipótese):

Por versão (`v34`, `v34-progressao`, `v34-duelo`), um conjunto pequeno e fixo
de arquivos no volume, cada um com um papel definido em `PIPELINE_VERSIONS`:

| Arquivo | Papel | Compartilhado entre versões? |
|---|---|---|
| `prompt-no-<versão>-montado.md` | prompt do nó (metacomando + princípios + pontuação + saída) | Não |
| `criterios-no-v34.md` | os 8 critérios, cada um uma seção numerada | **Sim** — progressão e duelo apontam pro mesmo arquivo do v34 (`criteriosDe: 'v34'`) |
| `sintetizador-<versão>.md` | escreve o feedback final | Não |
| `missao-v34-progressao.md` | só na progressão, julga sidequest/missão do dia | Só ali |

Isso **confirma a opção (a)** que ficou registrada aqui (path + conteúdo, 3-4
arquivos por versão) — não a (b) de entidade genérica. O schema fica:
`versoes_prompt (id, dir, criterios_de → versoes_prompt.id)` +
`arquivos_prompt (versao_id, papel ∈ {montado, criterios, sintetizador,
missao}, conteudo)`.

**`nCriterios: 8` é fixo e validado no boot** (o servidor recusa subir se
`criterios-no-v34.md` não tiver exatamente 8 blocos). Mudar a *quantidade* de
critérios continua sendo decisão de código, não de admin pela tela — isso não
mudou com a chegada do v34.

**Novo achado que entra no schema:** `avaliacoes-criterios/<id>.json` — um
arquivo por avaliação, com as 8 análises completas (o "gabarito lido"), que
só supervisor/admin acessam (`CLAUDE.md` §5.1 — sigilo por papel). Vira tabela
própria, com controle de acesso, não um campo solto em `logs`.

**Pendências reais que sobram** (agora sim de decisão sua, não de entrega
externa):
1. `criterios_de` como FK entre versões — confirma que o schema não trata
   cada versão como ilha independente?
2. `avaliacoes-criterios` vira tabela com controle de acesso por papel —
   confirma?

**Resposta:**
Vai ser aceitavel, eles estão em duvuida entre a v28 ou v29 — *nota: esta
resposta é de antes da descoberta de que o v28 (e v25/v29/v31/v32/v43) já
saíram de produção no código; não é mais uma dúvida em aberto, é fato
consumado. Confirmar se a v34 é aceita como está.*
_____________________________________________________________________

_____________________________________________________________________

---

## 🔴 A10. Quantas camadas de proteção para os prompts?

Paulo pediu que os prompts tenham backup. Importante: **estar no banco não é,
sozinho, um backup** — se alguém apagar a linha errada, o banco replica o
apagamento fielmente.

Proteção real tem três camadas:

1. **Prompts no banco** — tira a dependência do volume e entra no
   *point-in-time recovery* do Neon (a janela de retenção depende do plano; no
   gratuito costuma ser de poucos dias).
2. **Versão nomeada nunca é apagada nem sobrescrita** — criar a v30 não destrói
   a v28. Protege contra erro humano, que é o que o PITR cobre mal.
3. **Export periódico para fora do Neon** — sobrevive até a "perdi a conta do
   Neon".

1. Adotar as três camadas, ou só a primeira por enquanto?
2. Qual é o plano do Neon contratado (define a janela de recuperação)?

**Resposta:**
Camada 1 (prompt no banco, com PITR do Neon) — sim, é o suficiente. Camada 3
(export periódico manual para fora do Neon) — não, dispensada (estar no banco
já conta como o backup; não haverá rotina manual recorrente para outro
lugar). Camada 2 (versão nomeada nunca é apagada/sobrescrita) fica com um
desenho diferente do previsto aqui: como decidido em A9, as versões antigas
(v25/v28) **somem** quando a estrutura nova entrar — ou seja, "nunca apagar
versão antiga" não vale para essa transição pontual. Para as versões que
existirem **depois** da estrutura LTS estar no ar, a prática de não
sobrescrever uma versão em uso (só criar uma nova a partir dela) continua
valendo — ver P4.
_____________________________________________________________________

_____________________________________________________________________

---

## 🔴 A3. Fotos e arquivos de reasoning continuam em disco?

Os prompts já foram decididos (vão para o banco — ver A9). Restam:

- **Fotos** de pacientes, exercícios e perfis (binários);
- **`.txt` de reasoning** das avaliações (`avaliacao-reasoning/`).

Recomendação técnica: **continuam em disco**, com o banco guardando o caminho.
Respsotas: as imagens continuam em disco então.
**Consequência importante:** se algo continuar em disco, o **volume do Railway
não pode ser desligado** depois da migração. É comum desligar o volume achando
que "agora tem banco" — aqui isso apagaria as fotos.

1. Fotos continuam em disco?
2. Os `.txt` de reasoning têm valor a longo prazo, ou podem ser descartados
   depois de um tempo?

**Resposta:**
Reasoning e fotos não precisam estar no banco de dados.
_____________________________________________________________________

_____________________________________________________________________

---

## 🔴 A4. Filas e sessões em andamento viram tabelas?

Alguns arquivos não são cadastro — são **estado de trabalho**:
`avaliacao-fila.json`, `trilha-eval-queue.json`, `benchmark-fila.json`,
`benchmark-lotes.json`, `active-sessions.json`.

`active-sessions.json` guarda a conversa em andamento (permite dar F5 sem perder
a sessão nem o cronômetro).

Recomendação: **viram tabelas** — é exatamente onde a escrita concorrente
acontece, ou seja, onde a race condition mais dói.

1. Confirma que viram tabelas?
2. Uma sessão abandonada há muito tempo deve **expirar** sozinha, ou fica para
   sempre?

**Resposta:**
Vão virar tabela. Deve expirar com 15 dias. Vantagem principal: resolve a
race condition de verdade (o Postgres garante que só um processo pega cada
linha da fila; hoje dois processos podem ler/regravar o mesmo JSON e um
apaga o trabalho do outro). Custo: o código que hoje é "carrega o JSON
inteiro, processa, regrava o JSON inteiro" precisa virar transação por item —
é reescrita real, mas o ganho de corrigir a concorrência é o motivo inteiro
do projeto.
_____________________________________________________________________

_____________________________________________________________________

---

# 🟡 Travam a fase 2 (features novas) — dá pra migrar antes

## 🟡 A8. O banco de versões de prompt entra na fase 1 ou na fase 2? — RESOLVIDO POR CONSEQUÊNCIA

A pergunta original ("fica pra depois ou entra já?") deixou de fazer sentido
do jeito que foi feita: como a estrutura LTS **substitui** v25/v28 por
completo (A9), não existe um "continuar como está hoje" para adiar — a
mudança acontece de uma vez, quando a equipe entregar a estrutura.

O motivo por trás desta pergunta (a vantagem real do banco vs. o painel atual)
foi esclarecido assim: hoje `/admin/prompts` deixa **editar texto de um
arquivo existente**, mas **não deixa criar uma versão que o sistema de fato
rode**, nem **trocar quem é a padrão sem deploy** — essas duas decisões
continuam presas em `PIPELINE_VERSIONS`/`DEFAULT_VERSION`, constantes no
código (`server/avaliacao-v25.js`). É esse gap específico que o banco fecha —
não é sobre ter "mais tecnologia", é sobre essas duas ações pararem de exigir
programador.

**Resposta:**

Confirmado — ver A9. A tela para eleger a versão padrão reaproveita o mesmo
mecanismo que já existe em `/admin/modelos`.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟡 P3. Versão de prompt: padrão global ou por contexto?

Quando o admin marcar a v30 como padrão, isso vale:

1. **Globalmente** — todo mundo passa a ser avaliado pela v30; ou
2. **Por contexto** — um padrão para a trilha, outro para o competitivo, outro
   para o processo seletivo?

**Contexto:** o sistema **já** escolhe o modelo de IA **por categoria**, e a
trilha escolhe **por exercício**, isolada de propósito. Se o prompt for global e
o modelo for por categoria, ficam duas configurações desalinhadas — e descobrir
por que duas avaliações saíram diferentes fica difícil.

*(Paulo indicou seguir o modelo que o sistema já usa. Confirmar.)*

**Resposta:**
Confirmado por consequência de A8/A9: a eleição de versão padrão reaproveita
o mecanismo de `/admin/modelos`, que já é **por categoria + padrão global**
(escolha da categoria vence; sem escolha, cai no padrão global). O prompt
segue exatamente essa mesma estrutura — sem desalinhamento entre as duas
configurações.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟡 P4. Quem pode criar e eleger a versão de prompt?

Hoje trocar a versão exige **deploy** — ou seja, passa por um programador, o que
funciona como uma revisão involuntária. Ao virar tela de admin, isso se perde.

1. Qualquer `admin` pode eleger a versão que avalia todos os alunos, ou precisa
   de um papel mais restrito?
2. Deve haver **registro** de quem trocou, quando, e de qual para qual versão?
3. Uma versão **em uso** pode ser editada, ou só se cria uma nova a partir dela?
4. É possível **testar** uma versão antes de torná-la padrão para todos?
5. Alunos avaliados por versões diferentes aparecem no **mesmo ranking**? A nota
   é comparável?

**Por que importa:** eleger a versão errada muda a nota de todos os alunos na
hora, e hoje não ficaria registro de quem fez.

**Resposta:**
Qualquer admin, não precisa de registro de quem trocou, uma versão em uso pode ser editavel. É possivel testar. Alunos avaliados por versões diferentes aparecem no mesmo ranking.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟡 P5. Avaliações antigas devem guardar com qual versão foram feitas?

Se o prompt de avaliação muda ao longo do tempo, uma nota de março e uma de
agosto podem ter sido geradas por critérios diferentes.

1. Cada avaliação deve registrar **qual versão de prompt** a gerou?
2. Se sim, o ranking deve considerar isso de alguma forma?

**Recomendação:** registrar a versão junto de cada avaliação. É barato agora e
impossível de reconstruir depois.

**Resposta:**
O ranking não deve considerar o prompt usado e cada avaliação deve falar qual prompt foi usado para o administrador e não para o aluno
_____________________________________________________________________

_____________________________________________________________________

---

# 🟢 Não bloqueiam — decidir quando for conveniente

## 🟢 A5. Visitante (`visitor`) continua sem ser salvo?

É o papel mais checado do sistema (26 vezes) e hoje **não é persistido** — existe
só no token, nunca em `users.json`.

1. Continua assim?
2. Ou o banco passa a registrar visitantes para métricas (quantos experimentaram,
   quantos viraram aluno)?

**Recomendação:** continua efêmero na fase 1 (não mudar comportamento).

**Resposta:**

_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 A6. O papel `evaluator` está morto? — CORRIGIDO: NÃO ESTÁ

**Atualização de 14/09:** a premissa da pergunta era de uma versão mais
antiga do código. `CLAUDE.md` linha 21 confirma: `evaluator` é o **avaliador
externo do Processo Seletivo** — papel real, em uso, não resquício. A
resposta "3" (que lia como "pode remover") ficou baseada na premissa errada e
não se aplica mais. Não remover.

~~1. Existe conta com esse papel em produção hoje?~~
~~2. Era para dar acesso a quê?~~ → avaliar candidatos do Processo Seletivo.
~~3. Pode ser removido?~~ → não, é papel ativo.

**Resposta:**
Confirmado pelo CLAUDE.md — `evaluator` fica, é o avaliador do Processo
Seletivo. Sem pergunta pendente aqui.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 A11. IDs: manter os atuais ou trocar?

Hoje os IDs são gerados de duas formas: `Date.now()` (45 usos) e "maior id + 1".

Ambas têm problema conhecido: `Date.now()` **repete** se duas criações caírem no
mesmo milissegundo, e "maior + 1" repete sob concorrência — é a mesma família de
bug que motivou a migração.

O padrão em Postgres seria `BIGSERIAL` (o banco garante unicidade) ou `UUID`.

1. Pode trocar a geração de ID na migração?

**Observação:** trocar IDs é tecnicamente "mudar comportamento", mas como os
dados atuais são descartáveis (A1), este é o **momento mais barato** de fazer —
depois fica caro.

**Resposta:**
Pode trocar.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 A12. `settings.json` (configurações globais) — tabela ou continua chave-valor?

Guarda configuração da plataforma editada em runtime pelo admin: modelo de IA
por categoria, modelo de avaliação do visitante, entre outros. É lido e gravado
em pelo menos 6 pontos do código.

1. Vira uma tabela de chave-valor (mais parecido com hoje), ou colunas
   explícitas (o banco valida o que entra)?
2. Trocas de configuração devem ficar **registradas** (quem mudou o modelo de IA,
   quando)? Hoje não ficam.

**Resposta:**
O que vc achar melhor e que dar mais seguraça
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 A13. Quanto tempo o sistema pode ficar fora do ar?

A troca do JSON para o banco exige um corte.

1. Pode ficar indisponível por algumas horas? Em que dia/horário?
2. Alguém precisa ser avisado antes (os terapeutas que estão testando)?

**Resposta:**
Eu vou deixar o sistema rodando em json e vou subir o nosso sistema em outro projeto do rialway e ai vou falar para os usuário passrem a usar esse novo sistema/projeto.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P6. Qual o orçamento e o plano do Neon?

1. Qual plano do Neon será usado (define a janela de recuperação de dados — ver
   A10)?
2. Há limite de custo mensal para o banco?
3. O volume do Railway continua contratado depois da migração? (Necessário se
   fotos e reasoning ficarem em disco — ver A3.)

**Resposta:**
O plano do neon vai ser o mais básico
Não a limites para custo
Vamos contratar o volume do railway
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P7. Prazo e prioridade

1. Há **data limite** para a migração?
2. O que é mais urgente: **parar a perda de dados** (fase 1) ou **entregar aluno
   Allos × externo** (fase 2)?
3. Durante a migração o sistema pode ficar **congelado** (sem features novas),
   ou precisa continuar evoluindo em paralelo?

**Observação:** evoluir em paralelo é o principal risco de prazo — cada feature
nova criada durante a migração precisa ser escrita duas vezes.

**Resposta:**
Não a data para migração. NADA É URGENTE. 
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P8. Quem mais mexe no sistema?

1. Além do Paulo, alguém programa neste projeto?
2. Se sim, essa pessoa precisa parar de mexer durante a migração?
3. Quem valida que "o sistema continua funcionando igual" depois da virada — só
   o teste automatizado, ou alguém testa na mão?

**Resposta:**
Eu faço códgio, arthur e alan decide regras de negocio e validam
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P9. A conversa com o paciente pode crescer sem limite?

Não é sobre banco de dados — é sobre o que é mandado para a IA a cada turno.
Achado no código ([server/index.js:3907](server/index.js#L3907)): o histórico
inteiro da conversa é reenviado ao modelo em **todo** turno, sem corte e sem
resumo. O único paliativo é o *prompt caching* das APIs, que reduz o **custo**
de reprocessar o prefixo repetido — não reduz o **tamanho** do que é enviado.

Isso tem dois limites reais, hoje sem tratamento:

- **Técnico:** em algum ponto a conversa estoura a janela de contexto do
  modelo (ex.: 200k tokens na Anthropic) e a chamada passa a falhar no meio da
  sessão do terapeuta.
- **Financeiro:** o custo por turno cresce com o tamanho da conversa; e o
  cache tem TTL — se o aluno demorar para responder, o cache expira e o turno
  seguinte volta a cobrar o histórico inteiro no preço cheio.

O único cap encontrado (`LOG_MAX_MESSAGES = 500`) protege o `logs.json` no
momento de **salvar** a sessão finalizada — não limita o que é enviado à IA
durante uma sessão em andamento.

1. Já aconteceu alguma sessão anormalmente longa em produção (paciente
   simulado, duelo, trilha)?
2. Vale priorizar uma janela deslizante ou resumo periódico do histórico (cortar
   os turnos mais antigos conforme a conversa cresce), como projeto à parte?

**Nota:** isto não é resolvido pela migração para Postgres — é comportamento de
aplicação, independente de onde os dados moram. Fica registrado aqui porque
surgiu durante a análise, não porque bloqueia a fase 1.

**Resposta:**
Nunca aconteceu uma sessão gigante. COLCOAR JANELA DESLIZANTE COMO ESTÁ HOJE.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P10. Banco de dados vetorial (RAG) entra em algum momento?

Pergunta de fechamento, para constar em ata — a análise técnica já concluiu que
**não**, e o motivo já está registrado em demandas.md §2.5:

- Um "grafo de conhecimento do paciente" (mandar só o trecho relevante da
  conversa/histórico ao modelo, em vez do texto inteiro) economizaria tokens de
  fato, mas foi avaliado e descartado — é RAG, "a parte mais difícil do
  sistema", e arrisca a consistência narrativa do paciente simulado, que é o
  produto.
- Custo de IA foi declarado **fora do escopo deste projeto** e será tratado
  separadamente, se for o caso.
- Não há hoje nenhum caso de uso de busca semântica no sistema (não é uma base
  de conhecimento nem um buscador de documentos) — o crescimento de contexto
  descrito em P9 se resolve com janela/resumo, não com embeddings.

1. Confirma que RAG/vetor fica fora do escopo desta migração e de qualquer
   trabalho de custo de IA no curto prazo?

**Resposta:**
Tudo bem, não vamos usar RAG.
_____________________________________________________________________

_____________________________________________________________________

---

## 🟢 P11. Comunidade (fórum) — módulo novo, sem retenção/moderação documentada

**Achado de 14/09, nunca discutido:** apareceu um módulo inteiro que não
existia nas conversas anteriores nem em `demandas.md` — **Comunidade**
(`comunidade.json`, `comunidade-config.json`): discussões, comentários em
árvore de 1 nível, votos, enquetes (única/múltipla), fixar no topo, edição
pelo admin, banimento com prazo. É superfície de banco nova para a fase 1.

1. Tem alguma regra de **retenção** (discussões somem depois de X tempo, como
   logs e duelos) ou fica para sempre?
2. Denúncia/moderação além do banimento com prazo — existe ou está no radar?
3. Visitante lê uma discussão por link (`CLAUDE.md` linha 24) — ele também
   pode **comentar/votar**, ou só ler?

**Resposta (15/09):** **fica para depois** (demandas.md §18). Por enquanto a
comunidade foi migrada como está, sem retenção; o admin pode bloqueá-la por
perfil na tela de Acessos.

---

# ✅ Já respondidas (referência — não precisam de tempo na reunião)

## ✅ A1. Migrar os dados de produção ou começar limpo?

~~**Pode começar limpo.**~~ **Mudou em 15/09: importar os dados atuais**
(demandas.md §18, `VIRADA.md`). Os prompts continuam intocáveis.

## ✅ A2. Como os testes vão rodar contra o banco?

**Postgres local em Docker.** Docker está instalado e ativo na máquina
(v29.6.2). Ver demandas.md §8.1.

## ✅ A7. Um banco só no Neon, ou dois?

**Um banco só, mexendo direto em produção.** Coerente com A1.

## ✅ B0. Aluno pode mudar de categoria?

Pode (externo ↔ Allos) e **leva MMR, pontuação e recordes 👑**. Sem reset.
*(Confirmar com o chefe.)*

## ✅ Como o chat com o paciente é armazenado (decisão técnica, sem impacto de produto)

**Uma tabela `mensagens`, uma linha por mensagem** (`sessao_id`, `role`,
`conteudo`, `criado_em`) — é o mesmo padrão de sistemas de chat grandes
(Discord, Slack, WhatsApp Web). Resolve de graça o pedido de A4: a sessão
ativa passa a ser reconstruída lendo as linhas da tabela, em vez de um blob
JSON.

**Sem buffer** — cada mensagem é gravada assim que termina de ser gerada, sem
juntar 3-4 mensagens antes de escrever. Motivo: bufferizar existe para
resolver *volume* de escrita (milhares por segundo); aqui é uma mensagem a
cada alguns segundos, e um `INSERT` numa tabela indexada custa menos de 1ms —
não há gargalo a resolver. Bufferizar, além de não ganhar nada, reintroduziria
em miniatura o mesmo risco que motiva o projeto inteiro (mensagens em buffer
somem se o processo cair antes de gravar). A fluidez do chat continua vindo
do streaming (SSE) da resposta pro usuário, que já existe hoje e não muda.
</content>
