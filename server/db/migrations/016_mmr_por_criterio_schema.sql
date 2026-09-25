-- Reforma do MMR e TRI por critério (demandas.md §24, spec MMR-por-criterio.md).
-- Esta migração só mexe no SCHEMA. O reset do estado (TRUNCATE das tabelas do
-- motor) vive na 017, junto com o snapshot pré-reforma em *_arquivo_v1.
--
-- Motor por dentro (formato do JSONB de mmr_players/mmr_characters/mmr_anon_players)
-- é responsabilidade de server/mmr.js — não sai daqui.

-- 1) character_records: recorde passa a poder vir do Processo Seletivo (spec §9).
--    O candidato não tem linha em `users`, então:
--      · a FK de user_id sai (a coluna vira BIGINT nullable, como duels.challenger_id);
--      · nova coluna `origem`: 'competitivo' (o que já existia) ou 'selecao';
--      · para candidato, `user_name` copia selecao_logs.doc.candidate.nome no
--        momento do recorde — a ficha do caso segue funcionando mesmo se o log
--        do candidato sumir.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.table_name = 'character_records'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'user_id'
  LIMIT 1;
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE character_records DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

ALTER TABLE character_records
  ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'competitivo';

-- 2) logs: guardar a auditoria de MMR antes/depois por critério e total
--    (spec §12: "MMR antes e depois, por critério e total" por avaliação).
--    Sem coluna, a janela de mmr_players só guarda "antes" das últimas 10.
--    Com a persistência da §24.0 valendo, a auditoria completa cabe no log.
ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS mmr_delta JSONB;

-- 3) logs.criteria_scores: sem backfill. Logs velhos continuam com chave
--    posicional ("1","2",…); logs novos entram com o id estável de criterios.id
--    (spec §17 e §24.2 do demandas.md). O front reconstrói a identidade via
--    criteria_names + join com criterios.
