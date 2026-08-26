#requires -Version 7
<#
.SYNOPSIS
  Restringe a permissao Mail.Send do app all_OS a UMA caixa, via RBAC para
  Aplicativos do Exchange Online.

.DESCRIPTION
  Sem isto, quem tiver a chave privada do app manda e-mail como QUALQUER caixa da
  organizacao (Mail.Send de aplicativo vale pro locatario inteiro; a caixa e
  escolhida na URL da chamada, nao na permissao). Este script cria o escopo que
  reduz isso a uma caixa so.

  NAO usa New-ApplicationAccessPolicy: a Microsoft marcou como legado e pede pra
  nao criar novas.

  O script NAO revoga o consentimento no Entra — esse passo e no portal, e deve
  ser feito DEPOIS, quando o Test-ServicePrincipalAuthorization no fim daqui
  estiver dizendo InScope True. Enquanto o consentimento do Entra existir, as
  duas permissoes se SOMAM e o escopo nao restringe nada (FAQ da Microsoft).

.PARAMETER ServicePrincipalObjectId
  ID do objeto da pagina APLICATIVOS EMPRESARIAIS (Enterprise applications).
  ATENCAO: nao e o Object ID da pagina "Registros de aplicativo" — sao valores
  diferentes, e usar o errado faz New-ServicePrincipal falhar.

.EXAMPLE
  pwsh ./scripts/limitar-caixa-email.ps1 -ServicePrincipalObjectId 00000000-0000-0000-0000-000000000000
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$ServicePrincipalObjectId,

  # Por padrao le do .env da raiz, pra nao divergir da configuracao do servidor.
  [string]$AppId,
  [string]$Mailbox,
  [string]$AdminUpn,

  [string]$ScopeName = 'allOS-caixa-naoresponda',
  [string]$AssignmentName = 'allOS-MailSend',

  # Pula a criacao e so roda a verificacao (etapa 6).
  [switch]$SomenteVerificar
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Aviso($m){ Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Etapa($n, $m) { Write-Host "`n$n. $m" -ForegroundColor White }

# --- Le o .env da raiz do projeto ---
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$envMap = @{}
if (Test-Path $envPath) {
  foreach ($linha in Get-Content $envPath) {
    if ($linha -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
  }
}
if (-not $AppId)   { $AppId = $envMap['GRAPH_CLIENT_ID'] }
if (-not $Mailbox) { $Mailbox = $envMap['MAIL_FROM'] }

if (-not $AppId)   { throw "GRAPH_CLIENT_ID nao encontrado no .env — passe -AppId." }
if (-not $Mailbox) { throw "MAIL_FROM nao encontrado no .env — passe -Mailbox." }

Write-Host "`nRestringir Mail.Send a uma caixa — RBAC para Aplicativos" -ForegroundColor White
Info "AppId   : $AppId"
Info "Caixa   : $Mailbox"
Info "SPN Obj : $ServicePrincipalObjectId"

# --- 1. Modulo ---
Etapa 1 'Modulo ExchangeOnlineManagement'
if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Info 'instalando (primeira vez, pode levar um minuto)...'
  Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser -Force -AllowClobber
}
Import-Module ExchangeOnlineManagement
Ok 'disponivel'

# --- 2. Conectar ---
Etapa 2 'Conectar ao Exchange Online'
if (-not (Get-ConnectionInformation -ErrorAction SilentlyContinue)) {
  # -Device: no Linux nao ha navegador embutido. Aparece um codigo pra confirmar
  # o login em microsoft.com/devicelogin.
  if ($AdminUpn) { Connect-ExchangeOnline -UserPrincipalName $AdminUpn -Device -ShowBanner:$false }
  else           { Connect-ExchangeOnline -Device -ShowBanner:$false }
}
Ok ('conectado como ' + (Get-ConnectionInformation).UserPrincipalName)

if ($SomenteVerificar) {
  Info 'modo -SomenteVerificar: pulando criacao (etapas 3 a 5)'
} else {

# --- 3. Ponteiro do service principal ---
Etapa 3 'Ponteiro do service principal no Exchange'
$spn = Get-ServicePrincipal -Identity $AppId -ErrorAction SilentlyContinue
if ($spn) {
  Ok 'ja existia'
} else {
  $spn = New-ServicePrincipal -AppId $AppId -ObjectId $ServicePrincipalObjectId `
    -DisplayName 'all_OS email transacional'
  Ok 'criado'
}

# --- 4. Escopo de uma caixa ---
Etapa 4 "Escopo restrito a $Mailbox"
if (Get-ManagementScope -Identity $ScopeName -ErrorAction SilentlyContinue) {
  Ok "escopo '$ScopeName' ja existia"
} else {
  New-ManagementScope -Name $ScopeName `
    -RecipientRestrictionFilter "PrimarySmtpAddress -eq '$Mailbox'" | Out-Null
  Ok "escopo '$ScopeName' criado"
}

# --- 5. Atribuicao ---
Etapa 5 'Atribuicao Application Mail.Send dentro do escopo'
if (Get-ManagementRoleAssignment -Identity $AssignmentName -ErrorAction SilentlyContinue) {
  Ok "atribuicao '$AssignmentName' ja existia"
} else {
  New-ManagementRoleAssignment -Name $AssignmentName `
    -App $ServicePrincipalObjectId `
    -Role 'Application Mail.Send' `
    -CustomResourceScope $ScopeName | Out-Null
  Ok "atribuicao '$AssignmentName' criada"
}

} # fim do bloco de criacao (-SomenteVerificar)

# --- 6. Verificacao ---
# Este teste IGNORA o cache de permissao do Exchange (30 min a 2 h), entao e por
# ele que se confere — nao pelo comportamento do envio.
# Format-List e nao Format-Table: -AutoSize trunca em terminal estreito e come
# exatamente a coluna InScope, que e a unica que interessa aqui.
function Verificar($caixa, $esperado) {
  Write-Host "`n  $caixa" -ForegroundColor White
  $r = Test-ServicePrincipalAuthorization -Identity $AppId -Resource $caixa
  foreach ($linha in $r) {
    $cor = if ("$($linha.InScope)" -eq "$esperado") { 'Green' } else { 'Red' }
    Write-Host ("    {0,-24} escopo: {1,-26} InScope: {2}" -f `
      $linha.RoleName, $linha.AllowedResourceScope, $linha.InScope) -ForegroundColor $cor
  }
  if (-not $r) { Write-Host '    (nenhuma permissao atribuida)' -ForegroundColor DarkGray }
}

Etapa 6 'Verificacao'
Write-Host '  (verde = como esperado)' -ForegroundColor DarkGray
Write-Host "`n  PERMITIDA — deve dar InScope True:" -ForegroundColor White
Verificar $Mailbox $true

$outra = if ($AdminUpn) { $AdminUpn } else { (Get-ConnectionInformation).UserPrincipalName }
Write-Host "`n  QUALQUER OUTRA — deve dar InScope False:" -ForegroundColor White
Verificar $outra $false

Write-Host @"

Proximo passo (no portal, e SO agora):
  Revogar o consentimento do Mail.Send no Entra.
  Registro do app -> Permissoes de API -> linha Mail.Send -> ... ->
  Revogar consentimento do administrador, depois Remover permissao.

  Enquanto esse consentimento existir, o Entra e o Exchange SOMAM permissoes e
  o escopo acima nao restringe nada.

Depois, confirme que o envio continua funcionando:
  node scripts/testar-email.js seu-email@exemplo.com

"@ -ForegroundColor Cyan
