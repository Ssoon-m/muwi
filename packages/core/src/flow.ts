// 실제로 일어난 일. 그래프는 계획 그대로 그린다 (카드는 노드 하나에 하나, 선은 계획의 after).
// 실제로 일한 순서와 다시 한 일은 여기서 따로 만들어 카드의 표시와 타임라인으로 잇는다.
//   타임라인: 노드마다 작업 중·응답 대기·막힘이 이어진 구간, 그 구간을 한 쪽(세션이나 서브에이전트)의 줄, 계획이 바뀐 때
//   다시 한 회차: 계획상 뒤 노드를 끝내자마자 다시 시작했으면 그 노드에서 돌아온 것이고, 아니면 앞 회차의 결과를 보여 준다
//   나중에 넣은 노드: 첫 계획 뒤에 생겨 지금도 계획에 있는 노드
// 기록에 적힌 대로 모으기만 한다. 시각을 맞춰 짐작하지 않는다.
import type { Event, Plan } from './store.ts';

/** 노드 하나가 작업 중·응답 대기·막힘으로 이어진 한 구간 */
export type Segment = {
  node: string;
  /** 지금 계획의 제목. 계획에서 빠진 노드는 뺄 때의 제목 */
  title: string;
  attempt: number;
  /** 한 쪽: 서브에이전트가 시작했으면 그 서브에이전트, 아니면 세션. 응답 대기·막힘은 하던 쪽에 이어 둔다 */
  lane: string;
  kind: 'doing' | 'waiting' | 'blocked';
  start: string;
  /** 아직 이어지고 있으면 null */
  end: string | null;
  /** 응답 대기·막힘은 그때 남긴 말, 끝내며 닫힌 구간은 결과 */
  note?: string;
  /** 시작할 때 남긴 근거 (muwi node --why) */
  why?: string;
  /** 노드를 끝내며 닫혔다 */
  done?: true;
  /** 지금 계획에 없는 노드 */
  gone?: true;
  /** 시작을 적지 않고 끝을 적었다. 하는 동안의 기록이 없다 (start와 end가 같다) */
  instant?: true;
};
/** 타임라인의 한 줄: 일한 쪽. 세션 먼저, 처음 나온 순서로 */
export type Lane = { key: string; sub: boolean; name: string };
/** 계획이 바뀐 때 (첫 계획은 넣지 않는다) */
export type PlanMark = { at: string; by: 'ai' | 'human'; why?: string; added: string[]; removed: string[]; changed: string[] };
export type Timeline = { segments: Segment[]; lanes: Lane[]; marks: PlanMark[] };

/**
 * 다시 한 회차 (2회차부터). 그 회차를 시작하기 바로 전에 끝난 노드가 계획상 이 노드 뒤에 있으면 거기서 돌아온 것이다:
 * from, fromTitle, reason(그 회차의 근거, 없으면 돌아온 노드의 결과). 아니면 prev(앞 회차의 결과)
 */
export type Redo = { attempt: number; from: string; fromTitle: string; reason?: string } | { attempt: number; prev?: string };

/** 노드 id → 제목. 계획에서 빠진 노드는 뺄 때의 제목 */
function titlesOf(plan: Plan, events: Event[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const e of events) {
    if (e.type !== 'plan') continue;
    for (const s of [...(e.shapes ?? []), ...(e.gone ?? [])]) titles.set(s.id, s.title);
  }
  for (const n of plan.nodes) titles.set(n.id, n.title);
  return titles;
}

const laneOf = (e: Event) => e.agent ?? e.session ?? '';

export function timelineOf(plan: Plan, events: Event[]): Timeline {
  const titles = titlesOf(plan, events);
  const present = new Set(plan.nodes.map(n => n.id));
  const segments: Segment[] = [];
  const marks: PlanMark[] = [];
  const open = new Map<string, Segment>();
  const attempts = new Map<string, number>();
  const close = (node: string, at: string) => {
    const s = open.get(node);
    if (!s) return;
    s.end = at;
    segments.push(s);
    open.delete(node);
  };
  for (const e of events) {
    if (e.type === 'plan') {
      if (!e.first) marks.push({ at: e.at, by: e.by, ...(e.why ? { why: e.why } : {}), added: e.added, removed: e.removed, changed: e.changed });
      for (const id of e.removed) close(id, e.at);
      continue;
    }
    if (e.type !== 'node') continue;
    const cur = open.get(e.node);
    const attempt = e.attempt ?? attempts.get(e.node) ?? 1;
    attempts.set(e.node, attempt);
    if (e.status === 'doing' || e.status === 'waiting' || e.status === 'blocked') {
      const fresh = e.status === 'doing' || !cur;
      const lane = fresh ? laneOf(e) : cur.lane;
      if (cur && cur.kind === e.status && cur.lane === lane && cur.attempt === attempt) {
        if (e.why) cur.why = e.why;
        continue;
      }
      close(e.node, e.at);
      open.set(e.node, {
        node: e.node, title: '', attempt, lane, kind: e.status, start: e.at, end: null,
        ...(e.status !== 'doing' && e.note ? { note: e.note } : {}),
        ...(e.why ? { why: e.why } : {}),
      });
    } else if (cur) {
      if (e.status === 'done') {
        if (e.note) cur.note = e.note;
        cur.done = true;
      }
      close(e.node, e.at);
    } else if (e.status === 'done') {
      segments.push({
        node: e.node, title: '', attempt, lane: laneOf(e), kind: 'doing', start: e.at, end: e.at,
        ...(e.note ? { note: e.note } : {}), ...(e.why ? { why: e.why } : {}), done: true, instant: true,
      });
    }
  }
  segments.push(...open.values());
  segments.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const subs = new Set(events.filter(e => e.type === 'node' && e.agent).map(e => e.agent!));
  const mains: string[] = [], helpers: string[] = [];
  for (const s of segments) {
    s.title = titles.get(s.node) ?? s.node;
    if (!present.has(s.node)) s.gone = true;
    const list = subs.has(s.lane) ? helpers : mains;
    if (!list.includes(s.lane)) list.push(s.lane);
  }
  const lanes: Lane[] = [
    ...mains.map((key, i) => ({ key, sub: false, name: i ? `세션 ${i + 1}` : '세션' })),
    ...helpers.map((key, i) => ({ key, sub: true, name: `서브 ${i + 1}` })),
  ];
  return { segments, lanes, marks };
}

/** 노드마다 다시 한 회차들 (계획에 있는 노드만) */
export function redosOf(plan: Plan, events: Event[]): Map<string, Redo[]> {
  const titles = titlesOf(plan, events);
  const after = new Map(plan.nodes.map(n => [n.id, n.after]));
  /** x가 계획상 top 뒤에 오는가: x에서 앞 노드 쪽으로 올라가 top에 닿는다 */
  const below = (top: string, x: string) => {
    const seen = new Set<string>();
    const stack = [...(after.get(x) ?? [])];
    while (stack.length) {
      const y = stack.pop()!;
      if (y === top) return true;
      if (seen.has(y)) continue;
      seen.add(y);
      stack.push(...(after.get(y) ?? []));
    }
    return false;
  };
  /** 노드#회차 → 그 회차의 마지막 결과(남긴 말)와 근거 */
  const notes = new Map<string, string | undefined>();
  const whys = new Map<string, string>();
  const latest = new Map<string, number>();
  const starts: { node: string; attempt: number; back?: { node: string; note?: string } }[] = [];
  let lastDone: { node: string; note?: string } | null = null;
  for (const e of events) {
    if (e.type !== 'node') continue;
    const n = e.attempt ?? latest.get(e.node) ?? 1;
    if (n > (latest.get(e.node) ?? 0)) {
      latest.set(e.node, n);
      if (n >= 2 && after.has(e.node)) {
        const back = lastDone && lastDone.node !== e.node && below(e.node, lastDone.node) ? lastDone : undefined;
        starts.push({ node: e.node, attempt: n, ...(back ? { back } : {}) });
      }
    }
    const key = `${e.node}#${n}`;
    if (e.note) notes.set(key, e.note);
    else if (e.status === 'doing' || e.status === 'todo') notes.delete(key);
    if (e.why) whys.set(key, e.why);
    if (e.status === 'done') lastDone = { node: e.node, note: e.note };
  }
  const out = new Map<string, Redo[]>();
  for (const s of starts) {
    const reason = whys.get(`${s.node}#${s.attempt}`) ?? s.back?.note;
    const prev = notes.get(`${s.node}#${s.attempt - 1}`);
    const redo: Redo = s.back
      ? { attempt: s.attempt, from: s.back.node, fromTitle: titles.get(s.back.node) ?? s.back.node, ...(reason ? { reason } : {}) }
      : { attempt: s.attempt, ...(prev ? { prev } : {}) };
    out.set(s.node, [...(out.get(s.node) ?? []), redo]);
  }
  return out;
}

/** 첫 계획 뒤에 넣어서 지금도 계획에 있는 노드 */
export function addedOf(plan: Plan, events: Event[]): Set<string> {
  const added = new Set<string>();
  for (const e of events) {
    if (e.type !== 'plan' || e.first) continue;
    for (const id of e.added) added.add(id);
    for (const id of e.removed) added.delete(id);
  }
  const present = new Set(plan.nodes.map(n => n.id));
  return new Set([...added].filter(id => present.has(id)));
}
