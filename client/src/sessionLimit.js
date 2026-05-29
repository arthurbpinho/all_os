// Limite duro de tempo de sessão, válido em TODOS os modos (Treinamento,
// Modo Desafio, Competitivo, Duelo e Trilha).
//
// Regra do tempo: o cronômetro só corre quando a pessoa ESTÁ NO CHAT — ou seja,
// a aba/app precisa estar VISÍVEL e a tela de sessão montada. Tempo gasto com o
// app em background, fechado, com a tela bloqueada ou em outra aba NÃO conta.
// Isso é garantido somando 1s por tick só quando `document.visibilityState`
// é 'visible'; quando a aba some, o setInterval é estrangulado/pausado pelo
// navegador e, ainda que dispare, este guard impede o incremento.
export const SESSION_LIMIT_SECONDS = 200 * 60; // 200 minutos
export const SESSION_LIMIT_MINUTES = 200;

// Próximo valor do cronômetro a partir do atual. Use direto no setInterval:
//   timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
// Soma 1s apenas se a aba está visível e ainda há tempo abaixo do limite;
// caso contrário devolve o valor inalterado (pausa / trava no teto).
export function nextActiveElapsed(seconds) {
  const s = Number.isFinite(seconds) ? seconds : 0;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return s;
  if (s >= SESSION_LIMIT_SECONDS) return SESSION_LIMIT_SECONDS;
  return s + 1;
}
