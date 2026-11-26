// 그래프 칸에 그리는 카드와 선. 계획의 선을 실제로 일어난 순서에 맞춘다.
// 기준: 선 A → B는 "B는 A 뒤에 일어난 일"이다. 위에서 아래로(왼쪽에서 오른쪽으로) 읽으면 실제로 일한 순서가 된다.
// 기록(노드·회차)과 계획의 선은 바꾸지 않는다. 그리는 카드와 선만 맞춘다. 그래서 이미 있는 작업에도 그대로 적용된다.
//
//  1. 다시 한 노드: 어떤 회차를 시작하기 전에(앞 회차가 끝난 뒤로) 그 노드와 선으로 이어진 노드의 카드가 끝났으면,
//     그 회차부터 새 카드로 그리고 그 끝난 카드들 뒤에 잇는다. 사이에 끝난 카드가 없으면 같은 카드에 둔다 ("N회차").
//     예: verify → rework → verify(2회차) → rework(2회차) → full
//  2. 손대기 전 노드 뒤에 그려지는 노드: B를 (마지막으로) 시작할 때 계획상 앞 노드 A가 끝나지도 하고 있지도 않았으면,
//     A 대신 A의 앞 노드 쪽으로 올라가 그때 끝났거나 하고 있던 노드 뒤에 잇는다. 그 앞 노드들은 옆 가지로 남는다.
//     예: review → apply-review(응답 대기) → review2(시작 전) 뒤에 넣은 reorg(끝)는 review 뒤에 그린다.
//     시작 전이거나 잠시 멈춘 노드(앞에 끼어든 노드에 자리를 내줬다)는 계획대로 잇는다. 그 노드는 앞 노드 뒤에 할 일이다.
//
// 때는 시각이 아니라 기록의 줄 순서로 잰다. 같은 시각에 적힌 줄(끝내면서 다음 노드를 시작)도 앞뒤가 갈린다.
import type { Event, NodeStatus, Plan } from './store.ts';

/** 그리는 카드 하나. 다시 한 노드가 여러 카드로 나뉘면 카드마다 그리는 회차(tries)를 적는다. 나뉘지 않은 노드는 id가 노드 id다 */
export type Card = { id: string; node: string; tries?: number[] };
export type Flow = { cards: Card[]; edges: { from: string; to: string }[] };

type Attempt = {
  n: number;
  /** 이 회차의 첫 줄 */
  first: number;
  /** 이 회차를 마지막으로 시작(다시 시작)한 줄: 시작한 줄, 또는 잠시 멈췄다가(todo) 다시 움직인 줄. 시작을 적지 않고 끝냈으면 첫 줄 */
  resumed: number;
  /** 이 회차의 지금(그 줄까지의) 상태 */
  status: NodeStatus;
  /** 이 회차의 마지막 줄 */
  last: number;
  /** 이 회차가 끝으로 끝났으면 그 줄 */
  done?: number;
};
type Draw = { id: string; node: string; tries: number[]; start: number };

/** 이 회차 카드의 id. 노드 id에는 #이 들어가지 않는다 (plan.ts의 NODE_ID) */
export const cardId = (node: string, n: number) => `${node}#${n}`;

export function flowOf(plan: Plan, events: Event[]): Flow {
  const byId = new Map(plan.nodes.map(n => [n.id, n]));
  const next = new Map(plan.nodes.map(n => [n.id, [] as string[]]));
  for (const n of plan.nodes) for (const a of n.after) next.get(a)?.push(n.id);
  const before = (id: string) => (byId.get(id)?.after ?? []).filter(a => byId.has(a));

  const attempts = new Map<string, Attempt[]>();
  /** 노드마다 상태가 바뀐 줄과 그 상태 */
  const timeline = new Map<string, [number, NodeStatus][]>();
  events.forEach((e, i) => {
    if (e.type !== 'node' || !byId.has(e.node)) return;
    const list = attempts.get(e.node) ?? [];
    attempts.set(e.node, list);
    const n = e.attempt ?? list[list.length - 1]?.n ?? 1;
    let a = list.find(x => x.n === n);
    if (!a) {
      a = { n, first: i, resumed: i, last: i, status: e.status };
      list.push(a);
      list.sort((x, y) => x.n - y.n);
    }
    a.last = i;
    // 잠시 멈췄다가(앞에 끼어든 노드에 자리를 내줬다) 시작을 적지 않고 바로 끝낸 것도 다시 움직인 것이다
    if (e.status === 'doing' || (a.status === 'todo' && e.status !== 'todo')) a.resumed = i;
    a.status = e.status;
    if (e.status === 'done') a.done = i;
    else delete a.done;
    const line = timeline.get(e.node) ?? [];
    timeline.set(e.node, line);
    line.push([i, e.status]);
  });
  const attemptOf = (node: string, n: number) => attempts.get(node)?.find(a => a.n === n);
  /** 그 줄을 적은 때 그 노드의 상태 */
  const statusAt = (node: string, i: number): NodeStatus => {
    let s: NodeStatus = 'todo';
    for (const [at, status] of timeline.get(node) ?? []) {
      if (at > i) break;
      s = status;
    }
    return s;
  };

  // 1. 카드: 회차를 시작한 순서대로 훑으며, 앞 회차가 끝난 뒤로 선으로 이어진 노드의 카드가 끝났으면 새 카드를 연다
  const cards = new Map<string, Draw[]>();
  const edges: [string, string][] = [];
  const starts = [...attempts].flatMap(([node, list]) => list.map((a, k) => ({ node, a, prev: list[k - 1] }))).sort((x, y) => x.a.first - y.a.first);
  for (const { node, a, prev } of starts) {
    const mine = cards.get(node) ?? [];
    cards.set(node, mine);
    if (!prev || !mine.length) {
      mine.push({ id: node, node, tries: [a.n], start: a.first });
      continue;
    }
    const from = prev.done ?? prev.last;
    const between: string[] = [];
    for (const other of new Set([...(next.get(node) ?? []), ...before(node)])) {
      const ended = (cards.get(other) ?? []).filter(c => c.tries.some(k => {
        const done = attemptOf(other, k)?.done;
        return done !== undefined && done > from && done < a.first;
      }));
      if (ended.length) between.push(ended[ended.length - 1].id);
    }
    if (!between.length) {
      mine[mine.length - 1].tries.push(a.n);
      continue;
    }
    const id = cardId(node, a.n);
    mine.push({ id, node, tries: [a.n], start: a.first });
    for (const b of between) edges.push([b, id]);
  }

  /** 그 줄을 적은 때 그 노드를 그리던 카드 (그때까지 연 카드 중 마지막) */
  const cardAt = (node: string, i: number) => {
    const list = cards.get(node) ?? [];
    return [...list].reverse().find(c => c.start <= i)?.id ?? list[0]?.id ?? node;
  };
  const latest = (node: string) => cards.get(node)?.at(-1)?.id ?? node;

  // 2. 계획의 선을 각 노드의 첫 카드로 잇는다
  for (const n of plan.nodes) {
    const mine = cards.get(n.id);
    // 시작 전이거나 잠시 멈췄다: 계획대로 앞 노드(의 마지막 카드) 뒤에 할 일이다
    if (!mine?.length || (mine.length === 1 && n.status === 'todo')) {
      for (const p of before(n.id)) edges.push([latest(p), n.id]);
      continue;
    }
    const first = mine[0];
    const at = Math.max(...first.tries.map(k => attemptOf(n.id, k)?.resumed ?? first.start));
    const seen = new Set<string>();
    // 그때 끝났거나 하고 있던 노드를 만날 때까지 앞 노드 쪽으로 올라간다
    const up = (p: string): string[] => {
      if (seen.has(p)) return [];
      seen.add(p);
      const s = statusAt(p, at);
      return s === 'done' || s === 'doing' ? [cardAt(p, at)] : before(p).flatMap(up);
    };
    for (const p of before(n.id)) for (const from of up(p)) edges.push([from, first.id]);
  }

  // 카드는 계획의 순서대로, 나뉜 카드는 그 노드 자리에 회차 순서대로 둔다 (배치가 계획의 순서를 따른다)
  const out: Card[] = plan.nodes.flatMap(n => {
    const mine = cards.get(n.id);
    if (!mine || mine.length < 2) return [{ id: n.id, node: n.id }];
    return mine.map(c => ({ id: c.id, node: n.id, tries: c.tries }));
  });
  // 같은 선은 한 번만, 돌아가는 선(고리)은 넣지 않는다 (위의 규칙으로는 생기지 않지만 배치가 깨지지 않게)
  const drawn: { from: string; to: string }[] = [];
  const outOf = new Map<string, string[]>();
  const reaches = (a: string, b: string) => {
    const stack = [a];
    const seen = new Set<string>();
    while (stack.length) {
      const x = stack.pop()!;
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...(outOf.get(x) ?? []));
    }
    return false;
  };
  for (const [from, to] of edges) {
    if (from === to || drawn.some(e => e.from === from && e.to === to) || reaches(to, from)) continue;
    drawn.push({ from, to });
    outOf.set(from, [...(outOf.get(from) ?? []), to]);
  }
  return { cards: out, edges: drawn };
}
