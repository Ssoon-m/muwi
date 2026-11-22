// 세션 이름표. "어느 세션이 한 일인가"를 muwi 명령과 훅이 같은 이름으로 적게 한다.
//   muwi 명령은 환경 변수에서 세션을 읽고, 훅은 Claude Code가 넘겨주는 session_id를 쓴다. 둘은 같은 값이다.
// 세션마다 파일 하나(<기록 폴더>/.sessions/<세션>.json)에 지금 붙어 있는 작업과 읽은 skill을 적어 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, nowIso, readEvents, readJson, readPlan, writeJson } from './store.ts';

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
  /** 계획 없이 진행하겠다고 밝혔다 (muwi skip) */
  skipped?: { at: string; reason: string };
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
 * "이 세션은 더 알릴 것이 없다"는 표시. 작업에 붙었거나 계획 없이 진행하겠다고 밝혔을 때 남긴다.
 * hook.sh가 이 파일을 보고 파일 수정마다 node를 띄우지 않고 바로 끝낸다.
 */
export function markSettled(dir: string, key: string) {
  const file = path.join(dir, '.sessions', `${safe(key)}.ok`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
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

/** 세션이 skill을 읽었다. 세션 파일에 남기고, 붙어 있는 작업이 있으면 그 작업의 사건 기록에도 적는다 */
export function recordSkill(dir: string, key: string, skill: string, via: 'tool' | 'file', patch: Partial<Session> = {}, env: NodeJS.ProcessEnv = process.env) {
  const at = nowIso();
  const old = readSession(dir, key);
  const loaded = { ...(old?.loaded ?? {}) };
  if (!loaded[skill]) loaded[skill] = at;
  const session = touchSession(dir, key, { ...patch, loaded }, env);
  if (session.work && readPlan(dir, session.work)) {
    appendEvent(dir, session.work, { type: 'skill', skill, via }, key, at);
  }
  return session;
}

/** 화면에 보여 줄 짧은 이름: 터미널 주소가 있으면 그것, 없으면 세션 id 앞 네 글자 */
export function sessionLabel(s: Pick<Session, 'key' | 'terminal' | 'herdrPane'> | null | undefined, key: string | null): string {
  if (!key) return '';
  if (s?.terminal) return s.terminal;
  if (s?.herdrPane) return s.herdrPane;
  return key.replace(/^(hc|herdr)-/, '').slice(0, 4);
}
