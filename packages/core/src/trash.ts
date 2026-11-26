// 보관한 작업 지우기: 작업 폴더를 통째로(계획·기록과 그 폴더에 둔 파일까지) muwi 휴지통(~/.muwi/.trash)으로 옮긴다.
// TRASH_DAYS 동안은 muwi restore로 되살리고, 지나면 비운다. 휴지통은 점으로 시작해 작업 목록(listWorks)에 나오지 않는다.
// 지운 작업에 붙어 있던 세션은 그 작업에 더 적지 않는다 (계획이 없는 작업에는 적지 않는다). 되살리면 다시 적는다
import fs from 'node:fs';
import path from 'node:path';
import { clock, workDir } from './store.ts';

/** 작업 폴더가 있는데 계획이 없다 (지운 뒤에 남은 찌꺼기 등). 비었으면 'empty' */
function leftover(dir: string, work: string): 'none' | 'empty' | 'plan' | 'other' {
  let names: string[];
  try {
    names = fs.readdirSync(workDir(dir, work));
  } catch (e: any) {
    if (e.code === 'ENOENT') return 'none';
    throw e;
  }
  if (names.includes('plan.json')) return 'plan';
  return names.length ? 'other' : 'empty';
}

export const TRASH_DAYS = 30;
const DAY = 86_400_000;

/** 휴지통 폴더. 안의 이름은 <지운 때(ms)>-<작업> */
export const trashDir = (dir: string) => path.join(dir, '.trash');

export type Trashed = { work: string; at: number; name: string };

/** 휴지통의 작업들, 최근에 지운 것이 먼저 */
export function listTrash(dir: string): Trashed[] {
  let names: string[];
  try {
    names = fs.readdirSync(trashDir(dir));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: Trashed[] = [];
  for (const name of names) {
    const m = /^(\d+)-(.+)$/.exec(name);
    if (m && fs.statSync(path.join(trashDir(dir), name)).isDirectory()) out.push({ work: m[2], at: Number(m[1]), name });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** 작업 폴더를 휴지통으로 옮긴다. 지운 때를 돌려준다 */
export function trashWork(dir: string, work: string): number {
  let at = clock.now().getTime();
  fs.mkdirSync(trashDir(dir), { recursive: true });
  // 같은 작업을 같은 밀리초에 두 번 지우는 일은 없지만, 이름이 겹치면 한 칸 뒤로 민다
  while (fs.existsSync(path.join(trashDir(dir), `${at}-${work}`))) at += 1;
  const to = path.join(trashDir(dir), `${at}-${work}`);
  fs.renameSync(workDir(dir, work), to);
  // 잠금을 잡은 채로 옮겼으면 잠금도 같이 왔다. 되살렸을 때 남아 있지 않게 지운다
  fs.rmSync(path.join(to, '.lock'), { recursive: true, force: true });
  return at;
}

/**
 * 휴지통에서 가장 최근에 지운 그 작업을 되살린다. 휴지통에 없으면 null.
 * 같은 이름의 작업이 지금 있으면 덮어쓰지 않고 'taken', 계획 없는 폴더가 남아 있으면 'leftover'.
 * 빈 폴더만 남아 있으면 치우고 되살린다
 */
export function restoreWork(dir: string, work: string): Trashed | 'taken' | 'leftover' | null {
  const t = listTrash(dir).find(x => x.work === work);
  if (!t) return null;
  const now = leftover(dir, work);
  if (now === 'plan') return 'taken';
  if (now === 'other') return 'leftover';
  if (now === 'empty') fs.rmdirSync(workDir(dir, work));
  fs.renameSync(path.join(trashDir(dir), t.name), workDir(dir, work));
  return t;
}

/** TRASH_DAYS가 지난 것을 비운다. 지운 작업 이름들을 돌려준다 */
export function purgeTrash(dir: string): string[] {
  const now = clock.now().getTime();
  const gone: string[] = [];
  for (const t of listTrash(dir)) {
    if (now - t.at < TRASH_DAYS * DAY) continue;
    fs.rmSync(path.join(trashDir(dir), t.name), { recursive: true, force: true });
    gone.push(t.work);
  }
  return gone;
}

/** 휴지통에 남은 날 (0이면 오늘 비워진다) */
export const daysLeft = (t: Trashed) => Math.max(0, TRASH_DAYS - Math.floor((clock.now().getTime() - t.at) / DAY));
