// muwi setup: npm으로 받은 muwi를 쓸 수 있게 넣는다.
//   터미널과 그래프 칸이 부를 muwi 명령(~/.local/bin), 화면(Herdr 앱의 그래프 칸), 고른 AI 도구에 커넥터(지침·사용법 skill·훅).
//   화면에 무엇을 넣는지는 화면이 안다 (화면 규격의 setup). 여기서는 부르고 기록한다.
//   도구마다 무엇을 어디에 넣는지는 그 도구의 커넥터가 안다 (src/connectors). 여기서는 고른 도구들에 차례로 넣고 기록한다.
// 남의 설정은 건드리지 않는다. 우리 것은 명령 앞의 표시와 구간 표시로 알아본다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { host, hostFailure, hostPath, type HostInstall } from './host.ts';
import { nowIso, readJson, writeJson } from './store.ts';
import { copyDir, installBlock, shPath, uninstallBlock, writeText } from './connectors/files.ts';
import { adapterOf } from './connectors/index.ts';
import { TOOLS, toolHome, toolSkills, type Tool } from './connectors/tools.ts';
import type { Wired } from './connectors/types.ts';

export { BLOCK_END, BLOCK_START, installBlock, instructionText, removeBlock, uninstallBlock, upsertBlock } from './connectors/files.ts';
export { HOOK_MARK, removeHooks } from './connectors/settings-hooks.ts';
export { hookCommandFor, installHooks, mergeHooks, uninstallHooks } from './connectors/claude.ts';

// ── muwi setup ──────────────────────────────────────────────────────────

/** muwi setup이 무엇을 넣었는지. 다음 실행과 제거가 이걸 본다 */
export type Install = {
  root: string;
  version: string;
  bin?: string;
  /** Windows에서 넣은 muwi.cmd */
  cmd?: string;
  /** 화면 모듈의 경로. muwi 명령과 훅이 이 경로에서 화면을 불러온다 (host.ts의 loadHost) */
  host?: string;
  /** 화면이 넣은 것 (Herdr 앱의 칸 등). 뺄 때 화면에 그대로 돌려준다 */
  hosted?: HostInstall;
  /** 0.6.0까지의 기록: 넣은 Herdr 앱 칸 */
  herdr?: string;
  /** 커넥터를 넣은 도구들 (도구 id → 넣은 것) */
  tools?: Record<string, ToolInstall>;
  /** 0.5.x의 기록. tools.codex, tools.claude와 같은 것을 옛 이름으로도 남긴다 */
  codex?: { agents: string; skill: string };
  claude?: { settings: string; skill: string };
  at: string;
};

/** 한 도구에 넣은 것: 지침 구간을 넣은 파일, 사용법 skill 폴더, 훅·플러그인 */
export type ToolInstall = { instructions?: string; skill?: string } & Wired;

export type Places = { home: string; bin: string; cmd: string; nodeCache: string };

export function places(env: NodeJS.ProcessEnv = process.env): Places {
  const home = env.HOME || os.homedir();
  return {
    home,
    bin: path.join(home, '.local', 'bin', 'muwi'),
    // Windows의 PowerShell·cmd와 Herdr 앱 그래프 칸이 쓰는 명령 (sh 스크립트는 Git Bash에서만 실행된다)
    cmd: path.join(home, '.local', 'bin', 'muwi.cmd'),
    // src/find-node.sh가 로그인 셸에서 찾은 Node 경로를 적어 두는 곳
    nodeCache: path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'muwi', 'node'),
  };
}

/**
 * 설치 기록. 0.5.4까지는 install.json에 적었다.
 * 0.4.0·0.5.0의 훅은 세션이 시작될 때마다(압축·/clear 포함) install.json의 버전이 자기와 다르면 자기 버전으로 setup을
 * 다시 해서, 새 버전의 그래프 칸을 옛것으로 덮어썼다. 새 이름에 적으면 그 세션들은 기록을 찾지 못해 아무것도 하지 않는다.
 * install.json은 0.5.4 이하에서 올라올 때만 읽고, setup이 기록을 새로 적을 때 지운다.
 */
const installFile = (dir: string) => path.join(dir, 'setup.json');
const legacyInstallFile = (dir: string) => path.join(dir, 'install.json');
export const readInstall = (dir: string) => readJson<Install>(installFile(dir)) ?? readJson<Install>(legacyInstallFile(dir));

const WRAPPER_MARK = '# muwi setup이 만든 파일';
/** muwi.cmd의 표시. cmd.exe가 읽는 파일이라 ASCII로 적는다 */
const CMD_MARK = 'rem Created by muwi setup.';

/**
 * 터미널과 Herdr 앱에서 쓸 muwi 명령. 설치된 위치의 bin/muwi를 부른다.
 * Node는 실행할 때마다 bin/muwi가 찾는다 (nvm 기본 버전을 바꾸면 따라간다).
 * setup을 실행한 Node는 다른 곳에서 못 찾을 때만 쓴다.
 */
function wrapper(root: string, platform: NodeJS.Platform): string {
  return `#!/bin/sh\n${WRAPPER_MARK}. 고치지 말고 muwi setup을 다시 실행해요.\nMUWI_SETUP_NODE="${shPath(process.execPath, platform)}" exec "${shPath(path.join(root, 'bin', 'muwi'), platform)}" "$@"\n`;
}

/** 설치된 곳의 명령 파일: npm으로 받은 사본은 .js로 바꾼 cli.js, 저장소에서는 cli.ts */
const cliFile = (root: string) => {
  const js = path.join(root, 'src', 'cli.js');
  return fs.existsSync(js) ? js : path.join(root, 'src', 'cli.ts');
};

/**
 * Windows의 PowerShell·cmd에서 쓸 muwi.cmd. setup을 실행한 Node로 cli.ts를 바로 실행한다.
 * 그 Node가 없어졌으면 PATH의 node를 쓴다 (Windows의 Herdr 앱이 띄운 프로그램도 사용자 PATH를 받는다)
 */
function cmdWrapper(root: string): string {
  return [
    '@echo off',
    `${CMD_MARK} Do not edit. Run muwi setup again.`,
    'setlocal',
    `set "MUWI_NODE=${process.execPath}"`,
    'if not exist "%MUWI_NODE%" set "MUWI_NODE=node"',
    `"%MUWI_NODE%" "${cliFile(root)}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function isOurWrapper(file: string): boolean {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes(WRAPPER_MARK) || text.includes(CMD_MARK);
  } catch {
    return false;
  }
}

export type SetupOptions = {
  root: string; version: string; dir: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void;
  /** 커넥터를 넣을 도구들 (도구 id). claude, codex는 --claude, --codex의 옛 이름 */
  tools?: string[];
  claude?: boolean;
  codex?: boolean;
  /** 어느 OS에 넣는가 (테스트가 Windows를 흉내 낼 때 준다) */
  platform?: NodeJS.Platform;
  /** 사람이 muwi setup을 실행했다: 화면이 점검하고 화면 상태를 알린다 (훅이 업데이트 뒤에 다시 맞출 때는 아니다) */
  report?: boolean;
};

/**
 * 넣는다: 터미널용 명령, 화면(Herdr 앱 칸), 고른 도구들의 커넥터.
 * 커넥터는 그 도구에 지침, 사용법 skill, 훅(또는 플러그인 파일)을 넣는다. 전에 넣었던 도구는 다시 실행할 때 고르지 않아도 새 판으로 맞춘다.
 */
export function runSetup(o: SetupOptions): Install {
  const env = o.env ?? process.env;
  const log = o.log ?? (() => {});
  const platform = o.platform ?? process.platform;
  const p = places(env);
  let before: Install | null = null;
  try {
    before = readInstall(o.dir);
  } catch (e: any) {
    // 기록이 깨졌다: 새로 적는다. 무엇을 넣었는지 모르므로 전에 넣은 도구는 다시 골라야 한다
    log(`${e?.message ?? e}. 새로 적어요. 전에 커넥터를 넣은 도구가 있으면 다시 골라 주세요 (muwi setup --tool <도구>).`);
  }
  const install: Install = { root: o.root, version: o.version, at: nowIso() };
  const block = fs.readFileSync(path.join(o.root, 'hooks', 'instructions.md'), 'utf8');
  const skill = path.join(o.root, 'skills', 'muwi');

  // Node를 바꿨으면 setup을 다시 실행해서 알린다. 다음 실행 때 로그인 셸에서 다시 찾는다
  fs.rmSync(p.nodeCache, { force: true });

  if (fs.existsSync(p.bin) && !isOurWrapper(p.bin)) {
    log(`${p.bin}에 다른 파일이 있어서 명령은 넣지 않았어요.`);
  } else {
    writeText(p.bin, wrapper(o.root, platform), 0o755);
    fs.chmodSync(p.bin, 0o755);
    install.bin = p.bin;
    log(`muwi 명령: ${p.bin}`);
  }
  // Windows: PowerShell·cmd와 Herdr 앱 그래프 칸이 쓰는 muwi.cmd도 넣는다 (sh 스크립트는 Git Bash에서만 실행된다)
  if (platform === 'win32') {
    if (fs.existsSync(p.cmd) && !isOurWrapper(p.cmd)) {
      log(`${p.cmd}에 다른 파일이 있어서 muwi.cmd는 넣지 않았어요.`);
    } else {
      writeText(p.cmd, cmdWrapper(o.root));
      install.cmd = p.cmd;
      log(`muwi 명령 (PowerShell·cmd): ${p.cmd}`);
    }
  }

  // 화면(Herdr 앱의 그래프 칸 등). 화면을 불러온 경로를 적어 두면 muwi 명령과 훅이 그 화면을 쓴다
  const h = host();
  if (h.setup) {
    const hosted = h.setup({ root: o.root, dir: o.dir, env, log, report: o.report });
    if (hosted) install.hosted = hosted;
  }
  const from = hostPath();
  const failed = hostFailure();
  if (from) install.host = from;
  else if (failed && before?.host) {
    // 적어 둔 화면을 불러오지 못했다 (화면 패키지를 지웠거나 옮겼다). 화면이 넣은 것을 모르므로 전 기록을 그대로 둔다.
    // 지우면 그 뒤로 명령과 훅이 화면을 다시 불러오지 않고, setup --remove가 화면이 넣은 것을 빼지 못한다
    install.host = before.host;
    if (before.hosted) install.hosted = before.hosted;
    log(`화면을 불러오지 못해서 화면이 넣은 것은 그대로 뒀어요: ${failed.from} (${failed.reason}). 화면 패키지를 옮겼으면 그 패키지의 muwi로 muwi setup을 다시 실행하세요.`);
  }

  const want = new Set<string>([
    ...(o.tools ?? []), ...(o.claude ? ['claude'] : []), ...(o.codex ? ['codex'] : []),
    ...Object.keys(before?.tools ?? {}), ...(before?.claude ? ['claude'] : []), ...(before?.codex ? ['codex'] : []),
  ]);
  // 표의 순서대로 넣는다
  for (const tool of TOOLS.filter(t => want.has(t.id))) {
    const done = installTool(tool, { root: o.root, env, platform, home: toolHome(tool, env, p.home) }, p.home, block, skill);
    if (tool.note) log(`  ${tool.note}`);
    install.tools = { ...(install.tools ?? {}), [tool.id]: done };
    log(`${tool.name} 커넥터: ${[done.instructions, done.skill, ...(done.settings ?? []), ...(done.files ?? [])].filter(Boolean).join(', ')}`);
  }
  // 0.5.x가 읽던 이름으로도 남긴다
  const codex = install.tools?.codex, claude = install.tools?.claude;
  if (codex?.instructions && codex.skill) install.codex = { agents: codex.instructions, skill: codex.skill };
  if (claude?.settings?.[0] && claude.skill) install.claude = { settings: claude.settings[0], skill: claude.skill };

  writeJson(installFile(o.dir), install);
  fs.rmSync(legacyInstallFile(o.dir), { force: true });
  return install;
}

/** 한 도구에 커넥터를 넣는다: 지침(늘 읽히는 파일이 있으면), 사용법 skill, 훅 */
function installTool(tool: Tool, ctx: { root: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }, userHome: string, block: string, skill: string): ToolInstall {
  const done: ToolInstall = {};
  if (tool.instructions) {
    done.instructions = path.join(ctx.home, tool.instructions);
    installBlock(done.instructions, block);
  }
  const skills = toolSkills(tool, ctx.home, userHome);
  if (skills) {
    done.skill = path.join(skills, 'muwi');
    fs.rmSync(done.skill, { recursive: true, force: true });
    copyDir(skill, done.skill);
  }
  const wired = adapterOf(tool.id)?.install(ctx);
  return { ...done, ...(wired ?? {}) };
}

function removeTool(id: string, done: ToolInstall) {
  if (done.instructions) uninstallBlock(done.instructions);
  if (done.skill) fs.rmSync(done.skill, { recursive: true, force: true });
  adapterOf(id)?.remove(done);
}

/** 이 컴퓨터에 깔려 있는 도구들 (설정 폴더가 있는 것) */
export function installedTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  const home = places(env).home;
  return TOOLS.filter(t => fs.existsSync(toolHome(t, env, home)));
}

/** muwi setup이 넣은 것을 모두 뺀다. 기록은 남긴다 */
export function removeSetup(dir: string, log: (line: string) => void = () => {}) {
  const install = readInstall(dir);
  if (!install) {
    log('muwi setup으로 넣은 것이 없어요.');
    return;
  }
  if (install.bin && isOurWrapper(install.bin)) fs.rmSync(install.bin, { force: true });
  if (install.cmd && isOurWrapper(install.cmd)) fs.rmSync(install.cmd, { force: true });
  // 화면이 넣은 것은 화면이 뺀다. 0.6.0까지의 기록(herdr)은 Herdr 앱 칸 폴더다
  const hosted = install.hosted ?? (install.herdr ? { mod: install.herdr } : null);
  if (hosted) {
    const h = host();
    if (h.remove) h.remove(hosted, { dir, log });
    else {
      if (hosted.mod) fs.rmSync(hosted.mod, { recursive: true, force: true });
      const failed = hostFailure();
      if (failed && install.hosted) log(`화면을 불러오지 못해서 화면 칸만 뺐어요: ${failed.from} (${failed.reason}). 화면이 바꾼 것(레이아웃 등)은 되돌리지 못했어요.`);
    }
  }
  // 0.5.x의 기록(tools 없이 codex, claude만 있다)도 같은 모양으로 읽는다
  const tools: Record<string, ToolInstall> = {
    ...(install.codex ? { codex: { instructions: install.codex.agents, skill: install.codex.skill } } : {}),
    ...(install.claude ? { claude: { settings: [install.claude.settings], skill: install.claude.skill } } : {}),
    ...(install.tools ?? {}),
  };
  for (const [id, done] of Object.entries(tools)) removeTool(id, done);
  fs.rmSync(installFile(dir), { force: true });
  fs.rmSync(legacyInstallFile(dir), { force: true });
  log('muwi setup으로 넣은 것을 뺐어요. 기록 폴더는 그대로 있어요.');
}

/**
 * muwi를 업데이트하면 버전이(설치 방법에 따라 위치도) 바뀐다. 전에 setup을 한 적이 있고 위치나 버전이 달라졌으면 다시 맞춘다.
 * 세션이 시작될 때마다 부르므로, 달라진 게 없으면 파일 하나만 읽고 끝난다.
 */
export function refreshSetup(o: SetupOptions): boolean {
  let install: Install | null;
  try {
    install = readInstall(o.dir);
  } catch {
    // 기록이 깨졌다: 맞추지 않는다 (훅은 이것 때문에 지침을 못 주면 안 된다. muwi setup을 다시 하면 새로 적는다)
    return false;
  }
  if (!install || (install.root === o.root && install.version === o.version)) return false;
  // 업데이트하기 전부터 열려 있던 세션이 옛 판의 훅을 쓰더라도 새 설치를 옛 판으로 되돌리지 않는다
  if (olderThan(o.version, install.version)) return false;
  runSetup(o);
  return true;
}

/**
 * PATH에 있는 다른 muwi 중 이 판보다 새 판. 없으면 null.
 * npm i -g는 Node마다 다른 자리에 깐다 (nvm으로 Node를 바꾸고 새로 깔았을 때). 그러면 훅과 ~/.local/bin/muwi는 옛 자리를 가리키고,
 * ~/.local/bin이 PATH 앞에 있으면 muwi setup도 옛 판이 돈다. 그 판이 스스로 알아챌 길은 PATH뿐이라 PATH를 본다.
 *   macOS·Linux: <자리>/bin/muwi는 <자리>/lib/node_modules/<패키지>/bin/muwi.js로 가는 링크다
 *   Windows: <자리>/muwi.cmd 옆의 <자리>/node_modules/<패키지>
 */
export function newerElsewhere(version: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { bin: string; version: string } | null {
  let newest: { bin: string; version: string } | null = null;
  for (const d of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const pkg of packagesAt(d, platform)) {
      let v: string | undefined;
      try {
        const m = readJson<{ name?: string; version?: string }>(path.join(pkg.root, 'package.json'));
        if (m?.name && PACKAGE_NAMES.includes(m.name)) v = m.version;
      } catch {
        continue;
      }
      if (v && olderThan(newest?.version ?? version, v)) newest = { bin: pkg.bin, version: v };
    }
  }
  return newest;
}

/** npm에 올리는 muwi 패키지들 (둘 다 muwi 명령을 낸다) */
const PACKAGE_NAMES = ['@muwi/herdr-app', '@muwi/core'];

function packagesAt(dir: string, platform: NodeJS.Platform): { bin: string; root: string }[] {
  if (platform === 'win32') {
    const bin = path.join(dir, 'muwi.cmd');
    if (!fs.existsSync(bin)) return [];
    return PACKAGE_NAMES.map(name => ({ bin, root: path.join(dir, 'node_modules', ...name.split('/')) }));
  }
  const bin = path.join(dir, 'muwi');
  try {
    const real = fs.realpathSync(bin);
    return real.endsWith(`${path.sep}bin${path.sep}muwi.js`) ? [{ bin, root: path.dirname(path.dirname(real)) }] : [];
  } catch {
    return [];
  }
}

/** a가 b보다 낮은 버전인가 (1.2.10 > 1.2.9) */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}
