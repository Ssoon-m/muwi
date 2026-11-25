// 새 버전 알림과 업데이트. 사람이 새 판을 알아채는 곳은 셋이다:
//   1. 사람이 터미널에서 친 명령이 끝날 때 (afterCommand). AI 도구가 실행한 명령, 훅, 보기가 부르는 명령은 터미널이 아니라서 조용하다
//   2. 대화 자리: 세션이 시작될 때와 사람이 말할 때 (newerKnown → 훅의 답. 도구 화면에 바로 띄우거나 AI가 전한다. events.ts, hook.ts)
//   3. 보기 (muwi board의 update. 그래프 칸의 배너)
// 업데이트는 muwi update 하나로 한다: 지금 도는 muwi가 깔린 자리에 최신판을 받고, 새 판으로 muwi setup을 다시 해서 훅·보기·커넥터를 맞춘다 (updateTarget)
// - 명령을 늦추지 않는다: 알릴지는 캐시만 보고 정한다. npm에 묻는 일은 하루 한 번 따로 띄운 프로세스가 하고, 결과는 다음 명령에서 쓴다
// - 같은 알림은 하루 한 번만 한다
// - npm으로 깐 판(.js)에서만 묻는다. 저장소에서 .ts로 돌릴 때는 하지 않는다
// - 끄기: MUWI_NO_UPDATE_CHECK=1 (NO_UPDATE_NOTIFIER나 CI가 있어도 끈다)
// npm에는 패키지 이름만 묻는다 (https://registry.npmjs.org/-/package/<이름>/dist-tags)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { olderThan } from './setup.ts';

const DAY = 24 * 60 * 60 * 1000;
const REGISTRY = 'https://registry.npmjs.org';
const RELEASES = 'https://github.com/Ssoon-m/muwi/releases/tag';

/** 마지막으로 npm에 물어본 결과와 알린 때 */
export type UpdateCache = { name: string; latest?: string; checkedAt?: number; toldAt?: number };

export const cacheFile = (env: NodeJS.ProcessEnv) =>
  path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'muwi', 'update.json');

function readCache(file: string): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(file: string, c: UpdateCache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(c)}\n`);
}

const nameAt = (dir: string): string | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name;
  } catch {
    return undefined;
  }
};

/**
 * 사람이 npm으로 깐 패키지. 업데이트 명령에 이 이름을 쓴다. npm으로 깐 판이 아니면 null.
 * 코어가 다른 muwi 패키지 안에 따라 들어왔으면(<패키지>/node_modules/@muwi/core) 그 패키지다.
 * 아니면 붙은 보기·터미널 연결이 알려 준 패키지(plugins, 보기 먼저), 그것도 없으면 코어
 */
export function installedPackage(root: string, plugins: (string | undefined)[] = []): string | null {
  if (!fs.existsSync(path.join(root, 'src', 'cli.js'))) return null;
  if (path.basename(path.resolve(root, '..', '..')) === 'node_modules') {
    const outer = nameAt(path.resolve(root, '..', '..', '..'));
    if (outer?.startsWith('@muwi/')) return outer;
  }
  const named = plugins.find((p): p is string => Boolean(p));
  if (named) return named;
  return nameAt(root) === '@muwi/core' ? '@muwi/core' : null;
}

/** 캐시만 보고 정한다: 알릴 새 버전(tell)과, npm에 다시 물어볼지(refresh) */
export function decide(c: UpdateCache | null, name: string, current: string, now: number): { tell?: string; refresh: boolean } {
  const same = c?.name === name ? c : null;
  const refresh = !same?.checkedAt || now - same.checkedAt >= DAY;
  const latest = same?.latest;
  const toldRecently = Boolean(same?.toldAt && now - same.toldAt < DAY);
  return { tell: latest && olderThan(current, latest) && !toldRecently ? latest : undefined, refresh };
}

export const notice = (_name: string, current: string, latest: string) =>
  `\n새 버전이 나왔어요: ${current} → ${latest}\n  muwi update\n  바뀐 것: ${RELEASES}/v${latest}\n`;

/** 대화 자리와 보기에 띄울 한 줄 */
export const updateLine = (u: { current: string; latest: string }) =>
  `muwi ${u.latest}이 나왔어요 (지금 ${u.current}). 업데이트: muwi update · 바뀐 점: ${RELEASES}/v${u.latest}`;

export const releaseUrl = (version: string) => `${RELEASES}/v${version}`;

/** 끄기: MUWI_NO_UPDATE_CHECK=1 (NO_UPDATE_NOTIFIER나 CI가 있어도 끈다) */
const off = (env: NodeJS.ProcessEnv) => Boolean(env.MUWI_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);

export type Newer = { name: string; current: string; latest: string };

/**
 * 대화 자리와 보기에서 알릴 새 판. 캐시만 본다 (훅과 보기를 늦추지 않는다).
 * 하루가 지났으면 npm에 묻는 프로세스를 따로 띄우고, 그 결과는 다음에 쓴다. 끈 경우와 npm으로 깐 판이 아니면 null
 */
export function newerKnown(o: { current: string; root: string; plugins?: (string | undefined)[]; env?: NodeJS.ProcessEnv; now?: number; check?: (name: string, file: string) => void }): Newer | null {
  const env = o.env ?? process.env;
  try {
    if (off(env)) return null;
    const name = installedPackage(o.root, o.plugins);
    if (!name) return null;
    const file = cacheFile(env);
    const c = readCache(file);
    const same = c?.name === name ? c : null;
    const now = o.now ?? Date.now();
    if (!same?.checkedAt || now - same.checkedAt >= DAY) (o.check ?? spawnCheck(o.root))(name, file);
    return same?.latest && olderThan(o.current, same.latest) ? { name, current: o.current, latest: same.latest } : null;
  } catch {
    return null;
  }
}

/** 캐시에 적힌 그 패키지의 latest */
export const cachedLatest = (file: string, name: string): string | undefined => {
  const c = readCache(file);
  return c?.name === name ? c.latest : undefined;
};

/**
 * muwi update가 받을 곳: 지금 도는 muwi가 깔린 npm 전역 자리와, 사람이 깐 패키지.
 * 그 자리의 Node와 같은 폴더의 npm으로 받는다 (nvm으로 Node를 여럿 쓰면 다른 자리에 깔리는 것을 막는다).
 * bin: 새 판의 muwi 명령 (npm이 그 자리에 건 것). npm으로 전역에 깐 판이 아니면 null
 */
export function updateTarget(root: string, plugins: (string | undefined)[] = [], platform: NodeJS.Platform = process.platform, execPath = process.execPath): { name: string; prefix: string; npm: string; bin: string } | null {
  const name = installedPackage(root, plugins);
  if (!name) return null;
  // 사람이 깐 패키지의 폴더: 코어 자신이거나, 코어가 따라 들어온 바깥 패키지(<패키지>/node_modules/@muwi/core)
  const outer = path.resolve(root, '..', '..', '..');
  const pkgDir = nameAt(root) === name ? root : nameAt(outer) === name ? outer : null;
  if (!pkgDir) return null;
  const modules = path.resolve(pkgDir, ...(name.startsWith('@') ? ['..', '..'] : ['..']));
  if (path.basename(modules) !== 'node_modules') return null;
  // 전역 자리: macOS·Linux는 <자리>/lib/node_modules, Windows는 <자리>/node_modules. 프로젝트 안에 깐 것은 다루지 않는다
  const above = path.dirname(modules);
  const prefix = platform === 'win32' ? above : path.basename(above) === 'lib' ? path.dirname(above) : null;
  if (!prefix) return null;
  const npm = path.join(path.dirname(execPath), platform === 'win32' ? 'npm.cmd' : 'npm');
  return { name, prefix, npm: fs.existsSync(npm) ? npm : platform === 'win32' ? 'npm.cmd' : 'npm', bin: platform === 'win32' ? path.join(prefix, 'muwi.cmd') : path.join(prefix, 'bin', 'muwi') };
}

export type UpdateContext = {
  cmd: string | undefined;
  current: string;
  root: string;
  /** 붙은 보기와 터미널 연결이 알려 준 패키지 이름 (보기 먼저) */
  plugins?: (string | undefined)[];
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  now?: number;
  write?: (text: string) => void;
  /** npm에 물어볼 프로세스를 띄운다 (시험에서는 바꾼다) */
  check?: (name: string, file: string) => void;
};

/** 명령이 끝난 뒤 부른다. 무엇이 잘못돼도 명령은 실패하지 않는다 */
export function afterCommand(o: UpdateContext) {
  const env = o.env ?? process.env;
  try {
    if (!(o.tty ?? Boolean(process.stderr.isTTY))) return;
    if (off(env)) return;
    // 훅과 보기는 대화 자리·배너로 따로 알린다. muwi update는 스스로 알린다
    if (o.cmd === 'hook' || o.cmd === 'board' || o.cmd === 'update') return;
    const name = installedPackage(o.root, o.plugins);
    if (!name) return;
    const file = cacheFile(env);
    const now = o.now ?? Date.now();
    const c = readCache(file);
    const d = decide(c, name, o.current, now);
    if (d.tell) {
      (o.write ?? (t => process.stderr.write(t)))(notice(name, o.current, d.tell));
      writeCache(file, { ...(c?.name === name ? c : { name }), toldAt: now });
    }
    if (d.refresh) (o.check ?? spawnCheck(o.root))(name, file);
  } catch {
    // 알림은 덤이다. 캐시를 못 읽거나 못 써도 넘어간다
  }
}

/** npm에 묻는 일은 명령과 따로 돈다 (명령은 기다리지 않고 끝난다) */
const spawnCheck = (root: string) => (name: string, file: string) => {
  const child = spawn(process.execPath, [path.join(root, 'src', 'update.js'), '--check', name, file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
};

/** npm의 latest 버전을 물어 캐시에 적는다. 실패해도(오프라인) 물어본 때는 적어서 하루 동안 다시 묻지 않는다 */
export async function checkLatest(name: string, file: string, registry: string = REGISTRY, now = Date.now()) {
  let latest: string | undefined;
  try {
    const res = await fetch(`${registry}/-/package/${name.replace('/', '%2f')}/dist-tags`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) latest = ((await res.json()) as { latest?: string }).latest;
  } catch {
    // 오프라인이거나 npm이 답하지 않는다
  }
  const prev = readCache(file);
  const same = prev?.name === name ? prev : null;
  writeCache(file, { name, latest: latest ?? same?.latest, checkedAt: now, toldAt: same?.toldAt });
}

if (import.meta.main && process.argv[2] === '--check') {
  const [name, file] = process.argv.slice(3);
  // MUWI_UPDATE_REGISTRY: 시험에서 npm 대신 쓸 주소
  if (name && file) await checkLatest(name, file, process.env.MUWI_UPDATE_REGISTRY || REGISTRY);
}
