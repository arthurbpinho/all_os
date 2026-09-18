// O que está bloqueado para quem está logado (Administração → Acessos).
//
// Só serve para desenhar o cadeado e a tela de bloqueio: a trava de verdade é o
// servidor, que recusa a request mesmo que alguém digite o endereço na mão.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

const VAZIO = { bloqueadas: [], mensagem: '' };

export function useAcessos(user) {
  const [estado, setEstado] = useState(VAZIO);

  const recarregar = useCallback(() => (
    api.getAcessos()
      .then((a) => setEstado({ bloqueadas: a.bloqueadas || [], mensagem: a.mensagemCadeado || '' }))
      .catch(() => setEstado(VAZIO))
  ), []);

  useEffect(() => {
    if (user && user.id) recarregar();
    else setEstado(VAZIO);
  }, [user && user.id, user && user.role, recarregar]);

  return {
    bloqueada: (chave) => estado.bloqueadas.includes(chave),
    mensagem: estado.mensagem,
    recarregar,
  };
}
