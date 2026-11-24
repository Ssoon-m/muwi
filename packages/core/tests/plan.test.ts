import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNode, carryStatus, diffPlan, parsePlan, removeNode } from '../src/plan.ts';
import type { Plan } from '../src/store.ts';

const plan = (nodes: Plan['nodes']): Plan => ({ work: 'w', createdAt: '', updatedAt: '', nodes });

test('계획: 올바른 모양이면 받아들이고 after를 목록으로 맞춘다', () => {
  const { plan: p, problems } = parsePlan({ title: ' 제목 ', nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', after: 'a' }] });
  assert.deepEqual(problems, []);
  assert.equal(p!.title, '제목');
  assert.deepEqual(p!.nodes, [{ id: 'a', title: 'A', after: [] }, { id: 'b', title: 'B', after: ['a'] }]);
});

test('계획: 모양이 틀리면 무엇이 틀렸는지 알려 준다', () => {
  const problems = (raw: unknown) => parsePlan(raw).problems.join('\n');
  assert.match(problems(null), /JSON/);
  assert.match(problems({ nodes: [] }), /비어/);
  assert.match(problems({ nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }), /겹쳐/);
  assert.match(problems({ nodes: [{ id: 'a', title: '' }] }), /title/);
  assert.match(problems({ nodes: [{ id: 'a b', title: 'A' }] }), /id는/);
  assert.match(problems({ nodes: [{ id: 'a', title: 'A', after: ['x'] }] }), /없는 노드/);
  assert.match(problems({ nodes: [{ id: 'a', title: 'A', after: ['a'] }] }), /자기 자신/);
});

test('계획: 돌고 도는 선은 받지 않는다 (다시 하는 일은 회차로 적는다)', () => {
  const { plan: p, problems } = parsePlan({ nodes: [{ id: 'a', title: 'A', after: ['c'] }, { id: 'b', title: 'B', after: ['a'] }, { id: 'c', title: 'C', after: ['b'] }] });
  assert.equal(p, undefined);
  assert.match(problems[0], /돌고 돌아요/);
});

test('계획 비교: 생긴 노드, 없어진 노드, 제목이나 순서가 바뀐 노드를 찾는다', () => {
  const old = plan([
    { id: 'a', title: 'A', after: [], status: 'done' },
    { id: 'b', title: 'B', after: ['a'], status: 'doing' },
    { id: 'c', title: 'C', after: ['b'], status: 'todo' },
  ]);
  const next = [
    { id: 'a', title: 'A', after: [] },
    { id: 'b', title: 'B 고침', after: ['a'] },
    { id: 'd', title: 'D', after: ['b'] },
  ];
  assert.deepEqual(diffPlan(old.nodes, next), { added: ['d'], removed: ['c'], changed: ['b'] });
  // 같은 id면 하던 상태를 잇고, 새 노드는 아직
  assert.deepEqual(carryStatus(old.nodes, next).map(n => n.status), ['done', 'doing', 'todo']);
});

test('노드 끼워 넣기: before를 주면 그 사이에 들어가고 목록에서도 그 자리에 온다', () => {
  const old = plan([
    { id: 'impl', title: '구현', after: [], status: 'done' },
    { id: 'check', title: '확인', after: ['impl'], status: 'todo' },
    { id: 'pr', title: 'PR', after: ['check'], status: 'todo' },
  ]);
  const next = addNode(old, { id: 'lint', title: 'lint', after: ['impl'] }, 'check');
  assert.deepEqual(next.nodes.map(n => n.id), ['impl', 'lint', 'check', 'pr']);
  assert.deepEqual(next.nodes.find(n => n.id === 'check')!.after, ['lint']);
  assert.deepEqual(parsePlan(next).problems, []);
  // before가 없으면 after 노드 바로 뒤에 온다
  assert.deepEqual(addNode(old, { id: 'docs', title: '문서', after: ['impl'] }).nodes.map(n => n.id), ['impl', 'docs', 'check', 'pr']);
});

test('노드 빼기: 다음 노드는 빠진 노드의 앞 노드로 잇는다', () => {
  const old = plan([
    { id: 'impl', title: '구현', after: [], status: 'done' },
    { id: 'check', title: '확인', after: ['impl'], status: 'todo' },
    { id: 'pr', title: 'PR', after: ['check'], status: 'todo' },
  ]);
  const next = removeNode(old, 'check');
  assert.deepEqual(next.nodes, [{ id: 'impl', title: '구현', after: [] }, { id: 'pr', title: 'PR', after: ['impl'] }]);
});
