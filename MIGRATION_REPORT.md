# Migração delta — All_OS antigo (JSON) → Neon

**Data:** 2026-10-13. **Estado:** executada na produção do Neon com autorização do
dono — contas, catálogo, recordes, conquistas, sidequests e feedback às 17:20 UTC
(§10); logs de atendimento e duelo às 18:03 UTC (§11). App novo verificado ponta a
ponta com contas reais (§12). **Falta a virada**, com uma última rodada
(§8, virada) — sem troca de DNS: o código com banco entra no `main` do
`arthurbpinho/all_os`, que já é o que o domínio publica. Decisões em
`demandas.md` §25 e §26.

> Os repositórios são públicos: ids de infraestrutura (projeto e endpoints do
> Neon, projeto/serviço da Railway) **não** estão aqui. Os comandos usam as
> variáveis de `~/allos-backups/ids-migracao.env`, que fica só na máquina de quem
> migra.

---

## 1. Resumo

O sistema antigo seguiu no ar depois da importação de 22/09 (§22.1 do
`demandas.md`). Esta migração leva para o banco **só o que mudou desde então**,
sem mexer no schema.

| | Volume antigo (13/10) | Neon antes | Neon depois |
|---|---|---|---|
| Contas | 125 | 51 | **125** (+74; 5 atualizadas) |
| Pacientes | 10 | 8 | **10** (+2; 4 com foto nova) |
| Recordes 👑 | 10 | 8 | **10** (+2; 3 com nota maior) |
| Conquistas resgatadas | 136 (103 de contas) | 0 | **83** (53 rejeitadas, de propósito) |
| Sidequests (banco/ativas/concluídas) | 24 / 7 / 3 | 1 / 0 / 0 | **24 / 7 / 3** |
| Logs de atendimento | 91 (17/09 → 12/10) | 0 | **91**, com as 10.567 mensagens |
| Duelos | 1 | 0 | **1** |
| Detalhe por critério (volume) | 91 com log | 0 | **91** |
| Dificuldade de partida dos pacientes | — | 0 | **8** pacientes semeados |
| Fotos de pacientes (volume) | 20 | 12 | **20** |

Validação: **nenhuma divergência** em todos os registros do escopo, conferidos
inteiros contra a origem; as 20 checagens de integridade em zero; a segunda rodada
não inseriu nem atualizou nada; e o app novo, rodando sobre uma cópia da produção,
mostrou a cada pessoa os dados dela (§12).

## 2. Origem e destino

- **Origem:** volume `/data` do serviço Railway antigo (repo `arthurbpinho/all_os`,
  commit `e4ba033`, domínio `treinamento.allos.org.br`). Copiado por `railway ssh`
  (`tar` só lê) para `~/allos-backups/data-backup-<carimbo>.tar.gz`, com hashes
  conferidos contra o volume; a cópia extraída fica somente leitura.
- **Teste:** branches do Neon criadas da `production` (`migracao-teste`,
  `migracao-teste-logs`).
- **Produção:** branch `production` do Neon — o banco do serviço Railway novo
  (`stellar-enjoyment`).

sha256 dos arquivos lidos na carga dos logs (cópia de 18:03 UTC):

```
adf46cfd20355fc55522780ff517000a1d1969a2a7c154c0d6fec7e22f58821e  users.json
c0147e3d424f31e46a46e52ae3b1f9e326e1af49d896b76b11a777d0acfeec13  counters.json
e5c17dc15f15a364e9dedeb44c00527cbfb98598f4d083df2723ce61db25143f  character-records.json
7c72ae60540b4003373c0c1af78a1821c96b65e38ecd21703db891dab23e2e1a  settings.json
c78f0af74ab2f853747a3611368e3938528d5ddeecada3d69d6c4272ce0d1513  avatar-pool.json
bada730c71e41a053f42d6bb7cc527c3c606a0f70be58cdaa536acfbed15d625  achievements.json
c49d3f4c0e5dbf3d21a64a9df128350cd3f1b2f7a57228102e5142e980643d86  achievement-unlocks.json
d65c039d05d58c40c36bcb80c781cdfaf9169b87d3b9fe59c68d7d485c8ffbf3  sidequests.json
a78667839e1ce8b8ae0da7c0d0bf8d5e9bcdbcf04518d67774bafd330503c2bd  feedback.json
0d225f70a2c7674d8901f7460877eb21ed38abf425d10548ccd9204aa9b6267e  mmr.json
cf6461f01858abd4c506dc0c9c43fc427bb7cd35c22ca34f90ba13f3251b00c8  logs.json
746e32fef202f140a4f48163c071d2cb21120e665aed9774ff53b8b84c33fa07  duels.json
30666d82fc666bbcf9c40211554eaef17144e60788de8c884e49091a9f75fe5c  freeplay-characters.json
3a5c08310df0fe1c9866e3d44e65e6e936f7f056a7058a2064d036a7e07bb5ed  neuro-characters.json
e8ab1933da138d4ec785b79d252a2d86bae45122575cd789cfc1e0f23ed5c6b6  exercises.json
ecca8225dd6d0b3553df8ccc9ab1bdf8f5f795363a80ec0fc2db689a818dff81  trilha-skills.json
```

## 3. Decisões de schema

**Nenhuma.** As tabelas são as das migrações 001–017 e não foram alteradas. O que
seria "proposta de schema" virou um mapeamento do JSON para as colunas que já
existem:

| Origem | Tabela | Regra |
|---|---|---|
| `users.json` | `users` | Insere com o mesmo id; nas existentes, o antigo vence, menos senha (vale o `token_version` maior) e username (nunca muda). Sequência de ids avança até o `lastUserId` |
| `counters.json` | `contadores_usuario` | Maior valor dos dois lados |
| `freeplay-characters.json` + neuro, exercícios, Trilha | `catalogo_itens` | Upsert por (tipo, id); ordem = posição no arquivo |
| `character-records.json` | `character_records` | Só troca por nota **maior** (a regra do app) |
| `avatar-pool.json` | `configuracoes['avatar-pool']` | Upsert |
| `settings.json` (só `selecaoPassword*`) | `configuracoes['settings']` | Só se o `selecaoPasswordUpdatedAt` do arquivo for mais novo; o resto do bloco fica |
| `achievements.json` | `conquistas_resgatadas` | Insere o que falta; a do banco fica |
| `achievement-unlocks.json` | `conquistas_vistas` | União com o que o banco tem |
| `sidequests.json` | `sidequests_banco`, `_ativas`, `_concluidas` | Upsert; concluída sem chave natural é deduplicada pelo documento |
| `feedback.json` | `feedback` | Insere o que falta |
| `logs.json` | `logs` + `log_messages` | Upsert pelo id do log; mensagens por (log, posição). Mesmos normalizadores do app (um teste compara com o `repos/logs.js`) |
| `duels.json` | `duels` | Upsert pelo id; token de convite que já pertença a outro duelo é rejeitado |
| `mmr.json` (só `characters`) | `mmr_characters` | Semeia o D de partida (§4, item 7); paciente que o motor novo já mexeu fica |
| fotos e `avaliacoes-criterios/` | volume do app novo | Copia novos e diferentes por sha256; guarda antes os que serão trocados; nunca apaga. Do detalhe por critério, só os arquivos que têm log |

Rejeitados vão para um **arquivo** `.jsonl` em `~/allos-backups/` (com o motivo),
e não para uma tabela, porque a regra é não criar tabelas.

**Fora do escopo, por decisão do dono:** logs e dashboard do seletivo, Comunidade,
logs de erro, sessões em andamento, filas internas, Antessala, push, missões
diárias, progresso da Trilha, notificações, o MMR dos alunos e a cópia de 22/09
(logs anteriores a 17/09, que o sistema antigo já tinha podado). Também não vão os
prompts (os do volume novo são as versões atualizadas de propósito) nem arquivos
que nenhum código lê (`desafio*.json`, `updates.json`, `migrations.json`).

## 4. Problemas encontrados e tratamento

| # | Problema | Tratamento |
|---|---|---|
| 1 | Contas 23 e 39 só diferem na caixa do username (no sistema antigo, nenhuma das duas conseguia entrar) | Mantido o `-39` que já está no banco (§23.3). No app novo as duas entram |
| 2 | A conta 1 (admin) trocou a senha no **sistema novo** | Regra do `token_version` maior: fica a do banco. Aviso no relatório |
| 3 | 42 contas sem `criadoEm` (criadas pelo admin), 2 delas novas | Recebem o horário da carga, como a importação de 22/09 fez |
| 4 | A foto padrão `/profiles_icon/isaacdeterno.jpeg` não existe em nenhum dos deploys | Resolvido pelo pool de avatares, que estava ausente no Neon (~100 contas) |
| 5 | 20 resgates de conquistas removidas há tempo | Rejeitados com o motivo — já não aparecem nem no sistema antigo |
| 6 | 33 conquistas de visitantes | Rejeitadas — visitante não tem conta |
| 7 | Pedido do dono: base de dificuldade para o MMR recomeçar | D antigo dos 8 pacientes maduros (`n_D ≥ 20`) vira o D inicial de cada critério ativo, com contagens zeradas. Desvio consciente da spec §11 |
| 8 | 4 fotos de pacientes trocadas com o **mesmo nome de arquivo** | Sobrescritas no volume novo, com cópia das antigas antes |
| 9 | O app guarda catálogo, configurações e sidequests em memória | Reiniciar o serviço depois da carga |
| 10 | O app novo apaga detalhes por critério "órfãos" | Os 91 copiados têm o `logId` do log certo; a poda só toca arquivo sem `logId` |
| 11 | O sistema antigo poda logs com mais de 30 dias | A carga é incremental e nunca apaga: rodar agora guardou os 91; a virada traz os novos |

Nenhuma referência órfã no escopo. Datas em ISO, UTF-8 sem BOM, ids de conta sem
buracos. Todos os 125 hashes de senha são bcrypt `$2b$10$`.

## 5. O que o script faz

`scripts/migrar-delta.js` (CLI) + `server/migrar-delta.js` (regras):

- Uma transação só. Com `--dry-run`, roda tudo e desfaz no fim.
- Cada passo é um `INSERT … ON CONFLICT` em lote (`jsonb_to_recordset`), que só
  regrava a linha que de fato mudou. O relatório separa novos, atualizados,
  iguais e rejeitados.
- `--alvo=<ep-…>` é obrigatório e precisa bater com o host do `DATABASE_URL`. O
  script **não lê o `.env`**: sem a variável, para.
- Arquivo de origem corrompido para a migração antes de gravar qualquer coisa.
- `scripts/sincronizar-fotos-delta.sh`: arquivos do volume por SSH, simulação por
  padrão; `PASTAS` e `LISTA` escolhem o que vai.
- Conferência: `scripts/validar-delta-export.sql` (fotografia antes/depois),
  `scripts/validar-delta.py` (origem × banco, campo a campo) e
  `scripts/validar-delta.sql` (integridade).

Testes: `tests/migrar-delta.test.js` (11 casos: regras de conflito, rejeitados,
`--dry-run`, idempotência, arquivo corrompido, log migrado idêntico ao gravado pelo
app, marcação feita depois que chega sem duplicar, e a lista de conquistas presa à
do `index.js`).

## 6. Validação na branch de teste

| Execução | Resultado | Tempo |
|---|---|---|
| `--dry-run` | mesmos números da carga; nada gravado | 7–10 s |
| Carga | 73 + 5 contas, 2 + 4 pacientes, 2 + 3 recordes, 83 conquistas, 23 + 7 + 3 sidequests, 8 feedbacks, 8 dificuldades; depois 91 logs, 10.567 mensagens, 1 duelo | 12,4 s + 11,4 s |
| Segunda rodada | **0 novos, 0 atualizados** em todos os passos; contagens idênticas | ~10 s |

Contagem origem × tabela: `users` = 125 do arquivo; `catalogo_itens` = 10 + 2 + 1
+ 1; `character_records` = 10; `conquistas_resgatadas` = 136 − 33 de visitantes − 20
removidas; `conquistas_vistas` = contas do arquivo (unidas às que o app novo
tinha); `sidequests_*` = arquivo; `feedback` = 8; `mmr_characters` = 10 − 2 com uma
avaliação só; `logs` = 91; `log_messages` = 10.567; `duels` = 1. Nenhuma outra
tabela mudou.

## 7. Tempo

Cópia do volume (8 MB comprimido) ~10 s; simulação ~10 s; carga ~10–14 s; segunda
rodada ~10 s; arquivos ~10 s. A rede (Brasil → Ohio) domina: a carga vai em lotes,
uma consulta por tabela.

## 8. Passos exatos (produção e virada)

```bash
cd ~/Projetos/allos2
source ~/allos-backups/ids-migracao.env
export NEON_API_KEY="$(cat ~/.neon-api-key)"
B=~/allos-backups
T=$(date -u +%Y-%m-%dT%H%MZ)
```

**1. Acesso SSH aos dois serviços** (uma vez):

```bash
mkdir -p $B/rw-antigo $B/rw-novo
(cd $B/rw-antigo && railway link --project $RW_ANTIGO_PROJETO --environment $RW_ANTIGO_AMBIENTE --service $RW_ANTIGO_SERVICO \
   && railway ssh config --path $B/ssh-config --alias allos-antigo)
(cd $B/rw-novo && railway link --project $RW_NOVO_PROJETO --environment $RW_NOVO_AMBIENTE --service $RW_NOVO_SERVICO \
   && railway ssh config --path $B/ssh-config --alias allos-novo)
SSHO="-F $B/ssh-config -o UserKnownHostsFile=$B/known_hosts -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
```

**2. Cópia nova do volume antigo** (só lê):

```bash
(umask 077; ssh $SSHO allos-antigo 'tar czf - -C / --exclude=data/lost+found data' > $B/data-backup-$T.tar.gz)
mkdir -p $B/volume-$T && tar xzf $B/data-backup-$T.tar.gz -C $B/volume-$T && chmod -R a-w $B/volume-$T/data
```

**3. Ponto de volta e fotografia "antes"**:

```bash
neonctl branches create --project-id $NEON_PROJETO --parent production --name antes-migracao-$T
(umask 077; PGOPTIONS='-c default_transaction_read_only=on' psql "$(cat ~/.neon-url)" -X -A -t \
   -f scripts/validar-delta-export.sql -o $B/prod-antes-$T.json)
```

**4. Simulação e carga**:

```bash
DATABASE_URL="$(cat ~/.neon-url)" node scripts/migrar-delta.js $B/volume-$T/data --alvo=$EP_PRODUCAO --dry-run
DATABASE_URL="$(cat ~/.neon-url)" node scripts/migrar-delta.js $B/volume-$T/data --alvo=$EP_PRODUCAO
```

**5. Arquivos do volume** (sem `--aplicar` primeiro, para ver a lista):

```bash
export SSH_OPTS="$SSHO"
scripts/sincronizar-fotos-delta.sh $B/volume-$T/data allos-novo --aplicar
node -e "console.log(require('./server/migrar-delta').arquivosDeDetalhe('$B/volume-$T/data').join('\n'))" > $B/detalhes-$T.txt
PASTAS=avaliacoes-criterios LISTA=$B/detalhes-$T.txt scripts/sincronizar-fotos-delta.sh $B/volume-$T/data allos-novo --aplicar
```

**6. Reiniciar o app novo** (catálogo, configurações e sidequests em memória):

```bash
railway restart --project $RW_NOVO_PROJETO --environment $RW_NOVO_AMBIENTE --service $RW_NOVO_SERVICO -y
```

Em 13/10 a CLI reiniciou o serviço mas ficou presa depois. Se travar, interrompa e
confira pelo SSH que o processo do app começou depois da carga.

**7. Conferência**:

```bash
(umask 077; PGOPTIONS='-c default_transaction_read_only=on' psql "$(cat ~/.neon-url)" -X -A -t \
   -f scripts/validar-delta-export.sql -o $B/prod-depois-$T.json)
python3 -I scripts/validar-delta.py $B/volume-$T/data $B/prod-antes-$T.json $B/prod-depois-$T.json
PGOPTIONS='-c default_transaction_read_only=on' psql "$(cat ~/.neon-url)" -X -A -F ' | ' -t -f scripts/validar-delta.sql
DATABASE_URL="$(cat ~/.neon-url)" node scripts/migrar-delta.js $B/volume-$T/data --alvo=$EP_PRODUCAO   # 0 novos / 0 atualizados
```

### Virada (sem troca de DNS)

Decisão do dono: a produção é o `main` do `arthurbpinho/all_os`, que o serviço
Railway do domínio (`all_os`) já publica. Ordem:

- **A.** `git push <arthurbpinho> e4ba033:refs/heads/sistema-antigo-json` — o
  sistema antigo vira backup.
- **B.** Passos 2 a 4 e 7 acima: última carga, com o sistema antigo ainda no ar.
- **C.** Volume do serviço do domínio: guardar `/data/prompts` em
  `/data/prompts-sistema-antigo-<data>.tar.gz` e escrever nele os prompts do banco
  (`prompt_arquivos`), conferindo o sha256 de cada um contra o `semente_hash`. Sem
  isso, a semeadura do boot trocaria os prompts do banco pelos antigos do volume.
  (O sistema antigo guarda os prompts em memória: trocar o arquivo não o afeta.)
- **D.** Copiar para o serviço do domínio as variáveis que só o serviço de teste
  tinha (`railway variable set … --stdin --skip-deploys`, valor nunca na tela).
- **E.** Avançar a sequência de ids de conta em 50
  (`setval(pg_get_serial_sequence('users','id'), last_value + 50)`).
- **F.** Serviço de teste: `railway variable delete DATABASE_URL --skip-deploys` e
  `railway service source connect --repo arthurbpinho/all_os --branch sistema-antigo-json`.
  A partir daí só um app fala com o banco.
- **G.** `git merge -s ours <main antigo>` no branch novo (o código novo já tem as
  duas funções dos commits que só o `main` antigo tinha) e push para o `main` do
  `arthurbpinho/all_os`: a Railway publica sozinha. No log do boot **não** pode
  aparecer `[prompts] atualizado(s) pela semente` nem `[catalogo] semeado(s)`.
- **H.** Repetir os passos 2, 4 e 7 com o volume congelado (o código antigo parou):
  traz o que entrou no sistema antigo entre B e G. Reiniciar se catálogo,
  configurações ou sidequests mudarem.
- **I.** VIRADA.md §5 e §6: como admin, `/api/admin/diagnostico-ip` pelo domínio
  (se `conexaoEhCloudflare: false`, `CONFIAR_CF_CONNECTING_IP=sempre`); login,
  Minhas Sessões, Ranking, seletivo.

## 9. Pendências e cuidados

- **Ninguém deve criar conta no app novo antes da virada**: o próximo id do banco
  é o mesmo que o sistema antigo vai dar ao próximo cadastro.
- Quem estiver no meio de uma sessão no sistema antigo na hora da virada perde a
  conversa (sessões em andamento não migram).
- A produção é o `main` do `arthurbpinho/all_os`; o fork do Paulo deixa de ser o
  que vai ao ar (o PR #2 de lá tem o mesmo código).
- Depois da virada: remover a chave SSH `allos-migracao-arthur` da conta Railway,
  apagar as branches de teste do Neon e os `prod-*.json` / `teste-*.json` de
  `~/allos-backups/` (têm hash de senha e dados pessoais); rotacionar o
  `JWT_SECRET` (VIRADA.md §4).

## 10. Execução na produção — contas e cadastros (17:20 UTC)

| Passo | Resultado |
|---|---|
| Cópia nova do volume | 420 arquivos, hashes conferidos; já com 1 conta a mais que a cópia da manhã |
| Ponto de volta | branch `antes-migracao-2026-10-13T1720Z` |
| Simulação → carga | 74 contas novas + 5 atualizadas; o resto idêntico ao teste; carga em 14,0 s |
| Fotos | 8 novas + 4 trocadas, conferidas por sha256; antigas guardadas |
| Restart | processo do app iniciado às 17:23:32 UTC, depois da carga |
| Conferência | 0 divergências; integridade 20/20; segunda rodada 0/0 |

## 11. Execução na produção — logs e duelo (18:03 UTC)

| Passo | Resultado |
|---|---|
| Cópia nova do volume | 420 arquivos; 91 logs, 125 contas |
| Teste antes | branch `migracao-teste-logs`: 91 logs, 10.567 mensagens, 1 duelo; conferência campo a campo de todos os logs com as mensagens na ordem: 0 divergências; segunda rodada 0/0 |
| Ponto de volta | branch `antes-logs-2026-10-13T1803Z` |
| Simulação → carga | 91 logs, 10.567 mensagens, 1 duelo; tudo o que já estava ficou igual; carga em 8,2 s |
| Detalhe por critério | 91 arquivos copiados e conferidos; todos com o `logId` do log certo |
| Conferência | 0 divergências (logs: 1.638 campos); integridade 20/20; segunda rodada 0/0; nenhum log duplicado. O banco tem 92 logs: 91 migrados + 1 feito no app novo |

## 12. Verificação ponta a ponta do app (sobre cópia da produção)

O app novo rodou localmente sobre uma branch descartável da produção
(`verificacao-app`), sem chaves de IA, e-mail ou push. Nessa cópia, 8 contas reais
receberam uma senha de teste **gerada pela biblioteca do sistema antigo** (os 125
hashes de produção são do mesmo formato, `$2b$10$`). O login dos dois sistemas é o
mesmo código (`bcrypt.compare`, bcryptjs 3.0.3, username sem caixa), então hash
igual = senha igual — e a conferência da §11 mostrou os hashes idênticos aos do
sistema antigo em todas as contas.

| Conta | Login (e em maiúsculas; senha errada recusada) | Perfil e foto | Minhas Sessões | Metas | Outros |
|---|---|---|---|---|---|
| 81 — externa, criada depois de 22/09 | OK | OK (foto própria) | 14/14, nota e mensagens batem | 6/6 | aluno não recebe a chave do detalhe |
| 110 — externa nova | OK | OK (pool) | 2/2 | 2/2 | — |
| 38 — terapeuta | OK | OK (pool) | 2/2 | 0/0 | — |
| 5 — terapeuta | OK | OK (foto própria) | — | 3/3 | sidequest ativa igual |
| 9 — trocou a senha no antigo | OK | OK | — | 1/1 | — |
| 39 — `…-39` | OK | OK | — | — | — |
| 3 — supervisor | OK | OK | — | — | — |
| 1 — admin | OK | — | 91/91 nos Logs de Supervisão | — | detalhe por critério abre; 125 contas; Ranking; 10 pacientes com foto; 10 recordes 👑 |

Processo Seletivo na mesma cópia: a senha migrada abre a prova; o mesmo WhatsApp é
bloqueado por 15 dias; "Dar mais uma chance" libera; senha errada é recusada.

No serviço novo (Railway), comparados por hash: `JWT_SECRET`, VAPID, Turnstile,
Graph e `APP_BASE_URL` são **iguais** aos do antigo — quem estiver logado em
`treinamento.allos.org.br` continua logado depois da virada.

Uma observação do teste: o limite de 10 logins errados por 15 minutos por IP
funcionou (o script de verificação, com tentativas erradas de propósito, levou 429).

## 13. Virada — 2026-10-13, 18:35–18:56 UTC

| Passo | Resultado |
|---|---|
| A. Backup | branch `sistema-antigo-json` = `e4ba033` no `arthurbpinho/all_os` |
| B. Última carga com o antigo no ar | nada novo desde 18:03; nenhum conflito de id; ponto de volta `antes-virada-2026-10-13T1835Z` |
| C. Prompts no volume do domínio | antigos em `/data/prompts-sistema-antigo-2026-10-13.tar.gz` (e cópia local); os 10 arquivos agora idênticos ao banco |
| D. Variáveis | as 5 com valor copiadas (`DATABASE_URL` inclusive); as 8 vazias no serviço de teste não entram — vazio e ausente são iguais para o código. As 24 comuns já eram idênticas |
| E. Sequência de ids | 125 → 175 |
| F. Serviço de teste | sem `DATABASE_URL`, publicando `sistema-antigo-json`. O código antigo não sobe lá (volume sem contas + `ADMIN_INITIAL_PASSWORD` curta → fail-closed) — fica parado, sem acesso ao banco |
| G. `main` | merge `dfcc283` (estratégia *ours*: conteúdo = sistema com banco), push sem force. O serviço do domínio **não tinha gatilho de deploy** desde o rollback de 26/09; a origem foi religada ao `main` (`railway service source connect`), o que publicou o `dfcc283` às 18:53:53 UTC. Daqui em diante, push no `main` publica |
| Boot | só `Servidor Allos rodando na porta 8080`: nenhum prompt trocado pela semente, nenhum catálogo semeado, nenhum erro |
| H. Carga final (volume congelado) | nada novo; conferência 0 divergências; integridade 20/20; sequência em 175 |
| I. Pelo domínio | bundle `index-CUwxZwuE.js` (o testado); rotas só do sistema novo respondem; fotos novas e trocadas e pool de avatares servidos do volume; seletivo e login recusam senha errada |

Diagnóstico de IP (VIRADA.md §5), feito pelo dono como admin pelo domínio:
`conexaoEhCloudflare: false` — a conexão chega por um proxy da Railway, e os limites
de tentativa estavam contando todo mundo como um IP só. O serviço só tem o domínio
próprio (nenhum `*.up.railway.app`), e `CONFIAR_CF_CONNECTING_IP=sempre` foi
definido. Os avisos de CSP no console (o beacon de estatísticas do Cloudflare
bloqueado) já existiam no sistema antigo — a política é a mesma.

**Deploy automático (13/10, 19:15 UTC).** O serviço do domínio não tinha gatilho
de deploy porque o app da Railway no GitHub não tinha acesso ao
`arthurbpinho/all_os` (a API recusava: "no one in the project has access to it")
— por isso nada era publicado sozinho desde 26/09. O dono liberou o repositório
para o app, e o gatilho do `main` foi criado: push no `main` publica no
`treinamento.allos.org.br`. A `CONFIAR_CF_CONNECTING_IP=sempre` entrou num
redeploy às 19:13 UTC.
