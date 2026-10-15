# Backup do Processo Seletivo → Google Drive

Os logs do Processo Seletivo (transcrição completa + avaliação de cada
candidato) ficam guardados **para sempre** no banco (`selecao_logs`, no Neon) —
não existe mais poda automática (§24.0 do `ESTADO.md`). Este Google Apps Script
mantém uma **cópia fora do banco**: uma vez por dia, busca os logs e salva cada
candidato novo como um `.txt` numa pasta do Drive da Allos.

O único prazo de 15 dias que sobrou no seletivo é o **bloqueio por WhatsApp**
(uma avaliação por número a cada 15 dias). Ele só lê os logs, não apaga nada, e
não tem relação com este backup.

- Fonte do backend: `GET /api/selecao/export-all` em `server/index.js`
  (protegido por um secret fixo no header `X-Export-Secret`, não por login —
  quem chama é um script agendado, sem sessão de usuário).
- Roda **fora deste repositório**, dentro da conta Google da Allos
  (diretoria@allos.org.br), em [script.google.com](https://script.google.com).
  O arquivo `backup-processo-seletivo.gs` aqui é só a fonte versionada — se
  mudar, copie o conteúdo de novo para lá.

## Situação atual (2026-10-15)

Instalado e rodando. O trigger diário roda por volta das 3h (horário de
Brasília) e grava na pasta `16Vq4VI_OkI_xcIujiphDZYSF56I6czWC`. O endpoint
continuou o mesmo na troca do JSON para o banco: o domínio de produção
(`treinamento.allos.org.br`) e a variável `SELECAO_EXPORT_SECRET` seguem
configurados no serviço `all_os` do Railway.

## Como funciona

1. O endpoint devolve **todos** os logs do banco, já formatados como texto
   (o mesmo formato do botão "Tudo" na tela de Logs do seletivo).
2. Cada log vira um arquivo com nome estável:
   `processo-seletivo-<nome>-<AAAA-MM-DD>-<últimos 8 do id>.txt`.
3. Se já existe um arquivo com esse nome na pasta, o script pula. Rodar de novo
   não duplica nada.

Consequências:

- **Dia sem arquivo novo é normal** quando ninguém fez o processo seletivo na
  véspera.
- Um log que mudar depois de salvo (por exemplo, uma avaliação em lote que
  terminou depois da corrida) **não** é regravado: o nome já existe. O banco
  continua sendo a fonte da verdade.
- Como os logs não expiram mais, a resposta do endpoint cresce com o histórico
  inteiro. Com ~140 candidatos são ~5 MB; o Apps Script aceita até 50 MB por
  resposta e 6 min por execução, então só vai ser problema perto de mil e
  poucos candidatos. Quando chegar lá, o caminho é o endpoint aceitar um filtro
  de data.

## Conferir se está funcionando

- Em script.google.com → projeto do backup → **Execuções**: cada dia deve ter
  uma execução de `runScheduledBackup` com status "Concluída". O log da
  execução diz quantos arquivos foram salvos e quantos já existiam.
- Se uma execução falhar, o script manda um e-mail
  **"Falha no backup do Processo Seletivo (Allos)"** para `NOTIFY_EMAIL` (ou,
  sem ela, para a conta dona do script).
- Teste rápido do endpoint, sem o secret: `curl https://treinamento.allos.org.br/api/selecao/export-all`
  - `401 Não autorizado` → endpoint ligado (o esperado).
  - `503` → `SELECAO_EXPORT_SECRET` não está configurado no Railway.

## Instalar do zero

Só é preciso se o projeto do Apps Script for perdido ou trocado de conta.

### 1. Backend

Gere um secret aleatório:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No Railway (projeto `all_os`, serviço `all_os`) → Variables:

```
SELECAO_EXPORT_SECRET=<o valor gerado acima>
```

Sem essa variável, `/api/selecao/export-all` responde `503` (desligado).

### 2. Criar o Apps Script

1. Acesse [script.google.com](https://script.google.com) **com a conta Google
   da Allos** (a mesma dona da pasta do Drive).
2. **Novo projeto** → renomeie para algo como "Backup Processo Seletivo".
3. Apague o conteúdo padrão de `Código.gs` e cole o conteúdo de
   [`backup-processo-seletivo.gs`](./backup-processo-seletivo.gs).
4. Em **Configurações do projeto**, confira o fuso horário
   (`America/Sao_Paulo`): é nele que o trigger das 3h é contado.

### 3. Propriedades do script

**Configurações do projeto** (engrenagem) → **Propriedades do script** →
**Adicionar propriedade do script**, uma de cada vez:

| Propriedade | Valor |
|---|---|
| `EXPORT_URL` | `https://treinamento.allos.org.br/api/selecao/export-all` |
| `EXPORT_SECRET` | o mesmo valor de `SELECAO_EXPORT_SECRET` do Railway |
| `DRIVE_FOLDER_ID` | `16Vq4VI_OkI_xcIujiphDZYSF56I6czWC` (extraído do link da pasta) |
| `NOTIFY_EMAIL` *(opcional)* | quem recebe o aviso de falha. Sem ela, vai para a conta que autorizou o script |

### 4. Autorizar e instalar o trigger diário

1. No seletor de função (barra de cima, ao lado de ▶ Executar), escolha
   **installDailyTrigger** e clique em ▶ **Executar**.
2. Na primeira vez o Google pede autorização para Drive e Gmail. É a própria
   conta autorizando o próprio script, então aparece o aviso padrão de "app não
   verificado": **Avançado → Acessar [projeto] (não seguro)**.
3. Em **Gatilhos** (ícone de relógio) deve aparecer `runScheduledBackup`,
   "Baseado em tempo", todo dia por volta das 3h.

Rodar `installDailyTrigger` de novo é seguro: apaga o trigger antigo antes de
criar o novo.

Para testar na hora: escolha **runScheduledBackup** e ▶ Executar. O resultado
aparece em **Execuções**.

## Trocar o secret

Se trocar `SELECAO_EXPORT_SECRET` no Railway, atualize também a propriedade
`EXPORT_SECRET` no Apps Script. Os dois lados precisam bater; senão cada corrida
recebe `401` e dispara o e-mail de falha.
