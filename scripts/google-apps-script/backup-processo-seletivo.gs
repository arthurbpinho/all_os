/**
 * Backup do Processo Seletivo — Allos
 * ------------------------------------
 * Os logs do Processo Seletivo (transcrição completa + avaliação de cada
 * candidato) vivem só 15 dias no servidor (SELECTION_LOG_TTL_DAYS, em
 * server/index.js) antes de serem apagados. Este script busca todos os logs
 * ainda vivos em GET /api/selecao/export-all e salva cada um como um .txt na
 * pasta do Drive configurada abaixo — assim nada se perde quando o TTL expira.
 *
 * Não roda dentro do repo (Apps Script vive no navegador, em script.google.com);
 * este arquivo é só a fonte versionada. Ver README.md nesta mesma pasta para o
 * passo a passo de instalação.
 *
 * Idempotente: cada candidato vira 1 arquivo com nome estável (inclui o id do
 * log); antes de criar, o script checa se aquele nome já existe na pasta e
 * pula se sim — rodar de novo no mesmo dia (ou reprocessar) não duplica nada.
 */

function backupProcessoSeletivo() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('EXPORT_URL');
  var secret = props.getProperty('EXPORT_SECRET');
  var folderId = props.getProperty('DRIVE_FOLDER_ID');

  if (!url || !secret || !folderId) {
    throw new Error(
      'Configure EXPORT_URL, EXPORT_SECRET e DRIVE_FOLDER_ID em ' +
      'Configurações do projeto > Propriedades do script.'
    );
  }

  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-Export-Secret': secret },
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error(
      'Falha ao buscar logs (HTTP ' + code + '): ' +
      response.getContentText().slice(0, 500)
    );
  }

  var data = JSON.parse(response.getContentText());
  var logs = data.logs || [];
  var folder = DriveApp.getFolderById(folderId);

  var saved = 0;
  var skipped = 0;
  logs.forEach(function (item) {
    // Já existe um arquivo com esse nome nesta pasta? Pula (idempotência).
    if (folder.getFilesByName(item.filename).hasNext()) {
      skipped++;
      return;
    }
    folder.createFile(item.filename, item.content, MimeType.PLAIN_TEXT);
    saved++;
  });

  return 'Backup Processo Seletivo: ' + saved + ' novo(s) salvo(s), ' +
    skipped + ' já existiam (de ' + logs.length + ' recebidos no total).';
}

/**
 * Empacota a chamada acima com notificação por e-mail em caso de falha —
 * é essa função (não a de cima) que o trigger diário deve chamar, pra alguém
 * ficar sabendo se o backup parar de funcionar silenciosamente.
 */
function runScheduledBackup() {
  try {
    var summary = backupProcessoSeletivo();
    Logger.log(summary);
  } catch (err) {
    var props = PropertiesService.getScriptProperties();
    var to = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, 'Falha no backup do Processo Seletivo (Allos)', String(err));
    throw err;
  }
}

/**
 * Rodar ESTA função uma única vez, manualmente, pelo editor (menu ▶ Executar),
 * escolhendo runScheduledBackup no seletor de função. Isso: (1) pede a
 * autorização OAuth (acesso ao Drive/Gmail desta conta Google) e (2) instala
 * o trigger diário. Rodar de novo é seguro — remove o trigger antigo antes de
 * criar o novo, então nunca duplica.
 */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runScheduledBackup') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('runScheduledBackup')
    .timeBased()
    .everyDays(1)
    .atHour(3) // 03:00 no fuso configurado em Configurações do projeto > Fuso horário
    .create();
  Logger.log('Trigger diário instalado (todo dia por volta das 3h).');
}
