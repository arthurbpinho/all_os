-- Integridade depois da migração delta (server/migrar-delta.js). Só lê; toda
-- linha tem de dar 0, menos as duas últimas, que são informativas.
--
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$(cat ~/.neon-url)" -X -A -F ' | ' -t -f scripts/validar-delta.sql
SELECT 'professor inexistente ou não-aluno com professor', count(*) FROM users a LEFT JOIN users p ON p.id = a.teacher_id WHERE a.teacher_id IS NOT NULL AND (p.id IS NULL OR a.role NOT IN ('therapist', 'external'));
SELECT 'username repetido (sem caixa)', count(*) FROM (SELECT lower(username) FROM users GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'e-mail repetido (sem caixa)', count(*) FROM (SELECT lower(email) FROM users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;
SELECT 'e-mail vazio (deveria ser NULL)', count(*) FROM users WHERE email = '';
SELECT 'e-mail verificado sem e-mail', count(*) FROM users WHERE email IS NULL AND email_verified;
SELECT 'senha vazia em conta viva', count(*) FROM users WHERE password_hash = '' AND excluido_em IS NULL;
SELECT 'hash que não é bcrypt', count(*) FROM users WHERE password_hash !~ '^\$2[aby]\$' AND excluido_em IS NULL;
SELECT 'nome vazio', count(*) FROM users WHERE name = '';
SELECT 'termos sem versão / versão sem data', count(*) FROM users WHERE (termos_aceito_em IS NULL) <> (termos_versao IS NULL);
SELECT 'sequência atrás do maior id', count(*) FROM users WHERE id > pg_sequence_last_value(pg_get_serial_sequence('users', 'id')::regclass);
SELECT 'recorde de paciente fora do catálogo', count(*) FROM character_records r WHERE NOT EXISTS (SELECT 1 FROM catalogo_itens c WHERE c.tipo = 'freeplay' AND c.id = r.character_id);
SELECT 'recorde de conta inexistente', count(*) FROM character_records r WHERE r.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id);
SELECT 'foto de catálogo sem caminho', count(*) FROM catalogo_itens WHERE tipo IN ('freeplay', 'exercicios') AND (doc->>'photoIcon' IS NULL OR doc->>'photoFull' IS NULL);
SELECT 'ordem repetida no catálogo', count(*) FROM (SELECT tipo, ordem FROM catalogo_itens GROUP BY 1, 2 HAVING count(*) > 1) x;
SELECT 'conquista resgatada fora da lista', count(*) FROM conquistas_resgatadas WHERE conquista_id NOT IN ('first_session', 'first_ranked', 'madrugador', 'changed_photo', 'invited_friend', 'constancia', 'papagaio', 'eficiencia', 'bom_garoto', 'centena', 'persistencia', 'duelista', 'consistente', 'simulacao_complete', 'excelencia', 'perfeicao', 'meteu_o_lacan', 'estrelinha', 'invicto', 'davi_golias');
SELECT 'sidequest ativa apontando p/ banco inexistente', count(*) FROM sidequests_ativas a WHERE NOT EXISTS (SELECT 1 FROM sidequests_banco b WHERE b.id = a.doc->>'sidequestId');
SELECT 'sidequest concluída repetida', count(*) FROM (SELECT user_id, doc FROM sidequests_concluidas GROUP BY 1, 2 HAVING count(*) > 1) x;
SELECT 'título qt-* sem a sidequest concluída', count(*) FROM users u WHERE u.active_title LIKE 'qt-%' AND NOT EXISTS (SELECT 1 FROM sidequests_concluidas s WHERE s.user_id = u.id AND s.recompensa_id = u.active_title);
SELECT 'dificuldade de paciente fora do catálogo', count(*) FROM mmr_characters m WHERE NOT EXISTS (SELECT 1 FROM catalogo_itens c WHERE c.tipo = 'freeplay' AND c.id = m.character_id);
SELECT 'dificuldade com critério inativo/inexistente', count(*) FROM mmr_characters m, jsonb_object_keys(m.estado->'criterios') k WHERE k NOT IN (SELECT id::text FROM criterios WHERE ativo);
SELECT '(info) fotos no avatar-pool', coalesce((SELECT jsonb_array_length(valor->'photos') FROM configuracoes WHERE chave = 'avatar-pool'), 0);
SELECT '(info) chaves do bloco settings', (SELECT string_agg(k, ',' ORDER BY k) FROM configuracoes, jsonb_object_keys(valor) k WHERE chave = 'settings');
