-- Reavaliação de um log: re-rodar a avaliação de uma sessão que já foi avaliada.
--
-- Dois caminhos chegam aqui:
--   1. Supervisor ou admin manda reavaliar direto (a avaliação deu erro, ou ele
--      discorda da nota e acha que a IA alucinou).
--   2. O aluno, depois de acrescentar estrelas (a justificativa das falas dele)
--      a um log já avaliado, PEDE uma nova avaliação — e só supervisor ou admin
--      aprova. Sem a aprovação, ninguém fica marcando estrela e re-rodando a
--      avaliação até a nota subir.
--
-- Uma linha por pedido/execução, com a avaliação anterior guardada: reavaliar
-- não apaga o que o aluno leu antes, só deixa de ser a avaliação vigente.
CREATE TABLE reavaliacoes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  log_id             TEXT NOT NULL REFERENCES logs (id) ON DELETE CASCADE,
  -- solicitada   → o aluno pediu; espera supervisor/admin
  -- recusada     → supervisor/admin recusou o pedido
  -- em_andamento → aprovada (ou mandada direto); o pipeline está rodando
  -- concluida    → a avaliação nova está no log
  -- falhou       → o pipeline falhou; o log ficou com a avaliação anterior
  status             TEXT NOT NULL CHECK (status IN ('solicitada', 'recusada', 'em_andamento', 'concluida', 'falhou')),
  solicitado_por     BIGINT REFERENCES users (id),
  solicitado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo             TEXT NOT NULL DEFAULT '',
  decidido_por       BIGINT REFERENCES users (id),
  decidido_em        TIMESTAMPTZ,
  concluido_em       TIMESTAMPTZ,
  erro               TEXT,
  -- A avaliação que estava no log quando a reavaliação começou: score,
  -- criteriaScores, criteriaNames, evaluation, evalVersion, evalPartsId, evalError.
  avaliacao_anterior JSONB,
  nota_nova          DOUBLE PRECISION
);

-- No máximo um pedido aberto por log: o aluno não empilha pedidos, e duas
-- reavaliações do mesmo log nunca rodam ao mesmo tempo.
CREATE UNIQUE INDEX reavaliacoes_uma_aberta_uq ON reavaliacoes (log_id)
  WHERE status IN ('solicitada', 'em_andamento');
CREATE INDEX reavaliacoes_log_idx ON reavaliacoes (log_id, id);

-- Quando as estrelas do log foram editadas depois de salvo (NULL = nunca). A
-- tela do supervisor mostra que a avaliação vigente pode não ter visto as
-- estrelas de agora.
ALTER TABLE logs ADD COLUMN estrelas_editadas_em TIMESTAMPTZ;
