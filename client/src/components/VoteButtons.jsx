// Setas de upvote/downvote com o placar no meio.
//
// Otimista de propósito: o placar muda no clique e o servidor confirma depois.
// Votar é a interação mais repetida da tela e um round-trip por clique deixaria
// a lista "travada". Se a chamada falhar, o valor anterior volta — o
// componente guarda o estado de onde veio, então não precisa recarregar nada.
//
// Clicar de novo na seta já ativa DESFAZ o voto (manda 0), que é o
// comportamento que todo mundo espera de fórum.
import { useState } from 'react';

export default function VoteButtons({ score, myVote, onVote, disabled, orientation = 'vertical' }) {
  const [local, setLocal] = useState(null); // { score, myVote } enquanto o servidor não responde
  const atual = local || { score, myVote };

  async function clicar(valor) {
    if (disabled) return;
    const proximo = atual.myVote === valor ? 0 : valor;
    const anterior = { score: atual.score, myVote: atual.myVote };
    // Diferença entre o voto novo e o antigo: -1 → +1 move o placar em 2.
    setLocal({ score: anterior.score - anterior.myVote + proximo, myVote: proximo });
    try {
      const r = await onVote(proximo);
      if (r && typeof r.score === 'number') setLocal({ score: r.score, myVote: r.myVote });
    } catch {
      setLocal(anterior);
    }
  }

  return (
    <div className={`voto ${orientation}`}>
      <button
        type="button"
        className={`voto-btn ${atual.myVote === 1 ? 'ativo up' : ''}`}
        onClick={() => clicar(1)}
        disabled={disabled}
        aria-label="Votar a favor"
        aria-pressed={atual.myVote === 1}
        title={disabled ? 'Entre com sua conta para votar' : 'Votar a favor'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12l7-7 7 7" />
        </svg>
      </button>
      <span className={`voto-placar ${atual.myVote === 1 ? 'up' : atual.myVote === -1 ? 'down' : ''}`}>
        {atual.score}
      </span>
      <button
        type="button"
        className={`voto-btn ${atual.myVote === -1 ? 'ativo down' : ''}`}
        onClick={() => clicar(-1)}
        disabled={disabled}
        aria-label="Votar contra"
        aria-pressed={atual.myVote === -1}
        title={disabled ? 'Entre com sua conta para votar' : 'Votar contra'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7 7 7-7" />
        </svg>
      </button>
    </div>
  );
}
