# Estado do projeto — onde paramos

**Última atualização: 2026-09-23.** Este arquivo é o ponto de partida de quem
(ou o que) retoma o trabalho. Ele responde: o que está feito, o que falta, o que
está decidido e o que não pode ser esquecido.

- **Visão de produto:** `README.md`
- **Mapa dos dados e convenções de código:** `CLAUDE.md`
- **Histórico completo de decisões:** `demandas.md` (as mais recentes são §21 a §23)
- **Passo a passo da virada:** `VIRADA.md`
- **Deploy e variáveis:** `DEPLOY.md`
- **O MMR explicado:** `MMR.md`

---

## 1. Onde o projeto está

A branch **`feat/postgres-fase1`** tem a Fase 1 (migração para PostgreSQL) e a
Fase 2 (demandas novas) **completas**. Último commit: `e040390`.

**⚠️ Trabalho em andamento (2026-09-24):** a reforma do §24 (MMR por critério +
retenção) está **em progresso na `feat/postgres-fase1`**, quatro commits novos
já empurrados para o fork (`5d31e8d`, `a179405`, `0e8554e`, `02909d8`).

Feito:
- §24.0 completo: podas de `logs`/`duels`/`selecao_logs` fora, dedupe de
  WhatsApp fora, banners de expiração fora.
- Migrações `016_mmr_por_criterio_schema.sql` e `017_mmr_reset_por_criterio.sql`
  (a 017 arquiva `mmr_*` em `*_arquivo_v1` antes do TRUNCATE — spec §11).
- Motor `server/mmr.js` reescrito por critério; `server/repos/mmr.js`
  ajustado (recorde aceita `origem` + `userId` null).
- Wrappers `aplicarPartidaCompetitiva`, `registrarTriAnonimo` e
  `applyDuelMmr` migrados; rotas `/api/ranking`, `/api/me/mmr`,
  `/api/freeplay`, `/api/tri/personagens` adaptadas; recorde 👑 do seletivo
  criado (spec §9); `mmr_delta` no log gravado (spec §12).
- `tests/mmr.test.js` reescrito para os 16 critérios de aceite da spec §16:
  **41 testes verdes** (verificado com `TEST_DATABASE_URL= npx vitest run
  tests/mmr.test.js`). `tests/db-repo-mmr.test.js` reescrito para o novo
  shape. Testes obsoletos do motor antigo apagados
  (`mmr-pvp.test.js`, `tri-dificuldade.test.js`, `tri.test.js`).

Pendente:
- Testes de integração (`character-records.test.js`, `duel.test.js`,
  `tri-peso-acessos.test.js`, bloco de MMR em `regression.test.js`)
  precisam ser adaptados para o novo payload das rotas.
- Front das 5 telas da spec §10: `Profile.jsx` (radar por critério, MMR sem
  teto), `Ranking.jsx` (MMR total derivado — hoje já lê `mmr` do payload
  via alias, deve funcionar mas sem o radar), `Competitive.jsx`,
  `DuelSession.jsx` (venceu-cada-critério + soma-zero), `SelecaoDashboard.jsx`
  (nota ponderada visível).
- `MMR.md` reescrito (o atual descreve a régua antiga).
- Suíte inteira (`npm test`) verde. Hoje só o `tests/mmr.test.js` isolado
  foi rodado sem banco; o resto depende do Docker up (`npm run db:up`).

**Suíte anterior ao WIP: 74 arquivos, 932 testes verdes.** Build do cliente ok.

Os repositórios são **públicos**. A branch está no fork
`github.com/PauloHenriqueL/all_os`. O upstream `arthurbpinho/all_os` (remote
`origin`) **nunca recebeu nada** — decidir se o Railway novo aponta para o fork
ou se abre um PR.

---

## 2. O banco novo (Neon) — já tem dados

Projeto no **Neon**, Postgres **17.11**, região **AWS us-east-2 (Ohio)**,
endpoint **direto** (sem `-pooler` — ver `VIRADA.md` §2 para o porquê).

A connection string mora em **`~/.neon-url`** (`chmod 600`, fora do repositório).
Use-a por substituição, para não deixar rastro no histórico do shell:

```bash
DATABASE_URL="$(cat ~/.neon-url)" node scripts/importar-volume.js ./data-parcial
```

**Nunca ponha essa string no `.env`**: esse arquivo é lido pelo app e pela suíte
a cada execução local, e o `npm run dev` passaria a falar com produção.

### O que já está importado

| Tabela | Registros |
|---|---|
| `users` | **51** contas reais |
| `contadores_usuario` | 5 (inclui o próximo id de conta) |
| `catalogo_itens` | **12** (8 pacientes, 2 neuro, exercícios, Trilha) |
| `configuracoes` | 5 |
| `mmr_players` | **15** |
| `mmr_characters` | **8** — o TRI, a dificuldade medida |
| `mmr_anon_players` | 1 |
| `character_records` | **8** recordes 👑 |
| `selecao_estatisticas` | **120** registros anônimos |

### O que ficou de fora, por decisão do dono (§22.1)

`logs`, `log_messages`, `duels`, `sessoes_ativas`, `selecao_logs`, `progress`,
`notificacoes`, `comunidade` — **todos em zero**. Nenhuma transcrição de
atendimento subiu.

Consequência a não confundir com defeito: **Minhas Sessões, o radar do perfil e
os Logs de Supervisão nascem vazios.** O Ranking funciona, porque se monta com
contas + MMR e não lê os logs.

### O que ainda entra sozinho

`prompt_arquivos` e `criterios` estão em **0**, e isso é o esperado: os prompts
**não são importados**. Eles são semeados no **primeiro boot do app**, lendo o
`/data/prompts` do volume. É a Fase 4 abaixo.

---

## 3. O que falta para o deploy

### Fase 4 — prompts para o volume novo

**Decidido (§23.1): volume NOVO, com a cópia restaurada.** Não compartilhe o
volume com o projeto antigo — os prompts atualizados do v34 usam
`{{N_CRITERIOS}}`, e o código do `main` não substitui esses marcadores
(verificado). Com volume próprio isto pode ser feito com calma, antes de subir o
app, sem tocar no que está no ar.

A comparação já foi feita: dos 10 `.md`, **6 são idênticos** aos de produção e
**4 são mais novos na máquina do Paulo** — e as 4 diferenças são só a mudança da
§20.1 (tirar o número de critérios escrito à mão). **Não há edição de produção a
preservar**; a cópia é segura, numa direção só.

```bash
cd /home/paulo/Documentos/projetos/allos/all_os
rm -rf /tmp/volume-novo && mkdir -p /tmp/volume-novo
cp -r data/prompts /tmp/volume-novo/
cp avaliacao/v34/criterios-no-v34.md /tmp/volume-novo/prompts/avaliacao/v34/
cp avaliacao/v34-duelo/sintetizador-v34-duelo.md /tmp/volume-novo/prompts/avaliacao/v34-duelo/
cp avaliacao/v34-progressao/missao-v34-progressao.md /tmp/volume-novo/prompts/avaliacao/v34-progressao/
cp avaliacao/v34-progressao/sintetizador-v34-progressao.md /tmp/volume-novo/prompts/avaliacao/v34-progressao/
cp -r data/patient-photos data/exercise-photos data/avatar-pool data/comunidade-avatars /tmp/volume-novo/ 2>/dev/null
cd /tmp/volume-novo && tar czf /tmp/volume-novo.tar.gz . && find . -name '*.md' | wc -l   # tem de dar 10
```

### Fase 5 — projeto novo no Railway

1. New Project → deploy da branch `feat/postgres-fase1`.
2. Volume **novo** montado em `/data` (não o `all_os-volume` do projeto antigo).
3. Variáveis: o conteúdo de `.env.producao` **mais** `DATABASE_URL` (a do Neon,
   sem `-pooler`).
   - `JWT_SECRET` e o par **VAPID**: **os mesmos da produção atual** (§21.1).
     Motivo: os dois sistemas convivem no ar durante a migração, e secrets
     diferentes deslogariam quem transitasse entre eles. Rotacionar o secret
     **depois**, com o antigo fora do ar.
   - **Trocar** `SELECAO_PASSWORD` e `BENCHMARK_PASSWORD`: os defaults do código
     (`allos01`, `albires1`) estão num repositório público.
4. **Uma réplica só.** Prompts, catálogos, configurações e sidequests têm cópia
   em memória; duas instâncias divergem.
5. Restaurar o volume e só então subir.
6. No log do boot: deve aparecer `[prompts] N prompt(s) semeado(s) no banco.`;
   **não** deve aparecer `[catalogo] semeado(s)` — os catálogos já vieram da
   importação.

### Fase 6 — domínio

Apontar `treinamento.allos.org.br` para o projeto novo, atrás do Cloudflare com
proxy laranja. Depois, como admin, abrir `/api/admin/diagnostico-ip` **pelo
domínio próprio**: se `conexaoEhCloudflare: false`, definir
`CONFIAR_CF_CONNECTING_IP=sempre` **e** desativar o domínio `*.up.railway.app`.

### Fase 7 — conferência

Os 8 itens de `VIRADA.md` §6, lembrando que **Logs de Supervisão vazios e lista
de candidatos do Seletivo vazia são o esperado** neste escopo.

### Depois da virada

- Rotacionar o `JWT_SECRET`.
- Decidir o destino do upstream (PR ou não).
- **Criar CI** — não existe nenhum; os testes só rodam se alguém rodar.

---

## 4. Decisões fechadas que não se rediscutem

| Decisão | Onde |
|---|---|
| **Sem temporadas.** O Ranking é MMR + filtro por tag, sem período nem zeragem | §22.2 |
| **Importação sem transcrições** de atendimento | §22.1 |
| **Volume novo** na virada, não compartilhado | §23.1 |
| **`JWT_SECRET` e VAPID iguais** na virada; rotacionar depois | §21.1 |
| **Remover critério = desativar** (coluna `ativo`), nunca apagar | §23.2 |
| **Peso do TRI é do admin**, na tela de Acessos, de 0 a 1 | §22.4 |
| **Ohio** (us-east-2) mantido conscientemente, apesar do Railway em Virgínia | §21.4 |

---

## 5. Ambiente local de demonstração

Serve para mostrar o produto sem gastar com IA. **Tudo o que está aqui é local e
não deve ir para o Neon.**

```bash
npm run db:up      # Postgres 17 em Docker, porta 5433
npm run dev        # API em 3001 + Vite em 5173
```

| Conta | Senha | Para quê |
|---|---|---|
| `admin.demo` | `demo1234` | painéis de administração |
| `terapeuta.demo` | `demo1234` | visão do aluno: perfil, radar, Minhas Sessões |

Semeado por scripts, **todos com trava que recusa banco que não seja local**:

- `scripts/seed-demo-terapeuta.js` — 13 atendimentos avaliados, radar dos 8
  critérios, MMR pelo motor de verdade. `--limpar`, `--usuario`, `--senha`.
- `scripts/seed-demo-selecao.js` — 14 candidatos fictícios para `/selecao/logs`.
  E-mails em `@exemplo.invalid`, textos marcados como demonstração.

O banco local também tem: o catálogo real (8 pacientes com foto), os 51 usuários
importados, 4 tags de exemplo e os prompts de produção semeados.

**Sem chaves de IA no `.env`** — o app roda em modo demonstração: o chat responde
com mensagem enlatada e **a avaliação não acontece**. Para demonstrar o ciclo
completo é preciso copiar `ANTHROPIC_API_KEY` e `OPENAI_API_KEY` de
`.env.producao` para o `.env`, **e o custo vai para a conta real da Allos**.

### Os arquivos de ambiente

| Arquivo | O que é |
|---|---|
| `.env` | **só desenvolvimento.** É o único que o app lê |
| `.env.producao` | valores reais, **não é lido pelo app** — é o que se cola no Railway |
| `~/.neon-url` | a connection string do Neon, fora do repositório |

Os três estão fora do git. Uma armadilha já vivida: o `.env` chegou a ter os dois
blocos colados, e como o dotenv faz a **última** chave vencer, o dev rodava com o
`JWT_SECRET`, o VAPID e o `DATA_DIR` **de produção** (§21.6).

---

## 6. Cópias do volume antigo

O backup de `/data` de produção (9,8 MB → 3,3 MB comprimido) está em **três
lugares**: disco do Paulo, pen drive e o Drive da Allos. É a única cópia dos
**prompts**, que não estão no git (§9.2 do `demandas.md`).

No repositório, já descompactadas e **fora do git**:

- `data/` — a cópia completa do volume
- `data-parcial/` — só o que foi importado para o Neon

Para tirar uma cópia nova: **painel do Railway → serviço → Console**, e baixar
pelo painel **Files**. **`railway run bash` não funciona** — ele executa na sua
máquina, não dentro do container, e não enxerga o `/data`.

---

## 7. Pontas soltas conhecidas

- **Não há CI.** Rodar `npm test` antes de qualquer deploy.
- **A conta `Victor.toscano` virou `Victor.toscano-39`** na importação, por
  colisão de maiúsculas (a unicidade é case-insensitive). A pessoa **já foi
  avisada**.
- **Retenção de 30 dias** dos logs roda na leitura: sessões semeadas com mais de
  30 dias somem sozinhas. Não é bug.
- **`VISITOR_TRI` está desligado.** A avaliação de visitante não existe; o
  caminho está escrito e testado, e liga com `VISITOR_TRI=1`.
- **Comunidade**: retenção e moderação seguem sem definição (adiadas).
