// 세션 이름표. "어느 세션이 한 일인가"를 muwi 명령과 훅이 같은 이름으로 적게 한다.
//   muwi 명령은 환경 변수에서 세션을 읽고, 훅은 Claude Code가 넘겨주는 session_id를 쓴다. 둘은 같은 값이다.
// 세션마다 파일 하나(<기록 폴더>/.sessions/<세션>.json)에 지금 붙어 있는 작업과 읽은 skill을 적어 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, nowIso, readEvents, readJson, readPlan, writeJson } from './store.ts';
import type { Plan, Where } from './store.ts';

export type Session = {
  key: string;
  tool: 'claude' | 'codex' | 'unknown';
  cwd?: string;
  /** Herdr 앱의 터미널 주소 ($HC_TERMINAL_ID). 그래프에서 세션 상태를 보고 그 터미널로 갈 때 쓴다 */
  terminal?: string;
  /** herdr(터미널 앱)의 pane ($HERDR_PANE_ID) */
  herdrPane?: string;
  /** 지금 붙어 있는 작업 */
  work?: string;
  /** 이 세션이 읽은 skill과 처음 읽은 시각. 작업을 옮겨도 세션은 내용을 갖고 있으므로 따로 기억한다 */
  loaded: Record<string, string>;
  /** 계획 없이 파일을 고치려 해서 처음 알린 시각 (nudge 훅) */
  nudged?: string;
  /** 계획 없이 진행하겠다고 밝혔다 (muwi skip). 사람이 다음 말을 하면 지워진다 */
  skipped?: { at: string; reason: string };
  /** 훅이 이 세션을 마지막으로 본 시각. 있으면 이 세션이 읽은 skill을 관찰할 수 있다 */
  hooked?: string;
  /**
   * 서브에이전트가 곧 시작할 노드. 명령만 봐서는 누가 실행하는지 알 수 없어서(세션 id가 같다)
   * 훅이 명령을 보고 적어 두고, muwi node … start가 읽어서 그 서브에이전트가 시작한 것으로 적는다
   */
  starting?: Record<string, { agent: string; at: string }>;
  /** 이 세션의 서브에이전트가 하는 노드(own) 또는 뜰 때 세션이 하고 있던 노드(도운 노드) */
  agents?: Record<string, Where & { work: string; own: boolean }>;
  startedAt: string;
  seenAt: string;
};

/** muwi 명령을 실행한 세션. 알 수 없으면 null (세션 없이도 기록은 된다) */
export function sessionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MUWI_SESSION) return env.MUWI_SESSION;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  // Codex처럼 세션 id를 주지 않는 도구는 터미널을 세션으로 본다
  if (env.HC_TERMINAL_ID) return `hc-${env.HC_TERMINAL_ID}`;
  if (env.HERDR_PANE_ID) return `herdr-${env.HERDR_PANE_ID}`;
  return null;
}

export function toolOf(env: NodeJS.ProcessEnv = process.env): Session['tool'] {
  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) return 'claude';
  if (Object.keys(env).some(k => k.startsWith('CODEX_'))) return 'codex';
  return 'unknown';
}

const safe = (key: string) => key.replace(/[^A-Za-z0-9_.-]/g, '_');
const sessionFile = (dir: string, key: string) => path.join(dir, '.sessions', `${safe(key)}.json`);

export const readSession = (dir: string, key: string) => readJson<Session>(sessionFile(dir, key));

/**
 * 지금 이 쪽(세션, 또는 그 세션의 서브에이전트)이 하고 있는 노드. 계획에 적어 둔 "하고 있는 쪽"에서 읽는다.
 * 훅이 사실을 적는 순간에 불러서 그 사실이 어느 노드의 몇 번째 회차 것인지 같이 적는다.
 */
export function whereNow(plan: Plan, session: Pick<Session, 'key' | 'agents'>, agent?: string): Where {
  const doing = plan.nodes.filter(n => n.status === 'doing' && n.by?.session === session.key && (n.by?.agent ?? undefined) === agent);
  if (doing.length) {
    const last = doing.reduce((a, b) => ((a.by?.at ?? '') >= (b.by?.at ?? '') ? a : b));
    // 같은 쪽이 노드 여러 개를 동시에 하고 있으면 가장 늦게 시작한 것으로 적고, 확실하지 않다고 표시한다
    return { node: last.id, attempt: last.attempt ?? 1, ...(doing.length > 1 ? { guess: true } : {}) };
  }
  if (!agent) return {};
  // 노드를 직접 시작하지 않은 서브에이전트는 뜰 때 세션이 하고 있던 노드의 일을 돕는 것으로 본다
  const noted = session.agents?.[agent];
  if (!noted?.node || noted.work !== plan.work || !plan.nodes.some(n => n.id === noted.node)) return {};
  return { node: noted.node, attempt: noted.attempt ?? 1, ...(noted.guess ? { guess: true } : {}) };
}

/**
 * "이 세션은 더 알릴 것이 없다"는 표시. 작업에 붙었거나 계획 없이 진행하겠다고 밝혔을 때 남긴다.
 * hook.sh가 이 파일을 보고 파일 수정마다 node를 띄우지 않고 바로 끝낸다.
 */
export function markSettled(dir: string, key: string) {
  const file = path.join(dir, '.sessions', `${safe(key)}.ok`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

/** 이번 요청에서 이미 확인이 끝난 세션인가 */
export const isSettled = (dir: string, key: string) => fs.existsSync(path.join(dir, '.sessions', `${safe(key)}.ok`));

/** 사람이 새로 말을 걸었다. 계획을 적었는지 다시 따지게 표시를 지우고, 앞에서 한 skip도 끝낸다 */
export function unsettle(dir: string, key: string) {
  try {
    fs.rmSync(path.join(dir, '.sessions', `${safe(key)}.ok`), { force: true });
  } catch {
    // 지우지 못해도 다음 확인에서 다시 본다
  }
}

/** 세션 파일을 만들거나 고친다. 환경에서 알 수 있는 것(도구, 폴더, 터미널)을 채운다 */
export function touchSession(dir: string, key: string, patch: Partial<Session> = {}, env: NodeJS.ProcessEnv = process.env): Session {
  const at = nowIso();
  const old = readSession(dir, key);
  const fromEnv: Partial<Session> = {};
  if (env.HC_TERMINAL_ID) fromEnv.terminal = env.HC_TERMINAL_ID;
  if (env.HERDR_PANE_ID) fromEnv.herdrPane = env.HERDR_PANE_ID;
  const next: Session = {
    tool: toolOf(env),
    loaded: {},
    startedAt: at,
    ...old,
    ...fromEnv,
    ...patch,
    key,
    seenAt: at,
  };
  if (next.tool === 'unknown' && old?.tool && old.tool !== 'unknown') next.tool = old.tool;
  writeJson(sessionFile(dir, key), next);
  return next;
}

/**
 * 세션을 작업에 붙인다. 붙기 전에 이 세션이 읽어 둔 skill은 작업의 사건 기록에 옮겨 적는다(carried).
 * 그래야 "이 세션은 이미 그 skill을 읽은 상태"라는 걸 그 작업의 기록만 보고도 알 수 있다.
 */
export function attach(dir: string, key: string, work: string, env: NodeJS.ProcessEnv = process.env): Session {
  const session = touchSession(dir, key, {}, env);
  if (session.work === work) {
    markSettled(dir, key);
    return session;
  }
  const known = new Set(
    readEvents(dir, work).filter(e => e.type === 'skill' && e.session === key).map(e => (e as { skill: string }).skill),
  );
  for (const [skill, at] of Object.entries(session.loaded)) {
    if (!known.has(skill)) appendEvent(dir, work, { type: 'skill', skill, via: 'tool', carried: true }, key, at);
  }
  markSettled(dir, key);
  return touchSession(dir, key, { work }, env);
}

/**
 * 세션이 skill을 읽었다. 세션 파일에 남기고, 붙어 있는 작업이 있으면 그 작업의 사건 기록에도 적는다.
 * 서브에이전트(agent)가 읽은 것은 세션의 "읽어 둔 skill"에 넣지 않는다. 서브에이전트는 빈 상태에서 시작하고,
 * 끝나면 읽은 내용이 세션에 남지 않기 때문이다.
 */
export function recordSkill(dir: string, key: string, skill: string, via: 'tool' | 'file', patch: Partial<Session> = {}, env: NodeJS.ProcessEnv = process.env, agent?: string) {
  const at = nowIso();
  const old = readSession(dir, key);
  const loaded = { ...(old?.loaded ?? {}) };
  if (!agent && !loaded[skill]) loaded[skill] = at;
  const session = touchSession(dir, key, { ...patch, loaded, hooked: at }, env);
  const plan = session.work ? readPlan(dir, session.work) : null;
  if (session.work && plan) {
    // 읽는 순간에 하고 있던 노드를 같이 적는다
    appendEvent(dir, session.work, { type: 'skill', skill, via, ...(agent ? { agent } : {}), ...whereNow(plan, session, agent) }, key, at);
  }
  return session;
}

/** 그래프 칸이 터미널과 작업을 잇는 데 쓰는 세션 정보 */
export type SessionLink = { key: string; terminal: string; work?: string; seenAt: string };

/**
 * 최근에 본 세션 중 Herdr 터미널이 있는 것. 그래프 칸은 이걸로 "이 터미널의 세션은 어느 작업을 하는가"를 안다.
 * 오래된 세션은 넣지 않는다 (Herdr를 다시 켜면 터미널 주소가 다시 쓰인다)
 */
export function recentSessions(dir: string, since: number): SessionLink[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, '.sessions'));
  } catch {
    return [];
  }
  const out: SessionLink[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readJson<Session>(path.join(dir, '.sessions', name));
    if (!s?.key || !s.terminal || !s.seenAt || Date.parse(s.seenAt) < since) continue;
    out.push({ key: s.key, terminal: s.terminal, ...(s.work ? { work: s.work } : {}), seenAt: s.seenAt });
  }
  return out.sort((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0));
}

/** 화면에 보여 줄 짧은 이름: 터미널 주소가 있으면 그것, 없으면 세션 id 앞 네 글자 */
export function sessionLabel(s: Pick<Session, 'key' | 'terminal' | 'herdrPane'> | null | undefined, key: string | null): string {
  if (!key) return '';
  if (s?.terminal) return s.terminal;
  if (s?.herdrPane) return s.herdrPane;
  return key.replace(/^(hc|herdr)-/, '').slice(0, 4);
}
