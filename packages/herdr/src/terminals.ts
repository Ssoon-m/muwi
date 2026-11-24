// Herdr 터미널 연결: 코어의 터미널 연결 규격(@muwi/core/plugins의 Terminals)을 hc와 herdr-app으로 채운다.
//   이 터미널의 주소   $HC_TERMINAL_ID
//   터미널 목록        hc ls --json (state가 live인 것. status가 없으면 에이전트가 돌지 않는 터미널)
//   띄우기·보내기·읽기·닫기   hc run --bg, hc send, hc read, hc kill + hc rm
//   놓기               herdr-app do terminal.keep (키보드는 원래 있던 칸으로 되돌린다)
// 무엇을 띄울지, 세션이 닫혔는지는 코어가 정한다. 여기서는 Herdr에 전하고 답을 옮길 뿐이다.
import type { AgentState, Terminals } from '@muwi/core/plugins';
import { hc, keepTerminal, terminalName } from './hc.ts';

const AGENT: Record<string, AgentState> = { working: 'working', blocked: 'blocked', done: 'done', idle: 'idle' };

/**
 * 띄울 프로그램에 환경 변수를 넘긴다. hc run에는 환경 변수 옵션이 없어서 env 명령으로 감싼다 (env는 그 프로그램으로 바뀌어 실행된다).
 * Windows에는 env가 없어서 감싸지 않는다. 그때 코어는 띄운 터미널의 표(.spawns)로 맡은 노드를 안다
 */
export function withEnv(argv: string[], vars: Record<string, string>, platform: NodeJS.Platform = process.platform): string[] {
  const pairs = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  return platform === 'win32' || !pairs.length ? argv : ['env', ...pairs, ...argv];
}

const herdr: Terminals = {
  name: 'Herdr',
  package: '@muwi/herdr',
  place(env) {
    return env.HC_TERMINAL_ID ? { terminal: env.HC_TERMINAL_ID, ...(env.HERDR_PANE_ID ? { pane: env.HERDR_PANE_ID } : {}) } : null;
  },
  list(env) {
    const r = hc(['ls', '--json'], env, 3000);
    if (!r.ok) return null;
    try {
      const terminals: { address?: unknown; state?: unknown; status?: unknown }[] = JSON.parse(r.out)?.terminals ?? [];
      return terminals
        .filter(t => t.state === 'live' && t.address != null)
        // 상태를 알리는 프로그램(에이전트)이 돌고 있어야 그 세션이 살아 있는 것이다. 셸만 남은 터미널은 상태가 없다
        .map(t => ({ terminal: String(t.address), agent: t.status == null ? 'none' : (AGENT[String(t.status)] ?? 'working') }));
    } catch {
      return null;
    }
  },
  launch(o, env) {
    // 이름은 Herdr의 목록에서 어느 노드인지 보이게 짓는다. 이미 있는 이름이면 뒤에 몇 글자를 붙인다
    const base = terminalName(o.name);
    let last = '';
    for (const name of [base, `${base.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`]) {
      // 맡긴 세션이 끝나도(--outlive-parent) 띄운 세션은 남는다. 끝난 뒤에도 이어 시키거나 다시 볼 수 있게
      const r = hc(['run', '--bg', '--json', '--outlive-parent', '--name', name, '--cwd', o.cwd, '--', ...withEnv(o.argv, o.env)], env);
      if (!r.ok) {
        last = (r.err || r.out || 'hc 명령이 없어요').trim();
        continue;
      }
      let terminal = '';
      let delivered = true;
      try {
        const j = JSON.parse(r.out);
        terminal = String(j.address ?? j.terminal ?? j.id ?? '');
        if (j.first_message && j.first_message.sent === false) delivered = false;
      } catch {
        // 주소를 읽지 못하면 이름으로 가리킨다
      }
      return { terminal: terminal || name, name, delivered };
    }
    throw new Error(last);
  },
  send: (terminal, text, env) => hc(['send', terminal, text], env).ok,
  read(terminal, env) {
    const r = hc(['read', terminal], env, 10_000);
    return r.ok ? r.out : null;
  },
  close(terminal, env) {
    const killed = hc(['kill', terminal], env, 10_000).ok;
    const removed = hc(['rm', terminal], env, 10_000).ok;
    return killed || removed;
  },
  arrange(terminal, spot, near, env) {
    const r = keepTerminal(terminal, spot === 'tab' ? 'tab' : spot === 'below' ? 'down' : 'right', near, env);
    return r.ok ? { ok: true } : { ok: false, error: (r.err || r.out).trim() };
  },
};

export default herdr;
