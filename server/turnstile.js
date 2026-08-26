// Verificação do Cloudflare Turnstile (captcha do formulário de cadastro).
//
// Escolhido no lugar do reCAPTCHA porque é grátis e ilimitado, não manda dado
// dos usuários pro Google (a plataforma é de uma associação brasileira e o
// cadastro coleta nome e e-mail — menos um terceiro no caminho é menos
// exposição sob a LGPD) e o tráfego já passa pelo Cloudflare.
//
// ATENÇÃO: o widget só carrega porque challenges.cloudflare.com foi liberado em
// script-src, frame-src e connect-src no CSP do index.js. O CSP daqui é
// 'self'-puro; sem frame-src explícito o iframe do desafio cai no default-src e
// é bloqueado sem erro visível na tela.
//
// E o de sempre: captcha NÃO substitui rate limit nem confirmação de e-mail.
// Ele encarece o bot burro; quem realmente segura a porta é o link no e-mail.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

function estaConfigurado() {
  return !!(SITE_KEY && SECRET_KEY);
}

// A site key não é segredo (vai no HTML). Exposta em GET /api/config pra que o
// cliente não precise de rebuild quando a chave mudar — o build do Vite roda no
// deploy, e acoplar chave a build é o tipo de coisa que quebra no pior momento.
function siteKey() {
  return SITE_KEY;
}

// Devolve { ok, motivo }. Nunca lança.
//
// Sem configuração, devolve ok:true — é o mesmo padrão do VAPID e do e-mail
// neste projeto: em dev (e nos testes) o recurso externo some sem quebrar o
// fluxo. Em produção, o startup avisa em voz alta se a chave estiver faltando.
async function verificar(token, ip) {
  if (!estaConfigurado()) return { ok: true, motivo: 'nao-configurado' };
  if (!token || typeof token !== 'string') return { ok: false, motivo: 'token-ausente' };

  try {
    const body = new URLSearchParams({ secret: SECRET_KEY, response: token });
    // remoteip é opcional e ajuda o Cloudflare a pontuar. Só mandamos o IP real
    // (CF-Connecting-IP), nunca o X-Forwarded-For cru, que é forjável.
    if (ip) body.set('remoteip', ip);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, motivo: `http-${res.status}` };

    const json = await res.json();
    if (json.success) return { ok: true };
    return { ok: false, motivo: (json['error-codes'] || []).join(',') || 'recusado' };
  } catch (err) {
    // Timeout ou Cloudflare fora do ar. Fail-CLOSED: sem verificação, o cadastro
    // não passa. O contrário transformaria uma instabilidade do captcha numa
    // janela aberta pra registro em massa — e o custo do fail-closed é só o
    // usuário tentar de novo em um minuto.
    return { ok: false, motivo: 'indisponivel' };
  }
}

module.exports = { estaConfigurado, siteKey, verificar };
