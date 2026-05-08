import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { SKILL_NAMES, SKILL_COLORS } from '../prompts';
import Typewriter from '../components/Typewriter';

const VIEW_W = 1200;
const VIEW_H = 820;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const SKILL_RADIUS = 70;
const EXERCISE_RADIUS = 36;
const PENTAGON_DIST = 280;          // distância do centro até o pilar (overview)
const ORBIT_RADIUS_ZOOMED = 250;    // raio da órbita quando zoomed
const PENTAGON_ANGLES_DEG = [270, 342, 54, 126, 198];

const degToRad = (deg) => (deg * Math.PI) / 180;

function getSkillPosition(index) {
  const angle = degToRad(PENTAGON_ANGLES_DEG[index]);
  return {
    x: CENTER_X + PENTAGON_DIST * Math.cos(angle),
    y: CENTER_Y + PENTAGON_DIST * Math.sin(angle),
  };
}

// Posições orbitais dos exercícios em torno do centro (modo zoomed)
function getZoomedExercisePositions(count) {
  if (count === 0) return [];
  const positions = [];
  // Distribui em círculo completo. Para 1 exercício, posiciona à direita.
  // Para 2, esquerda/direita. 3+, círculo igual.
  const startDeg = count === 1 ? 0 : count === 2 ? 0 : -90;
  const stepDeg = count === 1 ? 0 : 360 / count;
  for (let i = 0; i < count; i++) {
    const ang = degToRad(startDeg + stepDeg * i);
    positions.push({
      x: CENTER_X + ORBIT_RADIUS_ZOOMED * Math.cos(ang),
      y: CENTER_Y + ORBIT_RADIUS_ZOOMED * Math.sin(ang),
    });
  }
  return positions;
}

function wrapText(text, maxChars) {
  const words = (text || '').split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function truncate(text, max) {
  return text && text.length > max ? text.slice(0, max - 1) + '…' : text || '';
}

function shade(hex, percent) {
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const adj = (v) => {
    const out = Math.round(v + (percent < 0 ? v * percent : (255 - v) * percent));
    return Math.max(0, Math.min(255, out));
  };
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return '#' + toHex(adj(r)) + toHex(adj(g)) + toHex(adj(b));
}

export default function SkillMap({ user }) {
  const navigate = useNavigate();
  const [exercises, setExercises] = useState([]);
  const [progressMap, setProgressMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hoveredNode, setHoveredNode] = useState(null);
  const [zoomedSkill, setZoomedSkill] = useState(null);
  const [pulsingExercise, setPulsingExercise] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const shellRef = useRef(null);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, originTx: 0, originTy: 0, pointerId: null });

  function getSvgPoint(clientX, clientY) {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const t = pt.matrixTransform(ctm.inverse());
    return { x: t.x, y: t.y };
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    function onWheel(e) {
      e.preventDefault();
      const pt = getSvgPoint(e.clientX, e.clientY);
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = Math.max(0.5, Math.min(6, v.scale * factor));
        const k = newScale / v.scale;
        return {
          scale: newScale,
          tx: pt.x - (pt.x - v.tx) * k,
          ty: pt.y - (pt.y - v.ty) * k,
        };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [loading]);

  function handlePointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    dragRef.current = {
      active: true,
      moved: false,
      startX: e.clientX,
      startY: e.clientY,
      originTx: view.tx,
      originTy: view.ty,
      pointerId: e.pointerId,
      captureTarget: e.currentTarget,
    };
    // Do NOT setPointerCapture here — it would redirect the eventual click
    // away from the inner skill nodes and break their onClick handlers.
  }

  function handlePointerMove(e) {
    const d = dragRef.current;
    if (!d.active) return;
    const dxPx = e.clientX - d.startX;
    const dyPx = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dxPx, dyPx) > 4) {
      d.moved = true;
      setIsDragging(true);
      // Capture only once a real drag has begun, so simple clicks still
      // reach the skill nodes underneath.
      try { d.captureTarget?.setPointerCapture?.(d.pointerId); } catch {}
    }
    if (!d.moved) return;
    const svg = svgRef.current;
    const ctm = svg && svg.getScreenCTM();
    if (!ctm) return;
    const dxSvg = dxPx / ctm.a;
    const dySvg = dyPx / ctm.d;
    setView((v) => ({ ...v, tx: d.originTx + dxSvg, ty: d.originTy + dySvg }));
  }

  function handlePointerUp(e) {
    const d = dragRef.current;
    if (!d.active) return;
    d.active = false;
    setIsDragging(false);
    if (d.captureTarget && d.pointerId !== null) {
      try { d.captureTarget.releasePointerCapture?.(d.pointerId); } catch {}
    }
    // keep `moved` flag for the upcoming click capture; clear on next tick
    setTimeout(() => { dragRef.current.moved = false; }, 0);
  }

  function handleClickCapture(e) {
    if (dragRef.current.moved) {
      e.stopPropagation();
      e.preventDefault();
      dragRef.current.moved = false;
    }
  }

  function resetView() {
    setView({ scale: 1, tx: 0, ty: 0 });
  }

  useEffect(() => {
    async function load() {
      try {
        const [exList, prog] = await Promise.all([
          api.getExercises(),
          user?.id ? api.getProgress(user.id) : Promise.resolve({}),
        ]);
        setExercises(exList || []);
        setProgressMap(prog || {});
      } catch (e) {
        setError(e.message || 'Erro ao carregar mapa');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [user]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      shellRef.current?.requestFullscreen?.();
    }
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && zoomedSkill && !document.fullscreenElement) {
        setZoomedSkill(null);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomedSkill]);

  const bySkill = {};
  for (let i = 1; i <= 5; i++) bySkill[i] = [];
  for (const ex of exercises) {
    const sid = ex.skillId;
    if (sid >= 1 && sid <= 5) bySkill[sid].push(ex);
  }

  function getSkillAggregateScore(skillId) {
    const exList = bySkill[skillId] || [];
    let total = 0;
    let count = 0;
    for (const ex of exList) {
      const prog = progressMap[ex.id];
      if (prog && prog.score !== null && prog.score !== undefined) {
        if (prog.skillScores && prog.skillScores[skillId] !== undefined) {
          total += prog.skillScores[skillId];
        } else {
          total += prog.score;
        }
        count++;
      }
    }
    if (count === 0) return null;
    return Math.round(total / count);
  }

  function handleSkillClick(skillId) {
    if (zoomedSkill === skillId) {
      setZoomedSkill(null);
    } else {
      setZoomedSkill(skillId);
    }
  }

  function handleExerciseClick(ex) {
    setPulsingExercise(ex.id);
    setTimeout(() => navigate(`/chat/exercise/${ex.id}`), 320);
  }

  return (
    <div>
      {!isFullscreen && (
        <div className="page-header with-action">
          <div>
            <div className="eyebrow">Sistema 1 · Programa Estruturado</div>
            <h2>
              <Typewriter text="Mapa de " />
              <span className="accent"><Typewriter text="Competências" delayStart={520} /></span>
            </h2>
            <p>
              Cinco competências clínicas. Clique em uma para abrir seus exercícios — a partir deles, inicie a
              prática deliberada com avaliação ao final.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {zoomedSkill && (
              <button className="btn btn-outline btn-sm" onClick={() => setZoomedSkill(null)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                Voltar à visão geral
              </button>
            )}
            <button className="btn btn-outline btn-sm" onClick={toggleFullscreen} title="Tela cheia">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              Tela cheia
            </button>
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '60px 24px' }}>
          <span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando programa…</span>
        </div>
      ) : (
        <div ref={shellRef} className={`skill-map-shell ${isFullscreen ? 'fullscreen' : ''}`}>
          <div className="skill-map-controls">
            {zoomedSkill && (
              <button className="map-control-btn" onClick={() => setZoomedSkill(null)} title="Voltar (Esc)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            {(view.scale !== 1 || view.tx !== 0 || view.ty !== 0) && (
              <button className="map-control-btn" onClick={resetView} title="Centralizar visualização">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                </svg>
              </button>
            )}
            <button className="map-control-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Sair tela cheia' : 'Tela cheia'}>
              {isFullscreen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                  <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                  <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
              )}
            </button>
          </div>

          <div
            ref={wrapRef}
            className="skill-map-svg-wrap"
            style={{ cursor: isDragging ? 'grabbing' : 'grab', touchAction: 'none' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onClickCapture={handleClickCapture}
            onClick={(e) => {
              if (zoomedSkill && e.target.tagName === 'svg') setZoomedSkill(null);
            }}
            onDoubleClick={resetView}
          >
            <svg ref={svgRef} className="skill-map-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet">
              <defs>
                {Object.entries(SKILL_COLORS).map(([id, color]) => (
                  <filter key={`glow-${id}`} id={`glow-${id}`} x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
                    <feMerge>
                      <feMergeNode in="coloredBlur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                ))}
              </defs>

              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>

              {/* Anéis decorativos — só no overview */}
              <g style={{ opacity: zoomedSkill ? 0 : 1, transition: 'opacity 0.4s ease' }}>
                <circle cx={CENTER_X} cy={CENTER_Y} r="370" fill="none" stroke="#E8E2D7" strokeWidth="1" strokeDasharray="2 6" />
                <circle cx={CENTER_X} cy={CENTER_Y} r="290" fill="none" stroke="#c4baa8" strokeWidth="0.6" />
                <circle cx={CENTER_X} cy={CENTER_Y} r="200" fill="none" stroke="#E8E2D7" strokeWidth="1" />
                {[0, 1, 2, 3, 4].map((i) => {
                  const a = getSkillPosition(i);
                  const b = getSkillPosition((i + 1) % 5);
                  return (
                    <line
                      key={`pent-${i}`}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="#c4baa8" strokeWidth="0.8" strokeDasharray="4 6" opacity="0.5"
                    />
                  );
                })}
              </g>

              {/* Anel orbital — só quando zoomed */}
              {zoomedSkill && (
                <g style={{ opacity: 0.5 }}>
                  <circle cx={CENTER_X} cy={CENTER_Y} r={ORBIT_RADIUS_ZOOMED} fill="none" stroke={SKILL_COLORS[zoomedSkill]} strokeWidth="0.8" strokeDasharray="3 6" opacity="0.4" />
                </g>
              )}

              {/* Núcleo central — só no overview */}
              <g style={{ opacity: zoomedSkill ? 0 : 1, transition: 'opacity 0.35s ease' }}>
                <circle cx={CENTER_X} cy={CENTER_Y} r="84" fill="#FDFBF7" stroke="#c4baa8" strokeWidth="1" />
                <circle cx={CENTER_X} cy={CENTER_Y} r="70" fill="none" stroke="#E8E2D7" strokeWidth="1" />
                <text x={CENTER_X} y={CENTER_Y - 6} textAnchor="middle" fontFamily="DM Serif Display, serif" fontSize="28">
                  <tspan fill="#14564E">all</tspan>
                  <tspan fill="#B85A40">_OS</tspan>
                </text>
                <text x={CENTER_X} y={CENTER_Y + 16} textAnchor="middle" fontFamily="DM Sans, sans-serif" fontSize="9" fill="#5C5C5C" letterSpacing="2.5">PRÁTICA · DELIBERADA</text>
                <text x={CENTER_X} y={CENTER_Y + 34} textAnchor="middle" fontFamily="Cormorant Garamond, serif" fontStyle="italic" fontSize="13" fill="#a89e8c">cinco competências</text>
              </g>

              {/* Skills + suas órbitas */}
              {[1, 2, 3, 4, 5].map((skillId) => {
                const idx = skillId - 1;
                const pentagonPos = getSkillPosition(idx);
                const color = SKILL_COLORS[skillId];
                const name = SKILL_NAMES[skillId];
                const exList = bySkill[skillId] || [];
                const exPositions = getZoomedExercisePositions(exList.length);
                const isHovered = hoveredNode === `skill-${skillId}`;
                const isThisZoomed = zoomedSkill === skillId;
                const isOtherZoomed = zoomedSkill && !isThisZoomed;
                const completedCount = exList.filter((ex) => {
                  const p = progressMap[ex.id];
                  return p && p.score !== null && p.score !== undefined;
                }).length;
                const skillAgg = getSkillAggregateScore(skillId);

                // Translação: pilar vai do pentágono ao centro quando zoomed
                const dx = isThisZoomed ? CENTER_X - pentagonPos.x : 0;
                const dy = isThisZoomed ? CENTER_Y - pentagonPos.y : 0;

                return (
                  <g
                    key={`skill-${skillId}`}
                    style={{
                      opacity: isOtherZoomed ? 0 : 1,
                      transition: 'opacity 0.45s ease',
                      pointerEvents: isOtherZoomed ? 'none' : 'auto',
                    }}
                  >
                    {/* Linhas centro-exercício — somente quando zoomed nesta skill */}
                    <g style={{
                      opacity: isThisZoomed ? 1 : 0,
                      transition: 'opacity 0.4s ease 0.25s',
                      pointerEvents: 'none',
                    }}>
                      {exList.map((ex, ei) => {
                        const epos = exPositions[ei];
                        const prog = progressMap[ex.id];
                        const done = prog && prog.score !== null && prog.score !== undefined;
                        return (
                          <line
                            key={`line-${ex.id}`}
                            x1={CENTER_X} y1={CENTER_Y} x2={epos.x} y2={epos.y}
                            stroke={done ? color : '#c4baa8'}
                            strokeWidth={done ? 1.5 : 1}
                            strokeDasharray={done ? 'none' : '4 6'}
                            opacity={done ? 0.65 : 0.5}
                          />
                        );
                      })}
                    </g>

                    {/* Nós de exercício — somente quando zoomed nesta skill */}
                    {exList.map((ex, ei) => {
                      const epos = exPositions[ei];
                      const prog = progressMap[ex.id];
                      const done = prog && prog.score !== null && prog.score !== undefined;
                      const score = done ? prog.score : null;
                      const isHoveredEx = hoveredNode === `ex-${ex.id}`;
                      const isPulsing = pulsingExercise === ex.id;
                      const nameLines = wrapText(truncate(ex.title || ex.name || 'Exercício', 40), 16);
                      return (
                        <g
                          key={`ex-${ex.id}`}
                          className={isPulsing ? 'exercise-pulsing' : ''}
                          style={{
                            cursor: isThisZoomed ? 'pointer' : 'default',
                            opacity: isThisZoomed ? 1 : 0,
                            pointerEvents: isThisZoomed ? 'auto' : 'none',
                            transform: isThisZoomed ? 'scale(1)' : 'scale(0.6)',
                            transformOrigin: `${epos.x}px ${epos.y}px`,
                            transition: 'opacity 0.45s ease 0.18s, transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) 0.18s',
                          }}
                          onClick={(e) => {
                            if (!isThisZoomed) return;
                            e.stopPropagation();
                            handleExerciseClick(ex);
                          }}
                          onMouseEnter={() => setHoveredNode(`ex-${ex.id}`)}
                          onMouseLeave={() => setHoveredNode(null)}
                        >
                          {isHoveredEx && isThisZoomed && (
                            <circle cx={epos.x} cy={epos.y} r={EXERCISE_RADIUS + 7} fill="none" stroke={color} strokeWidth="2" opacity="0.55" />
                          )}
                          {isPulsing && (
                            <>
                              <circle cx={epos.x} cy={epos.y} r={EXERCISE_RADIUS} fill="none" stroke={color} strokeWidth="2" className="exercise-ripple" />
                              <circle cx={epos.x} cy={epos.y} r={EXERCISE_RADIUS} fill="none" stroke={color} strokeWidth="2" className="exercise-ripple delayed" />
                            </>
                          )}
                          <circle
                            cx={epos.x} cy={epos.y} r={EXERCISE_RADIUS}
                            fill={done ? '#FDFBF7' : '#F5F0E8'}
                            stroke={done ? color : '#c4baa8'}
                            strokeWidth={done ? 2 : 1.4}
                            filter={done ? `url(#glow-${skillId})` : undefined}
                          />
                          {done && (
                            <circle cx={epos.x + EXERCISE_RADIUS - 9} cy={epos.y - EXERCISE_RADIUS + 9} r={6} fill={color} />
                          )}
                          {nameLines.map((line, li) => (
                            <text
                              key={li}
                              x={epos.x}
                              y={epos.y + (li - (nameLines.length - 1) / 2) * 11}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              fill={done ? color : '#3D3D3D'}
                              fontSize="10"
                              fontFamily="DM Sans, sans-serif"
                              fontWeight={done ? '600' : '500'}
                            >
                              {line}
                            </text>
                          ))}
                          {done && (
                            <g>
                              <circle cx={epos.x} cy={epos.y - EXERCISE_RADIUS - 12} r={11} fill="#FDFBF7" stroke={color} strokeWidth="1.4" />
                              <text
                                x={epos.x}
                                y={epos.y - EXERCISE_RADIUS - 9}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fill={color}
                                fontSize="9"
                                fontWeight="700"
                                fontFamily="DM Sans, sans-serif"
                              >
                                {score > 0 ? `+${score}` : score}
                              </text>
                            </g>
                          )}
                        </g>
                      );
                    })}

                    {/* Nó da skill — translada ao centro quando zoomed */}
                    <g
                      onMouseEnter={() => setHoveredNode(`skill-${skillId}`)}
                      onMouseLeave={() => setHoveredNode(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSkillClick(skillId);
                      }}
                      style={{
                        cursor: 'pointer',
                        transform: `translate(${dx}px, ${dy}px)`,
                        transition: 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      {!isThisZoomed && (
                        <circle cx={pentagonPos.x} cy={pentagonPos.y} r={SKILL_RADIUS + 14} fill="none" stroke={color} strokeWidth="1" opacity="0.2">
                          <animate attributeName="r" values={`${SKILL_RADIUS + 8};${SKILL_RADIUS + 22};${SKILL_RADIUS + 8}`} dur="3.5s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0.25;0.05;0.25" dur="3.5s" repeatCount="indefinite" />
                        </circle>
                      )}
                      {(isHovered || isThisZoomed) && (
                        <circle cx={pentagonPos.x} cy={pentagonPos.y} r={SKILL_RADIUS + (isThisZoomed ? 12 : 8)} fill="none" stroke={color} strokeWidth={isThisZoomed ? 2.5 : 2} opacity={isThisZoomed ? 0.7 : 0.55} />
                      )}

                      <circle cx={pentagonPos.x} cy={pentagonPos.y} r={SKILL_RADIUS} fill={color} stroke={shade(color, -0.25)} strokeWidth="1.5" />
                      <circle cx={pentagonPos.x} cy={pentagonPos.y} r={SKILL_RADIUS - 8} fill="none" stroke="rgba(253,251,247,0.35)" strokeWidth="0.8" strokeDasharray="3 4" />

                      <circle cx={pentagonPos.x + SKILL_RADIUS - 14} cy={pentagonPos.y - SKILL_RADIUS + 14} r={11} fill="#FDFBF7" stroke={shade(color, -0.3)} strokeWidth="1.5" />
                      <text x={pentagonPos.x + SKILL_RADIUS - 14} y={pentagonPos.y - SKILL_RADIUS + 14} textAnchor="middle" dominantBaseline="middle" fill={shade(color, -0.3)} fontSize="11" fontWeight="700" fontFamily="DM Sans, sans-serif">
                        {skillId}
                      </text>

                      {skillAgg !== null && (
                        <g>
                          <circle cx={pentagonPos.x - SKILL_RADIUS + 14} cy={pentagonPos.y - SKILL_RADIUS + 14} r={13} fill="#FDFBF7" stroke="#B85A40" strokeWidth="1.5" />
                          <text x={pentagonPos.x - SKILL_RADIUS + 14} y={pentagonPos.y - SKILL_RADIUS + 14} textAnchor="middle" dominantBaseline="middle" fill="#B85A40" fontSize="10" fontWeight="700" fontFamily="DM Sans, sans-serif">
                            {skillAgg > 0 ? `+${skillAgg}` : skillAgg}
                          </text>
                        </g>
                      )}

                      {wrapText(name, 13).map((line, li, arr) => (
                        <text
                          key={li}
                          x={pentagonPos.x}
                          y={pentagonPos.y + (li - (arr.length - 1) / 2) * 13 - 4}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="#FDFBF7"
                          fontSize="11.5"
                          fontFamily="DM Serif Display, serif"
                        >
                          {line}
                        </text>
                      ))}

                      <text
                        x={pentagonPos.x}
                        y={pentagonPos.y + SKILL_RADIUS - 14}
                        textAnchor="middle"
                        fill="rgba(253,251,247,0.85)"
                        fontSize="9.5"
                        fontFamily="DM Sans, sans-serif"
                        letterSpacing="1.5"
                      >
                        {completedCount}/{exList.length} exercícios
                      </text>
                    </g>
                  </g>
                );
              })}

              {!zoomedSkill && (
                <text x={CENTER_X} y={36} textAnchor="middle" fill="#a89e8c" fontSize="10" fontFamily="DM Sans, sans-serif" letterSpacing="6">
                  CINCO COMPETÊNCIAS · CLIQUE PARA EXPLORAR
                </text>
              )}

              </g>
            </svg>
          </div>

          <div className="skill-map-footer">
            {zoomedSkill ? (
              <div className="skill-map-active-info">
                <span className="swatch lg" style={{ background: SKILL_COLORS[zoomedSkill] }} />
                <div>
                  <div className="active-eyebrow">Competência {zoomedSkill}</div>
                  <div className="active-name">{SKILL_NAMES[zoomedSkill]}</div>
                </div>
                <div className="active-meta">
                  {bySkill[zoomedSkill].length === 0
                    ? 'Nenhum exercício cadastrado para esta competência ainda.'
                    : `${bySkill[zoomedSkill].length} ${bySkill[zoomedSkill].length === 1 ? 'exercício disponível' : 'exercícios disponíveis'} · clique num exercício para iniciar`}
                </div>
              </div>
            ) : (
              <div className="skill-map-legend">
                {[1, 2, 3, 4, 5].map((sid) => (
                  <button
                    key={sid}
                    className="legend-item legend-button"
                    onClick={() => setZoomedSkill(sid)}
                    title="Abrir esta competência"
                  >
                    <span className="swatch" style={{ background: SKILL_COLORS[sid] }} />
                    <span><strong style={{ color: 'var(--marrs-deep)' }}>{sid}.</strong> {SKILL_NAMES[sid]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
