import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedOf, redosOf, timelineOf } from '../src/flow.ts';
import type { Event, NodeStatus, Plan } from '../src/store.ts';

// 계획: [id, 앞 노드들]. 기록: 한 줄에 1분씩 (줄 순서가 일어난 순서다)
const plan = (nodes: [string, string[]][]): Plan =>
  ({ work: 'w', nodes: nodes.map(([id, after]) => ({ id, title: id.toUpperCase(), after, status: 'todo' })) }) as unknown as Plan;
type Line = [string, NodeStatus, { attempt?: number; note?: string; why?: string; agent?: string; session?: string }?];
const at = (i: number) => new Date(Date.UTC(2026, 10, 26, 0, i)).toISOString();
const node = ([id, status, o = {}]: Line, i: number): Event =>
  ({ at: at(i), session: o.session ?? 's1', type: 'node', node: id, status, ...(o.attempt ? { attempt: o.attempt } : {}), ...(o.note ? { note: o.note } : {}), ...(o.why ? { why: o.why } : {}), ...(o.agent ? { agent: o.agent } : {}) }) as Event;
const events = (lines: (Line | Event)[]): Event[] => lines.map((l, i) => (Array.isArray(l) ? node(l, i) : { ...l, at: at(i) }));
const replan = (o: { added?: string[]; removed?: string[]; first?: boolean; why?: string; gone?: { id: string; title: string }[] }): Event =>
  ({ at: '', session: 's1', type: 'plan', by: 'ai', added: o.added ?? [], removed: o.removed ?? [], changed: [], ...(o.first ? { first: true } : {}), ...(o.why ? { why: o.why } : {}),
    ...(o.gone ? { gone: o.gone.map(g => ({ ...g, after: [], status: 'todo' })) } : {}) }) as Event;

test('타임라인: 작업 중·응답 대기·막힘이 이어진 구간마다 하나. 끝내며 닫힌 구간에는 결과가 붙고, 열린 구간은 end가 null', () => {
  const p = plan([['read', []], ['impl', ['read']]]);
  const t = timelineOf(p, events([
    ['read', 'doing'], ['read', 'done', { note: '요구사항 2건' }],
    ['impl', 'doing', { why: '먼저 해도 된다' }], ['impl', 'waiting', { note: '어느 쪽으로?' }], ['impl', 'doing'],
  ]));
  assert.deepEqual(t.segments.map(s => [s.node, s.kind, s.start, s.end, s.note, s.done, s.why]), [
    ['read', 'doing', at(0), at(1), '요구사항 2건', true, undefined],
    ['impl', 'doing', at(2), at(3), undefined, undefined, '먼저 해도 된다'],
    ['impl', 'waiting', at(3), at(4), '어느 쪽으로?', undefined, undefined],
    ['impl', 'doing', at(4), null, undefined, undefined, undefined],
  ]);
  assert.deepEqual(t.segments.map(s => s.title), ['READ', 'IMPL', 'IMPL', 'IMPL']);
  assert.deepEqual(t.lanes, [{ key: 's1', sub: false, name: '세션' }]);
});

test('타임라인: 서브에이전트가 시작한 구간은 그 서브에이전트의 줄에. 응답 대기는 하던 쪽의 줄에 이어 둔다. 세션은 먼저, 처음 나온 순서로', () => {
  const p = plan([['a', []], ['b', []], ['c', []]]);
  const t = timelineOf(p, events([
    ['a', 'doing', { agent: 'x1' }], ['b', 'doing', { session: 's2' }], ['a', 'waiting', { note: '물어봄' }], ['c', 'doing'], ['a', 'done'],
  ]));
  assert.deepEqual(t.segments.map(s => `${s.node}:${s.kind}@${s.lane}`), ['a:doing@x1', 'b:doing@s2', 'a:waiting@x1', 'c:doing@s1']);
  assert.deepEqual(t.lanes.map(l => [l.key, l.name, l.sub]), [['s2', '세션', false], ['s1', '세션 2', false], ['x1', '서브 1', true]]);
});

test('타임라인: 같은 노드에서 다시 물으면 마지막 질문을 쓴다. 서브에이전트가 시작한 회차의 응답 대기는 잠시 멈췄다가 물어도 그 서브에이전트 줄에', () => {
  const p = plan([['a', []]]);
  const asked = timelineOf(p, events([['a', 'doing'], ['a', 'waiting', { note: 'PR 올릴까요?' }], ['a', 'waiting', { note: 'base는?' }]]));
  assert.deepEqual(asked.segments.map(s => [s.kind, s.note]), [['doing', undefined], ['waiting', 'base는?']]);
  // 서브에이전트 표시(agent)는 시작 줄에만 붙는다: 잠시 멈춘 뒤의 응답 대기도 시작한 서브에이전트의 줄에 둔다
  const sub = timelineOf(p, events([['a', 'doing', { agent: 'x1' }], ['a', 'todo'], ['a', 'waiting', { note: '물어봄' }]]));
  assert.deepEqual(sub.segments.map(s => `${s.kind}@${s.lane}`), ['doing@x1', 'waiting@x1']);
});

test('타임라인: 다른 세션이 이어받으면 구간을 나눈다. 잠시 멈추면 닫는다. 시작 없이 끝을 적으면 길이 없는 구간(instant)', () => {
  const p = plan([['a', []], ['b', []]]);
  const t = timelineOf(p, events([['a', 'doing'], ['a', 'doing', { session: 's2' }], ['a', 'todo'], ['b', 'done', { note: '한꺼번에' }]]));
  assert.deepEqual(t.segments.map(s => [s.node, s.lane, s.start, s.end, s.instant]), [
    ['a', 's1', at(0), at(1), undefined], ['a', 's2', at(1), at(2), undefined], ['b', 's1', at(3), at(3), true],
  ]);
});

test('타임라인: 계획이 바뀐 때(첫 계획 빼고). 빠진 노드의 구간은 그때 닫히고 뺄 때의 제목과 gone이 붙는다', () => {
  const p = plan([['a', []], ['c', ['a']]]);
  const t = timelineOf(p, events([
    replan({ first: true, added: ['a', 'b'] }),
    ['b', 'doing'],
    replan({ added: ['c'], removed: ['b'], why: '필요 없음', gone: [{ id: 'b', title: '뺀 일' }] }),
    ['a', 'doing'],
  ]));
  assert.deepEqual(t.marks, [{ at: at(2), by: 'ai', why: '필요 없음', added: ['c'], removed: ['b'], changed: [] }]);
  assert.deepEqual(t.segments.map(s => [s.node, s.title, s.end, s.gone]), [['b', '뺀 일', at(2), true], ['a', 'A', null, undefined]]);
});

test('다시 한 회차: 계획상 뒤 노드를 끝내자마자 다시 시작했으면 그 노드에서 돌아왔다. 근거가 없으면 돌아온 노드의 결과', () => {
  const p = plan([['impl', []], ['review', ['impl']], ['pr', ['review']]]);
  const r = redosOf(p, events([
    ['impl', 'doing'], ['impl', 'done', { note: '구현함' }],
    ['review', 'doing'], ['review', 'done', { note: '꼭 고칠 것 2' }],
    ['impl', 'doing', { attempt: 2 }], ['impl', 'done', { attempt: 2, note: '고침' }],
    ['review', 'doing', { attempt: 2, why: '고친 것만 다시 본다' }], ['review', 'done', { attempt: 2 }],
    ['impl', 'doing', { attempt: 3, why: 'CI가 깨졌다' }],
  ]));
  assert.deepEqual(r.get('impl'), [
    { attempt: 2, from: 'review', fromTitle: 'REVIEW', reason: '꼭 고칠 것 2' },
    { attempt: 3, from: 'review', fromTitle: 'REVIEW', reason: 'CI가 깨졌다' },
  ]);
  // review는 앞 노드(impl)를 끝낸 뒤 다시 했다: 돌아온 게 아니라 앞 회차의 결과를 보여 준다
  assert.deepEqual(r.get('review'), [{ attempt: 2, prev: '꼭 고칠 것 2' }]);
  assert.equal(r.has('pr'), false);
});

test('다시 한 회차: 바로 다시 했거나 계획상 뒤가 아닌 노드 다음에 했으면 앞 회차의 결과. 막혀 끝났으면 막힌 이유', () => {
  const p = plan([['a', []], ['b', []]]);
  const r = redosOf(p, events([['a', 'doing'], ['a', 'blocked', { note: '권한 없음' }], ['b', 'doing'], ['b', 'done'], ['a', 'doing', { attempt: 2 }]]));
  assert.deepEqual(r.get('a'), [{ attempt: 2, prev: '권한 없음' }]);
});

test('나중에 넣은 노드: 첫 계획 뒤에 생겨 지금도 계획에 있는 노드', () => {
  const p = plan([['a', []], ['c', ['a']]]);
  const added = addedOf(p, events([replan({ first: true, added: ['a'] }), replan({ added: ['b', 'c'] }), replan({ removed: ['b'] })]));
  assert.deepEqual([...added], ['c']);
});
