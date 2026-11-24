// Herdr 앱 화면(레이아웃)에 muwi 칸을 넣고 빼는 곳 (muwi layout).
//   사이드바의 Agents 칸 자리 → muwi 작업 목록 (variant list)
//   터미널 영역 아래 → muwi 그래프 (variant graph. 목록을 넣지 못했으면 목록까지 있는 full)
// 사람이 쓰던 레이아웃은 고치지 않는다. 지금 레이아웃을 복제(layout.clone)하고 복제본만 바꾼다.
// 되돌리면 원래 레이아웃으로 바꾸고 복제본을 지운다. 사람이 복제본을 손으로 고쳤으면 지우지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { herdrApp } from './hc.ts';
import { layoutPreview } from './preview.ts';
import { readJson, writeJson } from 'muwi/store';

export const LAYOUT_NAME = 'muwi';
export const GRAPH_ID = 'muwi-graph';
/** 터미널 영역과 그래프를 담는 세로 묶음. 이 묶음 안의 경계는 끌어서 높이를 바꿀 수 있다 */
export const SPLIT_ID = 'muwi-split';
/**
 * muwi 칸을 넣는 배치의 판. 배치를 바꾸면 올린다. 옛 판으로 만든 복제본은 muwi layout이 다시 만든다
 *   1: 그래프를 터미널 영역 아래에 끼워 넣음 (높이 고정)
 *   2: 터미널 영역과 그래프를 끌 수 있는 경계로 나눔
 */
export const PLACE_VERSION = 2;
const GRAPH_PX = 300;
const GRAPH_SIDE_PX = 480;

/** 그래프 칸의 자리: 터미널 영역의 아래, 위, 오른쪽 */
export type GraphAt = 'bottom' | 'top' | 'right';
export const GRAPH_AT: GraphAt[] = ['bottom', 'top', 'right'];
/** Herdr가 직접 내는 레이아웃. 업데이트되면 그 모양을 따라 다시 복제할 수 있다 */
const SHIPPED = new Set(['main', 'terminals', 'win98']);

export type LayoutNode = {
  id?: string;
  type?: string;
  content?: { mod?: string; tab?: string; props?: Record<string, unknown> } & Record<string, unknown>;
  children?: LayoutNode[];
  size?: unknown;
  cloned_from?: { name?: string; version?: string };
  [key: string]: unknown;
};

/** muwi layout이 바꾼 것. 되돌리기와 다시 맞추기에 쓴다 */
export type LayoutRecord = {
  /** 우리가 만든 복제본의 이름 */
  name: string;
  /** 복제하기 전에 보던 레이아웃 */
  base: string;
  /** 복제할 때의 Herdr 버전 */
  version?: string;
  /** 우리가 쓴 복제본의 해시. 다르면 사람이 고친 것이다 */
  hash: string;
  /** tree: 나무 내용의 해시 (키 순서와 상관없다). 없으면 파일 글자의 해시 (0.5.3 이하) */
  hashKind?: 'tree';
  /** 어느 판의 배치로 넣었나 (PLACE_VERSION). 없으면 1 */
  shape?: number;
  list: boolean;
  graph: boolean;
  /** 그래프 칸을 둔 자리. 없으면 아래 */
  graphAt?: GraphAt;
  at: string;
};

const recordFile = (dir: string) => path.join(dir, 'layout.json');
export const readLayoutRecord = (dir: string) => readJson<LayoutRecord>(recordFile(dir));

const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** 키 순서와 상관없이 같은 나무면 같은 글이 되게 (Herdr가 layout.set으로 파일을 다시 쓰면 키 순서가 바뀐다) */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
export const treeHash = (tree: LayoutNode) => hashOf(JSON.stringify(stable(tree)));

/** 복제본이 우리가 마지막으로 쓴 그대로인가. 예전 기록(hashKind 없음)은 파일 글자로 비교한다 */
function untouched(record: LayoutRecord, file: { tree: LayoutNode; text: string }): boolean {
  return record.hashKind === 'tree' ? treeHash(file.tree) === record.hash : hashOf(file.text) === record.hash;
}
/** Herdr 앱의 설정 폴더 (setup.ts의 places와 같은 규칙) */
const herdrHome = (env: NodeJS.ProcessEnv) => env.HERDR_APP_HOME || path.join(env.HOME || os.homedir(), '.config', 'herdr-app');
const layoutsDir = (env: NodeJS.ProcessEnv) => path.join(herdrHome(env), 'layouts');
const layoutPath = (env: NodeJS.ProcessEnv, name: string) => path.join(layoutsDir(env), `${name}.json`);
/** Herdr 설정 화면이 이 레이아웃의 그림으로 보여 줄 파일 (레이아웃 파일 옆) */
const previewPath = (env: NodeJS.ProcessEnv, name: string) => path.join(layoutsDir(env), `${name}.svg`);

/** 설정 화면에 보일 그림을 그래프 칸의 자리대로 그려 둔다. 못 그렸으면 false */
function drawPreview(env: NodeJS.ProcessEnv, name: string, where: GraphAt): boolean {
  try {
    fs.writeFileSync(previewPath(env, name), layoutPreview(where));
    return true;
  } catch {
    return false;
  }
}

/**
 * 그림을 그려 두고 레이아웃 나무에 그 그림을 적는다 ("preview": "layouts/<이름>.svg", Herdr 폴더에서 본 경로).
 * 그림이 없으면 설정 화면은 빈 틀만 그린다. 그림을 못 그려도 레이아웃은 그대로 쓴다
 */
function withPreview(env: NodeJS.ProcessEnv, name: string, tree: LayoutNode, where: GraphAt): LayoutNode {
  const { preview: _old, ...rest } = tree;
  return drawPreview(env, name, where) ? { ...rest, preview: `layouts/${name}.svg` } : rest;
}

function walk(node: LayoutNode, visit: (n: LayoutNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** 조건에 맞는 첫 노드까지의 길 (뿌리부터) */
function trailTo(node: LayoutNode, match: (n: LayoutNode) => boolean, trail: LayoutNode[] = []): LayoutNode[] | null {
  const here = [...trail, node];
  if (match(node)) return here;
  for (const child of node.children ?? []) {
    const found = trailTo(child, match, here);
    if (found) return found;
  }
  return null;
}

/** 레이아웃에 muwi 칸이 들어 있는가 */
export function hasMuwi(tree: LayoutNode): boolean {
  let found = false;
  walk(tree, n => {
    if (n.content?.mod === 'muwi') found = true;
  });
  return found;
}

/**
 * 레이아웃 나무에 muwi 칸을 넣은 새 나무를 돌려준다. 넣을 자리를 찾지 못한 쪽은 false.
 *   list: Agents 칸(content.mod "agents")의 내용을 muwi 작업 목록으로 바꿨다. 칸의 자리·크기는 그대로다
 *   graph: 터미널 영역(content.tab "active")을 담은 칸 아래에 그래프 칸을 넣었다. 둘을 새 세로 묶음으로 감싸서
 *          그 사이 경계를 끌어 높이를 바꿀 수 있게 한다 (Herdr의 기본 레이아웃은 작업 영역의 경계를 끌 수 없게 해 둔다)
 */
export function placeMuwi(tree: LayoutNode, where: GraphAt = 'bottom'): { tree: LayoutNode; list: boolean; graph: boolean } {
  const root = structuredClone(tree);
  let list = false;
  walk(root, n => {
    if (!list && n.type === 'block' && n.content?.mod === 'agents') {
      n.content = { mod: 'muwi', props: { variant: 'list' } };
      list = true;
    }
  });

  const trail = trailTo(root, n => n.type === 'block' && n.content?.tab === 'active');
  let graph = false;
  if (trail && trail.length > 1) {
    const side = where === 'right';
    const block: LayoutNode = {
      id: GRAPH_ID,
      type: 'block',
      size: { px: side ? GRAPH_SIDE_PX : GRAPH_PX },
      min: side ? 280 : 140,
      max: side ? 1400 : 900,
      content: { mod: 'muwi', props: { variant: list ? 'graph' : 'full' } },
    };
    // 터미널 영역을 담은 가장 가까운 세로 묶음에서 터미널 영역 쪽 칸을 고른다 (오른쪽 패널이 있으면 그것까지).
    // 세로 묶음이 없으면 터미널 영역 칸 자체를 고른다
    let parent = trail[trail.length - 2];
    let target = trail[trail.length - 1];
    for (let i = trail.length - 2; i >= 0; i--) {
      if (trail[i].type !== 'column') continue;
      parent = trail[i];
      target = trail[i + 1];
      break;
    }
    // 고른 칸과 그래프를 끌 수 있는 경계로 나눈 묶음으로 감싼다 (아래·위는 세로, 오른쪽은 가로).
    // 묶음은 고른 칸의 자리와 크기를 물려받는다
    const at = parent.children!.indexOf(target);
    const { size, min, max, ...rest } = target;
    const main = { ...rest, size: { weight: 1 }, min: side ? 320 : 120 };
    parent.children![at] = {
      id: SPLIT_ID,
      type: side ? 'row' : 'column',
      resizable: true,
      divider: { width: 1, color: 'border' },
      ...(size !== undefined ? { size } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      children: where === 'top' ? [block, main] : [main, block],
    };
    graph = true;
  }
  return { tree: root, list, graph };
}

export type Screen = {
  /** Herdr 앱이 열려 있는가 */
  app: boolean;
  /** 지금 보이는 레이아웃 */
  shown?: string;
  /** 지금 레이아웃에 muwi 칸이 있는가 */
  muwi: boolean;
  /** muwi 칸을 넣을 자리가 있는가 */
  canList: boolean;
  canGraph: boolean;
  /** muwi layout으로 바꾼 기록 */
  record: LayoutRecord | null;
  /** 우리 복제본을 새로 만들어야 한다: Herdr가 업데이트됐거나(herdr) muwi의 배치가 바뀌었다(muwi) */
  outdated: boolean;
  outdatedBy?: 'herdr' | 'muwi';
  /** 사람이 복제본을 손으로 고쳤다 */
  edited: boolean;
  version?: string;
};

function appVersion(env: NodeJS.ProcessEnv): string | undefined {
  const r = herdrApp(['--version'], env, 5000);
  return r.ok ? r.out.trim().split(/\s+/).pop() : undefined;
}

function readTree(env: NodeJS.ProcessEnv, name: string): { tree: LayoutNode; text: string } | null {
  try {
    const text = fs.readFileSync(layoutPath(env, name), 'utf8');
    return { tree: JSON.parse(text) as LayoutNode, text };
  } catch {
    return null;
  }
}

function shownLayout(env: NodeJS.ProcessEnv): string | null {
  const r = herdrApp(['status'], env, 5000);
  if (!r.ok) return null;
  try {
    const name = JSON.parse(r.out)?.layout;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/** 지금 화면 상태. Herdr 앱이 닫혀 있으면 app이 false다 */
export function screenState(dir: string, env: NodeJS.ProcessEnv = process.env): Screen {
  const record = readLayoutRecord(dir);
  const shown = shownLayout(env);
  const base: Screen = { app: Boolean(shown), muwi: false, canList: false, canGraph: false, record, outdated: false, edited: false };
  if (record) {
    const file = readTree(env, record.name);
    base.edited = Boolean(file && !untouched(record, file));
  }
  if (!shown) return base;
  const version = appVersion(env);
  const file = readTree(env, shown);
  if (!file) return { ...base, shown, version };
  const placed = placeMuwi(file.tree);
  const ours = Boolean(record && record.name === shown);
  const herdrMoved = ours && SHIPPED.has(record!.base) && Boolean(version && record!.version && version !== record!.version);
  const muwiMoved = ours && (record!.shape ?? 1) < PLACE_VERSION;
  return {
    ...base,
    shown,
    version,
    muwi: hasMuwi(file.tree),
    canList: placed.list,
    canGraph: placed.graph,
    outdated: herdrMoved || muwiMoved,
    ...(herdrMoved ? { outdatedBy: 'herdr' as const } : muwiMoved ? { outdatedBy: 'muwi' as const } : {}),
  };
}

export class ScreenError extends Error {}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 앱이 새 레이아웃 파일을 다 쓸 때까지 잠깐 기다린다 (쓰는 도중이면 JSON이 아직 깨져 있다) */
function waitForTree(env: NodeJS.ProcessEnv, name: string, ms = 3000): { tree: LayoutNode; text: string } | null {
  for (let waited = 0; waited <= ms; waited += 100) {
    const got = readTree(env, name);
    if (got) return got;
    pause(100);
  }
  return null;
}

/** 쓴 레이아웃을 앱이 받아들였는지 본다. 받아들이지 않으면 <이름>.error에 이유를 적는다 */
function layoutError(env: NodeJS.ProcessEnv, name: string, since: number): string | null {
  for (const file of [path.join(herdrHome(env), 'layout.error'), path.join(layoutsDir(env), `${name}.error`)]) {
    try {
      if (fs.statSync(file).mtimeMs < since) continue;
      return fs.readFileSync(file, 'utf8').trim() || '이유 없음';
    } catch {
      // 파일이 없으면 받아들인 것이다
    }
  }
  return null;
}

/**
 * 레이아웃 파일을 그 자리에서 고친다. 앱이 바로 다시 읽으므로 레이아웃을 바꾸지 않아도 된다.
 * layout.set은 쓰지 않는다: 그 레이아웃에서 사람이 고른 것(테마, 칸 크기, 고른 탭. layouts/.state)을 모두 지운다.
 * 파일을 고치면 고친 칸의 값만 파일을 따르고 나머지는 그대로 남는다.
 * 앱이 받아들이지 않으면 before(전 내용)로 되돌리고 그 이유를 돌려준다
 */
function writeLayout(env: NodeJS.ProcessEnv, name: string, tree: LayoutNode, before?: string): string | null {
  const file = layoutPath(env, name);
  const put = (text: string) => {
    const tmp = `${file}.muwi-tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  const since = Date.now();
  put(JSON.stringify(tree, null, 2) + '\n');
  pause(1200);
  const problem = layoutError(env, name, since);
  if (problem && before !== undefined) put(before);
  return problem;
}

/** 그래프 칸이 가로·세로를 바꿨으면 그 방향의 기본 크기로 맞춘다 */
function fitGraph(env: NodeJS.ProcessEnv, was: GraphAt, where: GraphAt) {
  if ((was === 'right') === (where === 'right')) return;
  herdrApp(['do', 'layout.resize', JSON.stringify({ id: GRAPH_ID, px: where === 'right' ? GRAPH_SIDE_PX : GRAPH_PX })], env);
}

function freeName(env: NodeJS.ProcessEnv, record: LayoutRecord | null): string {
  const ours = (name: string) => {
    if (record?.name !== name) return false;
    const file = readTree(env, name);
    return !file || untouched(record, file);
  };
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? LAYOUT_NAME : `${LAYOUT_NAME}-${i}`;
    if (!fs.existsSync(layoutPath(env, name)) || ours(name)) return name;
  }
  throw new ScreenError('muwi 레이아웃 이름을 정하지 못했어요. layouts 폴더의 muwi-* 파일을 정리해 주세요.');
}

export type Applied = { name: string; base: string; list: boolean; graph: boolean; graphAt: GraphAt; already?: boolean; refreshed?: boolean; moved?: boolean };

/**
 * 지금 레이아웃을 복제해 muwi 칸을 넣고 그 레이아웃으로 바꾼다.
 * 이미 muwi 칸이 있으면 그대로 둔다. 우리 복제본이 옛 모양이면(Herdr 업데이트, muwi 배치 변경) 원래 레이아웃의
 * 새 모양으로, 그래프 자리를 바꾸라고 하면(graphAt) 그 자리로, 복제본 파일을 그 자리에서 고친다.
 */
export function applyLayout(dir: string, env: NodeJS.ProcessEnv = process.env, o: { graphAt?: GraphAt } = {}): Applied {
  const state = screenState(dir, env);
  if (!state.app || !state.shown) throw new ScreenError('Herdr 앱이 열려 있지 않거나 herdr-app 명령이 없어요. Herdr 앱을 켠 뒤에 다시 실행해요.');
  const ours = Boolean(state.record && state.record.name === state.shown);
  const was = state.record?.graphAt ?? 'bottom';
  // 자리를 말하지 않으면 전에 고른 자리를 쓴다
  const where = o.graphAt ?? state.record?.graphAt ?? 'bottom';
  const base = state.shown;
  // 그래프 자리만 바꾸는 것이면 지금 레이아웃에서 그 칸만 옮긴다. 레이아웃을 바꾸지 않으니 화면이 번쩍이지 않는다
  if (state.muwi && ours && where !== was && !state.outdated && !state.edited) return moveGraph(dir, env, state.record!, where);
  if (state.muwi) {
    const moved = ours && where !== was;
    if (!state.outdated && !moved) {
      if (o.graphAt && !ours) throw new ScreenError(`${state.shown} 레이아웃은 muwi layout이 만든 것이 아니라 그래프 자리를 바꾸지 못해요. 레이아웃 파일에서 muwi 칸을 옮기거나, muwi 칸이 없는 레이아웃에서 muwi layout --graph ${where}을 실행해요.`);
      return { name: state.shown, base: state.record?.base ?? state.shown, list: true, graph: true, graphAt: was, already: true };
    }
    // Herdr가 업데이트됐거나 muwi의 배치가 바뀌었다. 우리 복제본을 그 자리에서 새 모양으로 고친다 (사람이 손으로 고쳤으면 그대로 둔다)
    if (state.edited) {
      const why = moved ? '그래프 자리를 바꾸려고 했지만' : state.outdatedBy === 'herdr' ? 'Herdr가 업데이트됐지만' : 'muwi 화면 배치가 바뀌었지만';
      throw new ScreenError(`${why} ${state.shown} 레이아웃을 손으로 고친 것 같아 다시 만들지 않았어요. 고친 복제본은 남겨 두고 새로 만들려면 muwi layout --remove 뒤에 muwi layout을 실행해요.`);
    }
    return rebuild(dir, env, state, where);
  }
  const from = readTree(env, base);
  if (!from) throw new ScreenError(`${base} 레이아웃 파일을 읽지 못했어요.`);
  const check = placeMuwi(from.tree, where);
  if (!check.list && !check.graph) {
    throw new ScreenError(`${base} 레이아웃에는 Agents 칸도 터미널 영역도 없어서 muwi 칸을 넣을 자리를 못 찾았어요. 그래프는 muwi open으로 터미널 옆에 열어요.`);
  }

  const name = freeName(env, readLayoutRecord(dir));
  fs.rmSync(layoutPath(env, name), { force: true });
  const cloned = herdrApp(['do', 'layout.clone', JSON.stringify({ name: base, as: name })], env);
  if (!cloned.ok) throw new ScreenError(`레이아웃을 복제하지 못했어요: ${(cloned.err || cloned.out).trim()}`);
  const file = layoutPath(env, name);
  const copy = waitForTree(env, name);
  if (!copy) throw new ScreenError(`복제한 레이아웃을 읽지 못했어요: ${file}`);

  // 복제하면 원래 레이아웃에서 사람이 고른 것(테마, 칸 크기)도 따라온다. 파일을 고쳐도 그것은 남는다
  const placed = placeMuwi(copy.tree, where);
  const tree = withPreview(env, name, placed.tree, where);
  // 앱이 받아들이지 않았으면 원래대로 돌린다
  const problem = writeLayout(env, name, tree);
  if (problem) {
    switchTo(env, base);
    fs.rmSync(file, { force: true });
    fs.rmSync(previewPath(env, name), { force: true });
    throw new ScreenError(`Herdr 앱이 바꾼 레이아웃을 받아들이지 않아 원래대로 돌렸어요: ${problem}`);
  }
  // 복제하면 앱이 그 레이아웃으로 바꾼다. 혹시 바꾸지 않았으면 바꾼다
  if (shownLayout(env) !== name) switchTo(env, name);

  const record: LayoutRecord = {
    name,
    base,
    ...(copy.tree.cloned_from?.version ? { version: copy.tree.cloned_from.version } : state.version ? { version: state.version } : {}),
    hash: treeHash(tree),
    hashKind: 'tree',
    shape: PLACE_VERSION,
    list: placed.list,
    graph: placed.graph,
    graphAt: where,
    at: new Date().toISOString(),
  };
  writeJson(recordFile(dir), record);
  return { name, base, list: placed.list, graph: placed.graph, graphAt: where };
}

/**
 * Herdr가 업데이트됐거나 muwi의 배치가 바뀌었다: 원래 레이아웃의 새 모양으로 우리 복제본을 그 자리에서 다시 쓴다.
 * 복제본을 지우고 다시 복제하면 이 레이아웃에서 사람이 고른 것(테마, 칸 크기, 고른 탭)이 사라지므로 그러지 않는다.
 * 레이아웃을 바꾸지 않으니 화면도 번쩍이지 않는다
 */
function rebuild(dir: string, env: NodeJS.ProcessEnv, state: Screen, where: GraphAt): Applied {
  const record = state.record!;
  const was = record.graphAt ?? 'bottom';
  const from = readTree(env, record.base);
  if (!from) throw new ScreenError(`${record.base} 레이아웃 파일을 읽지 못했어요.`);
  const placed = placeMuwi(from.tree, where);
  if (!placed.list && !placed.graph) {
    throw new ScreenError(`${record.base} 레이아웃에 muwi 칸을 넣을 자리가 없어졌어요. muwi layout --remove 뒤에 muwi open으로 터미널 옆에 열어요.`);
  }
  const before = readTree(env, record.name);
  const version = state.version ?? before?.tree.cloned_from?.version ?? record.version;
  // Herdr가 복제할 때처럼 어디서 복제했는지 적는다 (다음 업데이트를 알아보는 데 쓴다)
  const tree = withPreview(env, record.name, { ...placed.tree, cloned_from: { name: record.base, ...(version ? { version } : {}) } }, where);
  const problem = writeLayout(env, record.name, tree, before?.text);
  if (problem) {
    drawPreview(env, record.name, was);
    throw new ScreenError(`Herdr 앱이 새 모양을 받아들이지 않아 원래대로 돌렸어요: ${problem}`);
  }
  fitGraph(env, was, where);
  const next: LayoutRecord = {
    ...record,
    ...(version ? { version } : {}),
    hash: treeHash(tree),
    hashKind: 'tree',
    shape: PLACE_VERSION,
    list: placed.list,
    graph: placed.graph,
    graphAt: where,
    at: new Date().toISOString(),
  };
  writeJson(recordFile(dir), next);
  return { name: record.name, base: record.base, list: placed.list, graph: placed.graph, graphAt: where, ...(where !== was ? { moved: true } : { refreshed: true }) };
}

/** 레이아웃 나무에서 muwi가 넣은 묶음(터미널 영역 + 그래프)을 풀어 터미널 영역만 그 자리에 돌려놓는다 */
export function unplaceGraph(tree: LayoutNode): LayoutNode {
  const root = structuredClone(tree);
  const trail = trailTo(root, n => n.id === SPLIT_ID);
  if (!trail || trail.length < 2) return root;
  const split = trail[trail.length - 1];
  const parent = trail[trail.length - 2];
  const main = (split.children ?? []).find(c => c.id !== GRAPH_ID);
  if (!main) return root;
  // 감쌀 때 터미널 영역에 붙인 크기는 떼고, 묶음이 물려받았던 원래 크기를 돌려준다
  const { size: _size, min: _min, max: _max, ...rest } = main;
  const back: LayoutNode = { ...rest };
  if (split.size !== undefined) back.size = split.size;
  if (split.min !== undefined) back.min = split.min;
  if (split.max !== undefined) back.max = split.max;
  parent.children![parent.children!.indexOf(split)] = back;
  return root;
}

/**
 * 지금 보이는 muwi 레이아웃에서 그래프 칸만 다른 자리로 옮긴다. 레이아웃 파일을 그 자리에서 고쳐서(writeLayout)
 * 레이아웃을 바꾸지 않고, 사람이 고른 테마와 칸 크기도 지킨다. 가로·세로가 바뀌면 그 방향의 기본 크기로 맞춘다
 */
function moveGraph(dir: string, env: NodeJS.ProcessEnv, record: LayoutRecord, where: GraphAt): Applied {
  const file = readTree(env, record.name);
  if (!file) throw new ScreenError(`${record.name} 레이아웃 파일을 읽지 못했어요.`);
  const content = trailTo(file.tree, n => n.id === GRAPH_ID)?.at(-1)?.content;
  const placed = placeMuwi(unplaceGraph(file.tree), where);
  const graph = trailTo(placed.tree, n => n.id === GRAPH_ID)?.at(-1);
  if (!graph) throw new ScreenError('그래프 칸을 옮길 자리를 찾지 못했어요.');
  if (content) graph.content = content; // 사이드바 목록이 있으니 그래프만 그리는 모양 그대로
  // 설정 화면의 그림도 새 자리대로
  const tree = withPreview(env, record.name, placed.tree, where);
  const problem = writeLayout(env, record.name, tree, file.text);
  if (problem) {
    drawPreview(env, record.name, record.graphAt ?? 'bottom');
    throw new ScreenError(`Herdr 앱이 옮긴 레이아웃을 받아들이지 않아 원래대로 돌렸어요: ${problem}`);
  }
  fitGraph(env, record.graphAt ?? 'bottom', where);
  writeJson(recordFile(dir), { ...record, graphAt: where, hash: treeHash(tree), hashKind: 'tree', at: new Date().toISOString() });
  return { name: record.name, base: record.base, list: record.list, graph: true, graphAt: where, moved: true };
}

function switchTo(env: NodeJS.ProcessEnv, name: string) {
  const r = herdrApp(['do', 'layout.switch', JSON.stringify({ name })], env);
  if (!r.ok) throw new ScreenError(`${name} 레이아웃으로 바꾸지 못했어요: ${(r.err || r.out).trim()}`);
}

export type Removed = { switchedTo?: string; deleted: boolean; kept?: string; none?: boolean };

/** muwi layout으로 바꾼 것을 되돌린다: 원래 레이아웃으로 바꾸고, 손대지 않은 복제본은 지운다 */
export function removeLayout(dir: string, env: NodeJS.ProcessEnv = process.env): Removed {
  const record = readLayoutRecord(dir);
  if (!record) return { deleted: false, none: true };
  const shown = shownLayout(env);
  const result: Removed = { deleted: false };
  const file = layoutPath(env, record.name);
  const current = readTree(env, record.name);
  if (shown === record.name) {
    const back = fs.existsSync(layoutPath(env, record.base)) ? record.base : 'main';
    switchTo(env, back);
    result.switchedTo = back;
  }
  // 앱이 닫혀 있고 그 레이아웃이 마지막으로 보던 것이면 지우지 않는다 (다음에 켤 때 보여 줄 것이 없어진다)
  const stillShown = !shown && sharedLayout(env) === record.name;
  if (current && !untouched(record, current)) result.kept = file;
  else if (current && !stillShown) {
    fs.rmSync(file, { force: true });
    fs.rmSync(previewPath(env, record.name), { force: true });
    result.deleted = true;
  } else if (stillShown) result.kept = file;
  fs.rmSync(recordFile(dir), { force: true });
  return result;
}

/**
 * 그림 없이 만든 muwi 레이아웃(0.5.24까지)에 설정 화면의 그림을 넣고, 이미 있으면 지금 판의 그림으로 맞춘다. muwi setup이 부른다.
 * 우리가 쓴 그대로인 복제본에만 넣고, 사람이 손으로 고친 복제본은 그대로 둔다. 그래프 자리는 기록대로. 넣었으면 true
 */
export function ensurePreview(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const record = readLayoutRecord(dir);
  if (!record) return false;
  const file = readTree(env, record.name);
  if (!file || !untouched(record, file)) return false;
  if (file.tree.preview && fs.existsSync(previewPath(env, record.name))) {
    // 그림이 이미 있으면 그림 파일만 지금 판의 그림으로 맞춘다 (색 같은 것이 바뀌었을 때). 레이아웃 파일은 건드리지 않는다
    const want = layoutPreview(record.graphAt ?? 'bottom');
    if (fs.readFileSync(previewPath(env, record.name), 'utf8') === want) return false;
    return drawPreview(env, record.name, record.graphAt ?? 'bottom');
  }
  const tree = withPreview(env, record.name, file.tree, record.graphAt ?? 'bottom');
  if (!tree.preview || writeLayout(env, record.name, tree, file.text)) return false;
  writeJson(recordFile(dir), { ...record, hash: treeHash(tree), hashKind: 'tree' });
  return true;
}

/** 앱이 닫혀 있을 때 마지막으로 보던 레이아웃 (shared.json) */
function sharedLayout(env: NodeJS.ProcessEnv): string | null {
  const shared = readJson<{ layout?: string }>(path.join(herdrHome(env), 'shared.json'));
  return typeof shared?.layout === 'string' ? shared.layout : null;
}
