// 그래프 칸에 여러 작업을 나눠 그릴 때의 자리 규칙 (app/muwi/lanes.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, justShelved, laneGrid, laneTargets, layoutLanes, stripOrder, togglePin } from '../app/muwi/lanes.js';

type Row = { work: string; state: string; createdAt?: string; updatedAt?: string; archived?: boolean; past?: boolean };
/** 작업 줄: 상태와 만든 때·마지막으로 움직인 때 (분) */
const row = (work: string, state: string, made = 0, moved = made, extra: Partial<Row> = {}): Row => ({
  work, state, createdAt: new Date(made * 60_000).toISOString(), updatedAt: new Date(moved * 60_000).toISOString(), ...extra,
});
const table = (rows: Row[]) => {
  const by = new Map(rows.map(r => [r.work, r]));
  return (id: string) => by.get(id);
};

test('대상: 끝나지 않은 작업(멈춤, 지난 작업으로 접힌 멈춤도)과 고정·보는 중·고른 작업·자동 자리에 있던 작업. 보관한 작업은 고정돼 있어도 빼고, 순서는 목록과 같다', () => {
  const rows = [
    row('wait', 'waiting'), row('doing', 'doing'), row('stalled', 'stalled'), row('old-stalled', 'stalled', 0, 0, { past: true }),
    row('done', 'done'), row('pinned-done', 'done'), row('archived', 'doing', 0, 0, { archived: true }), row('seen', 'done'), row('kept', 'done'),
  ];
  assert.deepEqual(laneTargets(rows, { pins: ['pinned-done', 'archived'], viewing: 'seen', auto: ['kept'] }),
    ['wait', 'doing', 'stalled', 'old-stalled', 'pinned-done', 'seen', 'kept']);
  // 큰 그래프를 눌러 고른 작업도 끝났어도 남는다
  assert.deepEqual(laneTargets(rows, { picked: 'done' }), ['wait', 'doing', 'stalled', 'old-stalled', 'done']);
  // 보관한 작업도 보는 중이면 넣는다 (보관함에서 일부러 눌렀거나 그 작업의 터미널로 갔다)
  assert.deepEqual(laneTargets(rows, { viewing: 'archived' }), ['wait', 'doing', 'stalled', 'old-stalled', 'archived']);
});

test('관제탑: 보는 중이 어느 작업으로 가든(다른 탭·계획 없는 세션) 끝나지 않은 작업은 늘 대상이고, 끝난 작업은 보는 중일 때만 더해진다', () => {
  const rows = [row('a', 'doing'), row('b', 'waiting'), row('s', 'stalled'), row('d1', 'done'), row('d2', 'done')];
  const always = ['a', 'b', 's'];
  for (const viewing of [null, 'a', 'b', 's', 'd1', 'd2']) {
    const got = laneTargets(rows, { viewing });
    assert.deepEqual(got.filter(w => always.includes(w)), always, `보는 중 ${viewing}`);
    assert.deepEqual(got.filter(w => !always.includes(w)), viewing?.startsWith('d') ? [viewing] : [], `보는 중 ${viewing}`);
  }
  // 칸에 놓아도 마찬가지: 보는 중만 앞으로 오고, 끝나지 않은 작업은 큰 그래프나 작은 지도 어딘가에 늘 있다
  const area = { width: 800, height: 300 };
  let auto: string[] = [];
  for (const viewing of ['a', 'd1', 'b', null, 's']) {
    const targets = laneTargets(rows, { viewing, auto });
    const r = layoutLanes({ area, strip: 120, targets, rowOf: table(rows), viewing, auto });
    auto = r.auto;
    for (const w of always) assert.ok(r.shown.includes(w) || r.below.includes(w), `보는 중 ${viewing}: ${w}`);
    if (viewing) assert.ok(r.shown.includes(viewing), `보는 중 ${viewing}는 크게`);
  }
});

test('상태: 값이 없거나 처음 보는 값이면 작업 중으로 보고 늘 나온다. 지난 작업으로 접힌 끝나지 않은 작업(상태를 모른 채 오래된 작업)은 나오되 멈춤과 같은 급이다', () => {
  const rows = [
    { work: 'none' } as unknown as Row, row('odd', 'later'),
    row('stale', 'doing', 0, 0, { past: true }), row('s', 'stalled', 1, 100), row('d', 'doing', 2, 1),
  ];
  assert.deepEqual(laneTargets(rows, {}), ['none', 'odd', 'stale', 's', 'd']);
  const rowOf = table(rows);
  // 자리가 하나면 작업 중이 오래된 작업보다 앞선다
  let r = arrange({ targets: ['stale', 'd'], rowOf, cap: 1, pins: [], viewing: null, auto: [] });
  assert.deepEqual(r.shown, ['d']);
  // 오래된 작업과 멈춤은 같은 급이라 최근에 움직인 멈춤이 자리를 받는다
  r = arrange({ targets: ['stale', 's'], rowOf, cap: 1, pins: [], viewing: null, auto: [] });
  assert.deepEqual(r.shown, ['s']);
  // 작은 지도에서도 멈춤 묶음에 놓인다 (작업 중 뒤)
  assert.deepEqual(stripOrder(['stale', 'd', 's'], rowOf), ['d', 'stale', 's']);
});

test('크게 보기: 고른 작업 하나만 크게 두어도 끝나지 않은 작업은 모두 작은 지도에 있다', () => {
  const rows = [row('a', 'doing', 0), row('b', 'waiting', 1), row('s', 'stalled', 2), row('d', 'done', 3)];
  const targets = laneTargets(rows, { viewing: 'd' });
  const r = layoutLanes({ area: { width: 1200, height: 600 }, strip: 120, targets, rowOf: table(rows), viewing: 'd', auto: [], focus: true, lead: 'a' });
  assert.deepEqual(r.shown, ['a']);
  assert.deepEqual([...r.below].sort(), ['b', 'd', 's']);
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

test('자동 자리: 멈춘 작업은 빈자리를 채우고 끝난 작업의 자리를 밀어낸다. 작업 중·응답 대기는 멈춘 작업의 자리를 밀어낸다', () => {
  let rows = [row('s', 'stalled', 0, 10)];
  let r = arrange({ targets: ['s'], rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: [] });
  assert.deepEqual(r.shown, ['s']);
  // 끝난 작업이 자리에 남아 있고 자리가 다 찼으면, 새로 멈춘 작업이 그 자리를 그 자리에서 받는다
  rows = [row('s', 'stalled', 0, 10), row('d', 'done', 1, 50), row('s2', 'stalled', 2, 5)];
  r = arrange({ targets: ['s', 'd', 's2'], rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: ['d', 's'] });
  assert.deepEqual(r.shown, ['s2', 's']);
  // 작업 중인 작업은 멈춘 작업 중 오래 안 움직인 쪽의 자리를 받는다
  rows = [...rows, row('w', 'doing', 3, 60)];
  r = arrange({ targets: ['s', 's2', 'w'], rowOf: table(rows), cap: 2, pins: [], viewing: null, auto: r.auto });
  assert.deepEqual(r.shown, ['w', 's']);
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

test('지도 줄: 넘친 고정(고정한 순서) → 응답 대기·막힘 → 작업 중 → 멈춤 → 끝, 묶음 안은 만든 순', () => {
  const rows = [
    row('d-late', 'doing', 5, 50), row('d-early', 'doing', 1, 99), row('w', 'waiting', 9), row('b', 'blocked', 2),
    row('done', 'done', 0), row('p2', 'done', 7), row('p1', 'doing', 8), row('s', 'stalled', 3),
  ];
  assert.deepEqual(stripOrder(rows.map(r => r.work), table(rows), ['p1', 'p2']), ['p1', 'p2', 'b', 'w', 'd-early', 'd-late', 's', 'done']);
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

test('칸에 놓기: 멈춘 작업이 자리를 내주면 끝난 작업과 달리 지도 줄로 간다', () => {
  const area = { width: 1170, height: 560 };
  const strip = 120;
  let rows = [row('A', 'doing', 0, 10), row('B', 'doing', 1, 9), row('C', 'doing', 2, 8), row('D', 'doing', 3, 7), row('E', 'doing', 4, 6), row('F', 'stalled', 5, 5)];
  let r = layoutLanes({ area, strip, targets: rows.map(x => x.work), rowOf: table(rows), viewing: 'A', auto: [] });
  assert.deepEqual(r.shown, ['A', 'B', 'C', 'D', 'E', 'F']);
  rows = [...rows, row('G', 'doing', 6, 11)];
  r = layoutLanes({ area, strip, targets: rows.map(x => x.work), rowOf: table(rows), viewing: 'A', auto: r.auto });
  // 지도 줄이 생겨 한 줄로 줄어도 F는 빠지지 않고 지도 줄에 있다
  assert.ok(!r.shown.includes('F') && r.below.includes('F'));
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

test('큰 그래프: 보는 중이 자동 자리에 있던 작업으로 바뀌면 그 작업이 앞으로 오고, 전에 보던 작업은 남은 자리로 간다', () => {
  const rows = ['V1', 'A', 'V2', 'B'].map((id, i) => row(id, 'doing', i, 10 - i));
  const rowOf = table(rows);
  const targets = rows.map(r => r.work);
  let r = arrange({ targets, rowOf, cap: 4, pins: [], viewing: 'V1', auto: [] });
  assert.deepEqual(r.shown, ['V1', 'A', 'V2', 'B']);
  r = arrange({ targets, rowOf, cap: 4, pins: [], viewing: 'V2', auto: r.auto });
  assert.deepEqual(r.shown, ['V2', 'A', 'B', 'V1']);
});

test('고정을 풀면 고정 묶음에서 빠져 남은 자리 규칙을 따른다 (자리가 있으면 크게 남는다)', () => {
  const rows = ['P', 'V', 'A'].map((id, i) => row(id, 'doing', i, 10 - i));
  const rowOf = table(rows);
  const targets = rows.map(r => r.work);
  let r = arrange({ targets, rowOf, cap: 3, pins: ['P'], viewing: 'V', auto: [] });
  assert.deepEqual(r.shown, ['P', 'V', 'A']);
  r = arrange({ targets, rowOf, cap: 3, pins: [], viewing: 'V', auto: r.auto });
  assert.deepEqual(r.shown, ['V', 'A', 'P']);
});

test('방금 보관한 작업: 지난번에 보관하지 않았고 이번에 보관한 작업만 (전부터 보관한 작업, 꺼낸 작업, 없는 작업은 아니다)', () => {
  const before = [row('A', 'done'), row('B', 'done', 0, 0, { archived: true }), row('C', 'done', 0, 0, { archived: true })];
  const after = [row('A', 'done', 0, 0, { archived: true }), row('B', 'done', 0, 0, { archived: true }), row('C', 'done'), row('D', 'done', 0, 0, { archived: true })];
  assert.equal(justShelved(before, after, 'A'), true);
  assert.equal(justShelved(before, after, 'B'), false); // 보관함에서 일부러 누른 작업
  assert.equal(justShelved(before, after, 'C'), false); // 꺼냄
  assert.equal(justShelved(before, after, 'D'), false); // 지난번 목록에 없던 작업
  assert.equal(justShelved(before, after, null), false);
  assert.equal(justShelved(undefined, after, 'A'), false); // 처음 읽을 때
});
