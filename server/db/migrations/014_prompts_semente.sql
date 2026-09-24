-- Semeadura que ATUALIZA prompts (demandas.md §20).
--
-- Antes, o boot só inseria o prompt que faltava: um texto corrigido nos arquivos
-- de semente nunca chegava a um banco que já tinha a versão velha. Agora cada
-- linha lembra o hash do conteúdo que a semente entregou (`semente_hash`). No
-- boot, se o conteúdo no banco ainda é exatamente o da semente (ninguém editou
-- pelo painel) e a semente mudou, o prompt é atualizado — com a versão anterior
-- no histórico, motivo 'semente'. Prompt editado pelo admin nunca é
-- sobrescrito.

ALTER TABLE prompt_arquivos ADD COLUMN semente_hash TEXT;

-- O que já está no banco foi semeado e não tem edição pelo painel que se
-- distinga dele: vira a semente de referência.
UPDATE prompt_arquivos SET semente_hash = encode(sha256(convert_to(conteudo, 'UTF8')), 'hex');

ALTER TABLE prompt_versoes DROP CONSTRAINT prompt_versoes_motivo_check;
ALTER TABLE prompt_versoes ADD CONSTRAINT prompt_versoes_motivo_check
  CHECK (motivo IN ('edicao', 'restauracao', 'exclusao', 'semente'));
