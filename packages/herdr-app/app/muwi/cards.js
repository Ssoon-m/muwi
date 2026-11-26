// 그래프에 그리는 카드 (muwi board가 주는 drawn.cards, core의 flow.ts).
// 다시 한 노드가 여러 카드로 나뉘면(뒤 노드가 끝난 뒤 다시 했다) 카드마다 그 카드의 회차들로 그린다.
// 예: verify(1회차, 끝) → rework → verify(2회차, 하는 중). 나뉘지 않은 노드는 노드 그대로 그린다.

/** 카드 id → 그 카드로 그릴 노드. drawn이 없는 기록(예시 화면 등)은 노드 하나가 카드 하나다 */
export function cardNodes(view) {
  const byId = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
  const out = new Map();
  for (const c of cardsOf(view)) {
    const n = byId.get(c.node);
    if (n) out.set(c.id, c.tries ? cardNode(n, c) : n);
  }
  return out;
}

const cardsOf = (view) => view?.drawn?.cards ?? (view?.nodes ?? []).map((n) => ({ id: n.id, node: n.id }));

/**
 * 나뉜 카드 하나. node: 그 노드의 id (누르면 그 노드의 기록을 본다), round: 카드에 적을 회차 ("1회차", "2~3회차").
 * 지금 회차가 든 카드는 노드의 지금 상태 그대로 그리고, 앞 카드는 그 카드의 마지막 회차가 남긴 상태·결과로 그린다
 */
export function cardNode(n, card) {
  const tries = card.tries ?? [];
  const part = (n.tries ?? []).filter((t) => tries.includes(t.n));
  const first = tries[0], last = tries[tries.length - 1];
  const base = {
    ...n,
    id: card.id,
    node: n.id,
    round: first === last ? `${first}회차` : `${first}~${last}회차`,
    spentMs: part.reduce((sum, t) => sum + (t.spentMs ?? 0), 0),
  };
  if (tries.includes(n.attempts)) return base;
  const end = part[part.length - 1];
  return {
    ...base,
    status: end?.status ?? "done",
    note: end?.note,
    who: end?.who,
    session: end?.who?.session,
    skills: end?.skills ?? [],
    seen: end?.seen ?? n.seen,
    instant: end?.instant ?? false,
    startedAt: part[0]?.startedAt,
    endedAt: end?.endedAt,
    since: end?.endedAt,
    // 지금 일어나는 일이 아니다: 세션이 닫힘·멈춤, 계획과 다름, 맡긴 세션 같은 표시는 지금 회차의 카드에만
    closed: false,
    quiet: undefined,
    paused: false,
    early: false,
    offPlan: false,
    runUnknown: false,
    spawn: undefined,
  };
}

/** 노드 id들 → 그 노드를 그리는 카드 중 마지막 카드(지금 회차가 든 카드)의 id들 */
export function lastCards(view, ids) {
  const last = new Map();
  for (const c of cardsOf(view)) last.set(c.node, c.id);
  return ids.map((id) => last.get(id) ?? id);
}
