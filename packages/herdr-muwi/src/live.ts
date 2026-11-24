// 노드를 하던 세션이 아직 살아 있는지 Herdr에 물어본다.
// muwi는 AI가 적어 준 것만 안다. 세션을 닫아 버리면 "끝"을 적을 쪽이 없어서 노드가 계속 작업 중으로 남는다.
// 그래서 보여 줄 때 Herdr에 그 터미널이 살아 있는지 확인하고, 없으면 "세션이 닫힘"으로 보여 준다.
// 상태를 바꾸지는 않는다. 일이 끝났는지는 알 수 없다. 하다가 멈췄다는 것만 보여 준다.
import { LABEL_SESSION, hc } from './hc.ts';

export type SessionWhere = { terminal?: string; seenAt?: string };

/**
 * 닫힌 세션과, 그 세션을 마지막으로 본 시각(ms).
 * 판단할 수 없으면 닫혔다고 하지 않는다: Herdr 밖이거나(hc가 없음), 그 세션의 터미널을 모를 때.
 *
 * 닫혔다고 보는 경우
 *   - 터미널이 없어졌다 (닫았거나 프로그램이 끝났다)
 *   - 터미널은 있는데 에이전트가 돌고 있지 않다 (Claude를 끝내고 셸만 남았다)
 *   - 그 터미널에서 다른 대화가 돌고 있다 (/clear, 새로 띄움). 세션이 시작될 때 터미널에 세션 이름을 라벨로 붙여 둔다
 */
export function closedSessions(sessions: Record<string, SessionWhere>, keys: Iterable<string>, env: NodeJS.ProcessEnv = process.env): Map<string, number> {
  return sessionStates(sessions, keys, env).closed;
}

export type SessionStates = {
  /** 닫힌 세션과, 그 세션을 마지막으로 본 시각(ms) */
  closed: Map<string, number>;
  /** 살아 있는 세션의 Herdr 상태: working(일하는 중), blocked(입력을 기다림), done·idle(멈춰서 다음 말을 기다림) */
  status: Map<string, string>;
};

/** 세션마다 닫혔는지, 살아 있으면 지금 무얼 하는지 (closedSessions와 같은 기준) */
export function sessionStates(sessions: Record<string, SessionWhere>, keys: Iterable<string>, env: NodeJS.ProcessEnv = process.env): SessionStates {
  const closed = new Map<string, number>();
  const status = new Map<string, string>();
  const none = { closed, status };
  const wanted = [...new Set(keys)].filter(k => sessions[k]?.terminal);
  if (!wanted.length) return none;
  const ls = hc(['ls', '--json'], env, 3000);
  if (!ls.ok) return none;
  let terminals: any[];
  try {
    terminals = JSON.parse(ls.out)?.terminals ?? [];
  } catch {
    return none;
  }
  const live = new Map<string, any>(terminals.map(t => [String(t.address), t]));
  const owner = new Map<string, string | null>();
  /** 그 터미널에서 지금 도는 세션. 라벨이 없으면 null (옛 판에서 시작했거나 훅이 없는 도구) */
  const ownerOf = (terminal: string): string | null => {
    if (!owner.has(terminal)) {
      let label: string | null = null;
      const got = hc(['get', terminal, '--json'], env, 3000);
      try {
        const v = JSON.parse(got.out)?.labels?.[LABEL_SESSION];
        if (typeof v === 'string' && v) label = v;
      } catch {
        // 읽지 못하면 모르는 것으로 둔다
      }
      owner.set(terminal, label);
    }
    return owner.get(terminal) ?? null;
  };
  for (const key of wanted) {
    const terminal = sessions[key].terminal!;
    const t = live.get(terminal);
    // 상태를 알리는 프로그램(에이전트)이 돌고 있어야 살아 있는 것이다. 셸만 남은 터미널은 상태가 없다
    const running = Boolean(t && t.state === 'live' && t.status != null);
    const mine = running ? ownerOf(terminal) : null;
    if (!running || (mine !== null && mine !== key)) closed.set(key, Date.parse(sessions[key].seenAt ?? '') || 0);
    else status.set(key, String(t.status));
  }
  return { closed, status };
}
