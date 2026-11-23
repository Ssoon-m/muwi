// Herdr 앱 화면(레이아웃)에 muwi 칸을 넣고 빼는 곳 (muwi layout).
//   사이드바의 Agents 칸 자리 → muwi 작업 목록 (variant list)
//   터미널 영역 아래 → muwi 그래프 (variant graph. 목록을 넣지 못했으면 목록까지 있는 full)
// 사람이 쓰던 레이아웃은 고치지 않는다. 지금 레이아웃을 복제(layout.clone)하고 복제본만 바꾼다.
// 되돌리면 원래 레이아웃으로 바꾸고 복제본을 지운다. 사람이 복제본을 손으로 고쳤으면 지우지 않는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { herdrApp } from './herdr.ts';
import { readJson, writeJson } from './store.ts';

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
  /** 우리가 쓴 복제본 파일의 해시. 다르면 사람이 고친 것이다 */
  hash: string;
  /** 어느 판의 배치로 넣었나 (PLACE_VERSION). 없으면 1 */
  shape?: number;
  list: boolean;
  graph: boolean;
  at: string;
};

const recordFile = (dir: string) => path.join(dir, 'layout.json');
export const readLayoutRecord = (dir: string) => readJson<LayoutRecord>(recordFile(dir));

const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
/** Herdr 앱의 설정 폴더 (setup.ts의 places와 같은 규칙) */
const herdrHome = (env: NodeJS.ProcessEnv) => env.HERDR_APP_HOME || path.join(env.HOME || os.homedir(), '.config', 'herdr-app');
const layoutsDir = (env: NodeJS.ProcessEnv) => path.join(herdrHome(env), 'layouts');
const layoutPath = (env: NodeJS.ProcessEnv, name: string) => path.join(layoutsDir(env), `${name}.json`);

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
export function placeMuwi(tree: LayoutNode): { tree: LayoutNode; list: boolean; graph: boolean } {
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
    const block: LayoutNode = {
      id: GRAPH_ID,
      type: 'block',
      size: { px: GRAPH_PX },
      min: 140,
      max: 900,
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
    // 고른 칸과 그래프를 끌 수 있는 경계로 나눈 세로 묶음으로 감싼다. 묶음은 고른 칸의 자리와 크기를 물려받는다
    const at = parent.children!.indexOf(target);
    const { size, min, max, ...rest } = target;
    parent.children![at] = {
      id: SPLIT_ID,
      type: 'column',
      resizable: true,
      divider: { width: 1, color: 'border' },
      ...(size !== undefined ? { size } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      children: [{ ...rest, size: { weight: 1 }, min: 120 }, block],
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
    base.edited = Boolean(file && hashOf(file.text) !== record.hash);
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

function freeName(env: NodeJS.ProcessEnv, record: LayoutRecord | null): string {
  const ours = (name: string) => {
    if (record?.name !== name) return false;
    const file = readTree(env, name);
    return !file || hashOf(file.text) === record.hash;
  };
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? LAYOUT_NAME : `${LAYOUT_NAME}-${i}`;
    if (!fs.existsSync(layoutPath(env, name)) || ours(name)) return name;
  }
  throw new ScreenError('muwi 레이아웃 이름을 정하지 못했어요. layouts 폴더의 muwi-* 파일을 정리해 주세요.');
}

export type Applied = { name: string; base: string; list: boolean; graph: boolean; already?: boolean; refreshed?: boolean };

/**
 * 지금 레이아웃을 복제해 muwi 칸을 넣고 그 레이아웃으로 바꾼다.
 * 이미 muwi 칸이 있으면 그대로 둔다. 우리 복제본이 옛 Herdr 버전의 것이면 새 모양으로 다시 복제한다.
 */
export function applyLayout(dir: string, env: NodeJS.ProcessEnv = process.env): Applied {
  const state = screenState(dir, env);
  if (!state.app || !state.shown) throw new ScreenError('Herdr 앱이 열려 있지 않거나 herdr-app 명령이 없어요. Herdr 앱을 켠 뒤에 다시 실행해요.');
  let base = state.shown;
  let refreshed = false;
  if (state.muwi) {
    if (!state.outdated) return { name: state.shown, base: state.record?.base ?? state.shown, list: true, graph: true, already: true };
    // Herdr가 업데이트됐거나 muwi의 배치가 바뀌었다. 우리 복제본을 다시 만든다 (사람이 손으로 고쳤으면 그대로 둔다)
    if (state.edited) {
      const why = state.outdatedBy === 'herdr' ? 'Herdr가 업데이트됐지만' : 'muwi 화면 배치가 바뀌었지만';
      throw new ScreenError(`${why} ${state.shown} 레이아웃을 손으로 고친 것 같아 다시 만들지 않았어요. 고친 복제본은 남겨 두고 새로 만들려면 muwi layout --remove 뒤에 muwi layout을 실행해요.`);
    }
    base = state.record!.base;
    switchTo(env, base);
    fs.rmSync(layoutPath(env, state.shown), { force: true });
    refreshed = true;
  }
  const from = readTree(env, base);
  if (!from) throw new ScreenError(`${base} 레이아웃 파일을 읽지 못했어요.`);
  const check = placeMuwi(from.tree);
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

  const placed = placeMuwi(copy.tree);
  const text = JSON.stringify(placed.tree, null, 2) + '\n';
  const since = Date.now();
  const tmp = `${file}.muwi-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  // 앱이 받아들이지 않았으면 원래대로 돌린다
  pause(1200);
  const problem = layoutError(env, name, since);
  if (problem) {
    switchTo(env, base);
    fs.rmSync(file, { force: true });
    throw new ScreenError(`Herdr 앱이 바꾼 레이아웃을 받아들이지 않아 원래대로 돌렸어요: ${problem}`);
  }
  // 복제하면 앱이 그 레이아웃으로 바꾼다. 혹시 바꾸지 않았으면 바꾼다
  if (shownLayout(env) !== name) switchTo(env, name);

  const record: LayoutRecord = {
    name,
    base,
    ...(copy.tree.cloned_from?.version ? { version: copy.tree.cloned_from.version } : state.version ? { version: state.version } : {}),
    hash: hashOf(text),
    shape: PLACE_VERSION,
    list: placed.list,
    graph: placed.graph,
    at: new Date().toISOString(),
  };
  writeJson(recordFile(dir), record);
  return { name, base, list: placed.list, graph: placed.graph, ...(refreshed ? { refreshed } : {}) };
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
  if (current && hashOf(current.text) !== record.hash) result.kept = file;
  else if (current && !stillShown) {
    fs.rmSync(file, { force: true });
    result.deleted = true;
  } else if (stillShown) result.kept = file;
  fs.rmSync(recordFile(dir), { force: true });
  return result;
}

/** 앱이 닫혀 있을 때 마지막으로 보던 레이아웃 (shared.json) */
function sharedLayout(env: NodeJS.ProcessEnv): string | null {
  const shared = readJson<{ layout?: string }>(path.join(herdrHome(env), 'shared.json'));
  return typeof shared?.layout === 'string' ? shared.layout : null;
}
