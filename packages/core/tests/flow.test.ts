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

/** 선이 하나도 없는 카드 (기록이 있는 카드는 맨 앞 카드가 아니면 떨어지면 안 된다) */
const loose = (f: { cards: { id: string }[]; edges: { from: string; to: string }[] }) =>
  f.cards.map(c => c.id).filter(id => !f.edges.some(e => e.from === id || e.to === id));

test('다시 하던 회차 앞에 노드를 끼워 넣으면(--before, 잠시 멈춤) 끼운 노드는 그 회차 카드 앞에 그린다', () => {
  // verify를 다시 하다가(2회차, rework 뒤의 새 카드) 먼저 고칠 것을 앞에 끼웠다. fixfirst는 앞 노드가 없다
  const lines2 = (status: NodeStatus, extra: [string, NodeStatus, number?][]) => flowOf(
    plan([['impl', [], 'done'], ['fixfirst', [], extra.length > 1 ? 'done' : 'doing'], ['verify', ['impl', 'fixfirst'], status], ['rework', ['verify'], 'done']]),
    events([
      ['impl', 'doing'], ['impl', 'done'], ['verify', 'doing', 1], ['verify', 'done', 1], ['rework', 'doing', 1], ['rework', 'done', 1],
      ['verify', 'doing', 2], ['verify', 'todo', 2], ...extra,
    ]),
  );
  // 끼운 노드를 하는 중 (verify는 잠시 멈춤)
  const paused = lines2('todo', [['fixfirst', 'doing']]);
  assert.deepEqual(lines(paused), ['fixfirst→verify#2', 'impl→verify', 'rework→verify#2', 'verify→rework']);
  // 끼운 노드를 끝내고 verify를 다시 움직여 끝냈다
  const after = lines2('done', [['fixfirst', 'doing'], ['fixfirst', 'done'], ['verify', 'doing', 2], ['verify', 'done', 2]]);
  assert.deepEqual(lines(after), ['fixfirst→verify#2', 'impl→verify', 'rework→verify#2', 'verify→rework']);
  assert.deepEqual(loose(after), []);
});

test('두 노드를 다시 한 회차가 겹쳐도(확인을 다시 하는 동안 고침을 다시 했다) 고리 없이 둘 다 잇는다', () => {
  const p = plan([['verify', [], 'done'], ['rework', ['verify'], 'done'], ['full', ['rework'], 'todo']]);
  const f = flowOf(p, events([
    ['verify', 'doing', 1], ['verify', 'done', 1], ['rework', 'doing', 1], ['rework', 'done', 1],
    ['verify', 'doing', 2], ['rework', 'doing', 2], ['rework', 'done', 2], ['verify', 'done', 2],
  ]));
  // rework 2회차를 시작할 때 verify 2회차가 끝나지 않았으므로 rework는 한 카드(1~2회차)다
  assert.deepEqual(f.cards.filter(c => c.tries).map(c => `${c.id}[${c.tries}]`), ['verify[1]', 'verify#2[2]']);
  // 아직 시작하지 않은 full은 마지막에 끝난 다시 확인(verify#2) 뒤에 할 일이다
  assert.deepEqual(lines(f), ['rework→verify#2', 'verify#2→full', 'verify→rework']);
  assert.deepEqual(loose(f), []);
  // 앞 노드를 다시 해 응답 대기로 둔 사이에 뒤 노드를 다시 했다: 뒤 노드(1~2회차)는 앞 노드의 1회차 뒤에 남는다
  const g = flowOf(plan([['a', [], 'waiting'], ['b', ['a'], 'done']]), events([
    ['a', 'doing', 1], ['a', 'done', 1], ['b', 'doing', 1], ['b', 'done', 1], ['a', 'doing', 2], ['a', 'waiting', 2], ['b', 'doing', 2], ['b', 'done', 2],
  ]));
  assert.deepEqual(lines(g), ['a→b', 'b→a#2']);
});

test('세 번 다시 한 고리: 회차마다 그 사이에 끝난 카드 뒤에 그린다', () => {
  const p = plan([['fix', [], 'done'], ['check', ['fix'], 'done'], ['pr', ['check'], 'doing']]);
  const f = flowOf(p, events([
    ['fix', 'doing', 1], ['fix', 'done', 1], ['check', 'doing', 1], ['check', 'done', 1],
    ['fix', 'doing', 2], ['fix', 'done', 2], ['check', 'doing', 2], ['check', 'done', 2],
    ['fix', 'doing', 3], ['fix', 'done', 3], ['check', 'doing', 3], ['check', 'done', 3], ['pr', 'doing'],
  ]));
  assert.deepEqual(lines(f), ['check#2→fix#3', 'check#3→pr', 'check→fix#2', 'fix#2→check#2', 'fix#3→check#3', 'fix→check']);
});

test('다시 한 카드를 끝낸 뒤 시작한 다음 일은, 계획상 그 앞 카드 다음이어도 다시 한 카드 뒤에 그린다', () => {
  // recheck에서 걸려 fix를 다시 했고(2회차), 그 뒤에 screens를 했다. 계획은 recheck → screens
  const p = plan([['fix', [], 'done'], ['recheck', ['fix'], 'done'], ['screens', ['recheck'], 'done']]);
  const f = flowOf(p, events([
    ['fix', 'doing', 1], ['fix', 'done', 1], ['recheck', 'doing', 1], ['recheck', 'done', 1],
    ['fix', 'doing', 2], ['fix', 'done', 2], ['screens', 'doing'], ['screens', 'done'],
  ]));
  assert.deepEqual(lines(f), ['fix#2→screens', 'fix→recheck', 'recheck→fix#2']);
  // 다시 한 카드가 아직 하는 중일 때 시작했으면 나란히 둔다
  const g = flowOf(p, events([
    ['fix', 'doing', 1], ['fix', 'done', 1], ['recheck', 'doing', 1], ['recheck', 'done', 1],
    ['fix', 'doing', 2], ['screens', 'doing'], ['screens', 'done'], ['fix', 'done', 2],
  ]));
  assert.deepEqual(lines(g), ['fix→recheck', 'recheck→fix#2', 'recheck→screens']);
});

test('앞 노드 쪽으로 올라가도 끝났거나 하는 노드가 없으면 시작한 적 있는 노드(응답 대기) 뒤에 그린다', () => {
  // ask는 답을 기다리고, impl은 시작 전인데 새 요청 x를 했다
  const p = plan([['ask', [], 'waiting'], ['impl', ['ask'], 'todo'], ['x', ['impl'], 'done']]);
  const f = flowOf(p, events([['ask', 'doing'], ['ask', 'waiting'], ['x', 'doing'], ['x', 'done']]));
  assert.deepEqual(lines(f), ['ask→impl', 'ask→x']);
  assert.deepEqual(loose(f), []);
});

test('다시 하는 중인 카드 뒤의 아직 시작하지 않은 일은 그 카드 뒤에 그린다 (끝나는 순간 자리가 옮겨지지 않게)', () => {
  const p = plan([['fix', [], 'doing'], ['recheck', ['fix'], 'done'], ['screens', ['recheck'], 'todo']]);
  const f = flowOf(p, events([
    ['fix', 'doing', 1], ['fix', 'done', 1], ['recheck', 'doing', 1], ['recheck', 'done', 1], ['fix', 'doing', 2],
  ]));
  assert.deepEqual(lines(f), ['fix#2→screens', 'fix→recheck', 'recheck→fix#2']);
});

test('앞 노드를 하고 있을 때 시작한 노드는 그 앞의 끝난 노드가 아니라 하고 있던 앞 노드 뒤에 그린다', () => {
  const p = plan([['r', [], 'done'], ['a', ['r'], 'doing'], ['b', ['a'], 'done']]);
  const f = flowOf(p, events([['r', 'doing'], ['r', 'done'], ['a', 'doing'], ['b', 'doing'], ['b', 'done']]));
  assert.deepEqual(lines(f), ['a→b', 'r→a']);
});

test('노드를 마지막으로 다시 움직인 때로 잰다: 앞당겨 시작했다가 기다리는 동안 앞 노드를 끝냈으면 그 뒤에 그린다', () => {
  const p = plan([['r', [], 'done'], ['a', ['r'], 'done'], ['b', ['a'], 'done']]);
  const f = flowOf(p, events([
    ['r', 'doing'], ['r', 'done'], ['b', 'doing'], ['b', 'waiting'], ['a', 'doing'], ['a', 'done'], ['b', 'doing'], ['b', 'done'],
  ]));
  assert.deepEqual(lines(f), ['a→b', 'r→a']);
});

test('잠시 멈춘 노드도 시작한 적 있는 노드다: 맨 앞 노드를 멈추고 다음 노드를 하면 그 뒤에 그린다', () => {
  const p = plan([['read', [], 'todo'], ['impl', ['read'], 'done']]);
  const f = flowOf(p, events([['read', 'doing'], ['read', 'todo'], ['impl', 'doing'], ['impl', 'done']]));
  assert.deepEqual(lines(f), ['read→impl']);
});

test('잠시 멈춘 노드(카드 하나)는 계획의 앞 노드들 뒤에만 그린다: 앞당겨 시작했던 때의 선을 더하지 않는다', () => {
  // pr을 앞당겨 시작했다가(prbody 시작 전) 멈추고 video, prbody를 하는 중이다
  const p = plan([['rename', [], 'done'], ['video', ['rename'], 'done'], ['prbody', ['video'], 'doing'], ['pr', ['prbody'], 'todo']]);
  const f = flowOf(p, events([
    ['rename', 'doing'], ['rename', 'done'], ['pr', 'doing'], ['pr', 'todo'], ['video', 'doing'], ['video', 'done'], ['prbody', 'doing'],
  ]));
  assert.deepEqual(lines(f), ['prbody→pr', 'rename→video', 'video→prbody']);
});
