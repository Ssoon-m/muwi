// Herdr 설정 화면(Look > Layout)에 보일 muwi 레이아웃 그림. 레이아웃 파일의 "preview"가 이 그림을 가리킨다.
// 그림이 없으면 설정 화면은 빈 틀만 그린다. 320×200이고 설정 화면에서는 96×62쯤으로 줄어 보이므로 간단하게 그린다:
// 왼쪽 작업 목록(상태 색 점), 오른쪽 터미널과 그래프 칸. 그래프 칸은 그 레이아웃의 자리(위·아래·오른쪽)대로 그린다.
// 그림 파일은 테마를 따라가지 못해 어두운 색 하나로 그린다 (Herdr의 Terminals·Herdr 98 그림도 그렇다)
import type { GraphAt } from './screen.ts';

const C = {
  bg: '#1a1c21', side: '#202329', divider: '#2a2e36', canvas: '#1f2228', term: '#16181c',
  text: '#5b6270', faint: '#383d47',
  node: '#272b33', nodeEdge: '#363b45', doingFill: '#2e2a20',
  blue: '#61afef', yellow: '#e5c07b', purple: '#c678dd', green: '#98c379',
};

type Box = { x: number; y: number; w: number; h: number };
type Status = 'done' | 'doing' | 'todo';

export function layoutPreview(where: GraphAt = 'bottom'): string {
  const out: string[] = [];
  const rect = (b: Box, fill: string, rx = 0, extra = '') =>
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${extra}/>`);
  const bar = (x: number, y: number, w: number, fill: string, h = 5) => rect({ x, y: y - h / 2, w, h }, fill, h / 2);
  const dot = (x: number, y: number, r: number, fill: string) => out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`);
  const ring = (x: number, y: number, r: number, color: string) => out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="1.6"/>`);

  rect({ x: 0, y: 0, w: 320, h: 200 }, C.bg);

  // 작업 목록: 응답 대기 · 작업 중 · 새 결과 · 끝 · 끝
  rect({ x: 0, y: 0, w: 80, h: 200 }, C.side);
  rect({ x: 80, y: 0, w: 1.5, h: 200 }, C.divider);
  const rows: [string, number, string][] = [[C.purple, 38, C.text], [C.yellow, 30, C.text], [C.blue, 42, C.text], [C.faint, 34, C.faint], [C.faint, 26, C.faint]];
  rows.forEach(([color, w, line], i) => {
    const y = 52 + i * 24;
    dot(18, y, 4, color);
    bar(30, y, w, line);
  });

  // 터미널과 그래프 칸의 자리
  let graph: Box, term: Box;
  if (where === 'top') {
    graph = { x: 81.5, y: 0, w: 238.5, h: 112 };
    term = { x: 81.5, y: 113.5, w: 238.5, h: 86.5 };
  } else if (where === 'right') {
    term = { x: 81.5, y: 0, w: 118.5, h: 200 };
    graph = { x: 201.5, y: 0, w: 118.5, h: 200 };
  } else {
    term = { x: 81.5, y: 0, w: 238.5, h: 86.5 };
    graph = { x: 81.5, y: 88, w: 238.5, h: 112 };
  }
  if (where === 'top') rect({ x: 81.5, y: 112, w: 238.5, h: 1.5 }, C.divider);
  if (where === 'bottom') rect({ x: 81.5, y: 86.5, w: 238.5, h: 1.5 }, C.divider);
  if (where === 'right') rect({ x: 200, y: 0, w: 1.5, h: 200 }, C.divider);

  // 터미널: 세 줄만
  rect(term, C.term);
  const tx = term.x + 16, ty = term.y + Math.min(26, term.h / 4);
  dot(tx, ty, 2.6, C.green);
  bar(tx + 8, ty, Math.min(84, term.w - 40), C.text, 4.5);
  bar(tx - 2.6, ty + 18, Math.min(136, term.w - 32), C.faint, 4.5);
  bar(tx - 2.6, ty + 36, Math.min(100, term.w - 50), C.faint, 4.5);

  // 그래프: 끝난 노드 → 끝난 노드·작업 중인 노드 → 아직
  rect(graph, C.canvas);
  const down = where === 'right';
  const W = down ? 40 : 54, H = down ? 18 : 20;
  const at = (x: number, y: number, s: Status) => ({ b: { x, y, w: W, h: H }, s });
  let nodes: { b: Box; s: Status }[];
  if (!down) {
    const gap = 22, x0 = graph.x + (graph.w - (3 * W + 2 * gap)) / 2, cy = graph.y + graph.h / 2 - H / 2;
    nodes = [at(x0, cy, 'done'), at(x0 + W + gap, cy - 17, 'done'), at(x0 + W + gap, cy + 17, 'doing'), at(x0 + 2 * (W + gap), cy, 'todo')];
  } else {
    const gap = 10, cx = graph.x + (graph.w - W) / 2, x0 = graph.x + (graph.w - (2 * W + gap)) / 2;
    nodes = [at(cx, 44, 'done'), at(x0, 91, 'done'), at(x0 + W + gap, 91, 'doing'), at(cx, 138, 'todo')];
  }
  const [a, b1, b2, c] = nodes;

  // 선: 끝난 노드에서 나가는 선은 파랑, 나머지는 흐리게. 꺾이는 곳은 둥글게
  const edge = (from: { b: Box; s: Status }, to: { b: Box; s: Status }) => {
    const color = from.s === 'done' ? C.blue : C.faint;
    const f = from.b, t = to.b, r = 5;
    let d: string;
    if (!down) {
      const x1 = f.x + f.w, y1 = f.y + f.h / 2, x2 = t.x, y2 = t.y + t.h / 2, mx = (x1 + x2) / 2;
      const s = Math.sign(y2 - y1), k = Math.min(r, Math.abs(y2 - y1) / 2);
      d = s === 0 ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} H${mx - k} Q${mx} ${y1} ${mx} ${y1 + s * k} V${y2 - s * k} Q${mx} ${y2} ${mx + k} ${y2} H${x2}`;
    } else {
      const x1 = f.x + f.w / 2, y1 = f.y + f.h, x2 = t.x + t.w / 2, y2 = t.y, my = (y1 + y2) / 2;
      const s = Math.sign(x2 - x1), k = Math.min(r, Math.abs(x2 - x1) / 2);
      d = s === 0 ? `M${x1} ${y1} V${y2}` : `M${x1} ${y1} V${my - k} Q${x1} ${my} ${x1 + s * k} ${my} H${x2 - s * k} Q${x2} ${my} ${x2} ${my + k} V${y2}`;
    }
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
  };
  edge(a, b1); edge(a, b2); edge(b1, c); edge(b2, c);

  // 노드: 상태 점 하나와 제목 한 줄. 작업 중인 노드는 노랗게 빛난다
  for (const { b, s } of nodes) {
    if (s === 'doing') rect({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }, C.yellow, 9, ' opacity="0.14"');
    rect(b, s === 'doing' ? C.doingFill : C.node, 6, ` stroke="${s === 'doing' ? C.yellow : C.nodeEdge}" stroke-width="${s === 'doing' ? 1.6 : 1.2}"`);
    const cy = b.y + b.h / 2, ix = b.x + 10;
    if (s === 'done') dot(ix, cy, 3.4, C.blue);
    if (s === 'doing') dot(ix, cy, 3.4, C.yellow);
    if (s === 'todo') ring(ix, cy, 3, C.text);
    bar(b.x + 19, cy, b.w - (down ? 27 : 29), s === 'todo' ? C.faint : C.text, 4);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200">\n  ${out.join('\n  ')}\n</svg>\n`;
}
