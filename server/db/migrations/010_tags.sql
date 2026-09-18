-- Tags de terapeutas (demandas.md §16.4): rótulos livres que o admin cria
-- ("neuropsicólogo", "psicanalista") e aplica às contas, e que filtram o ranking
-- e os logs. Não é turma nem vínculo com professor.

CREATE TABLE tags (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome      TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Psicanalista" e "psicanalista" são a mesma tag.
CREATE UNIQUE INDEX tags_nome_idx ON tags (lower(nome));

CREATE TABLE user_tags (
  user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tag_id  BIGINT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, tag_id)
);

CREATE INDEX user_tags_tag_idx ON user_tags (tag_id);
