-- Logs de atendimento e progresso da Trilha: substitui logs.json e progress.json.
--
-- Os nomes de coluna espelham as chaves do JSON em snake_case (itemTitle →
-- item_title), como em 001. A exceção é `timestamp`, que vira criado_em.
--
-- DONO: conta OU visitante. O visitante também gera log e progresso, com o id
-- efêmero `visitor-…` do JWT, que não tem linha em users — então o dono não cabe
-- numa FK só. Conta vai em user_id, com FK; visitante vai em visitante_id; o
-- CHECK exige exatamente um dos dois. Conta excluída continua existindo como
-- lápide (002), então a FK nunca impede uma exclusão.

CREATE TABLE logs (
  -- Formato do app ('log<ms>-<hex>'): o cliente guarda e manda de volta.
  id                    TEXT PRIMARY KEY,
  criado_em             TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id               BIGINT REFERENCES users (id),
  visitante_id          TEXT,
  -- Nome no momento do atendimento, como o JSON gravava.
  user_name             TEXT NOT NULL DEFAULT '',
  type                  TEXT NOT NULL CHECK (type IN ('exercise', 'freeplay', 'neuro')),
  mode                  TEXT NOT NULL DEFAULT 'training' CHECK (mode IN ('training', 'competitive')),
  item_id               TEXT NOT NULL DEFAULT '',
  item_title            TEXT NOT NULL DEFAULT '',
  skill_id              INTEGER,
  difficulty            TEXT,
  duration_seconds      INTEGER NOT NULL DEFAULT 0,
  -- DOUBLE PRECISION, e não NUMERIC: o pg devolve NUMERIC como string, e o app
  -- testa a nota com Number.isFinite — toda nota viraria "sem nota".
  score                 DOUBLE PRECISION,
  criteria_scores       JSONB,
  evaluation            TEXT NOT NULL DEFAULT '',
  eval_version          TEXT,
  eval_parts_id         TEXT,
  -- Ciclo assíncrono do Competitivo: o log nasce pendente e o lote da OpenAI (ou
  -- a avaliação síncrona em background) o fecha depois.
  evaluation_pending    BOOLEAN NOT NULL DEFAULT false,
  eval_batch_id         TEXT,
  eval_batch_at         TIMESTAMPTZ,
  eval_batch_tentativas INTEGER,
  eval_batch_espera     TEXT,
  eval_attempts         INTEGER,
  eval_error            TEXT,
  mmr_before            INTEGER,
  mmr_after             INTEGER,
  image_schema          TEXT,
  cost                  JSONB,
  neuro_tests           JSONB,

  CONSTRAINT logs_um_dono CHECK ((user_id IS NULL) <> (visitante_id IS NULL))
);

CREATE INDEX logs_user_id_idx ON logs (user_id, criado_em) WHERE user_id IS NOT NULL;
CREATE INDEX logs_visitante_id_idx ON logs (visitante_id, criado_em) WHERE visitante_id IS NOT NULL;
-- Retenção de 30 dias (CLAUDE.md §5.5): a poda procura por idade.
CREATE INDEX logs_criado_em_idx ON logs (criado_em);
-- Fila do Competitivo: os sweeps procuram os pendentes a cada ciclo.
CREATE INDEX logs_pendentes_idx ON logs (eval_batch_id) WHERE evaluation_pending;


-- Uma linha por mensagem (decisão registrada em perguntas.md: tabela de
-- mensagens, uma linha por mensagem). Sai junto com o log.
CREATE TABLE log_messages (
  log_id      TEXT NOT NULL REFERENCES logs (id) ON DELETE CASCADE,
  posicao     INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  -- Marcação e comentário que o aluno faz na própria sessão.
  highlighted BOOLEAN NOT NULL DEFAULT false,
  comment     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (log_id, posicao)
);


-- Progresso da Trilha. No JSON era { [userId]: { [chave]: valor } }, com merge
-- raso a cada POST /api/progress; aqui cada chave é uma linha, e o merge vira um
-- UPSERT por chave.
CREATE TABLE progress (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT REFERENCES users (id),
  visitante_id  TEXT,
  chave         TEXT NOT NULL,
  -- O valor é o que o cliente mandou para aquela chave ({ score, passed, … }).
  valor         JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT progress_um_dono CHECK ((user_id IS NULL) <> (visitante_id IS NULL))
);

CREATE UNIQUE INDEX progress_conta_chave_uq ON progress (user_id, chave) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX progress_visitante_chave_uq ON progress (visitante_id, chave) WHERE visitante_id IS NOT NULL;
