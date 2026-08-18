# Backup do Processo Seletivo → Google Drive

Os logs do Processo Seletivo (transcrição completa + avaliação de cada
candidato) duram só **15 dias** no servidor (`SELECTION_LOG_TTL_DAYS`) antes de
serem apagados automaticamente. Este Google Apps Script busca todos os logs
ainda vivos e salva cada um como um `.txt` numa pasta do Drive da Allos, para
existir um backup permanente antes da expiração.

- Fonte do backend: `GET /api/selecao/export-all` em `server/index.js`
  (protegido por um secret fixo no header `X-Export-Secret`, não por login —
  quem chama é um script agendado, sem sessão de usuário).
- Roda **fora deste repositório**, dentro da conta Google da Allos, em
  [script.google.com](https://script.google.com). O arquivo `backup-processo-seletivo.gs`
  aqui é só a fonte versionada — copie o conteúdo pra lá.

## 1. Configurar o backend

Gere um secret aleatório:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No Railway → Variables, adicione:

```
SELECAO_EXPORT_SECRET=<o valor gerado acima>
```

Sem essa variável configurada, `/api/selecao/export-all` responde `503`
(desligado por padrão — nada muda até você configurar).

## 2. Criar o Apps Script

1. Acesse [script.google.com](https://script.google.com) **com a conta Google
   da Allos** (a mesma dona da pasta do Drive).
2. **Novo projeto** → renomeie para algo como "Backup Processo Seletivo".
3. Apague o conteúdo padrão de `Código.gs` e cole o conteúdo de
   [`backup-processo-seletivo.gs`](./backup-processo-seletivo.gs).

## 3. Configurar as propriedades do script

No editor: **Configurações do projeto** (ícone de engrenagem) → **Propriedades
do script** → **Adicionar propriedade do script**, uma de cada vez:

| Propriedade | Valor |
|---|---|
| `EXPORT_URL` | `https://SEU-DOMINIO/api/selecao/export-all` (o domínio público de produção — **não** a URL crua `*.up.railway.app`, ver nota de segurança no `DEPLOY.md`) |
| `EXPORT_SECRET` | o mesmo valor de `SELECAO_EXPORT_SECRET` que você configurou no Railway |
| `DRIVE_FOLDER_ID` | `16Vq4VI_OkI_xcIujiphDZYSF56I6czWC` (extraído do link da pasta) |
| `NOTIFY_EMAIL` *(opcional)* | e-mail que deve receber um aviso se o backup falhar. Se omitir, usa o e-mail da conta que autorizou o script |

## 4. Autorizar e instalar o trigger diário

1. No editor, no seletor de função (barra de cima, ao lado de ▶ Executar),
   escolha **installDailyTrigger**.
2. Clique em ▶ **Executar**. Na primeira vez o Google vai pedir autorização —
   aceite os escopos de Drive e Gmail (é a sua própria conta autorizando o
   próprio script, então mostra o aviso padrão de "app não verificado"; pode
   prosseguir com segurança, com **Avançado → Acessar [projeto] (não
   seguro)**).
3. Confira em **Gatilhos** (ícone de relógio na barra lateral): deve aparecer
   `runScheduledBackup`, tipo "Baseado em tempo", rodando todo dia por volta
   das 3h.

Pronto — o script já roda sozinho todo dia, salvando um `.txt` por candidato
na pasta do Drive, pulando quem já foi salvo antes (idempotente).

## Testar manualmente

A qualquer momento, escolha **runScheduledBackup** no seletor de função e
clique ▶ Executar. Veja o resultado em **Execuções** (histórico) ou
**Ver → Logs**.

## Trocar o secret depois

Se precisar trocar `SELECAO_EXPORT_SECRET` no Railway, atualize também a
propriedade `EXPORT_SECRET` no Apps Script (Configurações do projeto →
Propriedades do script) — os dois lados precisam bater.
