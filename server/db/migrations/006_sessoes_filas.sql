-- Sessões em andamento, cota do aluno externo e filas de trabalho: substitui
-- active-sessions.json, external-session-starts.json, batch-ledger.json,
-- trilha-eval-queue.json, avaliacao-fila.json, avaliacao-v25.json,
-- benchmark-fila.json e benchmark-lotes.json.
--
-- É onde a escrita concorrente mais acontece (perguntas.md A4): cada item passa
-- a ser uma linha travada sozinha, em vez de um arquivo inteiro relido e
-- regravado a cada alteração.


-- SESSÕES ATIVAS: a conversa em andamento, que permite F5 sem perder nada.
-- Dona é uma conta OU um visitante (id efêmero `visitor-…`), como nos logs.
-- Sessão abandonada expira em 15 dias sem ser salva (perguntas.md A4).
CREATE TABLE sessoes_ativas (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT REFERENCES users (id),
  visitante_id      TEXT,
  tipo              TEXT NOT NULL CHECK (tipo IN ('exercise', 'freeplay', 'neuro')),
  item_id           TEXT NOT NULL,
  item_title        TEXT NOT NULL DEFAULT '',
  elapsed_seconds   INTEGER NOT NULL DEFAULT 0,
  thread_id         TEXT,
  -- Rascunho da escolha de testes da Neuroavaliação.
  neuro_tests       JSONB,
  ultimo_salvamento TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sessoes_ativas_um_dono CHECK ((user_id IS NULL) <> (visitante_id IS NULL))
);

-- Uma sessão por dono + tipo + paciente/exercício.
CREATE UNIQUE INDEX sessoes_ativas_conta_idx ON sessoes_ativas (user_id, tipo, item_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX sessoes_ativas_visitante_idx ON sessoes_ativas (visitante_id, tipo, item_id) WHERE visitante_id IS NOT NULL;
CREATE INDEX sessoes_ativas_ultimo_salvamento_idx ON sessoes_ativas (ultimo_salvamento);

-- Uma linha por mensagem (perguntas.md, "Como o chat com o paciente é
-- armazenado"). A tela manda a conversa inteira a cada salvamento; só as linhas
-- que mudaram são escritas.
CREATE TABLE sessao_ativa_mensagens (
  sessao_id BIGINT NOT NULL REFERENCES sessoes_ativas (id) ON DELETE CASCADE,
  posicao   INTEGER NOT NULL,
  role      TEXT NOT NULL,
  content   TEXT NOT NULL DEFAULT '',
  -- Os demais campos que a tela guarda na mensagem (destaque, comentário…).
  extras    JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sessao_id, posicao)
);


-- COTA DO ALUNO EXTERNO: cada abertura de sessão numa janela deslizante de 24h
-- (server/session-quota.js). `chave` é tipo+paciente enquanto a sessão está
-- aberta, e vira null quando o atendimento é finalizado — o slot continua gasto.
CREATE TABLE cota_sessoes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id),
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  chave       TEXT
);

CREATE INDEX cota_sessoes_user_idx ON cota_sessoes (user_id, iniciado_em);


-- LEDGER DA BATCH API: os batches da OpenAI em voo e os tokens que cada um
-- reserva no teto por modelo, compartilhado pelos modos que usam batch
-- (server/batch-fila.js). Sai quando o batch termina, ou pela idade (26h).
CREATE TABLE batches_em_voo (
  batch_id  TEXT PRIMARY KEY,
  model     TEXT NOT NULL,
  tokens    BIGINT NOT NULL,
  modo      TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX batches_em_voo_model_idx ON batches_em_voo (lower(model));


-- JOBS DAS FERRAMENTAS INTERNAS: filas e resultados da Trilha em batch, da
-- Avaliação Independente e do benchmark de simulação. É estado operacional,
-- não dado de aluno (CLAUDE.md §4), e cada ferramenta guarda um documento com
-- formato próprio — por isso JSONB, com as chaves de busca extraídas em colunas.
-- Alterar um job trava só aquele job.
CREATE TABLE jobs (
  fila          TEXT NOT NULL CHECK (fila IN (
                  'trilha-avaliacao',       -- trilha-eval-queue.json
                  'avaliacao-fila',         -- avaliacao-fila.json
                  'avaliacao-resultados',   -- avaliacao-v25.json
                  'benchmark-fila',         -- benchmark-fila.json
                  'benchmark-lotes'         -- benchmark-lotes.json
                )),
  id            TEXT NOT NULL,
  -- Conta ou visitante, sem FK: é só para filtrar "os meus".
  user_id       TEXT,
  status        TEXT,
  batch_id      TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc           JSONB NOT NULL,
  PRIMARY KEY (fila, id)
);

CREATE INDEX jobs_status_idx ON jobs (fila, status, criado_em);
CREATE INDEX jobs_batch_idx ON jobs (fila, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX jobs_user_idx ON jobs (fila, user_id, criado_em DESC);
