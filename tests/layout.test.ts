import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIZE, layoutGraph, layoutProblems, type Graph, type Layout } from '../src/layout.ts';

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
