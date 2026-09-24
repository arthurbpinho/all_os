-- Sidequests (exercícios do supervisor e missão diária) e mapas da Antessala:
-- substitui sidequests.json e antessala.json.


-- SIDEQUESTS. Três partes, como no arquivo:
--   banco      → catálogo reutilizável, editado por supervisor/admin;
--   ativas     → a sidequest atribuída a cada aluno (no máximo uma);
--   concluídas → histórico com o título de recompensa, que vira título de perfil.
-- Cada definição/atribuição/conclusão é um documento com o formato de sempre.
CREATE TABLE sidequests_banco (
  id        TEXT PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc       JSONB NOT NULL
);

CREATE TABLE sidequests_ativas (
  user_id      BIGINT PRIMARY KEY REFERENCES users (id),
  atribuida_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc          JSONB NOT NULL
);

CREATE TABLE sidequests_concluidas (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users (id),
  -- O título de recompensa (qt-…): a missão diária não se repete por recompensa.
  recompensa_id TEXT,
  concluida_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc           JSONB NOT NULL
);

CREATE INDEX sidequests_concluidas_user_idx ON sidequests_concluidas (user_id, concluida_em, id);


-- ANTESSALA: um mapa de caso por linha. O corpo do mapa (fatos, saídas,
-- armadilhas…) é um documento aninhado que a tela lê e grava inteiro; as chaves
-- de busca (dono, status, datas) viram colunas. Entregue, o mapa congela.
CREATE TABLE antessala_mapas (
  id            TEXT PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users (id),
  status        TEXT NOT NULL CHECK (status IN ('draft', 'delivered')),
  criado_em     TIMESTAMPTZ NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL,
  doc           JSONB NOT NULL
);

CREATE INDEX antessala_mapas_owner_idx ON antessala_mapas (owner_id, atualizado_em DESC);
CREATE INDEX antessala_mapas_entregues_idx ON antessala_mapas (owner_id) WHERE status = 'delivered';
