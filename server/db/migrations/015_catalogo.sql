-- Catálogos editados pelo admin (demandas.md §20): pacientes simulados,
-- casos de neuroavaliação, exercícios e competências da Trilha. Eram os arquivos
-- freeplay-characters.json, neuro-characters.json, exercises.json e
-- trilha-skills.json no volume.
--
-- Um documento JSONB por item, e não colunas: cada catálogo tem campos próprios
-- que o editor do admin muda com frequência (prompt, gabarito, modelo, foto…), e
-- o app sempre lê o catálogo inteiro. `ordem` preserva a ordem do arquivo — o
-- "Paciente em Destaque" é o último cadastrado.
--
-- CONTEÚDO SENSÍVEL: `doc` traz o prompt do paciente e o Bloco 1 (gabarito). As
-- rotas públicas continuam devolvendo só os campos do card.
-- As fotos continuam em disco (patient-photos/, exercise-photos/); o doc guarda
-- só o caminho.

CREATE TABLE catalogo_itens (
  tipo          TEXT NOT NULL CHECK (tipo IN ('freeplay', 'neuro', 'exercicios', 'trilha_skills')),
  id            TEXT NOT NULL,
  ordem         INTEGER NOT NULL,
  doc           JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, id)
);

CREATE INDEX catalogo_itens_ordem_idx ON catalogo_itens (tipo, ordem);
