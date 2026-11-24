#!/usr/bin/env node
// 배포할 패키지를 실제로 깔아서 도는지 본다: 빌드 → npm pack → 빈 폴더에 npm으로 설치 → node_modules 안의 사본으로 명령을 돌린다.
// node_modules 안에서는 .ts가 실행되지 않으므로, 빠뜨린 .js 변환이나 파일이 있으면 여기서 드러난다.
// 홈 폴더와 기록 폴더는 임시 폴더를 쓴다 (이 컴퓨터의 설치를 건드리지 않는다). elkjs는 npm에서 받는다.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from './build.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-package-'));
const packs = path.join(tmp, 'packs');
const app = path.join(tmp, 'app');
const home = path.join(tmp, 'home');
for (const d of [packs, app, path.join(home, '.config', 'herdr-app', 'mods')]) fs.mkdirSync(d, { recursive: true });

const npm = (args, cwd) => execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const tarballs = ['muwi', 'herdr-muwi'].map(name => {
  const file = npm(['pack', build(name), '--pack-destination', packs, '--silent'], tmp).trim().split('\n').pop();
  return path.join(packs, file);
});
fs.writeFileSync(path.join(app, 'package.json'), '{"name":"check","private":true}');
npm(['install', ...tarballs, '--no-audit', '--no-fund', '--silent'], app);

const core = path.join(app, 'node_modules', 'muwi');
const herdr = path.join(app, 'node_modules', 'herdr-muwi');
// 실행되는 코드는 모두 .js다 (도구에 넣는 Pi·oh-my-pi 플러그인 파일과 그래프 칸의 타입 파일만 .ts로 남는다)
const ts = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) e.name !== 'node_modules' && walk(p);
    else if (e.name.endsWith('.ts')) ts.push(path.relative(app, p));
  }
};
walk(core);
walk(herdr);
const allowed = ['node_modules/herdr-muwi/app/muwi/gpui-kit.d.ts', 'node_modules/muwi/connectors/omp/muwi.ts', 'node_modules/muwi/connectors/pi/muwi.ts'];
assert.deepEqual(ts.filter(f => !allowed.includes(f.split(path.sep).join('/'))), []);

const env = { PATH: process.env.PATH, HOME: home, MUWI_DIR: path.join(home, '.muwi'), MUWI_SESSION: 'check' };
const run = (cmd, args, input = '') => {
  const r = spawnSync(cmd, args, { env, input, encoding: 'utf8' });
  assert.equal(r.status, 0, `${path.basename(cmd)} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const muwi = (...args) => run(process.execPath, [path.join(herdr, 'bin', 'muwi.js'), ...args]);
const plan = JSON.stringify({ title: '확인', nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', after: ['a'] }] });

// 코어만: sh 입구가 .js를 찾아 실행한다
const version = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')).version;
assert.equal(run('sh', [path.join(core, 'bin', 'muwi'), '--version']).trim(), version);
// Herdr 화면을 붙인 명령: 화면이 더하는 명령이 있고, 그래프 배치(elkjs)까지 돈다
assert.match(muwi('--help'), /muwi run/);
muwi('plan', '--work', 'w', '--request', '확인', plan);
muwi('node', 'a', 'start');
const board = JSON.parse(muwi('board'));
assert.equal(board.selected.layout.nodes.length, 2);
assert.deepEqual(board.selected.layoutProblems, []);
// setup: 터미널용 명령과 그래프 칸을 넣고 화면의 경로를 적어 둔다. 그 뒤로는 코어의 명령도 Herdr 화면을 쓴다
muwi('setup');
const setup = JSON.parse(fs.readFileSync(path.join(home, '.muwi', 'setup.json'), 'utf8'));
assert.equal(setup.host, path.join(fs.realpathSync(herdr), 'src', 'host.js'));
assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-app', 'mods', 'muwi', 'main.js')));
const wrapper = path.join(home, '.local', 'bin', 'muwi');
assert.equal(JSON.parse(run(wrapper, ['board'])).selected.work, 'w');
// 훅: 코어의 훅 스크립트가 지침을 돌려준다
const start = run('sh', [path.join(core, 'hooks', 'hook.sh')], JSON.stringify({ session_id: 'c1', hook_event_name: 'SessionStart', source: 'startup' }));
assert.match(JSON.parse(start).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`패키지 확인: muwi·herdr-muwi ${version}을 npm으로 깔아서 명령, 그래프 배치, setup, 훅이 돈다`);
