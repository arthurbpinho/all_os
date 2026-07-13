import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { api } from '../api';
import Typewriter from '../components/Typewriter';

/* ------------------------------------------------------------------ *
 * Antessala (pré-supervisão) — Allos
 * Porte do protótipo pre-supervisao.jsx para dentro do all_OS.
 * Wizard de 7 etapas: o aluno preenche; a rede se desenha sozinha.
 * A IA age SÓ sobre a FORMA do pensamento (perguntas maiêuticas) — nunca
 * gera fato, saída, risco, conceito ou conduta. O system prompt vive no
 * servidor (POST /api/antessala/reflect), fora do alcance do cliente.
 * Persistência: registros no servidor (não download de JSON).
 * ------------------------------------------------------------------ */

// Cores semânticas do MAPA — fixas por decisão de produto (carregam o
// significado das camadas). Neutros vêm do design system via CSS quando
// possível; aqui ficam explícitos porque o grafo é SVG desenhado à mão.
const C = {
  surface: '#FBFCFC', surfaceAlt: '#F2F5F4',
  ink: '#1E2A2C', inkSoft: '#546165', line: '#D3DAD9',
  fato: '#157A4E', variacao: '#C0392B', pitfall: '#23292B', conceito: '#6B4E9E',
  action: '#008f8f', // Marrs Green (primária Allos) no lugar do teal do protótipo
  fatoBg: '#E4F1EA', variacaoBg: '#F7E5E2', pitfallBg: '#E5E8E8', conceitoBg: '#EDE7F5',
};

const uid = () => Math.random().toString(36).slice(2, 9);

const ETAPAS = [
  { n: 1, key: 'titulo', nome: 'Título', sub: 'Um nome criativo para o caso', noMapa: false },
  { n: 2, key: 'business', nome: 'O que você vai fazer', sub: 'What business are you in?', noMapa: true },
  { n: 3, key: 'fatos', nome: 'Prioridade', sub: 'Fatos relevantes e suas relações', noMapa: true },
  { n: 4, key: 'variacoes', nome: 'Variações', sub: 'Saídas clínicas possíveis', noMapa: true },
  { n: 5, key: 'pitfalls', nome: 'Armadilhas', sub: 'Riscos de execução de cada saída', noMapa: true },
  { n: 6, key: 'conceitos', nome: 'Conceitos', sub: 'Referencial teórico ancorado no caso', noMapa: true },
  { n: 7, key: 'direcoes', nome: 'Direções', sub: 'O que fazer na próxima sessão', noMapa: false },
];

/* ------------------------------ dados ------------------------------ */

const emptyDoc = () => ({ titulo: '', business: '', fatos: [], relacoes: [], variacoes: [], pitfalls: [], conceitos: [], direcoes: [] });

// Só os campos do documento (o que persiste no servidor). Descarta metadados.
function docFields(d) {
  return {
    titulo: d.titulo || '', business: d.business || '',
    fatos: d.fatos || [], relacoes: d.relacoes || [], variacoes: d.variacoes || [],
    pitfalls: d.pitfalls || [], conceitos: d.conceitos || [], direcoes: d.direcoes || [],
  };
}

/* ------------------------------ layout ------------------------------ */

function wrap(text, max) {
  const words = (text || '').split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { if (cur) lines.push(cur.trim()); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur.trim());
  return lines.length ? lines : [''];
}

// Parâmetros por tipo de nó: largura de quebra do texto, fonte e peso.
const NODE_SPEC = {
  biz:      { wrapAt: 22, font: 13,   weight: 700, maxW: 240 },
  fato:     { wrapAt: 20, font: 12.5, weight: 600, maxW: 210 },
  variacao: { wrapAt: 18, font: 11.5, weight: 500, maxW: 190 },
  pitfall:  { wrapAt: 18, font: 11,   weight: 500, maxW: 180 },
  conceito: { wrapAt: 18, font: 11,   weight: 500, maxW: 190 },
};
const PAD_X = 15, PAD_Y = 10;

// Mede um nó a partir do texto: quebra em linhas e calcula caixa. Retorna
// também lineH pra centralizar o texto verticalmente na renderização.
function measureNode(kind, text) {
  const spec = NODE_SPEC[kind] || NODE_SPEC.fato;
  const lines = wrap(text || '…', spec.wrapAt);
  const charW = spec.font * 0.56;
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const w = Math.min(longest * charW + PAD_X * 2, spec.maxW);
  const lineH = spec.font + 4.5;
  const h = lines.length * lineH + PAD_Y * 2;
  return { lines, w, h, lineH, font: spec.font, weight: spec.weight };
}

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 3)));

// Layout radial por CUNHAS: cada fato ganha uma fatia angular ao redor do
// objetivo; suas variações/armadilhas/conceitos abrem em leque DENTRO dessa
// fatia, apontando pra fora. Isso mantém os ramos separados (não colidem com os
// vizinhos) e o mapa respira. A moldura (viewBox) é calculada pra caber tudo,
// então o mapa já nasce enquadrado, sem ficar amontoado no centro.
function computeLayout(doc) {
  const nodes = [], links = [];
  const push = (kind, id, x, y, extra) => {
    const key = kind === 'biz' ? doc.business : extra.text;
    const m = measureNode(kind, key);
    nodes.push({ id, kind, x, y, lines: m.lines, w: m.w, h: m.h, lineH: m.lineH, font: m.font, weight: m.weight, ...extra });
  };

  push('biz', '__biz', 0, 0, { text: doc.business || '—' });

  const fatos = doc.fatos || [];
  const N = Math.max(fatos.length, 1);
  const slot = (2 * Math.PI) / N; // fatia angular por fato
  const wedge = Math.min(slot * 0.72, 1.4); // abertura do leque dentro da fatia

  fatos.forEach((f, i) => {
    const theta = -Math.PI / 2 + i * slot;
    const cent = clampInt(f.centralidade, 1, 5);
    const fr = 300 + (5 - cent) * 66; // central (5) perto, periférico (1) longe
    const fx = Math.cos(theta) * fr, fy = Math.sin(theta) * fr;
    push('fato', f.id, fx, fy, { text: f.texto || '…' });
    links.push({ from: '__biz', to: f.id, kind: 'spine' });

    const vars = (doc.variacoes || []).filter((v) => v.fatoId === f.id);
    const m = vars.length;
    const vr = fr + 175;
    const vStep = m > 1 ? Math.min(wedge / (m - 1), 0.42) : 0;
    vars.forEach((v, vi) => {
      const va = theta + (vi - (m - 1) / 2) * vStep;
      const vx = Math.cos(va) * vr, vy = Math.sin(va) * vr;
      push('variacao', v.id, vx, vy, { text: v.texto || '…', parent: f.id });
      links.push({ from: f.id, to: v.id, kind: 'variacao' });

      const pfs = (doc.pitfalls || []).filter((p) => p.variacaoId === v.id);
      const pm = pfs.length;
      const pr = vr + 140;
      const pStep = pm > 1 ? 0.3 : 0;
      pfs.forEach((p, pi) => {
        const pa = va + (pi - (pm - 1) / 2) * pStep;
        const pxp = Math.cos(pa) * pr, pyp = Math.sin(pa) * pr;
        push('pitfall', p.id, pxp, pyp, { text: p.flagged ? 'não consegui enxergar' : (p.texto || '…'), flagged: p.flagged, parent: f.id });
        links.push({ from: v.id, to: p.id, kind: 'pitfall' });
      });
    });

    // Conceitos: lado "de trás" da fatia, na órbita do fato (fora do leque das
    // variações), pra não competir com elas.
    const cons = (doc.conceitos || []).filter((c) => c.fatoId === f.id);
    const cr = fr + 108;
    cons.forEach((c, ci) => {
      const ca = theta + wedge * 0.55 + 0.18 + ci * 0.2;
      const cx = Math.cos(ca) * cr, cy = Math.sin(ca) * cr;
      const label = (c.texto || '…') + (c.tipo ? ` · ${c.tipo}` : '');
      push('conceito', c.id, cx, cy, { text: label, parent: f.id });
      links.push({ from: f.id, to: c.id, kind: 'conceito' });
    });
  });

  (doc.relacoes || []).forEach((rel) => {
    if (nodes.some((n) => n.id === rel.origem) && nodes.some((n) => n.id === rel.destino)) {
      links.push({ from: rel.origem, to: rel.destino, kind: 'causal', label: rel.descricao });
    }
  });

  // Moldura que cabe tudo (auto-fit).
  const pad = 70;
  let minX = -pad, minY = -pad, maxX = pad, maxY = pad;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.w / 2 - pad); maxX = Math.max(maxX, n.x + n.w / 2 + pad);
    minY = Math.min(minY, n.y - n.h / 2 - pad); maxY = Math.max(maxY, n.y + n.h / 2 + pad);
  }
  const viewBox = `${minX} ${minY} ${Math.max(maxX - minX, 1)} ${Math.max(maxY - minY, 1)}`;
  return { nodes, links, viewBox };
}

const colorFor = (k) => ({ biz: C.fato, fato: C.fato, variacao: C.variacao, pitfall: C.pitfall, conceito: C.conceito }[k] || C.ink);
const bgFor = (k) => ({ biz: C.fato, fato: C.fatoBg, variacao: C.variacaoBg, pitfall: C.pitfallBg, conceito: C.conceitoBg }[k] || C.surface);

// Intersecção do segmento centro→centro com a borda do retângulo do nó de
// origem, pra as setas encostarem na caixa (não no meio do texto).
function anchor(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { x: a.x, y: a.y };
  const hw = a.w / 2 + 2, hh = a.h / 2 + 2;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function NetworkGraph({ doc, layers, focus, setFocus, forPrint }) {
  const { nodes, links, viewBox } = useMemo(() => computeLayout(doc), [doc]);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef(null);
  const movedRef = useRef(false);
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  const visK = (k) => {
    if (k === 'biz' || k === 'fato' || k === 'spine') return true;
    if (k === 'causal') return !!layers.causal;
    if (k === 'variacao') return !!layers.variacao;
    if (k === 'pitfall') return !!layers.pitfall;
    if (k === 'conceito') return !!layers.conceito;
    return true;
  };
  const inFocus = (n) => !focus || n.id === focus || n.id === '__biz' || n.parent === focus;
  const linkFocus = (l) => {
    if (!focus) return true;
    const a = byId[l.from], b = byId[l.to];
    if (!a || !b) return false;
    if (l.kind === 'causal') return l.from === focus || l.to === focus;
    return inFocus(a) && inFocus(b);
  };

  const onWheel = (e) => { if (forPrint) return; e.preventDefault(); const f = e.deltaY < 0 ? 1.12 : 0.89; setView((v) => ({ ...v, s: Math.min(3, Math.max(0.3, v.s * f)) })); };
  const onDown = (e) => { if (forPrint) return; movedRef.current = false; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; };
  const onMove = (e) => {
    if (!drag.current) return;
    const ddx = e.clientX - drag.current.x, ddy = e.clientY - drag.current.y;
    if (Math.abs(ddx) + Math.abs(ddy) > 4) movedRef.current = true;
    setView((v) => ({ ...v, x: drag.current.vx + ddx, y: drag.current.vy + ddy }));
  };
  const onUp = () => { drag.current = null; };
  const resetView = () => { setView({ s: 1, x: 0, y: 0 }); if (setFocus) setFocus(null); };

  const nodeClick = (n) => (e) => {
    e.stopPropagation();
    if (movedRef.current) return; // foi arraste, não clique
    if (setFocus) setFocus(focus === n.id ? null : n.id);
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: C.surface, cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none', overflow: 'hidden' }}
      onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
      {!forPrint && (
        <button onClick={resetView} title="Recentralizar"
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 2, width: 30, height: 30, borderRadius: 8, border: `1px solid ${C.line}`, background: C.surface, color: C.inkSoft, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>⤢</button>
      )}
      <svg viewBox={viewBox} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        <defs>
          {['causal', 'variacao', 'conceito', 'pitfall'].map((k) => (
            <marker key={k} id={`ar-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={k === 'causal' ? C.inkSoft : colorFor(k)} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.s})`}>
          {links.filter((l) => visK(l.kind) && linkFocus(l)).map((l, i) => {
            const a = byId[l.from], b = byId[l.to];
            if (!a || !b) return null;
            const p1 = anchor(a, b), p2 = anchor(b, a);
            const col = l.kind === 'causal' ? C.inkSoft : colorFor(l.kind);
            const dash = l.kind === 'spine' ? '4 6' : l.kind === 'conceito' ? '2 5' : 'none';
            const arrow = (l.kind === 'causal' || l.kind === 'variacao' || l.kind === 'conceito' || l.kind === 'pitfall') ? `url(#ar-${l.kind})` : undefined;
            const label = l.kind === 'causal' && l.label ? String(l.label) : '';
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            return (
              <g key={i} opacity={l.kind === 'spine' ? 0.45 : 0.9}>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={col} strokeWidth={l.kind === 'causal' ? 1.7 : 1.3} strokeDasharray={dash} markerEnd={arrow} />
                {label ? (
                  <>
                    <rect x={mx - label.length * 3.2 - 5} y={my - 9} width={label.length * 6.4 + 10} height={17} rx={8} fill={C.surface} stroke={C.line} strokeWidth={0.8} />
                    <text x={mx} y={my} textAnchor="middle" dominantBaseline="central" fontSize="10" fill={C.inkSoft} fontStyle="italic">{label}</text>
                  </>
                ) : null}
              </g>
            );
          })}
          {nodes.filter((n) => (n.kind === 'biz' || n.kind === 'fato' ? true : visK(n.kind)) && inFocus(n)).map((n) => {
            const isBiz = n.kind === 'biz';
            const clickable = n.kind === 'fato' && !forPrint;
            const isFocused = focus && n.id === focus;
            const textTop = -n.h / 2 + PAD_Y + n.lineH / 2;
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: clickable ? 'pointer' : 'default' }}
                onClick={clickable ? nodeClick(n) : undefined}>
                <rect x={-n.w / 2} y={-n.h / 2} width={n.w} height={n.h} rx={isBiz ? Math.min(n.h / 2, 22) : 10}
                  fill={isBiz ? C.fato : bgFor(n.kind)} stroke={colorFor(n.kind)} strokeWidth={isBiz ? 0 : (isFocused ? 2.4 : 1.4)} />
                {n.flagged ? <text x={-n.w / 2 + 9} y={-n.h / 2 + 13} fontSize="11" fill={C.pitfall}>⚑</text> : null}
                {n.lines.map((ln, i) => (
                  <text key={i} x={0} y={textTop + i * n.lineH} textAnchor="middle" dominantBaseline="central"
                    fontSize={n.font} fontWeight={n.weight}
                    fontStyle={n.kind === 'pitfall' && n.flagged ? 'italic' : 'normal'} fill={isBiz ? '#fff' : colorFor(n.kind)}>{ln}</text>
                ))}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// Blindagem: se algo no desenho do mapa lançar, mostra um aviso com botão de
// recarregar em vez de derrubar a página inteira (branco sem volta).
class GraphErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err) { try { console.error('[Antessala mapa]', err); } catch {} }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: C.surface, color: C.inkSoft, fontSize: 13, padding: 20, textAlign: 'center' }}>
          <span>Não consegui desenhar o mapa agora.</span>
          <button onClick={() => this.setState({ hasError: false })} style={{ border: `1px solid ${C.line}`, background: C.surfaceAlt, color: C.ink, borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600 }}>Tentar de novo</button>
        </div>
      );
    }
    return this.props.children;
  }
}
function SafeGraph(props) {
  return <GraphErrorBoundary><NetworkGraph {...props} /></GraphErrorBoundary>;
}

/* ------------------------------ UI bits ------------------------------ */

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 4 }}>{label}</label>
      {hint ? <p style={{ fontSize: 12, color: C.inkSoft, margin: '0 0 6px' }}>{hint}</p> : null}
      {children}
    </div>
  );
}
const inputStyle = { width: '100%', padding: '9px 11px', borderRadius: 9, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

function Btn({ children, onClick, kind = 'ghost', small, style, disabled }) {
  const base = { border: 'none', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', fontSize: small ? 12 : 13, fontWeight: 600, padding: small ? '5px 10px' : '8px 14px', opacity: disabled ? 0.5 : 1, ...style };
  const kinds = {
    solid: { background: C.action, color: '#fff' },
    ghost: { background: C.surfaceAlt, color: C.ink, border: `1px solid ${C.line}` },
    danger: { background: 'transparent', color: C.variacao, border: `1px solid ${C.variacaoBg}` },
    plain: { background: 'transparent', color: C.action },
    accent: { background: '#fff', color: C.action, border: `1.4px solid ${C.action}` },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...kinds[kind] }}>{children}</button>;
}
function FatoBlock({ color, title, children }) {
  return (
    <div style={{ borderLeft: `3px solid ${color}`, paddingLeft: 12, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ color, value, placeholder, onChange, onDel, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 }} />
      <input style={{ ...inputStyle, opacity: disabled ? 0.6 : 1 }} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <Btn kind="danger" small onClick={onDel}>×</Btn>
    </div>
  );
}
function Empty({ children }) {
  return <div style={{ padding: 20, textAlign: 'center', color: C.inkSoft, fontSize: 13, background: C.surfaceAlt, borderRadius: 10 }}>{children}</div>;
}

/* --------------------------- step editors --------------------------- */

function StepTitulo({ doc, set }) {
  return (
    <Field label="Título do caso" hint="Um nome criativo, um trocadilho, uma imagem. Pode partir do que é central ou do que é periférico. Serve para destravar o olhar e exercitar o que importa no caso.">
      <input style={inputStyle} value={doc.titulo} placeholder="ex.: O peso invisível" onChange={(e) => set({ titulo: e.target.value })} />
    </Field>
  );
}
function StepBusiness({ doc, set }) {
  return (
    <Field label="What business are you in?" hint="O que você pretende fazer com este caso, agora que ele está concreto na sua frente. Pense em operação mais objeto: o verbo diz o tipo de ação (ajudar a lidar, fazer crescer, conectar, explorar), o objeto diz sobre o quê. Vale voltar aqui depois de montar o mapa.">
      <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={doc.business} placeholder="ex.: Ajudar a paciente a distinguir o que ela quer do que esperam dela." onChange={(e) => set({ business: e.target.value })} />
    </Field>
  );
}
function StepFatos({ doc, set }) {
  const addFato = () => set({ fatos: [...doc.fatos, { id: uid(), texto: '', centralidade: 3 }] });
  const upd = (id, patch) => set({ fatos: doc.fatos.map((f) => f.id === id ? { ...f, ...patch } : f) });
  const del = (id) => set({ fatos: doc.fatos.filter((f) => f.id !== id), relacoes: doc.relacoes.filter((r) => r.origem !== id && r.destino !== id), variacoes: doc.variacoes.filter((v) => v.fatoId !== id), conceitos: doc.conceitos.filter((c) => c.fatoId !== id) });
  const addRel = () => { if (doc.fatos.length < 2) return; set({ relacoes: [...doc.relacoes, { id: uid(), origem: doc.fatos[0].id, destino: doc.fatos[1].id, descricao: '' }] }); };
  const updRel = (id, patch) => set({ relacoes: doc.relacoes.map((r) => r.id === id ? { ...r, ...patch } : r) });
  const delRel = (id) => set({ relacoes: doc.relacoes.filter((r) => r.id !== id) });
  const nameOf = (id) => (doc.fatos.find((f) => f.id === id)?.texto || '…').slice(0, 30);
  return (
    <div>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>Registre os fatos que chamaram atenção na sessão. A centralidade define o quão perto do meio do mapa cada um fica: mais central quando se articula com o título e com o objetivo, mais periférico quando fica solto.</p>
      {doc.fatos.map((f) => (
        <div key={f.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 11, marginBottom: 9, background: C.surface }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: C.fato, marginTop: 6, flexShrink: 0 }} />
            <textarea style={{ ...inputStyle, minHeight: 40, resize: 'vertical' }} value={f.texto} placeholder="fato clínico relevante" onChange={(e) => upd(f.id, { texto: e.target.value })} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, paddingLeft: 16 }}>
            <span style={{ fontSize: 12, color: C.inkSoft, minWidth: 78 }}>Centralidade</span>
            <input type="range" min={1} max={5} value={f.centralidade} style={{ flex: 1, accentColor: C.fato }} onChange={(e) => upd(f.id, { centralidade: Number(e.target.value) })} />
            <span style={{ fontSize: 12, fontWeight: 700, color: C.fato, minWidth: 14 }}>{f.centralidade}</span>
            <Btn kind="danger" small onClick={() => del(f.id)}>remover</Btn>
          </div>
        </div>
      ))}
      <Btn kind="ghost" onClick={addFato}>+ fato</Btn>
      <h4 style={{ fontSize: 13, color: C.ink, margin: '20px 0 6px' }}>Relações causais</h4>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>As setas do mapa. Cada relação liga um fato a outro com uma descrição curta do que a seta significa.</p>
      {doc.relacoes.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 7 }}>
          <select style={{ ...inputStyle, width: 'auto', flex: '1 1 120px', padding: '6px 8px' }} value={r.origem} onChange={(e) => updRel(r.id, { origem: e.target.value })}>
            {doc.fatos.map((f) => <option key={f.id} value={f.id}>{nameOf(f.id)}</option>)}
          </select>
          <input style={{ ...inputStyle, width: 'auto', flex: '1 1 100px', padding: '6px 8px', fontStyle: 'italic' }} placeholder="→ (ex.: alimenta)" value={r.descricao} onChange={(e) => updRel(r.id, { descricao: e.target.value })} />
          <select style={{ ...inputStyle, width: 'auto', flex: '1 1 120px', padding: '6px 8px' }} value={r.destino} onChange={(e) => updRel(r.id, { destino: e.target.value })}>
            {doc.fatos.map((f) => <option key={f.id} value={f.id}>{nameOf(f.id)}</option>)}
          </select>
          <Btn kind="danger" small onClick={() => delRel(r.id)}>×</Btn>
        </div>
      ))}
      <Btn kind="ghost" onClick={addRel} disabled={doc.fatos.length < 2}>+ relação</Btn>
    </div>
  );
}
function StepVariacoes({ doc, set }) {
  const add = (fatoId) => set({ variacoes: [...doc.variacoes, { id: uid(), fatoId, texto: '' }] });
  const upd = (id, patch) => set({ variacoes: doc.variacoes.map((v) => v.id === id ? { ...v, ...patch } : v) });
  const del = (id) => set({ variacoes: doc.variacoes.filter((v) => v.id !== id), pitfalls: doc.pitfalls.filter((p) => p.variacaoId !== id) });
  if (!doc.fatos.length) return <Empty>Adicione fatos na etapa 3 primeiro.</Empty>;
  return (
    <div>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>Para cada fato, abra as saídas clínicas possíveis. Costuma ajudar listar duas mais convencionais e ao menos uma mais criativa, que faça um movimento diferente das outras.</p>
      {doc.fatos.map((f) => (
        <FatoBlock key={f.id} color={C.fato} title={f.texto || '(fato sem texto)'}>
          {doc.variacoes.filter((v) => v.fatoId === f.id).map((v) => (
            <Row key={v.id} color={C.variacao} value={v.texto} placeholder="saída clínica possível" onChange={(val) => upd(v.id, { texto: val })} onDel={() => del(v.id)} />
          ))}
          <Btn kind="ghost" small onClick={() => add(f.id)} style={{ marginTop: 4 }}>+ variação</Btn>
        </FatoBlock>
      ))}
    </div>
  );
}
function StepPitfalls({ doc, set }) {
  const add = (variacaoId) => set({ pitfalls: [...doc.pitfalls, { id: uid(), variacaoId, texto: '', flagged: false }] });
  const upd = (id, patch) => set({ pitfalls: doc.pitfalls.map((p) => p.id === id ? { ...p, ...patch } : p) });
  const del = (id) => set({ pitfalls: doc.pitfalls.filter((p) => p.id !== id) });
  if (!doc.variacoes.length) return <Empty>Adicione variações na etapa 4 primeiro.</Empty>;
  return (
    <div>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>Para cada saída, o risco de execução embutido nela. Se não conseguir enxergar o risco de alguma, marque como pendente e leve isso para a supervisão.</p>
      {doc.fatos.map((f) => {
        const vars = doc.variacoes.filter((v) => v.fatoId === f.id);
        if (!vars.length) return null;
        return (
          <FatoBlock key={f.id} color={C.fato} title={f.texto || '(fato sem texto)'}>
            {vars.map((v) => (
              <div key={v.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.variacao, marginBottom: 4 }}>↳ {v.texto || '(variação sem texto)'}</div>
                {doc.pitfalls.filter((p) => p.variacaoId === v.id).map((p) => (
                  <div key={p.id} style={{ paddingLeft: 12 }}>
                    <Row color={C.pitfall} value={p.flagged ? '' : p.texto} disabled={p.flagged} placeholder={p.flagged ? 'marcado como pendente para a supervisão' : 'risco de execução'} onChange={(val) => upd(p.id, { texto: val })} onDel={() => del(p.id)} />
                    <label style={{ fontSize: 11, color: C.inkSoft, display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 4, marginBottom: 8 }}>
                      <input type="checkbox" checked={p.flagged} onChange={(e) => upd(p.id, { flagged: e.target.checked })} /> não consegui enxergar o risco
                    </label>
                  </div>
                ))}
                <div style={{ paddingLeft: 12 }}><Btn kind="ghost" small onClick={() => add(v.id)}>+ armadilha</Btn></div>
              </div>
            ))}
          </FatoBlock>
        );
      })}
    </div>
  );
}
function StepConceitos({ doc, set }) {
  const add = (fatoId) => set({ conceitos: [...doc.conceitos, { id: uid(), fatoId, texto: '', tipo: '' }] });
  const upd = (id, patch) => set({ conceitos: doc.conceitos.map((c) => c.id === id ? { ...c, ...patch } : c) });
  const del = (id) => set({ conceitos: doc.conceitos.filter((c) => c.id !== id) });
  if (!doc.fatos.length) return <Empty>Adicione fatos na etapa 3 primeiro.</Empty>;
  return (
    <div>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>Os conceitos, autores ou textos que você usa para pensar cada ponto. Ancore no caso concreto. O supervisor lê aqui de onde você parte e pode sugerir outros referenciais.</p>
      {doc.fatos.map((f) => (
        <FatoBlock key={f.id} color={C.fato} title={f.texto || '(fato sem texto)'}>
          {doc.conceitos.filter((c) => c.fatoId === f.id).map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input style={{ ...inputStyle, flex: 2 }} value={c.texto} placeholder="conceito, texto ou vídeo" onChange={(e) => upd(c.id, { texto: e.target.value })} />
              <input style={{ ...inputStyle, flex: 1 }} value={c.tipo} placeholder="autor (opcional)" onChange={(e) => upd(c.id, { tipo: e.target.value })} />
              <Btn kind="danger" small onClick={() => del(c.id)}>×</Btn>
            </div>
          ))}
          <Btn kind="ghost" small onClick={() => add(f.id)} style={{ marginTop: 4 }}>+ conceito</Btn>
        </FatoBlock>
      ))}
    </div>
  );
}
function StepDirecoes({ doc, set }) {
  const add = () => set({ direcoes: [...doc.direcoes, { id: uid(), texto: '' }] });
  const upd = (id, val) => set({ direcoes: doc.direcoes.map((d) => d.id === id ? { ...d, texto: val } : d) });
  const del = (id) => set({ direcoes: doc.direcoes.filter((d) => d.id !== id) });
  const move = (i, dir) => { const arr = [...doc.direcoes]; const j = i + dir; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; set({ direcoes: arr }); };
  return (
    <div>
      <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 0 }}>Com a clareza que só aparece agora, ordene o que você faria na próxima sessão. A ordem é a prioridade: o primeiro item é o que você faria antes de tudo.</p>
      {doc.direcoes.map((d, i) => (
        <div key={d.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 7 }}>
          <span style={{ width: 22, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.action, color: '#fff', borderRadius: 7, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
          <textarea style={{ ...inputStyle, minHeight: 34, resize: 'vertical' }} value={d.texto} placeholder="ação priorizada" onChange={(e) => upd(d.id, e.target.value)} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Btn kind="ghost" small onClick={() => move(i, -1)} style={{ padding: '2px 7px' }}>↑</Btn>
            <Btn kind="ghost" small onClick={() => move(i, 1)} style={{ padding: '2px 7px' }}>↓</Btn>
          </div>
          <Btn kind="danger" small onClick={() => del(d.id)}>×</Btn>
        </div>
      ))}
      <Btn kind="ghost" onClick={add}>+ direção</Btn>
    </div>
  );
}

/* ------------------------- reflexão (painel) ------------------------- */

function ReflectionPanel({ state, onClose }) {
  if (!state) return null;
  const lines = state.questions && state.questions.length
    ? state.questions
    : (state.text || '').split('\n').map((l) => l.replace(/^[-•\d.\s]+/, '').trim()).filter(Boolean);
  return (
    <div style={{ marginBottom: 16, border: `1px solid ${C.action}`, borderRadius: 11, background: '#fff', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 13px', background: C.action + '0F', borderBottom: `1px solid ${C.action}22` }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.action }}>Perguntas para você pensar · IA</span>
        <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: C.inkSoft, fontSize: 16, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ padding: '12px 14px' }}>
        {state.loading ? (
          <p style={{ fontSize: 13, color: C.inkSoft, margin: 0 }}>Lendo o que você escreveu…</p>
        ) : state.error ? (
          <p style={{ fontSize: 13, color: C.variacao, margin: 0 }}>{state.error}</p>
        ) : (
          <>
            {lines.map((l, i) => (
              <p key={i} style={{ fontSize: 13.5, color: C.ink, margin: '0 0 8px', paddingLeft: 14, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 0, color: C.action }}>›</span>{l}
              </p>
            ))}
            <p style={{ fontSize: 11, color: C.inkSoft, margin: '6px 0 0', fontStyle: 'italic' }}>Estas perguntas não trazem respostas. Elas só existem para você aprofundar o que já escreveu. Edite os campos acima como quiser.</p>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------- documento --------------------------- */

function Toggle({ on, c, label, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${on ? c : C.line}`, background: on ? c + '18' : 'transparent', borderRadius: 20, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, color: on ? c : C.inkSoft }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: on ? c : C.line }} />{label}
    </button>
  );
}
function Legenda() {
  const items = [[C.fato, 'Fatos e o objetivo do caso'], [C.variacao, 'Saídas clínicas'], [C.pitfall, 'Armadilhas'], [C.conceito, 'Conceitos']];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      {items.map(([c, l]) => (
        <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.inkSoft }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: c }} />{l}
        </span>
      ))}
    </div>
  );
}
function DocumentoView({ doc, meta }) {
  const layers = { causal: true, variacao: true, pitfall: true, conceito: true };
  return (
    <div style={{ padding: '4px 2px 24px' }} className="ant-print-full">
      <div style={{ maxWidth: 940, margin: '0 auto', background: C.surface, borderRadius: 12, border: `1px solid ${C.line}`, padding: '24px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4, gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', color: C.inkSoft }}>Título do caso{meta?.ownerName ? ` · ${meta.ownerName}` : ''}</div>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 600, margin: '2px 0 0', color: C.ink }}>{doc.titulo || '—'}</h1>
          </div>
          <Btn kind="solid" small onClick={() => window.print()} style={{ marginBottom: 6 }} className="ant-no-print">Exportar PDF</Btn>
        </div>
        <p style={{ fontSize: 14, color: C.ink, borderLeft: `3px solid ${C.fato}`, paddingLeft: 12, margin: '14px 0 20px' }}>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', color: C.inkSoft, display: 'block' }}>O que fazer com o caso</span>
          {doc.business || '—'}
        </p>
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, height: 560, overflow: 'hidden', background: C.surface, marginBottom: 22 }} className="ant-print-full">
          <SafeGraph doc={doc} layers={layers} focus={null} setFocus={() => {}} forPrint />
        </div>
        <Legenda />
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 600, color: C.ink, margin: '24px 0 10px' }}>Direções para a próxima sessão</h2>
        {doc.direcoes.length ? (
          <ol style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
            {doc.direcoes.map((d, i) => (
              <li key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
                <span style={{ width: 24, height: 24, borderRadius: 6, background: C.action, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ fontSize: 14, color: C.ink, paddingTop: 2 }}>{d.texto}</span>
              </li>
            ))}
          </ol>
        ) : <p style={{ fontSize: 13, color: C.inkSoft }}>—</p>}
      </div>
    </div>
  );
}

/* --------------------------- helpers de tela --------------------------- */

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function StatusChip({ status }) {
  const delivered = status === 'delivered';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, color: delivered ? C.fato : C.action, background: (delivered ? C.fato : C.action) + '18' }}>
      {delivered ? '✓ Entregue' : 'Rascunho'}
    </span>
  );
}

/* ------------------------------ editor ------------------------------ */

function Editor({ caseId, initialDoc, initialStatus, initialMeta, onBack, onChanged }) {
  const [doc, setDoc] = useState(() => ({ ...emptyDoc(), ...docFields(initialDoc) }));
  const [status, setStatus] = useState(initialStatus || 'draft');
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('wizard'); // wizard | documento
  const [tab, setTab] = useState('form');
  const [focus, setFocus] = useState(null);
  const [layers, setLayers] = useState({ causal: true, variacao: true, pitfall: false, conceito: false });
  const [reflect, setReflect] = useState(null); // {step, loading, questions, text, error}
  const [saveState, setSaveState] = useState('saved'); // saved | saving | dirty | error
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readOnly = status === 'delivered';
  const set = useCallback((patch) => { setDoc((d) => ({ ...d, ...patch })); setSaveState('dirty'); }, []);
  const et = ETAPAS[step - 1];

  // Liga as camadas relevantes conforme o aluno navega pelas etapas.
  useEffect(() => {
    if (step === 3) setLayers((l) => ({ ...l, causal: true }));
    if (step === 4) setLayers((l) => ({ ...l, variacao: true }));
    if (step === 5) setLayers((l) => ({ ...l, variacao: true, pitfall: true }));
    if (step === 6) setLayers((l) => ({ ...l, conceito: true }));
  }, [step]);

  // Autosave: grava no servidor 2s depois da última edição (só rascunho).
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => {
    if (readOnly || saveState !== 'dirty') return;
    const t = setTimeout(async () => {
      setSaveState('saving');
      try {
        await api.updateAntessalaCase(caseId, docFields(docRef.current));
        setSaveState((s) => (s === 'saving' ? 'saved' : s));
        onChanged && onChanged();
      } catch (e) {
        setSaveState('error');
        setError(e.message || 'Erro ao salvar.');
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [doc, saveState, readOnly, caseId, onChanged]);

  const saveNow = async () => {
    if (readOnly) return;
    setSaveState('saving');
    try {
      await api.updateAntessalaCase(caseId, docFields(docRef.current));
      setSaveState('saved');
      onChanged && onChanged();
    } catch (e) {
      setSaveState('error');
      setError(e.message || 'Erro ao salvar.');
    }
  };

  const runReflection = async () => {
    setReflect({ step, loading: true });
    try {
      const { questions, text } = await api.reflectAntessala(step, docFields(docRef.current));
      setReflect({ step, loading: false, questions, text });
    } catch (e) {
      setReflect({ step, loading: false, error: e.message || 'Não consegui gerar as perguntas agora. Tente de novo em instantes.' });
    }
  };

  const deliver = async () => {
    if (!window.confirm('Entregar este mapa para a supervisão? Depois de entregue você não poderá mais editá-lo.')) return;
    setBusy(true);
    setError('');
    try {
      await saveNow();
      const rec = await api.deliverAntessalaCase(caseId);
      setStatus(rec.status || 'delivered');
      setMode('documento');
      onChanged && onChanged();
    } catch (e) {
      setError(e.message || 'Erro ao entregar.');
    } finally {
      setBusy(false);
    }
  };

  const StepComp = { 1: StepTitulo, 2: StepBusiness, 3: StepFatos, 4: StepVariacoes, 5: StepPitfalls, 6: StepConceitos, 7: StepDirecoes }[step];

  const graphPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.surface }}>
      <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', borderBottom: `1px solid ${C.line}`, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: C.inkSoft, marginRight: 2 }}>Camadas</span>
        <Toggle on={layers.causal} c={C.inkSoft} label="Causa" onClick={() => setLayers((l) => ({ ...l, causal: !l.causal }))} />
        <Toggle on={layers.variacao} c={C.variacao} label="Variações" onClick={() => setLayers((l) => ({ ...l, variacao: !l.variacao }))} />
        <Toggle on={layers.pitfall} c={C.pitfall} label="Armadilhas" onClick={() => setLayers((l) => ({ ...l, pitfall: !l.pitfall }))} />
        <Toggle on={layers.conceito} c={C.conceito} label="Conceitos" onClick={() => setLayers((l) => ({ ...l, conceito: !l.conceito }))} />
        {focus ? <Btn kind="plain" small onClick={() => setFocus(null)} style={{ marginLeft: 'auto' }}>ver tudo</Btn> : null}
      </div>
      <div style={{ flex: 1, minHeight: 260 }}><SafeGraph doc={doc} layers={layers} focus={focus} setFocus={setFocus} /></div>
      <div style={{ fontSize: 11, color: C.inkSoft, padding: '6px 10px', borderTop: `1px solid ${C.line}` }}>Arraste para mover, role para dar zoom. Clique num fato verde para isolar o ramo dele.</div>
    </div>
  );

  const saveLabel = { saved: 'Salvo', saving: 'Salvando…', dirty: 'Alterações não salvas', error: 'Erro ao salvar' }[saveState];

  // Barra de navegação de topo do editor (voltar, status, entregar).
  const topBar = (
    <div className="ant-no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <Btn kind="ghost" small onClick={onBack}>← Meus mapas</Btn>
      <StatusChip status={status} />
      {!readOnly && (
        <span style={{ fontSize: 12, color: saveState === 'error' ? C.variacao : C.inkSoft }}>· {saveLabel}</span>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {!readOnly && <Btn kind="ghost" small onClick={saveNow} disabled={saveState === 'saving'}>Salvar agora</Btn>}
        <Btn kind={mode === 'documento' ? 'solid' : 'ghost'} small onClick={() => setMode(mode === 'documento' ? 'wizard' : 'documento')}>
          {mode === 'documento' ? (readOnly ? 'Voltar' : 'Editar') : 'Ver documento'}
        </Btn>
        {!readOnly && <Btn kind="accent" small onClick={deliver} disabled={busy}>Entregar para supervisão</Btn>}
      </div>
    </div>
  );

  return (
    <div style={{ color: C.ink }}>
      {topBar}
      {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}<button onClick={() => setError('')} className="close">×</button></div>}
      {readOnly && mode !== 'documento' && (
        <div style={{ marginBottom: 12, fontSize: 13, color: C.inkSoft, background: C.surfaceAlt, borderRadius: 10, padding: '10px 12px' }}>
          Este mapa já foi entregue para a supervisão e não pode mais ser editado. <button onClick={() => setMode('documento')} style={{ border: 'none', background: 'transparent', color: C.action, cursor: 'pointer', fontWeight: 600, padding: 0 }}>Ver documento</button>.
        </div>
      )}

      {mode === 'documento' ? (
        <DocumentoView doc={doc} meta={initialMeta} />
      ) : readOnly ? null : (
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
          {/* Trilha das 7 etapas */}
          <div className="ant-no-print" style={{ display: 'flex', gap: 4, padding: '10px 14px', borderBottom: `1px solid ${C.line}`, overflowX: 'auto' }}>
            {ETAPAS.map((e) => {
              const active = e.n === step;
              return (
                <button key={e.n} onClick={() => setStep(e.n)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, border: 'none', cursor: 'pointer', background: active ? C.surfaceAlt : 'transparent', borderRadius: 8, padding: '6px 10px', minWidth: 92, flexShrink: 0, borderBottom: active ? `2px solid ${C.action}` : '2px solid transparent', fontFamily: 'inherit', textAlign: 'left' }}>
                  <span style={{ fontSize: 10, color: e.noMapa ? C.action : C.inkSoft, fontWeight: 700 }}>{e.n}{e.noMapa ? ' ●' : ''}</span>
                  <span style={{ fontSize: 12, fontWeight: active ? 700 : 500, color: C.ink }}>{e.nome}</span>
                </button>
              );
            })}
          </div>

          {/* Alternância form/mapa em telas pequenas */}
          <div className="ant-no-print ant-lg-hide" style={{ display: 'flex', gap: 6, padding: '8px 14px 0' }}>
            <div style={{ display: 'flex', gap: 4, background: C.surfaceAlt, borderRadius: 9, padding: 3 }}>
              {['form', 'mapa'].map((t) => (
                <button key={t} onClick={() => setTab(t)} style={{ border: 'none', cursor: 'pointer', borderRadius: 7, padding: '5px 14px', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, background: tab === t ? C.surface : 'transparent', color: C.ink }}>{t === 'form' ? 'Formulário' : 'Mapa'}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', minHeight: 0, padding: 14, gap: 14 }}>
            <div className={tab === 'mapa' ? 'ant-pane-hide' : ''} style={{ flex: '1 1 46%', minWidth: 0, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: et.noMapa ? C.action : C.inkSoft }}>Etapa {et.n}</span>
                    <span style={{ fontSize: 10, color: C.inkSoft }}>{et.noMapa ? 'entra no mapa' : 'não entra no mapa'}</span>
                  </div>
                  <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 600, margin: '2px 0 0', color: C.ink }}>{et.nome}</h3>
                  <p style={{ fontSize: 12, color: C.inkSoft, margin: '1px 0 0' }}>{et.sub}</p>
                </div>
                <Btn kind="solid" onClick={runReflection} disabled={reflect && reflect.step === step && reflect.loading}
                  style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {reflect && reflect.step === step && reflect.loading ? 'Refletindo…' : '✦ Refletir com IA'}
                </Btn>
              </div>
              <div style={{ padding: 18, overflowY: 'auto', flex: 1 }}>
                {reflect && reflect.step === step ? <ReflectionPanel state={reflect} onClose={() => setReflect(null)} /> : null}
                <StepComp doc={doc} set={set} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 18px', borderTop: `1px solid ${C.line}` }}>
                <Btn kind="ghost" onClick={() => setStep(Math.max(1, step - 1))} disabled={step === 1}>← Voltar</Btn>
                {step < 7 ? <Btn kind="solid" onClick={() => setStep(step + 1)}>Avançar →</Btn> : <Btn kind="solid" onClick={() => setMode('documento')}>Ver documento</Btn>}
              </div>
            </div>
            <div className={`ant-lg-only ${tab === 'form' ? 'ant-pane-hide' : ''}`} style={{ flex: '1 1 54%', minWidth: 0, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>{graphPanel}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ lista ------------------------------ */

function CaseList({ cases, loading, onOpen, onNew, onDelete, creating }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Meus mapas</h3>
        <button className="btn btn-primary btn-sm" onClick={onNew} disabled={creating}>{creating ? 'Criando…' : '+ Novo mapa'}</button>
      </div>
      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}><span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span></div>
      ) : cases.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Nenhum mapa ainda. Crie o primeiro antes da sua próxima supervisão.
        </div>
      ) : (
        <div className="antessala-grid">
          {cases.map((c) => (
            <div key={c.id} className="card antessala-card" onClick={() => onOpen(c.id)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c.id); }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <h4 style={{ margin: 0, fontFamily: 'var(--serif)', fontSize: 18 }}>{c.titulo || 'Sem título'}</h4>
                <StatusChip status={c.status} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 8 }}>
                {c.fatosCount} fato{c.fatosCount === 1 ? '' : 's'} · atualizado {fmtDate(c.updatedAt)}
                {c.status === 'delivered' ? ` · entregue ${fmtDate(c.deliveredAt)}` : ''}
              </div>
              {c.status !== 'delivered' && (
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, color: 'var(--terra)' }}
                  onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}>Excluir</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------- vista do supervisor ------------------------- */

function SupervisorView() {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null); // { doc, meta }
  const [openLoading, setOpenLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getSupervisorAntessala()
      .then((list) => setCases(list || []))
      .catch((e) => setError(e.message || 'Erro ao carregar.'))
      .finally(() => setLoading(false));
  }, []);

  const openCase = async (id) => {
    setOpenLoading(true);
    setError('');
    try {
      const full = await api.getAntessalaCase(id);
      setOpen({ doc: { ...emptyDoc(), ...docFields(full) }, meta: { ownerName: full.ownerName, deliveredAt: full.deliveredAt } });
    } catch (e) {
      setError(e.message || 'Erro ao abrir o mapa.');
    } finally {
      setOpenLoading(false);
    }
  };

  // Agrupa por aluno pra facilitar a leitura longitudinal.
  const byStudent = useMemo(() => {
    const m = new Map();
    for (const c of cases) {
      const k = c.ownerName || c.ownerId;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(c);
    }
    return Array.from(m.entries());
  }, [cases]);

  if (open) {
    return (
      <div>
        <div className="ant-no-print" style={{ marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>← Voltar aos mapas</button>
        </div>
        <DocumentoView doc={open.doc} meta={open.meta} />
      </div>
    );
  }

  return (
    <div>
      {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}<button onClick={() => setError('')} className="close">×</button></div>}
      {openLoading && <div style={{ marginBottom: 12, color: 'var(--ink-soft)' }}><span className="spinner" /> Abrindo…</div>}
      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}><span className="spinner" /> <span style={{ marginLeft: 12, color: 'var(--ink-soft)' }}>Carregando…</span></div>
      ) : cases.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--ink-soft)' }}>
          Nenhum mapa entregue pelos seus alunos ainda.
        </div>
      ) : (
        byStudent.map(([student, list]) => (
          <div key={student} style={{ marginBottom: 22 }}>
            <h3 style={{ margin: '0 0 10px' }}>{student}</h3>
            <div className="antessala-grid">
              {list.map((c) => (
                <div key={c.id} className="card antessala-card" onClick={() => openCase(c.id)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') openCase(c.id); }}>
                  <h4 style={{ margin: 0, fontFamily: 'var(--serif)', fontSize: 18 }}>{c.titulo || 'Sem título'}</h4>
                  <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 8 }}>
                    {c.fatosCount} fato{c.fatosCount === 1 ? '' : 's'} · entregue {fmtDate(c.deliveredAt)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------ app ------------------------------ */

export default function Antessala({ user }) {
  const role = user?.role;
  const canWrite = role === 'therapist' || role === 'admin';
  const canSupervise = role === 'supervisor' || role === 'admin';

  // Admin vê os dois lados; escolhe pela aba. Supervisor puro só supervisiona.
  const [section, setSection] = useState(role === 'supervisor' ? 'supervisor' : 'meus');

  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(canWrite);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openData, setOpenData] = useState(null); // { doc, status, meta }
  const [openLoading, setOpenLoading] = useState(false);

  const loadCases = useCallback(() => {
    if (!canWrite) return;
    setLoading(true);
    api.getAntessalaCases()
      .then((list) => setCases(list || []))
      .catch((e) => setError(e.message || 'Erro ao carregar seus mapas.'))
      .finally(() => setLoading(false));
  }, [canWrite]);

  useEffect(() => { loadCases(); }, [loadCases]);

  const openCase = async (id) => {
    setOpenLoading(true);
    setError('');
    try {
      const full = await api.getAntessalaCase(id);
      setOpenData({ doc: full, status: full.status, meta: { ownerName: full.ownerName } });
      setOpenId(id);
    } catch (e) {
      setError(e.message || 'Erro ao abrir o mapa.');
    } finally {
      setOpenLoading(false);
    }
  };

  const newCase = async () => {
    setCreating(true);
    setError('');
    try {
      const rec = await api.createAntessalaCase(docFields(emptyDoc()));
      await loadCases();
      setOpenData({ doc: rec, status: rec.status, meta: { ownerName: rec.ownerName } });
      setOpenId(rec.id);
    } catch (e) {
      setError(e.message || 'Erro ao criar mapa.');
    } finally {
      setCreating(false);
    }
  };

  const deleteCase = async (id) => {
    if (!window.confirm('Excluir este mapa? Esta ação não pode ser desfeita.')) return;
    setError('');
    try {
      await api.deleteAntessalaCase(id);
      loadCases();
    } catch (e) {
      setError(e.message || 'Erro ao excluir.');
    }
  };

  const closeEditor = () => { setOpenId(null); setOpenData(null); loadCases(); };

  const showSupervisor = section === 'supervisor' && canSupervise;

  return (
    <div>
      {/* Estilos utilitários locais (responsivo + impressão). Prefixados com
          ant- pra não colidir com as classes globais do all_OS. */}
      <style>{`
        .antessala-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
        .antessala-card { cursor: pointer; transition: box-shadow .15s, transform .15s; }
        .antessala-card:hover { box-shadow: var(--shadow-md); transform: translateY(-1px); }
        @media print { .ant-no-print { display: none !important; } .ant-print-full { height: auto !important; } }
        @media (min-width: 900px) { .ant-lg-hide { display: none !important; } }
        @media (max-width: 899px) { .ant-lg-only { display: none !important; } .ant-pane-hide { display: none !important; } }
      `}</style>

      <div className="page-header ant-no-print">
        <div className="eyebrow">Pré-supervisão</div>
        <h2><Typewriter text="Antes" /><span className="accent"><Typewriter text="sala" delayStart={200} /></span></h2>
        <p>
          {canWrite && !showSupervisor
            ? 'Antes da supervisão, monte o mapa do caso: título, o que você vai fazer, fatos e suas relações, saídas clínicas, armadilhas, conceitos e direções. A IA só faz perguntas para você aprofundar — o raciocínio clínico é seu.'
            : 'Os mapas de pré-supervisão entregues pelos seus alunos. Cada mapa revela como o aluno organiza o caso e por onde pretende ir.'}
        </p>
        <div className="ornament" />
      </div>

      {/* Aviso de dados: o mapa fala de um paciente real, sem identificá-lo. */}
      {canWrite && !showSupervisor && !openId && (
        <div className="alert" style={{ marginBottom: 16, fontSize: 13 }}>
          Não escreva nome nem dado que identifique o paciente. Descreva os fatos com suas próprias palavras.
        </div>
      )}

      {/* Alternância de seção para admin (que é aluno e supervisor ao mesmo tempo) */}
      {canWrite && canSupervise && !openId && (
        <div className="ant-no-print" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <button className={`btn btn-sm ${section === 'meus' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSection('meus')}>Meus mapas</button>
          <button className={`btn btn-sm ${section === 'supervisor' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setSection('supervisor')}>Mapas dos alunos</button>
        </div>
      )}

      {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}<button onClick={() => setError('')} className="close">×</button></div>}
      {openLoading && !openId && <div style={{ marginBottom: 12, color: 'var(--ink-soft)' }}><span className="spinner" /> Abrindo…</div>}

      {openId && openData ? (
        <Editor
          key={openId}
          caseId={openId}
          initialDoc={openData.doc}
          initialStatus={openData.status}
          initialMeta={openData.meta}
          onBack={closeEditor}
          onChanged={loadCases}
        />
      ) : showSupervisor ? (
        <SupervisorView />
      ) : canWrite ? (
        <CaseList cases={cases} loading={loading} onOpen={openCase} onNew={newCase} onDelete={deleteCase} creating={creating} />
      ) : (
        <div className="card" style={{ color: 'var(--ink-soft)' }}>Sem acesso.</div>
      )}
    </div>
  );
}
