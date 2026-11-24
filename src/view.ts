// 계획과 사건 기록을 합쳐 보여 줄 모양을 만든다 (그래프 화면, muwi show, 문제 진단이 모두 이걸 읽는다).
//   노드마다: 회차별로 누가 했는지, 얼마나 걸렸는지, 하는 동안 읽은 skill
//   작업마다: 계획이 바뀐 이유들, 빠진 노드, 문제 표시, 노드 밖에서 읽은 skill
// 사건에는 어느 노드의 몇 번째 회차인지가 적혀 있다. 여기서는 적힌 대로 모으기만 한다.
// 시각을 맞춰 보며 짐작하지 않는다. 확실하지 않게 적힌 것(guess)과 관찰하지 못한 것(seen: false)은 그대로 드러낸다.
import type { Event, NodeStatus, Plan, PlanNode, ShowIn } from './store.ts';
import { clock, listWorks, readEvents, readPlan, resultsSince } from './store.ts';
import { sessionStates } from './live.ts';
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
  /** 이 회차를 시작할 때 그 세션이 쓰던 모델. 서브에이전트가 한 회차에는 없다 */
  model?: string;
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

export type Spawn = { at: string; terminal: string; name?: string; show?: ShowIn; /** 그 세션에 맡긴 말 */ task?: string; /** 새 세션을 띄운 폴더 */ cwd?: string };

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
  /**
   * 계획에 적은 것과 기록이 다르지만, 그 회차를 훅이 보지 못해서 정말 다르게 했는지 알 수 없다.
   * 훅이 없으면 서브에이전트가 실행한 muwi 명령도 세션이 직접 한 것처럼 적힌다
   */
  runUnknown?: boolean;
  seen: boolean;
  instant: boolean;
  /** 끝나지 않았는데 이 노드를 하던 세션이 닫혔다. 하다가 멈춘 것이다 (끝났는지는 알 수 없다) */
  closed?: boolean;
  /** 시작했다가 잠시 멈췄다 (앞에 먼저 할 노드가 끼어드는 등). 다시 시작하면 같은 회차로 이어진다 */
  paused?: boolean;
  /** 앞 노드가 끝나기 전에 시작했다 (그래프 흐름보다 순서를 앞당겼다) */
  early?: boolean;
  /** 이 노드를 맡기려고 띄운 새 세션들 (muwi run). spawn은 가장 최근 것 */
  spawn?: Spawn;
  spawns: Spawn[];
  skills: SkillUse[];
  flags: { at: string; text: string }[];
};

export type Change = { at: string; by: 'ai' | 'human'; why?: string; first: boolean; added: string[]; removed: string[]; changed: string[] };
/** stalled: 끝나지 않은 노드가 있는데 그 노드를 하던 세션이 모두 닫혔다 */
export type WorkState = 'waiting' | 'blocked' | 'doing' | 'stalled' | 'done';
/**
 * 하는 노드가 없는 작업(앞 노드를 끝내고 다음 노드를 아직 시작하지 않음)에서, 그 작업에 붙어 있는 세션이 하는 일.
 * working: 다음 노드를 준비하고 있다(작업 중), asking: 세션이 입력을 기다린다(응답 대기), stopped: 세션이 노드를 남긴 채 멈췄다(응답 대기),
 * gone: 이 작업을 맡은 세션이 없다(멈춤. 닫혔거나 다른 작업으로 갔다), unknown: 세션이 무얼 하는지 알 수 없다(Herdr 밖. 작업 중으로 본다)
 */
export type Between = 'working' | 'asking' | 'stopped' | 'gone' | 'unknown';
const BETWEEN_STATE: Record<Between, WorkState> = { working: 'doing', asking: 'waiting', stopped: 'waiting', gone: 'stalled', unknown: 'doing' };

export type SessionInfo = {
  label: string;
  tool: string;
  terminal?: string;
  herdrPane?: string;
  /** 이 세션이 마지막으로 무언가를 적은 시각 */
  seenAt?: string;
  /** 이 세션이 일하던 폴더. 세션이 닫혔을 때 이어서 하는 방법을 보여 주는 데 쓴다 */
  cwd?: string;
  /** 그 세션이 쓰는 모델 (도구의 훅이 알려 줄 때) */
  model?: string;
  /** 이 세션이 지금 붙어 있는 작업 */
  work?: string;
  /** Herdr가 알려 준 지금 상태: working(일하는 중), blocked(입력을 기다림), done·idle(멈춰서 다음 말을 기다림). 모르면 없다 */
  status?: string;
};

export type WorkView = {
  work: string;
  title?: string;
  request?: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * waiting: 사람의 응답을 기다리는 노드가 있다 > blocked: 막힌 노드가 있다 > doing > stalled: 하던 세션이 닫혀 멈췄다 > done: 모두 끝.
   * 하는 노드가 없으면 그 작업에 붙어 있는 세션이 하는 일로 정한다 (between)
   */
  state: WorkState;
  /** 하는 노드가 없을 때(앞 노드를 끝내고 다음 노드를 아직 시작하지 않음), 그 작업에 붙어 있는 세션이 하는 일 */
  between?: Between;
  /** 새 결과: 모두 끝났는데 사람이 아직 보지 않았다 (끝난 뒤에 viewed 기록이 없다) */
  unread?: boolean;
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

type Doer = { session: string | null; agent?: string; model?: string };
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
/** resultsFrom: 이 시각 뒤에 끝난 작업만 새 결과로 센다 (resultsSince). 주지 않으면 새 결과를 세지 않는다 */
export function buildView(plan: Plan, events: Event[], sessions: Record<string, SessionInfo> = {}, now: number = clock.now().getTime(), closed: Map<string, number> = new Map(), resultsFrom?: string): WorkView {
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
        if (!last || last.session !== e.session || last.agent !== e.agent) d.doers.push({ session: e.session, ...(e.agent ? { agent: e.agent } : {}), ...(e.model ? { model: e.model } : {}) });
        // 같은 쪽이 다시 시작하면서 모델이 바뀌었으면 마지막 것
        else if (e.model) last.model = e.model;
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
      spawns.set(e.node, [...(spawns.get(e.node) ?? []), { at: e.at, terminal: e.terminal, ...(e.name ? { name: e.name } : {}), ...(e.show ? { show: e.show } : {}), ...(e.task ? { task: e.task } : {}), ...(e.cwd ? { cwd: e.cwd } : {}) }]);
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
          ...(owner.model ? { model: owner.model } : {}),
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
    // 계획과 달랐는지는 끝난 뒤에만 본다. 하는 중에는 서브에이전트가 아직 뜨지 않았을 수 있다.
    // 훅이 보지 못한 회차는 누가 했는지 알 수 없으므로 다르다고 하지 않는다
    if (n.run && last?.who && n.status === 'done' && n.run !== last.who.kind) {
      if (last.seen) view.offPlan = true;
      else view.runUnknown = true;
    }
    if ((n.status === 'doing' || n.status === 'waiting' || n.status === 'blocked') && last?.who?.session && closed.has(last.who.session)) view.closed = true;
    if (n.status === 'todo' && (n.attempt ?? 0) > 0) view.paused = true;
    if ((n.status === 'doing' || n.status === 'waiting') && (n.after ?? []).some(p => plan.nodes.find(x => x.id === p)?.status !== 'done')) view.early = true;
    if (mine.length) view.spawn = mine[mine.length - 1];
    return view;
  });

  const counts = { total: nodes.length, todo: 0, doing: 0, waiting: 0, blocked: 0, done: 0 };
  for (const n of nodes) counts[n.status] += 1;
  // 작업의 상태는 살아 있는 세션이 하는 노드로 정한다. 닫힌 세션이 남긴 "응답 대기"가 목록 맨 위에 붙어 있지 않게
  const alive = (status: NodeStatus) => nodes.some(n => n.status === status && !n.closed);
  const base: WorkState | null =
    alive('waiting') ? 'waiting'
    : alive('blocked') ? 'blocked'
    : alive('doing') ? 'doing'
    : nodes.some(n => n.closed) ? 'stalled'
    : counts.total > 0 && counts.done === counts.total ? 'done'
    : null;
  // 하는 노드가 없다: 앞 노드를 끝내고 다음 노드를 아직 시작하지 않았다. 그 작업에 붙어 있는 세션이 지금 하는 일로 정한다
  const between = base ? undefined : betweenOf(plan.work, sessions, closed);
  const state: WorkState = base ?? BETWEEN_STATE[between!];

  // 새 결과: 마지막 노드가 끝난 뒤로 사람이 보지 않았다. 이 기능이 생기기 전에 끝난 작업은 본 것으로 친다
  let unread = false;
  if (state === 'done' && resultsFrom) {
    const finishedAt = events.filter(e => e.type === 'node' && e.status === 'done').at(-1)?.at;
    const viewedAt = events.filter(e => e.type === 'viewed').at(-1)?.at;
    unread = Boolean(finishedAt && finishedAt >= resultsFrom && (!viewedAt || viewedAt < finishedAt));
  }

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
    ...(between ? { between } : {}),
    ...(unread ? { unread: true } : {}),
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

/** 하는 노드가 없는 작업에서, 그 작업에 지금 붙어 있는 (닫히지 않은) 세션이 하는 일 */
function betweenOf(work: string, sessions: Record<string, SessionInfo>, closed: Map<string, number>): Between {
  const mine = Object.entries(sessions).filter(([key, s]) => s.work === work && !closed.has(key)).map(([, s]) => s);
  if (!mine.length) return 'gone';
  if (mine.some(s => s.status === 'working')) return 'working';
  if (mine.some(s => s.status === 'blocked')) return 'asking';
  if (mine.some(s => s.status)) return 'stopped';
  return 'unknown';
}

/** 이 작업을 한 대화들: 계획을 낸 대화 먼저, 나머지는 최근에 본 순 */
function talksOf(v: WorkView): string[] {
  const rest = Object.entries(v.sessions).filter(([k]) => k !== v.lead).sort((a, b) => (b[1].seenAt ?? '').localeCompare(a[1].seenAt ?? '')).map(([k]) => k);
  return v.lead ? [v.lead, ...rest] : rest;
}

/** 사건 기록에 나온 세션들의 정보를 세션 파일에서 읽는다 */
export function sessionsOf(dir: string, events: Event[]): Record<string, SessionInfo> {
  const out: Record<string, SessionInfo> = {};
  for (const e of events) {
    const key = e.session;
    if (!key || out[key]) continue;
    const s = readSession(dir, key);
    out[key] = {
      label: sessionLabel(s, key),
      tool: s?.tool ?? 'unknown',
      ...(s?.terminal ? { terminal: s.terminal } : {}),
      ...(s?.herdrPane ? { herdrPane: s.herdrPane } : {}),
      ...(s?.seenAt ? { seenAt: s.seenAt } : {}),
      ...(s?.cwd ? { cwd: s.cwd } : {}),
      ...(s?.model ? { model: s.model } : {}),
      ...(s?.work ? { work: s.work } : {}),
    };
  }
  return out;
}

export function loadView(dir: string, work: string, env: NodeJS.ProcessEnv = process.env): WorkView | null {
  const plan = readPlan(dir, work);
  if (!plan) return null;
  const events = readEvents(dir, work);
  const sessions = sessionsOf(dir, events);
  // 끝나지 않은 노드가 있을 때만 Herdr에 물어본다: 세션이 닫혔는지, 살아 있으면 지금 무얼 하는지. 다 끝난 작업은 물어볼 것이 없다
  const open = plan.nodes.some(n => n.status !== 'done');
  const live = open ? sessionStates(sessions, Object.keys(sessions), env) : { closed: new Map<string, number>(), status: new Map<string, string>() };
  for (const [key, status] of live.status) if (sessions[key]) sessions[key].status = status;
  return buildView(plan, events, sessions, clock.now().getTime(), live.closed, resultsSince(dir));
}

const ORDER: Record<WorkState, number> = { waiting: 0, blocked: 1, doing: 2, stalled: 3, done: 4 };
/** 이만큼 지나도록 바뀐 것이 없으면 "지난 작업"으로 접는다. 지우지는 않는다 */
export const PAST_DAYS = 7;

export type WorkSummary = Pick<WorkView, 'work' | 'title' | 'request' | 'state' | 'between' | 'unread' | 'updatedAt' | 'counts'> & {
  /** 이 작업을 한 대화(세션)들: 계획을 낸 대화 먼저, 나머지는 최근에 본 순. 그래프 칸이 누를 때 그 대화로 간다 */
  talks?: string[];
  /** 지금 눈여겨볼 노드들: 사람을 기다리는 것, 막힌 것, 하는 중인 것. closed: 그 노드를 하던 세션이 닫혔다 */
  active: { id: string; title: string; status: NodeStatus; note?: string; closed?: boolean }[];
  /** 지난 작업: 끝났거나 멈춘 채로 오래됐다. 목록에서 접어 둔다 */
  past: boolean;
  /** 이 작업으로 갈 때 열 Herdr 터미널. 모르면 없다 */
  terminal?: string;
};

const URGENT: Partial<Record<NodeStatus, number>> = { waiting: 0, blocked: 1, doing: 2 };

/**
 * 이 작업으로 갈 때 열 터미널: 사람을 기다리는 노드 → 막힌 노드 → 하는 노드를 하는 세션,
 * 그런 노드가 없으면 계획을 낸 세션, 그다음 가장 최근에 본 세션. 세션이 닫힌 노드는 건너뛴다
 */
export function terminalOf(v: Pick<WorkView, 'nodes' | 'sessions' | 'lead'>): string | undefined {
  const live = v.nodes
    .filter(n => URGENT[n.status] !== undefined && !n.closed && n.session)
    .sort((a, b) => URGENT[a.status]! - URGENT[b.status]!);
  for (const n of live) {
    const t = v.sessions[n.session!]?.terminal;
    if (t) return t;
  }
  const lead = v.lead ? v.sessions[v.lead]?.terminal : undefined;
  if (lead) return lead;
  return Object.values(v.sessions)
    .filter(s => s.terminal)
    .sort((a, b) => (b.seenAt ?? '').localeCompare(a.seenAt ?? ''))[0]?.terminal;
}

/** 모든 작업을 급한 순서로: 응답 대기 → 막힘 → 새 결과(끝났는데 안 봄) → 작업 중 → 멈춤 → 끝. 같은 상태면 최근 것이 위 */
export function loadBoard(dir: string, env: NodeJS.ProcessEnv = process.env): { works: WorkSummary[]; errors: { work: string; message: string }[] } {
  const works: WorkSummary[] = [];
  const errors: { work: string; message: string }[] = [];
  const now = clock.now().getTime();
  for (const work of listWorks(dir)) {
    try {
      const v = loadView(dir, work, env);
      if (!v) continue;
      // 살아 있는 세션이 하고 있는 작업은 오래돼도 접지 않는다
      // 세션이 무얼 하는지 모르는 작업(Herdr 밖)도 오래 그대로면 접는다
      const quiet = v.state === 'done' || v.state === 'stalled' || v.between === 'unknown';
      const terminal = terminalOf(v);
      works.push({
        work: v.work,
        title: v.title,
        request: v.request,
        state: v.state,
        ...(v.between ? { between: v.between } : {}),
        talks: talksOf(v),
        ...(v.unread ? { unread: true } : {}),
        updatedAt: v.updatedAt,
        counts: v.counts,
        active: v.nodes
          .filter(n => n.status === 'waiting' || n.status === 'blocked' || n.status === 'doing')
          .map(n => ({ id: n.id, title: n.title, status: n.status, ...(n.note ? { note: n.note } : {}), ...(n.closed ? { closed: true } : {}) })),
        // 아직 안 본 결과는 오래돼도 접지 않는다
        past: quiet && !v.unread && now - Date.parse(v.updatedAt) > PAST_DAYS * 86_400_000,
        ...(terminal ? { terminal } : {}),
      });
    } catch (e: any) {
      errors.push({ work, message: e?.message ?? String(e) });
    }
  }
  // 새 결과는 막힘 다음, 작업 중보다 위 (사람이 볼 일이다)
  const rank = (w: WorkSummary) => (w.unread ? ORDER.blocked + 0.5 : ORDER[w.state]);
  works.sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { works, errors };
}
