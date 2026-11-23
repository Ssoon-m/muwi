import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  hookCommandFor, installBlock, installHooks, instructionText, mergeHooks, readInstall, refreshSetup, removeBlock, removeHooks,
  olderThan, removeSetup, runSetup, uninstallBlock, uninstallHooks, upsertBlock,
} from '../src/setup.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = hookCommandFor('/Users/me/tools/muwi');
const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: '/opt/other/guard.sh' }] };
const ours = (extra = '') => ({ type: 'command', command: `${HOOK}${extra}` });

test('훅 넣기: 남의 훅은 그대로 두고 우리 것만 한 벌 넣는다', () => {
  const start = { model: 'opus', hooks: { PreToolUse: [theirs], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  const once = mergeHooks(start, HOOK);
  assert.deepEqual(mergeHooks(once, HOOK), once);
  assert.equal(once.model, 'opus');
  assert.deepEqual(once.hooks!.SessionStart, [{ hooks: [ours()] }]);
  assert.deepEqual(once.hooks!.PostToolUse, [{ matcher: 'Skill|Read', hooks: [ours()] }]);
  assert.deepEqual(once.hooks!.PreToolUse, [
    theirs,
    { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [ours(' nudge')] },
    { matcher: 'Bash', hooks: [ours(' guard')] },
  ]);
  assert.deepEqual(removeHooks(once), start);
  // 설치 위치가 바뀌어도 옛 위치의 우리 훅을 알아보고 바꾼다
  const moved = mergeHooks(once, hookCommandFor('/somewhere/else'));
  assert.equal(JSON.stringify(moved).includes('/Users/me/tools/muwi'), false);
  assert.equal(moved.hooks!.PreToolUse.length, 3);
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
function home(...tools: ('herdr' | 'codex')[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-home-'));
  if (tools.includes('herdr')) fs.mkdirSync(path.join(dir, '.config', 'herdr-app', 'mods'), { recursive: true });
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
  assert.match(fs.readFileSync(bin, 'utf8'), new RegExp(`MUWI_SETUP_NODE="${process.execPath}" exec "${ROOT}/bin/muwi"`));
  assert.ok(fs.statSync(bin).mode & 0o100);
  // Herdr 앱도 Codex도 없으면 건너뛴다. Claude Code 설정은 플러그인 몫이라 건드리지 않는다
  assert.equal(install.herdr, undefined);
  assert.equal(install.codex, undefined);
  assert.equal(install.claude, undefined);
  assert.equal(fs.existsSync(path.join(h.dir, '.claude')), false);
  assert.match(lines.join('\n'), /Herdr 앱이 없어/);
  assert.deepEqual(readInstall(h.records), install);
});

test('muwi setup: Herdr 앱 칸을 넣고, --codex를 주면 Codex 지침·skill도 넣고, --remove로 뺀다', () => {
  const h = home('herdr', 'codex');
  fs.writeFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), '# 내 Codex 규칙\n');
  // Codex가 있어도 --codex를 주지 않으면 건드리지 않는다
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  assert.equal(fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8'), '# 내 Codex 규칙\n');
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, codex: true });
  // 한 번 넣은 뒤로는 옵션 없이 다시 실행해도 유지한다 (업데이트 때 새 위치로 맞추기 위해)
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  const mod = path.join(h.dir, '.config', 'herdr-app', 'mods', 'muwi');
  assert.deepEqual(fs.readdirSync(mod).sort(), ['arc.svg', 'main.js', 'mod.json']);
  const agents = fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# 내 Codex 규칙\n\n<!-- muwi:start/);
  assert.ok(fs.existsSync(path.join(h.dir, '.codex', 'skills', 'muwi', 'SKILL.md')));

  removeSetup(h.records);
  assert.equal(fs.existsSync(mod), false);
  assert.equal(fs.existsSync(path.join(h.dir, '.local', 'bin', 'muwi')), false);
  assert.equal(fs.readFileSync(path.join(h.dir, '.codex', 'AGENTS.md'), 'utf8'), '# 내 Codex 규칙\n');
  assert.equal(fs.existsSync(path.join(h.dir, '.codex', 'skills', 'muwi')), false);
  assert.equal(readInstall(h.records), null);
});

test('muwi setup --claude: 플러그인 없이 쓸 때 훅과 사용법 skill을 직접 넣는다', () => {
  const h = home();
  fs.mkdirSync(path.join(h.dir, '.claude'));
  fs.writeFileSync(path.join(h.dir, '.claude', 'settings.json'), '{"model":"opus"}');
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env, claude: true });
  const settings = JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, hookCommandFor(ROOT));
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
  const h = home('herdr');
  // setup을 한 적이 없으면 아무것도 넣지 않는다
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  assert.equal(fs.existsSync(path.join(h.dir, '.local')), false);
  runSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env });
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  // 새 버전이 다른 위치에 깔렸다
  const next = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-next-'));
  for (const d of ['hooks', 'skills', 'herdr-app']) fs.cpSync(path.join(ROOT, d), path.join(next, d), { recursive: true });
  assert.equal(refreshSetup({ root: next, version: '0.2.0', dir: h.records, env: h.env }), true);
  assert.match(fs.readFileSync(path.join(h.dir, '.local', 'bin', 'muwi'), 'utf8'), new RegExp(`"${next}/bin/muwi"`));
  assert.equal(readInstall(h.records)!.version, '0.2.0');
  // 업데이트 전부터 열려 있던 세션(옛 버전)이 새로 시작해도 새 설치를 되돌리지 않는다
  assert.equal(refreshSetup({ root: ROOT, version: '0.1.0', dir: h.records, env: h.env }), false);
  assert.equal(readInstall(h.records)!.version, '0.2.0');
  assert.match(fs.readFileSync(path.join(h.dir, '.local', 'bin', 'muwi'), 'utf8'), new RegExp(`"${next}/bin/muwi"`));
  assert.equal(olderThan('0.9.0', '0.10.0'), true);
  assert.equal(olderThan('0.10.0', '0.9.0'), false);
  assert.equal(olderThan('0.5.0', '0.5.0'), false);
});
