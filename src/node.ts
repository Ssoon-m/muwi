// 노드의 상태를 적는다. muwi node 명령과, 맡긴 새 세션이 떴을 때의 훅이 같이 쓴다.
// 시작할 때 "몇 번째 회차인지"와 "누가 하는지"를 계획에 적어 둔다. 훅이 읽은 skill을 기록할 때 이것을 보고 노드를 같이 적는다.
import { readSession, touchSession } from './session.ts';
import { appendEvent, clock, nowIso, readPlan, withLock, workDir, writePlan } from './store.ts';
import type { NodeStatus, Plan } from './store.ts';

/** 서브에이전트가 "곧 시작한다"고 훅이 적어 둔 것을 얼마 동안 믿을지 */
const STARTING_MS = 120_000;

/**
 * 노드의 상태를 바꾸고 사건 기록에 한 줄 남긴다. 작업이나 노드가 없으면 null.
 * 순서는 보지 않는다. 앞 노드가 끝나지 않아도 시작할 수 있다.
 *
 * 회차: 처음 시작하거나, 끝냈거나 막혔던 노드를 다시 시작하면 새 회차다.
 * 기다리다 이어 하거나, 잠시 멈췄다(pause) 다시 하거나, 하는 중에 다른 쪽이 이어받는 것은 같은 회차다.
 */
export function markNode(dir: string, work: string, id: string, status: NodeStatus, note: string | undefined, key: string | null, env: NodeJS.ProcessEnv = process.env): Plan | null {
  // 서브에이전트가 시작하는 것이면 훅이 방금 그 서브에이전트를 적어 뒀다 (명령에서는 세션 id가 같아 구분할 수 없다)
  const session = key ? readSession(dir, key) : null;
  const pending = status === 'doing' ? session?.starting?.[id] : undefined;
  const agent = pending && clock.now().getTime() - Date.parse(pending.at) < STARTING_MS ? pending.agent : undefined;

  const plan = withLock(workDir(dir, work), () => {
    const plan = readPlan(dir, work);
    const node = plan?.nodes.find(n => n.id === id);
    if (!plan || !node) return null;
    const at = nowIso();
    const before = node.status;
    const same = before === status && (node.note ?? undefined) === (status === 'doing' ? undefined : note);
    node.status = status;
    if (status === 'doing' || status === 'todo') delete node.note;
    else if (note) node.note = note;
    else delete node.note;
    if (status === 'doing') {
      // 기다리다 이어 하거나, 잠시 멈췄던 노드(시작한 적이 있는데 아직으로 돌아간 노드)를 다시 하는 것은 같은 회차다
      const resume = before === 'waiting' || before === 'doing' || (before === 'todo' && (node.attempt ?? 0) > 0);
      node.attempt = resume ? (node.attempt ?? 1) : (node.attempt ?? 0) + 1;
      node.by = { session: key, ...(agent ? { agent } : {}), at };
    } else delete node.by;
    plan.updatedAt = at;
    writePlan(dir, plan);
    // 같은 상태를 다시 적어도 사건은 남긴다. 다른 쪽이 이어받은 것일 수 있다
    if (!same || status === 'doing') {
      appendEvent(dir, work, {
        type: 'node', node: id, status,
        ...(node.note ? { note: node.note } : {}),
        ...(node.attempt ? { attempt: node.attempt } : {}),
        // 시작할 때의 모델을 노드에 적어 둔다. 세션이 도중에 모델을 바꿔도 앞에서 한 노드의 기록은 그대로 남는다.
        // 서브에이전트는 세션과 다른 모델을 쓸 수 있어서 세션의 모델로 적지 않는다
        ...(status === 'doing' ? { ...(agent ? { agent } : {}), seen: Boolean(session?.hooked), ...(!agent && session?.model ? { model: session.model } : {}) } : {}),
      }, key, at);
    }
    return plan;
  });

  // 서브에이전트가 직접 시작했으면 그 서브에이전트의 노드로 적어 둔다. 그 뒤에 읽는 skill이 이 노드에 붙는다
  if (plan && key && pending) {
    const starting = { ...(session?.starting ?? {}) };
    delete starting[id];
    const node = plan.nodes.find(n => n.id === id);
    const agents = agent && node ? { ...(session?.agents ?? {}), [agent]: { work, node: id, attempt: node.attempt ?? 1, own: true } } : session?.agents;
    touchSession(dir, key, { starting, ...(agents ? { agents } : {}) }, env);
  }
  return plan;
}
