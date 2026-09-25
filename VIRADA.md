# Virada para o PostgreSQL

Passo a passo para trocar o sistema em arquivos JSON pelo sistema com banco
(branch `feat/postgres-fase1`). Decisões e contexto em `demandas.md` §17 e §18.

Ensaiado localmente em 2026-09-15: importação de uma cópia da pasta de dados,
boot do app contra o banco importado, prompts e critérios semeados sozinhos.

---

## 0. O que muda e o que não muda

- **Vai para o banco:** contas, logs, progresso, MMR, duelos, prompts, filas,
  notificações, conquistas, sidequests, antessala, Processo Seletivo, Comunidade,
  configurações, tags, uso de IA e **os catálogos** (pacientes, exercícios, neuro,
  competências da Trilha — `demandas.md` §20).
- **Continua no volume `/data` (obrigatório):** fotos (pacientes, exercícios,
  pool de avatares, comunidade), detalhe por critério das avaliações, raciocínio
  da Avaliação Independente, transcrições do benchmark.
- **O app roda em UMA instância.** Prompts, catálogos, configurações e
  sidequests têm cópia em memória.

## 1. Antes de mexer em qualquer coisa

1. Avisar os usuários do horário (a janela entre a cópia e a virada perde o que
   for feito no sistema antigo).
2. **Cópia de segurança do volume inteiro**, para fora do Railway. Feito em
   2026-09-22 pelo **Console do painel do Railway**, sem instalar CLI:
   ```bash
   tar czf /app/data-backup.tar.gz -C / data && ls -lh /app/data-backup.tar.gz
   ```
   O `-C /` guarda os caminhos como `data/...`, que é o que a importação espera.
   O pacote é criado em `/app` de propósito: é onde o painel **Files** (rodapé do
   Console) enxerga e permite baixar. Volume inteiro = 9,8 MB → 3,3 MB comprimido.
   Depois do download, `rm /app/data-backup.tar.gz` — o pacote tem hashes de
   senha, PII e transcrições, e `/app` não é lugar para isso ficar.

   > **Não use `railway run bash`** (era o que este documento e o `DEPLOY.md`
   > mandavam). O `railway run` executa na SUA máquina com as variáveis do
   > Railway injetadas; ele não enxerga o `/data`, que está dentro do container.
   > Os caminhos que funcionam são o Console do painel e o `railway ssh`.

   É desta cópia que a importação lê. Ela também é o backup dos prompts (§9), e
   por isso vai para **mais de um lugar** (em 22/09: disco, pen drive e o Drive
   da Allos).
3. Baixar também o export pela tela (Administração → exportar), como segunda cópia.

## 2. Banco

1. Criar o projeto no **Neon**, Postgres **17**.
2. **Desligue o "Object storage"** na criação. O app não usa bucket: as fotos
   ficam no volume do Railway (§0). Ligado, é serviço a mais para cobrar e mais
   uma coisa para alguém confundir depois com "onde estão as fotos".
3. Anotar a connection string (com `?sslmode=require`).
4. 🔴 **Use o endpoint DIRETO, não o `-pooler`.** O Neon oferece os dois; o
   `-pooler` é PgBouncer em modo transação. O runner de migrações segura um
   **advisory lock de sessão** (`server/db/migrate.js`), e o próprio comentário
   de lá explica o porquê: o lock pertence à sessão, e uma conexão que troca de
   dono entre as transações o perde. Com o pooler, a proteção contra dois
   processos migrando ao mesmo tempo some **em silêncio**. A diferença entre as
   duas strings é o texto `-pooler` no host.

**Feito em 2026-09-22:** projeto no Neon, Postgres **17.11**, região
**AWS us-east-2 (Ohio)**, endpoint direto. A região ficou em Ohio e não em
`us-east-1` (Virgínia, ao lado do `us-east4` do Railway) — **decisão do dono,
mantida conscientemente**; custa uns 10–15 ms por consulta.

A connection string mora em `~/.neon-url` (fora do repositório, `chmod 600`) e
entra nos comandos por substituição, para não ficar no histórico do shell nem
em arquivo versionado:

```bash
DATABASE_URL="$(cat ~/.neon-url)" node scripts/importar-volume.js ./data
```

**Não ponha a string do Neon no `.env`**: esse arquivo é lido pelo app e pela
suíte de testes a cada execução local (`server/index.js:1`), e o `npm run dev`
passaria a falar com produção.

## 3. Importar (ANTES do primeiro boot do app novo)

Na sua máquina, com a cópia do volume descompactada:

```bash
tar xzf data-backup.tar.gz          # cria ./data
DATABASE_URL="$(cat ~/.neon-url)" node scripts/importar-volume.js ./data
```

- ⚠️ **Confira a primeira linha da saída**, que imprime o banco. O script carrega
  o `.env` do projeto (`require('dotenv').config()`); esquecer a variável na
  frente do comando faz a importação cair no **Postgres local** sem avisar.
- ⏱️ **Demora, e o gargalo é a rede.** A importação insere um registro por vez:
  uma ida e volta até o banco para cada linha. Rodando do Brasil contra o Neon em
  Ohio a latência medida foi de **639 ms por consulta**, e ~2.900 inserções
  levaram ~25 min. Não é sintoma de problema. Em produção quem fala com o banco é
  o Railway (mesma costa), não a máquina de quem migra.
- O script aplica as migrações e importa. O banco precisa estar vazio.
- Os catálogos entram junto (`freeplay-characters.json`, `neuro-characters.json`,
  `exercises.json`, `trilha-skills.json`), com a marca de semeado: o boot não
  põe os pacientes de exemplo por cima.
- Leia o relatório: registros ignorados saem com o motivo; contas excluídas que
  ainda eram referenciadas viram lápide; nomes repetidos só na caixa são
  renomeados com o id.
- Deu errado? Corrija e rode de novo com `--limpar` (apaga os dados do banco,
  menos os prompts).

## 3b. Prompts atualizados (textos que se ajustam à quantidade de critérios)

Os prompts não estão no git. Os textos do v34 foram atualizados na máquina do
Paulo (`avaliacao/` e `server/data/prompts/`, §20.1 de `demandas.md`) e só chegam
à produção pelo volume:

1. **Antes de copiar, compare** com os prompts do volume de produção
   (`/data/prompts/avaliacao/...`). Se algum foi editado em produção depois da
   cópia local, junte as duas edições antes — copiar por cima perderia a de
   produção.
2. Copie os `.md` atualizados para `/data/prompts/avaliacao/` (mesmos caminhos).
3. No boot, a semeadura (§20.2) insere o que falta e **atualiza o prompt que
   ninguém editou pelo painel**, com a versão anterior no histórico. No log:
   `[prompts] atualizado(s) pela semente …`. Prompt editado pelo painel aparece em
   `[prompts] editado(s) pelo admin, semente ignorada …` e fica como está.

Alternativa sem mexer no volume: depois do boot, colar os textos em
Administração → Prompts.

## 4. App novo no Railway

1. Projeto novo, apontando para a branch com o banco.
2. **Volume NOVO, com a cópia restaurada nele** — decisão de 2026-09-23.
   Não compartilhe o volume com o projeto antigo: os prompts do v34 atualizados
   usam `{{N_CRITERIOS}}`, e o **código antigo não substitui esses marcadores**
   (verificado: nenhuma ocorrência no `main`). Com volume compartilhado, copiar
   os prompts novos trocaria os prompts do sistema que ainda está no ar. Com
   volume próprio, a Fase 4 (§3b) pode ser feita com calma, antes de subir o app,
   e o plano de volta (§7) fica limpo: o projeto antigo segue intocado.
3. Variáveis: as de hoje (`ADMIN_INITIAL_PASSWORD`, chaves de IA, Graph,
   Turnstile, `APP_BASE_URL`) **mais** `DATABASE_URL`, e mais o que a decisão
   abaixo define para `JWT_SECRET` e VAPID.

   **Decisão de 2026-09-22 — `JWT_SECRET` e VAPID: os MESMOS da produção atual**,
   e rotacionar o secret **depois**, como passo separado, com o sistema antigo já
   fora do ar. O que sustenta:
   - Os dois sistemas ficam no ar ao mesmo tempo. Com o mesmo secret, quem cai
     num lado e depois no outro transita sem perceber; com secrets diferentes é
     deslogado a cada troca, justamente na semana de mais suporte.
   - O token dura 7 dias e carrega `{ sub, role, username, tv }`
     (`server/index.js`, `signToken`). A importação preserva id e `token_version`
     de cada conta (`server/importar-volume.js`), então um token emitido hoje
     pelo sistema antigo é aceito pelo novo sem ajuste nenhum.
   - Trocar o VAPID é menos grave do que parece: `client/src/push.js` compara a
     chave da assinatura existente com a atual do servidor e reassina sozinho, no
     boot do app, sem prompt. Perde-se só o push disparado entre a virada e a
     próxima visita da pessoa. Ainda assim, manter é de graça.
   - Contra-argumento registrado: esse `JWT_SECRET` hoje existe em mais lugares
     do que existia (`.env.producao` na máquina do Paulo, além do painel). Não
     foi para o git — `.env*` está no `.gitignore` —, mas é o motivo de a
     rotação ficar agendada em vez de descartada.
4. **Trocar `SELECAO_PASSWORD` e `BENCHMARK_PASSWORD`.** Os defaults do código
   (`allos01` e `albires1`) estão escritos em `server/index.js`, num repositório
   **público**.
5. **Uma réplica só.**
6. Subir. No log do boot deve aparecer `[prompts] N prompt(s) semeado(s) no banco.`
   Não deve aparecer `[catalogo] semeado(s) no banco` — os catálogos já vieram da
   importação. Se aparecer, a importação não trouxe algum catálogo: confira o
   relatório do passo 3.

## 5. Domínio e Cloudflare

1. Domínio próprio atrás do Cloudflare (proxy laranja ligado).
2. **Não divulgar o domínio `*.up.railway.app`.**
3. Logado como admin, abrir `/api/admin/diagnostico-ip` **pelo domínio próprio**:
   - `conexaoEhCloudflare: true` → tudo certo, os limites de tentativa usam o IP real.
   - `false` → o Railway está escondendo o IP do Cloudflare. Os limites estariam
     contando todo mundo como um IP só. Definir `CONFIAR_CF_CONNECTING_IP=sempre`
     e, nesse caso, **desativar o domínio do Railway** (por ele o cabeçalho é forjável).

## 6. Conferência depois do boot

- [ ] Login do admin e de um aluno real.
- [ ] Administração → Prompts: os prompts de produção estão lá, e o painel
      "Critérios da régua" não mostra aviso de quantidade escrita à mão.
- [ ] Pacientes, casos de neuro, exercícios e competências da Trilha: os mesmos
      de antes, com as fotos.
- [ ] Um atendimento de Treinamento avaliado do começo ao fim.
- [ ] Ranking e Logs com os dados importados.
- [ ] Cadastro de teste recebe o e-mail de confirmação (Graph) e mostra o captcha.
- [ ] Processo Seletivo: dashboard com o histórico.
- [ ] Comunidade: um link antigo de discussão abre a mesma discussão.

## 7. Se precisar voltar

O sistema antigo continua no projeto antigo do Railway, com o volume intacto
(a importação só lê). Voltar = apontar o domínio de novo para ele. O que foi
feito no sistema novo depois da virada não volta junto.
