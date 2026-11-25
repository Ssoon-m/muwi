// Herdr 앱 보기를 넣고 빼기 (muwi setup이 부른다): Herdr 앱의 그래프 칸(mod), 설정 화면의 레이아웃 그림, 화면 안내.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyDir } from '@muwi/core/connectors/files';
import type { ViewInstall } from '@muwi/core/plugins';
import { config, describeScreen, guardScreen, layoutRemoved } from './commands.ts';
import { ScreenError, applyLayout, ensurePreview, readLayoutRecord, removeLayout, screenState } from './screen.ts';

/** Herdr 앱의 설정 폴더. 없으면 Herdr 앱이 없는 것이다 */
export const appHome = (env: NodeJS.ProcessEnv) => env.HERDR_APP_HOME || path.join(env.HOME || os.homedir(), '.config', 'herdr-app');

/** 이 패키지에 든 그래프 칸 */
const MOD = path.resolve(import.meta.dirname, '..', 'app', 'muwi');

/** Herdr 앱 칸을 넣는다. 앱은 저장하는 즉시 다시 불러오므로 main.js를 마지막에 쓴다 */
function installMod(home: string): string {
  const to = path.join(home, 'mods', 'muwi');
  const generated = (name: string) => name.endsWith('.d.ts') || name === 'jsconfig.json' || name === '.gitignore';
  copyDir(MOD, to, name => name === 'main.js' || generated(name));
  fs.copyFileSync(path.join(MOD, 'main.js'), path.join(to, 'main.js'));
  return to;
}

/** Herdr 앱 칸이 문제없이 불리는지 앱에 확인받는다. 앱 명령이 없으면 건너뛴다 */
export function checkMod(modDir: string): string | null {
  const r = spawnSync('herdr-app', ['check', modDir], { encoding: 'utf8' });
  if (r.error) return null;
  return r.status === 0 ? 'ok' : (r.stdout + r.stderr).trim();
}

/**
 * Herdr 앱이 있으면 그래프 칸을 넣는다. report: 사람이 muwi setup을 실행했다 (칸을 점검하고 화면이 어떤지 알린다).
 * 업데이트 뒤에 훅이 다시 맞출 때는 칸만 넣는다
 */
export function setupHerdr(o: { dir: string; env: NodeJS.ProcessEnv; log: (line: string) => void; report?: boolean }): ViewInstall | null {
  const home = appHome(o.env);
  if (!fs.existsSync(home)) {
    o.log('Herdr 앱이 없어 그래프 칸은 건너뛰었어요.');
    return null;
  }
  const mod = installMod(home);
  o.log(`Herdr 앱 그래프 칸: ${mod}`);
  if (o.report) {
    const checked = checkMod(mod);
    if (checked && checked !== 'ok') o.log(`Herdr 앱 칸 점검에서 문제가 나왔어요:\n${checked}`);
    // 그림 없이 만든 muwi 레이아웃이면 Herdr 설정 화면에 보일 그림을 넣는다
    // 0.10까지의 오른쪽 자리를 먼저 아래로 옮긴다 (옮기면 그림도 새 자리대로 그린다)
    const moved = moveOffRight(o.dir, o.env);
    if (moved) o.log(moved);
    if (ensurePreview(o.dir)) o.log('Herdr 설정 화면(Look > Layout)의 muwi 레이아웃 그림을 새로 그렸어요.');
    const screen = screenState(o.dir);
    // 안내를 꺼 뒀으면 화면이 이미 muwi일 때만 알린다
    if (config(o.dir).layout || screen.muwi) o.log(describeScreen(screen));
  }
  return { mod };
}

/**
 * 0.10까지 고를 수 있던 오른쪽 자리에 둔 그래프 칸을 터미널 아래로 옮긴다. 알릴 말을 돌려준다 (옮길 것이 없으면 null).
 * 그 레이아웃을 보고 있을 때만 옮긴다 (다른 레이아웃을 보는 중이면 그 레이아웃을 건드리지 않고, 다음 muwi layout 때 옮긴다)
 */
export function moveOffRight(dir: string, env: NodeJS.ProcessEnv): string | null {
  const record = readLayoutRecord(dir);
  if (record?.graphAt !== 'right') return null;
  const later = '그래프 칸의 오른쪽 자리는 없어졌어요. Herdr 앱에서 muwi 레이아웃을 보는 중에 muwi layout을 실행하면 터미널 아래로 옮겨요.';
  try {
    if (screenState(dir, env).shown !== record.name) return later;
    applyLayout(dir, env, { graphAt: 'bottom' });
    return '그래프 칸의 오른쪽 자리는 없어져서 터미널 아래로 옮겼어요. 위로 두려면 muwi layout --graph top';
  } catch (e) {
    // 앱이 닫혀 있으면 다음에, 손으로 고친 레이아웃이면 그 까닭(고치는 법)을 그대로 알린다
    if (e instanceof ScreenError) return `그래프 칸의 오른쪽 자리는 없어졌어요. ${e.message}`;
    throw e;
  }
}

/** 넣은 것을 뺀다. 화면을 바꿔 뒀으면 먼저 되돌린다 (그래프 칸을 빼면 그 레이아웃의 칸이 빈다) */
export function removeHerdr(installed: ViewInstall, o: { dir: string }) {
  if (fs.existsSync(path.join(o.dir, 'layout.json'))) layoutRemoved(guardScreen(() => removeLayout(o.dir)));
  if (installed.mod) fs.rmSync(installed.mod, { recursive: true, force: true });
}
