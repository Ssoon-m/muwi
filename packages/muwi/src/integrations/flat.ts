// 훅을 한 줄씩 납작하게 적는 설정 파일 (Copilot CLI, Cursor CLI):
//   { "version": 1, "hooks": { "<사건>": [ { "command": "…", "matcher": "…", "timeout": 10 } ] } }
// Mastra Code는 사건 표가 파일 맨 위에 있고(bare) matcher가 객체다: { "<사건>": [ { "command": "…", "matcher": { "tool_name": "…" } } ] }
// 남의 훅은 그대로 두고, 명령 앞의 표시로 우리 것만 알아보고 바꾼다.
import fs from 'node:fs';
import { backup, writeText } from './files.ts';
import { HOOK_MARK } from './settings-hooks.ts';

export type FlatEntry = { event: string; matcher?: string; command: string };
type FlatFile = { version?: number; hooks?: Record<string, unknown> } & Record<string, unknown>;

const ours = (h: unknown) => typeof (h as { command?: unknown })?.command === 'string' && (h as { command: string }).command.includes(HOOK_MARK);

function read(file: string): FlatFile {
  if (!fs.existsSync(file)) return {};
  let data: FlatFile;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`설정 파일이 JSON이 아니라서 고치지 않았어요: ${file}`);
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`설정 파일 모양이 달라서 고치지 않았어요: ${file}`);
  return data;
}

/** 파일의 모양: bare면 사건 표가 맨 위에 있다. version이면 "version": 1을 적는다. matcherAs: matcher를 적는 모양 */
export type FlatLayout = { bare?: boolean; version?: boolean; matcherAs?: (m: string) => unknown };

const tableOf = (data: FlatFile, bare?: boolean): Record<string, unknown> => (bare ? (data as Record<string, unknown>) : (data.hooks ?? {}));

function without(table: Record<string, unknown>): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(table)) {
    const kept = Array.isArray(list) ? list.filter(h => !ours(h)) : list;
    if (!Array.isArray(kept) || kept.length) hooks[event] = kept;
  }
  return hooks;
}

/** 우리 훅을 넣는다. 여러 번 해도 한 벌만 남는다. each: 훅 한 줄에 더 넣을 값 (type, timeout 등) */
export function installFlat(file: string, entries: FlatEntry[], each: Record<string, unknown> = {}, layout: FlatLayout = { version: true }) {
  const data = read(file);
  const hooks = without(tableOf(data, layout.bare));
  for (const e of entries) {
    const list = Array.isArray(hooks[e.event]) ? (hooks[e.event] as unknown[]) : [];
    const matcher = e.matcher !== undefined ? { matcher: layout.matcherAs ? layout.matcherAs(e.matcher) : e.matcher } : {};
    hooks[e.event] = [...list, { ...each, ...matcher, command: e.command }];
  }
  backup(file);
  const next = layout.bare ? hooks : { ...data, ...(layout.version ? { version: data.version ?? 1 } : {}), hooks };
  writeText(file, JSON.stringify(next, null, 2) + '\n');
}

/** 우리 훅만 뺀다. 우리 것만 있던 파일이면 지운다 */
export function uninstallFlat(file: string, layout: FlatLayout = { version: true }) {
  if (!fs.existsSync(file)) return;
  const data = read(file);
  const hooks = without(tableOf(data, layout.bare));
  const rest = layout.bare ? [] : Object.keys(data).filter(k => k !== 'version' && k !== 'hooks');
  if (!rest.length && !Object.keys(hooks).length) fs.rmSync(file, { force: true });
  else writeText(file, JSON.stringify(layout.bare ? hooks : { ...data, hooks }, null, 2) + '\n');
}
