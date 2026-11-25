// 그래프 칸에 여러 작업을 나눠 그릴 때의 자리 규칙 (app/muwi/lanes.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, laneGrid, laneTargets, layoutLanes, stripOrder, togglePin } from '../app/muwi/lanes.js';

type Row = { work: string; state: string; createdAt?: string; updatedAt?: string; archived?: boolean; past?: boolean };
/** 작업 줄: 상태와 만든 때·마지막으로 움직인 때 (분) */
const row = (work: string, state: string, made = 0, moved = made, extra: Partial<Row> = {}): Row => ({
  work, state, createdAt: new Date(made * 60_000).toISOString(), updatedAt: new Date(moved * 60_000).toISOString(), ...extra,
});
const table = (rows: Row[]) => {
  const by = new Map(rows.map(r => [r.work, r]));
  return (id: string) => by.get(id);
};

test('대상: 진행 중인 작업과 고정·보는 중·고른 작업·자동 자리에 있던 작업. 보관한 작업은 고정돼 있어도 빼고, 순서는 목록과 같다', () => {
  const rows = [
    row('wait', 'waiting'), row('doing', 'doing'), row('done', 'done'), row('pinned-done', 'done'),
    row('archived', 'doing', 0, 0, { archived: true }), row('old', 'doing', 0, 0, { past: true }), row('seen', 'done'), row('kept', 'stalled'),
  ];
  assert.deepEqual(laneTargets(rows, { pins: ['pinned-done', 'archived'], viewing: 'seen', auto: ['kept'] }),
    ['wait', 'doing', 'pinned-done', 'seen', 'kept']);
  // 큰 그래프를 눌러 고른 작업도 끝났어도 남는다
  assert.deepEqual(laneTargets(rows, { picked: 'done' }), ['wait', 'doing', 'done']);
});

test('자리 수: 너비로 한 줄의 수, 높이로 줄 수. 지도 줄 높이를 빼고 센다. 아무리 좁아도 하나', () => {
  assert.deepEqual(laneGrid({ width: 1200, height: 600 }), { cols: 3, rows: 2 });
  assert.deepEqual(laneGrid({ width: 1200, height: 600 }, 112), { cols: 3, rows: 1 });
  assert.deepEqual(laneGrid({ width: 2400, height: 300 }), { cols: 6, rows: 1 });
  assert.deepEqual(laneGrid({ width: 200, height: 100 }), { cols: 1, rows: 1 });
});

test('큰 그래프: 고정한 순서가 맨 앞이고, 고정한 작업은 보는 중이 돼도 자리가 그대로다. 고정이 아닌 보는 중은 고정 바로 뒤', () => {
  const rows = ['x', 'y', 'z', 'w', 'a'].map((id, i) => row(id, 'doing', i, i));
  const rowOf = table(rows);
  const targets = rows.map(r => r.work);
  const pins = ['x', 'y', 'z'];
  assert.deepEqual(arrange({ targets, rowOf, cap: 5, pins, viewing: 'y', auto: [] }).shown, ['x', 'y', 'z', 'a', 'w']);
  assert.deepEqual(arrange({ targets, rowOf, cap: 5, pins, viewing: 'w', auto: [] }).shown, ['x', 'y', 'z', 'w', 'a']);
});

test('큰 그래프: 고정이 자리를 다 채우면 마지막 자리를 보는 중에게 준다. 지도 줄로 밀린 고정 작업을 볼 때도 같다', () => {
  const rows = ['x', 'y', 'z', 'q', 'w'].map((id, i) => row(id, 'doing', i, i));
  const rowOf = table(rows);
  const targets = rows.map(r => r.work);
  const pins = ['x', 'y', 'z', 'q'];
  assert.deepEqual(arrange({ targets, rowOf, cap: 3, pins, viewing: 'w', auto: [] }).shown, ['x', 'y', 'w']);
  assert.deepEqual(arrange({ targets, rowOf, cap: 3, pins, viewing: 'q', auto: [] }).shown, ['x', 'y', 'q']);
  assert.deepEqual(arrange({ targets, rowOf, cap: 3, pins, viewing: 'y', auto: [] }).shown, ['x', 'y', 'z']);
  // 자리가 하나뿐이면 보는 중만
  assert.deepEqual(arrange({ targets, rowOf, cap: 1, pins, viewing: 'w', auto: [] }).shown, ['w']);
});

test('자동 자리: 급한 등급이 먼저, 같은 등급이면 최근에 움직인 작업. 한 번 들어온 작업은 같은 등급에게 밀려나지 않는다', () => {
  let rows = [row('a', 'doing', 0, 10), row('b', 'doing', 1, 20), row('c', 'doing', 2, 5)];
  let r = arrange({ targets: rows.map(x => x.work), rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: [] });
  assert.deepEqual(r.shown, ['b', 'a']);
  // c가 더 최근에 움직여도 같은 등급이라 자리를 뺏지 않는다
  rows = [row('a', 'doing', 0, 10), row('b', 'doing', 1, 20), row('c', 'doing', 2, 30)];
  r = arrange({ targets: rows.map(x => x.work), rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: r.auto });
  assert.deepEqual(r.shown, ['b', 'a']);
  // c가 응답 대기가 되면 가장 오래 안 움직인 작업 중(a) 자리를 그 자리에서 바꾼다. b는 그대로
  rows = [row('a', 'doing', 0, 10), row('b', 'doing', 1, 20), row('c', 'waiting', 2, 30)];
  r = arrange({ targets: rows.map(x => x.work), rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: r.auto });
  assert.deepEqual(r.shown, ['b', 'c']);
  // b가 응답 대기가 돼도 자리를 다시 정렬하지 않는다
  rows = [row('a', 'doing', 0, 10), row('b', 'waiting', 1, 40), row('c', 'waiting', 2, 30)];
  r = arrange({ targets: rows.map(x => x.work), rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: r.auto });
  assert.deepEqual(r.shown, ['b', 'c']);
});

test('자동 자리: 끝난 작업은 자리를 비킬 때까지 남고, 진행 중인 작업이 자리를 필요로 하면 가장 먼저 비킨다. 끝난 작업이 빈자리를 채우지는 않는다', () => {
  let rows = [row('a', 'done', 0, 10), row('picked', 'done', 1, 50)];
  let r = arrange({ targets: ['a', 'picked'], rowOf: table(rows), cap: 3, pins: [], viewing: null, auto: ['a'] });
  assert.deepEqual(r.shown, ['a']);
  rows = [row('a', 'done', 0, 10), row('b', 'doing', 1, 5)];
  r = arrange({ targets: ['a', 'b'], rowOf: table(rows), cap: 1, pins: [], viewing: null, auto: r.auto });
  assert.deepEqual(r.shown, ['b']);
});

test('칸이 줄면 자동 자리 중 가장 덜 중요한 것부터, 그다음 보는 중이 아닌 고정의 뒤쪽부터 빠진다', () => {
  const rows = [row('p1', 'doing', 0, 0), row('p2', 'doing', 1, 1), row('v', 'doing', 2, 2), row('u', 'waiting', 3, 3), row('d', 'doing', 4, 9)];
  const rowOf = table(rows);
  const targets = rows.map(x => x.work);
  const pins = ['p1', 'p2'];
  let r = arrange({ targets, rowOf, cap: 5, pins, viewing: 'v', auto: [] });
  assert.deepEqual(r.shown, ['p1', 'p2', 'v', 'u', 'd']);
  r = arrange({ targets, rowOf, cap: 4, pins, viewing: 'v', auto: r.auto });
  assert.deepEqual(r.shown, ['p1', 'p2', 'v', 'u']);
  r = arrange({ targets, rowOf, cap: 2, pins, viewing: 'v', auto: r.auto });
  assert.deepEqual(r.shown, ['p1', 'v']);
});

test('지도 줄: 넘친 고정(고정한 순서) → 응답 대기·막힘 → 작업 중 → 끝·멈춤, 묶음 안은 만든 순', () => {
  const rows = [
    row('d-late', 'doing', 5, 50), row('d-early', 'doing', 1, 99), row('w', 'waiting', 9), row('b', 'blocked', 2),
    row('done', 'done', 0), row('p2', 'done', 7), row('p1', 'doing', 8),
  ];
  assert.deepEqual(stripOrder(rows.map(r => r.work), table(rows), ['p1', 'p2']), ['p1', 'p2', 'b', 'w', 'd-early', 'd-late', 'done']);
});

test('고정: 새로 고정하면 고정 묶음의 맨 뒤, 다시 누르면 푼다', () => {
  assert.deepEqual(togglePin(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(togglePin(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

test('칸에 놓기: 끝난 작업이 자동 자리를 내줄 때 지도 줄이 생긴 것으로 보지 않는다 (다른 자동 자리가 섞이지 않는다)', () => {
  // 3×2가 딱 들어가는 칸 (지도 줄이 생기면 한 줄만 들어간다)
  const area = { width: 1170, height: 560 };
  const strip = 120;
  let rows = [row('A', 'doing', 0, 10), row('B', 'doing', 1, 9), row('C', 'doing', 2, 8), row('D', 'doing', 3, 7), row('E', 'doing', 4, 6), row('F', 'doing', 5, 5)];
  let r = layoutLanes({ area, strip, targets: rows.map(x => x.work), rowOf: table(rows), viewing: 'A', auto: [] });
  assert.deepEqual([r.grid, r.shown, r.below], [{ cols: 3, rows: 2 }, ['A', 'B', 'C', 'D', 'E', 'F'], []]);
  // F가 끝났다: 자리를 비킬 때까지 남는다
  rows = rows.map(x => (x.work === 'F' ? { ...x, state: 'done' } : x));
  r = layoutLanes({ area, strip, targets: rows.map(x => x.work), rowOf: table(rows), viewing: 'A', auto: r.auto });
  assert.deepEqual(r.shown, ['A', 'B', 'C', 'D', 'E', 'F']);
  // 새 작업 G가 생기면 F 자리를 그 자리에서 받는다. F는 지도 줄로 가지 않고 사라진다
  rows = [...rows, row('G', 'doing', 6, 11)];
  r = layoutLanes({ area, strip, targets: rows.map(x => x.work), rowOf: table(rows), viewing: 'A', auto: r.auto });
  assert.deepEqual([r.grid, r.shown, r.below], [{ cols: 3, rows: 2 }, ['A', 'B', 'C', 'D', 'E', 'G'], []]);
});

test('칸에 놓기: 넘치면 지도 줄 높이를 빼고 다시 센다. 크게 보기는 고른 작업 하나만 크게 두고 자동 자리를 그대로 둔다', () => {
  const area = { width: 1170, height: 570 };
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id, i) => row(id, 'doing', i, 10 - i));
  const targets = rows.map(x => x.work);
  const split = layoutLanes({ area, strip: 120, targets, rowOf: table(rows), viewing: 'A', auto: [] });
  assert.deepEqual([split.grid, split.shown, split.below], [{ cols: 3, rows: 1 }, ['A', 'B', 'C'], ['D', 'E', 'F', 'G']]);
  // 접은 지도 줄은 낮아서 두 줄이 들어간다
  const folded = layoutLanes({ area, strip: 25, targets, rowOf: table(rows), viewing: 'A', auto: [] });
  assert.deepEqual([folded.grid, folded.shown], [{ cols: 3, rows: 2 }, ['A', 'B', 'C', 'D', 'E', 'F']]);
  const focus = layoutLanes({ area, strip: 120, targets, rowOf: table(rows), viewing: 'A', auto: split.auto, focus: true, lead: 'C' });
  assert.deepEqual([focus.shown, focus.auto, focus.below], [['C'], split.auto, ['A', 'B', 'D', 'E', 'F', 'G']]);
});
