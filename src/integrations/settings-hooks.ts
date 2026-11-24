// JSON 설정 파일의 hooks에 명령을 거는 방식. Claude Code가 이 모양이고, 여러 도구가 같은 모양을 따른다.
//   { "hooks": { "<사건>": [ { "matcher": "<도구 이름>", "hooks": [ { "type": "command", "command": "…" } ] } ] } }
import fs from 'node:fs';
import { backup, writeText } from './files.ts';

/** 우리 훅은 명령 앞에 이 표시가 붙어 있다. 설치 위치가 어디든 이걸로 알아본다 */
export const HOOK_MARK = 'MUWI_HOOK=1';
const OURS = /(^|\s)MUWI_HOOK=1(\s|$)/;

export type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string; onFailure?: string }[] };
export type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const isOurCommand = (c: unknown) => typeof c === 'string' && OURS.test(c);
const isOurs = (g: HookGroup) => (g.hooks ?? []).some(h => isOurCommand(h.command));

/** 설정에서 우리 훅만 뺀다. 한 묶음에 남의 훅이 같이 있으면 우리 것만 빼고 묶음은 남긴다 */
export function removeHooks(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map(g => (isOurs(g) ? { ...g, hooks: (g.hooks ?? []).filter(h => !isOurCommand(h.command)) } : g))
      .filter(g => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete (next as Settings).hooks;
  return next;
}

/** 걸 훅 하나: 어느 사건에, 어떤 도구에(matcher), 어떤 명령을 */
export type HookEntry = { event: string; matcher?: string; command: string; extra?: Record<string, unknown> };

/** 우리 훅을 넣는다. 여러 번 해도 한 벌만 남는다 (먼저 우리 것을 빼고 다시 넣는다) */
export function addHooks(settings: Settings, entries: HookEntry[]): Settings {
  const base = removeHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(base.hooks ?? {}) };
  for (const e of entries) {
    const group: HookGroup = { ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), hooks: [{ type: 'command', command: e.command, ...(e.extra ?? {}) }] };
    hooks[e.event] = [...(hooks[e.event] ?? []), group];
  }
  return { ...base, hooks };
}

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  let settings: Settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`설정 파일이 JSON이 아니라서 고치지 않았어요: ${file}`);
  }
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`설정 파일 모양이 달라서 고치지 않았어요: ${file}`);
  return settings;
}

/** 설정 파일에 우리 훅을 넣는다 (없으면 만든다). 처음 고칠 때 원본을 .muwi.bak으로 남긴다 */
export function installEntries(file: string, entries: HookEntry[]) {
  const settings = readSettings(file);
  backup(file);
  writeText(file, JSON.stringify(addHooks(settings, entries), null, 2) + '\n');
}

/** 설정 파일에서 우리 훅만 뺀다 */
export function uninstallEntries(file: string) {
  if (!fs.existsSync(file)) return;
  writeText(file, JSON.stringify(removeHooks(readSettings(file)), null, 2) + '\n');
}
