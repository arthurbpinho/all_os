"""Confere a migração delta (server/migrar-delta.js): origem × banco, campo a campo.

Uso:
  python3 -I scripts/validar-delta.py <pasta data> <antes.json> <depois.json>

<antes.json> e <depois.json> saem de scripts/validar-delta-export.sql, rodado
antes e depois da carga. Confere TODOS os registros do escopo, aplicando as mesmas
regras de conflito da migração, e mostra uma amostra aleatória de 24. Imprime só
ids, contagens e nomes de campo — nunca valores pessoais. Sai com código 1 se
houver divergência.
"""
import hashlib
import json
import os
import random
import sys
from datetime import datetime, timezone

pasta, antes_p, depois_p = sys.argv[1:4]
L = lambda f: json.load(open(os.path.join(pasta, f), encoding='utf-8'))
antes = json.load(open(antes_p, encoding='utf-8'))
D = json.load(open(depois_p, encoding='utf-8'))
norm = lambda s: str(s if s is not None else '').strip().lower()
CONQ = {'first_session', 'first_ranked', 'madrugador', 'changed_photo', 'invited_friend', 'constancia', 'papagaio',
        'eficiencia', 'bom_garoto', 'centena', 'persistencia', 'duelista', 'consistente', 'simulacao_complete',
        'excelencia', 'perfeicao', 'meteu_o_lacan', 'estrelinha', 'invicto', 'davi_golias'}


def ts(v):
    if v in (None, ''):
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000, timezone.utc)
    return datetime.fromisoformat(str(v).replace('Z', '+00:00'))


falhas = []
conferidos = {}  # tipo -> [(chave, n_campos, divergencias)]


def confere(tipo, chave, pares):
    """pares: {campo: (esperado, obtido)}"""
    div = [c for c, (e, o) in pares.items() if e != o]
    conferidos.setdefault(tipo, []).append((chave, len(pares), div))
    for c in div:
        falhas.append(f'{tipo} {chave}: campo {c} diferente')


# ---------------------------------------------------------------- contas
users = L('users.json')
nb_antes = {u['id']: u for u in antes['users'] or []}
du = {u['id']: u for u in D['users']}
for u in users:
    r = du.get(u['id'])
    if not r:
        falhas.append(f'conta {u["id"]} não está no banco')
        continue
    a = nb_antes.get(u['id'])
    termos = (u.get('consentimento') or {}).get('termos') or {}
    origem = u.get('origem') or {}
    email = norm(u.get('email')) or None
    tv = u.get('tokenVersion') or 0
    # Regras: username de conta existente fica o do banco; senha = lado com token_version maior.
    exp_user = a['username'] if a else u['username']
    if a and a['token_version'] > tv:
        exp_tv, exp_pw = a['token_version'], None  # hash do banco (comparado por md5 abaixo)
    else:
        exp_tv, exp_pw = tv, u['passwordHash']
    pares = {
        'username': (exp_user, r['username']),
        'name': (u.get('name') or '', r['name']),
        'role': (u['role'], r['role']),
        'teacher_id': (u.get('teacherId') or None, r['teacher_id']),
        'token_version': (exp_tv, r['token_version']),
        'email': (email, r['email']),
        'email_verified': (bool(email and u.get('emailVerified')), r['email_verified']),
        'gender': (u.get('gender') or '', r['gender']),
        'profile_photo': (u.get('profilePhoto') or '', r['profile_photo']),
        'visual_description': (u.get('visualDescription'), r['visual_description']),
        'share_appearance': (None if u.get('shareAppearance') is None else bool(u['shareAppearance']), r['share_appearance']),
        'sidequests_enabled': (u.get('sidequestsEnabled') is not False, r['sidequests_enabled']),
        'abordagem': ((u.get('abordagem') or '')[:120], r['abordagem']),
        'active_title': (u.get('activeTitle') or '', r['active_title']),
        'update_all_os': (bool(u.get('updateAllOS')), r['update_all_os']),
        'update_allos': (bool(u.get('updateAllos')), r['update_allos']),
        'origem_canal': (origem.get('canal') or None, r['origem_canal']),
        'origem_detalhe': ((origem.get('detalhe') or '') if origem.get('canal') else None, r['origem_detalhe']),
        'termos_aceito_em': (ts(termos.get('em')), ts(r['termos_aceito_em'])),
        'termos_versao': (str(termos.get('versao') or '1') if termos.get('em') else None, r['termos_versao']),
        'excluido_em': (None, r['excluido_em']),
    }
    if exp_pw is not None:
        pares['password_hash'] = (exp_pw, r['password_hash'])
    else:
        pares['password_hash (o do banco)'] = (a['password_hash'], r['password_hash'])
    if not a and u.get('criadoEm'):
        pares['criado_em'] = (ts(u['criadoEm']), ts(r['criado_em']))
    confere('contas', u['id'], pares)
extra = sorted(set(du) - {u['id'] for u in users}, key=int)
if extra:
    falhas.append(f'contas no banco que não estão no JSON: {extra}')

# ------------------------------------------------------------ contadores
cont = L('counters.json')
for k, v in cont.items():
    if k == '__meta':
        continue
    neon_antes = (antes['contadores'] or {}).get(k, 0)
    confere('contadores', k, {'mic_uses': (max(v.get('micUses', 0), neon_antes), D['contadores'].get(k))})

# ------------------------------------------------------------- catálogos
cat = {(c['tipo'], c['id']): c for c in D['catalogo']}
for tipo, f in [('freeplay', 'freeplay-characters.json'), ('neuro', 'neuro-characters.json'),
                ('exercicios', 'exercises.json'), ('trilha_skills', 'trilha-skills.json')]:
    for i, it in enumerate(L(f), 1):
        c = cat.get((tipo, str(it['id'])))
        if not c:
            falhas.append(f'catálogo {tipo} {it["id"]} ausente')
            continue
        confere('catálogo', f'{tipo}/{it["id"]}', {'doc': (it, c['doc']), 'ordem': (i, c['ordem'])})

# -------------------------------------------------------------- recordes
rec = {r['character_id']: r for r in D['records']}
rec_antes = {r['character_id']: r for r in antes['records'] or []}
for cid, r in L('character-records.json').items():
    d = rec.get(cid)
    a = rec_antes.get(cid)
    if a and a['score'] >= r['score']:
        confere('recordes', cid, {'score': (a['score'], d['score']), 'user_id': (a['user_id'], d['user_id'])})
    else:
        confere('recordes', cid, {'score': (r['score'], d['score']), 'user_id': (str(r['userId']), d['user_id']),
                                  'user_name': (r.get('userName') or '', d['user_name']), 'user_photo': (r.get('userPhoto'), d['user_photo']),
                                  'at': (ts(r['at']), ts(d['at'])), 'origem': ('competitivo', d['origem'])})

# --------------------------------------------------------- configurações
cfg = D['configuracoes']
confere('configurações', 'avatar-pool', {'valor': ({'photos': L('avatar-pool.json')['photos']}, cfg.get('avatar-pool'))})
s = L('settings.json')
confere('configurações', 'settings(senha do seletivo)', {k: (s[k], cfg['settings'].get(k)) for k in ('selecaoPassword', 'selecaoPasswordUpdatedAt', 'selecaoPasswordUpdatedBy')})

# ------------------------------------------------------------ conquistas
res = {(r['user_id'], r['conquista_id']): r for r in D['resgatadas']}
esperadas = 0
for dono, mapa in L('achievements.json').items():
    if not dono.isdigit():
        continue
    for cq, em in mapa.items():
        if cq not in CONQ:
            if (dono, cq) in res:
                falhas.append(f'conquista removida {dono}/{cq} entrou no banco')
            continue
        esperadas += 1
        r = res.get((dono, cq))
        confere('conquistas resgatadas', f'{dono}/{cq}', {'existe': (True, r is not None), 'em': (ts(em), ts(r['em']) if r else None)})
vis = D['vistas']
for dono, ids in L('achievement-unlocks.json').items():
    confere('conquistas vistas', dono, {'contém tudo do JSON': (True, set(ids) <= set(vis.get(dono, [])))})
for dono, ids in (antes['vistas'] or {}).items():
    confere('conquistas vistas', f'{dono} (do banco)', {'manteve o que o banco tinha': (True, set(ids) <= set(vis.get(dono, [])))})

# ------------------------------------------------------------ sidequests
sq = L('sidequests.json')
for b in sq['bank']:
    confere('sidequests', f'banco/{b["id"]}', {'doc': (b, D['sq_banco'].get(b['id']))})
for dono, doc in sq['active'].items():
    confere('sidequests', f'ativa/{dono}', {'doc': (doc, D['sq_ativas'].get(dono))})
conc = D['sq_concluidas'] or []
for dono, docs in sq['completed'].items():
    for doc in docs:
        achados = [c for c in conc if c['user_id'] == dono and c['doc'] == doc]
        confere('sidequests', f'concluída/{dono}', {'uma linha só': (1, len(achados)),
                                                   'recompensa_id': (doc.get('rewardTitleId'), achados[0]['recompensa_id'] if achados else None)})

# --------------------------------------------------------------- feedback
fb = {f['id']: f for f in (D['feedback'] or [])}
for f in L('feedback.json'):
    d = fb.get(f['id'])
    confere('feedback', f['id'], {'user_id': (f.get('userId'), d and d['user_id']), 'stars': (f.get('stars'), d and d['stars']),
                                  'message': (f.get('message') or '', d and d['message']), 'criado_em': (ts(f['timestamp']), ts(d['criado_em']) if d else None)})

# ------------------------------------------------- dificuldade de partida
m = L('mmr.json')['characters']
for cid, c in m.items():
    d = D['mmr_characters'].get(cid)
    if c.get('n_D', 0) >= 20:
        crit = (d or {}).get('estado', {}).get('criterios', {})
        confere('dificuldade', cid, {'8 critérios': (8, len(crit)),
                                     'D': (round(max(10, min(90, c['D'])) * 100) / 100, {v['D'] for v in crit.values()}.pop() if crit else None),
                                     'n_D zerado': (True, all(v['n_D'] == 0 and v['historico'] == [] and v['beta'] == 1 for v in crit.values())),
                                     'fontes vazias': ({}, (d or {}).get('fontes'))})
    else:
        confere('dificuldade', cid, {'sem estado (nasce em 50)': (None, d)})

# ------------------------------------------------------------------- logs
dl = D.get('logs') or {}
for l in L('logs.json') if os.path.exists(os.path.join(pasta, 'logs.json')) else []:
    r = dl.get(l['id'])
    if not r:
        falhas.append(f'log {l["id"]} não está no banco')
        continue
    conta = str(l.get('userId', '')).isdigit()
    msgs = [{'role': m.get('role'), 'content': m.get('content') or '', 'highlighted': bool(m.get('highlighted')),
             'comment': m.get('comment') or ''} for m in l.get('messages') or []]
    confere('logs', l['id'], {
        'criado_em': (ts(l.get('timestamp')), ts(r['criado_em'])),
        'dono': ((l['userId'], None) if conta else (None, l['userId']), (r['user_id'], r['visitante_id'])),
        'user_name': (l.get('userName') or '', r['user_name']), 'type': (l['type'], r['type']),
        'mode': (l.get('mode') or 'training', r['mode']), 'item_id': (str(l.get('itemId') or ''), r['item_id']),
        'item_title': (l.get('itemTitle') or '', r['item_title']), 'duration_seconds': (int(l.get('durationSeconds') or 0), r['duration_seconds']),
        'score': (l.get('score'), r['score']), 'criteria_scores': (l.get('criteriaScores'), r['criteria_scores']),
        'evaluation': (l.get('evaluation') or '', r['evaluation']), 'eval_version': (l.get('evalVersion'), r['eval_version']),
        'eval_parts_id': (l.get('evalPartsId'), r['eval_parts_id']), 'evaluation_pending': (bool(l.get('evaluationPending')), r['evaluation_pending']),
        'eval_batch_id': (l.get('evalBatchId'), r['eval_batch_id']),
        'mmr_before': (l.get('mmrBefore'), r['mmr_before']), 'mmr_after': (l.get('mmrAfter'), r['mmr_after']),
        'mensagens (todas, na ordem)': (msgs, r['mensagens']),
    })

dd = D.get('duels') or {}
for d in L('duels.json') if os.path.exists(os.path.join(pasta, 'duels.json')) else []:
    r = dd.get(d['id']) or {}
    confere('duelos', d['id'], {'token': (d['token'], r.get('token')), 'status': (d['status'], r.get('status')),
                                'challenger_id': (str((d.get('challenger') or {}).get('userId')), r.get('challenger_id')),
                                'opponent_id': (str((d.get('opponent') or {}).get('userId')), r.get('opponent_id')),
                                'doc': (d, r.get('doc'))})

# ----------------------------------------------------------- relatório
print('== Conferência completa (origem × banco), por tipo')
for tipo, itens in conferidos.items():
    n_div = sum(1 for _, _, d in itens if d)
    print(f'  {tipo:24} {len(itens):4} registros, {sum(n for _, n, _ in itens):5} campos conferidos, {n_div} com divergência')
print(f'  sequência de ids: {D["seq"]} (JSON lastUserId = {L("counters.json")["__meta"]["lastUserId"]})')
print(f'  mmr_players (alunos): {D["mmr_players"]} — esperado 0 (motor recomeça)')
print(f'  conquistas resgatadas esperadas: {esperadas} | no banco: {len(res)}')

print('\n== Amostra aleatória (semente 20261013): 24 registros, ponta a ponta')
rng = random.Random(20261013)
todos = [(t, k, n, d) for t, itens in conferidos.items() for (k, n, d) in itens]
for t, k, n, d in rng.sample(todos, 24):
    print(f'  {t:24} {k:42} {n:2} campos  {"OK" if not d else "DIVERGE: " + ", ".join(d)}')

print('\n== Resultado:', 'NENHUMA divergência' if not falhas else f'{len(falhas)} divergência(s)')
for f in falhas[:50]:
    print('  -', f)
sys.exit(1 if falhas else 0)
