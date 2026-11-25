// Herdr 앱 보기가 더하는 명령: 화면 설정(layout), 그래프 칸 열기(open).
// 기록을 읽고 쓰는 명령(board, run, tidy …)은 코어에 있다. 여기서는 Herdr 앱 화면만 다룬다.
import { spawnSync } from 'node:child_process';
import { Fail, VALUED, out, parseArgs, str, type Args } from '@muwi/core/kit';
import { readConfig } from '@muwi/core/store';
import { focusedPane, keepFocus } from '@muwi/herdr/hc';
import { GRAPH_AT, ScreenError, applyLayout, removeLayout, screenState, type GraphAt, type Screen } from './screen.ts';

/** 이 명령들의 값을 받는 옵션: 코어의 것과 layout의 --graph */
const OWN = new Set([...VALUED, 'graph']);
const args = (argv: string[]) => parseArgs(argv, OWN);

/** 설정의 기본값 (muwi config) */
export const CONFIG = { layout: { default: true, about: 'Herdr 앱 화면에 muwi 칸이 없을 때 넣자고 안내한다 (muwi setup, 그래프 칸)' } };
export const config = (dir: string) => readConfig(dir, { layout: CONFIG.layout.default });

/** 지금 Herdr 앱 화면이 어떤지, 무엇을 할 수 있는지 사람에게 말하듯 적는다 */
export function describeScreen(s: Screen): string {
  if (!s.app || !s.shown) return 'Herdr 앱 화면: 앱이 열려 있지 않아 확인하지 못했어요. 앱을 켠 뒤 muwi layout --status로 볼 수 있어요.';
  if (s.muwi && s.outdated) {
    const why = s.outdatedBy === 'herdr' ? 'Herdr가 업데이트돼서' : 'muwi 화면 배치가 바뀌어서';
    return `Herdr 앱 화면: ${why} muwi 레이아웃(${s.shown})이 옛 모양이에요. muwi layout을 다시 실행하면 새 모양으로 맞춰요.`;
  }
  if (s.muwi) return `Herdr 앱 화면: 지금 레이아웃(${s.shown})에 muwi 칸이 있어요.`;
  if (!s.canList && !s.canGraph) return `Herdr 앱 화면: 지금 레이아웃(${s.shown})에는 muwi 칸을 넣을 자리가 없어요. 그래프는 muwi open으로 터미널 아래에 열어요.`;
  const what = [s.canList ? '사이드바의 Agents 자리에 작업 목록을' : null, s.canGraph ? '터미널 아래에 그래프를' : null].filter(Boolean).join(', ');
  return [
    `Herdr 앱 화면: 지금 레이아웃(${s.shown})에는 muwi 칸이 없어요.`,
    `  muwi layout을 실행하면 이 레이아웃을 복제해서 ${what} 넣고 그 레이아웃으로 바꿔요. 지금 레이아웃은 그대로 남아요.`,
    '  바꾸지 않고 보려면 muwi open (이 터미널 아래에 그래프 칸을 연다)',
  ].join('\n');
}

export function guardScreen<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof ScreenError) throw new Fail(e.message);
    throw e;
  }
}

export function layoutRemoved(r: ReturnType<typeof removeLayout>) {
  if (r.none) return out('muwi layout으로 바꾼 화면이 없어요.');
  if (r.switchedTo) out(`Herdr 앱 화면을 ${r.switchedTo} 레이아웃으로 되돌렸어요.`);
  if (r.deleted) out('muwi가 만든 레이아웃 복제본을 지웠어요.');
  if (r.kept) out(`레이아웃 복제본은 남겨 뒀어요 (손으로 고쳤거나 마지막으로 보던 레이아웃이에요): ${r.kept}`);
}

function cmdLayout(a: Args, dir: string) {
  if (a.flags.remove) return layoutRemoved(guardScreen(() => removeLayout(dir)));
  if (a.flags.status) {
    const s = screenState(dir);
    return out(a.flags.json ? JSON.stringify(s) : describeScreen(s));
  }
  const graphAt = str(a, 'graph');
  if (graphAt === 'right') throw new Fail(`그래프 칸의 오른쪽 자리는 없어졌어요 (여러 작업을 가로로 나눠 그려서 너비가 필요해요). --graph는 ${GRAPH_AT.join(', ')} 중 하나예요`);
  if (graphAt !== undefined && !GRAPH_AT.includes(graphAt as GraphAt)) throw new Fail(`--graph는 ${GRAPH_AT.join(', ')} 중 하나예요`);
  const r = guardScreen(() => applyLayout(dir, process.env, graphAt ? { graphAt: graphAt as GraphAt } : {}));
  if (a.flags.json) return out(JSON.stringify(r));
  const spot = { bottom: '터미널 아래', top: '터미널 위' }[r.graphAt];
  if (r.already) return out(`이미 muwi 칸이 있는 레이아웃이에요: ${r.name} (그래프: ${spot})`);
  if (r.moved) return out(`그래프를 ${spot}에 뒀어요.`);
  out(`Herdr 앱 화면을 ${r.name} 레이아웃으로 ${r.refreshed ? '새 모양에 맞춰 다시 만들었어요' : '바꿨어요'} (${r.base} 레이아웃을 복제했어요).`);
  if (r.list) out('  사이드바: Agents 자리에 작업 목록 (작업에 붙지 않은 열린 세션도 같이 보여요)');
  if (r.graph) out(`  ${spot}: ${r.list ? '그래프 (지금 보는 터미널의 작업을 따라가고, 볼 작업이 여럿이면 나눠 그려요)' : '작업 목록과 그래프'}`);
  out('그래프 자리는 muwi layout --graph bottom|top 으로 바꿔요. 그래프 칸 위쪽의 버튼으로도 바꿀 수 있어요.');
  out(`되돌리려면 muwi layout --remove (${r.base} 레이아웃으로 돌아가요)`);
}

/** Herdr 앱에서 그래프 칸을 연다. 이 터미널 아래에 열고, 글자 입력은 터미널에 그대로 둔다 */
function cmdOpen(a: Args) {
  if (a.flags.right) throw new Fail('그래프 칸의 오른쪽 자리는 없어졌어요 (여러 작업을 가로로 나눠 그려서 너비가 필요해요). muwi open은 이 터미널 아래에 열어요.');
  const app = (args: string[]) => spawnSync('herdr-app', args, { encoding: 'utf8' });
  const terminal = process.env.HC_TERMINAL_ID;
  const ls = app(['ls']);
  if (ls.error || ls.status !== 0) throw new Fail('Herdr 앱이 열려 있지 않거나 herdr-app 명령이 없어요. Herdr 앱 안에서 실행해요.');
  let pane: string | undefined;
  try {
    for (const space of JSON.parse(ls.stdout).spaces ?? []) {
      for (const tab of space.tabs ?? []) {
        for (const t of tab.terminals ?? []) if (terminal && t.terminal === terminal) pane = t.pane;
      }
    }
  } catch {
    // 목록을 읽지 못하면 지금 보고 있는 칸 옆에 연다
  }
  const before = focusedPane();
  const split = app(['do', 'pane.split', JSON.stringify({ direction: 'down', mod: 'muwi', ...(pane ? { pane } : {}) })]);
  if (split.status !== 0) throw new Fail(`그래프 칸을 열지 못했어요: ${(split.stderr || split.stdout).trim()}`);
  // 글자 입력이 그래프 칸으로 넘어가지 않게, 키보드가 있던 칸으로 되돌린다
  keepFocus(before, pane ? { pane } : undefined);
  let opened = '';
  try {
    opened = JSON.parse(split.stdout).pane ?? '';
  } catch {
    // 칸 id를 모르면 안내만 한다
  }
  out(`그래프 칸을 열었어요${opened ? ` (${opened})` : ''}. 닫으려면 그 칸의 닫기 버튼을 눌러요.`);
}

export const layout = (argv: string[], dir: string) => cmdLayout(args(argv), dir);
export const open = (argv: string[]) => cmdOpen(args(argv));
