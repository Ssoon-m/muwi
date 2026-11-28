// 그래프 배치. 카드와 연결선이 겹치지 않는 좌표를 계산한다.
// 계산은 ELK(Eclipse Layout Kernel, elkjs)의 layered 알고리즘이 한다. 왼쪽에서 오른쪽으로 흐르고 선은 직각으로 꺾인다.
// 세로로 긴 칸(그래프 칸을 높게 키웠을 때)에서는 위에서 아래로 흐르게 할 수 있다 (down).
// 칸 크기를 알면 두 방향을 다 ELK로 계산해 보고, 칸에 훨씬 크게 들어가는 방향을 쓴다 (layoutFor). 배치 자체는 ELK가 계산한 그대로다.
// 계획이 바뀌면 전체를 다시 계산한다. 그리는 쪽(보기)은 받은 좌표를 그대로 그린다 (muwi board).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type Point = [number, number];
export type Box = { x: number; y: number; w: number; h: number };
export type LayoutNode = Box & { id: string };
export type LayoutEdge = { key: string; from: string; to: string; points: Point[] };
export type Layout = { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; /** 칸 비율에 맞춰 여러 줄로 접었다 */ wrapped?: boolean };
/** 그래프를 그릴 칸의 크기 (그래프 칸이 알려 준다) */
export type Fit = { w: number; h: number };
/** tall: 카드에 셋째 줄이 있다 (다시 한 노드). 그만큼 높게 놓는다 */
export type Graph = { nodes: { id: string; tall?: boolean }[]; edges: { from: string; to: string }[] };
/** 흐름의 방향: 왼쪽→오른쪽(right) 또는 위→아래(down) */
export type Flow = 'right' | 'down';

/** 카드 크기 (px, 확대 1 기준). lineH: 셋째 줄이 있는 카드에 더하는 높이. 그리는 쪽과 같아야 한다 */
export const SIZE = { cardW: 224, cardH: 62, lineH: 16 };
type Size = { cardW: number; cardH: number; lineH?: number };

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  // 계획에 적은 순서를 따른다. 같은 계획이면 같은 그림이 나온다
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'NONE',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '22',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.edgeEdge': '10',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '10',
  'elk.padding': '[top=28,left=28,bottom=28,right=28]',
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 한 줄로 그리면 칸에 이 배율보다 작게 들어갈 때만 여러 줄로 접는다. 그보다 크면 글자가 읽히므로 한 줄 그대로 둔다.
 * 그래프 칸이 글자가 읽히는 크기로 보는 배율(터미널 아래 칸에서 0.7배까지 줄여 담는다)과 같다
 */
const WRAP_BELOW = 0.7;

/**
 * 계획을 그래프로 배치한다. fit(그릴 칸의 크기)을 주면, 한 줄로는 칸에 너무 작게 들어가는 긴 그래프를
 * 칸 비율에 맞춰 여러 줄로 접는다 (ELK의 graph wrapping). 접어도 더 크게 보이지 않으면 한 줄 그대로 둔다
 */
export async function layoutGraph(g: Graph, size: Size = SIZE, flow: Flow = 'right', fit?: Fit): Promise<Layout> {
  const flat = await place(g, size, flow);
  if (!fit || fit.w <= 0 || fit.h <= 0 || !flat.nodes.length) return flat;
  const zoom = (l: Layout) => fitZoom(l, fit);
  if (zoom(flat) >= WRAP_BELOW) return flat;
  // 선이 한 가닥만 지나는 곳에서만 자른다 (SINGLE_EDGE). 갈래 한가운데를 자르지 않아서 줄과 줄 사이로는 선이 늘 한 가닥만 지나간다.
  // 그런 곳이 없는 계획은 ELK가 접지 못하므로 한 줄 그대로 둔다 (MULTI_EDGE는 갈래 한가운데도 잘라 선 여러 가닥이 줄 사이를 길게 돌아갔다)
  const wrapped = await place(g, size, flow, { 'elk.layered.wrapping.strategy': 'SINGLE_EDGE', 'elk.aspectRatio': String(fit.w / fit.h) });
  return zoom(wrapped) > zoom(flat) + 0.05 ? { ...wrapped, wrapped: true } : flat;
}

async function place(g: Graph, size: Size, flow: Flow, extra: Record<string, string> = {}): Promise<Layout> {
  if (!g.nodes.length) return { width: 0, height: 0, nodes: [], edges: [] };
  // elkjs의 한 파일짜리 판 (워커 없이 이 프로세스에서 계산한다)
  const ELK = require('elkjs/lib/elk.bundled.js');
  const ids = new Set(g.nodes.map(n => n.id));
  const lines = g.edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(e => ({ key: `${e.from}|${e.to}`, from: e.from, to: e.to }));
  const out = await new ELK().layout({
    id: 'plan',
    layoutOptions: { ...(flow === 'down' ? { ...OPTIONS, 'elk.direction': 'DOWN', 'elk.layered.spacing.nodeNodeBetweenLayers': '40' } : OPTIONS), ...extra },
    children: g.nodes.map(n => ({ id: n.id, width: size.cardW, height: size.cardH + (n.tall ? size.lineH ?? 0 : 0) })),
    edges: lines.map(l => ({ id: l.key, sources: [l.from], targets: [l.to] })),
  });
  const nodes: LayoutNode[] = out.children.map((c: any) => ({ id: c.id, x: r1(c.x), y: r1(c.y), w: c.width, h: c.height }));
  const edges: LayoutEdge[] = out.edges.map((e: any, i: number) => {
    const s = e.sections?.[0];
    if (!s) throw new Error(`선을 잇지 못했어요: ${lines[i].key}`);
    const points: Point[] = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p: any) => [r1(p.x), r1(p.y)]);
    return { ...lines[i], points };
  });
  return { width: Math.ceil(out.width), height: Math.ceil(out.height), nodes, edges };
}

/** 그래프가 칸에 다 들어가는 배율. 칸보다 작은 그래프를 키우지는 않는다 (1까지) */
export const fitZoom = (l: Layout, fit: Fit): number => (l.width && l.height ? Math.min(1, fit.w / l.width, fit.h / l.height) : 1);

/** 반대 방향이 칸에 이만큼 넘게 크게 들어가야 칸 모양으로 정한 방향을 버린다 (비슷하면 칸 모양을 따른다) */
const SWITCH = 1.25;

/**
 * 칸에 맞는 흐름 방향으로 배치한다. 칸 모양으로 정한 방향(prefer)을 쓰되, 반대 방향이 칸에 훨씬 크게 들어가면 반대 방향을 쓴다.
 * 두 방향 모두 ELK가 계산한 배치(필요하면 여러 줄로 접은 것)를 그대로 쓰고, 어느 쪽을 쓸지만 고른다.
 * 예: 나란히 하는 일이 여덟인 계획을 좁고 긴 칸에서 위→아래로 그리면 여덟 카드가 옆으로 늘어서 칸보다 몇 배 넓어진다.
 * 왼쪽→오른쪽으로 그리면 여덟 카드가 세로로 쌓여 칸에 들어간다
 */
export async function layoutFor(g: Graph, prefer: Flow, fit?: Fit, size: Size = SIZE): Promise<{ layout: Layout; flow: Flow }> {
  const layout = await layoutGraph(g, size, prefer, fit);
  // 칸에 거의 다 들어가면 반대 방향이 더 나을 수 없다 (1배보다 키우지 않는다)
  if (!fit || fit.w <= 0 || fit.h <= 0 || !layout.nodes.length || fitZoom(layout, fit) * SWITCH >= 1) return { layout, flow: prefer };
  const other: Flow = prefer === 'down' ? 'right' : 'down';
  const alt = await layoutGraph(g, size, other, fit);
  return fitZoom(alt, fit) > fitZoom(layout, fit) * SWITCH ? { layout: alt, flow: other } : { layout, flow: prefer };
}

// ── 겹침 검사 ──────────────────────────────────────────────────────────
// 배치가 지켜야 할 것: 카드끼리 겹치지 않는다, 선은 직각으로 꺾인다,
// 선은 출발 카드 오른쪽 변에서 나가 도착 카드 왼쪽 변으로 들어간다 (위→아래면 아래 변에서 나가 위 변으로), 선이 카드를 지나지 않는다,
// 두 선이 같은 줄 위에 포개지지 않는다.

type Seg = { a: Point; b: Point; edge: string };

const segsOf = (e: LayoutEdge): Seg[] => e.points.slice(1).map((p, i) => ({ a: e.points[i], b: p, edge: e.key }));
const inset = (b: Box, d: number): Box => ({ x: b.x + d, y: b.y + d, w: b.w - 2 * d, h: b.h - 2 * d });
const boxesMeet = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

function segCrosses(s: Seg, b: Box): boolean {
  const [x1, x2] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
  const [y1, y2] = [Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
  return x1 < b.x + b.w && x2 > b.x && y1 < b.y + b.h && y2 > b.y;
}

/** 배치의 문제 목록. 비어 있으면 겹침 없이 그릴 수 있다 */
export function layoutProblems(l: Layout, flow: Flow = 'right'): string[] {
  const out: string[] = [];
  const at = new Map(l.nodes.map(n => [n.id, n]));
  const segs = l.edges.flatMap(segsOf);

  for (let i = 0; i < l.nodes.length; i++) {
    for (let j = i + 1; j < l.nodes.length; j++) {
      if (boxesMeet(l.nodes[i], l.nodes[j])) out.push(`카드 겹침: ${l.nodes[i].id} ↔ ${l.nodes[j].id}`);
    }
  }
  for (const e of l.edges) {
    const src = at.get(e.from), dst = at.get(e.to);
    if (!src || !dst) {
      out.push(`없는 카드에 이은 선: ${e.key}`);
      continue;
    }
    const [p0, pn] = [e.points[0], e.points[e.points.length - 1]];
    if (flow === 'down') {
      if (Math.abs(p0[1] - (src.y + src.h)) > 0.6 || p0[0] < src.x || p0[0] > src.x + src.w) out.push(`선이 출발 카드 아래 변에서 나가지 않음: ${e.key}`);
      if (Math.abs(pn[1] - dst.y) > 0.6 || pn[0] < dst.x || pn[0] > dst.x + dst.w) out.push(`선이 도착 카드 위 변으로 들어가지 않음: ${e.key}`);
    } else {
      if (Math.abs(p0[0] - (src.x + src.w)) > 0.6 || p0[1] < src.y || p0[1] > src.y + src.h) out.push(`선이 출발 카드 오른쪽 변에서 나가지 않음: ${e.key}`);
      if (Math.abs(pn[0] - dst.x) > 0.6 || pn[1] < dst.y || pn[1] > dst.y + dst.h) out.push(`선이 도착 카드 왼쪽 변으로 들어가지 않음: ${e.key}`);
    }
    for (const s of segsOf(e)) {
      if (Math.abs(s.a[0] - s.b[0]) > 0.6 && Math.abs(s.a[1] - s.b[1]) > 0.6) out.push(`비스듬한 선: ${e.key}`);
    }
  }
  for (const s of segs) {
    for (const n of l.nodes) if (segCrosses(s, inset(n, 1))) out.push(`선이 카드를 지남: ${s.edge} → ${n.id}`);
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [s, t] = [segs[i], segs[j]];
      if (s.edge === t.edge) continue;
      const sh = Math.abs(s.a[1] - s.b[1]) < 0.6, th = Math.abs(t.a[1] - t.b[1]) < 0.6;
      if (sh !== th) continue;
      const k = sh ? 1 : 0, m = sh ? 0 : 1;
      if (Math.abs(s.a[k] - t.a[k]) > 0.6) continue;
      const lo = Math.max(Math.min(s.a[m], s.b[m]), Math.min(t.a[m], t.b[m]));
      const hi = Math.min(Math.max(s.a[m], s.b[m]), Math.max(t.a[m], t.b[m]));
      if (hi - lo > 2) out.push(`선 포개짐: ${s.edge} ↔ ${t.edge}`);
    }
  }
  return [...new Set(out)];
}
