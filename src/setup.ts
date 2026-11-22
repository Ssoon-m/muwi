// 플러그인이 해 주지 못하는 설치를 맡는다 (muwi setup).
//   Claude Code 플러그인으로 받으면 명령·훅·지침·사용법 skill은 Claude Code가 넣어 준다.
//   여기서 하는 일은 그 밖의 것: 터미널에서도 muwi 명령을 쓰게 하기, Herdr 앱 그래프 칸, Codex.
//   플러그인을 쓰지 않을 때는 --claude로 훅과 skill을 직접 넣는다.
// 남의 설정은 건드리지 않는다. 우리 것은 명령 경로와 구간 표시로 알아본다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nowIso, readJson, writeJson } from './store.ts';

/** 우리 훅은 명령 앞에 이 표시가 붙어 있다. 설치 위치가 어디든 이걸로 알아본다 */
export const HOOK_MARK = 'MUWI_HOOK=1';
const OURS = /(^|\s)MUWI_HOOK=1(\s|$)/;

/** 설정 파일에 넣을 훅 명령 */
export const hookCommandFor = (root: string) => `${HOOK_MARK} sh "${path.join(root, 'hooks', 'hook.sh')}"`;

type HookGroup = { matcher?: string; hooks?: { type?: string; command?: string }[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

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

/**
 * 우리 훅을 넣는다. 여러 번 해도 한 벌만 남는다. 플러그인의 hooks/hooks.json과 같은 구성이다.
 * 계획 알림(nudge)과 push 앞에서 묻기(guard)를 켜고 끄는 것은 muwi config가 한다.
 */
export function mergeHooks(settings: Settings, hookCommand: string): Settings {
  const base = removeHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(base.hooks ?? {}) };
  const add = (event: string, group: HookGroup) => {
    hooks[event] = [...(hooks[event] ?? []), group];
  };
  const cmd = (extra = '') => ({ type: 'command', command: `${hookCommand}${extra}` });
  add('SessionStart', { hooks: [cmd()] });
  add('SubagentStart', { hooks: [cmd()] });
  add('SubagentStop', { hooks: [cmd()] });
  add('PostToolUse', { matcher: 'Skill|Read', hooks: [cmd()] });
  add('PreToolUse', { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [cmd(' nudge')] });
  add('PreToolUse', { matcher: 'Bash', hooks: [cmd(' guard')] });
  return { ...base, hooks };
}

export const BLOCK_START = '<!-- muwi:start';
export const BLOCK_END = '<!-- muwi:end -->';

/** 지침 파일에서 우리 구간을 뺀다 */
export function removeBlock(text: string): string {
  const a = text.indexOf(BLOCK_START);
  if (a < 0) return text;
  const b = text.indexOf(BLOCK_END, a);
  if (b < 0) return text;
  const before = text.slice(0, a).replace(/\n+$/, '');
  const after = text.slice(b + BLOCK_END.length).replace(/^\n+/, '');
  if (!before) return after;
  if (!after) return before + '\n';
  return `${before}\n\n${after}`;
}

/** 지침 파일 끝에 우리 구간을 넣는다. 이미 있으면 새 내용으로 바꾼다 */
export function upsertBlock(text: string, block: string): string {
  const rest = removeBlock(text).replace(/\n+$/, '');
  const body = block.trim();
  return rest ? `${rest}\n\n${body}\n` : `${body}\n`;
}

/** 지침 원문에서 사람이 읽을 본문만 꺼낸다 (구간 표시 주석은 뺀다) */
export function instructionText(block: string): string {
  return block
    .split('\n')
    .filter(line => !line.startsWith(BLOCK_START) && !line.startsWith(BLOCK_END))
    .join('\n')
    .trim();
}

function backup(file: string) {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.muwi.bak`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

function writeText(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function installHooks(settingsFile: string, hookCommand: string) {
  let settings: Settings = {};
  if (fs.existsSync(settingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      throw new Error(`설정 파일이 JSON이 아니라서 고치지 않았어요: ${settingsFile}`);
    }
    if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`설정 파일 모양이 달라서 고치지 않았어요: ${settingsFile}`);
  }
  backup(settingsFile);
  writeText(settingsFile, JSON.stringify(mergeHooks(settings, hookCommand), null, 2) + '\n');
}

export function uninstallHooks(settingsFile: string) {
  if (!fs.existsSync(settingsFile)) return;
  let settings: Settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    throw new Error(`설정 파일이 JSON이 아니라서 고치지 않았어요: ${settingsFile}`);
  }
  writeText(settingsFile, JSON.stringify(removeHooks(settings), null, 2) + '\n');
}

export function installBlock(file: string, block: string) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  backup(file);
  writeText(file, upsertBlock(old, block));
}

export function uninstallBlock(file: string) {
  if (!fs.existsSync(file)) return;
  const old = fs.readFileSync(file, 'utf8');
  const next = removeBlock(old);
  if (next !== old) writeText(file, next);
}

// ── muwi setup ──────────────────────────────────────────────────────────

/** muwi setup이 무엇을 넣었는지. 다음 실행과 제거가 이걸 본다 */
export type Install = {
  root: string;
  version: string;
  bin?: string;
  herdr?: string;
  codex?: { agents: string; skill: string };
  claude?: { settings: string; skill: string };
  at: string;
};

export type Places = { home: string; bin: string; herdr: string; codex: string; claude: string };

export function places(env: NodeJS.ProcessEnv = process.env): Places {
  const home = env.HOME || os.homedir();
  return {
    home,
    bin: path.join(home, '.local', 'bin', 'muwi'),
    herdr: env.HERDR_APP_HOME || path.join(home, '.config', 'herdr-app'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  };
}

const installFile = (dir: string) => path.join(dir, 'install.json');
export const readInstall = (dir: string) => readJson<Install>(installFile(dir));

const WRAPPER_MARK = '# muwi setup이 만든 파일';

/** 터미널과 Herdr 앱에서 쓸 muwi 명령. 설치된 위치와 node를 절대 경로로 적어 둔다 */
function wrapper(root: string): string {
  return `#!/bin/sh\n${WRAPPER_MARK}. 고치지 말고 muwi setup을 다시 실행해요.\nexec "${process.execPath}" "${path.join(root, 'src', 'cli.ts')}" "$@"\n`;
}

function isOurWrapper(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(WRAPPER_MARK);
  } catch {
    return false;
  }
}

function copyDir(from: string, to: string, skip: (name: string) => boolean = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}

/** Herdr 앱 칸을 넣는다. 앱은 저장하는 즉시 다시 불러오므로 main.js를 마지막에 쓴다 */
function installMod(root: string, appHome: string): string {
  const from = path.join(root, 'herdr-app', 'muwi');
  const to = path.join(appHome, 'mods', 'muwi');
  const generated = (name: string) => name.endsWith('.d.ts') || name === 'jsconfig.json' || name === '.gitignore';
  copyDir(from, to, name => name === 'main.js' || generated(name));
  fs.copyFileSync(path.join(from, 'main.js'), path.join(to, 'main.js'));
  return to;
}

export type SetupOptions = { root: string; version: string; dir: string; env?: NodeJS.ProcessEnv; claude?: boolean; codex?: boolean; log?: (line: string) => void };

/**
 * 플러그인 밖의 것을 넣는다: 터미널용 명령, Herdr 앱 칸(앱이 있을 때).
 * codex를 주면 Codex에 지침과 사용법 skill을 넣는다 (Codex에는 훅이 없어 계획 기록만 된다).
 * claude를 주면 플러그인 없이 쓰는 경우로 보고 Claude Code 훅과 사용법 skill도 넣는다.
 * 전에 넣었던 것은 다시 실행할 때 옵션을 주지 않아도 새 위치로 맞춘다.
 */
export function runSetup(o: SetupOptions): Install {
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const p = places(env);
  const before = readInstall(o.dir);
  const install: Install = { root: o.root, version: o.version, at: nowIso() };
  const block = fs.readFileSync(path.join(o.root, 'hooks', 'instructions.md'), 'utf8');
  const skill = path.join(o.root, 'skills', 'muwi');

  if (fs.existsSync(p.bin) && !isOurWrapper(p.bin)) {
    log(`${p.bin}에 다른 파일이 있어서 명령은 넣지 않았어요.`);
  } else {
    writeText(p.bin, wrapper(o.root), 0o755);
    fs.chmodSync(p.bin, 0o755);
    install.bin = p.bin;
    log(`muwi 명령: ${p.bin}`);
  }

  if (fs.existsSync(p.herdr)) {
    install.herdr = installMod(o.root, p.herdr);
    log(`Herdr 앱 그래프 칸: ${install.herdr}`);
  } else {
    log('Herdr 앱이 없어 그래프 칸은 건너뛰었어요.');
  }

  if (o.codex || before?.codex) {
    const agents = path.join(p.codex, 'AGENTS.md');
    const to = path.join(p.codex, 'skills', 'muwi');
    installBlock(agents, block);
    fs.rmSync(to, { recursive: true, force: true });
    copyDir(skill, to);
    install.codex = { agents, skill: to };
    log(`Codex 지침과 사용법 skill: ${agents}, ${to}`);
  }

  if (o.claude || before?.claude) {
    const settings = path.join(p.claude, 'settings.json');
    const to = path.join(p.claude, 'skills', 'muwi');
    installHooks(settings, hookCommandFor(o.root));
    fs.rmSync(to, { recursive: true, force: true });
    copyDir(skill, to);
    install.claude = { settings, skill: to };
    log(`Claude Code 훅과 사용법 skill: ${settings}, ${to}`);
  }

  writeJson(installFile(o.dir), install);
  return install;
}

/** muwi setup이 넣은 것을 모두 뺀다. 기록은 남긴다 */
export function removeSetup(dir: string, log: (line: string) => void = () => {}) {
  const install = readInstall(dir);
  if (!install) {
    log('muwi setup으로 넣은 것이 없어요.');
    return;
  }
  if (install.bin && isOurWrapper(install.bin)) fs.rmSync(install.bin, { force: true });
  if (install.herdr) fs.rmSync(install.herdr, { recursive: true, force: true });
  if (install.codex) {
    uninstallBlock(install.codex.agents);
    fs.rmSync(install.codex.skill, { recursive: true, force: true });
  }
  if (install.claude) {
    uninstallHooks(install.claude.settings);
    fs.rmSync(install.claude.skill, { recursive: true, force: true });
  }
  fs.rmSync(installFile(dir), { force: true });
  log('muwi setup으로 넣은 것을 뺐어요. 기록 폴더는 그대로 있어요.');
}

/**
 * 플러그인이 업데이트되면 설치 위치가 바뀐다. 전에 setup을 한 적이 있고 위치나 버전이 달라졌으면 다시 맞춘다.
 * 세션이 시작될 때마다 부르므로, 달라진 게 없으면 파일 하나만 읽고 끝난다.
 */
export function refreshSetup(o: SetupOptions): boolean {
  const install = readInstall(o.dir);
  if (!install || (install.root === o.root && install.version === o.version)) return false;
  runSetup(o);
  return true;
}

/** Herdr 앱 칸이 문제없이 불리는지 앱에 확인받는다. 앱 명령이 없으면 건너뛴다 */
export function checkMod(modDir: string): string | null {
  const r = spawnSync('herdr-app', ['check', modDir], { encoding: 'utf8' });
  if (r.error) return null;
  return r.status === 0 ? 'ok' : (r.stdout + r.stderr).trim();
}
