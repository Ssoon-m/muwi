import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  installBlock, instructionText, newerElsewhere, readInstall, refreshSetup, removeBlock, removeHooks,
  olderThan, removeSetup, runSetup, uninstallBlock, upsertBlock,
} from '../src/setup.ts';
import { installHooks, mergeHooks, uninstallHooks } from '../src/connectors/claude.ts';
import { toolCommand } from '../src/connectors/settings-hooks.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
/** sh 래퍼는 Windows에서도 슬래시 경로로 적는다 (Git Bash가 읽기 쉽게) */
const posix = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
const HOOK = toolCommand('/Users/me/tools/muwi', 'claude');
const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/other/guard.sh' }] };
const ours = (extra = '') => ({ type: 'command', command: `${HOOK}${extra}`, onFailure: 'continue' });

test('훅 넣기: 남의 훅은 그대로 두고 우리 것만 한 벌 넣는다', () => {
  const start = { model: 'opus', hooks: { PreToolUse: [theirs], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const once = mergeHooks(start, HOOK);
  assert.deepEqual(mergeHooks(once, HOOK), once);
  assert.equal(once.model, 'opus');
  assert.deepEqual(once.hooks!.SessionStart, [{ hooks: [ours()] }]);
  assert.deepEqual(once.hooks!.PostToolUse, [{ matcher: 'Skill|Read', hooks: [ours()] }]);
  assert.deepEqual(once.hooks!.PreToolUse, [
    theirs,
    { matcher: 'Bash', hooks: [ours(' command')] },
  ]);
  assert.deepEqual(removeHooks(once), start);
  // 설치 위치가 바뀌어도 옛 위치의 우리 훅을 알아보고 바꾼다
  const moved = mergeHooks(once, toolCommand('/somewhere/else', 'claude'));
  assert.equal(JSON.stringify(moved).includes('/Users/me/tools/muwi'), false);
  assert.equal(moved.hooks!.PreToolUse.length, 2); // 남의 훅 하나와 우리 것 하나 (셸 명령 앞)
  assert.deepEqual(removeHooks(mergeHooks({ theme: 'dark' }, HOOK)), { theme: 'dark' });
});

test('훅 넣기: 설정 파일을 고치기 전에 원본을 남기고, JSON이 아니면 건드리지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-setup-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"model":"opus"}');
  installHooks(file, HOOK);
  assert.equal(fs.readFileSync(`${file}.muwi.bak`, 'utf8'), '{"model":"opus"}');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart.length, 1);
  uninstallHooks(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus' });
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ // 주석\n}');
  assert.throws(() => installHooks(broken, HOOK), /JSON이 아니라서/);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ // 주석\n}');
});

const BLOCK = '<!-- muwi:start (설명) -->\n## 작업 진행 방식\n- 계획을 적는다\n<!-- muwi:end -->\n';

test('지침 구간: 다른 내용은 그대로 두고 우리 구간만 넣고, 바꾸고, 뺀다', () => {
  const mine = '# 내 규칙\n\n- 한국어로 답한다\n';
  const added = upsertBlock(mine, BLOCK);
  assert.equal(added, `${mine}\n${BLOCK}`);
  assert.equal(upsertBlock(added, BLOCK), added);
  const changed = upsertBlock(added, BLOCK.replace('계획을 적는다', '계획을 적고 시작한다'));
  assert.match(changed, /계획을 적고 시작한다/);
  assert.equal(changed.match(/muwi:start/g)!.length, 1);
  assert.equal(removeBlock(changed), mine);
  assert.equal(upsertBlock('', BLOCK), BLOCK);
  assert.equal(removeBlock(BLOCK), '');
  assert.equal(removeBlock(`${added}\n## 나중에 적은 것\n`), `${mine}\n## 나중에 적은 것\n`);
  assert.equal(instructionText(BLOCK), '## 작업 진행 방식\n- 계획을 적는다');
});

test('지침 구간: 파일에 쓰고 뺀다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-setup-'));
  const file = path.join(dir, 'AGENTS.md');
  installBlock(file, BLOCK);
  assert.equal(fs.readFileSync(file, 'utf8'), BLOCK);
  fs.writeFileSync(file, `# 내 규칙\n\n${BLOCK}`);
  uninstallBlock(file);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 내 규칙\n');
});

/** 빈 홈 폴더를 만든다. with에 적은 도구만 설치돼 있는 것으로 친다 */
function home(...tools: 'codex'[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-home-'));
  if (tools.includes('codex')) fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  const env = { HOME: dir } as NodeJS.ProcessEnv;
  return { dir, env, records: path.join(dir, '.muwi') };
}

test('muwi setup: 있는 도구에만 넣고, 무엇을 넣었는지 적어 둔다', () => {
  const h = home();
  const lines: string[] = [];
  // 로그인 셸에서 찾아 둔 Node 경로는 setup을 다시 하면 버린다
  const nodeCache = path.join(h.dir, '.cache', 'muwi', 'node');
  fs.mkdirSync(path.dirname(nodeCache), { recursive: true });
  fs.writeFileSync(nodeCache, '/old/node\n');
  const install = runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, log: l => lines.push(l) });
  assert.equal(fs.existsSync(nodeCache), false);
  // 터미널용 명령은 항상. 설치 위치의 bin/muwi를 부르고, setup을 실행한 node는 못 찾을 때만 쓰도록 넘긴다
  const bin = path.join(h.dir, '.local', 'bin', 'muwi');
  assert.equal(install.bin, bin);
  assert.ok(fs.readFileSync(bin, 'utf8').includes(`MUWI_SETUP_NODE="${posix(process.execPath)}" exec "${posix(path.join(ROOT, 'bin', 'muwi'))}"`));
  // Windows는 실행 권한 비트가 없다 (Git Bash는 #! 줄을 보고 실행한다)
  if (process.platform !== 'win32') assert.ok(fs.statSync(bin).mode & 0o100);
  // 터미널 연결과 보기가 없으면 적지 않는다. 고르지 않은 도구(Claude Code 포함)에는 커넥터를 넣지 않는다
  assert.equal(install.terminals, undefined);
  assert.equal(install.views, undefined);
  assert.equal(install.tools, undefined);
  assert.equal(fs.existsSync(path.join(h.dir, '.claude')), false);
  assert.deepEqual(readInstall(h.records), install);
});

test('muwi setup: --tool codex를 주면 Codex 지침·skill을 넣고, --remove로 뺀다', () => {
  const h = home('codex');
  fs.writeFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), '# 내 Codex 규칙\n');
  // Codex가 있어도 고르지 않으면 건드리지 않는다
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  assert.equal(fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8'), '# 내 Codex 규칙\n');
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, tools: ['codex'] });
  // 한 번 넣은 뒤로는 옵션 없이 다시 실행해도 유지한다 (업데이트 때 새 위치로 맞추기 위해)
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  const agents = fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# 내 Codex 규칙\n\n<!-- muwi:start/);
  // 사용법 skill은 Codex가 읽는 ~/.agents/skills에 넣는다
  assert.ok(fs.existsSync(path.join(h.dir, '.agents', 'skills', 'muwi', 'SKILL.md')));

  removeSetup(h.records);
  assert.equal(fs.existsSync(path.join(h.dir, '.local', 'bin', 'muwi')), false);
  assert.equal(fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8'), '# 내 Codex 규칙\n');
  assert.equal(fs.existsSync(path.join(h.dir, '.agents', 'skills', 'muwi')), false);
  assert.equal(readInstall(h.records), null);
});

test('muwi setup --tool claude: Claude Code에 훅과 사용법 skill을 넣는다', () => {
  const h = home();
  fs.mkdirSync(path.join(h.dir, '.claude'));
  fs.writeFileSync(path.join(h.dir, '.claude', 'settings.json'), '{"model":"opus"}');
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, tools: ['claude'] });
  const settings = JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, toolCommand(ROOT, 'claude'));
  // 세션이 일하는지 기다리는지, 끝났는지를 알려 주는 훅도 건다 (화면 없이 세션 상태를 아는 길)
  for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd']) assert.equal(settings.hooks[event][0].hooks[0].command, toolCommand(ROOT, 'claude'));
  assert.ok(fs.existsSync(path.join(h.dir, '.claude', 'skills', 'muwi', 'SKILL.md')));
  // 지침은 훅이 세션마다 넣어 주므로 CLAUDE.md는 건드리지 않는다
  assert.equal(fs.existsSync(path.join(h.dir, '.claude', 'CLAUDE.md')), false);
  removeSetup(h.records);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8')), { model: 'opus' });
  assert.equal(fs.existsSync(path.join(h.dir, '.claude', 'skills', 'muwi')), false);
});

test('muwi setup: 남이 만든 muwi 명령은 덮어쓰지 않는다', () => {
  const h = home();
  const bin = path.join(h.dir, '.local', 'bin', 'muwi');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\necho other\n');
  const install = runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  assert.equal(install.bin, undefined);
  assert.equal(fs.readFileSync(bin, 'utf8'), '#!/bin/sh\necho other\n');
});

test('업데이트로 설치 위치나 버전이 바뀌면, setup을 한 적이 있을 때만 다시 맞춘다', () => {
  const h = home();
  // setup을 한 적이 없으면 아무것도 넣지 않는다
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  assert.equal(fs.existsSync(path.join(h.dir, '.local')), false);
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  // 새 버전이 다른 위치에 깔렸다
  const next = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-next-'));
  for (const d of ['hooks', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(next, d), { recursive: true });
  assert.equal(refreshSetup({ root: next, version: '0.2.0', dir: h.records, env: h.env }), true);
  assert.ok(fs.readFileSync(path.join(h.dir, '.local', 'bin', 'muwi'), 'utf8').includes(`"${posix(path.join(next, 'bin', 'muwi'))}"`));
  assert.equal(readInstall(h.records)!.version, '0.2.0');
  // 업데이트 전부터 열려 있던 세션(옛 버전)이 새로 시작해도 새 설치를 되돌리지 않는다
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  assert.equal(readInstall(h.records)!.version, '0.2.0');
  assert.ok(fs.readFileSync(path.join(h.dir, '.local', 'bin', 'muwi'), 'utf8').includes(`"${posix(path.join(next, 'bin', 'muwi'))}"`));
  assert.equal(olderThan('0.9.0', '0.10.0'), true);
  assert.equal(olderThan('0.10.0', '0.9.0'), false);
  assert.equal(olderThan('0.5.0', '0.5.0'), false);
});

test('muwi setup (Windows): PowerShell·cmd에서 쓸 muwi.cmd를 넣고, 뺄 때 같이 뺀다', () => {
  const h = home();
  const install = runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, platform: 'win32' });
  const cmd = path.join(h.dir, '.local', 'bin', 'muwi.cmd');
  assert.equal(install.cmd, cmd);
  const text = fs.readFileSync(cmd, 'utf8');
  // cmd.exe가 읽는 파일: 줄바꿈은 CRLF, 설치한 Node로 cli.ts를 바로 실행하고 그 Node가 없으면 PATH의 node
  assert.match(text, /^@echo off\r\n/);
  assert.equal(/[^\r]\n/.test(text), false);
  assert.ok(text.includes(`set "MUWI_NODE=${process.execPath}"`));
  assert.ok(text.includes('if not exist "%MUWI_NODE%" set "MUWI_NODE=node"'));
  assert.ok(text.includes(`"%MUWI_NODE%" "${path.join(ROOT, 'src', 'cli.ts')}" %*`));
  // Git Bash에서 쓸 sh 래퍼도 넣는다. 경로는 슬래시로 적는다
  assert.ok(fs.readFileSync(path.join(h.dir, '.local', 'bin', 'muwi'), 'utf8').includes(`exec "${posix(path.join(ROOT, 'bin', 'muwi'))}"`));
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/d', '/c', cmd, '--version'], { encoding: 'utf8' });
    assert.match(r.stdout, /^\d+\.\d+\.\d+/, r.stderr);
  }
  removeSetup(h.records);
  assert.equal(fs.existsSync(cmd), false);
});

test('npm이 거는 muwi 명령(bin/muwi.js): 다른 폴더에 걸린 링크로 실행해도 패키지의 명령을 찾는다', { skip: process.platform === 'win32' && '링크 대신 npm이 만든 muwi.cmd를 쓴다 (패키지 확인에서 실행해 본다)' }, () => {
  // npm i -g는 <prefix>/bin/muwi를 패키지의 bin 파일로 가는 링크로 건다. 링크가 있는 폴더를 기준으로 찾으면 실행되지 않는다
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-bin-')), 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(ROOT, 'bin', 'muwi.js'), path.join(bin, 'muwi'));
  const r = spawnSync(process.execPath, [path.join(bin, 'muwi'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
});

test('다른 자리의 더 새 muwi를 PATH에서 찾는다 (nvm으로 Node를 바꾸고 새로 깐 경우)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-newer-'));
  /** npm i -g가 까는 모양: 패키지 폴더와 PATH에 걸리는 명령. 돌려주는 것은 PATH에 넣을 폴더 */
  const npmGlobal = (prefix: string, name: string, version: string, platform: NodeJS.Platform) => {
    const pkg = path.join(tmp, prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(pkg, 'bin', 'muwi.js'), '');
    if (platform === 'win32') {
      fs.writeFileSync(path.join(tmp, prefix, 'muwi.cmd'), '@echo off');
      return path.join(tmp, prefix);
    }
    fs.mkdirSync(path.join(tmp, prefix, 'bin'));
    fs.symlinkSync(path.join(pkg, 'bin', 'muwi.js'), path.join(tmp, prefix, 'bin', 'muwi'));
    return path.join(tmp, prefix, 'bin');
  };
  const PATH = (...dirs: string[]) => ({ PATH: dirs.join(path.delimiter) });
  // Windows: muwi.cmd 옆의 node_modules
  const w1 = npmGlobal('w-old', '@muwi/herdr-app', '0.7.0', 'win32');
  const w2 = npmGlobal('w-new', '@muwi/herdr-app', '0.7.2', 'win32');
  assert.deepEqual(newerElsewhere('0.7.0', PATH(w1, w2), 'win32'), { bin: path.join(w2, 'muwi.cmd'), version: '0.7.2' });
  assert.equal(newerElsewhere('0.7.2', PATH(w1, w2), 'win32'), null);
  if (process.platform === 'win32') return; // 링크는 macOS·Linux에서만 시험한다
  // macOS·Linux: <자리>/bin/muwi가 패키지의 bin/muwi.js로 가는 링크. 우리 래퍼(~/.local/bin/muwi)나 다른 프로그램은 넘어간다
  const old = npmGlobal('old', '@muwi/herdr-app', '0.7.0', 'linux');
  const core = npmGlobal('core', '@muwi/core', '0.7.1', 'linux');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'muwi'), '#!/bin/sh\n');
  assert.deepEqual(newerElsewhere('0.7.0', PATH(other, old, core), 'linux'), { bin: path.join(core, 'muwi'), version: '0.7.1' });
  assert.equal(newerElsewhere('0.7.1', PATH(other, old, core), 'linux'), null);
  assert.equal(newerElsewhere('0.7.0', PATH(path.join(tmp, 'missing')), 'linux'), null);
});

test('Windows의 훅 명령(setup --tool claude)은 경로를 슬래시로 적는다: Git Bash가 읽는다', () => {
  assert.equal(toolCommand('C:\\Users\\me\\muwi', 'claude', 'win32'), 'MUWI_HOOK=1 sh "C:/Users/me/muwi/hooks/tool.sh" claude');
  // macOS·Linux는 경로를 그대로 둔다 (Windows 호스트에서는 path.join이 백슬래시를 만들어 이 조합이 나오지 않는다)
  if (process.platform !== 'win32') assert.equal(toolCommand('/Users/me/muwi', 'claude', 'darwin'), 'MUWI_HOOK=1 sh "/Users/me/muwi/hooks/tool.sh" claude');
});
