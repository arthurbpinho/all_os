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

Gerando o JWT_SECRET localmente:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
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

## 6. Primeiro acesso

- Acesse o domínio.
- Login com `admin` / a senha que você colocou em `ADMIN_INITIAL_PASSWORD`.
- Vá em **Administração → Contas** e crie professores e alunos da associação.
- Cada aluno deve ser vinculado a um professor.
- Entre em Perfil e troque a senha do admin.

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
