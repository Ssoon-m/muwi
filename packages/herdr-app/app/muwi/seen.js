// 새 결과(끝났는데 아직 안 본 작업)를 그 작업의 터미널에서 봤는지 (화면 없이 계산만 한다. 시험은 tests/seen.test.ts).
// 사람이 그 작업을 한 대화의 터미널을 보고 있으면 결과를 읽은 것이다: 한 터미널에서 지켜보는 동안 작업이 끝나면 곧바로 "끝"으로 간다.

/** 그 작업을 한 대화(AI 세션)들. 목록 줄·터미널로 이동 단추가 갈 터미널을 찾을 때와 같다 */
export const talksOf = (w) => [...new Set(w?.talks ?? [w?.lead, ...Object.keys(w?.sessions ?? {})].filter(Boolean))];

/**
 * 본 것으로 적을 새 결과들.
 *   front: Herdr 창이 앞에 있고 보인다. terminal: 키보드가 있는(보이는) 터미널.
 *   owner: 그 터미널에서 지금 도는 세션. agent: 그 터미널에 AI 도구가 떠 있다.
 * 그 터미널의 지금 세션이 그 작업을 한 대화이면 본 것이다 (그 대화가 지금 다른 작업을 하고 있어도, 대화가 여럿이어도).
 * 보관한 작업은 목록에 없으므로 적지 않는다
 */
export function seenWorks({ works, front, terminal, owner, agent }) {
  if (!front || !terminal || !owner || !agent) return [];
  return (works ?? []).filter((w) => w.unread && !w.archived && talksOf(w).includes(owner)).map((w) => w.work);
}

/** 다른 칸이 먼저 적기 시작한 작업을 이 칸이 건너뛰는 시간 */
export const SEEN_TTL = 10_000;

/**
 * 칸끼리(사이드바 목록, 그래프 칸) 본 것으로 적기를 나눠 맡는다. claims: { 작업: 맡은 때 } (모든 칸이 같이 쓰는 값).
 * 다른 칸이 SEEN_TTL 안에 맡은 작업이면 맡지 않는다. 지난 것과 앞날짜(시계를 되돌림)인 것은 버린다.
 * { ok: 이 칸이 맡는가, claims: 새로 쓸 값 }
 */
export function claimSeen(claims, work, now) {
  const kept = {};
  for (const [w, at] of Object.entries(claims ?? {})) if (typeof at === "number" && at <= now && now - at < SEEN_TTL) kept[w] = at;
  if (work in kept) return { ok: false, claims: kept };
  return { ok: true, claims: { ...kept, [work]: now } };
}
