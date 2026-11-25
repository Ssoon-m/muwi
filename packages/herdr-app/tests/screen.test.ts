import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { layoutPreview } from '../src/preview.ts';
import { moveOffRight } from '../src/install.ts';
import { PLACE_VERSION, ScreenError, applyLayout, ensurePreview, hasMuwi, placeMuwi, readLayoutRecord, removeLayout, screenState, treeHash, type LayoutNode } from '../src/screen.ts';

/** @muwi/herdr-app의 muwi 명령: Herdr 화면을 붙인 muwi */
const CLI = path.resolve(import.meta.dirname, '../bin/muwi.js');


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
  // 그래프는 터미널 영역(오른쪽 패널까지)을 담은 줄 아래, 상태 줄 위에.
  // 둘을 새 세로 묶음으로 감싸서 사이 경계를 끌 수 있게 한다 (작업 영역 묶음은 끌 수 없게 돼 있다)
  assert.deepEqual(find(tree, 'work')!.children!.map(c => c.id), ['tabs', 'muwi-split', 'status']);
  const split = find(tree, 'muwi-split')!;
  assert.equal(split.type, 'column');
  assert.equal(split.resizable, true);
  assert.deepEqual(split.children!.map(c => c.id), ['work-body', 'muwi-graph']);
  assert.deepEqual(split.children![0].size, { weight: 1 });
  assert.deepEqual(find(tree, 'muwi-graph')!.size, { px: 300 });
  assert.deepEqual(find(tree, 'muwi-graph')!.content, { mod: 'muwi', props: { variant: 'graph' } });
  assert.ok(hasMuwi(tree));
  assert.equal(hasMuwi(MAIN), false);
});

test('레이아웃에 muwi 칸 넣기: 그래프를 터미널 영역의 위에 둘 수 있다 (오른쪽은 없다)', () => {
  const top = placeMuwi(MAIN, 'top').tree;
  const upper = find(top, 'muwi-split')!;
  assert.equal(upper.type, 'column');
  assert.equal(upper.resizable, true);
  assert.deepEqual(upper.children!.map(c => c.id), ['muwi-graph', 'work-body']);
  assert.deepEqual(find(top, 'muwi-graph')!.size, { px: 300 });
  // 어디에 두든 작업 영역의 탭 줄·상태 줄 사이에 들어간다
  assert.deepEqual(find(top, 'work')!.children!.map(c => c.id), ['tabs', 'muwi-split', 'status']);
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
  assert.equal(wrap.id, 'muwi-split');
  assert.equal(wrap.type, 'column');
  assert.equal(wrap.resizable, true);
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
  // Node 스크립트로 쓴다 (.cjs). muwi는 이런 도구를 Node로 실행하므로 Windows에서도 돈다
  const bin = path.join(home, 'herdr-app.cjs');
  fs.writeFileSync(bin, `const fs = require('fs'), path = require('path');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const layouts = ${JSON.stringify(path.join(app, 'layouts'))};
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(st));
const [first, cmd, raw] = process.argv.slice(2);
// 진짜 앱처럼 레이아웃마다 사람이 고른 것(테마, 칸 크기)을 layouts/.state/<이름>.json에 둔다:
// 복제하면 따라가고, layout.set을 하면 지워지고, 파일을 직접 고치면 남는다
const clicks = (name) => path.join(layouts, '.state', name + '.json');
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
  if (fs.existsSync(clicks(a.name))) fs.copyFileSync(clicks(a.name), clicks(a.as));
  st.clones = (st.clones || 0) + 1;
  st.layout = a.as; save(); console.log('{"ok":true}'); process.exit(0);
}
if (first === 'do' && cmd === 'layout.set') {
  // 보이는 레이아웃의 나무를 바꾼다. 앱처럼 키 순서를 바꿔 다시 쓴다
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map(k => [k, sort(v[k])])) : v;
  fs.writeFileSync(path.join(layouts, st.layout + '.json'), JSON.stringify(sort(a.layout), null, 2));
  fs.rmSync(clicks(st.layout), { force: true });
  st.sets = (st.sets || 0) + 1; save(); console.log('{"ok":true}'); process.exit(0);
}
if (first === 'do' && cmd === 'layout.resize') { st.resized = a; save(); console.log('{"ok":true}'); process.exit(0); }
if (first === 'do' && cmd === 'layout.switch') {
  if (!fs.existsSync(path.join(layouts, a.name + '.json'))) { console.error('no layout'); process.exit(1); }
  st.switches = (st.switches || 0) + 1;
  st.layout = a.name; save(); console.log('{"ok":true}'); process.exit(0);
}
if (first === 'do' && cmd === 'app.theme') {
  // 보이는 레이아웃에 테마를 고른다 (그 테마의 밝기 쪽 절반)
  fs.mkdirSync(path.dirname(clicks(st.layout)), { recursive: true });
  const old = fs.existsSync(clicks(st.layout)) ? JSON.parse(fs.readFileSync(clicks(st.layout), 'utf8')) : { nodes: {} };
  old.theme = { light: 'paper', dark: 'graphite', ...old.theme, [a.name === 'paper' ? 'light' : 'dark']: a.name };
  fs.writeFileSync(clicks(st.layout), JSON.stringify(old)); console.log('{"ok":true}'); process.exit(0);
}
console.error('unknown command'); process.exit(1);
`);
  const env = { HOME: home, HERDR_APP_HOME: app, MUWI_HERDR_APP: bin, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  const records = path.join(home, '.muwi');
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const layout = (name: string) => {
    const file = path.join(app, 'layouts', `${name}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutNode) : null;
  };
  /** 사람이 지금 레이아웃에서 테마를 고른다 (Herdr의 테마 메뉴) */
  const pickTheme = (name: string) => assert.equal(spawnSync(process.execPath, [bin, 'do', 'app.theme', JSON.stringify({ name })]).status, 0);
  /** 그 레이아웃에서 고른 테마 (없으면 undefined) */
  const themeOf = (name: string) => {
    const file = path.join(app, 'layouts', '.state', `${name}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).theme : undefined;
  };
  return { home, app, env, records, state, set: (patch: object) => write({ ...state(), ...patch }), layout, pickTheme, themeOf };
}

test('muwi layout: 지금 레이아웃을 복제해 muwi 칸을 넣고 바꾼다. 다시 하면 그대로 두고, 되돌리면 복제본을 지운다', () => {
  const h = fakeApp();
  assert.deepEqual(
    (({ app, shown, muwi, canList, canGraph }) => ({ app, shown, muwi, canList, canGraph }))(screenState(h.records, h.env)),
    { app: true, shown: 'main', muwi: false, canList: true, canGraph: true },
  );
  // 원래 레이아웃에서 고른 테마는 복제본에도 그대로 남는다 (복제 뒤 파일을 직접 고치고 layout.set은 쓰지 않는다)
  h.pickTheme('atom-one-dark');
  const applied = applyLayout(h.records, h.env);
  assert.deepEqual(applied, { name: 'muwi', base: 'main', list: true, graph: true, graphAt: 'bottom' });
  assert.equal(h.state().layout, 'muwi');
  assert.equal(h.state().sets, undefined);
  assert.deepEqual(h.themeOf('muwi'), { light: 'paper', dark: 'atom-one-dark' });
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

test('muwi layout: Herdr가 업데이트되면 복제본을 그 자리에서 새 모양으로 고친다. 손으로 고친 복제본은 지우지 않는다', () => {
  const h = fakeApp();
  applyLayout(h.records, h.env);
  // muwi 레이아웃에서 테마를 골랐다
  h.pickTheme('atom-one-dark');
  h.set({ version: '0.1.17' });
  const s = screenState(h.records, h.env);
  assert.equal(s.outdated, true);
  assert.equal(s.edited, false);
  const again = applyLayout(h.records, h.env);
  assert.equal(again.refreshed, true);
  assert.deepEqual(h.layout('muwi')!.cloned_from, { name: 'main', version: '0.1.17' });
  assert.equal(readLayoutRecord(h.records)!.version, '0.1.17');
  assert.equal(screenState(h.records, h.env).outdated, false);
  // 지우고 다시 복제하지 않는다: 레이아웃을 바꾸지 않고(번쩍이지 않고), 고른 테마도 남는다
  assert.deepEqual([h.state().clones, h.state().switches, h.state().sets], [1, undefined, undefined]);
  assert.equal(h.state().layout, 'muwi');
  assert.deepEqual(h.themeOf('muwi'), { light: 'paper', dark: 'atom-one-dark' });

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

test('muwi layout: muwi의 배치가 바뀌면 옛 판으로 만든 복제본을 다시 만든다', () => {
  const h = fakeApp();
  applyLayout(h.records, h.env);
  assert.equal(readLayoutRecord(h.records)!.shape, PLACE_VERSION);
  // 옛 판(높이를 바꿀 수 없던 배치)으로 만든 것처럼 기록을 되돌린다
  const file = path.join(h.records, 'layout.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete old.shape;
  fs.writeFileSync(file, JSON.stringify(old));
  const s = screenState(h.records, h.env);
  assert.equal(s.outdated, true);
  assert.equal(s.outdatedBy, 'muwi');
  assert.equal(applyLayout(h.records, h.env).refreshed, true);
  assert.equal(readLayoutRecord(h.records)!.shape, PLACE_VERSION);
  assert.equal(screenState(h.records, h.env).outdated, false);
});

test('muwi layout --graph: 그래프 자리를 바꾸면 다시 만들고, 고른 자리를 기억한다', () => {
  const h = fakeApp();
  assert.equal(applyLayout(h.records, h.env).graphAt, 'bottom');
  // 자리만 바꿀 때는 레이아웃을 바꾸지 않고 파일을 그 자리에서 고친다. 화면이 번쩍이지 않고,
  // layout.set을 쓰지 않으니 그 레이아웃에서 고른 테마와 칸 크기가 지워지지 않는다
  h.pickTheme('atom-one-dark');
  const moved = applyLayout(h.records, h.env, { graphAt: 'top' });
  assert.deepEqual([moved.moved, moved.graphAt, moved.refreshed], [true, 'top', undefined]);
  assert.equal(h.state().layout, 'muwi');
  assert.deepEqual([h.state().sets, h.state().switches, h.state().clones], [undefined, undefined, 1]);
  assert.deepEqual(h.themeOf('muwi'), { light: 'paper', dark: 'atom-one-dark' });
  assert.deepEqual(find(h.layout('muwi')!, 'muwi-split')!.children!.map(c => c.id), ['muwi-graph', 'work-body']);
  assert.equal(find(h.layout('muwi')!, 'muwi-split')!.type, 'column');
  // 아래↔위는 같은 방향이라 크기를 그대로 둔다
  assert.equal(h.state().resized, undefined);
  // 사이드바 목록은 그대로, 그래프는 그래프만 그리는 모양 그대로
  assert.deepEqual(find(h.layout('muwi')!, 'agents')!.content, { mod: 'muwi', props: { variant: 'list' } });
  assert.deepEqual(find(h.layout('muwi')!, 'muwi-graph')!.content, { mod: 'muwi', props: { variant: 'graph' } });
  assert.equal(readLayoutRecord(h.records)!.graphAt, 'top');
  // 앱이 파일을 다시 쓰며 키 순서가 바뀌어도 손으로 고친 것으로 보지 않는다
  assert.equal(screenState(h.records, h.env).edited, false);
  // 자리를 말하지 않으면 그대로 둔다
  assert.deepEqual([applyLayout(h.records, h.env).already, applyLayout(h.records, h.env).graphAt], [true, 'top']);
  // 원래 레이아웃으로 돌아갔다가 다시 넣어도 고른 자리를 쓴다
  removeLayout(h.records, h.env);
  h.set({ layout: 'main' });
  fs.writeFileSync(path.join(h.records, 'layout.json'), JSON.stringify({ name: 'gone', base: 'main', hash: 'x', list: true, graph: true, graphAt: 'top', at: '' }));
  assert.equal(applyLayout(h.records, h.env).graphAt, 'top');
});

/** 0.10까지 고를 수 있던 오른쪽 자리에 그래프 칸을 둔 muwi 레이아웃 (가로 묶음, 기록에 right) */
function onRight(h: ReturnType<typeof fakeApp>) {
  applyLayout(h.records, h.env);
  const file = path.join(h.app, 'layouts', 'muwi.json');
  const tree = JSON.parse(fs.readFileSync(file, 'utf8')) as LayoutNode;
  const split = find(tree, 'muwi-split')!;
  split.type = 'row';
  find(tree, 'muwi-graph')!.size = { px: 480 };
  fs.writeFileSync(file, JSON.stringify(tree, null, 2));
  const record = readLayoutRecord(h.records)!;
  fs.writeFileSync(path.join(h.records, 'layout.json'), JSON.stringify({ ...record, graphAt: 'right', hash: treeHash(tree), hashKind: 'tree' }));
}

test('0.10까지의 오른쪽 자리: muwi layout과 muwi setup이 그래프 칸을 터미널 아래로 옮기고 기본 높이로 맞춘다', () => {
  const h = fakeApp();
  onRight(h);
  const moved = applyLayout(h.records, h.env);
  assert.deepEqual([moved.moved, moved.graphAt], [true, 'bottom']);
  assert.equal(find(h.layout('muwi')!, 'muwi-split')!.type, 'column');
  assert.deepEqual(find(h.layout('muwi')!, 'muwi-split')!.children!.map(c => c.id), ['work-body', 'muwi-graph']);
  assert.deepEqual(h.state().resized, { id: 'muwi-graph', px: 300 });
  assert.equal(readLayoutRecord(h.records)!.graphAt, 'bottom');
  // muwi setup이 부르는 것: 옮겼다고 알린다. 옮길 것이 없으면 아무 말도 하지 않는다
  const h2 = fakeApp();
  onRight(h2);
  assert.match(moveOffRight(h2.records, h2.env)!, /오른쪽 자리는 없어져서 터미널 아래로 옮겼어요/);
  assert.equal(find(h2.layout('muwi')!, 'muwi-split')!.type, 'column');
  assert.equal(moveOffRight(h2.records, h2.env), null);
  // 다른 레이아웃을 보는 중이면 건드리지 않고 다음에 옮긴다고 알린다
  const h3 = fakeApp();
  onRight(h3);
  h3.set({ layout: 'main' });
  assert.match(moveOffRight(h3.records, h3.env)!, /muwi layout을 실행하면 터미널 아래로 옮겨요/);
  assert.equal(find(h3.layout('muwi')!, 'muwi-split')!.type, 'row');
  // 그동안 설정 화면의 그림도 아래 그림으로 바꾸지 않는다 (옮길 때 새로 그린다)
  assert.equal(ensurePreview(h3.records, h3.env), false);
  // 손으로 고친 레이아웃이면 그 까닭과 고치는 법을 알린다
  const h4 = fakeApp();
  onRight(h4);
  const file = path.join(h4.app, 'layouts', 'muwi.json');
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  edited.note = '손으로 고침';
  fs.writeFileSync(file, JSON.stringify(edited));
  assert.match(moveOffRight(h4.records, h4.env)!, /오른쪽 자리는 없어졌어요\. 그래프 자리를 바꾸려고 했지만[\s\S]*손으로 고친 것 같아/);
});

test('레이아웃 그림: 설정 화면에 보일 그림을 그래프 자리마다 다르게 그린다', () => {
  const pictures = (['bottom', 'top'] as const).map(w => layoutPreview(w));
  for (const svg of pictures) assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 320 200">/);
  assert.equal(new Set(pictures).size, 2);
});

test('muwi layout: Herdr 설정 화면에 보일 그림을 그래프 자리대로 같이 쓰고, 자리를 옮기면 다시 그리고, 되돌리면 지운다', () => {
  const h = fakeApp();
  const picture = () => {
    const file = path.join(h.app, 'layouts', 'muwi.svg');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  applyLayout(h.records, h.env);
  assert.equal(h.layout('muwi')!.preview, 'layouts/muwi.svg');
  assert.equal(picture(), layoutPreview('bottom'));
  // 그림을 적어도 우리가 쓴 그대로로 본다 (손으로 고친 것으로 보지 않는다)
  assert.equal(screenState(h.records, h.env).edited, false);
  applyLayout(h.records, h.env, { graphAt: 'top' });
  assert.equal(h.layout('muwi')!.preview, 'layouts/muwi.svg');
  assert.equal(picture(), layoutPreview('top'));
  assert.equal(screenState(h.records, h.env).edited, false);
  removeLayout(h.records, h.env);
  assert.equal(picture(), null);
});

test('muwi setup: 그림 없이 만든 muwi 레이아웃(0.5.24까지)에 그림을 넣는다. 손으로 고친 복제본은 그대로 둔다', () => {
  const h = fakeApp();
  applyLayout(h.records, h.env, { graphAt: 'top' });
  // 그림 없이 만든 옛 복제본으로 되돌려 둔다
  const old = () => {
    const { preview: _, ...tree } = h.layout('muwi')!;
    fs.writeFileSync(path.join(h.app, 'layouts', 'muwi.json'), JSON.stringify(tree, null, 2));
    fs.rmSync(path.join(h.app, 'layouts', 'muwi.svg'), { force: true });
    return tree;
  };
  const tree = old();
  fs.writeFileSync(path.join(h.records, 'layout.json'), JSON.stringify({ ...readLayoutRecord(h.records), hash: treeHash(tree) }));
  assert.equal(ensurePreview(h.records, h.env), true);
  assert.equal(h.layout('muwi')!.preview, 'layouts/muwi.svg');
  assert.equal(fs.readFileSync(path.join(h.app, 'layouts', 'muwi.svg'), 'utf8'), layoutPreview('top'));
  assert.equal(screenState(h.records, h.env).edited, false);
  // 이미 있으면 다시 쓰지 않는다
  assert.equal(ensurePreview(h.records, h.env), false);
  // 옛 판의 그림이면 그림 파일만 새 그림으로 바꾼다
  fs.writeFileSync(path.join(h.app, 'layouts', 'muwi.svg'), '<svg/>');
  assert.equal(ensurePreview(h.records, h.env), true);
  assert.equal(fs.readFileSync(path.join(h.app, 'layouts', 'muwi.svg'), 'utf8'), layoutPreview('top'));
  // 사람이 손으로 고친 복제본에는 넣지 않는다
  old();
  const edited = { ...h.layout('muwi')!, titlebar: 'native' };
  fs.writeFileSync(path.join(h.app, 'layouts', 'muwi.json'), JSON.stringify(edited, null, 2));
  assert.equal(ensurePreview(h.records, h.env), false);
  assert.equal(h.layout('muwi')!.preview, undefined);
});

test('muwi layout --graph: muwi layout이 만들지 않은 레이아웃은 자리를 바꾸지 않는다', () => {
  const mine = placeMuwi(MAIN).tree;
  const h = fakeApp({ main: MAIN, mine });
  h.set({ layout: 'mine' });
  assert.throws(() => applyLayout(h.records, h.env, { graphAt: 'top' }), /muwi layout이 만든 것이 아니라/);
  assert.equal(applyLayout(h.records, h.env).already, true);
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
  assert.match(muwi('layout').out, /이미 muwi 칸이 있는 레이아웃이에요: muwi \(그래프: 터미널 아래\)/);
  assert.match(muwi('layout', '--graph', 'top').out, /그래프를 터미널 위에 뒀어요/);
  assert.match(muwi('layout', '--graph', 'right').err, /오른쪽 자리는 없어졌어요[\s\S]*--graph는 bottom, top 중 하나예요/);
  assert.match(muwi('layout', '--graph', 'left').err, /--graph는 bottom, top 중 하나예요/);
  // muwi open --right도 없어졌다고 알린다 (앱에 묻기 전에 멈춘다)
  const right = muwi('open', '--right');
  assert.equal(right.code, 1);
  assert.match(right.err, /오른쪽 자리는 없어졌어요[\s\S]*이 터미널 아래에 열어요/);
  assert.equal(JSON.parse(muwi('layout', '--status', '--json').out).muwi, true);
  const removed = muwi('layout', '--remove');
  assert.match(removed.out, /main 레이아웃으로 되돌렸어요[\s\S]*복제본을 지웠어요/);
  h.set({ up: false });
  const closed = muwi('layout');
  assert.equal(closed.code, 1);
  assert.match(closed.err, /Herdr 앱이 열려 있지 않거나/);
});
