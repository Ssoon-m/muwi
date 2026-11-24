// Herdr 화면의 명령과 설치: 그래프 칸이 읽는 board, 화면 설정(layout), muwi setup이 넣는 그래프 칸.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setHost } from '@muwi/core/host';
import { readInstall, removeSetup, runSetup } from '@muwi/core/setup';
import herdr from '../src/host.ts';

/** @muwi/herdr-app의 muwi 명령: Herdr 화면을 붙인 muwi */
const CLI = path.resolve(import.meta.dirname, '../bin/muwi.js');
const HERDR_HOST = path.resolve(import.meta.dirname, '../src/host.ts');
/** 코어(@muwi/core)가 깔린 곳 */
const CORE = path.dirname(fileURLToPath(import.meta.resolve('@muwi/core/package.json')));

const PLAN = JSON.stringify({
  title: '연수원명 클릭 시 상세 이동',
  nodes: [
    { id: 'read', title: '티켓 읽기' },
    { id: 'impl', title: '구현', after: ['read'] },
    { id: 'check', title: '화면 확인', after: ['impl'] },
  ],
});

function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-board-'));
  const muwi = (args: string[], o: { session?: string; input?: string; env?: Record<string, string> } = {}) => {
    const env = { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: o.session ?? 'lead', ...o.env };
    const r = spawnSync(process.execPath, [CLI, ...args], { env, input: o.input ?? '', encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, muwi };
}

test('muwi board: 그래프 칸이 읽는 기록. 고른 작업의 그래프 배치와 읽은 skill을 함께 준다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['hook'], { input: JSON.stringify({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'spec-reader' }, tool_response: { success: true } }) });
  muwi(['node', 'read', 'done', '요구사항 2건']);
  const board = JSON.parse(muwi(['board']).out);
  assert.equal(board.works[0].work, 'w');
  assert.equal(board.selected.work, 'w');
  assert.deepEqual(board.selected.layoutProblems, []);
  assert.equal(board.selected.layout.nodes.length, 3);
  assert.equal(board.selected.layout.edges.length, 2);
  assert.deepEqual(board.selected.nodes[0].skills, [{ skill: 'spec-reader', state: 'read', count: 1, via: 'tool' }]);
});

test('muwi board: 그래프 칸이 터미널과 작업을 잇도록 세션과 터미널을 알려 준다. 화면 안내는 muwi config layout으로 끈다', () => {
  const { muwi } = bench();
  // 계획을 낸 세션은 Herdr 터미널 t5에서 돈다. 다른 세션(t6)은 계획 없이 일한다
  muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN], { env: { HC_TERMINAL_ID: 't5' } });
  muwi(['hook'], { session: 'other', env: { HC_TERMINAL_ID: 't6' }, input: JSON.stringify({ session_id: 'other', hook_event_name: 'SessionStart', source: 'startup' }) });
  // 사람을 기다리는 노드를 다른 세션이 맡고 있으면 그 세션의 터미널로 간다
  muwi(['node', 'impl', 'wait', '어느 쪽?', '--work', 'w'], { session: 'helper', env: { HC_TERMINAL_ID: 't7' } });
  const board = JSON.parse(muwi(['board']).out);
  assert.equal(board.works[0].terminal, 't7');
  assert.deepEqual(
    board.sessions.map((s: any) => [s.key, s.terminal, s.work ?? null]).sort(),
    // 노드를 맡은 세션은 그 작업에 붙는다. 계획 없이 일하는 세션은 작업이 없다
    [['helper', 't7', 'w'], ['lead', 't5', 'w'], ['other', 't6', null]],
  );
  assert.equal(board.suggest, true);
  assert.match(muwi(['config']).out, /^layout\s+on/);
  assert.match(muwi(['config', 'layout', 'off']).out, /layout\s+off/);
  assert.match(muwi(['config', 'layout', 'maybe']).err, /사용법: muwi config \[layout\] on\|off/);
  assert.equal(JSON.parse(muwi(['board']).out).suggest, false);
});

test('muwi setup: Herdr 앱이 있으면 그래프 칸을 넣고 화면의 경로를 적어 둔다. --remove로 뺀다', t => {
  // 화면을 불러온 경로를 적어 두면 muwi 명령과 훅이 그 화면을 쓴다
  setHost(herdr, HERDR_HOST);
  t.after(() => setHost(null));
  const home = (withApp: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-home-'));
    if (withApp) fs.mkdirSync(path.join(dir, '.config', 'herdr-app', 'mods'), { recursive: true });
    return { dir, env: { HOME: dir } as NodeJS.ProcessEnv, records: path.join(dir, '.muwi') };
  };
  // Herdr 앱이 없으면 칸은 건너뛴다
  const none = home(false);
  const lines: string[] = [];
  const skipped = runSetup({ root: CORE, version: '0.1.0', dir: none.records, env: none.env, log: l => lines.push(l) });
  assert.match(lines.join('\n'), /Herdr 앱이 없어/);
  assert.equal(skipped.hosted, undefined);
  // 앱이 있으면 칸을 넣는다. 다시 해도 한 벌이다
  const h = home(true);
  runSetup({ root: CORE, version: '0.1.0', dir: h.records, env: h.env });
  runSetup({ root: CORE, version: '0.1.0', dir: h.records, env: h.env });
  const mod = path.join(h.dir, '.config', 'herdr-app', 'mods', 'muwi');
  assert.deepEqual(fs.readdirSync(mod).sort(), ['arc.svg', 'main.js', 'mod.json']);
  assert.deepEqual([readInstall(h.records)!.host, readInstall(h.records)!.hosted], [HERDR_HOST, { mod }]);
  removeSetup(h.records);
  assert.equal(fs.existsSync(mod), false);
  assert.equal(readInstall(h.records), null);
  // 0.6.0까지의 기록(herdr: 칸 폴더)도 뺀다
  runSetup({ root: CORE, version: '0.1.0', dir: h.records, env: h.env });
  const old = readInstall(h.records)!;
  fs.writeFileSync(path.join(h.records, 'setup.json'), JSON.stringify({ ...old, hosted: undefined, host: undefined, herdr: mod }));
  removeSetup(h.records);
  assert.equal(fs.existsSync(mod), false);
});
