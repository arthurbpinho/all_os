-- Fotografia das tabelas que a migração delta toca, em JSON, para conferir a
-- origem contra o banco (scripts/validar-delta.py). Rode ANTES e DEPOIS da carga:
--
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql "$(cat ~/.neon-url)" -X -A -t -f scripts/validar-delta-export.sql -o antes.json
--
-- Só lê. A saída tem hash de senha e dados pessoais: guarde em pasta privada
-- (~/allos-backups/, chmod 600) e apague quando a conferência acabar.
SELECT json_build_object(
 'users', (SELECT json_agg(u ORDER BY id) FROM (
    SELECT id::text, username, name, role, teacher_id::text, password_hash, token_version, email, email_verified,
           gender, profile_photo, visual_description, share_appearance, sidequests_enabled, abordagem, active_title,
           update_all_os, update_allos, origem_canal, origem_detalhe, termos_aceito_em, termos_versao, criado_em, excluido_em
    FROM users) u),
 'seq', (SELECT pg_sequence_last_value(pg_get_serial_sequence('users', 'id')::regclass)),
 'contadores', (SELECT json_object_agg(user_id::text, mic_uses) FROM contadores_usuario),
 'catalogo', (SELECT json_agg(json_build_object('tipo', tipo, 'id', id, 'ordem', ordem, 'doc', doc)) FROM catalogo_itens),
 'records', (SELECT json_agg(json_build_object('character_id', character_id, 'score', score, 'user_id', user_id::text,
    'user_name', user_name, 'user_photo', user_photo, 'at', at, 'origem', origem)) FROM character_records),
 'configuracoes', (SELECT json_object_agg(chave, valor) FROM configuracoes),
 'resgatadas', (SELECT json_agg(json_build_object('user_id', user_id::text, 'conquista_id', conquista_id, 'em', resgatada_em)) FROM conquistas_resgatadas),
 'vistas', (SELECT json_object_agg(user_id::text, conquistas) FROM conquistas_vistas),
 'sq_banco', (SELECT json_object_agg(id, doc) FROM sidequests_banco),
 'sq_ativas', (SELECT json_object_agg(user_id::text, doc) FROM sidequests_ativas),
 'sq_concluidas', (SELECT json_agg(json_build_object('user_id', user_id::text, 'recompensa_id', recompensa_id, 'em', concluida_em, 'doc', doc)) FROM sidequests_concluidas),
 'feedback', (SELECT json_agg(row_to_json(f)) FROM feedback f),
 'mmr_characters', (SELECT json_object_agg(character_id, json_build_object('estado', estado, 'fontes', fontes)) FROM mmr_characters),
 'mmr_players', (SELECT count(*) FROM mmr_players),
 'logs', (SELECT json_object_agg(l.id, json_build_object(
    'criado_em', l.criado_em, 'user_id', l.user_id::text, 'visitante_id', l.visitante_id, 'user_name', l.user_name,
    'type', l.type, 'mode', l.mode, 'item_id', l.item_id, 'item_title', l.item_title, 'duration_seconds', l.duration_seconds,
    'score', l.score, 'criteria_scores', l.criteria_scores, 'evaluation', l.evaluation, 'eval_version', l.eval_version,
    'eval_parts_id', l.eval_parts_id, 'evaluation_pending', l.evaluation_pending, 'eval_batch_id', l.eval_batch_id,
    'mmr_before', l.mmr_before, 'mmr_after', l.mmr_after,
    'mensagens', (SELECT coalesce(json_agg(json_build_object('role', m.role, 'content', m.content, 'highlighted', m.highlighted,
                  'comment', m.comment) ORDER BY m.posicao), '[]'::json) FROM log_messages m WHERE m.log_id = l.id)))
    FROM logs l),
 'duels', (SELECT json_object_agg(id, json_build_object('token', token, 'status', status, 'challenger_id', challenger_id,
    'opponent_id', opponent_id, 'criado_em', criado_em, 'doc', doc)) FROM duels)
);
