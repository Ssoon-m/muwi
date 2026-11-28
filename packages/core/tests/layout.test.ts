import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIZE, fitZoom, layoutFor, layoutGraph, layoutProblems, type Graph, type Layout } from '../src/layout.ts';

const graph = (edges: [string, string][], extra: string[] = []): Graph => {
  const ids = [...new Set([...edges.flat(), ...extra])];
  return { nodes: ids.map(id => ({ id })), edges: edges.map(([from, to]) => ({ from, to })) };
};

const GRAPHS: Record<string, Graph> = {
  '한 줄': graph([['read', 'branch'], ['branch', 'impl'], ['impl', 'check'], ['check', 'pr']]),
  '갈라졌다 모임': graph([['spec', 'a'], ['spec', 'b'], ['spec', 'c'], ['a', 'verify'], ['b', 'verify'], ['c', 'verify'], ['verify', 'pr']]),
  '건너뛰는 선': graph([['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd'], ['a', 'c'], ['b', 'd']]),
  '여러 갈래': graph([
    ['read', 'api'], ['read', 'ui'], ['read', 'docs'], ['api', 'api-test'], ['ui', 'ui-test'], ['api', 'ui'],
    ['api-test', 'review'], ['ui-test', 'review'], ['docs', 'review'], ['review', 'screen'], ['review', 'pr'], ['screen', 'pr'],
  ]),
  '따로 떨어진 노드': graph([['a', 'b']], ['alone', 'alone2']),
  '노드 하나': graph([], ['only']),
};

for (const [name, g] of Object.entries(GRAPHS)) {
  test(`배치: ${name} — 카드와 선이 겹치지 않는다`, async () => {
    const l = await layoutGraph(g);
    assert.deepEqual(layoutProblems(l), []);
    assert.equal(l.nodes.length, g.nodes.length);
    assert.equal(l.edges.length, g.edges.length);
    for (const n of l.nodes) assert.deepEqual([n.w, n.h], [SIZE.cardW, SIZE.cardH]);
    // 선은 왼쪽에서 오른쪽으로 흐른다
    const x = new Map(l.nodes.map(n => [n.id, n.x]));
    for (const e of l.edges) assert.ok(x.get(e.from)! < x.get(e.to)!, `${e.key}가 오른쪽으로 가지 않는다`);
  });
}

test('배치: 같은 계획이면 같은 좌표가 나온다', async () => {
  const [a, b] = [await layoutGraph(GRAPHS['여러 갈래']), await layoutGraph(GRAPHS['여러 갈래'])];
  assert.deepEqual(a, b);
});

test('배치: 셋째 줄이 있는 카드(tall)는 그만큼 높게 놓고 겹치지 않는다', async () => {
  const l = await layoutGraph({ nodes: [{ id: 'a' }, { id: 'b', tall: true }, { id: 'c', tall: true }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] });
  assert.deepEqual(l.nodes.map(n => n.h), [SIZE.cardH, SIZE.cardH + SIZE.lineH, SIZE.cardH + SIZE.lineH]);
  assert.deepEqual(layoutProblems(l), []);
});

test('배치: 노드가 없으면 빈 그림', async () => {
  assert.deepEqual(await layoutGraph({ nodes: [], edges: [] }), { width: 0, height: 0, nodes: [], edges: [] });
});

test('검사기: 겹친 카드와 카드를 지나는 선을 잡는다', () => {
  const bad: Layout = {
    width: 600, height: 200,
    nodes: [
      { id: 'a', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', x: 50, y: 20, w: 100, h: 40 },
      { id: 'c', x: 400, y: 0, w: 100, h: 40 },
    ],
    edges: [{ key: 'a|c', from: 'a', to: 'c', points: [[100, 30], [400, 30]] }],
  };
  const problems = layoutProblems(bad).join('\n');
  assert.match(problems, /카드 겹침: a ↔ b/);
  assert.match(problems, /선이 카드를 지남: a\|c → b/);
});

test('세로로 긴 칸에서는 위에서 아래로 흐른다. 선은 아래 변에서 나가 위 변으로 들어간다', async () => {
  const g: Graph = {
    nodes: [{ id: 'read' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'merge' }],
    edges: [{ from: 'read', to: 'a' }, { from: 'read', to: 'b' }, { from: 'read', to: 'c' }, { from: 'a', to: 'merge' }, { from: 'b', to: 'merge' }, { from: 'c', to: 'merge' }],
  };
  const l = await layoutGraph(g, SIZE, 'down');
  assert.deepEqual(layoutProblems(l, 'down'), []);
  const y = (id: string) => l.nodes.find(n => n.id === id)!.y;
  assert.ok(y('read') < y('a') && y('a') < y('merge'));
  // 위→아래로 그리면 세 갈래가 옆으로 놓여 폭이 높이보다 크지 않게 줄지어진다
  assert.ok(l.height > SIZE.cardH * 3);
});

test('긴 그래프는 칸 비율에 맞춰 여러 줄로 접는다. 칸에 잘 들어가는 그래프는 그대로 둔다', async () => {
  const chain = graph(Array.from({ length: 12 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]));
  const fit = { w: 1500, h: 950 };
  const zoom = (l: Layout, f = fit) => Math.min(1, f.w / l.width, f.h / l.height);
  // 칸 크기를 모르면 지금처럼 한 줄
  const flat = await layoutGraph(chain);
  assert.equal(new Set(flat.nodes.map(n => n.y)).size, 1);
  assert.equal(flat.wrapped, undefined);
  // 한 줄로는 칸에 너무 작게 들어간다: 여러 줄로 접어 더 크게 보인다. 배치 규칙(겹침·직각·옆면)은 그대로 지킨다
  const wrapped = await layoutGraph(chain, SIZE, 'right', fit);
  assert.equal(wrapped.wrapped, true);
  assert.ok(new Set(wrapped.nodes.map(n => n.y)).size > 1);
  assert.ok(zoom(wrapped) > zoom(flat) + 0.3, `${zoom(flat)} → ${zoom(wrapped)}`);
  assert.deepEqual(layoutProblems(wrapped), []);
  // 위→아래로 흐르는 좁고 긴 칸에서도
  const tall = { w: 480, h: 900 };
  const down = await layoutGraph(chain, SIZE, 'down', tall);
  assert.equal(down.wrapped, true);
  assert.ok(zoom(down, tall) > zoom(await layoutGraph(chain, SIZE, 'down'), tall));
  assert.deepEqual(layoutProblems(down, 'down'), []);
  // 갈래가 여러 개여도 접고, 규칙을 지킨다
  const branchy = await layoutGraph(GRAPHS['여러 갈래'], SIZE, 'right', { w: 700, h: 700 });
  assert.deepEqual(layoutProblems(branchy), []);
  // 칸에 잘 들어가는 그래프는 접지 않는다
  assert.equal((await layoutGraph(GRAPHS['한 줄'], SIZE, 'right', fit)).wrapped, undefined);
});

test('칸 모양으로 정한 방향보다 반대 방향이 칸에 훨씬 크게 들어가면 반대 방향으로 그린다. 배치는 ELK가 계산한 그대로다', async () => {
  // 나란히 하는 일이 여덟인 계획: 위→아래로 그리면 여덟 카드가 옆으로 늘어서 좁고 긴 칸보다 몇 배 넓다
  const fan = graph([
    ...Array.from({ length: 8 }, (_, i) => ['start', `c${i}`] as [string, string]),
    ...Array.from({ length: 8 }, (_, i) => [`c${i}`, 'end'] as [string, string]),
  ]);
  const narrow = { w: 454, h: 723 };
  const down = await layoutGraph(fan, SIZE, 'down', narrow);
  const picked = await layoutFor(fan, 'down', narrow);
  assert.equal(picked.flow, 'right');
  assert.ok(fitZoom(picked.layout, narrow) > fitZoom(down, narrow) * 1.25, `${fitZoom(down, narrow)} → ${fitZoom(picked.layout, narrow)}`);
  // 고른 배치는 그 방향으로 ELK가 계산한 것과 같다 (손대지 않는다)
  assert.deepEqual(picked.layout, await layoutGraph(fan, SIZE, 'right', narrow));
  assert.deepEqual(layoutProblems(picked.layout, picked.flow), []);
  // 넓은 칸에서는 칸 모양대로 왼쪽→오른쪽
  assert.equal((await layoutFor(fan, 'right', { w: 980, h: 945 })).flow, 'right');
  // 한 줄로 길게 이어진 계획은 좁고 긴 칸에서 칸 모양대로 위→아래
  const chain = graph(Array.from({ length: 12 }, (_, i) => [`n${i}`, `n${i + 1}`] as [string, string]));
  assert.equal((await layoutFor(chain, 'down', narrow)).flow, 'down');
  // 칸 크기를 모르면 정한 방향 그대로
  assert.equal((await layoutFor(fan, 'down')).flow, 'down');
});

test('여러 줄로 접을 때 선이 한 가닥만 지나는 곳에서만 자른다. 한 줄로도 읽히는 그래프는 접지 않는다', async () => {
  // 갈래가 갈라졌다 모이는 계획: 갈래 한가운데(c → d1·d2, d1·d2 → e)는 자르지 않는다
  const forked = graph([['a', 'b'], ['b', 'c'], ['c', 'd1'], ['c', 'd2'], ['d1', 'e'], ['d2', 'e'], ['e', 'f'], ['f', 'g']]);
  const fit = { w: 1230, h: 310 };
  const l = await layoutGraph(forked, SIZE, 'right', fit);
  assert.equal(l.wrapped, true);
  // 줄을 넘는 선: ELK가 다음 줄 처음으로 돌려 그린 선 (흐름을 거슬러 왼쪽으로 가는 부분이 있다)
  // 두 줄로 접히고, 줄 사이로는 갈래가 모인 뒤의 선(e → f) 한 가닥만 지나간다
  const back = l.edges.filter(e => e.points.some((p, i) => i > 0 && p[0] < e.points[i - 1][0] - 0.5));
  assert.deepEqual(back.map(e => e.key), ['e|f']);
  assert.deepEqual(layoutProblems(l), []);
  // 한 줄로 그려도 0.7배 넘게 보이면 접지 않는다 (노드 5개: 한 줄 1400px을 1100px 칸에 0.79배)
  assert.equal((await layoutGraph(GRAPHS['한 줄'], SIZE, 'right', { w: 1100, h: 400 })).wrapped, undefined);
});
