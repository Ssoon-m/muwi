// 새 결과를 그 작업의 터미널에서 봤는지 (app/muwi/seen.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimSeen, SEEN_TTL, seenWorks, talksOf } from '../app/muwi/seen.js';

type Work = { work: string; unread?: boolean; archived?: boolean; talks?: string[]; lead?: string; sessions?: Record<string, unknown> };
const works: Work[] = [
  { work: 'a', unread: true, talks: ['s1'] },
  { work: 'b', unread: true, talks: ['s2', 's1'] }, // s1이 이어 맡은 작업
  { work: 'c', unread: true, talks: ['s3'] }, // 다른 터미널의 대화
  { work: 'read', talks: ['s1'] }, // 이미 봤다
  { work: 'shelved', unread: true, archived: true, talks: ['s1'] },
];
const here = { works, front: true, terminal: 't1', owner: 's1', agent: true };

test('그 터미널의 지금 세션이 그 작업을 한 대화이면 본 것이다 (대화가 여럿이어도, 지금 다른 작업을 하고 있어도). 본 작업·보관한 작업·다른 터미널의 작업은 아니다', () => {
  assert.deepEqual(seenWorks(here), ['a', 'b']);
  assert.deepEqual(seenWorks({ ...here, owner: 's2' }), ['b']);
  assert.deepEqual(seenWorks({ ...here, owner: 's3' }), ['c']);
});

test('Herdr 창이 뒤에 있거나, 키보드가 터미널이 아닌 칸(그래프 칸 등)에 있거나, 그 터미널의 세션을 모르거나, AI 도구가 꺼졌으면 적지 않는다', () => {
  assert.deepEqual(seenWorks({ ...here, front: false }), []);
  assert.deepEqual(seenWorks({ ...here, terminal: null }), []);
  assert.deepEqual(seenWorks({ ...here, owner: null }), []);
  assert.deepEqual(seenWorks({ ...here, agent: false }), []);
});

test('대화 목록이 없으면 계획을 낸 대화와 노드를 맡은 대화로 센다', () => {
  assert.deepEqual(talksOf({ work: 'x', lead: 's1', sessions: { s2: {}, s1: {} } }), ['s1', 's2']);
  assert.deepEqual(seenWorks({ ...here, works: [{ work: 'x', unread: true, sessions: { s1: {} } }] }), ['x']);
});

test('칸끼리 나눠 맡기: 작업마다 먼저 맡은 칸만 적고, 다른 작업은 따로 맡는다. 지난 것과 앞날짜인 것은 버린다', () => {
  let c = claimSeen(undefined, 'a', 1000);
  assert.deepEqual(c, { ok: true, claims: { a: 1000 } });
  // 같은 틱에 두 작업을 적어도 다른 칸은 둘 다 건너뛴다
  c = claimSeen(c.claims, 'b', 1000);
  assert.deepEqual(c, { ok: true, claims: { a: 1000, b: 1000 } });
  assert.equal(claimSeen(c.claims, 'a', 1001).ok, false);
  assert.equal(claimSeen(c.claims, 'b', 1001).ok, false);
  // 맡은 칸이 못 적었으면 SEEN_TTL 뒤에 다른 칸이 맡는다
  assert.deepEqual(claimSeen(c.claims, 'a', 1000 + SEEN_TTL), { ok: true, claims: { a: 1000 + SEEN_TTL } });
  // 시계를 되돌렸으면(앞날짜) 막지 않는다. 예전 모양의 값({ work, at })도 지났으면 버린다
  assert.equal(claimSeen({ a: 5000 }, 'a', 1000).ok, true);
  assert.deepEqual(claimSeen({ work: 'a', at: 1000 - SEEN_TTL }, 'a', 1000), { ok: true, claims: { a: 1000 } });
});
