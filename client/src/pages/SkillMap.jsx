import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { SKILL_NAMES, SKILL_COLORS } from '../prompts';

// Ordem de exibição das competências no menu conversacional (pedido do produto):
// Hermenêutica, Personalidade, Estrutura, Especificidade do caso, Empatia.
const MENU_ORDER = [1, 5, 2, 4, 3];

// Aprovação na fase: nota (porcentagem 0–100) ≥ 75 libera a próxima.
const PASS = 75;

// Dificuldade representada por cor (verde / laranja / vermelho), sem texto.
const DIFFICULTY_ORDER = { iniciante: 0, intermediario: 1, avancado: 2 };
const DIFFICULTY_COLOR = {
  iniciante: '#3FA45E',     // verde   — fácil
  intermediario: '#E08A3C', // laranja — médio
  avancado: '#C0453A',      // vermelho— avançado
};
function diffColor(ex) {
  return DIFFICULTY_COLOR[ex?.difficulty] || DIFFICULTY_COLOR.iniciante;
}

// Geometria da trilha sinuosa (estilo Duolingo). Espaço de coordenadas fixo de
// 320px de largura, centralizado — os nós são posicionados em px nesse espaço.
const INNER_W = 320;
const CENTER_X = 160;
const AMP = 92;
const STEP = 112;
const PAD_TOP = 82;
const PAD_BOTTOM = 92;
const NODE_R = 33;
const xFor = (i) => CENTER_X + AMP * Math.sin(i * 0.7);
const yFor = (i) => PAD_TOP + i * STEP;

function shade(hex, percent) {
  const c = (hex || '#000000').replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const adj = (v) => Math.max(0, Math.min(255, Math.round(v + (percent < 0 ? v * percent : (255 - v) * percent))));
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return '#' + toHex(adj(r)) + toHex(adj(g)) + toHex(adj(b));
}

const LEVEL_THRESHOLDS = [3, 10, 30, 100]; // níveis 2,3,4,5

// ── Ícones inline ──
const IconCheck = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
);
const IconStar = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.6 5.8 21 7 14.1 2 9.3 8.9 8.6" /></svg>
);
const IconLock = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
const IconFlame = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c.6 3-1.5 4.4-2.8 6C7.6 10.2 7 12 7 13.7 7 17.2 9.7 20 13 20c3.1 0 5.5-2.4 5.5-5.6 0-2.6-1.4-4.3-2.6-5.8-.4 1-1.2 1.7-2.2 1.9.7-1.9.5-5-1.7-8.5z" /></svg>
);
const IconArrowLeft = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
);
const IconChevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
);
const AvatarFallback = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></svg>
);

function firstName(name) {
  return (name || '').trim().split(/\s+/)[0] || 'aluno';
}

function levelFromCount(count) {
  let level = 1;
  for (const t of LEVEL_THRESHOLDS) if (count >= t) level++;
  return level;
}

export default function SkillMap({ user }) {
  const navigate = useNavigate();
  const [exercises, setExercises] = useState([]);
  const [progressMap, setProgressMap] = useState({});
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedSkill, setSelectedSkill] = useState(null);
  const [shakeId, setShakeId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [exList, prog, st] = await Promise.all([
          api.getExercises(),
          user?.id ? api.getProgress(user.id) : Promise.resolve({}),
          user?.id ? api.getTrilhaStats(user.id).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setExercises(exList || []);
        setProgressMap(prog || {});
        setStats(st);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Erro ao carregar a trilha');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Agrupa exercícios por competência e ordena as fases por dificuldade
  // (iniciante → intermediário → avançado) e, em empate, por ordem de criação.
  const bySkill = useMemo(() => {
    const map = {};
    for (let i = 1; i <= 5; i++) map[i] = [];
    for (const ex of exercises) {
      if (ex.skillId >= 1 && ex.skillId <= 5) map[ex.skillId].push(ex);
    }
    for (let i = 1; i <= 5; i++) {
      map[i].sort((a, b) => {
        const da = DIFFICULTY_ORDER[a.difficulty] ?? 1;
        const db = DIFFICULTY_ORDER[b.difficulty] ?? 1;
        if (da !== db) return da - db;
        return String(a.id).localeCompare(String(b.id));
      });
    }
    return map;
  }, [exercises]);

  function scoreOf(ex) {
    const p = progressMap[ex.id];
    return p && Number.isFinite(p.score) ? p.score : null;
  }
  function passedCount(skillId) {
    return (bySkill[skillId] || []).filter((ex) => { const s = scoreOf(ex); return s !== null && s >= PASS; }).length;
  }

  // Estados das fases de uma competência: 'done' | 'active' | 'locked'.
  function phaseStates(skillId) {
    const phases = bySkill[skillId] || [];
    let prevPassed = true;
    let activeFound = false;
    return phases.map((ex, i) => {
      const score = scoreOf(ex);
      const passed = score !== null && score >= PASS;
      const unlocked = i === 0 ? true : prevPassed;
      let state;
      if (passed) state = 'done';
      else if (unlocked && !activeFound) { state = 'active'; activeFound = true; }
      else state = 'locked';
      prevPassed = passed;
      return { ex, score, passed, unlocked: unlocked || passed, state };
    });
  }

  function openExercise(node) {
    if (node.state === 'locked') {
      setShakeId(node.ex.id);
      setTimeout(() => setShakeId(null), 480);
      return;
    }
    navigate(`/chat/exercise/${node.ex.id}`);
  }

  // ── Stats da barra superior ──
  const completed = stats?.completed ?? Object.values(progressMap).filter((p) => p && Number.isFinite(p.score) && p.score >= PASS).length;
  const level = stats?.level ?? levelFromCount(completed);
  const nextThreshold = stats?.nextThreshold ?? (level < 5 ? LEVEL_THRESHOLDS[level - 1] : null);
  const constancia = stats?.constancia || { current: 0, isAlive: false };
  const prevThreshold = level > 1 ? LEVEL_THRESHOLDS[level - 2] : 0;
  const levelPct = nextThreshold
    ? Math.max(0, Math.min(100, Math.round(((completed - prevThreshold) / (nextThreshold - prevThreshold)) * 100)))
    : 100;

  const TopBar = (
    <div className="trilha-topbar">
      <div className="trilha-id">
        <span className={`trilha-avatar ${constancia.isAlive ? 'with-streak' : ''}`}>
          {user?.profilePhoto ? <img src={user.profilePhoto} alt={user.name} /> : <AvatarFallback />}
        </span>
        <div className="trilha-id-text">
          <div className="trilha-hello">Olá, {firstName(user?.name)}</div>
          <div className="trilha-id-sub">{selectedSkill ? SKILL_NAMES[selectedSkill] : 'Trilha de competências'}</div>
        </div>
      </div>
      <div className="trilha-stats">
        <div className={`trilha-stat constancia ${constancia.isAlive ? 'alive' : ''}`} title="Constância — dias seguidos treinando">
          <span className="trilha-stat-icon"><IconFlame /></span>
          <span className="trilha-stat-num">{constancia.current}</span>
          <span className="trilha-stat-label">{constancia.current === 1 ? 'dia' : 'dias'}</span>
        </div>
        <div className="trilha-stat level" title={nextThreshold ? `${completed}/${nextThreshold} exercícios para o nível ${level + 1}` : 'Nível máximo'}>
          <div className="trilha-level-head"><span className="trilha-level-badge">Nv {level}</span><span className="trilha-stat-label">{nextThreshold ? `Nível ${level}` : 'Nível máx.'}</span></div>
          <div className="trilha-level-bar"><span style={{ width: `${levelPct}%` }} /></div>
        </div>
        <div className="trilha-stat done" title="Exercícios concluídos">
          <span className="trilha-stat-num">{completed}</span>
          <span className="trilha-stat-label">{completed === 1 ? 'exercício' : 'exercícios'}</span>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div>
        {TopBar}
        <div className="card" style={{ textAlign: 'center', padding: '60px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando trilha…</span>
        </div>
      </div>
    );
  }

  // ── Tela conversacional (if/else de escolhas) ──
  if (!selectedSkill) {
    return (
      <div className="trilha-screen">
        {TopBar}
        {error && <div className="alert error">{error}</div>}
        <div className="trilha-convo">
          <div className="trilha-convo-avatar">
            <img src="/profiles_icon/alloschar.jpeg" alt="allOS" />
          </div>
          <div className="trilha-convo-bubble">
            <p className="trilha-convo-greet">Olá, <strong>{firstName(user?.name)}</strong>!</p>
            <p>Qual competência você gostaria de treinar hoje?</p>
          </div>
        </div>
        <div className="trilha-choices">
          {MENU_ORDER.map((sid, i) => {
            const total = (bySkill[sid] || []).length;
            const done = passedCount(sid);
            const color = SKILL_COLORS[sid];
            const pct = total ? Math.round((done / total) * 100) : 0;
            const complete = total > 0 && done === total;
            return (
              <button
                key={sid}
                className="trilha-choice"
                onClick={() => setSelectedSkill(sid)}
                style={{ '--skill-color': color, animationDelay: `${i * 70}ms` }}
              >
                <span className="trilha-choice-badge" style={{ background: `linear-gradient(150deg, ${color}, ${shade(color, -0.22)})` }}>
                  {complete ? <IconCheck /> : <span className="trilha-choice-num">{i + 1}</span>}
                </span>
                <span className="trilha-choice-body">
                  <span className="trilha-choice-name">{SKILL_NAMES[sid]}</span>
                  <span className="trilha-choice-meta">
                    {total === 0 ? 'Em breve' : complete ? 'Competência concluída' : `${done} de ${total} ${total === 1 ? 'fase' : 'fases'}`}
                  </span>
                  {total > 0 && (
                    <span className="trilha-choice-bar"><span style={{ width: `${pct}%`, background: color }} /></span>
                  )}
                </span>
                <span className="trilha-choice-go" aria-hidden="true"><IconChevron /></span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Tela da trilha de uma competência ──
  const phases = phaseStates(selectedSkill);
  const color = SKILL_COLORS[selectedSkill];
  const total = phases.length;
  const done = phases.filter((p) => p.passed).length;
  const H = PAD_TOP + Math.max(0, total - 1) * STEP + PAD_BOTTOM;

  return (
    <div className="trilha-screen">
      {TopBar}
      <div className="trilha-view">
        <button className="trilha-back" onClick={() => setSelectedSkill(null)} title="Voltar à escolha de competência" aria-label="Voltar">
          <IconArrowLeft />
        </button>

        <div className="trilha-unit-band" style={{ background: `linear-gradient(135deg, ${color}, ${shade(color, -0.18)})` }}>
          <div className="trilha-unit-eyebrow">Competência</div>
          <h3>{SKILL_NAMES[selectedSkill]}</h3>
          <p>{total === 0 ? 'Nenhuma fase cadastrada ainda' : `${done} de ${total} ${total === 1 ? 'fase concluída' : 'fases concluídas'}`}</p>
        </div>

        {total === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--ink-soft)' }}>
            Ainda não há exercícios cadastrados para esta competência.
          </div>
        ) : (
          <div className="trilha-path-wrap">
            <div className="trilha-path" style={{ width: INNER_W, height: H }}>
              <svg className="trilha-connectors" width={INNER_W} height={H} viewBox={`0 0 ${INNER_W} ${H}`} aria-hidden="true">
                {phases.map((p, i) => {
                  if (i === total - 1) return null;
                  const lit = p.passed; // segmento "aceso" até onde a pessoa já passou
                  return (
                    <line
                      key={`seg-${i}`}
                      x1={xFor(i)} y1={yFor(i)} x2={xFor(i + 1)} y2={yFor(i + 1)}
                      stroke={lit ? shade(diffColor(p.ex), 0.35) : '#d4cab8'}
                      strokeWidth={7}
                      strokeLinecap="round"
                      strokeDasharray={lit ? 'none' : '1 13'}
                      opacity={lit ? 0.9 : 0.85}
                    />
                  );
                })}
              </svg>

              {phases.map((p, i) => {
                const cx = xFor(i);
                const cy = yFor(i);
                const dc = diffColor(p.ex);
                const isLocked = p.state === 'locked';
                const isActive = p.state === 'active';
                const isDone = p.state === 'done';
                // Fase concluída mostra a nota acima; fase ativa mostra a bolha
                // (que já inclui a nota quando houve tentativa abaixo de 75%).
                const showGrade = isDone && p.score !== null;
                const bubble = isActive ? (p.score !== null && p.score < PASS ? `${p.score}% · Refazer` : 'Começar') : null;
                return (
                  <div
                    key={p.ex.id}
                    className={`trilha-node-wrap ${shakeId === p.ex.id ? 'shake' : ''}`}
                    style={{ left: cx, top: cy }}
                  >
                    {showGrade && (
                      <span className={`trilha-grade ${p.passed ? 'pass' : 'fail'}`} style={p.passed ? { color: dc, borderColor: dc } : undefined}>
                        {p.score}%
                      </span>
                    )}
                    {bubble && <span className="trilha-bubble" style={{ background: dc, color: '#fff', '--bubble-bg': dc }}>{bubble}</span>}
                    <button
                      className={`trilha-node ${p.state}`}
                      onClick={() => openExercise(p)}
                      disabled={isLocked}
                      title={isLocked ? 'Conclua a fase anterior para desbloquear' : p.ex.title}
                      style={!isLocked ? { background: dc, borderColor: shade(dc, -0.28), boxShadow: isActive ? `0 0 0 6px ${dc}33, 0 8px 18px ${dc}44` : `0 6px 14px ${dc}33` } : undefined}
                    >
                      {isDone ? <IconCheck /> : isActive ? <IconStar /> : <IconLock />}
                    </button>
                    <span className={`trilha-node-label ${isLocked ? 'locked' : ''}`}>{p.ex.title}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
