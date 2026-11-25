// 그래프 칸(관제탑)에 여러 작업을 나눠 그릴 때 무엇을 어디에 둘지 (화면 없이 계산만 한다. 시험은 tests/lanes.test.ts).
//   끝나지 않은 작업은 어느 탭·터미널에 있든 늘 나온다. 키보드를 옮기면 보는 중과 자리 순서만 바뀐다.
//   큰 그래프: 위쪽에 나눠 그린 그래프들. 고정 → 보는 중 → 자동 순서 (브라우저의 고정 탭처럼)
//   지도 줄: 큰 그래프에 못 들어간 작업을 줄여 그린 작은 지도들. 넘친 고정 → 응답 대기·막힘 → 작업 중 → 멈춤 → 끝
// 자리는 이 규칙으로만 정한다. 상태가 바뀌었다고 다시 정렬하지 않는다 (사람이 보던 자리가 흔들리지 않게).

/** 큰 그래프 하나가 읽히는 최소 크기와 그래프 사이 간격 */
export const LANE = { w: 380, h: 260, gap: 6, pad: 6 };

/** 자리를 다툴 때의 등급: 낮을수록 급하다. 끝은 이미 자리에 있던 것만 남는다 */
const GRADE = { waiting: 0, blocked: 0, doing: 1, stalled: 2, done: 3 };
// 상태를 모르면(값이 없거나 처음 보는 값) 목록처럼 작업 중으로 본다.
// 지난 작업으로 접힌 끝나지 않은 작업(세션 상태를 모른 채 오래 소식이 없는 작업 등)은 멈춤과 같은 급이다
const grade = (row) => (row?.past && row.state !== "done" ? GRADE.stalled : GRADE[row?.state] ?? 1);
const time = (iso) => Date.parse(iso ?? "") || 0;

/** 끝나지 않은 작업인가 (응답 대기·막힘·작업 중·멈춤). 그래프 칸에 늘 나온다 */
export const unfinished = (row) => grade(row) < GRADE.done;

/**
 * 그래프 칸에 나올 작업: 끝나지 않은 작업(지난 작업으로 접힌 것도), 고정한 작업, 보는 중, 고른 작업, 자동 자리에 이미 있던 작업.
 * 보관한 작업은 고정돼 있어도 뺀다. 다만 보는 중이면(보관함에서 일부러 눌렀거나 그 작업의 터미널로 갔으면) 넣는다.
 * 그래서 끝나지 않은 작업은 보는 중이 어디든(어느 탭이든) 늘 들어 있다. 순서는 목록(rows)과 같다
 */
export function laneTargets(rows, o) {
  const keep = new Set([...(o.pins ?? []), ...(o.auto ?? []), o.viewing, o.picked].filter(Boolean));
  return rows.filter((r) => r.work === o.viewing || (!r.archived && (keep.has(r.work) || unfinished(r)))).map((r) => r.work);
}

/** 칸 크기로 큰 그래프 자리 수: 한 줄의 수(cols) × 줄 수(rows). strip: 지도 줄이 차지할 높이 */
export function laneGrid(area, strip = 0) {
  const fit = (size, min) => Math.max(1, Math.floor((size - LANE.pad * 2 + LANE.gap) / (min + LANE.gap)));
  return { cols: fit(area.width, LANE.w), rows: fit(area.height - strip, LANE.h) };
}

/**
 * 큰 그래프에 둘 작업을 cap개까지, 왼쪽부터:
 *   1. 고정한 작업, 고정한 순서. 보는 중이 돼도 자리가 바뀌지 않는다
 *   2. 보는 중 (고정이 아니면 고정 묶음 바로 뒤). 늘 큰 그래프에 둔다:
 *      고정이 자리를 다 채우면 마지막 자리를 보는 중에게 주고, 밀린 고정은 지도 줄로 간다
 *   3. 자동: 남은 자리에 끝나지 않은 작업. 응답 대기·막힘 > 작업 중 > 멈춤 > (이미 자리에 있던) 끝.
 *      같은 등급이면 최근에 움직인 작업이 먼저 자리를 받고, 오래 안 움직인 작업이 먼저 비킨다.
 *      한 번 자리를 받은 작업은 밀려날 때까지 그 자리에 있고, 더 높은 등급만 더 낮은 등급의 자리를 그 자리에서 바꾼다
 * auto: 지난번 자동 자리 (자리 순서). 돌려주는 auto를 다음에 그대로 넘긴다
 */
export function arrange(o) {
  const { targets, rowOf, cap } = o;
  const has = new Set(targets);
  const g = (id) => grade(rowOf(id));
  const moved = (id) => time(rowOf(id)?.updatedAt);
  // a가 b보다 덜 중요한가: 등급이 낮거나, 같은 등급이면 오래 안 움직였다
  const lower = (a, b) => g(a) > g(b) || (g(a) === g(b) && moved(a) < moved(b));
  const view = o.viewing && has.has(o.viewing) ? o.viewing : null;
  const pins = (o.pins ?? []).filter((id) => has.has(id));
  let front = pins.slice(0, cap);
  if (view && !front.includes(view)) front = [...pins.slice(0, Math.max(0, cap - 1)), view];
  const room = cap - front.length;
  const auto = (o.auto ?? []).filter((id) => has.has(id) && !front.includes(id) && !pins.includes(id));
  const lowest = (ok) => {
    let at = -1;
    auto.forEach((id, i) => {
      if (ok(id) && (at < 0 || !lower(auto[at], id))) at = i;
    });
    return at;
  };
  // 자리가 줄었으면 가장 덜 중요한 자리부터 비운다
  while (auto.length > room) auto.splice(lowest(() => true), 1);
  // 들이기: 끝나지 않은 작업만, 급한 등급 순, 같은 등급이면 최근에 움직인 순
  const outside = targets
    .filter((id) => !front.includes(id) && !auto.includes(id) && !pins.includes(id) && unfinished(rowOf(id)))
    .sort((a, b) => g(a) - g(b) || moved(b) - moved(a));
  for (const id of outside) {
    if (auto.length < room) {
      auto.push(id);
      continue;
    }
    const at = lowest((x) => g(x) > g(id));
    if (at >= 0) auto[at] = id;
  }
  return { shown: [...front, ...auto], auto };
}

/**
 * 지도 줄의 순서: 넘친 고정(고정한 순서) → 응답 대기·막힘 → 작업 중 → 멈춤 → 끝. 묶음 안은 만든 순 (계획을 처음 적은 때).
 * 등급이 바뀌거나 큰 그래프로 오르내리거나 새 작업이 생길 때만 움직인다
 */
export function stripOrder(hidden, rowOf, pins = []) {
  const group = (id) => (pins.includes(id) ? -1 : grade(rowOf(id)));
  const made = (id) => time(rowOf(id)?.createdAt ?? rowOf(id)?.updatedAt);
  return [...hidden].sort((a, b) => group(a) - group(b)
    || (group(a) < 0 ? pins.indexOf(a) - pins.indexOf(b) : made(a) - made(b) || (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * 방금 보관한 작업인가: 지난번 목록(before)에는 보관하지 않은 작업으로 있었고, 이번 목록(after)에서 보관한 작업이다.
 * 보는 중·고른 작업을 비우고 그래프 칸 대상에서 뺄 때 쓴다. 전부터 보관한 작업(보관함에서 일부러 누른 작업)은 아니다
 */
export function justShelved(before, after, id) {
  if (!id) return false;
  const was = (before ?? []).find((w) => w.work === id);
  const now = (after ?? []).find((w) => w.work === id);
  return Boolean(was) && !was.archived && Boolean(now?.archived);
}

/** 고정을 켜고 끈다. 새로 고정하면 고정 묶음의 맨 뒤 */
export const togglePin = (pins, work) => (pins.includes(work) ? pins.filter((x) => x !== work) : [...pins, work]);

/**
 * 그래프 칸에 큰 그래프와 지도 줄을 놓는다. 돌려주는 auto를 다음에 그대로 넘긴다.
 *   area: 큰 그래프들이 놓이는 곳의 크기. strip: 지도 줄이 생기면 차지할 높이.
 *   focus: 크게 보기 (lead 하나만 크게, 자동 자리는 그대로 둔다)
 * 지도 줄이 생길 때만 그 높이를 빼고 자리 수를 다시 센다. 생기는지는 다음에도 남을 작업으로 정한다:
 * 방금 자동 자리에서 내보낸 끝난 작업은 다음부터 대상이 아니므로 지도 줄에 넣지 않는다
 */
export function layoutLanes(o) {
  const { area, targets, rowOf, viewing, picked, focus, lead, strip } = o;
  const pins = o.pins ?? [];
  const keeps = (id, auto) => {
    const r = rowOf(id);
    return pins.includes(id) || id === viewing || id === picked || auto.includes(id) || unfinished(r);
  };
  const place = (cap) => (focus ? { shown: [lead], auto: o.auto ?? [] } : arrange({ targets, rowOf, cap, pins, viewing, auto: o.auto ?? [] }));
  const rest = (r) => targets.filter((id) => !r.shown.includes(id) && keeps(id, r.auto));
  let grid = laneGrid(area);
  let r = place(grid.cols * grid.rows);
  if (rest(r).length > 0) {
    grid = laneGrid(area, strip);
    r = place(grid.cols * grid.rows);
  }
  return { grid, shown: r.shown, auto: r.auto, below: stripOrder(rest(r), rowOf, pins) };
}
