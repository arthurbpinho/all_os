-- Notificações, push, conquistas, contadores e o que é da operação (logs de
-- erro, feedback, configurações do admin): substitui notifications.json,
-- push-subscriptions.json, achievements.json, achievement-unlocks.json,
-- counters.json, daily-missions.json, error-logs.json, feedback.json,
-- settings.json e avatar-pool.json.


-- NOTIFICAÇÕES (sino). Uma linha por notificação. O conteúdo varia por tipo
-- (convite de duelo, resultado, aviso do admin…) e fica em `doc`; `ordem` é a
-- posição no sino — uma notificação ATUALIZADA (fila → pronta) volta ao topo.
-- O sino guarda as 50 mais recentes por pessoa.
CREATE SEQUENCE notificacoes_ordem_seq;

CREATE TABLE notificacoes (
  id        TEXT PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users (id),
  -- Chave de atualização (ex.: 'log:<id>'): a mesma avaliação é UMA notificação.
  ref_id    TEXT,
  lida      BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ordem     BIGINT NOT NULL DEFAULT nextval('notificacoes_ordem_seq'),
  doc       JSONB NOT NULL
);

CREATE INDEX notificacoes_user_idx ON notificacoes (user_id, ordem DESC);
CREATE UNIQUE INDEX notificacoes_ref_idx ON notificacoes (user_id, ref_id) WHERE ref_id IS NOT NULL;


-- WEB PUSH: um dispositivo assinado por linha (até 10 por pessoa).
CREATE SEQUENCE push_inscricoes_ordem_seq;

CREATE TABLE push_inscricoes (
  user_id   BIGINT NOT NULL REFERENCES users (id),
  endpoint  TEXT NOT NULL,
  p256dh    TEXT NOT NULL,
  auth      TEXT NOT NULL,
  ua        TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ordem     BIGINT NOT NULL DEFAULT nextval('push_inscricoes_ordem_seq'),
  PRIMARY KEY (user_id, endpoint)
);


-- CONQUISTAS resgatadas (claim) e as já avisadas no sino.
CREATE TABLE conquistas_resgatadas (
  user_id      BIGINT NOT NULL REFERENCES users (id),
  conquista_id TEXT NOT NULL,
  resgatada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conquista_id)
);

-- As desbloqueadas que o sino já avisou. A primeira gravação é a linha de base
-- silenciosa (não avisa tudo que a pessoa já tinha).
CREATE TABLE conquistas_vistas (
  user_id     BIGINT PRIMARY KEY REFERENCES users (id),
  conquistas  TEXT[] NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contadores por pessoa (uso do microfone, para a conquista "Papagaio").
CREATE TABLE contadores_usuario (
  user_id  BIGINT PRIMARY KEY REFERENCES users (id),
  mic_uses INTEGER NOT NULL DEFAULT 0
);

-- Sequência de dias com todas as missões diárias completas ("Bom garoto").
CREATE TABLE sequencia_missoes_diarias (
  user_id     BIGINT PRIMARY KEY REFERENCES users (id),
  atual       INTEGER NOT NULL DEFAULT 0,
  melhor      INTEGER NOT NULL DEFAULT 0,
  -- Dia (AAAA-MM-DD, dayKey do index.js) da última contagem.
  ultima_data TEXT
);


-- LOGS DE ERRO (painel do admin). A entrada é a de server/error-log.js, inteira.
-- Retenção: 30 dias e no máximo 500 entradas.
CREATE TABLE erros (
  id        TEXT PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL,
  entrada   JSONB NOT NULL
);

CREATE INDEX erros_criado_em_idx ON erros (criado_em DESC);

-- FEEDBACK do popup de fim de sessão. Visitante também manda, por isso sem FK.
CREATE TABLE feedback (
  id        TEXT PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   TEXT,
  user_name TEXT NOT NULL DEFAULT '',
  role      TEXT NOT NULL DEFAULT '',
  stars     INTEGER NOT NULL DEFAULT 0,
  message   TEXT NOT NULL DEFAULT ''
);

-- CONFIGURAÇÕES escolhidas pelo admin, uma linha por bloco ('settings',
-- 'avatar-pool', …). São lidas em quase toda requisição e mudam raramente; o
-- app mantém uma cópia em memória e cada alteração trava só o seu bloco.
CREATE TABLE configuracoes (
  chave         TEXT PRIMARY KEY,
  valor         JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
