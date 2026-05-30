// Som de notificação sintetizado via Web Audio API — um carrilhão (chime) bem
// suave de duas notas ascendentes, volume baixinho, com ataque/decaimento macios
// pra avisar sem assustar. Sem arquivos de áudio: tudo gerado em runtime.
//
// Navegadores bloqueiam áudio até o primeiro gesto do usuário (autoplay policy).
// Como a notificação chega via polling (sem gesto), destravamos o AudioContext
// no primeiro clique/tecla da página e só tocamos se ele já estiver liberado —
// se ainda estiver travado, simplesmente não toca (sem erro, sem fila).

let ctx = null;
let unlocked = false;

function getCtx() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

// Destrava o áudio no primeiro gesto (resume do AudioContext). Idempotente.
function unlock() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  unlocked = true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
}

// Toca o chime suave. No-op silencioso se o áudio não estiver disponível ou
// ainda travado pela política de autoplay.
export function playNotificationChime() {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  if (c.state !== 'running') return; // ainda travado: não toca

  const now = c.currentTime;
  const peak = 0.07; // bem baixinho — "de leve"

  // Lowpass leve pra tirar o brilho/estridência das senoides.
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2600;
  filter.connect(c.destination);

  // Duas notas (G5 → D6), a segunda entrando logo após a primeira.
  const notes = [
    { freq: 784.0, at: 0 },
    { freq: 1174.7, at: 0.13 },
  ];
  for (const n of notes) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    const start = now + n.at;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.03); // ataque macio
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55); // decaimento
    osc.connect(gain);
    gain.connect(filter);
    osc.start(start);
    osc.stop(start + 0.6);
  }
}
