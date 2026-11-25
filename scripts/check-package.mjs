#!/usr/bin/env node
// 배포할 패키지를 사용자가 까는 그대로 깔아서 도는지 본다: 빌드 → npm pack → 패키지마다 빈 자리에 npm i -g → npm이 PATH에 건 muwi로 명령을 돌린다.
// node_modules 안에서는 .ts가 실행되지 않으므로, 빠뜨린 .js 변환이나 파일이 있으면 여기서 드러난다.
// npm이 거는 명령은 macOS·Linux에서는 <자리>/bin/muwi (패키지의 bin 파일로 가는 링크), Windows에서는 <자리>/muwi.cmd (npm이 만든 shim)다.
// 홈 폴더와 기록 폴더는 임시 폴더를 쓴다 (이 컴퓨터의 설치를 건드리지 않는다). elkjs는 npm에서 받는다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from './build.mjs';

const WIN = process.platform === 'win32';
// 훅 스크립트를 실행할 sh. Windows는 Claude Code처럼 Git for Windows의 sh를 쓴다
const gitSh = 'C:\\Program Files\\Git\\bin\\sh.exe';
const SH = WIN && fs.existsSync(gitSh) ? gitSh : 'sh';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-package-'));
const packs = path.join(tmp, 'packs');
fs.mkdirSync(packs);

// Windows의 npm은 npm.cmd라서 셸로 부른다 (인자는 경로와 옵션뿐이다)
const npm = (args, cwd = tmp) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: WIN });
const pack = dir => path.join(packs, npm(['pack', dir, '--pack-destination', packs, '--silent']).trim().split('\n').pop());

/**
 * 같은 저장소의 다른 muwi 패키지에 기대는 패키지는 같은 버전을 npm에서 받는다. 아직 올리지 않은 판을 확인하므로,
 * 확인용 사본만 그 의존을 방금 만든 tarball로 바꿔서 만든다
 */
function packWith(folder, local) {
  const check = path.join(tmp, folder);
  fs.cpSync(build(folder), check, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(check, 'package.json'), 'utf8'));
  for (const [name, tgz] of Object.entries(local)) if (manifest.dependencies?.[name]) manifest.dependencies[name] = `file:${tgz.split(path.sep).join('/')}`;
  fs.writeFileSync(path.join(check, 'package.json'), JSON.stringify(manifest, null, 2));
  return pack(check);
}

const coreTgz = pack(build('core'));
const herdrTermTgz = packWith('herdr', { '@muwi/core': coreTgz });
const herdrTgz = packWith('herdr-app', { '@muwi/core': coreTgz, '@muwi/herdr': herdrTermTgz });

/** 패키지 하나를 빈 자리(npm prefix)에 npm i -g로 깐다. 그 패키지의 폴더와 npm이 건 명령을 돌려준다. label은 임시 폴더 이름 */
function installAlone(label, name, tgz) {
  const prefix = path.join(tmp, `${label}-prefix`);
  npm(['install', '-g', '--prefix', prefix, tgz, '--no-audit', '--no-fund', '--silent']);
  const pkg = path.join(prefix, ...(WIN ? [] : ['lib']), 'node_modules', ...name.split('/'));
  return { pkg, bin: WIN ? path.join(prefix, 'muwi.cmd') : path.join(prefix, 'bin', 'muwi') };
}

/** 자리마다 홈과 기록 폴더를 따로 쓴다 */
function envFor(name) {
  const home = path.join(tmp, `${name}-home`);
  fs.mkdirSync(path.join(home, '.config', 'herdr-app', 'mods'), { recursive: true });
  return { home, env: { ...process.env, HOME: home, USERPROFILE: home, MUWI_DIR: path.join(home, '.muwi'), MUWI_SESSION: 'check' } };
}

function runner(env) {
  const run = (cmd, args, input = '') => {
    // Windows에서 .cmd는 셸로만 실행된다. 셸을 거치면 인자의 따옴표가 깨지므로 .cmd에는 간단한 인자만 준다
    const shell = WIN && /\.cmd$/i.test(cmd);
    const r = spawnSync(cmd, args, { env, input, encoding: 'utf8', shell });
    assert.equal(r.status, 0, `${path.basename(cmd)} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  return run;
}

const version = JSON.parse(fs.readFileSync(path.join(build('core'), 'package.json'), 'utf8')).version;
const plan = JSON.stringify({ title: '확인', nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', after: ['a'] }] });

// 실행되는 코드는 모두 .js다 (도구에 넣는 Pi·oh-my-pi 플러그인 파일과 그래프 칸의 타입 파일만 .ts로 남는다)
function onlyAllowedTs(pkg) {
  const allowed = ['app/muwi/gpui-kit.d.ts', 'connectors/omp/muwi.ts', 'connectors/pi/muwi.ts'];
  const ts = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) e.name !== 'node_modules' && walk(p);
      else if (e.name.endsWith('.ts')) ts.push(path.relative(pkg, p).split(path.sep).join('/'));
    }
  };
  walk(pkg);
  assert.deepEqual(ts.filter(f => !allowed.includes(f)), []);
}

// ---- 코어(@muwi/core)만 깔았을 때: npm이 건 명령으로 기록과 setup이 돈다
{
  const { pkg, bin } = installAlone('core', '@muwi/core', coreTgz);
  const { home, env } = envFor('core');
  const run = runner(env);
  onlyAllowedTs(pkg);
  assert.equal(run(bin, ['--version']).trim(), version);
  // 인자에 JSON이 들어가는 명령은 npm이 건 명령이 실행하는 파일을 node로 바로 부른다 (Windows의 .cmd는 따옴표가 깨진다)
  const muwi = (...args) => (WIN ? run(process.execPath, [path.join(pkg, 'bin', 'muwi.js'), ...args]) : run(bin, args));
  muwi('plan', '--work', 'w', '--request', '확인', plan);
  muwi('node', 'a', 'start');
  assert.match(muwi('show', '--work', 'w'), /A/);
  run(bin, ['setup']);
  const wrapper = path.join(home, '.local', 'bin', WIN ? 'muwi.cmd' : 'muwi');
  assert.equal(run(wrapper, ['--version']).trim(), version);
  run(bin, ['setup', '--remove']);
  assert.equal(fs.existsSync(wrapper), false);
}

// ---- @muwi/herdr만 깔았을 때: 코어는 그 안에 따라 들어오고, setup이 Herdr 터미널 연결의 경로를 적어 둔다 (보기는 없다)
{
  const { pkg, bin } = installAlone('herdr', '@muwi/herdr', herdrTermTgz);
  const { home, env } = envFor('herdr');
  const run = runner(env);
  onlyAllowedTs(pkg);
  assert.equal(run(bin, ['--version']).trim(), version);
  assert.doesNotMatch(run(bin, ['--help']), /muwi layout/);
  run(bin, ['setup']);
  const setup = JSON.parse(fs.readFileSync(path.join(home, '.muwi', 'setup.json'), 'utf8'));
  assert.equal(setup.terminals, path.join(fs.realpathSync(pkg), 'src', 'terminals.js'));
  assert.equal(setup.views, undefined);
  run(bin, ['setup', '--remove']);
}

// ---- @muwi/herdr-app만 깔았을 때: 코어와 Herdr 터미널 연결(@muwi/herdr)은 그 안에 따라 들어오고, 보기가 더하는 명령과 그래프 배치(elkjs)까지 돈다
{
  const { pkg: herdr, bin } = installAlone('herdr-app', '@muwi/herdr-app', herdrTgz);
  const core = path.join(herdr, 'node_modules', '@muwi', 'core');
  const terminals = path.join(herdr, 'node_modules', '@muwi', 'herdr');
  const { home, env } = envFor('herdr-app');
  const run = runner(env);
  onlyAllowedTs(herdr);
  onlyAllowedTs(core);
  onlyAllowedTs(terminals);
  assert.equal(run(bin, ['--version']).trim(), version);
  assert.match(run(bin, ['--help']), /muwi layout/);
  const muwi = (...args) => (WIN ? run(process.execPath, [path.join(herdr, 'bin', 'muwi.js'), ...args]) : run(bin, args));
  muwi('plan', '--work', 'w', '--request', '확인', plan);
  muwi('node', 'a', 'start');
  const board = JSON.parse(muwi('board'));
  assert.equal(board.selected.layout.nodes.length, 2);
  assert.deepEqual(board.selected.layoutProblems, []);
  // setup: 터미널용 명령과 그래프 칸을 넣고 연결과 보기의 경로를 적어 둔다. 그 뒤로는 코어의 명령도 둘을 쓴다
  run(bin, ['setup']);
  const setup = JSON.parse(fs.readFileSync(path.join(home, '.muwi', 'setup.json'), 'utf8'));
  assert.equal(setup.terminals, path.join(fs.realpathSync(terminals), 'src', 'terminals.js'));
  assert.equal(setup.views[0].path, path.join(fs.realpathSync(herdr), 'src', 'view.js'));
  assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-app', 'mods', 'muwi', 'main.js')));
  const wrapper = path.join(home, '.local', 'bin', WIN ? 'muwi.cmd' : 'muwi');
  assert.equal(JSON.parse(run(wrapper, ['board'])).selected.work, 'w');
  // 훅: 모든 도구가 들어오는 입구(tool.sh <도구>)가 지침을 돌려준다 (Windows는 Git Bash의 sh로)
  const start = run(SH, [path.join(core, 'hooks', 'tool.sh'), 'claude'], JSON.stringify({ session_id: 'c1', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(JSON.parse(start).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);

  // 커넥터 하나를 넣어 본다 (Claude Code: settings.json에 훅, ~/.claude/skills에 사용법). 넣은 훅 명령을 그대로 실행해 본다
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  run(bin, ['setup', '--tool', 'claude']);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.match(command, /node_modules[\\/]@muwi[\\/]core[\\/]hooks[\\/]tool\.sh" claude$/);
  const viaClaude = run(SH, ['-c', command], JSON.stringify({ session_id: 'c2', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(JSON.parse(viaClaude).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'muwi', 'SKILL.md')));

  // 새 판 알림: 캐시에 더 새 판이 있으면 보기가 읽는 board에 싣고, 세션 시작 훅이 Claude Code 화면에 알린다 (npm에 묻지 않는다).
  // CI에서는 알림이 꺼지므로 이 확인에서만 켠다
  const loud = { ...env, CI: '', NO_UPDATE_NOTIFIER: '', MUWI_NO_UPDATE_CHECK: '', XDG_CACHE_HOME: path.join(home, '.cache') };
  const cache = path.join(home, '.cache', 'muwi', 'update.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ name: '@muwi/herdr-app', latest: '99.0.0', checkedAt: Date.now() }));
  const runLoud = runner(loud);
  const told = (WIN ? runLoud(process.execPath, [path.join(herdr, 'bin', 'muwi.js'), 'board']) : runLoud(bin, ['board']));
  assert.equal(JSON.parse(told).update.latest, '99.0.0');
  const viaClaudeNew = runLoud(SH, ['-c', command], JSON.stringify({ session_id: 'c3', hook_event_name: 'SessionStart', source: 'startup' }));
  assert.match(JSON.parse(viaClaudeNew).systemMessage, /muwi 99\.0\.0이 나왔어요 .*muwi update/);
  run(bin, ['setup', '--remove']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks, undefined);
  assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-app', 'mods', 'muwi')), false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`패키지 확인: @muwi/core·@muwi/herdr·@muwi/herdr-app ${version}을 하나씩 npm i -g로 깔아서, npm이 건 muwi로 명령, 그래프 배치, setup, 훅, Claude Code 커넥터가 돈다`);
