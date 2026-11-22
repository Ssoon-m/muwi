// 노드의 상태를 적는다. muwi node 명령과, 맡긴 새 세션이 떴을 때의 훅이 같이 쓴다.
import { appendEvent, nowIso, readPlan, withLock, workDir, writePlan } from './store.ts';
import type { NodeStatus, Plan } from './store.ts';

/**
 * 노드의 상태를 바꾸고 사건 기록에 한 줄 남긴다. 작업이나 노드가 없으면 null.
 * 순서는 보지 않는다. 앞 노드가 끝나지 않아도 시작할 수 있다.
 */
export function markNode(dir: string, work: string, id: string, status: NodeStatus, note: string | undefined, key: string | null): Plan | null {
  return withLock(workDir(dir, work), () => {
    const plan = readPlan(dir, work);
    const node = plan?.nodes.find(n => n.id === id);
    if (!plan || !node) return null;
    const at = nowIso();
    const same = node.status === status && (node.note ?? undefined) === (status === 'doing' ? undefined : note);
    node.status = status;
    if (status === 'doing' || status === 'todo') delete node.note;
    else if (note) node.note = note;
    else delete node.note;
    plan.updatedAt = at;
    writePlan(dir, plan);
    // 같은 상태를 다시 적어도 사건은 남긴다. 다른 세션이 이어받은 것일 수 있다
    if (!same || status === 'doing') appendEvent(dir, work, { type: 'node', node: id, status, ...(node.note ? { note: node.note } : {}) }, key, at);
    return plan;
  });
}
