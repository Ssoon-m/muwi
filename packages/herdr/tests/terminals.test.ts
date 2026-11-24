// Herdr 터미널 연결: 코어의 터미널 연결 규격을 hc와 herdr-app으로 채우는지 본다.
// hc와 herdr-app은 흉내 낸 스크립트를 쓴다 ($MUWI_HC, $MUWI_HERDR_APP)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readEvents } from '@muwi/core/store';
import { terminalName } from '../src/hc.ts';
import herdr, { withEnv } from '../src/terminals.ts';

/** @muwi/herdr의 muwi 명령: Herdr 터미널 연결을 붙인 muwi */
const CLI = path.resolve(import.meta.dirname, '../bin/muwi.js');

/**
 * hc와 herdr-app을 흉내 내는 스크립트. 받은 인자를 적어 두고 정해 둔 답을 한다.
 * herdr-app은 키보드가 어느 칸에 있는지 기억한다: 칸을 새로 놓으면 그 칸으로 옮겨 가고, pane.focus로 옮긴다.
 * runFails: 처음 몇 번의 hc run을 실패시킨다 (이름이 겹친 경우)
 */
function fakeHerdr(o: { focus?: string; runFails?: number; ls?: unknown } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-fake-'));
  const log = path.join(bin, 'calls.log');
  const at = path.join(bin, 'focus');
  const fails = path.join(bin, 'fails');
  fs.writeFileSync(at, o.focus ?? 'pUSER');
  fs.writeFileSync(fails, String(o.runFails ?? 0));
  const ls = JSON.stringify(o.ls ?? { terminals: [{ address: 't2', state: 'live', status: 'working' }, { address: 't7', state: 'live', status: null }, { address: 't9', state: 'exited', status: null }] });
  // Node 스크립트로 쓴다. .cjs 도구는 Node로 실행하므로 Windows에서도 돈다
  const record = `const fs = require('fs');\nconst args = process.argv.slice(2);\nconst note = (who) => fs.appendFileSync(${JSON.stringify(log)}, who + args.map(a => ' [' + a + ']').join('') + '\\n');\n`;
  fs.writeFileSync(path.join(bin, 'hc.cjs'), `${record}note('hc');
switch (args[0]) {
  case 'run': {
    const left = Number(fs.readFileSync(${JSON.stringify(fails)}, 'utf8'));
    if (left > 0) { fs.writeFileSync(${JSON.stringify(fails)}, String(left - 1)); console.error('name taken'); process.exit(1); }
    console.log('{"address":"t7","first_message":{"sent":true}}'); break;
  }
  case 'ls': console.log(${JSON.stringify(ls)}); break;
  case 'read': console.log('screen of ' + args[1]); break;
  default: console.log('{}');
}
`);
  fs.writeFileSync(path.join(bin, 'herdr-app.cjs'), `${record}const at = ${JSON.stringify(at)};
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ focused_pane: fs.readFileSync(at, 'utf8') })); process.exit(0); }
note('app');
if (args[1] === 'terminal.keep' || args[1] === 'pane.split') {
  if (fs.readFileSync(at, 'utf8')) fs.writeFileSync(at, 'pNEW');
  console.log('{"pending":true,"pane":"pNEW"}');
} else if (args[1] === 'pane.focus') {
  const pane = JSON.parse(args[2] || '{}').pane;
  if (pane) fs.writeFileSync(at, pane);
  console.log('{}');
} else console.log('{}');
`);
  const env = { MUWI_HC: path.join(bin, 'hc.cjs'), MUWI_HERDR_APP: path.join(bin, 'herdr-app.cjs'), PATH: process.env.PATH } as NodeJS.ProcessEnv;
  return { env, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), focus: () => fs.readFileSync(at, 'utf8') };
}

test('이 터미널의 주소는 $HC_TERMINAL_ID다. Herdr 밖이면 모른다', () => {
  assert.deepEqual(herdr.place({ HC_TERMINAL_ID: 't3', HERDR_PANE_ID: 'p1' } as NodeJS.ProcessEnv), { terminal: 't3', pane: 'p1' });
  assert.equal(herdr.place({} as NodeJS.ProcessEnv), null);
});

test('터미널 목록: 살아 있는 터미널과 에이전트 상태. 상태가 없으면 셸만 남은 터미널이고, hc가 없으면 모른다', () => {
  const fake = fakeHerdr();
  assert.deepEqual(herdr.list!(fake.env), [{ terminal: 't2', agent: 'working' }, { terminal: 't7', agent: 'none' }]);
  assert.equal(herdr.list!({ MUWI_HC: '/no/such/hc' } as NodeJS.ProcessEnv), null);
});

test('띄우기: 맡은 작업과 노드는 env로 감싸 넘기고, 이름은 Herdr에 맞게 고치고, 겹치면 뒤에 글자를 붙여 다시 띄운다', () => {
  const fake = fakeHerdr({ runFails: 1 });
  const r = herdr.launch!({ cwd: '/repo', name: 'Impl UI', argv: ['claude', '해줘'], env: { MUWI_RUN: 'impl-1', MUWI_RUN_WORK: 'w', MUWI_RUN_NODE: 'impl' } }, fake.env);
  assert.equal(r.terminal, 't7');
  assert.equal(r.delivered, true);
  assert.match(r.name!, /^impl-ui-[0-9a-z]{4}$/);
  const runs = fake.calls().split('\n').filter(l => l.startsWith('hc [run]'));
  assert.equal(runs.length, 2);
  const wrap = process.platform === 'win32' ? '' : ' [env] [MUWI_RUN=impl-1] [MUWI_RUN_WORK=w] [MUWI_RUN_NODE=impl]';
  assert.equal(runs[0], `hc [run] [--bg] [--json] [--outlive-parent] [--name] [impl-ui] [--cwd] [/repo] [--]${wrap} [claude] [해줘]`);
  assert.throws(() => herdr.launch!({ cwd: '/repo', name: 'x', argv: ['claude'], env: {} }, fakeHerdr({ runFails: 2 }).env), /name taken/);
  // Windows에는 env 명령이 없다. 그때는 감싸지 않는다 (코어가 그 터미널의 표로 맡은 노드를 안다)
  assert.deepEqual(withEnv(['claude'], { A: '1' }, 'win32'), ['claude']);
  assert.deepEqual(withEnv(['claude'], { A: '1' }, 'darwin'), ['env', 'A=1', 'claude']);
  assert.equal(terminalName('화면'), 'node');
  assert.equal(terminalName('a'.repeat(40)).length, 32);
});

test('놓기: Herdr 앱의 옆 칸·아래 칸·탭에 놓고, 키보드는 사람이 있던 칸으로 되돌린다', () => {
  const fake = fakeHerdr();
  assert.deepEqual(herdr.arrange!('t7', 'beside', 't2', fake.env), { ok: true });
  const calls = fake.calls();
  assert.match(calls, /app \[do\] \[terminal\.keep\] \[\{"terminal":"t7","place":"right"\}\]/);
  // muwi를 부른 터미널(t2)로 끌어오지 않는다
  assert.equal(fake.focus(), 'pUSER');
  herdr.arrange!('t7', 'below', 't2', fake.env);
  herdr.arrange!('t7', 'tab', 't2', fake.env);
  assert.match(fake.calls(), /"place":"down"[\s\S]*"place":"tab"/);
});

test('보내기·읽기·닫기는 hc로 한다', () => {
  const fake = fakeHerdr();
  assert.equal(herdr.send!('t7', '안녕', fake.env), true);
  assert.equal(herdr.read!('t7', fake.env), 'screen of t7\n');
  assert.equal(herdr.close!('t7', fake.env), true);
  assert.deepEqual(fake.calls().trim().split('\n'), ['hc [send] [t7] [안녕]', 'hc [read] [t7]', 'hc [kill] [t7]', 'hc [rm] [t7]']);
});

test('@muwi/herdr의 muwi: Herdr 터미널 안에서 muwi run이 hc로 띄우고 맡긴 노드를 적는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-herdr-'));
  const fake = fakeHerdr();
  const muwi = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
    env: { ...fake.env, HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead', HC_TERMINAL_ID: 't2' } as NodeJS.ProcessEnv, encoding: 'utf8',
  });
  assert.equal(muwi(['plan', '--work', 'w', '{"nodes":[{"id":"impl","title":"구현","run":"session","show":"pane"}]}']).status, 0);
  const r = muwi(['run', 'impl', '해줘']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /새 세션을 띄웠어요: impl \(t7\) → 노드 impl · pane/);
  assert.match(fake.calls(), /terminal\.keep/);
  assert.deepEqual(readEvents(dir, 'w').filter(e => e.type === 'spawn').map(e => [(e as any).terminal, (e as any).from]), [['t7', 't2']]);
});
