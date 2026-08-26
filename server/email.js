// Envio de e-mail transacional pela Microsoft Graph API (Microsoft 365).
//
// POR QUE GRAPH E NÃO SMTP: a Microsoft está aposentando a autenticação básica
// no SMTP AUTH do Exchange Online (rejeição gradual desde 01/03/2026, conclusão
// em 30/04/2026, prazo final de tenant até dez/2026). Construir em cima de SMTP
// com senha hoje é construir em cima do que já está caindo. O Graph usa OAuth
// client credentials e é só um POST HTTPS — sem dependência npm nova, o que
// também casa com a quarentena do .npmrc (ver SEGURANCA.md).
//
// LIMITE IMPORTANTE: o Exchange Online NÃO é serviço de e-mail em massa
// (~10.000 destinatários/dia, 30 mensagens/minuto, e os termos não cobrem
// marketing). Aqui só saem e-mails TRANSACIONAIS: confirmação de cadastro,
// redefinição de senha e avisos de segurança da própria conta. As newsletters
// (updateAllOS / updateAllos) ficam apenas REGISTRADAS como consentimento —
// quando forem disparadas, tem que ser por plataforma própria de marketing.
//
// Configuração no portal: ver DEPLOY.md, seção "E-mail (Microsoft 365)".

const crypto = require('crypto');
const fs = require('fs');

const GRAPH_TENANT_ID = process.env.GRAPH_TENANT_ID || '';
const GRAPH_CLIENT_ID = process.env.GRAPH_CLIENT_ID || '';

// --- Credencial do app: certificado OU segredo ---
//
// Certificado é o caminho preferido, e em muitos tenants o ÚNICO: a política de
// gerenciamento de aplicativos do Entra (passwordAddition) bloqueia a criação de
// client secret, e a Microsoft está distribuindo isso como padrão. Além de ser
// obrigatório nesses tenants, é melhor: a chave privada nunca sai do servidor,
// não há segredo compartilhado pra vazar em log, e não expira por política de
// portal.
//
// A chave pode vir inline (Railway) ou por caminho de arquivo (dev local, pra
// não colar um PEM multilinha no .env). O thumbprint é o hex que o portal mostra
// depois do upload do certificado.
const GRAPH_CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || '';
const GRAPH_CERT_THUMBPRINT = (process.env.GRAPH_CERT_THUMBPRINT || '').replace(/[^0-9a-fA-F]/g, '');

function lerChavePrivada() {
  const arquivo = process.env.GRAPH_CERT_KEY_FILE;
  if (arquivo) {
    try {
      // Caminho relativo é resolvido a partir da RAIZ do projeto, não do cwd:
      // o servidor é iniciado tanto de lá (`npm start`) quanto de subpastas.
      const path = require('path');
      const alvo = path.isAbsolute(arquivo) ? arquivo : path.join(__dirname, '..', arquivo);
      return fs.readFileSync(alvo, 'utf-8');
    } catch (e) {
      console.error('[email] GRAPH_CERT_KEY_FILE não pôde ser lido:', e && e.message);
      return '';
    }
  }
  const bruto = (process.env.GRAPH_CERT_PRIVATE_KEY || '').trim();
  if (!bruto) return '';

  // Aceita a chave em tres formatos, porque cada painel de variavel estraga o
  // PEM de um jeito diferente:
  //
  //   1. PEM cru multilinha       - funciona onde o painel preserva quebra de linha
  //   2. PEM com \n literal       - o painel escapou as quebras
  //   3. base64 do PEM, uma linha - RECOMENDADO no Railway: nao tem quebra de
  //      linha nenhuma pra estragar, e sobrevive a copiar/colar em qualquer UI
  if (bruto.includes('-----BEGIN')) {
    return bruto.replace(/\\n/g, '\n');
  }
  try {
    const decodificado = Buffer.from(bruto, 'base64').toString('utf-8');
    if (decodificado.includes('-----BEGIN')) return decodificado;
  } catch {}
  console.error('[email] GRAPH_CERT_PRIVATE_KEY nao parece um PEM nem um base64 de PEM.');
  return '';
}
const GRAPH_CERT_PRIVATE_KEY = lerChavePrivada();

const USA_CERTIFICADO = !!(GRAPH_CERT_PRIVATE_KEY && GRAPH_CERT_THUMBPRINT);
// Como o app se autentica, pra log e diagnóstico.
function modoCredencial() {
  if (USA_CERTIFICADO) return 'certificado';
  if (GRAPH_CLIENT_SECRET) return 'segredo';
  return 'nenhuma';
}
// Caixa remetente (UPN ou objectId). Precisa estar dentro do grupo do
// ApplicationAccessPolicy — ver DEPLOY.md.
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'all_OS — Associação Allos';
// Usada para montar os links dos e-mails. Sem ela, o link sairia relativo.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

function estaConfigurado() {
  // Trava dura: sob NODE_ENV=test o módulo se declara NÃO configurado, então
  // todo envio cai no caminho de captura em memória. Sem isto, a suíte lê o
  // .env real (o server/index.js chama dotenv) e passa a disparar e-mail DE
  // VERDADE pela caixa da organização — os destinatários dos testes são
  // fictícios, viram bounce e queimam cota e reputação do domínio.
  // O helper de teste também zera as envs; isto aqui é a segunda barreira.
  if (process.env.NODE_ENV === 'test') return false;
  return !!(GRAPH_TENANT_ID && GRAPH_CLIENT_ID && MAIL_FROM && modoCredencial() !== 'nenhuma');
}

// JWT assinado com a chave privada do certificado (private_key_jwt do OpenID
// Connect). Substitui o client_secret: o Entra valida a assinatura com a chave
// PÚBLICA do certificado que você subiu no portal.
//
// O `x5t` diz ao Entra QUAL certificado usar para verificar — é o thumbprint
// SHA-1 em bytes crus, codificado em base64url (o portal mostra em hex).
function montarClientAssertion(audience) {
  const agora = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    x5t: Buffer.from(GRAPH_CERT_THUMBPRINT, 'hex').toString('base64url'),
  };
  const payload = {
    aud: audience,
    iss: GRAPH_CLIENT_ID,
    sub: GRAPH_CLIENT_ID,
    // jti único por assertion — o Entra recusa reuso, e é o que impede que uma
    // assertion capturada seja reapresentada.
    jti: crypto.randomUUID(),
    nbf: agora - 60,          // 60s de folga para relógio dessincronizado
    iat: agora,
    exp: agora + 300,         // 5 min; a Microsoft recomenda no máximo 10
  };
  const cabeca = Buffer.from(JSON.stringify(header)).toString('base64url');
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const assinatura = crypto
    .createSign('RSA-SHA256')
    .update(`${cabeca}.${corpo}`)
    .sign(GRAPH_CERT_PRIVATE_KEY)
    .toString('base64url');
  return `${cabeca}.${corpo}.${assinatura}`;
}

// --- Token de aplicação (client credentials) ---
// O token do Graph dura ~1h. Guardamos em memória com margem de 5 min; um
// processo só (caso atual no Railway), então não precisa de cache distribuído.
let tokenCache = { value: null, expiraEm: 0 };

async function getAccessToken() {
  const agora = Date.now();
  if (tokenCache.value && agora < tokenCache.expiraEm) return tokenCache.value;

  const url = `https://login.microsoftonline.com/${encodeURIComponent(GRAPH_TENANT_ID)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: GRAPH_CLIENT_ID,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  if (USA_CERTIFICADO) {
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set('client_assertion', montarClientAssertion(url));
  } else {
    body.set('client_secret', GRAPH_CLIENT_SECRET);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    // Sem o corpo do erro é impossível distinguir segredo expirado de
    // consentimento faltando — os dois vêm como 401.
    const detalhe = await res.text().catch(() => '');
    throw new Error(`Graph token ${res.status}: ${detalhe.slice(0, 300)}`);
  }
  const json = await res.json();
  tokenCache = {
    value: json.access_token,
    expiraEm: agora + Math.max(0, (Number(json.expires_in) || 3600) - 300) * 1000,
  };
  return tokenCache.value;
}

// Últimos e-mails "enviados" enquanto o Graph NÃO está configurado. Serve pra
// dois usos: inspecionar em dev sem caixa de e-mail, e deixar a suíte de testes
// pegar o token do link (que em disco só existe hasheado, e portanto não pode
// ser reconstruído a partir do arquivo de pendências).
//
// Só é populado no caminho `skipped`. Com o Graph configurado, nada de e-mail
// fica em memória — não existe aqui um histórico de mensagens reais pra vazar.
const CAPTURA_MAX = 50;
const capturados = [];
function emailsCapturados() { return capturados.slice(); }
function limparCapturados() { capturados.length = 0; }

// --- Envio ---
//
// Nunca lança: um e-mail que não sai não pode derrubar o cadastro (o usuário
// pode pedir reenvio). Devolve { ok, skipped?, erro? } pro chamador decidir o
// que dizer na tela e o que registrar no log de erro.
async function enviarEmail({ to, subject, html, text }) {
  if (!estaConfigurado()) {
    // Em dev (e em qualquer deploy sem as chaves) o link vai pro stdout, senão
    // seria impossível testar o cadastro localmente.
    console.warn('[email] NÃO CONFIGURADO — e-mail não enviado. Assunto:', subject);
    console.warn('[email] destinatário:', to);
    if (text) console.warn('[email] corpo:\n' + text);
    capturados.push({ to, subject, text, html, em: new Date().toISOString() });
    if (capturados.length > CAPTURA_MAX) capturados.shift();
    return { ok: false, skipped: true };
  }

  try {
    const token = await getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_FROM)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: to } }],
            from: { emailAddress: { address: MAIL_FROM, name: MAIL_FROM_NAME } },
          },
          // false = a cópia fica em Itens Enviados. Deixamos gravar: é o rastro
          // que responde "o e-mail saiu mesmo?" quando o aluno diz que não
          // recebeu, sem precisar de log próprio de mensagem.
          saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      throw new Error(`Graph sendMail ${res.status}: ${detalhe.slice(0, 300)}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('[email] falha ao enviar:', err && err.message);
    return { ok: false, erro: (err && err.message) || String(err) };
  }
}

// --- Templates ---
//
// HTML propositalmente simples e com tudo inline: cliente de e-mail ignora
// <style> em <head>, Gmail corta CSS externo, e Outlook renderiza com engine do
// Word. Tabela + inline style é o que sobrevive nos três.
function escaparHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function layout({ titulo, corpoHtml, botao }) {
  const botaoHtml = botao ? `
        <tr><td style="padding:8px 0 24px;">
          <a href="${escaparHtml(botao.href)}" style="display:inline-block;background:#1f6f5c;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;">${escaparHtml(botao.label)}</a>
        </td></tr>
        <tr><td style="padding:0 0 24px;color:#6b7280;font-size:12.5px;line-height:1.6;">
          Se o botão não funcionar, copie e cole este endereço no navegador:<br>
          <span style="color:#1f6f5c;word-break:break-all;">${escaparHtml(botao.href)}</span>
        </td></tr>` : '';

  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:0;background:#f4f4f2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="padding-bottom:8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a83;">Associação Allos</td></tr>
        <tr><td style="padding-bottom:20px;font-size:26px;font-weight:700;color:#1a1a18;">all<span style="color:#1f6f5c;">_OS</span></td></tr>
        <tr><td style="padding-bottom:12px;font-size:19px;font-weight:600;color:#1a1a18;">${escaparHtml(titulo)}</td></tr>
        <tr><td style="padding-bottom:20px;color:#3a3a36;font-size:15px;line-height:1.65;">${corpoHtml}</td></tr>
        ${botaoHtml}
        <tr><td style="border-top:1px solid #e6e6e2;padding-top:18px;color:#8a8a83;font-size:12px;line-height:1.6;">
          Este é um e-mail automático da plataforma all_OS. Não responda a esta mensagem.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function link(caminho, token) {
  const base = APP_BASE_URL || '';
  return `${base}${caminho}?token=${encodeURIComponent(token)}`;
}

// O `username` aparece no corpo de propósito: um novo cadastro com o mesmo
// e-mail SUBSTITUI a pendência anterior, então dizer qual nome está sendo
// confirmado é o que permite à pessoa notar se o pedido não foi dela.
async function enviarConfirmacaoCadastro({ to, nome, username, token }) {
  const href = link('/confirmar-email', token);
  const primeiroNome = String(nome || '').split(' ')[0];
  return enviarEmail({
    to,
    subject: 'Confirme seu cadastro na all_OS',
    html: layout({
      titulo: `Boas-vindas, ${escaparHtml(primeiroNome)}!`,
      corpoHtml: `Falta um passo para sua conta ficar pronta: confirme que este e-mail é seu. O link vale por <strong>48 horas</strong>.<br><br>Nome de usuário escolhido: <strong>${escaparHtml(username || '')}</strong>.<br><br>Se não foi você quem se cadastrou, ignore este e-mail — nenhuma conta será criada.`,
      botao: { href, label: 'Confirmar meu cadastro' },
    }),
    text: `Boas-vindas, ${primeiroNome}!\n\nConfirme seu cadastro na all_OS (link válido por 48 horas):\n${href}\n\nNome de usuário escolhido: ${username || ''}\n\nSe não foi você quem se cadastrou, ignore este e-mail — nenhuma conta será criada.`,
  });
}

// Enviado quando alguém tenta se cadastrar com um e-mail QUE JÁ TEM CONTA.
// A resposta da API é sempre a mesma ("enviamos um e-mail"), então é este
// e-mail que muda — e quem recebe é o dono legítimo, não quem tentou.
async function enviarEmailJaCadastrado({ to, username }) {
  const href = `${APP_BASE_URL}/login`;
  return enviarEmail({
    to,
    subject: 'Tentativa de cadastro com seu e-mail — all_OS',
    html: layout({
      titulo: 'Você já tem uma conta',
      corpoHtml: `Alguém tentou criar uma conta na all_OS com este e-mail, mas ele já está cadastrado no usuário <strong>${escaparHtml(username)}</strong>.<br><br>Se foi você, é só entrar normalmente. Se esqueceu a senha, use "Esqueci minha senha" na tela de login.<br><br>Se não foi você, pode ignorar — nada mudou na sua conta.`,
      botao: { href, label: 'Ir para o login' },
    }),
    text: `Alguém tentou criar uma conta na all_OS com este e-mail, que já pertence ao usuário ${username}.\n\nSe foi você, entre em ${href}. Se não foi, ignore — nada mudou na sua conta.`,
  });
}

async function enviarRedefinicaoSenha({ to, nome, token }) {
  const href = link('/redefinir-senha', token);
  const primeiroNome = String(nome || '').split(' ')[0];
  return enviarEmail({
    to,
    subject: 'Redefinir sua senha da all_OS',
    html: layout({
      titulo: 'Redefinir senha',
      corpoHtml: `Olá, ${escaparHtml(primeiroNome)}. Recebemos um pedido para redefinir a senha da sua conta. O link vale por <strong>1 hora</strong> e só pode ser usado uma vez.<br><br>Se não foi você, ignore este e-mail: sua senha continua a mesma.`,
      botao: { href, label: 'Criar nova senha' },
    }),
    text: `Olá, ${primeiroNome}.\n\nPara redefinir sua senha da all_OS (link válido por 1 hora, uso único):\n${href}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.`,
  });
}

// Confirmação do NOVO endereço quando o usuário troca o e-mail do perfil.
async function enviarConfirmacaoTrocaEmail({ to, nome, token }) {
  const href = link('/confirmar-email', token);
  const primeiroNome = String(nome || '').split(' ')[0];
  return enviarEmail({
    to,
    subject: 'Confirme seu novo e-mail na all_OS',
    html: layout({
      titulo: 'Confirme seu novo e-mail',
      corpoHtml: `Olá, ${escaparHtml(primeiroNome)}. Para passar a usar este endereço na sua conta all_OS, confirme abaixo. O link vale por <strong>48 horas</strong>.<br><br>Até confirmar, o e-mail antigo continua valendo.`,
      botao: { href, label: 'Confirmar novo e-mail' },
    }),
    text: `Confirme seu novo e-mail na all_OS (válido por 48 horas):\n${href}\n\nAté confirmar, o e-mail antigo continua valendo.`,
  });
}

// Aviso ao endereço ANTIGO. Não pede ação: é o alarme que permite à pessoa
// reagir caso a troca não tenha partido dela.
async function enviarAvisoTrocaEmail({ to, novoEmail }) {
  return enviarEmail({
    to,
    subject: 'Pedido de troca de e-mail na sua conta all_OS',
    html: layout({
      titulo: 'Alguém pediu para trocar o e-mail da sua conta',
      corpoHtml: `Foi solicitada a troca do e-mail da sua conta all_OS para <strong>${escaparHtml(novoEmail)}</strong>. A troca só acontece quando o novo endereço for confirmado.<br><br><strong>Se não foi você</strong>, troque sua senha agora e fale com a equipe da Allos.`,
    }),
    text: `Foi solicitada a troca do e-mail da sua conta all_OS para ${novoEmail}. Se não foi você, troque sua senha e avise a equipe da Allos.`,
  });
}

// Aviso após redefinição/alteração de senha concluída.
async function enviarAvisoSenhaAlterada({ to, nome }) {
  const primeiroNome = String(nome || '').split(' ')[0];
  return enviarEmail({
    to,
    subject: 'Sua senha da all_OS foi alterada',
    html: layout({
      titulo: 'Senha alterada',
      corpoHtml: `Olá, ${escaparHtml(primeiroNome)}. A senha da sua conta all_OS acabou de ser alterada, e todas as sessões abertas foram encerradas.<br><br><strong>Se não foi você</strong>, fale com a equipe da Allos imediatamente.`,
    }),
    text: `A senha da sua conta all_OS foi alterada e todas as sessões abertas foram encerradas. Se não foi você, fale com a equipe da Allos imediatamente.`,
  });
}

module.exports = {
  estaConfigurado,
  modoCredencial,
  // Exportada para scripts/testar-email.js exercitar o MESMO código do servidor.
  montarClientAssertion,
  emailsCapturados,
  limparCapturados,
  enviarEmail,
  enviarConfirmacaoCadastro,
  enviarEmailJaCadastrado,
  enviarRedefinicaoSenha,
  enviarConfirmacaoTrocaEmail,
  enviarAvisoTrocaEmail,
  enviarAvisoSenhaAlterada,
  APP_BASE_URL,
  MAIL_FROM,
};
