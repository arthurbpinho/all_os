-- Reset one-shot do estado do motor de MMR/TRI, para a virada da fórmula por
-- critério (demandas.md §24.4, spec §11).
--
-- Antes do TRUNCATE, o estado atual é arquivado em tabelas de leitura, para
-- ficar "consultável" (spec §11 é explícita: "preservado de forma consultável
-- antes de zerar, e não apagado"). O acesso ao arquivo é via SQL direto no
-- Neon — sem rota, sem UI (§24 do demandas.md, decisão do dono).
--
-- character_records NÃO é tocada: os recordes 👑 são mantidos (spec §11).
--
-- Esta migração roda uma única vez, garantido pelo marcador em db_migracoes.
-- O código do motor novo (server/mmr.js) precisa estar no processo que roda
-- este arquivo — as tabelas do motor ficam vazias até a próxima avaliação, e
-- o formato do JSONB gravado a partir daí é o novo.

-- 1) Arquivo pré-reforma
CREATE TABLE IF NOT EXISTS mmr_players_arquivo_v1 (
  user_id       BIGINT PRIMARY KEY,
  estado        JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL,
  arquivado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mmr_characters_arquivo_v1 (
  character_id  TEXT PRIMARY KEY,
  estado        JSONB NOT NULL,
  fontes        JSONB NOT NULL DEFAULT '{}',
  atualizado_em TIMESTAMPTZ NOT NULL,
  arquivado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mmr_anon_players_arquivo_v1 (
  pool          TEXT PRIMARY KEY,
  estado        JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL,
  arquivado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mmr_players_arquivo_v1 (user_id, estado, atualizado_em)
SELECT user_id, estado, atualizado_em FROM mmr_players
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO mmr_characters_arquivo_v1 (character_id, estado, fontes, atualizado_em)
SELECT character_id, estado, fontes, atualizado_em FROM mmr_characters
ON CONFLICT (character_id) DO NOTHING;

INSERT INTO mmr_anon_players_arquivo_v1 (pool, estado, atualizado_em)
SELECT pool, estado, atualizado_em FROM mmr_anon_players
ON CONFLICT (pool) DO NOTHING;

-- 2) Reset do motor
TRUNCATE mmr_players;
TRUNCATE mmr_characters;
TRUNCATE mmr_anon_players;
