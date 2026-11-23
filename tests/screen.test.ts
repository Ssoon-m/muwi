import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ScreenError, applyLayout, hasMuwi, placeMuwi, readLayoutRecord, removeLayout, screenState, type LayoutNode } from '../src/screen.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');

/** Herdr의 기본 레이아웃(main)을 줄인 것: 사이드바에 Spaces와 Agents, 작업 영역에 탭 줄·터미널 영역·상태 줄 */
const MAIN: LayoutNode = {
  id: 'root',
  type: 'row',
  titlebar: 'none',
  children: [
    {
      id: 'sidebar', type: 'column', size: { px: 268 },
      children: [
        { id: 'brand', type: 'block', size: { px: 46 }, content: { mod: 'workspace-chrome' } },
        {
          id: 'sidebar-lists', type: 'column',
          children: [
            { id: 'spaces', type: 'block', size: { weight: 1 }, content: { mod: 'spaces' } },
            { id: 'agents', type: 'block', size: { weight: 1 }, min: 90, content: { mod: 'agents' } },
          ],
        },
      ],
    },
    {
      id: 'work', type: 'column',
      children: [
        { id: 'tabs', type: 'block', size: { px: 42 }, content: { mod: 'tabs' } },
        {
          id: 'work-body', type: 'row',
          children: [
            { id: 'main', type: 'block', content: { tab: 'active' } },
            { id: 'panel', type: 'column', size: { px: 368 }, hidden: true, children: [] },
          ],
        },
        { id: 'status', type: 'block', size: { px: 28 }, content: { mod: 'workspace-status' } },
      ],
    },
  ],
};

const find = (node: LayoutNode, id: string): LayoutNode | null =>
  node.id === id ? node : (node.children ?? []).map(c => find(c, id)).find(Boolean) ?? null;

test('레이아웃에 muwi 칸 넣기: Agents 자리에 작업 목록, 터미널 영역 아래에 그래프. 원래 나무는 그대로다', () => {
  const before = JSON.stringify(MAIN);
  const { tree, list, graph } = placeMuwi(MAIN);
  assert.equal(JSON.stringify(MAIN), before);
  assert.ok(list && graph);
  // Agents 칸은 자리와 크기를 그대로 두고 내용만 바꾼다
  assert.deepEqual(find(tree, 'agents'), { id: 'agents', type: 'block', size: { weight: 1 }, min: 90, content: { mod: 'muwi', props: { variant: 'list' } } });
  // 그래프는 터미널 영역(오른쪽 패널까지)을 담은 줄 바로 아래, 상태 줄 위에
  assert.deepEqual(find(tree, 'work')!.children!.map(c => c.id), ['tabs', 'work-body', 'muwi-graph', 'status']);
  assert.deepEqual(find(tree, 'muwi-graph')!.content, { mod: 'muwi', props: { variant: 'graph' } });
  assert.ok(hasMuwi(tree));
  assert.equal(hasMuwi(MAIN), false);
});

test('레이아웃에 muwi 칸 넣기: Agents 칸이 없으면 목록까지 있는 그래프를, 세로 묶음이 없으면 감싸서 넣는다', () => {
  const plain: LayoutNode = {
    id: 'root', type: 'row',
    children: [
      { id: 'side', type: 'block', size: { px: 200 }, content: { mod: 'spaces' } },
      { id: 'main', type: 'block', size: { weight: 3 }, content: { tab: 'active' } },
    ],
  };
  const { tree, list, graph } = placeMuwi(plain);
  assert.equal(list, false);
  assert.equal(graph, true);
  const wrap = tree.children![1];
  assert.equal(wrap.type, 'column');
  assert.deepEqual(wrap.size, { weight: 3 });
  assert.deepEqual(wrap.children!.map(c => c.id), ['main', 'muwi-graph']);
  assert.deepEqual(wrap.children![0].size, { weight: 1 });
  assert.deepEqual(wrap.children![1].content, { mod: 'muwi', props: { variant: 'full' } });
  // 넣을 자리가 아무 데도 없는 화면 (창 전체를 mod 하나가 그린다)
  const desktop = placeMuwi({ id: 'root', type: 'column', children: [{ id: 'desk', type: 'block', content: { mod: 'win98' } }] });
  assert.equal(desktop.list, false);
  assert.equal(desktop.graph, false);
});

/** herdr-app을 흉내 낸다: 지금 레이아웃, 버전, 레이아웃 복제·바꾸기 */
function fakeApp(layouts: Record<string, LayoutNode> = { main: MAIN }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-screen-'));
  const app = path.join(home, '.config', 'herdr-app');
  fs.mkdirSync(path.join(app, 'layouts'), { recursive: true });
  for (const [name, tree] of Object.entries(layouts)) fs.writeFileSync(path.join(app, 'layouts', `${name}.json`), JSON.stringify(tree, null, 2));
  const stateFile = path.join(home, 'app-state.json');
  const write = (s: { layout: string; version: string; up: boolean }) => fs.writeFileSync(stateFile, JSON.stringify(s));
  write({ layout: 'main', version: '0.1.16', up: true });
  const bin = path.join(home, 'herdr-app');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const layouts = ${JSON.stringify(path.join(app, 'layouts'))};
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(st));
const [first, cmd, raw] = process.argv.slice(2);
if (!st.up) { console.error('Herdr app is not running'); process.exit(1); }
if (first === '--version') { console.log('herdr-app ' + st.version); process.exit(0); }
if (first === 'status') { console.log(JSON.stringify({ layout: st.layout, errors: [] })); process.exit(0); }
const a = JSON.parse(raw || '{}');
if (first === 'do' && cmd === 'layout.clone') {
  const to = path.join(layouts, a.as + '.json');
  if (fs.existsSync(to)) { console.error('a layout named ' + a.as + ' exists'); process.exit(1); }
  const tree = JSON.parse(fs.readFileSync(path.join(layouts, a.name + '.json'), 'utf8'));
  tree.cloned_from = { name: a.name, version: st.version };
  fs.writeFileSync(to, JSON.stringify(tree, null, 2));
  st.layout = a.as; save(); console.log('{"ok":true}'); process.exit(0);
}
if (first === 'do' && cmd === 'layout.switch') {
  if (!fs.existsSync(path.join(layouts, a.name + '.json'))) { console.error('no layout'); process.exit(1); }
  st.layout = a.name; save(); console.log('{"ok":true}'); process.exit(0);
}
console.error('unknown command'); process.exit(1);
`, { mode: 0o755 });
  const env = { HOME: home, HERDR_APP_HOME: app, MUWI_HERDR_APP: bin, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const records = path.join(home, '.muwi');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const layout = (name: string) => {
    const file = path.join(app, 'layouts', `${name}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutNode) : null;
  };
  return { home, app, env, records, state, set: (patch: object) => write({ ...state(), ...patch }), layout };
}

test('muwi layout: 지금 레이아웃을 복제해 muwi 칸을 넣고 바꾼다. 다시 하면 그대로 두고, 되돌리면 복제본을 지운다', () => {
  const h = fakeApp();
  assert.deepEqual(
    (({ app, shown, muwi, canList, canGraph }) => ({ app, shown, muwi, canList, canGraph }))(screenState(h.records, h.env)),
    { app: true, shown: 'main', muwi: false, canList: true, canGraph: true },
  );
  const applied = applyLayout(h.records, h.env);
  assert.deepEqual(applied, { name: 'muwi', base: 'main', list: true, graph: true });
  assert.equal(h.state().layout, 'muwi');
  const clone = h.layout('muwi')!;
  assert.ok(hasMuwi(clone));
  assert.deepEqual(clone.cloned_from, { name: 'main', version: '0.1.16' });
  // 원래 레이아웃은 손대지 않는다
  assert.equal(hasMuwi(h.layout('main')!), false);
  assert.equal(readLayoutRecord(h.records)!.base, 'main');
  assert.equal(applyLayout(h.records, h.env).already, true);
  assert.equal(screenState(h.records, h.env).muwi, true);

  const removed = removeLayout(h.records, h.env);
  assert.deepEqual(removed, { deleted: true, switchedTo: 'main' });
  assert.equal(h.state().layout, 'main');
  assert.equal(h.layout('muwi'), null);
  assert.equal(readLayoutRecord(h.records), null);
  assert.deepEqual(removeLayout(h.records, h.env), { deleted: false, none: true });
});

test('muwi layout: Herdr가 업데이트되면 새 모양으로 다시 복제한다. 손으로 고친 복제본은 지우지 않는다', () => {
  const h = fakeApp();
  applyLayout(h.records, h.env);
  h.set({ version: '0.1.17' });
  const s = screenState(h.records, h.env);
  assert.equal(s.outdated, true);
  assert.equal(s.edited, false);
  const again = applyLayout(h.records, h.env);
  assert.equal(again.refreshed, true);
  assert.deepEqual(h.layout('muwi')!.cloned_from, { name: 'main', version: '0.1.17' });
  assert.equal(readLayoutRecord(h.records)!.version, '0.1.17');

  // 사람이 복제본을 고쳤다: 업데이트돼도 다시 만들지 않고, 되돌려도 지우지 않는다
  const file = path.join(h.app, 'layouts', 'muwi.json');
  fs.writeFileSync(file, JSON.stringify({ ...h.layout('muwi')!, background: '#000000' }, null, 2));
  h.set({ version: '0.1.18' });
  assert.equal(screenState(h.records, h.env).edited, true);
  assert.throws(() => applyLayout(h.records, h.env), /손으로 고친 것 같아/);
  const removed = removeLayout(h.records, h.env);
  assert.equal(removed.kept, file);
  assert.equal(removed.switchedTo, 'main');
  assert.ok(fs.existsSync(file));
  // 남겨 둔 복제본과 이름이 겹치지 않게 다음 이름을 쓴다
  assert.equal(applyLayout(h.records, h.env).name, 'muwi-2');
});

test('muwi layout: 앱이 닫혀 있거나 넣을 자리가 없으면 아무것도 바꾸지 않고 이유를 알린다', () => {
  const h = fakeApp({ main: MAIN, win98: { id: 'root', type: 'column', children: [{ id: 'desk', type: 'block', content: { mod: 'win98' } }] } });
  h.set({ layout: 'win98' });
  assert.throws(() => applyLayout(h.records, h.env), (e: unknown) => e instanceof ScreenError && /자리를 못 찾았어요/.test(e.message));
  assert.equal(h.layout('muwi'), null);
  assert.equal(h.state().layout, 'win98');
  h.set({ up: false });
  assert.equal(screenState(h.records, h.env).app, false);
  assert.throws(() => applyLayout(h.records, h.env), /Herdr 앱이 열려 있지 않거나/);
});

test('muwi layout 명령: 상태 보기, 바꾸기, 되돌리기를 사람이 읽는 글로 알린다', () => {
  const h = fakeApp();
  const muwi = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...h.env, MUWI_DIR: h.records } as NodeJS.ProcessEnv, encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  assert.match(muwi('layout', '--status').out, /지금 레이아웃\(main\)에는 muwi 칸이 없어요[\s\S]*Agents 자리에 작업 목록을, 터미널 아래에 그래프를/);
  const applied = muwi('layout');
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /muwi 레이아웃으로 바꿨어요 \(main 레이아웃을 복제했어요\)/);
  assert.match(applied.out, /되돌리려면 muwi layout --remove/);
  assert.match(muwi('layout').out, /이미 muwi 칸이 있는 레이아웃이에요: muwi/);
  assert.equal(JSON.parse(muwi('layout', '--status', '--json').out).muwi, true);
  const removed = muwi('layout', '--remove');
  assert.match(removed.out, /main 레이아웃으로 되돌렸어요[\s\S]*복제본을 지웠어요/);
  h.set({ up: false });
  const closed = muwi('layout');
  assert.equal(closed.code, 1);
  assert.match(closed.err, /Herdr 앱이 열려 있지 않거나/);
});
