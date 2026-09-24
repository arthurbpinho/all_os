-- Nome de cada critério no momento da avaliação ({"1": "Manejo do vínculo", ...}).
-- O gráfico do perfil (demandas.md §16.3) junta as sessões pelo nome: quando o
-- admin acrescenta, renomeia ou reordena critérios, o número deixa de identificar.
-- Logs antigos ficam NULL e caem nos nomes atuais da régua que os corrigiu.
ALTER TABLE logs ADD COLUMN criteria_names JSONB;
