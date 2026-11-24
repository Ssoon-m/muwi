// Herdr 화면이 더하는 명령: 그래프 칸이 읽는 board, 새 세션에 맡기는 run·tidy, 칸을 여는 open, 레이아웃을 바꾸는 layout.
// 화면 규격(../host.ts)의 commands로 코어에 붙는다. 코어의 기록은 코어의 모듈로 읽고 쓴다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Fail, VALUED, join, needPlan, out, parseArgs, resolveWork, str, type Args } from '@muwi/core/kit';
import { readSession, recentSessions, sessionKey } from '@muwi/core/session';
import { SHOW_IN, appendEvent, clock, readConfig, type ShowIn } from '@muwi/core/store';
import { PAST_DAYS, loadBoard, loadView, type WorkView } from '@muwi/core/view';
import { launchCommand, modelIn, toolById } from '@muwi/core/connectors/tools';
import { LABEL_MODEL, LABEL_NODE, LABEL_WORK, hc, herdrApp, terminalName, type Ran } from './hc.ts';
// 그래프 배치(ELK)는 무거워서 board를 그릴 때만 불러온다 (훅은 이 파일을 자주 불러온다)
import type { Fit, Flow } from './layout.ts';
import { resumeFacts } from './resume.ts';
import { GRAPH_AT, ScreenError, applyLayout, removeLayout, screenState, type GraphAt, type Screen } from './screen.ts';

/** 이 명령들의 값을 받는 옵션: 코어의 것과 run의 --name·--agent·--cwd, layout의 --graph, board의 --fit */
const OWN = new Set([...VALUED, 'name', 'agent', 'cwd', 'graph', 'fit']);
const args = (argv: string[]) => parseArgs(argv, OWN);

/** 설정의 기본값 (muwi config) */
export const CONFIG = { layout: { default: true, about: 'Herdr 앱 화면에 muwi 칸이 없을 때 넣자고 안내한다 (muwi setup, 그래프 칸)' } };
export const config = (dir: string) => readConfig(dir, { layout: CONFIG.layout.default });

/** prefer: 칸 모양으로 정한 흐름 방향. fit(칸 크기)을 알면 칸에 훨씬 크게 들어가는 쪽으로 바꿀 수 있다. 실제로 쓴 방향을 flow로 돌려준다 */
async function withLayout(v: WorkView, prefer: Flow = 'right', fit?: Fit) {
  const { layoutFor, layoutProblems } = await import('./layout.ts');
  const { layout, flow } = await layoutFor({ nodes: v.nodes, edges: v.edges }, prefer, fit);
  return { ...v, layout, flow, layoutProblems: layoutProblems(layout, flow) };
}

async function cmdBoard(a: Args, dir: string) {
  // 작업 시간을 센 때. 그래프 칸은 진행 중인 노드에 이 뒤로 흐른 시간을 더해 초마다 늘린다
  const now = clock.now().getTime();
  const board = loadBoard(dir);
  // 고른 작업이 없으면 맨 위 작업을 보여 준다. 접어 둔 지난 작업보다 지금 작업이 먼저다
  const pick = str(a, 'work') ?? (board.works.find(w => !w.past) ?? board.works[0])?.work;
  let selected = null;
  if (pick) {
    const v = loadView(dir, pick);
    // 그래프 칸이 세로로 길면 위→아래로 그린다 (--down)
    // 닫힌 세션을 이어 하는 버튼에 쓸 것(폴더가 있는가, Claude 대화를 다시 열 수 있는가)도 함께 넘긴다
    // --fit WxH: 그래프 칸의 크기. --down(칸 모양으로 정한 방향)의 반대 방향이 칸에 훨씬 크게 들어가면 그 방향으로 그린다
    const m = /^(\d+)x(\d+)$/.exec(str(a, 'fit') ?? '');
    const fit = m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
    if (v) selected = { ...(await withLayout(v, a.flags.down ? 'down' : 'right', fit)), ...resumeFacts(v) };
  }
  // 그래프 칸이 Herdr 터미널과 작업을 잇는 데 쓴다 (지금 보는 탭의 작업 따라가기, 계획 없는 세션 가려내기)
  const sessions = recentSessions(dir, Date.now() - PAST_DAYS * 86_400_000);
  // 화면에 muwi 칸이 없을 때 그래프 칸이 바꾸자고 안내해도 되는가 (muwi config layout)
  const suggest = config(dir).layout;
  out(JSON.stringify({ dir, now, ...board, sessions, suggest, selected }));
}

/** 지금 Herdr 앱 화면이 어떤지, 무엇을 할 수 있는지 사람에게 말하듯 적는다 */
export function describeScreen(s: Screen): string {
  if (!s.app || !s.shown) return 'Herdr 앱 화면: 앱이 열려 있지 않아 확인하지 못했어요. 앱을 켠 뒤 muwi layout --status로 볼 수 있어요.';
  if (s.muwi && s.outdated) {
    const why = s.outdatedBy === 'herdr' ? 'Herdr가 업데이트돼서' : 'muwi 화면 배치가 바뀌어서';
    return `Herdr 앱 화면: ${why} muwi 레이아웃(${s.shown})이 옛 모양이에요. muwi layout을 다시 실행하면 새 모양으로 맞춰요.`;
  }
  if (s.muwi) return `Herdr 앱 화면: 지금 레이아웃(${s.shown})에 muwi 칸이 있어요.`;
  if (!s.canList && !s.canGraph) return `Herdr 앱 화면: 지금 레이아웃(${s.shown})에는 muwi 칸을 넣을 자리가 없어요. 그래프는 muwi open으로 터미널 옆에 열어요.`;
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
  if (graphAt !== undefined && !GRAPH_AT.includes(graphAt as GraphAt)) throw new Fail(`--graph는 ${GRAPH_AT.join(', ')} 중 하나예요`);
  const r = guardScreen(() => applyLayout(dir, process.env, graphAt ? { graphAt: graphAt as GraphAt } : {}));
  if (a.flags.json) return out(JSON.stringify(r));
  const spot = { bottom: '터미널 아래', top: '터미널 위', right: '터미널 오른쪽' }[r.graphAt];
  if (r.already) return out(`이미 muwi 칸이 있는 레이아웃이에요: ${r.name} (그래프: ${spot})`);
  if (r.moved) return out(`그래프를 ${spot}에 뒀어요.`);
  out(`Herdr 앱 화면을 ${r.name} 레이아웃으로 ${r.refreshed ? '새 모양에 맞춰 다시 만들었어요' : '바꿨어요'} (${r.base} 레이아웃을 복제했어요).`);
  if (r.list) out('  사이드바: Agents 자리에 작업 목록 (계획 없는 세션도 같이 보여요)');
  if (r.graph) out(`  ${spot}: ${r.list ? '고른 작업의 그래프 (지금 보는 탭의 작업을 따라가요)' : '작업 목록과 그래프'}`);
  out('그래프 자리는 muwi layout --graph bottom|top|right 로 바꿔요. 그래프 칸 위쪽의 버튼으로도 바꿀 수 있어요.');
  out(`되돌리려면 muwi layout --remove (${r.base} 레이아웃으로 돌아가요)`);
}

/** Herdr 앱에서 그래프 칸을 연다. 이 터미널 옆에 열고, 글자 입력은 터미널에 그대로 둔다 */
function cmdOpen(a: Args) {
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
  const split = app(['do', 'pane.split', JSON.stringify({ direction: a.flags.right ? 'right' : 'down', mod: 'muwi', ...(pane ? { pane } : {}) })]);
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

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 지금 키보드가 있는 칸. 알 수 없으면 null */
function focusedPane(): string | null {
  try {
    const pane = JSON.parse(herdrApp(['status']).out)?.focused_pane;
    return typeof pane === 'string' && pane ? pane : null;
  } catch {
    return null;
  }
}

/**
 * 칸을 새로 놓으면 조금 뒤에 키보드가 그 칸으로 옮겨 간다. 잠깐 지켜보다가 옮겨 갔으면 원래 있던 칸으로 되돌린다.
 * 사람이 다른 칸에서 쓰고 있었다면 그 칸으로 돌아간다. muwi를 부른 터미널로 끌어오지 않는다.
 * 원래 자리를 알 수 없을 때만 fallback(부른 터미널)으로 보낸다.
 */
function keepFocus(before: string | null, fallback?: { pane?: string; terminal?: string }) {
  let calm = 0;
  for (let i = 0; i < 8 && calm < 3; i++) {
    pause(200);
    if (!before) {
      if (fallback) herdrApp(['do', 'pane.focus', JSON.stringify(fallback)]);
      continue;
    }
    const now = focusedPane();
    if (now && now !== before) {
      herdrApp(['do', 'pane.focus', JSON.stringify({ pane: before })]);
      calm = 0;
    } else calm += 1;
  }
}

/** 띄운 세션을 pane이나 tab에 놓는다. 키보드는 원래 있던 칸에 둔다 */
function placeTerminal(terminal: string, place: string, lead: string): Ran {
  const before = focusedPane();
  let kept: Ran = { ok: false, out: '', err: '' };
  // 방금 띄운 터미널을 앱이 아직 모를 수 있어서 몇 번 다시 해 본다
  for (let i = 0; i < 6 && !kept.ok; i++) {
    if (i) pause(400);
    kept = herdrApp(['do', 'terminal.keep', JSON.stringify({ terminal, place })]);
  }
  keepFocus(before, { terminal: lead });
  return kept;
}

/**
 * 노드를 새 세션에 맡긴다. 세션은 hc가 띄우고, pane이나 tab에 놓는 것은 herdr-app이 한다.
 * 맡을지, 어디에 놓을지는 부르는 쪽(AI)이 정한다. 여기서는 띄우고, 노드와 터미널을 이어 적기만 한다.
 */
function cmdRun(a: Args, dir: string) {
  const [id, task] = a.pos;
  if (!id || !task?.trim()) throw new Fail('사용법: muwi run <노드 id> "<맡길 일>" [--show pane|tab] [--down] [--name <이름>] [--agent "<명령>"] [--cwd <폴더>]');
  const lead = process.env.HC_TERMINAL_ID;
  if (!lead) throw new Fail('새 세션은 Herdr 앱의 터미널 안에서만 띄울 수 있어요 ($HC_TERMINAL_ID가 없어요). 여기서는 서브에이전트에 맡기거나 직접 해요.');
  const work = resolveWork(a, dir);
  const plan = needPlan(dir, work);
  const node = plan.nodes.find(n => n.id === id);
  if (!node) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}. 새 노드면 muwi add로 먼저 넣어요.`);
  const show = (str(a, 'show') ?? node.show) as ShowIn | undefined;
  if (show !== undefined && !SHOW_IN.includes(show)) throw new Fail(`--show는 ${SHOW_IN.join(' 또는 ')}이에요`);
  const cwd = str(a, 'cwd') ?? process.cwd();
  // 띄울 명령을 주지 않으면 맡기는 세션과 같은 도구로 띄운다
  const me = sessionKey();
  // --agent codex처럼 도구 이름을 주면 그 도구가 첫 말을 받는 모양으로 띄운다. 그 밖의 값은 명령으로 보고 그대로 실행한다
  const asked = str(a, 'agent')?.trim();
  const other = toolById(asked);
  const template = other ? other.launch : launchCommand(me ? readSession(dir, me)?.tool : undefined);
  const given = other ? undefined : asked;
  const agent = (given ?? template[0]).trim().split(/\s+/).filter(Boolean);
  if (!agent.length) throw new Fail('--agent에 띄울 명령이 없어요');
  // 띄우는 명령에 모델을 정해 줬으면 적어 둔다 (--agent "codex --model gpt-5"). 그 세션의 훅이 모델을 알려 주지 않아도 노드에 모델이 남는다
  const model = modelIn(agent);
  const brief = `${task.trim()}\n\n(muwi) 작업 ${work}의 노드 ${id}(${node.title})를 맡았어요. 시작은 자동으로 적혀요. 끝나면 muwi node ${id} done "<결과 한 줄>"을 적고, hc send ${lead} "<결과나 막힌 점>"으로 알려요.`;

  // 이름은 Herdr의 목록에서 어느 노드인지 보이게 노드 id로 짓는다. 이미 있는 이름이면 뒤에 몇 글자를 붙인다
  const base = terminalName(str(a, 'name') ?? id);
  let name = base;
  let started: Ran | null = null;
  for (const candidate of [base, `${base.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`]) {
    name = candidate;
    // 맡길 일은 명령 이름 바로 뒤에 둔다. 뒤에 두면 값을 여러 개 받는 옵션(--allowedTools 등)이 삼킨다
    // --agent로 준 명령은 그 모양 그대로. 주지 않았으면 그 도구가 첫 말을 받는 자리에 넣는다 (qwen -i "<첫 말>" 같은 것)
    const argv = given ? [agent[0], brief, ...agent.slice(1)] : template.map(part => (part === '{prompt}' ? brief : part));
    started = hc(['run', '--bg', '--json', '--name', candidate, '--cwd', cwd, '--label', `${LABEL_WORK}=${work}`, '--label', `${LABEL_NODE}=${id}`, ...(model ? ['--label', `${LABEL_MODEL}=${model}`] : []), '--', ...argv]);
    if (started.ok) break;
  }
  if (!started?.ok) throw new Fail(`새 세션을 띄우지 못했어요: ${(started?.err || started?.out || 'hc 명령이 없어요').trim()}`);
  let terminal = '';
  let sent = true;
  try {
    const j = JSON.parse(started.out);
    terminal = String(j.address ?? j.terminal ?? j.id ?? '');
    if (j.first_message && j.first_message.sent === false) sent = false;
  } catch {
    // 주소를 읽지 못하면 이름으로 가리킨다
  }
  if (!terminal) terminal = name;
  // 첫 말을 명령으로 받지 못하는 도구는 뜬 뒤에 말로 보낸다
  if (!given && !template.includes('{prompt}')) sent = hc(['send', terminal, brief]).ok;

  let placed = '';
  if (show) {
    const place = show === 'tab' ? 'tab' : a.flags.down ? 'down' : 'right';
    const kept = placeTerminal(terminal, place, lead);
    placed = kept.ok ? show : `${show}에 놓지 못했어요 (${(kept.err || kept.out).trim().split('\n')[0]})`;
  }

  // 맡긴 말도 남긴다. 나중에 "맡긴 쪽이 무엇을 모르고 일했나"를 볼 수 있게
  // 띄운 폴더도 남긴다. 새 세션이 기록을 남기기 전에 닫혀도 어디서 이어 하면 되는지 알려 줄 수 있게 (worktree에 띄웠을 때)
  appendEvent(dir, work, { type: 'spawn', node: id, terminal, name, ...(show ? { show } : {}), task: task.trim().slice(0, 2000), cwd: path.resolve(cwd), ...(model ? { model } : {}) }, sessionKey());
  join(dir, work);
  out(`새 세션을 띄웠어요: ${name} (${terminal}) → 노드 ${id}${placed ? ` · ${placed}` : ''}`);
  if (!sent) out(`맡길 일이 아직 전달되지 않았어요. hc read ${terminal}로 화면을 보고(폴더 신뢰 확인이 떠 있을 수 있어요) 풀어 준 뒤 hc send ${terminal} "<맡길 일>"로 다시 보내요.`);
  out(`끝나거나 물어볼 게 생기길 기다리려면 hc wait --children any, 화면을 보려면 hc read ${terminal}, 말을 걸려면 hc send ${terminal} "…"`);
}

/** 끝난 노드를 맡았던 새 세션의 터미널을 닫는다. 판단 과정을 볼 수 있게 평소에는 남겨 두고, 사람이 정리하라고 할 때만 쓴다 */
function cmdTidy(a: Args, dir: string) {
  const work = a.pos[0] ?? resolveWork(a, dir);
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  // 같은 노드에 세션을 여러 번 띄웠으면 전부 본다
  const targets = v.nodes.filter(n => n.status === 'done').flatMap(n => [...new Set(n.spawns.map(sp => sp.terminal))].map(terminal => ({ n, terminal })));
  if (!targets.length) return out('닫을 세션이 없어요 (끝난 노드를 맡았던 새 세션만 닫아요)');
  for (const { n, terminal } of targets) {
    const got = hc(['get', terminal, '--json'], process.env, 5000);
    let labels: Record<string, string> = {};
    try {
      labels = JSON.parse(got.out)?.labels ?? {};
    } catch {
      // 없는 터미널
    }
    // 주소는 다시 쓰일 수 있다. 이 작업의 이 노드를 맡았던 터미널이 맞을 때만 닫는다
    if (!got.ok || labels[LABEL_WORK] !== work || labels[LABEL_NODE] !== n.id) {
      out(`  ${n.id}: 이미 없어요 (${terminal})`);
      continue;
    }
    hc(['kill', terminal], process.env, 10_000);
    hc(['rm', terminal], process.env, 10_000);
    out(`  ${n.id}: ${terminal} 닫음`);
  }
}

export const board = (argv: string[], dir: string) => cmdBoard(args(argv), dir);
export const layout = (argv: string[], dir: string) => cmdLayout(args(argv), dir);
export const open = (argv: string[]) => cmdOpen(args(argv));
export const run = (argv: string[], dir: string) => cmdRun(args(argv), dir);
export const tidy = (argv: string[], dir: string) => cmdTidy(args(argv), dir);
