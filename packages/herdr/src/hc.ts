// Herdr와 이야기하는 곳. 터미널을 띄우고, 말을 걸고, 읽고, 닫는 것은 hc가, 앱 화면에 놓는 것은 herdr-app이 한다.
// muwi는 그 둘을 부르기만 한다. 세션을 관리하는 기능을 다시 만들지 않는다.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type Ran = { ok: boolean; out: string; err: string };

function call(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Ran {
  // 대신 쓸 도구를 Node 스크립트로 줄 수 있다 (MUWI_HC, MUWI_HERDR_APP). Windows는 #! 줄로 스크립트를 실행하지 못한다
  if (/\.(c|m)?js$/.test(bin)) {
    const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env, timeout });
    return { ok: !r.error && r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error ? String(r.error.message) : '') };
  }
  let r = spawnSync(bin, args, { encoding: 'utf8', env, timeout });
  // Herdr 앱이 띄운 프로그램에는 셸의 PATH가 없다 (그래프 칸이 muwi를 부를 때). 설치되는 자리에서 한 번 더 찾는다
  const home = env.HOME || env.USERPROFILE;
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !/[\\/]/.test(bin) && home) {
    r = spawnSync(path.join(home, '.local', 'bin', bin), args, { encoding: 'utf8', env, timeout });
  }
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error ? String(r.error.message) : '') };
}

/** hc: 터미널을 띄우고, 말을 걸고, 기다린다 */
export const hc = (args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 90_000) => call(env.MUWI_HC || 'hc', args, env, timeout);
/** herdr-app: 창 안의 pane과 tab을 다룬다 */
export const herdrApp = (args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 10_000) => call(env.MUWI_HERDR_APP || 'herdr-app', args, env, timeout);

/** Herdr 터미널 이름으로 쓸 수 있게 바꾼다 (a-z 0-9 - _ 로 1~32자) */
export function terminalName(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'node';
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Herdr 앱에서 지금 키보드가 있는 칸. 알 수 없으면 null */
export function focusedPane(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const pane = JSON.parse(herdrApp(['status'], env).out)?.focused_pane;
    return typeof pane === 'string' && pane ? pane : null;
  } catch {
    return null;
  }
}

/**
 * 칸을 새로 놓으면 조금 뒤에 키보드가 그 칸으로 옮겨 간다. 잠깐 지켜보다가 옮겨 갔으면 원래 있던 칸으로 되돌린다.
 * 사람이 다른 칸에서 쓰고 있었다면 그 칸으로 돌아간다. muwi를 부른 터미널로 끌어오지 않는다.
 * 원래 자리를 알 수 없을 때만 fallback(부른 터미널)으로 보낸다.
 */
export function keepFocus(before: string | null, fallback?: { pane?: string; terminal?: string }, env: NodeJS.ProcessEnv = process.env) {
  let calm = 0;
  for (let i = 0; i < 8 && calm < 3; i++) {
    pause(200);
    if (!before) {
      if (fallback) herdrApp(['do', 'pane.focus', JSON.stringify(fallback)], env);
      continue;
    }
    const now = focusedPane(env);
    if (now && now !== before) {
      herdrApp(['do', 'pane.focus', JSON.stringify({ pane: before })], env);
      calm = 0;
    } else calm += 1;
  }
}

/** 방금 띄운 터미널을 Herdr 앱의 칸이나 탭에 놓는다. 앱이 아직 그 터미널을 모를 수 있어서 몇 번 다시 해 본다. 키보드는 원래 있던 칸에 둔다 */
export function keepTerminal(terminal: string, place: 'right' | 'down' | 'tab', near: string | null, env: NodeJS.ProcessEnv = process.env): Ran {
  const before = focusedPane(env);
  let kept: Ran = { ok: false, out: '', err: '' };
  for (let i = 0; i < 6 && !kept.ok; i++) {
    if (i) pause(400);
    kept = herdrApp(['do', 'terminal.keep', JSON.stringify({ terminal, place })], env);
  }
  keepFocus(before, near ? { terminal: near } : undefined, env);
  return kept;
}
