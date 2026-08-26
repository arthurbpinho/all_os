import { useEffect, useRef, useState } from 'react';

// Widget do Cloudflare Turnstile.
//
// O script é carregado sob demanda (só quem abre o cadastro ou o "esqueci minha
// senha" baixa) e uma única vez por aba, mesmo com duas telas montando o widget.
//
// Sem site key o componente não renderiza NADA e chama onToken(null): é o
// mesmo padrão do servidor (turnstile.js), onde captcha ausente = check pulado.
// Assim dev e teste rodam sem chave e a tela não fica com um buraco.
//
// O CSP precisa liberar challenges.cloudflare.com em script-src, frame-src e
// connect-src — ver o helmet em server/index.js.

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function carregarScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.async = true;
    el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile ausente')));
    el.onerror = () => {
      // Deixa uma nova tentativa possível: quem falhou pode ter sido a rede.
      scriptPromise = null;
      reject(new Error('falha ao carregar o captcha'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export default function Turnstile({ siteKey, onToken, acao }) {
  const boxRef = useRef(null);
  const widgetRef = useRef(null);
  const [erro, setErro] = useState('');
  // onToken em ref: o pai costuma passar uma função nova a cada render, e como
  // dependência do efeito ela remontaria o widget sem parar.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey) {
      onTokenRef.current?.(null);
      return;
    }
    let vivo = true;
    carregarScript()
      .then((turnstile) => {
        if (!vivo || !boxRef.current) return;
        widgetRef.current = turnstile.render(boxRef.current, {
          sitekey: siteKey,
          action: acao || undefined,
          callback: (token) => onTokenRef.current?.(token),
          // O token do Turnstile vence em ~5 min. Se a pessoa demorar
          // preenchendo o formulário, o widget se renova sozinho e o pai
          // recebe o token novo — sem isso, o envio falharia no captcha
          // justamente para quem leu tudo com calma.
          'expired-callback': () => onTokenRef.current?.(null),
          'error-callback': () => {
            setErro('Não foi possível carregar a verificação de segurança.');
            onTokenRef.current?.(null);
          },
          theme: 'auto',
        });
      })
      .catch(() => {
        if (vivo) setErro('Não foi possível carregar a verificação de segurança. Verifique sua conexão.');
      });

    return () => {
      vivo = false;
      // Sem o remove, voltar pra tela deixa widgets órfãos acumulados no DOM.
      if (widgetRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetRef.current); } catch {}
      }
      widgetRef.current = null;
    };
  }, [siteKey, acao]);

  if (!siteKey) return null;

  return (
    <div className="turnstile-wrap">
      <div ref={boxRef} />
      {erro && <div className="alert error" style={{ marginTop: 8 }}>{erro}</div>}
    </div>
  );
}
