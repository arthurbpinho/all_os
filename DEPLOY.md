# Deploy no Railway (plano gratuito)

Guia rápido para subir a plataforma Allos em produção. Não inclui execução — apenas as
etapas que você seguirá quando estiver pronto pra colocar no ar.

## Visão geral

- Frontend (React/Vite) é compilado para `client/dist/` durante o build.
- Servidor Express serve a API **e** os arquivos estáticos do build na mesma origem.
  Isso elimina configuração de CORS em produção.
- Dados ficam em arquivos JSON em `DATA_DIR` (default: `server/data/`).
  Em produção, este diretório precisa apontar para o **volume persistente** do Railway.

## 1. Subir para o GitHub

1. Crie um repo privado no GitHub.
2. Garanta que `.env` **não** esteja versionado (já está no `.gitignore`).
3. `git push`.

## 2. Criar o serviço no Railway

1. https://railway.app → New Project → Deploy from GitHub repo → escolha o repo.
2. Railway lê `railway.json` na raiz e aplica:
   - Build:  `npm install && npm run build`
   - Start:  `npm start`

## 3. Variáveis de ambiente (Railway → Variables)

Use `.env.example` como referência. As essenciais:

| Variável                 | Valor                                                 |
|--------------------------|-------------------------------------------------------|
| `OPENAI_API_KEY`         | sua chave da OpenAI                                   |
| `JWT_SECRET`             | string longa aleatória (ver comando abaixo)           |
| `ADMIN_INITIAL_PASSWORD` | senha para o primeiro login do admin                  |
| `DATA_DIR`               | `/data` (após montar o volume — passo 4)              |
| `OPENAI_CHAT_MODEL`      | opcional, default `gpt-5.4-mini`                      |
| `VAPID_PUBLIC_KEY`       | opcional — sem ela, notificação push fica desligada (só o sino in-app funciona) |
| `VAPID_PRIVATE_KEY`      | opcional — par da chave acima                          |
| `VAPID_SUBJECT`          | opcional, default `mailto:ti@allos.org.br`             |
| `APP_BASE_URL`           | **obrigatória com o cadastro aberto** — ex. `https://treinamento.allos.org.br`. É a base dos links de confirmação e de redefinição de senha; sem ela o link sai relativo e não funciona |
| `GRAPH_TENANT_ID`        | e-mail via Microsoft 365 — ver seção 7                 |
| `GRAPH_CLIENT_ID`        | idem                                                   |
| `GRAPH_CERT_PRIVATE_KEY` | idem — chave privada em PEM (o tenant bloqueia client secret) |
| `GRAPH_CERT_THUMBPRINT`  | idem — impressão digital SHA-1 do certificado          |
| `GRAPH_CERT_KEY_FILE`    | só em dev local — caminho do `.pem` em vez de colar o conteúdo |
| `MAIL_FROM`              | caixa remetente, ex. `naoresponda@allos.org.br`        |
| `MAIL_FROM_NAME`         | opcional, default `all_OS — Associação Allos`          |
| `TURNSTILE_SITE_KEY`     | captcha do cadastro — ver seção 8                      |
| `TURNSTILE_SECRET_KEY`   | idem                                                   |
| `TERMOS_URL`             | opcional — URL dos termos de uso. Vazia: o aceite aparece sem link |
| `PRIVACIDADE_URL`        | opcional — URL da política de privacidade              |
| `TERMOS_VERSAO`          | opcional, default `1`. Gravada em cada consentimento; incremente ao publicar revisão dos documentos |
| `CADASTRO_EXTERNO_ABERTO`| opcional — `false` fecha o auto-cadastro sem deploy    |

Gerando o JWT_SECRET localmente:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Gerando o par VAPID (Web Push) localmente:

```
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

> O `PORT` é injetado automaticamente pelo Railway — não defina manualmente.

## 4. Volume persistente (CRÍTICO)

Sem isso, todo redeploy zera usuários, logs e progresso.

1. No painel do serviço → Settings → Volumes → **+ Mount Volume**.
2. Mount path: `/data`
3. Confirme que `DATA_DIR=/data` está nas Variables.
4. Redeploy.

Na primeira execução o servidor copia o conteúdo seed (`server/data/*.json` do repo)
para o volume, mas só preenche arquivos que não existirem — atualizações futuras dos JSONs
no repo **não** sobrescrevem o que já está no volume.

## 5. Domínio + Cloudflare

1. Railway → Settings → Networking → **Generate Domain** (gera um `*.up.railway.app`).
2. No Cloudflare:
   - Adicione seu domínio (ex: `allos.org.br`).
   - DNS → adicione um CNAME apontando para o domínio Railway gerado.
   - Proxy status: **Proxied** (nuvem laranja) — você ganha SSL + cache + DDoS básico.
   - SSL/TLS mode: **Full** (Railway já serve HTTPS).
3. Railway → Settings → Networking → **Custom Domain** → cole o domínio Cloudflare.

> **Não divulgue a URL `*.up.railway.app`.** Ela chega no app **por fora** do
> Cloudflare, e todo o rate limit pré-autenticação (login, visitante, processo
> seletivo) é chaveado pelo header `CF-Connecting-IP` — que só é confiável
> porque o Cloudflare o sobrescreve em toda request. Por dentro do domínio da
> Railway esse header volta a ser forjável e os limites viram decoração.
> Se um dia a URL vazar, o caminho é ativar Authenticated Origin Pulls no
> Cloudflare e recusar no Express o que não vier dele.

## 6. Primeiro acesso

- Acesse o domínio.
- Login com `admin` / a senha que você colocou em `ADMIN_INITIAL_PASSWORD`.
- Vá em **Administração → Contas** e crie professores e alunos da associação.
- Cada aluno deve ser vinculado a um professor.
- Entre em Perfil e troque a senha do admin.

## 7. E-mail transacional (Microsoft 365 / Graph API)

O app manda quatro tipos de e-mail: **confirmação de cadastro**, **redefinição de
senha**, **confirmação de troca de e-mail** e **avisos de segurança da conta**
(senha alterada, alguém pediu troca de e-mail).

Sem as variáveis configuradas nada quebra: o servidor loga o link no stdout e
segue. Mas o cadastro público fica inútil — ninguém consegue confirmar — então
configure antes de abrir.

### Por que Graph e não SMTP

A Microsoft está aposentando a autenticação básica no SMTP AUTH do Exchange
Online: rejeição gradual desde 01/03/2026, conclusão em 30/04/2026, prazo final
de tenant até dezembro de 2026. Configurar SMTP com senha hoje é configurar algo
que já está sendo desligado. O Graph usa OAuth (client credentials) e é só um
POST HTTPS — **nenhuma dependência npm nova**, o que também casa com a
quarentena do `.npmrc`.

### ⚠️ Antes de tudo: o Exchange Online não é serviço de e-mail em massa

O limite é ~10.000 destinatários/dia e 30 mensagens/minuto, e os termos da
Microsoft não cobrem marketing em massa. Traduzindo:

| E-mail                                       | Pode sair pelo M365? |
|----------------------------------------------|----------------------|
| Confirmação de cadastro                      | ✅ sim               |
| Redefinição de senha / avisos de segurança   | ✅ sim               |
| Newsletter do all_OS / da Associação Allos   | ❌ **não**           |

Os dois checkboxes de newsletter do cadastro **apenas registram o consentimento**
(campos `updateAllOS` e `updateAllos` do usuário, com data e versão dos termos).
Nenhum disparo acontece hoje. Quando for disparar, use plataforma própria de
marketing (Brevo, Mailchimp, Resend): mandar newsletter pela caixa que também
carrega o e-mail real da equipe põe em risco a reputação do domínio.

### Passo a passo

**1. Criar a caixa remetente**

Em `admin.microsoft.com`, crie `naoresponda@allos.org.br`. Pode ser **caixa
compartilhada** (Teams & groups → Shared mailboxes), que **não consome licença** —
importante no grant non-profit, onde as licenças são contadas.

**2. Registrar o app no Entra ID**

1. `entra.microsoft.com` → **Identity → Applications → App registrations** → **New registration**.
2. Nome: `all_OS — e-mail transacional`. Tipo: *Accounts in this organizational directory only*. **Sem** Redirect URI (não há login de usuário aqui).
3. Guarde da tela **Overview**:
   - **Application (client) ID** → `GRAPH_CLIENT_ID`
   - **Directory (tenant) ID** → `GRAPH_TENANT_ID`

**3. Criar a credencial — certificado, não segredo**

> ⚠️ Se aparecer **"Os segredos do cliente são bloqueados por uma política para
> todo o locatário"**, isso é esperado — inclusive para quem é administrador. A
> política de gerenciamento de aplicativos do Entra (`passwordAddition`) bloqueia
> a *ação*, não é falta de permissão. A Microsoft está distribuindo isso como
> padrão. **Não lute contra: use certificado**, que é para onde a política
> empurra e é a opção mais segura de qualquer forma.

Certificado é melhor que segredo aqui: a chave privada nunca sai do servidor, não
existe segredo compartilhado para vazar em log, e a validade é você quem escolhe.

Gere o par (chave privada + certificado público):

```bash
mkdir -p .certs && chmod 700 .certs
openssl req -x509 -newkey rsa:2048 -sha256 -days 1095 -nodes \
  -keyout .certs/allos-email-key.pem \
  -out    .certs/allos-email-cert.cer \
  -subj "/CN=all_OS email transacional/O=Associacao Allos"
chmod 600 .certs/allos-email-key.pem

# O thumbprint que vai no .env:
openssl x509 -in .certs/allos-email-cert.cer -noout -fingerprint -sha1 | sed 's/.*=//; s/://g'
```

`.certs/` está no `.gitignore` — **a chave privada nunca vai para o git.**

No portal: **Certificados e segredos** → aba **Certificados** → **Carregar
certificado** → escolha `.certs/allos-email-cert.cer` (só o `.cer`; a chave
privada fica com você). O portal mostra a **impressão digital** — confira que
bate com a do comando acima.

Configure:

| Onde | Variável |
|---|---|
| Local (dev) | `GRAPH_CERT_KEY_FILE=.certs/allos-email-key.pem` — aponta pro arquivo, sem colar PEM no `.env` |
| Railway | `GRAPH_CERT_PRIVATE_KEY` = a chave em **base64, uma linha só** |
| Ambos | `GRAPH_CERT_THUMBPRINT` = o hex do comando acima |

**A chave privada tem que existir nos dois lugares** — na sua máquina (para
desenvolver e testar) e no Railway (para produção). O que nunca acontece é ela
entrar no git: `.certs/` está no `.gitignore`, e no Railway ela vive no cofre de
variáveis, igual ao `JWT_SECRET` e às chaves de IA que já estão lá.

Para gerar as variáveis de produção já no formato certo:

```bash
node scripts/testar-email.js --railway
```

Ele imprime tudo pronto para colar em **Railway → Variables**, com a chave em
**base64 numa linha só**. Use esse formato: PEM multilinha é o que mais quebra em
painel web — a interface come as quebras de linha (ou escapa em `\n`) e o erro só
aparece depois, como `error:0909006C` sem explicação. O servidor aceita PEM cru,
PEM escapado e base64, mas só o base64 não tem como estragar no copiar/colar.

> ⚠️ **Não** defina `GRAPH_CERT_KEY_FILE` no Railway: lá o arquivo não existe, e se
> a variável estiver presente o servidor tenta ler o arquivo e ignora o base64.

> 📅 **Anote a data de expiração num calendário.** Quando o certificado vencer, os
> e-mails param e o sintoma no log é `Graph token 401`. Renovar = gerar outro par,
> subir o novo `.cer` (dá para ter dois válidos ao mesmo tempo) e trocar as duas
> variáveis.

> Se a política do tenant também recusar o certificado, ela está limitando a
> **validade** das chaves. Gere de novo com `-days 365` (ou o teto que a mensagem
> indicar) e suba outra vez.

<details>
<summary>Se você preferir liberar client secret no tenant (não recomendado)</summary>

Em `entra.microsoft.com` → **Identidade → Aplicativos → Registros de aplicativo →
Políticas de aplicativo**, dá para desligar a política padrão ou criar uma
política customizada isentando este app. Só que aí você reabre para o tenant
inteiro (ou passa a manter uma exceção) um controle que existe por bom motivo, e
ainda fica com um segredo que expira em no máximo 24 meses. O certificado resolve
o mesmo problema sem nenhuma das duas desvantagens.

</details>

**4. Dar a permissão**

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Application permissions** (não *Delegated*: não há usuário logado) → marque
**`Mail.Send`** → **Add permissions**.

Depois clique em **Grant admin consent for &lt;sua organização&gt;**. Sem esse
clique a permissão fica "Not granted" e o envio falha com 403.

**5. 🔒 Trancar a permissão numa caixa só**

Este passo não habilita nada — o envio já funciona sem ele. Ele reduz o estrago
**se a chave privada vazar**: sem ele, quem tiver a chave manda e-mail como
**qualquer pessoa da organização**, porque `Mail.Send` de aplicativo é concedido
para o locatário inteiro e a caixa é escolhida na URL da chamada, não na
permissão. Faça antes de divulgar o cadastro.

> ⚠️ Use **RBAC para Aplicativos**, não `New-ApplicationAccessPolicy`. A
> Microsoft marcou as Application Access Policies como **legado** e pede para não
> criar novas — elas exigirão migração. O caminho abaixo é o atual.

**5.1 — Instalar o PowerShell** (não há interface gráfica para isto; a Microsoft
não expõe RBAC para Aplicativos no Centro de administração do Exchange):

```bash
sudo snap install powershell --classic       # Ubuntu/Zorin
pwsh
```

Dentro do `pwsh`:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force
# No Linux não há navegador embutido: -Device mostra um código para você
# confirmar o login em microsoft.com/devicelogin no celular ou noutra aba.
Connect-ExchangeOnline -UserPrincipalName voce@allos.org.br -Device
```

**5.2 — Pegar o Object ID do *service principal*.** Este é o erro mais comum do
passo: **não** é o Object ID da página *Registros de aplicativo*.

`entra.microsoft.com` → **Aplicativos empresariais** (Enterprise applications) →
abra o seu app → copie o **ID do objeto** dessa página.

**5.3 — Criar o ponteiro, o escopo e a atribuição:**

```powershell
# Ponteiro do Exchange para o service principal do Entra.
# -AppId    = ID do aplicativo (cliente)
# -ObjectId = ID do objeto da pagina APLICATIVOS EMPRESARIAIS (passo 5.2)
New-ServicePrincipal -AppId <APP_ID> -ObjectId <OBJECT_ID_DO_SERVICE_PRINCIPAL> `
  -DisplayName "all_OS email transacional"

# Escopo: exatamente uma caixa.
New-ManagementScope -Name "allOS-caixa-naoresponda" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'naoresponda@allos.org.br'"

# Permissao de envio, restrita ao escopo acima.
New-ManagementRoleAssignment -Name "allOS-MailSend" `
  -App <OBJECT_ID_DO_SERVICE_PRINCIPAL> `
  -Role "Application Mail.Send" `
  -CustomResourceScope "allOS-caixa-naoresponda"
```

**5.4 — ⚠️ REMOVER o consentimento do `Mail.Send` no Entra.** Sem isto, o passo
anterior **não surte efeito nenhum**: as permissões do Entra e do Exchange são
somadas (união), então um `Mail.Send` sem escopo no Entra continua valendo para
todas as caixas, e o escopo do Exchange não restringe nada.

No portal: registro do app → **Permissões de API** → linha `Mail.Send` → **⋯** →
**Revogar consentimento do administrador**, e depois **Remover permissão**.

A partir daqui a permissão passa a viver **só no Exchange**, com escopo. É
esperado que o token do app deixe de trazer `Mail.Send` na lista de `roles` — o
`scripts/testar-email.js` já sabe disso e não trata como erro.

**5.5 — Conferir:**

```powershell
# Na caixa permitida → InScope True
Test-ServicePrincipalAuthorization -Identity <APP_ID> -Resource naoresponda@allos.org.br | Format-Table

# Em qualquer outra caixa → InScope False  (é o que queremos)
Test-ServicePrincipalAuthorization -Identity <APP_ID> -Resource voce@allos.org.br | Format-Table
```

`InScope False` na segunda linha é a prova de que o app perdeu a chave-mestra.

> ⏱️ O Exchange guarda permissão de app em cache de **30 min a 2 h**. Depois de
> mudar, o envio pode continuar se comportando como antes por esse tempo. O
> `Test-ServicePrincipalAuthorization` **ignora o cache** — é por ele que você
> confere, não pelo comportamento do envio.

<details>
<summary>Caminho legado (Application Access Policy) — só para referência</summary>

Ainda funciona e é mais curto, mas a Microsoft pede para não criar novas e
avisará a descontinuação:

```powershell
New-DistributionGroup -Name "AllOS App Mail Senders" -Alias allos-app-senders `
  -Type Security -Members naoresponda@allos.org.br
New-ApplicationAccessPolicy -AppId <APP_ID> `
  -PolicyScopeGroupId allos-app-senders@allos.org.br `
  -AccessRight RestrictAccess -Description "all_OS: envia so pela caixa naoresponda"
Test-ApplicationAccessPolicy -Identity voce@allos.org.br -AppId <APP_ID>
```

Diferença importante: a Application Access Policy **restringe** a permissão do
Entra, então aqui o consentimento do `Mail.Send` no Entra **deve permanecer**.

</details>

**6. Configurar as variáveis** (Railway → Variables)

```
GRAPH_TENANT_ID=<ID do diretório (locatário)>
GRAPH_CLIENT_ID=<ID do aplicativo (cliente)>
GRAPH_CERT_PRIVATE_KEY=<conteúdo do .certs/allos-email-key.pem>
GRAPH_CERT_THUMBPRINT=<impressão digital do certificado, hex sem os dois-pontos>
MAIL_FROM=naoresponda@allos.org.br
APP_BASE_URL=https://treinamento.allos.org.br
```

Valide tudo antes de subir, com o diagnóstico em camadas:

```bash
node scripts/testar-email.js                      # para antes de enviar
node scripts/testar-email.js voce@allos.org.br    # envia de verdade
```

**7. Conferir**

No log do startup deve aparecer:

```
[startup] MAIL_FROM = set (28 chars) → e-mail ATIVO
```

Depois teste com "Esqueci minha senha" usando um e-mail já cadastrado. Se falhar,
o log diz o motivo:

| No log                                | Causa provável                                        |
|---------------------------------------|-------------------------------------------------------|
| `Graph token 401`                     | certificado errado/expirado, ou thumbprint que não bate com o `.cer` enviado |
| `AADSTS700027`                        | o thumbprint não corresponde a nenhum certificado do app |
| `Graph sendMail 403 ... AccessDenied` | falta o *Grant admin consent*, ou o `MAIL_FROM` está fora do grupo da access policy |
| `Graph sendMail 404`                  | `MAIL_FROM` não existe / grafado errado               |
| `e-mail DESLIGADO` no startup         | falta alguma das quatro variáveis                     |

### SPF, DKIM e DMARC

Se `allos.org.br` já está no Microsoft 365, SPF e DKIM provavelmente já estão
publicados. Confira o DKIM em `security.microsoft.com` → Email & collaboration →
Policies → **DKIM**, e veja se existe registro DMARC no DNS. Sem isso, e-mail
transacional cai em spam com facilidade — e o sintoma chega até você como "o
aluno não recebeu o link".

## 8. Captcha do cadastro (Cloudflare Turnstile)

Sem as chaves o servidor **pula** a verificação (o cadastro funciona, só sem
captcha) e o startup avisa `captcha DESLIGADO`. Configure antes de divulgar o
link do cadastro.

1. Painel do Cloudflare → **Turnstile** → **Add widget**.
2. Nome: `all_OS cadastro`. Em **Domains**, adicione o domínio do app (e
   `localhost` se quiser testar local). Widget mode: **Managed**.
3. **Site Key** → `TURNSTILE_SITE_KEY`; **Secret Key** → `TURNSTILE_SECRET_KEY`.

É grátis e sem limite. A Site Key não é segredo (vai no HTML) e é entregue ao
cliente por `GET /api/config` — de propósito, para que trocar a chave não exija
rebuild do front.

> O CSP do app já libera `challenges.cloudflare.com` em `script-src`, `frame-src`
> e `connect-src` (ver o `helmet` em `server/index.js`). Se endurecer o CSP no
> futuro, mantenha as três: sem `frame-src` o iframe do desafio é bloqueado **sem
> erro visível na tela**, e o cadastro simplesmente não envia.

Se a verificação estiver ligada e o Cloudflare ficar fora do ar, o cadastro
**recusa** em vez de deixar passar (fail-closed): instabilidade do captcha não
deve virar janela aberta para registro em massa.

## 9. Abrindo o cadastro público de Aluno Externo

O papel `external` é o único que nasce sem admin — todos os outros continuam
exclusivos da tela de Contas. O portão não é o captcha nem o rate limit, é a
**confirmação por e-mail**: enquanto o link não é clicado, não existe usuário
nenhum, só uma pendência que vence em 48h.

Antes de divulgar `/cadastro`, confira:

- [ ] `APP_BASE_URL` setada com o domínio real (senão o link do e-mail não abre)
- [ ] e-mail **ATIVO** no log do startup (seção 7)
- [ ] captcha **ATIVO** no log do startup (seção 8)
- [ ] `TERMOS_URL` e `PRIVACIDADE_URL` publicadas — sem elas o aceite aparece
      como texto sem link, o que serve para testar mas não para produção
- [ ] um cadastro de teste feito ponta a ponta, com e-mail real

Depois de aberto, o que vale saber no dia a dia:

| Situação | Onde resolver |
|---|---|
| Fechar o cadastro às pressas | `CADASTRO_EXTERNO_ABERTO=false` (só a variável, sem deploy) |
| Ver quem se cadastrou e de onde veio | Administração → Contas → aba **Alunos Externos** (a origem fica no registro do usuário) |
| Dar supervisor a um aluno externo | Contas → editar → **Professor responsável** (é opcional nesse papel). A partir daí ele aparece na lista do professor e a Antessala dele é entregue a esse supervisor |
| Aluno não recebeu o e-mail | pede reenvio na própria tela de cadastro; o link antigo morre e sai um novo |

**Limites por hora, por IP** (salvo indicação): cadastro 10; reenvio do link e
"esqueci minha senha" 8; troca de e-mail 5 **por usuário**; confirmação de link e
consulta de nome de usuário 60 por 15 min; login 10 **falhas** por 15 min (acerto
não conta). Os contadores vivem em memória — um redeploy zera todos.

## Custos esperados (free tier)

- Railway: $5 de crédito/mês cobre um app pequeno como este (1 dyno + volume pequeno).
  Se passar, custa cêntimos por dia de uso real.
- Cloudflare: free.
- OpenAI: pay-as-you-go conforme uso.

## Backup recomendado

Como os dados ficam em JSON num volume Railway, considere periodicamente:

1. Acessar o serviço via Railway CLI: `railway run bash`.
2. `tar czf /tmp/backup.tar.gz /data && cat /tmp/backup.tar.gz | base64` (e copiar localmente).

Quando migrar para Postgres/SQLite, ponto único de mudança são as funções
`readJSON`/`writeJSON` em `server/index.js`.
