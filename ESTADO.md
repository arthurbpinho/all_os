# Estado do projeto — onde paramos

**Última atualização: 2026-09-24.** Este arquivo é o ponto de partida de quem
(ou o que) retoma o trabalho. Ele responde: o que está feito, o que falta, o que
está decidido e o que não pode ser esquecido.

- **Visão de produto:** `README.md`
- **Mapa dos dados e convenções de código:** `CLAUDE.md`
- **Spec do MMR por critério:** `MMR-por-criterio.md`
- **Histórico completo de decisões:** `demandas.md` (as mais recentes são §21 a §24)
- **Passo a passo da virada:** `VIRADA.md`
- **Deploy e variáveis:** `DEPLOY.md`
- **O MMR explicado:** `MMR.md`

---

## 1. Onde o projeto está

**Branch de trabalho: `main` do fork `PauloHenriqueL/all_os`, no commit `729c425`
(Merge PR #1 do `feat/mmr-por-criterio-fase2` — 2026-09-24).** O Railway novo
puxa daqui. **Não** vamos empurrar mais nada para o `arthurbpinho/all_os`.

Suíte: **913 testes verdes em 71 arquivos** (com Postgres local up, `npm run db:up`).
Build do cliente ok (`npm run build`, 4,24s).

### §24 do demandas.md — MMR por critério + retenção — **implementada**

- **§24.0 retenção:** podas automáticas de `logs`/`duels`/`selecao_logs` e
  dedupe de WhatsApp do seletivo removidas. Dados de aluno são persistentes.
  O único TTL restante fica em `uso_ia` e `sessoes_ativas` (operacional).
- **Motor `server/mmr.js`** reescrito por critério segundo `MMR-por-criterio.md`:
  P_c, D_c, β_c, K = max(1/(n+1); 0,20), janela 10, ganho 0,2/0,1, β em
  [0,5; 1,5] com intercepto fixo em 50, trava-25, admin não move nada.
- **`server/repos/mmr.js`** ajustado: `registrarRecorde` aceita `userId=null`
  + `origem` ('competitivo' | 'selecao'); `aplicar` recebe/devolve `fontes`
  por critério.
- **Migrações escritas** (rodam sozinhas no boot):
  - `016_mmr_por_criterio_schema.sql` — `character_records` sem FK em user_id
    + coluna `origem`; `logs.mmr_delta JSONB`.
  - `017_mmr_reset_por_criterio.sql` — arquiva `mmr_players`, `mmr_characters`,
    `mmr_anon_players` em `*_arquivo_v1` (spec §11 exige "consultável") e
    depois `TRUNCATE`. `character_records` **não** é tocada (recordes 👑 ficam).
- **Rotas em `server/index.js`:** `aplicarPartidaCompetitiva`, `registrarTriAnonimo`
  e `applyDuelMmr` migrados para a API por critério; `runComparativeEvaluation`
  extrai criteriosA/B do resultado do avaliador comparativo; `/api/ranking`,
  `/api/me/mmr`, `/api/freeplay`, `/api/tri/personagens` adaptadas; recorde
  👑 do seletivo criado.
- **Front:** `Profile.jsx` mostra MMR por critério (0..10 com uma casa
  decimal); `DuelSession.jsx` mostra "Por critério" com ✓/✗/= de quem
  venceu cada um; `SelecaoDashboard.jsx` tem `<details>` "Ver D por critério"
  por caso. Ranking segue funcionando via alias `mmr` no payload.
- **Testes:** `mmr.test.js` cobre os 16 critérios de aceite da spec §16;
  `db-repo-mmr.test.js` reescrito para o novo shape; os 3 testes de motor
  antigo (`mmr-pvp`, `tri-dificuldade`, `tri`) apagados; integração
  (`selecao`, `tags`, `tri-peso-acessos`, `duel`, bloco de MMR em
  `regression`) adaptados.
- **Docs:** `MMR.md` reescrito do zero; `MMR-por-criterio.md` (spec do Alan)
  presente na raiz; §24 do `demandas.md` marcada como implementada.

### O que ficou pra depois de subir

Nenhum débito de código bloqueia o deploy. O que **rodar em produção** vai
expor:

- Todos os 51 alunos vão para **calibração** no primeiro boot (a migração
  017 zera o motor). É por design (spec §11 + [pergunta 6a do grilling]).
  Alan avisa os alunos presencialmente — sem aviso in-app.
- Os 8 **recordes 👑 são mantidos**.
- As tabelas `logs`, `duels`, `selecao_logs` já vieram vazias do Neon (§22.1),
  então "Minhas Sessões", "Radar do perfil" e "Logs de Supervisão" nascem
  vazios. Não é bug.

---

## 2. Deploy em andamento — Railway novo

**Neon:** verificado 2026-09-24. Bate 100% com a §3 abaixo — schema,
migrações 001–015 aplicadas, contagens, formato do JSONB antigo (com `S_aj`
na janela, o que confirma que 017 vai fazer diferença).

**Volume:** o `.tar.gz` novo já foi empacotado em `/tmp/volume-novo.tar.gz`
(1,37 MB — 10 prompts .md + patient-photos + exercise-photos + avatar-pool +
comunidade-avatars). **Pronto para upload.** Se `/tmp/` sumiu (reboot),
refazer com os comandos da §4 abaixo.

**Railway:** projeto `all_os` criado no fork (visto na screenshot do usuário,
Building 00:12). Source: `PauloHenriqueL/all_os`, branch `main`.

Falta, tudo pelo painel:

1. **Variables** (Raw Editor) — colar `.env.producao` inteiro **mais**:
   - `DATABASE_URL=<neon-url sem -pooler>` (fica em `~/.neon-url`; o app
     usa transações longas e o pooler mata)
   - `SELECAO_PASSWORD=<senha nova>` — a session anterior gerou
     `wLFepsorn7Qy7FkSjcP1`, mas trocar pelo painel de admin assim que subir
   - `BENCHMARK_PASSWORD=<senha nova>` — gerada `oleZExsx2DoYPhzkLBrV`
   - **`JWT_SECRET` e VAPID iguais** aos da produção atual (§21.1). Rotacionar
     depois, com o antigo fora do ar.
   - **Não colocar** `ADMIN_INITIAL_PASSWORD` — o Neon já tem admins, essa
     var só é lida quando não existe nenhum admin (fail-closed).
2. **Settings → Volumes** — criar volume mount `/data`, 1 GB.
3. **Files** — upload de `/tmp/volume-novo.tar.gz` para `/data/`.
4. **Console** —
   ```bash
   tar xzf /data/volume-novo.tar.gz -C /data
   rm /data/volume-novo.tar.gz
   ls /data/prompts/avaliacao/v34/   # tem que listar 3 .md
   ```
5. **Deployments → Restart** — no log, procurar:
   ```
   [migracao] 016_mmr_por_criterio_schema.sql aplicada.
   [migracao] 017_mmr_reset_por_criterio.sql aplicada.
   [prompts] N prompt(s) semeado(s) no banco.
   ```
   **Não** deve aparecer `[catalogo] semeado(s)` (catálogos vieram do Neon).

Depois:

- **Fase 6 — domínio:** apontar `treinamento.allos.org.br` para o projeto
  novo, atrás do Cloudflare com proxy laranja. Como admin, abrir
  `/api/admin/diagnostico-ip` **pelo domínio próprio**: se
  `conexaoEhCloudflare: false`, setar `CONFIAR_CF_CONNECTING_IP=sempre` e
  desativar o domínio `*.up.railway.app`.
- **Fase 7 — conferência:** os 8 itens de `VIRADA.md` §6. Lembrar:
  "Minhas Sessões vazias" e "candidatos vazios" **são o esperado**.
- **Depois da virada:** rotacionar `JWT_SECRET`; anotar em `demandas.md`
  as dívidas técnicas (ver §5 abaixo); começar a pensar em CI.

---

## 3. O banco novo (Neon) — verificado 2026-09-24

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
| `mmr_players` | **15** — formato antigo, com `S_aj` na janela |
| `mmr_characters` | **8** — o TRI da fórmula antiga |
| `mmr_anon_players` | 1 |
| `character_records` | **8** recordes 👑 (mantidos pelo reset) |
| `selecao_estatisticas` | **120** registros anônimos |
| `schema_migrations` | **15** (001 até 015_catalogo.sql) |

### O que ficou de fora, por decisão do dono (§22.1)

`logs`, `log_messages`, `duels`, `sessoes_ativas`, `selecao_logs`, `progress`,
`notificacoes`, `comunidade` — **todos em zero**. Nenhuma transcrição de
atendimento subiu.

### O que ainda entra sozinho

`prompt_arquivos` e `criterios` estão em **0** — o boot do app semeia lendo
`/data/prompts/*.md` (por isso o volume tem que subir ANTES do primeiro boot
completo).

### O que as migrações 016 e 017 vão fazer no primeiro boot

Verificado antes de rodar:

- `character_records.character_records_user_id_fkey` **existe** → 016 dropa.
- `character_records` **sem** coluna `origem` → 016 adiciona.
- `logs` **sem** coluna `mmr_delta` → 016 adiciona.
- `mmr_players.estado` no formato antigo (`P`, `n`, `W` com `S_aj`) → 017
  copia para `mmr_players_arquivo_v1` (com `arquivado_em`) e trunca. Idem
  `mmr_characters` (com `fontes`) e `mmr_anon_players`.

Depois disso o estado do motor volta a zero. Todos vão para calibração. Os
recordes 👑 continuam.

---

## 4. Comandos úteis (repetir se algo se perder)

### Regerar o `.tar.gz` do volume

```bash
cd /home/paulo/Documentos/projetos/allos/all_os
rm -rf /tmp/volume-novo && mkdir -p /tmp/volume-novo
cp -r data/prompts /tmp/volume-novo/
cp avaliacao/v34/criterios-no-v34.md /tmp/volume-novo/prompts/avaliacao/v34/
cp avaliacao/v34-duelo/sintetizador-v34-duelo.md /tmp/volume-novo/prompts/avaliacao/v34-duelo/
cp avaliacao/v34-progressao/missao-v34-progressao.md /tmp/volume-novo/prompts/avaliacao/v34-progressao/
cp avaliacao/v34-progressao/sintetizador-v34-progressao.md /tmp/volume-novo/prompts/avaliacao/v34-progressao/
cp -r data/patient-photos data/exercise-photos data/avatar-pool data/comunidade-avatars /tmp/volume-novo/ 2>/dev/null
cd /tmp/volume-novo && tar czf /tmp/volume-novo.tar.gz . && find . -name '*.md' | wc -l  # tem de dar 10
```

### Consultar o Neon (só leitura)

```bash
psql "$(cat ~/.neon-url)" -c "SELECT COUNT(*) FROM users;"
```

### Rodar testes local (precisa Docker)

```bash
npm run db:up          # Postgres 17 em Docker, porta 5433
npm test               # 913 testes esperados
npm run build          # cliente
```

### Sanity checks para depois do deploy

- No painel do Neon, `SELECT * FROM mmr_players_arquivo_v1 LIMIT 1;` — deve
  existir, com dados do formato antigo.
- No app, entrar como admin, ir em Ranking — todos aparecem "em calibração"
  (nEntradas < 3 depois do reset).
- No perfil de qualquer aluno, o bloco "Por critério" ainda não deve mostrar
  nada (só aparece depois da 3ª avaliação).

---

## 5. Decisões fechadas que não se rediscutem

| Decisão | Onde |
|---|---|
| **Sem temporadas.** Ranking é MMR + filtro por tag, sem período nem zeragem | §22.2 |
| **Importação sem transcrições** de atendimento | §22.1 |
| **Volume novo** na virada, não compartilhado | §23.1 |
| **`JWT_SECRET` e VAPID iguais** na virada; rotacionar depois | §21.1 |
| **Remover critério = desativar** (coluna `ativo`), nunca apagar | §23.2 |
| **Peso do TRI é do admin**, na tela de Acessos, de 0 a 1 | §22.4 |
| **Ohio** (us-east-2) mantido conscientemente, apesar do Railway em Virgínia | §21.4 |
| **Dados de aluno são persistentes** — sem poda de `logs`/`duels`/`selecao_logs` | §24.0 |
| **MMR por critério com reset one-shot** no deploy da §24; recordes 👑 ficam | §24.1–§24.4 |
| **Alan avisa os alunos presencialmente** — sem aviso in-app do reset | §24 grilling |
| **Bloqueio de 15 dias por WhatsApp** só no seletivo, com botão "Dar mais uma chance" para o avaliador; prova de 2h (substitui a linha "sem dedupe" da §24.0) | §25 |
| **Deploy pela `main` do fork** — não vamos mandar para o `arthurbpinho/all_os` | 2026-09-24 |
| **`.env` fica como está** — não vamos migrar variáveis para o admin nesta rodada | 2026-09-24 |

Dívidas técnicas anotadas mas **não** para agora (ver §7):
- Migrar para admin panel: `CADASTRO_EXTERNO_ABERTO`, `TERMOS_URL`,
  `TERMOS_VERSAO`, `PRIVACIDADE_URL`, `MAIL_FROM_NAME`.
- Rótulo dos critérios no perfil do aluno é "Crit. <id>" — quando surgir um
  endpoint público de nomes ativos, trocar por nome do critério.

---

## 6. Ambiente local de demonstração

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

## 7. Pontas soltas conhecidas

- **Não há CI.** Rodar `npm test` antes de qualquer deploy.
- **A conta `Victor.toscano` virou `Victor.toscano-39`** na importação, por
  colisão de maiúsculas (a unicidade é case-insensitive). A pessoa **já foi
  avisada**.
- **`VISITOR_TRI` está desligado.** A avaliação de visitante não existe; o
  caminho está escrito e testado, e liga com `VISITOR_TRI=1`.
- **Comunidade**: retenção (agora que é persistente por §24.0) e moderação
  seguem sem definição avançada — decidir eventualmente.
- **Rótulo dos critérios** no perfil ainda é `Crit. <id>` — precisa de rota
  pública que devolva os nomes ativos.
- **`ADMIN_INITIAL_PASSWORD`** não vai para o Railway (fail-closed só ativa
  se o banco não tiver admin nenhum, o que não é o caso).

---

## 8. Cópias do volume antigo

O backup de `/data` de produção (9,8 MB → 3,3 MB comprimido) está em **três
lugares**: disco do Paulo, pen drive e o Drive da Allos. É a única cópia dos
**prompts**, que não estão no git (§9.2 do `demandas.md`).

No repositório, já descompactadas e **fora do git**:

- `data/` — a cópia completa do volume
- `data-parcial/` — só o que foi importado para o Neon

Para tirar uma cópia nova: **painel do Railway → serviço → Console**, e baixar
pelo painel **Files**. **`railway run bash` não funciona** — ele executa na sua
máquina, não dentro do container, e não enxerga o `/data`.
