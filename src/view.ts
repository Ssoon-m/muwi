// 계획과 사건 기록을 합쳐 보여 줄 모양을 만든다 (그래프 화면, muwi show, 문제 진단이 모두 이걸 읽는다).
//   노드마다: 회차별로 누가 했는지, 얼마나 걸렸는지, 하는 동안 읽은 skill
//   작업마다: 계획이 바뀐 이유들, 빠진 노드, 문제 표시, 노드 밖에서 읽은 skill
// 사건에는 어느 노드의 몇 번째 회차인지가 적혀 있다. 여기서는 적힌 대로 모으기만 한다.
// 시각을 맞춰 보며 짐작하지 않는다. 확실하지 않게 적힌 것(guess)과 관찰하지 못한 것(seen: false)은 그대로 드러낸다.
import type { Event, NodeStatus, Plan, PlanNode, ShowIn } from './store.ts';
import { clock, listWorks, readEvents, readPlan } from './store.ts';
import { closedSessions } from './live.ts';
import { readSession, sessionLabel } from './session.ts';

export type SkillUse = {
  skill: string;
  /** read: 이 회차를 하는 동안 읽었다. loaded: 이 회차를 한 세션이 그 전에 읽어서 내용을 갖고 있다 */
  state: 'read' | 'loaded';
  /** 이 회차에서 읽은 횟수 (loaded면 0) */
  count: number;
  /** tool: Skill 도구로 불렀다. file: SKILL.md 파일을 직접 열었다 */
  via: 'tool' | 'file';
  /** 서브에이전트만 읽었다. 그 내용은 서브에이전트가 끝나면 세션에 남지 않는다 */
  agent?: boolean;
  /** 읽을 때 같은 쪽이 노드 여러 개를 하고 있어서, 이 노드의 것인지 확실하지 않다 */
  guess?: boolean;
};

/** 회차를 한 쪽. 기록에 적힌 것이다 */
export type Actor = {
  /** me: 대화가 직접 했다. session: muwi run으로 뜬 새 세션이 했다. subagent: 서브에이전트가 했다 */
  kind: 'me' | 'session' | 'subagent';
  session?: string;
  /** 이 회차에 있었던 서브에이전트. own: 노드를 직접 시작했다. 아니면 그 세션이 이 노드를 하는 동안 떠서 도왔다 */
  agents: { id: string; kind?: string; own?: boolean }[];
};

/** 노드를 한 번 한 것. 끝냈거나 막혔던 노드를 다시 시작하면 다음 회차가 된다 */
export type Try = {
  n: number;
  startedAt?: string;
  endedAt?: string;
  /** 작업 중이던 시간 (ms). 사람을 기다린 시간은 넣지 않는다 */
  spentMs: number;
  /** 이 회차의 마지막 상태와 그때 남긴 한 줄 */
  status: NodeStatus;
  note?: string;
  who?: Actor;
  skills: SkillUse[];
  /** 훅이 이 회차를 한 세션을 보고 있었나. false면 읽은 skill을 관찰하지 못한 것이다 ("없음"이 아니라 "모름") */
  seen: boolean;
  /** 시작을 적지 않았거나 시작과 끝을 한꺼번에 적었다. 하는 동안의 기록이 없다 */
  instant: boolean;
};

export type Spawn = { at: string; terminal: string; name?: string; show?: ShowIn; /** 그 세션에 맡긴 말 */ task?: string };

/** 노드. who·skills·seen·instant는 가장 최근 회차의 것이고, 회차별 기록은 tries에 있다 */
export type NodeView = PlanNode & {
  /** 몇 번째 하는 중인가. 끝낸 노드를 다시 시작하면 올라간다 */
  attempts: number;
  tries: Try[];
  startedAt?: string;
  endedAt?: string;
  /** 작업 중이던 시간의 합 (ms). 사람을 기다린 시간은 넣지 않는다 */
  spentMs: number;
  /** 지금 상태가 된 시각 */
  since?: string;
  /** 마지막으로 이 노드를 한 세션 */
  session?: string;
  who?: Actor;
  /** 끝난 노드가 계획에 적은 것(run)과 다르게 진행됐다 */
  offPlan?: boolean;
  seen: boolean;
  instant: boolean;
  /** 끝나지 않았는데 이 노드를 하던 세션이 닫혔다. 하다가 멈춘 것이다 (끝났는지는 알 수 없다) */
  closed?: boolean;
  /** 이 노드를 맡기려고 띄운 새 세션들 (muwi run). spawn은 가장 최근 것 */
  spawn?: Spawn;
  spawns: Spawn[];
  skills: SkillUse[];
  flags: { at: string; text: string }[];
};

export type Change = { at: string; by: 'ai' | 'human'; why?: string; first: boolean; added: string[]; removed: string[]; changed: string[] };
/** stalled: 끝나지 않은 노드가 있는데 그 노드를 하던 세션이 모두 닫혔다 */
export type WorkState = 'waiting' | 'blocked' | 'doing' | 'stalled' | 'done' | 'idle';

export type SessionInfo = { label: string; tool: string; terminal?: string; herdrPane?: string; /** 이 세션이 마지막으로 무언가를 적은 시각 */ seenAt?: string };

export type WorkView = {
  work: string;
  title?: string;
  request?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  /** waiting: 사람을 기다리는 노드가 있다 > blocked: 막힌 노드가 있다 > doing > stalled: 하던 세션이 닫혀 멈췄다 > done: 모두 끝 > idle: 노드 사이 */
  state: WorkState;
  nodes: NodeView[];
  edges: { from: string; to: string }[];
  changes: Change[];
  /** 계획에서 빠진 노드. 빠진 뒤에도 무엇이었는지 볼 수 있게 남긴다 */
  gone: { at: string; id: string; title: string; status: NodeStatus; why?: string }[];
  flags: { at: string; node?: string; text: string }[];
  /** 어느 노드도 하고 있지 않을 때 읽은 skill (계획을 짜는 동안 등) */
  outside: { at: string; session: string | null; skill: string; via: 'tool' | 'file'; agent?: boolean }[];
  /** 대화가 요약된 시각들 */
  compacts: { at: string; session: string | null }[];
  sessions: Record<string, SessionInfo>;
  /** 계획을 처음 낸 세션 */
  lead: string | null;
  /** 같이 일한 새 세션(muwi run으로 뜬 것)과 서브에이전트의 수 */
  helpers: { sessions: number; subagents: number };
  counts: Record<NodeStatus, number> & { total: number };
};

type Doer = { session: string | null; agent?: string };
type Draft = {
  n: number;
  startedAt?: string;
  endedAt?: string;
  spent: number;
  openFrom: number | null;
  status: NodeStatus;
  note?: string;
  /** 이 회차를 시작한 쪽들. 마지막이 지금(또는 끝까지) 한 쪽이다 */
  doers: Doer[];
  /** 시작을 적지 않고 끝낸 회차는 끝낸 세션이 한 것으로 본다 */
  closer?: string;
  seen: boolean;
  /** main: 세션이 직접 읽은 적이 있다. sure: 확실하게 이 노드의 것으로 적힌 읽기가 있다 */
  reads: Map<string, { count: number; via: 'tool' | 'file'; main: boolean; sure: boolean }>;
  helpers: Set<string>;
};

const ms = (iso: string) => Date.parse(iso);
/** 시작과 끝 사이가 이보다 짧고 그 사이에 적힌 것이 없으면 "한꺼번에 적었다"고 본다 */
const INSTANT_MS = 3000;

/**
 * closed: 닫힌 세션과 그 세션을 마지막으로 본 시각 (live.ts). 주지 않으면 모두 살아 있는 것으로 본다.
 */
export function buildView(plan: Plan, events: Event[], sessions: Record<string, SessionInfo> = {}, now: number = clock.now().getTime(), closed: Map<string, number> = new Map()): WorkView {
  const byId = new Map(plan.nodes.map(n => [n.id, n]));
  const drafts = new Map<string, Draft[]>();
  const since = new Map<string, string>();
  const prev = new Map<string, NodeStatus>();
  /** 서브에이전트의 종류 (Explore 등) */
  const kinds = new Map<string, string>();
  const seenAgents = new Set<string>();
  /** 노드를 직접 시작한 서브에이전트 */
  const owners = new Set<string>();
  /** muwi run으로 떠서 맡은 노드에 붙은 세션 */
  const joined = new Set<string>();
  const spawns = new Map<string, Spawn[]>();
  const outside: WorkView['outside'] = [];
  const skillEvents = events.filter((e): e is Event & { type: 'skill' } => e.type === 'skill');

  const find = (node?: string, n?: number) => (node && n ? drafts.get(node)?.find(d => d.n === n) : undefined);

  for (const e of events) {
    if (e.type === 'node') {
      if (!byId.has(e.node)) continue;
      const list = drafts.get(e.node) ?? [];
      drafts.set(e.node, list);
      const n = e.attempt ?? list[list.length - 1]?.n ?? 1;
      let d = list.find(x => x.n === n);
      if (!d) {
        d = { n, spent: 0, openFrom: null, status: e.status, doers: [], seen: false, reads: new Map(), helpers: new Set() };
        list.push(d);
        list.sort((a, b) => a.n - b.n);
      }
      if ((prev.get(e.node) ?? 'todo') !== e.status) since.set(e.node, e.at);
      prev.set(e.node, e.status);
      d.status = e.status;
      if (e.note) d.note = e.note;
      else if (e.status === 'doing' || e.status === 'todo') delete d.note;
      if (e.status === 'doing') {
        d.startedAt ??= e.at;
        delete d.endedAt;
        if (d.openFrom === null) d.openFrom = ms(e.at);
        const last = d.doers[d.doers.length - 1];
        if (!last || last.session !== e.session || last.agent !== e.agent) d.doers.push({ session: e.session, ...(e.agent ? { agent: e.agent } : {}) });
        if (e.agent) {
          owners.add(e.agent);
          seenAgents.add(e.agent);
        }
        d.seen = Boolean(e.seen);
      } else {
        if (d.openFrom !== null) {
          d.spent += Math.max(0, ms(e.at) - d.openFrom);
          d.openFrom = null;
        }
        if (e.status === 'done' || e.status === 'blocked') d.endedAt = e.at;
        if (e.session) d.closer = e.session;
      }
    } else if (e.type === 'skill') {
      if (e.carried) continue;
      const d = find(e.node, e.attempt);
      if (!d) {
        outside.push({ at: e.at, session: e.session, skill: e.skill, via: e.via, ...(e.agent ? { agent: true } : {}) });
        continue;
      }
      const cur = d.reads.get(e.skill);
      d.reads.set(e.skill, {
        count: (cur?.count ?? 0) + 1,
        via: cur?.via === 'tool' ? 'tool' : e.via,
        main: Boolean(cur?.main) || !e.agent,
        sure: Boolean(cur?.sure) || !e.guess,
      });
    } else if (e.type === 'agent') {
      seenAgents.add(e.agent);
      if (e.kind) kinds.set(e.agent, e.kind);
      if (e.what === 'start') find(e.node, e.attempt)?.helpers.add(e.agent);
    } else if (e.type === 'join') {
      if (e.session) joined.add(e.session);
    } else if (e.type === 'spawn') {
      spawns.set(e.node, [...(spawns.get(e.node) ?? []), { at: e.at, terminal: e.terminal, ...(e.name ? { name: e.name } : {}), ...(e.show ? { show: e.show } : {}), ...(e.task ? { task: e.task } : {}) }]);
    }
  }

  /** muwi run으로 뜬 세션인가: 붙은 기록이 있거나, 그 노드를 맡기려고 띄운 터미널에서 도는 세션이다 */
  const spawnedFor = (session: string | null | undefined, node: string) => {
    if (!session) return false;
    if (joined.has(session)) return true;
    const terminal = sessions[session]?.terminal;
    return Boolean(terminal && (spawns.get(node) ?? []).some(s => s.terminal === terminal));
  };

  const flags = events.filter((e): e is Event & { type: 'flag' } => e.type === 'flag');

  const nodes: NodeView[] = plan.nodes.map(n => {
    const list = drafts.get(n.id) ?? [];
    const tries: Try[] = list.map((d, i) => {
      // 계획에서 작업 중이 아닌 노드는 열린 구간이 남아 있어도 닫는다 (기록이 한 줄 빠졌을 때)
      const running = d.openFrom !== null && n.status === 'doing' && i === list.length - 1;
      const owner: Doer | undefined = d.doers[d.doers.length - 1] ?? (d.closer ? { session: d.closer } : undefined);
      // 하던 세션이 닫혔으면 시간은 그 세션을 마지막으로 본 때까지만 센다. 닫힌 뒤로도 계속 늘어나지 않게
      const until = running && owner?.session && closed.has(owner.session) ? Math.min(now, Math.max(d.openFrom!, closed.get(owner.session)!)) : now;
      const spentMs = d.spent + (running ? Math.max(0, until - d.openFrom!) : 0);
      const own = [...new Set(d.doers.map(x => x.agent).filter((x): x is string => Boolean(x)))];
      const helped = [...d.helpers].filter(id => !owners.has(id));
      let who: Actor | undefined;
      if (owner) {
        // 서브에이전트가 직접 시작했으면 서브에이전트의 것. 세션이 시작해 놓고 서브에이전트를 띄운 경우는,
        // 계획에 서브에이전트로 하기로 적어 둔 노드일 때만 서브에이전트가 한 것으로 본다. 그 밖에는 도운 것이다
        const kind: Actor['kind'] =
          owner.agent ? 'subagent'
          : spawnedFor(owner.session, n.id) ? 'session'
          : n.run === 'subagent' && helped.length ? 'subagent'
          : 'me';
        who = {
          kind,
          ...(owner.session ? { session: owner.session } : {}),
          agents: [
            ...own.map(id => ({ id, ...(kinds.get(id) ? { kind: kinds.get(id) } : {}), own: true })),
            ...helped.map(id => ({ id, ...(kinds.get(id) ? { kind: kinds.get(id) } : {}) })),
          ],
        };
      }
      // 이 회차를 한 세션이 시작하기 전에 읽어 둔 skill. 서브에이전트는 빈 상태에서 시작하므로 붙이지 않고,
      // 서브에이전트가 읽은 것은 세션이 읽어 둔 것으로 치지 않는다
      const loaded = new Map<string, 'tool' | 'file'>();
      const from = d.startedAt ?? d.endedAt;
      if (owner?.session && who?.kind !== 'subagent' && from) {
        for (const e of skillEvents) {
          if (e.agent || e.session !== owner.session || ms(e.at) >= ms(from)) continue;
          if (!d.reads.get(e.skill)?.main && !loaded.has(e.skill)) loaded.set(e.skill, e.via);
        }
      }
      const skills: SkillUse[] = [
        ...[...d.reads].map(([skill, r]) => ({ skill, state: 'read' as const, count: r.count, via: r.via, ...(r.main ? {} : { agent: true }), ...(r.sure ? {} : { guess: true }) })),
        ...[...loaded].filter(([skill]) => !d.reads.has(skill)).map(([skill, via]) => ({ skill, state: 'loaded' as const, count: 0, via })),
      ];
      const quick = Boolean(d.startedAt && d.endedAt && ms(d.endedAt) - ms(d.startedAt) < INSTANT_MS && d.reads.size === 0 && d.helpers.size === 0);
      return {
        n: d.n,
        ...(d.startedAt ? { startedAt: d.startedAt } : {}),
        ...(d.endedAt ? { endedAt: d.endedAt } : {}),
        spentMs,
        status: d.status,
        ...(d.note ? { note: d.note } : {}),
        ...(who ? { who } : {}),
        skills,
        seen: d.seen || d.reads.size > 0,
        instant: !d.startedAt || quick,
      };
    });
    const last = tries[tries.length - 1];
    const mine = spawns.get(n.id) ?? [];
    const view: NodeView = {
      ...n,
      attempts: n.attempt ?? last?.n ?? 0,
      tries,
      spentMs: tries.reduce((sum, t) => sum + t.spentMs, 0),
      seen: last?.seen ?? false,
      instant: last?.instant ?? false,
      spawns: mine,
      skills: last?.skills ?? [],
      flags: flags.filter(f => f.node === n.id).map(f => ({ at: f.at, text: f.text })),
    };
    const started = tries.find(t => t.startedAt)?.startedAt;
    const changedAt = since.get(n.id);
    if (started) view.startedAt = started;
    if (last?.endedAt && n.status === 'done') view.endedAt = last.endedAt;
    if (changedAt) view.since = changedAt;
    if (last?.who?.session) view.session = last.who.session;
    if (last?.who) view.who = last.who;
    // 계획과 달랐는지는 끝난 뒤에만 본다. 하는 중에는 서브에이전트가 아직 뜨지 않았을 수 있다
    if (n.run && last?.who && n.status === 'done' && n.run !== last.who.kind) view.offPlan = true;
    if ((n.status === 'doing' || n.status === 'waiting' || n.status === 'blocked') && last?.who?.session && closed.has(last.who.session)) view.closed = true;
    if (mine.length) view.spawn = mine[mine.length - 1];
    return view;
  });

  const counts = { total: nodes.length, todo: 0, doing: 0, waiting: 0, blocked: 0, done: 0 };
  for (const n of nodes) counts[n.status] += 1;
  // 작업의 상태는 살아 있는 세션이 하는 노드로 정한다. 닫힌 세션이 남긴 "나를 기다림"이 목록 맨 위에 붙어 있지 않게
  const alive = (status: NodeStatus) => nodes.some(n => n.status === status && !n.closed);
  const state: WorkState =
    alive('waiting') ? 'waiting'
    : alive('blocked') ? 'blocked'
    : alive('doing') ? 'doing'
    : nodes.some(n => n.closed) ? 'stalled'
    : counts.total > 0 && counts.done === counts.total ? 'done'
    : 'idle';

  const planEvents = events.filter((e): e is Event & { type: 'plan' } => e.type === 'plan');
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
    edges: plan.nodes.flatMap(n => n.after.filter(a => byId.has(a)).map(a => ({ from: a, to: n.id }))),
    changes: planEvents.map(e => ({ at: e.at, by: e.by, why: e.why, first: Boolean(e.first), added: e.added, removed: e.removed, changed: e.changed })),
    // 같은 id로 다시 넣은 노드는 빠진 것으로 치지 않는다
    gone: planEvents.flatMap(e => (e.gone ?? []).filter(g => !byId.has(g.id)).map(g => ({ at: e.at, id: g.id, title: g.title, status: g.status, ...(e.why ? { why: e.why } : {}) }))),
    flags: flags.map(f => ({ at: f.at, node: f.node, text: f.text })),
    outside,
    compacts: events.filter(e => e.type === 'session').map(e => ({ at: e.at, session: e.session })),
    sessions,
    lead: planEvents[0]?.session ?? null,
    helpers: {
      sessions: new Set(nodes.flatMap(n => n.tries).map(t => (t.who?.kind === 'session' ? t.who.session : undefined)).filter(Boolean)).size,
      subagents: seenAgents.size,
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
    out[key] = { label: sessionLabel(s, key), tool: s?.tool ?? 'unknown', ...(s?.terminal ? { terminal: s.terminal } : {}), ...(s?.herdrPane ? { herdrPane: s.herdrPane } : {}), ...(s?.seenAt ? { seenAt: s.seenAt } : {}) };
  }
  return out;
}

export function loadView(dir: string, work: string, env: NodeJS.ProcessEnv = process.env): WorkView | null {
  const plan = readPlan(dir, work);
  if (!plan) return null;
  const events = readEvents(dir, work);
  const sessions = sessionsOf(dir, events);
  // 끝나지 않은 노드가 있을 때만 Herdr에 물어본다. 다 끝난 작업은 물어볼 것이 없다
  const open = plan.nodes.some(n => n.status === 'doing' || n.status === 'waiting' || n.status === 'blocked');
  const closed = open ? closedSessions(sessions, Object.keys(sessions), env) : new Map<string, number>();
  return buildView(plan, events, sessions, clock.now().getTime(), closed);
}

const ORDER: Record<WorkState, number> = { waiting: 0, blocked: 1, doing: 2, stalled: 3, idle: 4, done: 5 };
/** 이만큼 지나도록 바뀐 것이 없으면 "지난 작업"으로 접는다. 지우지는 않는다 */
export const PAST_DAYS = 7;

export type WorkSummary = Pick<WorkView, 'work' | 'title' | 'request' | 'state' | 'updatedAt' | 'counts'> & {
  /** 지금 눈여겨볼 노드들: 사람을 기다리는 것, 막힌 것, 하는 중인 것. closed: 그 노드를 하던 세션이 닫혔다 */
  active: { id: string; title: string; status: NodeStatus; note?: string; closed?: boolean }[];
  /** 지난 작업: 끝났거나 멈춘 채로 오래됐다. 목록에서 접어 둔다 */
  past: boolean;
};

/** 모든 작업을 급한 순서로: 나를 기다림 → 막힘 → 작업 중 → 멈춤 → 노드 사이 → 끝. 같은 상태면 최근 것이 위 */
export function loadBoard(dir: string, env: NodeJS.ProcessEnv = process.env): { works: WorkSummary[]; errors: { work: string; message: string }[] } {
  const works: WorkSummary[] = [];
  const errors: { work: string; message: string }[] = [];
  const now = clock.now().getTime();
  for (const work of listWorks(dir)) {
    try {
      const v = loadView(dir, work, env);
      if (!v) continue;
      // 살아 있는 세션이 하고 있는 작업은 오래돼도 접지 않는다
      const quiet = v.state === 'done' || v.state === 'stalled' || v.state === 'idle';
      works.push({
        work: v.work,
        title: v.title,
        request: v.request,
        state: v.state,
        updatedAt: v.updatedAt,
        counts: v.counts,
        active: v.nodes
          .filter(n => n.status === 'waiting' || n.status === 'blocked' || n.status === 'doing')
          .map(n => ({ id: n.id, title: n.title, status: n.status, ...(n.note ? { note: n.note } : {}), ...(n.closed ? { closed: true } : {}) })),
        past: quiet && now - Date.parse(v.updatedAt) > PAST_DAYS * 86_400_000,
      });
    } catch (e: any) {
      errors.push({ work, message: e?.message ?? String(e) });
    }
  }
  works.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { works, errors };
}
