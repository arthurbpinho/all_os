-- MMR, dificuldade dos pacientes (TRI), recordes 👑 e duelos: substitui
-- mmr.json, character-records.json e duels.json.
--
-- ESTADO DO MMR EM JSONB. O motor (server/mmr.js) é puro e é dono do formato do
-- estado: P, n e a janela W do jogador; D, n_D, a regressão e o histórico do
-- paciente. Guardar esse estado no formato do motor evita acoplar o schema ao
-- algoritmo. O que o banco resolve é o que o arquivo não resolvia: cada partida
-- é aplicada numa transação que trava SÓ as linhas envolvidas (o paciente e o(s)
-- jogador(es)). No arquivo, toda partida relia e regravava o MMR de todo mundo.

CREATE TABLE mmr_players (
  user_id       BIGINT PRIMARY KEY REFERENCES users (id),
  estado        JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mmr_characters (
  character_id  TEXT PRIMARY KEY,
  estado        JSONB NOT NULL,
  -- De onde vieram os atendimentos que mexeram na dificuldade (competitivo,
  -- selecao, visitante). O `charSources` do mmr.json; só a dashboard de TRI lê.
  fontes        JSONB NOT NULL DEFAULT '{}',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Populações anônimas (Processo Seletivo, visitante): cada uma é um "jogador"
-- persistente que aprende o nível do grupo (ver mmr.js, newAnonPopulation).
CREATE TABLE mmr_anon_players (
  pool          TEXT PRIMARY KEY,
  estado        JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Recorde 👑 de cada paciente: a maior nota do Competitivo. Permanente — por
-- isso não mora nos logs, que expiram em 30 dias.
CREATE TABLE character_records (
  character_id TEXT PRIMARY KEY,
  score        DOUBLE PRECISION NOT NULL,
  user_id      BIGINT REFERENCES users (id),
  user_name    TEXT NOT NULL DEFAULT '',
  user_photo   TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- DUELOS. O duelo é um documento aninhado (os dois lados, cada um com a sessão
-- enviada, e o resultado) que as rotas leem e alteram inteiro. Fica em JSONB,
-- uma linha por duelo, com as chaves de busca extraídas em colunas. Alterar um
-- duelo trava só aquele duelo.
--
-- Exceção consciente à regra "uma linha por mensagem" (perguntas.md): as
-- mensagens de cada lado ficam dentro do documento. Não é conversa ao vivo — é a
-- transcrição enviada uma vez, no fim da sessão, e sempre lida junto com o duelo.
CREATE TABLE duels (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  criado_em     TIMESTAMPTZ NOT NULL,
  -- Conta ou visitante (`visitor-…`), por isso sem FK.
  challenger_id TEXT,
  opponent_id   TEXT,
  doc           JSONB NOT NULL
);

CREATE INDEX duels_challenger_idx ON duels (challenger_id);
CREATE INDEX duels_opponent_idx ON duels (opponent_id);
-- Retenção de 30 dias (CLAUDE.md §5.5).
CREATE INDEX duels_criado_em_idx ON duels (criado_em);
