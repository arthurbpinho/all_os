#!/usr/bin/env node
// Diagnóstico da configuração de e-mail (Microsoft 365 / Graph API).
//
// Testa em CAMADAS, parando na primeira que falha, pra você saber exatamente
// qual passo do DEPLOY.md (seção 7) errou — em vez de só ver "não chegou".
//
//   1. as variáveis estão setadas?
//   2. o app consegue pegar token?              → segredo / tenant / client id
//   3. a caixa remetente existe e é alcançável? → Mail.Send + admin consent
//   4. a access policy está trancada?           → passo 5 (o que mais se pula)
//   5. o e-mail sai de verdade?                 → envio real
//
// Uso (lê o .env da raiz automaticamente):
//   node scripts/testar-email.js
//   node scripts/testar-email.js voce@allos.org.br   # envia teste real
//   node scripts/testar-email.js --railway https://treinamento.allos.org.br
//                                                    # imprime as vars de producao
//
// Sem destinatário, para no passo 4 e não manda nada.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Reaproveita o próprio módulo do servidor pra montar o token: assim o teste
// exercita EXATAMENTE o código que roda em produção, em vez de uma segunda
// implementação que pode divergir.
const mailer = require('../server/email');

const TENANT = process.env.GRAPH_TENANT_ID || '';
const CLIENT = process.env.GRAPH_CLIENT_ID || '';
const FROM = process.env.MAIL_FROM || '';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const falha = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);
const passo = (n, m) => console.log(`\n\x1b[1m${n}. ${m}\x1b[0m`);

function morre(dica) {
  console.log(`\n\x1b[31mParou aqui.\x1b[0m ${dica}\n`);
  process.exit(1);
}

// Imprime as variáveis prontas pra colar no painel do Railway. A chave privada
// sai em BASE64 numa linha só: PEM multilinha é o que mais quebra em painel web
// (a UI come as quebras, ou escapa em "\\n", e o crypto recusa depois com um erro
// que não diz nada). O servidor aceita os dois, mas o base64 não tem como dar
// errado no copiar/colar.
function imprimirParaRailway(baseUrlProd) {
  const fs = require('fs');
  const path = require('path');
  const arquivo = process.env.GRAPH_CERT_KEY_FILE
    ? path.resolve(__dirname, '..', process.env.GRAPH_CERT_KEY_FILE)
    : null;
  if (!arquivo || !fs.existsSync(arquivo)) {
    console.log('\n\x1b[31mNão achei a chave privada.\x1b[0m Defina GRAPH_CERT_KEY_FILE no .env apontando pro .pem.\n');
    process.exit(1);
  }
  const b64 = Buffer.from(fs.readFileSync(arquivo, 'utf-8')).toString('base64');

  // O APP_BASE_URL de produção é DIFERENTE do local: em dev ele é localhost, e
  // copiar isso pro Railway faria os links dos e-mails apontarem pro localhost
  // do aluno. É a variável mais fácil de errar no deploy, então ela é exigida
  // explicitamente em vez de herdada do .env.
  const doEnv = process.env.APP_BASE_URL || '';
  let base = baseUrlProd || '';
  if (!base) {
    if (/localhost|127\.0\.0\.1/.test(doEnv) || !doEnv) {
      console.log('\n\x1b[31mFalta a URL de produção.\x1b[0m O APP_BASE_URL do .env é de');
      console.log('desenvolvimento (' + (doEnv || 'vazio') + ') e não serve no Railway.\n');
      console.log('  node scripts/testar-email.js --railway https://treinamento.allos.org.br\n');
      process.exit(1);
    }
    base = doEnv;
  }
  if (!/^https:\/\//.test(base)) {
    console.log(`\n\x1b[31mA URL de produção precisa começar com https://\x1b[0m (recebi "${base}")\n`);
    process.exit(1);
  }
  base = base.replace(/\/+$/, '');

  // Formato de bloco colável de uma vez no Raw Editor do Railway, em vez de
  // variável por variável — são muitas, e a chave em base64 é longa demais pra
  // copiar à mão sem erro.
  console.log('\n\x1b[1mRailway → Variables → Raw Editor → cole o bloco abaixo\x1b[0m');
  console.log('\x1b[2m(só o que este trabalho adicionou; o resto do app já está lá)\x1b[0m');
  console.log('\x1b[2m' + '─'.repeat(64) + '\x1b[0m');

  const faltando = [];
  const linha = (nome, valor) => {
    if (!valor) faltando.push(nome);
    console.log(`${nome}=${valor || ''}`);
  };

  linha('GRAPH_TENANT_ID', process.env.GRAPH_TENANT_ID);
  linha('GRAPH_CLIENT_ID', process.env.GRAPH_CLIENT_ID);
  linha('GRAPH_CERT_THUMBPRINT', process.env.GRAPH_CERT_THUMBPRINT);
  linha('MAIL_FROM', process.env.MAIL_FROM);
  linha('TURNSTILE_SITE_KEY', process.env.TURNSTILE_SITE_KEY);
  linha('TURNSTILE_SECRET_KEY', process.env.TURNSTILE_SECRET_KEY);
  console.log(`APP_BASE_URL=${base}`);
  console.log(`TERMOS_VERSAO=${process.env.TERMOS_VERSAO || '1'}`);
  console.log('CADASTRO_EXTERNO_ABERTO=true');
  // Vazias de propósito: sem elas o aceite do cadastro aparece sem link, o que
  // é melhor que um link quebrado. Preencher quando os documentos existirem.
  console.log('TERMOS_URL=');
  console.log('PRIVACIDADE_URL=');
  console.log(`GRAPH_CERT_PRIVATE_KEY=${b64}`);
  console.log('\x1b[2m' + '─'.repeat(64) + '\x1b[0m');
  if (faltando.length) {
    console.log(`\n\x1b[31mVAZIAS no .env: ${faltando.join(', ')}\x1b[0m`);
  }
  console.log('\n\x1b[2mNÃO defina GRAPH_CERT_KEY_FILE no Railway — lá não existe o arquivo,');
  console.log('e se ela estiver setada o servidor tenta o arquivo e ignora o base64.');
  console.log('');
  console.log('JWT_SECRET: NÃO reaproveite o do .env. Gere um só pra produção com');
  console.log('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.log(`Confira também que ${base.replace('https://', '')} está nos hostnames do widget Turnstile.\x1b[0m\n`);
}

async function main() {
  if (process.argv.includes('--railway')) {
    const i = process.argv.indexOf('--railway');
    return imprimirParaRailway(process.argv[i + 1]);
  }
  const destino = process.argv[2];
  console.log('\n\x1b[1mDiagnóstico de e-mail — Microsoft 365 / Graph\x1b[0m');

  // --- 1. Variáveis ---
  passo(1, 'Variáveis de ambiente');
  const faltando = [];
  for (const [nome, valor] of [
    ['GRAPH_TENANT_ID', TENANT], ['GRAPH_CLIENT_ID', CLIENT], ['MAIL_FROM', FROM],
  ]) {
    if (!valor) { falha(`${nome} — não setada`); faltando.push(nome); }
    else ok(`${nome} = ${valor}`);
  }

  // Credencial: certificado (preferido, e obrigatório em tenant que bloqueia
  // client secret) ou segredo.
  const modo = mailer.modoCredencial();
  if (modo === 'certificado') {
    ok(`credencial = certificado (thumbprint ${(process.env.GRAPH_CERT_THUMBPRINT || '').slice(0, 12)}…)`);
  } else if (modo === 'segredo') {
    ok(`credencial = client secret (${(process.env.GRAPH_CLIENT_SECRET || '').length} chars)`);
    info('nota: muitos tenants bloqueiam segredo por política. Certificado é o caminho preferido.');
  } else {
    falha('credencial = NENHUMA');
    info('certificado: GRAPH_CERT_KEY_FILE (ou GRAPH_CERT_PRIVATE_KEY) + GRAPH_CERT_THUMBPRINT');
    info('ou segredo:  GRAPH_CLIENT_SECRET');
    faltando.push('credencial do app');
  }
  if (!process.env.APP_BASE_URL) {
    falha('APP_BASE_URL — não setada (os links do e-mail sairiam relativos e não abririam)');
  } else ok(`APP_BASE_URL = ${process.env.APP_BASE_URL}`);
  if (faltando.length) morre(`Preencha ${faltando.join(', ')} no .env — DEPLOY.md seção 7, passo 6.`);

  // Erro de digitação clássico: colar o "Object ID" no lugar do "Application
  // (client) ID", ou o nome do tenant no lugar do GUID.
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!GUID.test(TENANT)) info('aviso: GRAPH_TENANT_ID não parece um GUID (pode ser o domínio, que também funciona)');
  if (!GUID.test(CLIENT)) falha('GRAPH_CLIENT_ID não é um GUID — confira se você copiou o "Application (client) ID"');

  // --- 2. Token ---
  passo(2, `Token de aplicação (client credentials via ${modo})`);
  let token;
  {
    const url = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: CLIENT,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    if (modo === 'certificado') {
      body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      body.set('client_assertion', mailer.montarClientAssertion(url));
    } else {
      body.set('client_secret', process.env.GRAPH_CLIENT_SECRET);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const corpo = await res.text();
    if (!res.ok) {
      falha(`HTTP ${res.status}`);
      info(corpo.slice(0, 500));
      if (corpo.includes('AADSTS7000215')) morre('Segredo inválido. Gere outro em Certificates & secrets e copie o **Value** (não o Secret ID).');
      if (corpo.includes('AADSTS700016')) morre('Client ID não existe neste tenant. Confira GRAPH_CLIENT_ID e GRAPH_TENANT_ID.');
      if (corpo.includes('AADSTS90002')) morre('Tenant não encontrado. Confira GRAPH_TENANT_ID.');
      if (corpo.includes('AADSTS7000222')) morre('O segredo EXPIROU. Crie um novo em Certificates & secrets.');
      if (corpo.includes('AADSTS700027')) morre('O certificado não confere. Você subiu o .cer certo no portal? O GRAPH_CERT_THUMBPRINT tem que ser o do MESMO certificado.');
      if (corpo.includes('AADSTS700016') || corpo.includes('AADSTS50012')) morre('Credencial não reconhecida — confira se o certificado foi enviado em Certificados e segredos → Certificados.');
      morre('Veja o código AADSTS acima — DEPLOY.md seção 7, passos 2 e 3.');
    }
    token = JSON.parse(corpo).access_token;
    ok('token obtido');

    // Os escopos concedidos vêm dentro do próprio token — dá pra conferir a
    // permissão ANTES de tentar enviar, e dizer com precisão o que falta.
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      const papeis = claims.roles || [];
      if (papeis.includes('Mail.Send')) {
        ok('permissão Mail.Send presente no token (consentida no Entra, SEM escopo de caixa)');
      } else {
        // NÃO é falha fatal: com RBAC para Aplicativos a permissão vive no
        // Exchange, não no Entra, e o token sai sem `roles` mesmo estando tudo
        // certo — nesse caso o escopo de caixa é justamente o que faz o envio
        // funcionar só pela caixa permitida. Quem decide é o envio real.
        info(`Mail.Send não está no token. Permissões no token: ${papeis.length ? papeis.join(', ') : '(nenhuma)'}`);
        info('Dois cenários possíveis, e o envio (passo 5) distingue:');
        info('  a) RBAC para Aplicativos configurado → normal, é assim que deve ficar');
        info('  b) permissão não concedida / delegada por engano → o envio dará 403');
      }
    } catch { info('(não consegui ler os claims do token — seguindo)'); }
  }

  const graph = (caminho, opcoes = {}) => fetch(`https://graph.microsoft.com/v1.0${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
  });

  // --- 3. Caixa remetente ---
  //
  // Ler o objeto de usuário no diretório exige User.Read.All, que o app NÃO tem
  // — e não deve ter: ele só precisa de Mail.Send. Então o 403 aqui é o
  // resultado ESPERADO e é sinal de menor privilégio funcionando, não de erro.
  // Quem valida a existência da caixa de verdade é o envio (passo 5).
  passo(3, `Caixa remetente (${FROM})`);
  let podeLerDiretorio = false;
  {
    const res = await graph(`/users/${encodeURIComponent(FROM)}?$select=displayName,mail,userPrincipalName`);
    if (res.status === 403) {
      ok('sem acesso ao diretório — esperado (o app só tem Mail.Send)');
      info('a existência da caixa é confirmada pelo envio real, no passo 5');
    } else if (res.status === 404) {
      falha('a caixa não existe');
      morre(`Nenhuma caixa "${FROM}" no tenant. Confira a grafia, ou crie a caixa compartilhada — DEPLOY.md seção 7, passo 1.`);
    } else if (res.ok) {
      const u = await res.json();
      podeLerDiretorio = true;
      ok(`encontrada: ${u.displayName} <${u.mail || u.userPrincipalName}>`);
      info('nota: o app consegue LER o diretório, então tem mais permissão que os');
      info('      Mail.Send de que precisa. Vale revisar em Permissões de API.');
    } else {
      falha(`HTTP ${res.status}`);
      info((await res.text()).slice(0, 300));
      info('inconclusivo — o envio no passo 5 é o que decide');
    }
  }

  // --- 4. Access policy ---
  // Não existe API pra LER a policy, então o teste é indireto e honesto: pede a
  // lista de caixas e vê se o app alcança mais de uma. Se alcança, o passo 5
  // não foi feito — e o app pode enviar como qualquer pessoa da organização.
  passo(4, 'A permissão está trancada numa caixa só?');
  if (!podeLerDiretorio) {
    // Sem User.Read.All não há como enumerar caixas pela API. Isso é bom (menor
    // privilégio), mas significa que a checagem tem que ser feita no PowerShell.
    info('não verificável por aqui: o app não lê o diretório (e é assim que deve ser).');
    console.log('');
    console.log('    pwsh scripts/limitar-caixa-email.ps1 -SomenteVerificar \\');
    console.log('      -ServicePrincipalObjectId <object id em Aplicativos empresariais>');
    console.log('');
    info('Espera-se InScope True só na caixa remetente e False em qualquer outra.');
    info('Se o passo 2 acima disse que Mail.Send NÃO está no token e o envio');
    info('funciona, o escopo já está valendo: a permissão vem do Exchange.');
  } else {
    const res = await graph('/users?$select=userPrincipalName&$top=999');
    if (!res.ok) {
      info(`não consegui listar caixas (HTTP ${res.status}) — teste inconclusivo`);
    } else {
      const todas = (await res.json()).value.map((u) => u.userPrincipalName);
      const outras = todas.filter((u) => u.toLowerCase() !== FROM.toLowerCase());
      if (outras.length === 0) {
        ok('o app só alcança a caixa remetente');
      } else {
        // Confirma tentando LER a caixa de outra pessoa. Se a policy estiver
        // ativa, o Graph responde 403 aqui.
        const alvo = outras[0];
        const teste = await graph(`/users/${encodeURIComponent(alvo)}/mailFolders/inbox?$select=id`);
        if (teste.status === 403) {
          ok(`access policy ATIVA (leitura de ${alvo} recusada com 403)`);
        } else if (teste.status === 404) {
          info(`inconclusivo: ${alvo} não tem caixa de correio. Confira à mão com Test-ApplicationAccessPolicy.`);
        } else {
          falha(`o app ALCANÇA a caixa de ${alvo} (HTTP ${teste.status})`);
          console.log('\n  \x1b[33m⚠  A access policy NÃO está aplicada.\x1b[0m');
          console.log('     Com Mail.Send de aplicação sem restrição, este app pode enviar');
          console.log('     e-mail como QUALQUER pessoa da Allos. Faça o passo 5 da seção 7');
          console.log('     do DEPLOY.md (New-ApplicationAccessPolicy) antes de ir pra produção.');
          console.log('     A policy leva até ~1h pra propagar depois de criada.');
        }
      }
    }
  }

  // --- 5. Envio real ---
  if (!destino) {
    console.log('\n\x1b[1mTudo que dá pra testar sem enviar está OK.\x1b[0m');
    console.log('Para mandar um e-mail de teste de verdade:\n');
    console.log('  node scripts/testar-email.js seu-email@allos.org.br\n');
    return;
  }

  passo(5, `Envio real para ${destino}`);
  {
    const res = await graph(`/users/${encodeURIComponent(FROM)}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: 'Teste de configuração — all_OS',
          body: {
            contentType: 'HTML',
            content: '<p>Se você está lendo isto, o envio de e-mail do all_OS está funcionando.</p>'
              + `<p style="color:#888;font-size:12px">Enviado por scripts/testar-email.js em ${new Date().toLocaleString('pt-BR')}.</p>`,
          },
          toRecipients: [{ emailAddress: { address: destino } }],
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 202) {
      ok('aceito pelo Graph (HTTP 202)');
      console.log(`\n\x1b[32mPronto.\x1b[0m Confira a caixa de ${destino} — inclusive o spam.`);
      console.log('Se não chegar em alguns minutos, o problema é entregabilidade');
      console.log('(SPF/DKIM/DMARC), não configuração — ver o fim da seção 7.\n');
      return;
    }
    falha(`HTTP ${res.status}`);
    const corpo = await res.text();
    info(corpo.slice(0, 500));
    if (res.status === 403) {
      morre('403 = ou falta o "Grant admin consent" (passo 4), ou o MAIL_FROM está FORA do grupo da access policy (passo 5).');
    }
    if (res.status === 404) morre('404 = a caixa MAIL_FROM não existe (passo 1).');
    morre('Veja o corpo do erro acima.');
  }
}

main().catch((e) => {
  console.error('\n\x1b[31mErro inesperado:\x1b[0m', e && e.message);
  process.exit(1);
});
