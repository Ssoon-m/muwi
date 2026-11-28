// 큰 그래프 아래 타임라인의 자리와 글 (app/muwi/timeline.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timelineLayout } from '../app/muwi/timeline.js';

const at = (m: number) => `2026-01-01T00:${String(m).padStart(2, '0')}:00.000Z`;
const seg = (node: string, attempt: number, lane: string, kind: string, start: number, end: number | null, extra = {}) =>
  ({ node, title: node.toUpperCase(), attempt, lane, kind, start: at(start), end: end === null ? null : at(end), ...extra });

test('막대: 전체 시간에 대한 자리와 너비, 색, 글. 여러 번 한 노드는 몇 번째인지, 응답 대기는 그렇게 적는다', () => {
  const T = timelineLayout({
    segments: [
      seg('impl', 1, 's1', 'doing', 0, 2, { done: true, note: '구현함' }),
      seg('impl', 2, 's1', 'doing', 4, null),
      seg('ask', 1, 'x1', 'waiting', 2, 3),
      seg('old', 1, 's1', 'doing', 3, 3, { done: true, instant: true, gone: true }),
    ],
    lanes: [{ key: 's1', sub: false, name: '세션' }, { key: 'x1', sub: true, name: '서브 1' }],
    marks: [{ at: at(2), by: 'ai', added: ['ask'], removed: [], changed: [] }],
  }, Date.parse(at(8)));
  assert.equal(T.span, 8 * 60_000);
  const [main, sub] = T.lanes;
  assert.deepEqual(main.bars.map((b: any) => [b.label, b.left, b.width, b.tone, b.thin]), [
    ['IMPL① · 구현함', '0.000%', '25.000%', 'done', false],
    ['IMPL②', '50.000%', '50.000%', 'doing', false],
    ['OLD · 빠짐', '37.500%', '0.000%', 'done', true],
  ]);
  assert.deepEqual(sub.bars.map((b: any) => [b.label, b.tone, b.i]), [['응답 대기 · ASK', 'waiting', 2]]);
  assert.deepEqual(T.marks.map((m: any) => m.left), ['25.000%']);
  assert.equal(T.ticks.length, 4);
});

test('일어난 일이 없으면 null', () => {
  assert.equal(timelineLayout({ segments: [], lanes: [], marks: [] }, 0), null);
  assert.equal(timelineLayout(undefined, 0), null);
});
