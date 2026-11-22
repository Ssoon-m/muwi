// 계획과 사건 기록을 합쳐 보여 줄 모양을 만든다 (그래프 화면, muwi show, 문제 진단이 모두 이걸 읽는다).
//   노드마다: 몇 번째 하는 중인지, 얼마나 걸렸는지, 누가(계획을 낸 세션, 새 세션, 서브에이전트) 했는지, 하는 동안 읽은 skill
//   작업마다: 계획이 바뀐 이유들, 문제 표시, 노드 밖에서 읽은 skill
import type { Event, NodeStatus, Plan, PlanNode, ShowIn } from './store.ts';
import { clock, listWorks, readEvents, readPlan } from './store.ts';
import { readSession, sessionLabel } from './session.ts';

export type SkillUse = {
  skill: string;
  /** read: 이 노드를 하는 동안 읽었다. loaded: 같은 세션이 그 전에 읽어서 내용을 갖고 있다 */
  state: 'read' | 'loaded';
  /** 이 노드에서 읽은 횟수 (loaded면 0) */
  count: number;
  /** tool: Skill 도구로 불렀다. file: SKILL.md 파일을 직접 열었다 */
  via: 'tool' | 'file';
  /** 서브에이전트만 읽었다. 그 내용은 서브에이전트가 끝나면 맡긴 세션에 남지 않는다 */
  agent?: boolean;
};

/** 노드를 실제로 한 쪽. 기록에서 본 것이지 계획에 적은 것이 아니다 */
export type Actor = {
  /** me: 계획을 낸 세션이 직접. session: 다른 세션. subagent: 서브에이전트 */
  kind: 'me' | 'session' | 'subagent';
  session?: string;
  agents: { id: string; kind?: string }[];
};

export type NodeView = PlanNode & {
  /** 몇 번째 하는 중인가. 끝낸 노드를 다시 시작하면 올라간다 */
  attempts: number;
  startedAt?: string;
  endedAt?: string;
  /** 작업 중이던 시간의 합 (ms). 사람을 기다린 시간은 넣지 않는다 */
  spentMs: number;
  /** 지금 상태가 된 시각 */
  since?: string;
  /** 마지막으로 이 노드를 한 세션 */
  session?: string;
  /** 실제로 누가 했나. 시작한 적이 없으면 없다 */
  who?: Actor;
  /** 끝난 노드가 계획에 적은 것(run)과 다르게 진행됐다 */
  offPlan?: boolean;
  /** 이 노드를 맡기려고 띄운 새 세션 (muwi run) */
  spawn?: { at: string; terminal: string; name?: string; show?: ShowIn };
  skills: SkillUse[];
  flags: { at: string; text: string }[];
};

export type Change = { at: string; by: 'ai' | 'human'; why?: string; first: boolean; added: string[]; removed: string[]; changed: string[] };
export type WorkState = 'waiting' | 'blocked' | 'doing' | 'done' | 'idle';

export type SessionInfo = { label: string; tool: string; terminal?: string; herdrPane?: string };

export type WorkView = {
  work: string;
  title?: string;
  request?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  /** waiting: 사람을 기다리는 노드가 있다 > blocked: 막힌 노드가 있다 > doing > done: 모두 끝 > idle: 노드 사이 */
  state: WorkState;
  nodes: NodeView[];
  edges: { from: string; to: string }[];
  changes: Change[];
  flags: { at: string; node?: string; text: string }[];
  /** 어느 노드도 하고 있지 않을 때 읽은 skill (계획을 짜는 동안 등) */
  outside: { at: string; session: string | null; skill: string; via: 'tool' | 'file'; agent?: boolean }[];
  /** 대화가 요약된 시각들 */
  compacts: { at: string; session: string | null }[];
  sessions: Record<string, SessionInfo>;
  /** 계획을 낸 세션 */
  lead: string | null;
  /** 같이 일한 새 세션과 서브에이전트의 수 */
  helpers: { sessions: number; subagents: number };
  counts: Record<NodeStatus, number> & { total: number };
};

type Interval = { session: string | null; from: number; to: number; open: boolean };

const ms = (iso: string) => Date.parse(iso);

export function buildView(plan: Plan, events: Event[], sessions: Record<string, SessionInfo> = {}, now: number = clock.now().getTime()): WorkView {
  const ids = new Set(plan.nodes.map(n => n.id));
  const intervals = new Map<string, Interval[]>();
  const attempts = new Map<string, number>();
  const firstStart = new Map<string, string>();
  const lastEnd = new Map<string, string>();
  const since = new Map<string, string>();
  const lastSession = new Map<string, string>();
  /** 시작을 적지 않고 끝낸 노드는 끝낸 세션이 한 것으로 본다 */
  const closedBy = new Map<string, string>();
  const prev = new Map<string, NodeStatus>();

  for (const e of events) {
    if (e.type !== 'node') continue;
    const list = intervals.get(e.node) ?? [];
    intervals.set(e.node, list);
    const open = list[list.length - 1]?.open ? list[list.length - 1] : null;
    const before = prev.get(e.node) ?? 'todo';
    if (before !== e.status) since.set(e.node, e.at);
    if (e.status === 'doing') {
      if (!open) {
        list.push({ session: e.session, from: ms(e.at), to: now, open: true });
        // 기다리다 이어 하는 것은 같은 회차다. 처음이거나, 끝냈거나 막혔던 걸 다시 하면 새 회차
        if (before !== 'waiting') attempts.set(e.node, (attempts.get(e.node) ?? 0) + 1);
        if (!firstStart.has(e.node)) firstStart.set(e.node, e.at);
      } else if (e.session && open.session !== e.session) {
        // 다른 세션이 이어받았다
        open.to = ms(e.at);
        open.open = false;
        list.push({ session: e.session, from: ms(e.at), to: now, open: true });
      }
      if (e.session) lastSession.set(e.node, e.session);
      lastEnd.delete(e.node);
    } else {
      if (open) {
        open.to = ms(e.at);
        open.open = false;
      }
      if (e.status === 'done') lastEnd.set(e.node, e.at);
      if (e.session && e.status !== 'todo') closedBy.set(e.node, e.session);
    }
    prev.set(e.node, e.status);
  }
  // 계획에서 끝난 걸로 적힌 노드는 열린 구간이 남아 있어도 닫는다 (기록이 한 줄 빠졌을 때)
  for (const n of plan.nodes) {
    if (n.status === 'doing') continue;
    for (const iv of intervals.get(n.id) ?? []) if (iv.open) iv.open = false;
  }

  const lead = events.find(e => e.type === 'plan')?.session ?? null;
  const planned = new Map(plan.nodes.map(n => [n.id, n.run]));

  // 서브에이전트가 어느 노드를 했는지 찾는다.
  //   서브에이전트가 노드를 직접 시작했으면(bind) 그 노드.
  //   아니면 띄운 세션이 그때 하고 있던 노드: 서브에이전트로 하기로 한 노드 > 아직 서브에이전트가 붙지 않은 노드 > 가장 늦게 시작한 노드
  type Sub = { id: string; kind?: string; node?: string };
  const subs = new Map<string, Sub>();
  const subsOf = new Map<string, string[]>();
  /** 서브에이전트가 직접 시작한 노드. 세션 id가 부모와 같아서 구간만 보면 부모가 한 것처럼 보인다 */
  const startedBySub = new Set<string>();
  const give = (sub: Sub, node: string) => {
    if (sub.node === node) return;
    if (sub.node) subsOf.set(sub.node, (subsOf.get(sub.node) ?? []).filter(id => id !== sub.id));
    sub.node = node;
    subsOf.set(node, [...(subsOf.get(node) ?? []), sub.id]);
  };
  for (const e of events) {
    if (e.type !== 'agent') continue;
    const sub = subs.get(e.agent) ?? { id: e.agent };
    subs.set(e.agent, sub);
    if (e.kind) sub.kind = e.kind;
    if (e.what === 'bind' && e.node && ids.has(e.node)) {
      give(sub, e.node);
      startedBySub.add(e.node);
    }
    else if (e.what === 'start' && !sub.node) {
      const t = ms(e.at);
      let best: { node: string; want: number; load: number; from: number } | null = null;
      for (const [node, list] of intervals) {
        if (!ids.has(node)) continue;
        for (const iv of list) {
          if (iv.session !== e.session || t < iv.from || t > iv.to) continue;
          const c = { node, want: planned.get(node) === 'subagent' ? 1 : 0, load: subsOf.get(node)?.length ?? 0, from: iv.from };
          if (!best || c.want > best.want || (c.want === best.want && (c.load < best.load || (c.load === best.load && c.from > best.from)))) best = c;
        }
      }
      if (best) give(sub, best.node);
    }
  }

  // skill 사건을 노드에 붙인다.
  //   서브에이전트가 읽은 것: 그 서브에이전트가 한 노드.
  //   세션이 읽은 것: 그 세션이 그 시각에 하고 있던 노드. 여러 개면 서브에이전트가 시작한 노드를 빼고 가장 늦게 시작한 노드
  const reads = new Map<string, Map<string, { count: number; via: 'tool' | 'file'; agent: boolean }>>();
  const outside: WorkView['outside'] = [];
  const skillEvents = events.filter((e): e is Event & { type: 'skill' } => e.type === 'skill');
  for (const e of skillEvents) {
    if (e.carried) continue;
    let target: string | null = null;
    if (e.agent) target = subs.get(e.agent)?.node ?? null;
    else {
      const t = ms(e.at);
      let best: { node: string; own: number; from: number } | null = null;
      for (const [node, list] of intervals) {
        if (!ids.has(node)) continue;
        for (const iv of list) {
          if (iv.session !== e.session || t < iv.from || t > iv.to) continue;
          const c = { node, own: startedBySub.has(node) ? 0 : 1, from: iv.from };
          if (!best || c.own > best.own || (c.own === best.own && c.from > best.from)) best = c;
        }
      }
      target = best?.node ?? null;
    }
    if (!target || !ids.has(target)) {
      outside.push({ at: e.at, session: e.session, skill: e.skill, via: e.via, ...(e.agent ? { agent: true } : {}) });
      continue;
    }
    const m = reads.get(target) ?? new Map();
    reads.set(target, m);
    const cur = m.get(e.skill);
    m.set(e.skill, { count: (cur?.count ?? 0) + 1, via: cur?.via === 'tool' ? 'tool' : e.via, agent: (cur ? cur.agent : true) && Boolean(e.agent) });
  }

  const spawns = new Map<string, NonNullable<NodeView['spawn']>>();
  for (const e of events) {
    if (e.type === 'spawn') spawns.set(e.node, { at: e.at, terminal: e.terminal, ...(e.name ? { name: e.name } : {}), ...(e.show ? { show: e.show } : {}) });
  }

  const flags = events.filter((e): e is Event & { type: 'flag' } => e.type === 'flag');

  const nodes: NodeView[] = plan.nodes.map(n => {
    const list = intervals.get(n.id) ?? [];
    const read = reads.get(n.id) ?? new Map<string, { count: number; via: 'tool' | 'file'; agent: boolean }>();
    const session = lastSession.get(n.id) ?? (n.status === 'todo' ? undefined : closedBy.get(n.id));
    const agents = (subsOf.get(n.id) ?? []).map(id => ({ id, ...(subs.get(id)?.kind ? { kind: subs.get(id)!.kind } : {}) }));
    let who: Actor | undefined;
    if (session || agents.length) {
      const kind: Actor['kind'] = session && lead && session !== lead ? 'session' : agents.length ? 'subagent' : 'me';
      who = { kind, ...(session ? { session } : {}), agents };
    }
    // 이 노드를 한 세션이 노드를 시작하기 전에 읽어 둔 skill.
    // 서브에이전트는 빈 상태에서 시작하므로 서브에이전트가 한 노드에는 붙이지 않고, 서브에이전트가 읽은 것도 세지 않는다
    const loaded = new Map<string, 'tool' | 'file'>();
    if (who?.kind !== 'subagent') {
      for (const iv of list) {
        for (const e of skillEvents) {
          if (e.agent || e.session !== iv.session || ms(e.at) >= iv.from) continue;
          if (!read.has(e.skill) && !loaded.has(e.skill)) loaded.set(e.skill, e.via);
        }
      }
    }
    const skills: SkillUse[] = [
      ...[...read].map(([skill, v]) => ({ skill, state: 'read' as const, count: v.count, via: v.via, ...(v.agent ? { agent: true } : {}) })),
      ...[...loaded].map(([skill, via]) => ({ skill, state: 'loaded' as const, count: 0, via })),
    ];
    const view: NodeView = {
      ...n,
      attempts: attempts.get(n.id) ?? 0,
      spentMs: list.reduce((sum, iv) => sum + Math.max(0, (iv.open ? now : iv.to) - iv.from), 0),
      skills,
      flags: flags.filter(f => f.node === n.id).map(f => ({ at: f.at, text: f.text })),
    };
    const started = firstStart.get(n.id);
    const ended = lastEnd.get(n.id);
    const changedAt = since.get(n.id);
    if (started) view.startedAt = started;
    if (ended && n.status === 'done') view.endedAt = ended;
    if (changedAt) view.since = changedAt;
    if (session) view.session = session;
    if (who) view.who = who;
    // 계획과 달랐는지는 끝난 뒤에만 본다. 하는 중에는 서브에이전트가 아직 뜨지 않았을 수 있다
    if (n.run && who && n.status === 'done' && n.run !== who.kind) view.offPlan = true;
    const spawn = spawns.get(n.id);
    if (spawn) view.spawn = spawn;
    return view;
  });

  const counts = { total: nodes.length, todo: 0, doing: 0, waiting: 0, blocked: 0, done: 0 };
  for (const n of nodes) counts[n.status] += 1;
  const state: WorkState =
    counts.waiting ? 'waiting'
    : counts.blocked ? 'blocked'
    : counts.doing ? 'doing'
    : counts.total > 0 && counts.done === counts.total ? 'done'
    : 'idle';

  const lastAt = events.length ? events[events.length - 1].at : plan.updatedAt;
  return {
    work: plan.work,
    title: plan.title,
    request: plan.request,
    cwd: plan.cwd,
    createdAt: plan.createdAt,
    updatedAt: lastAt > plan.updatedAt ? lastAt : plan.updatedAt,
    state,
    nodes,
    edges: plan.nodes.flatMap(n => n.after.filter(a => ids.has(a)).map(a => ({ from: a, to: n.id }))),
    changes: events
      .filter((e): e is Event & { type: 'plan' } => e.type === 'plan')
      .map(e => ({ at: e.at, by: e.by, why: e.why, first: Boolean(e.first), added: e.added, removed: e.removed, changed: e.changed })),
    flags: flags.map(f => ({ at: f.at, node: f.node, text: f.text })),
    outside,
    compacts: events.filter(e => e.type === 'session').map(e => ({ at: e.at, session: e.session })),
    sessions,
    lead,
    helpers: {
      sessions: new Set(nodes.map(n => (n.who?.kind === 'session' ? n.who.session : undefined)).filter(Boolean)).size,
      subagents: subs.size,
    },
    counts,
  };
}

/** 사건 기록에 나온 세션들의 정보를 세션 파일에서 읽는다 */
export function sessionsOf(dir: string, events: Event[]): Record<string, SessionInfo> {
  const out: Record<string, SessionInfo> = {};
  for (const e of events) {
    const key = e.session;
    if (!key || out[key]) continue;
    const s = readSession(dir, key);
    out[key] = { label: sessionLabel(s, key), tool: s?.tool ?? 'unknown', ...(s?.terminal ? { terminal: s.terminal } : {}), ...(s?.herdrPane ? { herdrPane: s.herdrPane } : {}) };
  }
  return out;
}

export function loadView(dir: string, work: string): WorkView | null {
  const plan = readPlan(dir, work);
  if (!plan) return null;
  const events = readEvents(dir, work);
  return buildView(plan, events, sessionsOf(dir, events));
}

const ORDER: Record<WorkState, number> = { waiting: 0, blocked: 1, doing: 2, idle: 3, done: 4 };

export type WorkSummary = Pick<WorkView, 'work' | 'title' | 'request' | 'state' | 'updatedAt' | 'counts'> & {
  /** 지금 눈여겨볼 노드들: 사람을 기다리는 것, 막힌 것, 하는 중인 것 */
  active: { id: string; title: string; status: NodeStatus; note?: string }[];
};

/** 모든 작업을 급한 순서로: 나를 기다림 → 막힘 → 작업 중 → 노드 사이 → 끝. 같은 상태면 최근 것이 위 */
export function loadBoard(dir: string): { works: WorkSummary[]; errors: { work: string; message: string }[] } {
  const works: WorkSummary[] = [];
  const errors: { work: string; message: string }[] = [];
  for (const work of listWorks(dir)) {
    try {
      const v = loadView(dir, work);
      if (!v) continue;
      works.push({
        work: v.work,
        title: v.title,
        request: v.request,
        state: v.state,
        updatedAt: v.updatedAt,
        counts: v.counts,
        active: v.nodes
          .filter(n => n.status === 'waiting' || n.status === 'blocked' || n.status === 'doing')
          .map(n => ({ id: n.id, title: n.title, status: n.status, ...(n.note ? { note: n.note } : {}) })),
      });
    } catch (e: any) {
      errors.push({ work, message: e?.message ?? String(e) });
    }
  }
  works.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { works, errors };
}
