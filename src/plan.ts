// 계획의 모양을 확인하고, 이전 계획과 무엇이 달라졌는지 찾는다.
// 여기서 보는 것은 형식뿐이다 (id가 겹치지 않는가, 없는 노드를 가리키지 않는가, 돌고 도는 선이 없는가).
// 어떤 노드를 둘지, 어떤 순서로 할지는 계획을 쓰는 쪽(AI)이 정한다.
import type { NodeStatus, Plan, PlanNode } from './store.ts';

export type PlanInput = { title?: string; nodes: { id: string; title: string; after: string[] }[] };

const NODE_ID = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣_.-]*$/;
const MAX_NODES = 60;

/** 받은 값이 계획 모양인지 확인한다. 문제가 있으면 problems에 담는다 */
export function parsePlan(raw: unknown): { plan?: PlanInput; problems: string[] } {
  const problems: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { problems: ['계획은 {"nodes": [...]} 모양의 JSON이어야 해요'] };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.nodes) || r.nodes.length === 0) return { problems: ['nodes가 비어 있어요. 노드를 하나 이상 적어요'] };
  if (r.nodes.length > MAX_NODES) problems.push(`노드가 너무 많아요 (${r.nodes.length}개, ${MAX_NODES}개까지). 사람이 그래프로 읽을 수 있는 크기로 묶어요`);
  if (r.title !== undefined && typeof r.title !== 'string') problems.push('title은 글자여야 해요');

  const nodes: PlanInput['nodes'] = [];
  const seen = new Set<string>();
  r.nodes.forEach((n: any, i: number) => {
    const where = `nodes[${i}]`;
    if (n == null || typeof n !== 'object') return problems.push(`${where}: {"id", "title"} 모양이어야 해요`);
    if (typeof n.id !== 'string' || !NODE_ID.test(n.id)) return problems.push(`${where}: id는 글자·숫자·_ . -로 써요 (받은 값: ${JSON.stringify(n.id)})`);
    if (seen.has(n.id)) return problems.push(`${where}: id가 겹쳐요 (${n.id})`);
    seen.add(n.id);
    if (typeof n.title !== 'string' || !n.title.trim()) problems.push(`${n.id}: title이 없어요`);
    const after = n.after === undefined ? [] : typeof n.after === 'string' ? [n.after] : n.after;
    if (!Array.isArray(after) || after.some((a: unknown) => typeof a !== 'string')) return problems.push(`${n.id}: after는 노드 id 목록이어야 해요`);
    nodes.push({ id: n.id, title: String(n.title ?? '').trim(), after: [...new Set(after as string[])] });
  });
  for (const n of nodes) {
    for (const a of n.after) {
      if (a === n.id) problems.push(`${n.id}: after에 자기 자신이 있어요`);
      else if (!seen.has(a)) problems.push(`${n.id}: after의 ${a}는 없는 노드예요`);
    }
  }
  if (!problems.length) {
    const loop = findCycle(nodes);
    if (loop) problems.push(`선이 돌고 돌아요: ${loop.join(' → ')}. 다시 하는 일은 같은 노드를 다시 시작하면 돼요 (회차로 기록돼요)`);
  }
  if (problems.length) return { problems };
  return { plan: { title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined, nodes }, problems };
}

/** after를 따라가다 자기 자신으로 돌아오는 길이 있으면 그 길을 돌려준다 */
export function findCycle(nodes: { id: string; after: string[] }[]): string[] | null {
  const after = new Map(nodes.map(n => [n.id, n.after]));
  const state = new Map<string, 1 | 2>(); // 1: 보는 중, 2: 다 봄
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const a of after.get(id) ?? []) {
      const loop = visit(a);
      if (loop) return loop;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of nodes) {
    const loop = visit(n.id);
    if (loop) return loop.reverse();
  }
  return null;
}

export type PlanDiff = { added: string[]; removed: string[]; changed: string[] };

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** 이전 계획과 비교해 생긴 노드, 없어진 노드, 제목이나 순서가 달라진 노드를 찾는다 */
export function diffPlan(old: PlanNode[], next: PlanInput['nodes']): PlanDiff {
  const before = new Map(old.map(n => [n.id, n]));
  const nextIds = new Set(next.map(n => n.id));
  return {
    added: next.filter(n => !before.has(n.id)).map(n => n.id),
    removed: old.filter(n => !nextIds.has(n.id)).map(n => n.id),
    changed: next.filter(n => {
      const b = before.get(n.id);
      return b !== undefined && (b.title !== n.title || !sameList(b.after, n.after));
    }).map(n => n.id),
  };
}

export const isEmptyDiff = (d: PlanDiff) => !d.added.length && !d.removed.length && !d.changed.length;

/** 새 계획의 노드에 이전 상태를 이어 붙인다. 같은 id면 하던 상태 그대로, 새 노드는 아직(todo) */
export function carryStatus(old: PlanNode[], next: PlanInput['nodes']): PlanNode[] {
  const before = new Map(old.map(n => [n.id, n]));
  return next.map(n => {
    const b = before.get(n.id);
    const status: NodeStatus = b?.status ?? 'todo';
    return { id: n.id, title: n.title, after: n.after, status, ...(b?.note ? { note: b.note } : {}) };
  });
}

/**
 * 노드 하나를 끼워 넣는다. before를 주면 그 노드가 새 노드 다음에 오게 선을 다시 잇는다.
 * 목록에서의 자리도 흐름을 따라 잡는다 (before 앞, 없으면 after 노드들 바로 뒤). 그림과 목록이 읽는 순서대로 나온다.
 */
export function addNode(plan: Plan, node: { id: string; title: string; after: string[] }, before?: string): PlanInput {
  const nodes = plan.nodes.map(n => ({ id: n.id, title: n.title, after: [...n.after] }));
  const fresh = { id: node.id, title: node.title, after: [...node.after] };
  const target = before ? nodes.find(n => n.id === before) : undefined;
  if (target) {
    // 예: impl → check 사이에 lint를 넣으면 impl → lint → check가 된다
    target.after = [...target.after.filter(a => !node.after.includes(a)), node.id];
    nodes.splice(nodes.indexOf(target), 0, fresh);
  } else {
    const last = Math.max(-1, ...node.after.map(a => nodes.findIndex(n => n.id === a)));
    nodes.splice(node.after.length ? last + 1 : nodes.length, 0, fresh);
  }
  return { title: plan.title, nodes };
}

/** 노드 하나를 뺀다. 그 노드 다음에 오던 노드는 빠진 노드의 앞 노드로 잇는다 */
export function removeNode(plan: Plan, id: string): PlanInput {
  const gone = plan.nodes.find(n => n.id === id);
  const nodes = plan.nodes
    .filter(n => n.id !== id)
    .map(n => ({
      id: n.id,
      title: n.title,
      after: n.after.includes(id) ? [...new Set([...n.after.filter(a => a !== id), ...(gone?.after ?? [])])] : [...n.after],
    }));
  return { title: plan.title, nodes };
}
