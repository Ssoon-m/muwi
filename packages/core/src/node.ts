// 노드의 상태를 적는다. muwi node 명령과, 맡긴 새 세션이 떴을 때의 훅이 같이 쓴다.
// 시작할 때 "몇 번째 회차인지"와 "누가 하는지"를 계획에 적어 둔다. 훅이 읽은 skill을 기록할 때 이것을 보고 노드를 같이 적는다.
import crypto from 'node:crypto';
import { readSession, touchSession } from './session.ts';
import { appendEvent, clock, nowIso, readPlan, withLock, workDir, writePlan } from './store.ts';
import type { NodeStatus, Plan, PlanNode } from './store.ts';

/** 서브에이전트가 "곧 시작한다"고 훅이 적어 둔 것을 얼마 동안 믿을지 */
const STARTING_MS = 120_000;

/** 훅이 방금 적어 둔, 이 노드를 시작하려는 서브에이전트 (도구의 훅이 서브에이전트를 알려 줄 때만 있다) */
function startingAgent(dir: string, key: string | null, id: string): string | undefined {
  const pending = key ? readSession(dir, key)?.starting?.[id] : undefined;
  return pending && clock.now().getTime() - Date.parse(pending.at) < STARTING_MS ? pending.agent : undefined;
}

/**
 * 이 명령을 서브에이전트가 실행했는가. 서브에이전트는 세션 id가 부모와 같아서 명령만으로는 구분할 수 없다.
 *   - 스스로 밝혔다 (muwi node <id> start --sub). 어떤 도구에서든 된다
 *   - 훅이 방금 알려 줬다 (서브에이전트를 알려 주는 도구)
 *   - 서브에이전트가 맡은 노드의 상태를 적는다
 * 서브에이전트의 명령은 부모 세션이 붙은 작업을 바꾸지 않고, 부모에게 갈 말(바뀐 지침)을 받지 않는다
 */
export function fromSubagent(dir: string, work: string, id: string, key: string | null, sub = false): boolean {
  if (sub || startingAgent(dir, key, id)) return true;
  const by = readPlan(dir, work)?.nodes.find(n => n.id === id)?.by;
  return Boolean(by?.agent && by.session === key);
}

/**
 * 노드의 상태를 바꾸고 사건 기록에 한 줄 남긴다. 작업이나 노드가 없으면 null.
 * 순서는 보지 않는다. 앞 노드가 끝나지 않아도 시작할 수 있다.
 *
 * 회차: 처음 시작하거나, 끝냈거나 막혔던 노드를 다시 시작하면 새 회차다.
 * 기다리다 이어 하거나, 잠시 멈췄다(pause) 다시 하거나, 하는 중에 다른 쪽이 이어받는 것은 같은 회차다.
 */
/**
 * 앞 노드가 끝나기 전에 시작한 노드에 붙일 말 (막지는 않는다).
 * 앞 노드를 하고 있으면 그래프는 계획대로 그 노드 다음에 그리고 "순서 앞당김"으로 보이므로, 같이 하는 거면 계획에서 나란히 두라고 알린다
 * (나란히 = 안 끝난 앞 노드 대신 그 노드의 앞 노드들 뒤). 앞 노드를 아직 하고 있지 않으면(시작 전·잠시 멈춤·응답 대기·막힘) 그래프는 이미
 * 그 노드를 건너뛰어 실제로 한 순서대로 그리므로(flow.ts) 계획을 고칠 필요는 없다
 */
export function earlyStart(nodes: PlanNode[], id: string): string | null {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const node = byId.get(id);
  if (!node) return null;
  const open = openBefore(nodes, id);
  if (!open.length) return null;
  const running = open.filter(p => byId.get(p)!.status === 'doing');
  const idle = open.filter(p => !running.includes(p));
  const side = [...new Set([...(node.after ?? []).filter(p => byId.has(p) && !running.includes(p)), ...running.flatMap(p => byId.get(p)!.after ?? [])])];
  const lines: string[] = [];
  if (running.length) {
    const names = running.join(', ');
    lines.push(
      `앞 노드 ${names}를 아직 하고 있어요. 그래프에는 계획대로 ${names} 다음에 그려지고 "순서 앞당김"으로 보여요.`,
      `같이 하는 거면 계획에서 나란히 두세요: muwi show로 지금 계획을 보고 ${id}의 after를 ${side.length ? `[${side.map(s => `"${s}"`).join(', ')}]` : '빈 목록(맨 앞)'}으로 바꿔 muwi plan --why "<같이 하는 이유>" '<계획 JSON>'으로 다시 적어요.`,
    );
  }
  if (idle.length) lines.push(`앞 노드 ${idle.join(', ')}를 아직 하고 있지 않아요(시작 전·잠시 멈춤·응답 대기·막힘). 그래프에는 그 노드를 건너뛰어 실제로 한 순서대로 그려져요.`);
  lines.push(`순서대로 하려던 거면 muwi node ${id} pause로 멈추고 ${open.join(', ')}를 먼저 끝내요.`);
  return lines.join('\n');
}

/** 계획에서 이 노드보다 먼저 하는 노드 중 아직 끝나지 않은 것 */
function openBefore(nodes: PlanNode[], id: string): string[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return (byId.get(id)?.after ?? []).filter(p => byId.has(p) && byId.get(p)!.status !== 'done');
}

/**
 * 시작한 것이 계획과 다른 점들. 막지 않는다. 판단의 근거(--why)를 남기라고 알릴 때 쓴다.
 * nodes: 시작한 뒤의 계획, was: 시작하기 전 그 노드의 상태, sub: 서브에이전트가 시작했다
 *   다시 하기: 끝냈거나 막혔던 노드를 다시 시작했다 (새 회차)
 *   순서: 계획의 앞 노드가 끝나기 전에 시작했다
 *   맡는 쪽: 계획(run)은 서브에이전트인데 서브에이전트가 아닌 쪽이, 또는 직접인데 서브에이전트가 시작했다
 */
export function offPlanStart(nodes: PlanNode[], id: string, was: NodeStatus | undefined, sub: boolean): string[] {
  const node = nodes.find(n => n.id === id);
  if (!node) return [];
  const out: string[] = [];
  if (was === 'done' || was === 'blocked') out.push(`${was === 'done' ? '끝낸' : '막혔던'} 노드를 ${node.attempt ?? 2}회차로 다시 함`);
  const open = openBefore(nodes, id);
  if (open.length) out.push(`${open.join(', ')}가 아직 안 끝남`);
  if (node.run === 'subagent' && !sub) out.push('계획은 서브에이전트인데 이 세션이 시작함');
  if (node.run === 'me' && sub) out.push('계획은 직접인데 서브에이전트가 시작함');
  return out;
}

export function markNode(dir: string, work: string, id: string, status: NodeStatus, note: string | undefined, key: string | null, env: NodeJS.ProcessEnv = process.env, o: { sub?: boolean; why?: string } = {}): Plan | null {
  // 서브에이전트가 시작하는 것이면 훅이 방금 그 서브에이전트를 적어 뒀다 (명령에서는 세션 id가 같아 구분할 수 없다).
  // 훅이 알려 주지 않는 도구에서는 서브에이전트가 스스로 밝힌다 (--sub). 그때는 이름을 지어 준다
  const session = key ? readSession(dir, key) : null;
  const pending = status === 'doing' ? session?.starting?.[id] : undefined;
  const hooked = status === 'doing' ? startingAgent(dir, key, id) : undefined;
  const declared = status === 'doing' && o.sub && !hooked;

  const plan = withLock(workDir(dir, work), () => {
    const plan = readPlan(dir, work);
    const node = plan?.nodes.find(n => n.id === id);
    if (!plan || !node) return null;
    const at = nowIso();
    const before = node.status;
    // 스스로 밝힌 서브에이전트가 같은 노드를 이어 시작하면(기다리다 다시 등) 앞에서 지은 이름을 그대로 쓴다
    const agent = hooked ?? (declared ? (node.by?.session === key && node.by.agent?.startsWith('sub-') ? node.by.agent : `sub-${crypto.randomBytes(4).toString('hex')}`) : undefined);
    const same = before === status && (node.note ?? undefined) === (status === 'doing' ? undefined : note);
    node.status = status;
    if (status === 'doing' || status === 'todo') delete node.note;
    else if (note) node.note = note;
    else delete node.note;
    if (status === 'doing') {
      // 기다리다 이어 하거나, 잠시 멈췄던 노드(시작한 적이 있는데 아직으로 돌아간 노드)를 다시 하는 것은 같은 회차다
      const resume = before === 'waiting' || before === 'doing' || (before === 'todo' && (node.attempt ?? 0) > 0);
      // 시작을 적지 않고 끝냈거나 막혔던 노드는 회차가 적혀 있지 않지만 한 번 한 것이다 (그 기록은 1회차로 읽는다). 다시 하면 2회차다
      const done = node.attempt ?? (before === 'done' || before === 'blocked' ? 1 : 0);
      node.attempt = resume ? (node.attempt ?? 1) : done + 1;
      node.by = { session: key, ...(agent ? { agent } : {}), at };
    } else delete node.by;
    plan.updatedAt = at;
    writePlan(dir, plan);
    // 같은 상태를 다시 적어도 사건은 남긴다. 다른 쪽이 이어받은 것일 수 있고, 판단의 근거(why)를 덧붙인 것일 수 있다
    if (!same || status === 'doing' || o.why) {
      appendEvent(dir, work, {
        type: 'node', node: id, status,
        ...(node.note ? { note: node.note } : {}),
        ...(node.attempt ? { attempt: node.attempt } : {}),
        ...(o.why ? { why: o.why } : {}),
        // 시작할 때의 모델을 노드에 적어 둔다. 세션이 도중에 모델을 바꿔도 앞에서 한 노드의 기록은 그대로 남는다.
        // 서브에이전트는 세션과 다른 모델을 쓸 수 있어서 세션의 모델로 적지 않는다
        ...(status === 'doing' ? { ...(agent ? { agent } : {}), ...(declared ? { declared: true } : {}), seen: Boolean(session?.hooked), ...(!agent && session?.model ? { model: session.model } : {}) } : {}),
      }, key, at);
    }
    return plan;
  });

  // 서브에이전트가 직접 시작했으면 그 서브에이전트의 노드로 적어 둔다. 그 뒤에 읽는 skill이 이 노드에 붙는다
  if (plan && key && pending) {
    const starting = { ...(session?.starting ?? {}) };
    delete starting[id];
    const node = plan.nodes.find(n => n.id === id);
    const agents = hooked && node ? { ...(session?.agents ?? {}), [hooked]: { work, node: id, attempt: node.attempt ?? 1, own: true } } : session?.agents;
    touchSession(dir, key, { starting, ...(agents ? { agents } : {}) }, env);
  }
  return plan;
}
