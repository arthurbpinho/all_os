// Nome atual de cada critério pelo id ({ id: nome }), para o que é guardado
// pelo id do critério — o MMR por critério do perfil e o D por critério do
// seletivo. Busca a cada montagem: renomeou em "Critérios da régua", a próxima
// tela já mostra o nome novo.
import { useEffect, useState } from 'react';
import { api } from './api';

export function useNomesCriterios() {
  const [nomes, setNomes] = useState({});
  useEffect(() => {
    let vivo = true;
    api.criteriosNomes()
      .then((r) => { if (vivo && r && r.nomes) setNomes(r.nomes); })
      .catch(() => {}); // sem nomes, a tela cai no "Crit. <id>" de antes
    return () => { vivo = false; };
  }, []);
  return nomes;
}

export function nomeDoCriterio(nomes, id) {
  return (nomes && nomes[id]) || `Crit. ${id}`;
}
