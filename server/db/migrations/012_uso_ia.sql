-- Uso de IA por conta, para o limite semanal do Terapeuta externo (demandas.md
-- §16.2 e §18): janela deslizante de 7 dias em dólares e tokens.
--
-- Uma linha por chamada cobrada (turno do paciente, avaliação inteira). O limite
-- soma as linhas dos últimos 7 dias; linhas com mais de 30 dias são podadas.

CREATE TABLE uso_ia (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  categoria TEXT NOT NULL DEFAULT '',
  modelo    TEXT NOT NULL DEFAULT '',
  tokens    BIGINT NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  -- NULL = modelo sem preço na tabela: conta nos tokens, não nos dólares.
  usd       NUMERIC(14, 6) CHECK (usd IS NULL OR usd >= 0)
);

CREATE INDEX uso_ia_user_criado_idx ON uso_ia (user_id, criado_em);

-- Último aviso ao suporte por conta: um aviso por estouro, não um por chamada
-- recusada.
CREATE TABLE uso_ia_alertas (
  user_id     BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  alertado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
