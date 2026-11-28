// 큰 그래프 아래 타임라인: 실제로 일어난 일 (muwi board가 주는 timeline. core의 flow.ts).
// 그래프는 계획 그대로이고, 실제로 일한 순서와 쪽은 여기에 나온다. 여기서는 놓을 자리와 글만 계산한다.

const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
export const circled = (n) => CIRCLED[n] ?? `(${n})`;

/** 이보다 짧은 막대(전체 시간에 대한 비율)는 얇은 선으로 그린다 */
const THIN = 0.004;

/**
 * 시간 축에 놓을 막대와 계획이 바뀐 표시. now: 아직 이어지는 구간을 늘릴 지금 (ms). 일어난 일이 없으면 null.
 * left·width는 전체 시간에 대한 백분율 문자열이다.
 * 막대: tone(그릴 색: done·doing·waiting·blocked), label(막대에 쓸 글), thin(얇은 선으로 그린다), i(구간의 순번), 그 구간(segment)의 값
 */
export function timelineLayout(timeline, now) {
  const segs = (timeline?.segments ?? []).map((x, i) => ({ ...x, i, from: Date.parse(x.start), to: x.end ? Date.parse(x.end) : now }));
  if (!segs.length) return null;
  const marks = (timeline.marks ?? []).map((m) => ({ ...m, from: Date.parse(m.at) }));
  const t0 = Math.min(...segs.map((x) => x.from), ...marks.map((m) => m.from));
  const span = Math.max(1000, ...segs.map((x) => x.to - t0), ...marks.map((m) => m.from - t0));
  const share = (ms) => `${Math.max(0, Math.min(100, (ms / span) * 100)).toFixed(3)}%`;
  // 여러 번 한 노드는 막대마다 몇 번째인지 붙인다
  const several = new Set(segs.filter((x) => x.attempt > 1).map((x) => x.node));
  const bar = (x) => {
    const head = x.kind === "waiting" ? `응답 대기 · ${x.title}` : x.kind === "blocked" ? `막힘 · ${x.title}` : `${x.title}${several.has(x.node) ? circled(x.attempt) : ""}`;
    return {
      ...x,
      left: share(x.from - t0),
      width: share(x.to - x.from),
      thin: Boolean(x.instant) || x.to - x.from < span * THIN,
      tone: x.kind === "doing" ? (x.done ? "done" : "doing") : x.kind,
      label: `${head}${x.gone ? " · 빠짐" : ""}${x.note ? ` · ${x.note}` : ""}`,
    };
  };
  return {
    start: t0,
    span,
    lanes: (timeline.lanes ?? []).map((l) => ({ ...l, bars: segs.filter((x) => x.lane === l.key).map(bar) })),
    marks: marks.map((m) => ({ ...m, left: share(m.from - t0) })),
    ticks: [0, 0.25, 0.5, 0.75].map((f) => ({ at: t0 + span * f, left: share(span * f) })),
  };
}
