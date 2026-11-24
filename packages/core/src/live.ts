// 노드를 하던 세션이 아직 살아 있는지, 살아 있으면 지금 무얼 하는지.
// muwi는 AI가 적어 준 것만 안다. 세션을 닫아 버리면 "끝"을 적을 쪽이 없어서 노드가 계속 작업 중으로 남는다.
// 그래서 보여 줄 때 세 가지를 합쳐 판단한다. 상태를 바꾸지는 않는다. 일이 끝났는지는 알 수 없고, 하다가 멈췄다는 것만 보여 준다.
//   1. 훅: 세션이 끝났다(SessionEnd), 말을 끝내고 멈췄다(Stop), 사람이 말을 걸었다(UserPromptSubmit)
//   2. 세션 파일: 같은 터미널에서 더 늦게 시작해 아직 끝나지 않은 세션이 있으면 앞 세션은 닫힌 것이다 (/clear, 새로 띄움).
//      끝난 세션은 셈하지 않는다 (에이전트가 셸에서 잠깐 돌린 claude -p 같은 것). 다시 연 세션(--resume)은 시작한 때가 새로 적힌다
//   3. 터미널 연결: 그 터미널이 아직 있는가, 에이전트가 돌고 있는가, 무얼 하는가
// 판단할 수 없으면 닫혔다고 하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { terminals } from './plugins.ts';
import { readJson } from './store.ts';
import type { Session } from './session.ts';

/** closed: 닫힌 세션과 그 세션을 마지막으로 본 시각(ms). status: 살아 있는 세션이 하는 일 (working, blocked, done, idle) */
export type SessionStates = { closed: Map<string, number>; status: Map<string, string> };

/** 모든 세션 파일 (같은 터미널에서 더 늦게 시작한 세션을 찾는 데 쓴다) */
function allSessions(dir: string): Session[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, '.sessions'));
  } catch {
    return [];
  }
  return names.filter(n => n.endsWith('.json')).map(n => readJson<Session>(path.join(dir, '.sessions', n))).filter((s): s is Session => Boolean(s?.key));
}

/** 세션들이 지금 어떤가. keys: 알고 싶은 세션들 */
export function sessionStates(dir: string, keys: Iterable<string>, env: NodeJS.ProcessEnv = process.env): SessionStates {
  const closed = new Map<string, number>();
  const status = new Map<string, string>();
  const all = allSessions(dir);
  const byKey = new Map(all.map(s => [s.key, s]));
  const wanted = [...new Set(keys)].map(k => byKey.get(k)).filter((s): s is Session => Boolean(s));
  if (!wanted.length) return { closed, status };

  const latest = owners(all);
  // 터미널이 있는 세션이 있을 때만 터미널 연결에 묻는다
  const list = wanted.some(s => s.terminal) ? (terminals().list?.(env) ?? null) : null;
  const live = list ? new Map(list.map(t => [t.terminal, t])) : null;

  for (const s of wanted) {
    const seen = Date.parse(s.seenAt ?? '') || 0;
    if (s.endedAt) {
      closed.set(s.key, Date.parse(s.endedAt) || seen);
      continue;
    }
    if (s.terminal) {
      const owner = latest.get(s.terminal);
      if (owner && owner.key !== s.key) {
        closed.set(s.key, seen);
        continue;
      }
      if (live) {
        const t = live.get(s.terminal);
        if (!t || t.agent === 'none') {
          closed.set(s.key, seen);
          continue;
        }
        if (t.agent) {
          status.set(s.key, t.agent);
          continue;
        }
      }
    }
    // 터미널 연결이 모르면 훅이 알려 준 것을 쓴다
    if (s.turn) status.set(s.key, s.turn);
  }
  return { closed, status };
}

/** 터미널마다 지금 그 터미널을 쓰는 세션: 가장 늦게 시작해 아직 끝나지 않은 세션 */
function owners(all: Session[]): Map<string, Session> {
  const latest = new Map<string, Session>();
  for (const s of all) {
    if (!s.terminal || s.endedAt) continue;
    const prev = latest.get(s.terminal);
    if (!prev || (s.startedAt ?? '') > (prev.startedAt ?? '')) latest.set(s.terminal, s);
  }
  return latest;
}

/** 그 터미널을 지금 쓰는 세션. 모르면 null */
export function ownerOfTerminal(dir: string, terminal: string): Session | null {
  return owners(allSessions(dir)).get(terminal) ?? null;
}

/** 터미널 → 그 터미널을 지금 쓰는 세션 이름 (보기가 터미널과 대화를 잇는 데 쓴다) */
export function terminalOwners(dir: string): Record<string, string> {
  return Object.fromEntries([...owners(allSessions(dir))].map(([t, s]) => [t, s.key]));
}
