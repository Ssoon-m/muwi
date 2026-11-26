// 그래프에 그리는 카드 (app/muwi/cards.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardNode, cardNodes, lastCards } from '../app/muwi/cards.js';

const verify = {
  id: 'verify', title: '확인', after: [], status: 'doing', attempts: 2, spentMs: 900, session: 's2', closed: false, quiet: 'stopped', note: undefined,
  who: { kind: 'subagent', session: 's2', agents: [] },
  tries: [
    { n: 1, status: 'done', spentMs: 600, note: '꼭 고칠 것 1', startedAt: 'a', endedAt: 'b', who: { kind: 'subagent', session: 's1', agents: [] }, skills: [], seen: true, instant: false },
    { n: 2, status: 'doing', spentMs: 300, startedAt: 'c', who: { kind: 'subagent', session: 's2', agents: [] }, skills: [], seen: true, instant: false },
  ],
};
const rework = { id: 'rework', title: '고침', after: ['verify'], status: 'done', attempts: 1, spentMs: 100, tries: [] };
const view = {
  nodes: [verify, rework],
  drawn: { cards: [{ id: 'verify', node: 'verify', tries: [1] }, { id: 'rework', node: 'rework' }, { id: 'verify#2', node: 'verify', tries: [2] }], edges: [] },
};

test('나뉜 카드: 앞 카드는 그 회차가 남긴 상태·결과·시간으로, 지금 회차가 든 카드는 지금 상태로 그린다', () => {
  const cards = cardNodes(view);
  assert.deepEqual([...cards.keys()], ['verify', 'rework', 'verify#2']);
  const before = cards.get('verify');
  assert.equal(before.node, 'verify');
  assert.equal(before.status, 'done');
  assert.equal(before.note, '꼭 고칠 것 1');
  assert.equal(before.spentMs, 600);
  assert.equal(before.round, '1회차');
  assert.equal(before.session, 's1');
  // 지금 일어나는 일의 표시(멈춤 등)는 앞 카드에 붙지 않는다
  assert.equal(before.quiet, undefined);
  const now = cards.get('verify#2');
  assert.equal(now.status, 'doing');
  assert.equal(now.quiet, 'stopped');
  assert.equal(now.spentMs, 300);
  assert.equal(now.round, '2회차');
  // 나뉘지 않은 노드는 그대로
  assert.equal(cards.get('rework'), rework);
});

test('한 카드에 회차 여럿이면 "1~2회차"로 적는다', () => {
  assert.equal(cardNode(verify, { id: 'verify', node: 'verify', tries: [1, 2] }).round, '1~2회차');
});

test('보여 줄 노드는 그 노드의 마지막 카드로 찾는다. drawn이 없는 기록은 노드 하나가 카드 하나다', () => {
  assert.deepEqual(lastCards(view, ['verify', 'rework']), ['verify#2', 'rework']);
  const plain = { nodes: [rework] };
  assert.deepEqual([...cardNodes(plain).keys()], ['rework']);
  assert.deepEqual(lastCards(plain, ['rework']), ['rework']);
});

test('막힘으로 끝난 지난 회차 카드는 지난 것(past)으로 그린다: 지금 일어나는 일로 빛나지 않고, 문제 표시는 지금 카드에만', () => {
  const blocked = { ...verify, flags: [{ at: 'x', text: '견본' }], tries: [{ ...verify.tries[0], status: 'blocked', note: '권한이 없음' }, verify.tries[1]] };
  const before = cardNode(blocked, { id: 'verify', node: 'verify', tries: [1] });
  assert.equal(before.status, 'blocked');
  assert.equal(before.past, true);
  assert.deepEqual(before.flags, []);
  const now = cardNode(blocked, { id: 'verify#2', node: 'verify', tries: [2] });
  assert.equal(now.past, undefined);
  assert.equal(now.flags.length, 1);
});
