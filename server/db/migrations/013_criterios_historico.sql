-- Histórico de um critério quando o admin o edita (demandas.md §16.6).
--
-- O critério é identificado pelo nome. Ao editar, o admin escolhe:
--   · manter o histórico: as notas antigas continuam na média do perfil — mesmo
--     que o nome mude, o antigo fica em `nomes_anteriores` e aponta para este;
--   · zerar: a média recomeça em `historico_desde`, e notas de antes não contam.
-- Critério novo nasce sem nenhum dos dois, e sem notas começa do zero sozinho.

ALTER TABLE criterios ADD COLUMN historico_desde TIMESTAMPTZ;
ALTER TABLE criterios ADD COLUMN nomes_anteriores TEXT[] NOT NULL DEFAULT '{}';
