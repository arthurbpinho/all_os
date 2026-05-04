import { useEffect, useState } from 'react';

// Animação de máquina de escrever para títulos.
// Use múltiplas instâncias com delayStart diferentes para encadear segmentos
// (ex: <h2><Typewriter text="Mapa de "/><span><Typewriter text="Habilidades" delayStart={520}/></span></h2>).
export default function Typewriter({
  text = '',
  speed = 38,        // ms por caractere
  delayStart = 0,    // ms até começar a digitação
  cursor = false,    // mostrar cursor piscante após terminar
  className = '',
}) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let cancelled = false;
    let i = 0;

    const startTimer = setTimeout(function step() {
      if (cancelled) return;
      if (i >= text.length) {
        setDone(true);
        return;
      }
      setDisplayed(text.slice(0, i + 1));
      i++;
      setTimeout(step, speed);
    }, delayStart);

    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [text, speed, delayStart]);

  return (
    <span className={`typewriter ${className}`} aria-label={text}>
      {displayed}
      {cursor && !done && <span className="typewriter-cursor">|</span>}
    </span>
  );
}
