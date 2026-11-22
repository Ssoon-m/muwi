// Herdr와 이야기하는 곳. 세션을 띄우고 기다리는 것은 hc가, 화면에 놓는 것은 herdr-app이 한다.
// muwi는 그 둘을 부르기만 한다. 세션을 관리하는 기능을 다시 만들지 않는다.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type Ran = { ok: boolean; out: string; err: string };

function call(bin: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Ran {
  let r = spawnSync(bin, args, { encoding: 'utf8', env, timeout });
  // Herdr 앱이 띄운 프로그램에는 셸의 PATH가 없다. 그래프 칸이 muwi를 부를 때가 그렇다. 설치되는 자리에서 한 번 더 찾는다
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !bin.includes('/') && env.HOME) {
    r = spawnSync(path.join(env.HOME, '.local', 'bin', bin), args, { encoding: 'utf8', env, timeout });
  }
  return { ok: !r.error && r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') || (r.error ? String(r.error.message) : '') };
}

/** hc: 터미널을 띄우고, 말을 걸고, 기다린다 */
export const hc = (args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 90_000) => call(env.MUWI_HC || 'hc', args, env, timeout);
/** herdr-app: 창 안의 pane과 tab을 다룬다 */
export const herdrApp = (args: string[], env: NodeJS.ProcessEnv = process.env, timeout = 10_000) => call(env.MUWI_HERDR_APP || 'herdr-app', args, env, timeout);

export const LABEL_WORK = 'muwi.work';
export const LABEL_NODE = 'muwi.node';
/** 그 터미널에서 지금 도는 세션. 세션이 시작될 때 붙인다. 같은 터미널에서 다른 대화가 시작되면 바뀐다 */
export const LABEL_SESSION = 'muwi.session';

/** 이 터미널이 muwi run으로 뜬 것이면 맡은 작업과 노드를 돌려준다. 띄울 때 터미널에 붙여 둔 라벨에서 읽는다 */
export function spawnedFor(terminal: string, env: NodeJS.ProcessEnv = process.env): { work: string; node: string } | null {
  const r = hc(['get', terminal, '--json'], env, 3000);
  if (!r.ok) return null;
  try {
    const labels = JSON.parse(r.out)?.labels ?? {};
    const work = labels[LABEL_WORK];
    const node = labels[LABEL_NODE];
    return typeof work === 'string' && work && typeof node === 'string' && node ? { work, node } : null;
  } catch {
    return null;
  }
}

/** Herdr 터미널 이름으로 쓸 수 있게 바꾼다 (a-z 0-9 - _ 로 1~32자) */
export function terminalName(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'node';
}
