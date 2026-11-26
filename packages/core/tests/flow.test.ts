import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flowOf } from '../src/flow.ts';
import type { Event, NodeStatus, Plan } from '../src/store.ts';

// 계획: [id, 앞 노드들, 지금 상태]. 기록: [노드, 상태, 회차] (줄 순서가 일어난 순서다)
const plan = (nodes: [string, string[], NodeStatus][]): Plan =>
  ({ work: 'w', nodes: nodes.map(([id, after, status]) => ({ id, title: id, after, status })) }) as Plan;
const events = (lines: [string, NodeStatus, number?][]): Event[] =>
  lines.map(([node, status, attempt], i) => ({ at: new Date(Date.UTC(2026, 10, 26, 0, i)).toISOString(), session: 's', type: 'node', node, status, ...(attempt ? { attempt } : {}) }));
const lines = (f: { edges: { from: string; to: string }[] }) => f.edges.map(e => `${e.from}→${e.to}`).sort();

test('기록대로 진행한 계획은 계획의 선 그대로 그린다', () => {
  const p = plan([['read', [], 'done'], ['impl', ['read'], 'done'], ['check', ['impl'], 'doing'], ['pr', ['check'], 'todo']]);
  const f = flowOf(p, events([['read', 'doing'], ['read', 'done'], ['impl', 'doing'], ['impl', 'done'], ['check', 'doing']]));
  assert.deepEqual(f.cards, [{ id: 'read', node: 'read' }, { id: 'impl', node: 'impl' }, { id: 'check', node: 'check' }, { id: 'pr', node: 'pr' }]);
  assert.deepEqual(lines(f), ['check→pr', 'impl→check', 'read→impl']);
});

test('뒤 노드가 끝난 뒤 다시 한 회차는 새 카드로 그 뒤에 그린다: 확인 → 고침 → 다시 확인 → 다시 고침 → 전체 테스트', () => {
  const p = plan([['verify', [], 'done'], ['rework', ['verify'], 'done'], ['full', ['rework'], 'doing']]);
  const f = flowOf(p, events([
    ['verify', 'doing', 1], ['verify', 'done', 1],
    ['rework', 'doing', 1], ['rework', 'done', 1],
    ['verify', 'doing', 2], ['verify', 'done', 2],
    ['rework', 'doing', 2], ['rework', 'done', 2],
    ['full', 'doing', 1],
  ]));
  assert.deepEqual(f.cards, [
    { id: 'verify', node: 'verify', tries: [1] }, { id: 'verify#2', node: 'verify', tries: [2] },
    { id: 'rework', node: 'rework', tries: [1] }, { id: 'rework#2', node: 'rework', tries: [2] },
    { id: 'full', node: 'full' },
  ]);
  assert.deepEqual(lines(f), ['rework#2→full', 'rework→verify#2', 'verify#2→rework#2', 'verify→rework']);
});

test('사이에 끝난 카드 없이 다시 한 회차는 같은 카드에 둔다', () => {
  const p = plan([['impl', [], 'done'], ['check', ['impl'], 'todo']]);
  const f = flowOf(p, events([['impl', 'doing', 1], ['impl', 'done', 1], ['impl', 'doing', 2], ['impl', 'done', 2]]));
  assert.deepEqual(f.cards, [{ id: 'impl', node: 'impl' }, { id: 'check', node: 'check' }]);
  assert.deepEqual(lines(f), ['impl→check']);
});

test('다시 한 노드의 다음 노드: 다시 한 카드보다 먼저 시작했으면 앞 카드에, 시작 전이면 마지막 카드에 잇는다', () => {
  // 확인을 다시 하는 동안(뒤에서 도는 서브에이전트) 다음 일을 먼저 했다
  const p = plan([['check', [], 'done'], ['opts', ['check'], 'done'], ['next', ['opts'], 'done'], ['after', ['check'], 'todo']]);
  const f = flowOf(p, events([
    ['check', 'doing', 1], ['check', 'done', 1],
    ['opts', 'doing', 1], ['opts', 'done', 1],
    ['check', 'doing', 2], ['next', 'doing', 1], ['next', 'done', 1], ['check', 'done', 2],
  ]));
  assert.deepEqual(lines(f), ['check#2→after', 'check→opts', 'opts→check#2', 'opts→next']);
});

test('손대지 않은 노드 뒤에 붙은 노드는 그때 진행된 노드 뒤에 그린다: 남겨 둔 노드는 옆 가지가 된다', () => {
  // review → apply-review(응답 대기로 남김) → review2(시작 전) 뒤에 새 요청 reorg, usage를 이어 했다
  const p = plan([
    ['review', [], 'done'], ['apply-review', ['review'], 'done'], ['review2', ['apply-review'], 'doing'],
    ['reorg', ['review2'], 'done'], ['usage', ['reorg'], 'done'],
  ]);
  const f = flowOf(p, events([
    ['review', 'doing'], ['review', 'done'], ['apply-review', 'waiting'],
    ['reorg', 'doing'], ['reorg', 'waiting'], ['reorg', 'doing'], ['reorg', 'done'], ['usage', 'doing'], ['usage', 'done'],
    ['apply-review', 'doing'], ['apply-review', 'done'], ['review2', 'doing'],
  ]));
  assert.deepEqual(lines(f), ['apply-review→review2', 'reorg→usage', 'review→apply-review', 'review→reorg']);
});

test('하던 노드 앞에 끼워 넣은 노드: 하던 노드는 끼운 노드가 끝난 뒤 다시 움직였으므로 계획대로 그 뒤에 그린다', () => {
  // pr을 하다가 fix2를 앞에 끼워 넣었다 (pr은 잠시 멈춤). fix2를 끝내고 pr을 시작을 적지 않고 끝냈다
  const p = plan([['fix', [], 'done'], ['fix2', ['fix'], 'done'], ['pr', ['fix', 'fix2'], 'done']]);
  const f = flowOf(p, events([['fix', 'doing'], ['fix', 'done'], ['pr', 'doing'], ['pr', 'todo'], ['fix2', 'doing'], ['fix2', 'done'], ['pr', 'done']]));
  assert.deepEqual(lines(f), ['fix2→pr', 'fix→fix2', 'fix→pr']);
  // 아직 멈춰 있으면(다시 시작 전) 계획대로 둔다
  const paused = flowOf(plan([['fix', [], 'done'], ['fix2', ['fix'], 'doing'], ['pr', ['fix', 'fix2'], 'todo']]),
    events([['fix', 'doing'], ['fix', 'done'], ['pr', 'doing'], ['pr', 'todo'], ['fix2', 'doing']]));
  assert.deepEqual(lines(paused), ['fix2→pr', 'fix→fix2', 'fix→pr']);
});

test('앞 노드가 하는 중일 때 시작한 노드는 그 뒤에 그대로 둔다 (뒤에서 도는 일과 나란히 했다)', () => {
  const p = plan([['full', [], 'done'], ['g10', ['full'], 'done']]);
  const f = flowOf(p, events([['full', 'doing'], ['g10', 'doing'], ['g10', 'done'], ['full', 'done']]));
  assert.deepEqual(lines(f), ['full→g10']);
});

test('앞 노드 쪽으로 끝까지 올라가도 진행된 노드가 없으면 그 선은 그리지 않는다', () => {
  const p = plan([['a', [], 'todo'], ['b', ['a'], 'done']]);
  const f = flowOf(p, events([['b', 'doing'], ['b', 'done']]));
  assert.deepEqual(lines(f), []);
});
