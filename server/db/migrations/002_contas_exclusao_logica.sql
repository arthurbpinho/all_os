-- Exclusão lógica de conta (decisão de 2026-09-14).
--
-- Excluir uma conta não apaga mais a linha: ela vira uma "lápide". Mantém o id,
-- que logs, duelos e MMR continuam referenciando, e perde tudo que identifica a
-- pessoa (nome, e-mail, senha, foto, origem, aceite dos termos). É o equivalente
-- do que o JSON fazia — tirava a conta do users.json e deixava os logs no disco —
-- sem deixar registro apontando para um id que não existe mais.
--
-- Toda leitura de conta ignora as linhas com excluido_em preenchido (ver
-- server/repos/contas.js). O username da lápide recebe um caractere que o
-- cadastro não aceita, então o nome original fica livre e nenhum nome real
-- colide com uma lápide.

ALTER TABLE users ADD COLUMN excluido_em TIMESTAMPTZ;
