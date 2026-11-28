// muwi: 작업 계획과 진행을 기록하는 명령.
// AI가 이번 작업의 계획을 스스로 짜서 여기에 적고, 사람은 그 기록을 그래프로 본다.
// 이 명령은 적어 두기만 한다. 순서를 막거나 다음에 할 일을 정하지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, adoptSpawn, guideUpdate, handleHook, sessionInstructions } from './hook.ts';
import { cmdBoard } from './board.ts';
import { cmdPeek, cmdResume, cmdRun, cmdTell, cmdTidy, cmdWait } from './delegate.ts';
import { Fail, dur, join, needPlan, out, parseArgs, resolveWork, str, type Args } from './kit.ts';
import { hasTerminals, loadPlugins, pluginFailures, terminals, views } from './plugins.ts';
import { earlyStart, fromSubagent, markNode, offPlanStart } from './node.ts';
import { addNode, carryStatus, diffPlan, editsOf, isEmptyDiff, parsePlan, removeNode, shape, type NodeInput, type PlanInput } from './plan.ts';
import { readSession, sessionKey, sessionLabel } from './session.ts';
import { installedTools, newerElsewhere, olderThan, readInstall, refreshSetup, removeSetup, runSetup } from './setup.ts';
import { adapterOf } from './connectors/index.ts';
import { gaps } from './connectors/types.ts';
import { TOOLS, toolById } from './connectors/tools.ts';
import {
  SCHEMA, appendEvent, checkWorkName, listWorks, nowIso, readConfig, readEvents, readJson, readPlan, runsDir, withLock, workDir, writeConfig, writePlan,
  type NodeEdit, type NodeStatus, type Plan, type PlanNode, type RunBy, type ShowIn,
} from './store.ts';
import { TRASH_DAYS, daysLeft, listTrash, purgeTrash, restoreWork, trashWork } from './trash.ts';
import { afterCommand, cacheFile, cachedLatest, checkLatest, releaseUrl, updateTarget } from './update.ts';
import { PAST_DAYS, loadBoard, loadView, type Actor, type Between, type NodeView, type Quiet, type Try, type WorkView } from './view.ts';

const HELP = `사용법: muwi <명령>

  계획 (이번 작업을 어떻게 진행할지 스스로 정해서 적는다)
  muwi plan --work <이름> --request "<시킨 말>" '<계획 JSON>'    새 작업의 계획을 적는다
  muwi plan --why "<바꾼 이유>" '<계획 JSON>'                    계획을 바꾼다 (같은 id의 노드는 상태를 잇는다)
  muwi add <id> "<제목>" --after a,b | --before c --why "…"    노드 하나를 끼워 넣는다 (--run, --show도 받는다)
                                       자리(--after 또는 --before)를 꼭 준다. 이 작업 안의 일인데 순서와 상관없으면 --alone.
                                       이 작업의 흐름에 없는 일(새로 시킨 일)은 노드로 넣지 말고 새 작업으로 적는다
  muwi remove <id> --why "…"                                   노드 하나를 뺀다
      계획 JSON: {"title": "한 줄 설명", "nodes": [{"id": "read", "title": "티켓 읽기"},
                                                  {"id": "impl", "title": "구현", "after": ["read"]}]}
      JSON은 인자, --file <경로>, 표준 입력 중 하나로 준다. 사람이 바꾸라고 했으면 --human을 붙인다.
      누가 할지 정했으면 노드에 "run": "me" | "subagent" | "session"을 적는다 (정하지 않았으면 뺀다).
      새 세션을 어디에 보여 줄지 정했으면 "show": "pane" | "tab"도 적는다.

  진행
  muwi node <id> start [--sub]         노드를 시작한다. 서브에이전트가 맡은 노드를 시작할 때는 --sub를 붙인다 (서브에이전트가 한 것으로 적힌다)
      [--why "<근거>"]                 계획과 다르게 진행할 때(다시 하기, 앞 노드보다 먼저, 계획과 다른 쪽이 함) 그 판단의 근거
  muwi node <id> done ["<결과 한 줄>"]   노드를 끝낸다
  muwi node <id> wait "<물어볼 것>"     사람의 결정을 기다린다
  muwi node <id> block "<이유>"         막혔다
  muwi node <id> pause                 하던 노드를 잠시 멈춘다 (다른 노드를 먼저 할 때). 다시 start하면 같은 회차로 이어진다
  muwi flag [<id>] "<메모>"             문제 지점을 표시한다
  muwi viewed [--work <작업>]          끝난 작업을 본 것으로 적는다 (새 결과에서 뺀다. 보기가 그 작업을 보여 주거나 그 작업의 터미널에 사람이 있을 때 적는다)

  새 세션에 맡기기 (터미널 연결이 있을 때. 멀티플렉서의 터미널 안에서)
  muwi run <id> "<맡길 일>" [--show pane|tab] [--down] [--name <이름>] [--agent "<도구나 명령>"] [--cwd <폴더>]
                                       노드를 맡을 세션을 띄운다. 그 세션은 뜨면서 이 작업의 그 노드에 붙는다
  muwi wait [<id>…] [--timeout <초>]   맡긴 노드가 끝나거나, 사람을 기다리거나, 막히거나, 세션이 멈출 때까지 기다린다
  muwi peek <id> [--all]               그 노드를 맡은 세션의 화면을 본다
  muwi tell "<말>"                     (맡은 세션에서) 맡긴 세션에 알린다
  muwi tell <id> "<말>"                그 노드를 맡은 세션에 말을 보낸다
  muwi tidy [<작업>]                    끝난 노드를 맡았던 새 세션의 터미널을 닫는다 (사람이 정리하라고 할 때)
  muwi resume <id> [--new] [--show pane|tab]   닫힌 세션이 하던 노드를 이어 한다 (하던 대화를 다시 열거나 새 대화로)

  보기
  muwi status [--all] [--json]         작업 목록 (응답 대기·막힘·새 결과가 위). 오래된 작업과 보관한 작업은 빼고, --all이면 다 보여 준다
  muwi archive <작업>… | --done        끝났거나 멈춘 작업을 목록에서 치운다 (보관). 기록은 그대로 있고, 다시 시작하면 목록으로 돌아온다
                                       --done: 끝난 작업을 모두 보관한다
  muwi unarchive <작업>…               보관한 작업을 목록으로 꺼낸다
  muwi delete <작업>… | --archived     보관한 작업을 지운다 (끝 → 보관 → 삭제). 작업 폴더를 통째로 휴지통에 옮기고 30일 뒤에 비운다
                                       --archived: 보관한 작업을 모두 지운다
  muwi restore [<작업>…]               지운 작업을 휴지통에서 되살린다 (보관함으로 돌아온다). 작업 없이 부르면 휴지통 목록
  muwi show [<작업>] [--json]           작업 하나의 기록: 노드, 읽은 skill, 계획이 바뀐 이유, 문제 표시
  muwi session                         이 세션이 붙어 있는 작업과 읽은 skill
  muwi guide                           작업 진행 방식(지침)을 보여 준다. muwi가 업데이트되면 muwi 명령의 출력 끝에도 한 번 나온다
  muwi board [--work <작업>] [--down] [--fit WxH]   보기가 읽는 기록 (JSON)

  설치와 설정
  muwi setup                         터미널용 muwi 명령과, 붙은 터미널 연결·보기를 넣는다
  muwi setup --tools                 아는 AI 도구와, 깔렸는지, muwi 커넥터를 넣었는지 본다
  muwi setup --tool <도구>[,<도구>]   그 AI 도구에 muwi 커넥터(지침·사용법 skill·훅)를 넣는다
  muwi setup --all                   이 컴퓨터에 깔린 도구 전부에 넣는다
  muwi setup --remove                setup으로 넣은 것을 뺀다 (보기가 바꾼 것도 보기가 되돌린다)
  muwi config [<이름> on|off]         설정을 보고 켜고 끈다 (보기가 정하는 설정)
  muwi update [--check]              npm에 나온 최신판으로 올리고, 새 판으로 muwi setup을 다시 해서 훅·보기·커넥터를 맞춘다
                                     (지금 muwi가 깔린 자리에 같은 Node의 npm으로 받는다). --check: 새 판이 있는지만 본다
  muwi --version

작업은 --work <이름>으로 고른다. 없으면 이 세션이 붙어 있는 작업을 쓴다.
기록 폴더: $MUWI_DIR, 없으면 ~/.muwi`;

/** 필요한 Node의 가장 낮은 버전 */
const NODE_MIN = 24;

function readPlanText(a: Args): string {
  if (a.pos[0] !== undefined) return a.pos[0];
  const file = str(a, 'file');
  if (file) {
    if (!fs.existsSync(file)) throw new Fail(`파일이 없어요: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  if (!process.stdin.isTTY) {
    try {
      const text = fs.readFileSync(0, 'utf8');
      if (text.trim()) return text;
    } catch {
      // 표준 입력이 없다
    }
  }
  throw new Fail(`계획 JSON이 없어요. 예: muwi plan --work shop-web-PROJ-123 --request "…" '{"nodes":[{"id":"read","title":"티켓 읽기"}]}'`);
}

const MARK: Record<NodeStatus, string> = { todo: '○', doing: '●', waiting: '⏸', blocked: '✗', done: '✓' };
/** 노드의 표시. 시작한 적이 있는데 아직으로 돌아간 노드는 잠시 멈춘 것이다 */
const markOf = (n: PlanNode) => (n.status === 'todo' && (n.attempt ?? 0) > 0 ? '⏸' : MARK[n.status]);
const STATE_NAME: Record<WorkView['state'], string> = { waiting: '응답 대기', blocked: '막힘', doing: '작업 중', stalled: '멈춤', done: '끝' };
/** 하는 노드가 없을 때 그 작업의 세션이 하는 일 (세션이 무얼 하는지 모르면 적지 않는다) */
const BETWEEN_NAME: Partial<Record<Between, string>> = { working: '다음 노드 준비 중', asking: '세션이 입력을 기다림', stopped: '세션이 멈춤', gone: '맡은 세션이 없음' };
/** 하는 중이라고 적힌 노드를 하던 세션이 일을 멈췄을 때 */
const QUIET_NAME: Record<Quiet, string> = { asking: '세션이 입력을 기다림', stopped: '세션이 멈춤' };

const RUN_NAME: Record<RunBy, string> = { me: '직접', subagent: '서브에이전트', session: '새 세션' };
const runTag = (n: { run?: RunBy; show?: ShowIn }) => (n.run ? `${RUN_NAME[n.run]}${n.show ? `, ${n.show}` : ''}` : '');

function printPlan(plan: Plan) {
  const width = Math.max(...plan.nodes.map(n => n.id.length));
  for (const n of plan.nodes) {
    // 시작한 적이 있는데 아직으로 돌아간 노드는 잠시 멈춘 것이다
    out(`  ${markOf(n)} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}${n.run ? `  [${runTag(n)}]` : ''}`);
  }
  const alone = loneNodes(plan);
  const flat = flatNodes(plan);
  if (flat.length) {
    out(`⚠ 노드 사이에 선이 없어요: ${flat.join(', ')}. 그래프에 따로 떨어진 카드로 보여요.`);
    out('  하는 순서가 있으면 계획을 다시 내서 뒤 노드의 after에 앞 노드를 적어요 (muwi plan --why "…"). 나란히 해도 되는 일이면 그대로 둬요.');
  } else if (alone.length) {
    out(`⚠ 다른 노드와 이어지지 않은 노드가 있어요: ${alone.join(', ')}. 그래프에 선 없이 따로 떨어져 보여요.`);
    out('  순서가 있으면 계획을 다시 내서 그 노드의 after에 앞 노드를 적어요 (muwi plan --why "…"). 일부러 따로 둔 것이면 그대로 둬요.');
  }
}

/**
 * 계획은 방향 있는 선으로 이어진 그래프다. 선이 있는 계획에서 어느 노드와도 이어지지 않은 노드는 대개 after를 빼먹은 것이다.
 * 선이 하나도 없는 계획은 flatNodes가 따로 알린다
 */
export function loneNodes(plan: Pick<Plan, 'nodes'>): string[] {
  if (!plan.nodes.some(n => n.after.length)) return [];
  return plan.nodes.filter(n => !n.after.length && !plan.nodes.some(m => m.after.includes(n.id))).map(n => n.id);
}

/**
 * 노드가 둘 이상인데 선이 하나도 없는 계획의 노드들. 대개 처음 계획을 적을 때 after를 빼먹은 것이다
 * (나란히 해도 되는 일만 늘어놓은 계획일 수도 있어서 막지는 않고 알린다)
 */
export function flatNodes(plan: Pick<Plan, 'nodes'>): string[] {
  if (plan.nodes.length < 2 || plan.nodes.some(n => n.after.length)) return [];
  return plan.nodes.map(n => n.id);
}

/** 진행 중이었는데 앞에 끝나지 않은 노드가 새로 생겨 잠시 멈춰야 하는 노드 */
type Paused = { id: string; by: string[] };

/**
 * 계획을 적는다. 처음이면 새 작업을 만들고, 있으면 바꾼 것을 사건 기록에 남긴다.
 * make는 잠금을 잡은 뒤에 지금 계획을 받아 새 계획을 만든다 (그 사이에 다른 세션이 바꾼 것을 덮어쓰지 않게).
 * whole: 계획을 통째로 다시 낸 것. 이미 시작했거나 끝난 노드가 빠져 있으면 받지 않는다
 */
function savePlan(dir: string, work: string, make: (old: Plan | null) => PlanInput, a: Args, whole = false): { plan: Plan; created: boolean; changed: boolean; paused: Paused[] } {
  const key = sessionKey();
  const by = a.flags.human || str(a, 'by') === 'human' ? 'human' : 'ai';
  const why = str(a, 'why')?.trim() || undefined;
  return withLock(workDir(dir, work), () => {
    const old = readPlan(dir, work);
    // 지운 작업을 하던 세션이 계획을 고치려 하거나(--why), 그 작업에 붙어 있던 세션이 다시 적으면 같은 이름의 빈 새 작업을 만들지 않는다.
    // 만들면 휴지통의 그 작업을 되살릴 수 없게 된다. 다른 세션이 지운 이름으로 새로 시작하는 것은 막지 않는다
    if (!old && listTrash(dir).some(t => t.work === work) && (why || (key && readSession(dir, key)?.work === work))) {
      throw new Fail(`${work}: 지운 작업이에요 (휴지통에 있어요). 이어서 하려면 사람이 muwi restore ${work}로 되살려야 해요. 새로 시작하려면 다른 이름으로 계획을 적어요`);
    }
    const input = make(old);
    const at = nowIso();
    if (!old) {
      const plan: Plan = {
        work,
        schema: SCHEMA,
        ...(str(a, 'title') ?? input.title ? { title: str(a, 'title') ?? input.title } : {}),
        ...(str(a, 'request') ? { request: str(a, 'request') } : {}),
        cwd: process.cwd(),
        createdAt: at,
        updatedAt: at,
        nodes: carryStatus([], input.nodes),
      };
      writePlan(dir, plan);
      appendEvent(dir, work, { type: 'plan', by, ...(why ? { why } : {}), first: true, added: plan.nodes.map(n => n.id), removed: [], changed: [], shapes: input.nodes.map(shape) }, key, at);
      return { plan, created: true, changed: true, paused: [] };
    }
    const diff = diffPlan(old.nodes, input.nodes);
    const title = str(a, 'title') ?? input.title ?? old.title;
    const request = str(a, 'request') ?? old.request;
    const sameOrder = old.nodes.map(n => n.id).join('\n') === input.nodes.map(n => n.id).join('\n');
    if (isEmptyDiff(diff) && sameOrder && title === old.title && request === old.request) return { plan: old, created: false, changed: false, paused: [] };
    const gone = old.nodes.filter(n => diff.removed.includes(n.id));
    // 통째로 낸 계획은 "여기 없는 노드는 뺀다"는 뜻이 된다. 다른 세션이 넣고 하는 중인 노드를 모른 채 내면 그 노드가 사라진다
    const lost = whole ? gone.filter(n => n.status !== 'todo') : [];
    if (lost.length) {
      throw new Fail(
        `이미 시작했거나 끝난 노드가 새 계획에 없어요: ${lost.map(n => `${n.id}(${MARK[n.status]} ${n.title})`).join(', ')}. 다른 세션이 넣은 노드일 수 있어요. muwi show ${work}로 지금 계획을 보고 그 노드를 넣어서 다시 내요. 정말 빼려면 muwi remove <id> --why "<이유>"로 하나씩 빼요.`,
        2,
      );
    }
    // 이 작업에서 뺀 노드의 id는 다시 쓰지 않는다. 기록은 노드 id로 모이므로 같은 id면 앞 노드의 회차와 결과가 새 노드에 섞인다
    const reused = removedBefore(dir, work).filter(g => diff.added.includes(g.id));
    if (reused.length) {
      throw new Fail(
        `이 작업에서 전에 뺀 노드의 id예요: ${reused.map(g => `${g.id}(${g.title})`).join(', ')}. 같은 id를 다시 쓰면 그 노드의 회차와 결과가 새 노드에 섞여요. 다른 id를 골라 다시 적어요. 뺀 노드와 같은 일을 다시 넣는 것이어도 새로 하는 일이니 새 id로 적어요.`,
        2,
      );
    }
    if (!isEmptyDiff(diff) && !why) {
      throw new Fail(`${work}의 계획을 바꾸려면 --why "<이유>"를 적어요. 나중에 왜 바뀌었는지 볼 수 있게요. 사람이 바꾸라고 했으면 --human도 붙여요. 다른 새 작업이면 --work <새 이름>으로 적어요.`);
    }
    const plan: Plan = { ...old, schema: SCHEMA, ...(title ? { title } : {}), ...(request ? { request } : {}), updatedAt: at, nodes: carryStatus(old.nodes, input.nodes) };
    writePlan(dir, plan);
    if (!isEmptyDiff(diff)) {
      appendEvent(dir, work, {
        type: 'plan', by, ...(why ? { why } : {}), ...diff,
        // 생긴 노드의 모양과 바뀐 노드의 전과 뒤. 무엇이 어떻게 바뀌었는지 기록만으로 알 수 있게
        ...(diff.added.length ? { shapes: input.nodes.filter(n => diff.added.includes(n.id)).map(shape) } : {}),
        ...(diff.changed.length ? { edits: editsOf(old.nodes, input.nodes, diff.changed) } : {}),
        // 빠진 노드가 무엇이었는지 남긴다. 빠진 뒤에도 기록에서 볼 수 있다
        ...(gone.length ? { gone: gone.map(n => ({ ...shape(n), status: n.status })) } : {}),
      }, key, at);
    }
    // 하던 노드(작업 중, 응답 대기) 앞에 끝나지 않은 노드가 새로 생겼으면 그 노드는 아직 할 차례가 아니다.
    // 그래프가 흐름대로 보이게 잠시 멈춘 것으로 적는다 (잠금 밖에서, pausePlanned)
    const before = new Map(old.nodes.map(n => [n.id, new Set(n.after ?? [])]));
    const done = new Set(plan.nodes.filter(n => n.status === 'done').map(n => n.id));
    const paused: Paused[] = plan.nodes
      .filter(n => n.status === 'doing' || n.status === 'waiting')
      .map(n => ({ id: n.id, by: (n.after ?? []).filter(p => !before.get(n.id)?.has(p) && !done.has(p)) }))
      .filter(p => p.by.length > 0);
    return { plan, created: false, changed: true, paused };
  });
}

/** 이 작업에서 전에 뺀 노드들 (계획이 바뀐 기록의 gone). 같은 id가 여러 번 빠졌으면 마지막 것 */
function removedBefore(dir: string, work: string): { id: string; title: string }[] {
  const out = new Map<string, { id: string; title: string }>();
  for (const e of readEvents(dir, work)) {
    if (e.type !== 'plan') continue;
    for (const id of e.removed) out.set(id, { id, title: out.get(id)?.title ?? id });
    for (const g of e.gone ?? []) out.set(g.id, { id: g.id, title: g.title });
  }
  return [...out.values()];
}

/** 앞에 끝나지 않은 노드가 생긴 하던 노드를 잠시 멈춘다. 다시 start하면 같은 회차로 이어진다 */
function pausePlanned(dir: string, work: string, paused: Paused[], say: (line: string) => void = out) {
  for (const p of paused) {
    if (!markNode(dir, work, p.id, 'todo', undefined, sessionKey())) continue;
    say(`⏸ ${p.id}는 앞에 끝나지 않은 노드(${p.by.join(', ')})가 생겨서 잠시 멈췄어요. 그 노드가 끝나면 muwi node ${p.id} start로 이어서 해요 (같은 회차로 이어져요).`);
  }
}

/** 이번 명령을 서브에이전트가 실행했다 (바뀐 지침은 부모 세션의 명령에만 붙인다) */
let bySubagent = false;

/**
 * muwi가 업데이트돼 지침이 바뀌었으면 이 명령의 출력 끝에 새 지침을 붙인다. 세션을 새로 열지 않아도 된다.
 * 적는 명령(plan, node …)에만 붙인다. 훅으로 말을 넣을 수 없는 도구에서도 닿는 길이다
 */
function tellGuide(dir: string) {
  const key = sessionKey();
  if (!key || bySubagent) return;
  const text = guideUpdate(dir, key);
  if (text) out(`\n${text}`);
}

/** 지침의 원본. 지침 파일이나 훅으로 받지 못한 세션이 직접 읽을 수 있다 */
function cmdGuide(dir: string) {
  const guide = sessionInstructions(ROOT);
  if (!guide) throw new Fail('지침 파일을 읽지 못했어요 (hooks/instructions.md)');
  out(guide);
  const key = sessionKey();
  // 지금 판을 읽었다고 적어 둔다 (같은 것을 다시 붙이지 않게)
  if (key) guideUpdate(dir, key);
}

function cmdPlan(a: Args, dir: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readPlanText(a));
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail('계획이 JSON이 아니에요. {"nodes": [{"id": "…", "title": "…", "after": ["…"]}]} 모양으로 적어요.');
  }
  const { plan: input, problems } = parsePlan(raw);
  if (!input) throw new Fail(`계획을 적지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);

  // 이름 없이 계획을 내면 이 세션이 하던 작업의 계획을 바꾸는 것으로만 본다 (같은 폴더의 남의 작업을 덮어쓰지 않게)
  let work: string;
  if (str(a, 'work') ?? process.env.MUWI_WORK) work = resolveWork(a, dir);
  else {
    try {
      work = resolveWork(a, dir, { sessionOnly: true, open: true });
    } catch {
      const works = listWorks(dir);
      throw new Fail(
        `새 작업이면 --work <이름>을 붙여요 (티켓 키나 짧은 영문 요약). 하던 작업의 계획을 바꾸는 거면 --work <기존 이름>.${works.length ? ` 지금 있는 작업: ${works.join(', ')}` : ''}`,
      );
    }
  }
  const saved = savePlan(dir, work, () => input, a, true);
  const { created, changed, paused } = saved;
  join(dir, work);
  pausePlanned(dir, work, paused, a.flags.json ? () => {} : out);
  const plan = paused.length ? (readPlan(dir, work) ?? saved.plan) : saved.plan;
  if (a.flags.json) return out(JSON.stringify({ work, created, changed, nodes: plan.nodes, ...(paused.length ? { paused } : {}) }, null, 2));
  if (!changed) return out(`바뀐 것이 없어요: ${work}`);
  out(`${created ? '계획을 적었어요' : '계획을 바꿨어요'}: ${work} (노드 ${plan.nodes.length}개)`);
  printPlan(plan);
  if (created) out('노드를 시작할 때 muwi node <id> start, 끝낼 때 muwi node <id> done "<결과 한 줄>"');
  if (created) warnUnhooked(dir);
}

/**
 * 훅이 있는 도구인데 이 세션에서 훅이 돌지 않았으면 알린다 (muwi를 넣기 전에 연 세션 등).
 * 계획과 진행은 적히지만, 읽은 skill과 서브에이전트는 훅이 봐야 적히므로 빠진다
 */
function warnUnhooked(dir: string) {
  const key = sessionKey();
  const session = key ? readSession(dir, key) : null;
  // 훅이 있는 도구인데 이 세션에서는 돌지 않았다
  if (!session || !adapterOf(session.tool) || session.hooked) return;
  out('※ 이 세션에서는 muwi 훅이 돌지 않아요 (muwi를 설치하기 전에 연 세션일 수 있어요). 계획과 진행은 적히지만 읽은 skill과 서브에이전트가 한 일은 기록되지 않아요. 사용자에게 알리고, 기록이 필요하면 세션을 새로 열어 달라고 해요.');
}

function cmdAdd(a: Args, dir: string) {
  const [id, title] = a.pos;
  if (!id || !title) throw new Fail('사용법: muwi add <id> "<제목>" --after a,b | --before c | --alone [--run me|subagent|session] [--show pane|tab] --why "<이유>"');
  const work = resolveWork(a, dir);
  const after = (str(a, 'after') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const before = str(a, 'before');
  const fresh = { id, title, after, ...(str(a, 'run') ? { run: str(a, 'run') } : {}), ...(str(a, 'show') ? { show: str(a, 'show') } : {}) } as NodeInput;
  const { plan, paused } = savePlan(dir, work, old => {
    if (!old) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
    if (old.nodes.some(n => n.id === id)) throw new Fail(`이미 있는 노드예요: ${id}`);
    if (before && !old.nodes.some(n => n.id === before)) throw new Fail(`--before의 ${before}는 없는 노드예요. 있는 노드: ${old.nodes.map(n => n.id).join(', ')}`);
    // 자리를 짐작하지 않는다. 앞 노드를 고르지 못하는 일은 이 작업의 흐름에 없는 일(새로 시킨 일)일 수 있다. 그런 일은 새 작업으로 적는다.
    // 예전에는 맨 끝 노드 뒤에 알아서 이었다. 그래서 새로 시킨 일이 줄줄이 하던 작업의 그래프에, 손대지 않은 노드 밑에 붙었다
    if (!after.length && !before && !a.flags.alone) throw new Fail(missingPlace(old, id, title), 2);
    const { plan: input, problems } = parsePlan(addNode(old, fresh, before));
    if (!input) throw new Fail(`노드를 넣지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);
    return input;
  }, a);
  out(`노드를 넣었어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  pausePlanned(dir, work, paused);
  printPlan(readPlan(dir, work) ?? plan);
}

/** muwi add에 자리를 주지 않았을 때: 어느 노드 다음인지 적거나, 이 작업의 흐름에 없는 일이면 새 작업으로 적으라고 알린다 */
function missingPlace(plan: Plan, id: string, title: string): string {
  const width = Math.max(...plan.nodes.map(n => n.id.length));
  return [
    `노드를 넣지 않았어요. 먼저 이 일이 이 작업의 흐름에 있는지 봐요.`,
    `  같은 작업: 이 작업에서 시킨 일을 이루는 일 (리뷰 반영, 다시 확인, 빠뜨린 단계). 새 작업: 새로 시킨 일 (같은 대화·같은 저장소여도). 헷갈리면 새 작업이에요.`,
    `새 작업이면 이 작업에 넣지 말고 새로 적어요: muwi plan --work <새 이름> --request "<시킨 말>" '<계획 JSON>'`,
    `같은 작업이면 어느 노드 다음인지 적어요: muwi add ${id} "${title}" --after <노드> --why "<이유>" (하던 노드 앞에 끼우려면 --before <노드>, 이 작업 안의 일인데 순서와 상관없으면 --alone)`,
    `지금 노드 (${plan.work}):`,
    ...plan.nodes.map(n => `  ${markOf(n)} ${n.id.padEnd(width)}  ${n.title}`),
  ].join('\n');
}

function cmdRemove(a: Args, dir: string) {
  const [id] = a.pos;
  if (!id) throw new Fail('사용법: muwi remove <id> --why "<이유>"');
  const work = resolveWork(a, dir);
  let was: NodeStatus = 'todo';
  const { plan } = savePlan(dir, work, old => {
    if (!old) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
    const node = old.nodes.find(n => n.id === id);
    if (!node) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${old.nodes.map(n => n.id).join(', ')}`);
    if (old.nodes.length === 1) throw new Fail('마지막 노드는 뺄 수 없어요');
    was = node.status;
    const { plan: input, problems } = parsePlan(removeNode(old, id));
    if (!input) throw new Fail(`노드를 빼지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);
    return input;
  }, a);
  out(`노드를 뺐어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  // 하던 노드를 뺀 것이면 알려 둔다. 그 노드의 기록은 muwi show의 "빠진 노드"에 남는다
  if (was !== 'todo') out(`${id}는 ${{ doing: '하는 중', waiting: '사람을 기다리는 중', blocked: '막힌 상태', done: '끝난 상태', todo: '' }[was]}였어요. 기록은 남아 있어요 (muwi show ${work}의 빠진 노드).`);
  printPlan(plan);
}

const ACTION: Record<string, NodeStatus> = { start: 'doing', done: 'done', wait: 'waiting', block: 'blocked', pause: 'todo', todo: 'todo' };

function cmdNode(id: string | undefined, action: string | undefined, text: string | undefined, a: Args, dir: string) {
  const status = action ? ACTION[action] : undefined;
  if (!id || !status) throw new Fail('사용법: muwi node <id> start | done ["<결과>"] | wait "<물어볼 것>" | block "<이유>" | pause');
  const note = (text ?? str(a, 'result'))?.trim() || undefined;
  if (status === 'waiting' && !note) throw new Fail('무엇을 기다리는지 적어요: muwi node <id> wait "<사람에게 물어볼 것>"');
  if (status === 'blocked' && !note) throw new Fail('왜 막혔는지 적어요: muwi node <id> block "<이유>"');
  const work = resolveWork(a, dir);
  const key = sessionKey();
  // 서브에이전트가 실행한 명령이면 부모 세션이 붙은 작업을 바꾸지 않는다 (--work를 붙여 적어도). 부모에게 갈 말도 받지 않는다
  const sub = fromSubagent(dir, work, id, key, Boolean(a.flags.sub));
  const why = str(a, 'why')?.trim() || undefined;
  // 계획과 다르게 시작했는지 보려고 시작하기 전의 상태를 읽어 둔다 (알리기만 한다)
  const was = readPlan(dir, work)?.nodes.find(n => n.id === id)?.status;
  const result = markNode(dir, work, id, status, note, key, process.env, { sub: Boolean(a.flags.sub), ...(why ? { why } : {}) });
  if (!result) {
    const plan = needPlan(dir, work);
    throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}. 새 노드면 muwi add <id> "<제목>" --after <앞 노드> --why "<이유>"로 먼저 넣어요 (이 작업의 흐름에 없는 일이면 새 작업으로).`);
  }
  if (sub) bySubagent = true;
  // 노드를 시작할 때만 그 작업에 붙는다. 끝내기·기다리기·멈추기는 --work로 다른 작업에 적어도 붙은 작업을 바꾸지 않는다 (하던 작업 정리)
  else if (status === 'doing') join(dir, work);
  const done = result.nodes.filter(n => n.status === 'done').length;
  const label = { doing: '시작', done: '끝', waiting: '응답 대기', blocked: '막힘', todo: '잠시 멈춤 (다시 start하면 같은 회차로 이어져요)' }[status];
  out(`${status === 'todo' ? '⏸' : MARK[status]} ${id} ${label} (${work}, ${done}/${result.nodes.length} 끝)`);
  if (status === 'done' && done === result.nodes.length) out('모든 노드가 끝났어요.');
  // 앞 노드가 끝나기 전에 시작했다: 같이 하는 거면 계획을 고치라고 알린다. 맡은 서브에이전트는 계획을 고치지 않으므로 알리지 않는다
  const early = status === 'doing' && !sub ? earlyStart(result.nodes, id) : null;
  if (early) out(early);
  // 계획과 다르게 시작했는데 근거가 없으면 근거를 남기는 법을 알린다 (막지 않는다). 다시 start하면 같은 회차에 붙는다
  // 앞 노드가 안 끝난 것은 위의 안내가 이미 말했다: 같은 말을 두 번 하지 않고 근거를 남기는 법만 붙인다
  const off = status === 'doing' && !why ? offPlanStart(result.nodes, id, was, sub, { open: !early }) : [];
  const again = `muwi node ${id} start${sub ? ` --sub --work ${work}` : ''} --why "<근거>"`;
  if (off.length) out(`계획과 다르게 시작했어요 (${off.join(', ')}). 판단의 근거를 남기려면 ${again}로 다시 적어요.`);
  else if (early && !why) out(`같이 하기로 판단한 거면 그 근거를 남기려면 ${again}로 다시 적어요.`);
}

function cmdFlag(a: Args, dir: string) {
  const [first, second] = a.pos;
  const node = second !== undefined ? first : undefined;
  const text = (second ?? first)?.trim();
  if (!text) throw new Fail('사용법: muwi flag [<노드 id>] "<무엇이 문제였는지>"');
  const work = resolveWork(a, dir);
  const plan = needPlan(dir, work);
  if (node && !plan.nodes.some(n => n.id === node)) throw new Fail(`없는 노드예요: ${node}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}`);
  appendEvent(dir, work, { type: 'flag', ...(node ? { node } : {}), text }, sessionKey());
  out(`문제 지점을 표시했어요: ${node ? `${node} · ` : ''}${text} (${work})`);
}

/** 끝난 작업을 본 것으로 적는다. 그래프 칸이 사람이 고른 작업을 보여 줄 때 부른다. 아직 안 본 결과일 때만 적는다 */
/**
 * 보관: 끝났거나 멈춘 작업을 목록(그래프 칸, muwi status)에서 치운다. 기록은 그대로 두어 muwi show와 원인 찾기는 그대로 된다.
 * 사건 하나만 남기고, 그 뒤에 작업에 무슨 일이 생기면(다시 시작) 목록으로 돌아온다. 하는 중인 작업은 보관하지 않는다
 */
function cmdArchive(a: Args, dir: string, on: boolean) {
  const names = on && a.flags.done
    ? loadBoard(dir).works.filter(w => w.state === 'done' && !w.archived).map(w => w.work)
    : a.pos.length ? a.pos : [resolveWork(a, dir, { guess: true })];
  if (!names.length) return out('보관할 끝난 작업이 없어요');
  const views = names.map(work => {
    const v = loadView(dir, work);
    if (!v) throw new Fail(`없는 작업이에요: ${work} (muwi status --all로 목록을 봐요)`);
    return v;
  });
  // 하나라도 받을 수 없으면 아무것도 적지 않는다
  const busy = on ? views.filter(v => v.state !== 'done' && v.state !== 'stalled' && !v.archived) : [];
  if (busy.length) throw new Fail(`아직 하는 중이라 보관하지 않아요: ${busy.map(v => `${v.work}(${STATE_NAME[v.state]})`).join(', ')}. 끝났거나 멈춘 작업만 보관해요`);
  for (const v of views) {
    if (on === Boolean(v.archived)) {
      out(`${v.work}: ${on ? '이미 보관했어요' : '보관한 작업이 아니에요'}`);
      continue;
    }
    appendEvent(dir, v.work, { type: on ? 'archive' : 'unarchive' }, null);
    out(on ? `${v.work}: 보관했어요. 목록에서 빠지고 기록은 그대로 있어요 (꺼내려면 muwi unarchive ${v.work})` : `${v.work}: 목록으로 꺼냈어요`);
  }
}

/**
 * 삭제: 보관한 작업의 폴더를 통째로(계획·기록과 그 폴더에 둔 파일까지) 휴지통으로 옮긴다. 끝 → 보관 → 삭제 순서라 보관하지 않은 작업은 지우지 않는다.
 * TRASH_DAYS 동안 muwi restore로 되살린다
 */
function cmdDelete(a: Args, dir: string) {
  purgeTrash(dir);
  if (a.flags.archived && a.pos.length) throw new Fail('--archived와 작업 이름을 같이 주지 않아요 (--archived는 보관한 작업을 모두 지워요)');
  const names = a.flags.archived ? loadBoard(dir).works.filter(w => w.archived).map(w => w.work) : a.pos;
  if (!names.length) {
    if (a.flags.archived) return out('지울 보관한 작업이 없어요');
    throw new Fail('지울 작업을 적어요: muwi delete <작업>… (보관한 작업을 모두 지우려면 --archived)');
  }
  // 작업 이름만 받는다 (경로를 주면 다른 폴더를 옮길 수 있다)
  for (const work of names) {
    const bad = checkWorkName(work);
    if (bad) throw new Fail(bad);
  }
  const views = names.map(work => {
    const v = loadView(dir, work);
    if (!v) throw new Fail(`없는 작업이에요: ${work} (muwi status --all로 목록을 봐요)`);
    return v;
  });
  // 하나라도 받을 수 없으면 아무것도 지우지 않는다
  const kept = views.filter(v => !v.archived);
  if (kept.length) throw new Fail(`보관한 작업만 지워요 (끝 → 보관 → 삭제): ${kept.map(v => v.work).join(', ')}. 먼저 muwi archive로 보관해요`);
  // 작업마다 잠그고 다시 확인한 뒤 옮긴다 (그 사이에 다시 시작한 작업은 지우지 않는다). 하나가 안 돼도 나머지는 지운다
  const failed: string[] = [];
  for (const work of names) {
    try {
      withLock(workDir(dir, work), () => {
        if (!loadView(dir, work)?.archived) throw new Fail('지우는 사이에 다시 시작했어요');
        trashWork(dir, work);
      });
      out(`${work}: 지웠어요. ${TRASH_DAYS}일 동안 휴지통에 있어요 (되살리려면 muwi restore ${work})`);
    } catch (e: any) {
      failed.push(`${work}(${e?.message ?? e})`);
    }
  }
  if (failed.length) throw new Fail(`지우지 못했어요: ${failed.join(', ')}`);
}

/** 지운 작업을 휴지통에서 되살린다 (가장 최근에 지운 것). 보관한 채로 돌아오므로 보관함에 있다. 작업 없이 부르면 휴지통 목록 */
function cmdRestore(a: Args, dir: string) {
  purgeTrash(dir);
  if (!a.pos.length) {
    const list = listTrash(dir);
    if (!list.length) return out('휴지통이 비어 있어요');
    for (const t of list) out(`${t.work}  ${new Date(t.at).toLocaleString()}에 지움 · ${daysLeft(t)}일 남음`);
    return out('되살리려면 muwi restore <작업> (같은 작업이 여럿이면 가장 최근에 지운 것)');
  }
  // 하나가 안 돼도 나머지는 되살린다
  const failed: string[] = [];
  for (const work of a.pos) {
    const bad = checkWorkName(work);
    const r = bad ? null : restoreWork(dir, work);
    if (bad) failed.push(bad);
    else if (r === null) failed.push(`휴지통에 없는 작업이에요: ${work} (muwi restore로 목록을 봐요)`);
    else if (r === 'taken') failed.push(`같은 이름의 작업이 있어서 되살리지 않았어요: ${work}`);
    else if (r === 'leftover') failed.push(`${workDir(dir, work)} 폴더가 남아 있어서 되살리지 않았어요 (계획이 없는 폴더예요. 치우고 다시 해요)`);
    else out(`${work}: 되살렸어요. 보관함에 있어요 (목록으로 꺼내려면 muwi unarchive ${work})`);
  }
  if (failed.length) throw new Fail(failed.join('\n'));
}

function cmdViewed(a: Args, dir: string) {
  const work = resolveWork(a, dir);
  const v = loadView(dir, work);
  if (!v) throw new Fail(`없는 작업이에요: ${work}`);
  if (!v.unread) return out(`${work}: 새 결과가 아니에요 (${v.state === 'done' ? '이미 봤어요' : '아직 끝나지 않았어요'})`);
  appendEvent(dir, work, { type: 'viewed' }, null);
  out(`${work}: 본 것으로 적었어요`);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function clockTime(iso: string) {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 회차를 누가 했는지 한마디로 */
function whoText(v: WorkView, who: Actor): string {
  const label = (key?: string) => (key ? v.sessions[key]?.label ?? sessionLabel(null, key) : '');
  const count = (list: Actor['agents']) => {
    const kinds = [...new Set(list.map(x => x.kind).filter(Boolean))].join(', ');
    return `서브에이전트 ${list.length}개${kinds ? `(${kinds})` : ''}`;
  };
  const own = who.agents.filter(x => x.own);
  const helped = who.agents.filter(x => !x.own);
  if (who.kind === 'subagent') return own.length ? count(own) : `${count(helped)} · 세션 ${label(who.session)}이 시작함`;
  // 이 회차를 시작할 때의 모델 (노드마다 적힌 것)
  const model = who.model ? ` (${who.model})` : '';
  const base = who.kind === 'session' ? `새 세션 ${label(who.session)}${model}` : `세션 ${label(who.session)}${model}`;
  return [base, own.length ? count(own) : '', helped.length ? `${count(helped)}가 도움` : ''].filter(Boolean).join(' + ');
}

/** 노드를 누가 했는지. 시작 전이면 계획에 적은 것 */
function whoLine(v: WorkView, n: NodeView): string {
  if (!n.who) {
    if (n.spawn && n.status === 'todo') return `새 세션 ${n.spawn.terminal} 뜨는 중`;
    return n.run && n.status === 'todo' ? `예정: ${runTag(n)}` : '';
  }
  const text = whoText(v, n.who);
  if (n.offPlan && n.run) return `${text} · 계획과 다름(${withRo(RUN_NAME[n.run])} 하기로 함)`;
  if (n.runUnknown && n.run) return `${text} · 계획: ${RUN_NAME[n.run]} (훅이 돌지 않아 계획대로 했는지 확인하지 못함)`;
  return text;
}

/** 받침에 맞춰 '로'나 '으로'를 붙인다 (ㄹ 받침은 '로') */
function withRo(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return `${word}(으)로`;
  const final = (last - 0xac00) % 28;
  return final === 0 || final === 8 ? `${word}로` : `${word}으로`;
}

/**
 * 읽은 skill 한 줄. "없음"은 훅이 보고 있었는데 읽지 않았다는 뜻일 때만 쓴다.
 * 훅이 그 세션을 보지 못했으면 "볼 수 없었음"이라고 적는다 (읽었는지 모른다).
 */
function skillsLine(t: Pick<Try, 'skills' | 'seen' | 'instant'>, started: boolean): string {
  const read = t.skills.filter(s => s.state === 'read').map(s => `${s.skill}${s.count > 1 ? ` ×${s.count}` : ''}${s.via === 'file' ? '(파일)' : ''}${s.agent ? '(서브에이전트)' : ''}${s.guess ? '(확실하지 않음)' : ''}`);
  const loaded = t.skills.filter(s => s.state === 'loaded').map(s => s.skill);
  const parts: string[] = [];
  if (started) {
    if (!t.seen) parts.push('읽은 skill: 볼 수 없었음(이 세션에서 훅이 돌지 않았어요)');
    else parts.push(`읽은 skill: ${read.length ? read.join(', ') : t.instant ? '기록 없음(시작과 끝을 한꺼번에 적었어요)' : '없음'}`);
  }
  if (loaded.length) parts.push(`이미 읽은 상태: ${loaded.join(', ')}`);
  return parts.join(' · ');
}

/** 바뀐 노드 하나를 짧게: ~impl(제목 "구현" → "구현과 시험" · 앞 read → read,lint) */
function editText(id: string, edit?: NodeEdit): string {
  if (!edit) return `~${id}`;
  const { before: b, after: a } = edit;
  const list = (x?: string[]) => (x?.length ? x.join(',') : '없음');
  const run = (x?: RunBy | null) => (x ? RUN_NAME[x] : '정하지 않음');
  const parts = [
    'title' in a ? `제목 "${b.title}" → "${a.title}"` : '',
    'after' in a ? `앞 ${list(b.after)} → ${list(a.after)}` : '',
    'run' in a ? `맡는 쪽 ${run(b.run)} → ${run(a.run)}` : '',
    'show' in a ? `보여 줄 곳 ${b.show ?? '정하지 않음'} → ${a.show ?? '정하지 않음'}` : '',
  ].filter(Boolean);
  return `~${id}${parts.length ? `(${parts.join(' · ')})` : ''}`;
}

function printShow(v: WorkView) {
  const between = v.between ? BETWEEN_NAME[v.between] : v.quiet ? QUIET_NAME[v.quiet] : undefined;
  out(`${v.work}${v.title ? ` · ${v.title}` : ''} · ${STATE_NAME[v.state]}${between ? ` · ${between}` : ''}${v.unread ? ' · 아직 안 봄' : ''} (${v.counts.done}/${v.counts.total} 끝${v.spentMs > 0 ? ` · 작업 ${dur(v.spentMs)}` : ''})`);
  if (v.request) out(`요청: ${v.request}`);
  if (v.helpers.sessions || v.helpers.subagents) {
    const who = v.lead ? v.sessions[v.lead] : undefined;
    // 어느 도구의 어떤 모델이 계획을 냈는지 (훅이 알려 준 만큼)
    const made = [toolById(who?.tool)?.name, who?.model].filter(Boolean).join(' · ');
    const lead = v.lead ? `${who?.label ?? sessionLabel(null, v.lead)}${made ? ` (${made})` : ''}` : '';
    out(`같이 한 쪽: ${[lead ? `계획을 낸 세션 ${lead}` : '', v.helpers.sessions ? `새 세션 ${v.helpers.sessions}` : '', v.helpers.subagents ? `서브에이전트 ${v.helpers.subagents}` : ''].filter(Boolean).join(' · ')}`);
  }
  out('');
  out('노드');
  const width = Math.max(...v.nodes.map(n => n.id.length));
  for (const n of v.nodes) {
    // 하던 세션이 닫혔으면 그렇게 적는다. 상태는 그대로 두지만 지금 하고 있는 쪽이 없다
    const who = [whoLine(v, n), n.closed ? '세션이 닫힘' : n.quiet ? QUIET_NAME[n.quiet] : ''].filter(Boolean).join(' · ');
    const flow = n.paused ? '잠시 멈춤' : n.early ? '순서 앞당김 (앞 노드가 끝나기 전에 시작)' : '';
    const meta = [flow, n.attempts > 1 ? `${n.attempts}회차` : '', n.spentMs > 0 ? dur(n.spentMs) : '', who].filter(Boolean).join(' · ');
    out(`  ${n.paused ? '⏸' : MARK[n.status]} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}${meta ? `  (${meta})` : ''}`);
    const indent = ' '.repeat(width + 6);
    if (n.note) out(`${indent}${{ waiting: '기다리는 것', blocked: '막힌 이유', done: '결과' }[n.status as 'waiting' | 'blocked' | 'done'] ?? '메모'}: ${n.note}`);
    if (n.tries.length > 1) {
      // 다시 한 노드는 회차별로 보여 준다. 처음에 무슨 일이 있었는지가 다시 한 기록에 덮이지 않게
      for (const t of n.tries) {
        const head = [`${t.n}회차`, t.startedAt ? clockTime(t.startedAt) : '', t.spentMs > 0 ? dur(t.spentMs) : '', t.who ? whoText(v, t.who) : ''].filter(Boolean).join(' · ');
        const result = t.note && t.n !== n.tries[n.tries.length - 1].n ? ` · ${{ waiting: '기다린 것', blocked: '막힌 이유', done: '결과' }[t.status as 'waiting' | 'blocked' | 'done'] ?? '메모'}: ${t.note}` : '';
        out(`${indent}${head} · ${skillsLine(t, true)}${result}${t.why ? ` · 근거: ${t.why}` : ''}`);
      }
    } else {
      const why = n.tries[0]?.why;
      const line = [skillsLine(n, n.attempts > 0), why ? `근거: ${why}` : ''].filter(Boolean).join(' · ');
      if (line) out(`${indent}${line}`);
    }
    for (const sp of n.spawns) if (sp.task) out(`${indent}맡긴 말 (${sp.terminal}): ${sp.task.replace(/\s+/g, ' ').slice(0, 160)}${sp.task.length > 160 ? '…' : ''}`);
    for (const f of n.flags) out(`${indent}⚑ 문제 표시 (${clockTime(f.at)}): ${f.text}`);
  }
  const changes = v.changes.filter(c => !c.first);
  if (changes.length) {
    out('');
    out('계획이 바뀐 기록');
    for (const c of changes) {
      const what = [
        ...c.added.map(id => `+${id}`),
        ...c.removed.map(id => `-${id}`),
        ...c.changed.map(id => editText(id, c.edits.find(x => x.id === id))),
      ].join(' ');
      out(`  ${clockTime(c.at)}  ${c.by === 'human' ? '사람' : 'AI'}  ${what}  이유: ${c.why ?? '(없음)'}`);
    }
  }
  if (v.outside.length) {
    out('');
    out('노드 밖에서 읽은 skill');
    for (const s of v.outside) out(`  ${clockTime(s.at)}  ${s.skill}${s.via === 'file' ? '(파일)' : ''}${s.agent ? '(서브에이전트)' : ''}${s.session ? `  세션 ${v.sessions[s.session]?.label ?? ''}` : ''}`);
  }
  if (v.gone.length) {
    out('');
    out('빠진 노드');
    for (const g of v.gone) out(`  ${clockTime(g.at)}  ${MARK[g.status]} ${g.id}  ${g.title}  이유: ${g.why ?? '(없음)'}`);
  }
  // 노드를 짚지 않은 표시와, 빠진 노드에 남긴 표시
  const here = new Set(v.nodes.map(n => n.id));
  const loose = v.flags.filter(f => !f.node || !here.has(f.node));
  if (loose.length) {
    out('');
    out('문제 표시');
    for (const f of loose) out(`  ${clockTime(f.at)}  ${f.node ? `${f.node}(빠진 노드) · ` : ''}${f.text}`);
  }
  if (v.compacts.length) {
    out('');
    out(`대화가 요약된 시각: ${v.compacts.map(c => clockTime(c.at)).join(', ')} (그 전에 읽은 skill 내용은 흐려졌을 수 있어요)`);
  }
}

async function cmdShow(a: Args, dir: string) {
  const work = a.pos[0] ?? resolveWork(a, dir, { guess: true });
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  if (a.flags.json) return out(JSON.stringify(v, null, 2));
  printShow(v);
}

function cmdStatus(a: Args, dir: string) {
  const board = loadBoard(dir);
  if (a.flags.json) return out(JSON.stringify({ dir, ...board }, null, 2));
  if (!board.works.length) out(`기록된 작업이 없어요 (${dir})`);
  // 끝났거나 멈춘 채로 오래된 작업은 접어 두고, 보관한 작업은 뺀다. --all이면 다 보여 준다
  const past = board.works.filter(w => w.past);
  const shelved = board.works.filter(w => w.archived);
  for (const w of board.works) {
    if ((w.past || w.archived) && !a.flags.all) continue;
    // 끝났는데 사람이 아직 안 본 작업은 "새 결과"로 보여 준다
    out(`${(w.archived ? '보관' : w.unread ? '새 결과' : STATE_NAME[w.state]).padEnd(7)} ${w.work}  ${w.counts.done}/${w.counts.total}${w.spentMs > 0 ? ` · ${dur(w.spentMs)}` : ''}${w.title ? `  ${w.title}` : ''}`);
    for (const n of w.active) out(`          ${MARK[n.status]} ${n.id}  ${n.title}${n.closed ? ' (세션이 닫힘)' : n.quiet ? ` (${QUIET_NAME[n.quiet]})` : ''}${n.note ? ` : ${n.note}` : ''}`);
    // 하는 노드가 없으면 그 작업의 세션이 무얼 하는지
    const between = w.between ? BETWEEN_NAME[w.between] : undefined;
    if (between) out(`          · ${between}`);
  }
  if (past.length && !a.flags.all) out(`지난 작업 ${past.length}개는 접어 뒀어요 (${PAST_DAYS}일 넘게 바뀐 것이 없는 작업). muwi status --all로 봐요.`);
  if (shelved.length && !a.flags.all) out(`보관한 작업 ${shelved.length}개는 뺐어요. muwi status --all로 봐요.`);
  for (const e of board.errors) out(`⚠ ${e.work}: ${e.message}`);
}

function cmdHook(a: Args, dir: string) {
  // 훅이 실패해도 세션은 계속돼야 한다. 문제는 파일에만 남긴다
  try {
    const text = fs.readFileSync(0, 'utf8');
    const mode = a.pos[0] === 'command' ? 'command' : 'record';
    const payload = JSON.parse(text);
    // 입력에 사건 이름을 넣지 않는 도구는 훅 명령이 알려 준다 (--event)
    const named = str(a, 'event');
    if (named && payload && typeof payload === 'object' && !payload.hook_event_name) payload.hook_event_name = named;
    // muwi가 업데이트돼 버전이나 설치 위치가 바뀌었으면, 전에 setup으로 넣어 둔 명령·보기·커넥터를 새 판으로 맞춘다.
    // 새 세션이 열릴 때뿐 아니라 열려 있는 세션에 말을 걸 때도 맞춘다 (더 낮은 버전으로는 맞추지 않는다)
    // 어느 도구의 훅인지는 훅 명령(hooks/tool.sh <도구>)이 알려 준다. 기본 도구는 없다
    const from = str(a, 'from');
    if (!from) throw new Error('muwi hook에 --from <도구>가 없어요. muwi setup을 다시 실행하면 훅 명령을 새로 넣어요');
    const result = handleHook(from, payload, dir, mode, process.env, ROOT, h => {
      if (h.kind === 'session-start' || h.kind === 'prompt') refreshSetup({ root: ROOT, version: version(), dir });
      // 적어 둔 터미널 연결이나 보기를 불러오지 못했으면 세션이 시작될 때 한 번 남긴다 (그래프와 세션 상태가 안 나오는 까닭)
      if (h.kind === 'session-start') for (const f of pluginFailures()) hookError(dir, `불러오지 못했어요: ${f.from} (${f.reason})`);
    });
    if (result.stdout) out(result.stdout);
    // 종료 코드와 표준 오류로 답을 받는 도구가 있다 (막을 때 2와 이유)
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.code) process.exitCode = result.code;
  } catch (e: any) {
    hookError(dir, String(e?.message ?? e));
  }
}

/** 훅의 문제는 세션을 막지 않고 파일에만 남긴다 */
function hookError(dir: string, message: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(`${dir}/.hook-errors.log`, `${nowIso()} ${message}\n`);
  } catch {
    // 남길 곳도 없으면 그냥 넘어간다
  }
}

function version(): string {
  return readJson<{ version?: string }>(`${ROOT}/package.json`)?.version ?? '0.0.0';
}

function cmdSetup(a: Args, dir: string) {
  // 보기가 넣은 것(그래프 칸, 바꾼 레이아웃)은 보기가 뺀다
  if (a.flags.remove) return removeSetup(dir, out);
  if (a.flags.tools) {
    // 아는 도구와, 이 컴퓨터에 깔렸는지, muwi 커넥터를 넣었는지
    const have = new Set(installedTools().map(t => t.id));
    const done = readInstall(dir)?.tools ?? {};
    for (const t of TOOLS) {
      const state = done[t.id] ? '커넥터 넣음' : have.has(t.id) ? '깔려 있음' : '없음';
      // 그 도구의 훅이 알려 주지 않는 것 (커넥터의 선언에서 만든다). 비어 있으면 다 알려 준다
      const lacks = gaps(adapterOf(t.id)?.can ?? { subagents: false, start: false, skills: false }).join(' · ');
      out(`${t.id.padEnd(16)} ${t.name.padEnd(18)} ${state.padEnd(6)}${lacks ? `  ${lacks}` : ''}`);
    }
    out('넣기: muwi setup --tool <도구>[,<도구>] 또는 muwi setup --all');
    return;
  }
  // --tool codex,cursor처럼 고르거나, --all로 이 컴퓨터에 깔린 도구 전부에 넣는다
  const picked = (str(a, 'tool') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const unknown = picked.filter(id => !toolById(id));
  if (unknown.length) throw new Fail(`모르는 도구예요: ${unknown.join(', ')}. 아는 도구: ${TOOLS.map(t => t.id).join(', ')}`);
  const all = a.flags.all ? installedTools().map(t => t.id) : [];
  // 붙은 보기가 있으면 보기도 넣는다 (그래프 칸 같은 것). 보기는 점검하고 지금 어떤지도 알린다
  const install = runSetup({ root: ROOT, version: version(), dir, tools: [...picked, ...all], log: out, report: true });
  const done = Object.keys(install.tools ?? {});
  if (!done.length) {
    const have = installedTools().map(t => t.id);
    out(`AI 도구에는 아직 넣지 않았어요. 넣으려면 muwi setup --tool <도구> 또는 muwi setup --all${have.length ? ` (이 컴퓨터에 깔린 도구: ${have.join(', ')})` : ''}`);
  }
  tellNewer();
}

/** 다른 자리(다른 Node 버전 등)에 더 새 muwi가 깔려 있으면 알린다. 지금 도는 판이 setup의 기준이 되기 때문이다 */
function tellNewer() {
  const newer = newerElsewhere(version());
  if (newer) process.stderr.write(`더 새 muwi(${newer.version})가 다른 자리에 있어요: ${newer.bin}\n지금 도는 판은 ${version()} (${ROOT})예요. 새 판으로 옮기려면 그 자리의 명령으로 muwi setup을 실행하세요: "${newer.bin}" setup\n`);
}

/** 붙은 보기와 터미널 연결의 패키지 이름 (보기 먼저). 사람이 어느 패키지를 깔았는지 알 때 쓴다 */
const pluginPackages = () => [...views().map(v => v.package), terminals().package];

/**
 * muwi update: npm에 나온 최신판으로 올린다. 사람이 직접 하거나 AI에게 시킬 때 쓴다 (스스로 올리지는 않는다).
 * 지금 도는 muwi가 깔린 자리에 같은 Node의 npm으로 받고, 전에 setup을 했으면 새 판으로 setup을 다시 해서
 * 명령·훅·보기·커넥터를 새 판에 맞춘다 (훅 입구가 바뀐 판도 이걸로 맞춰진다)
 */
async function cmdUpdate(a: Args, dir: string) {
  const t = updateTarget(ROOT, pluginPackages());
  if (!t) throw new Fail('npm으로 전역에 깐 muwi가 아니라서 여기서 올릴 수 없어요. 저장소에서 돌리는 muwi는 git pull로 받아요');
  const current = version();
  const file = cacheFile(process.env);
  // 사람이 시킨 것이라 지금 npm에 묻는다
  await checkLatest(t.name, file, process.env.MUWI_UPDATE_REGISTRY || undefined);
  const latest = cachedLatest(file, t.name);
  if (!latest) throw new Fail('npm에 물어보지 못했어요 (오프라인이거나 npm이 답하지 않아요). 잠시 뒤에 다시 해 보세요');
  if (!olderThan(current, latest)) return out(`최신이에요: ${t.name} ${current}`);
  out(`새 판이 있어요: ${current} → ${latest} (${t.name}). 바뀐 점: ${releaseUrl(latest)}`);
  if (a.flags.check) return out('올리려면 muwi update');
  const win = process.platform === 'win32';
  out(`올려요: npm i -g ${t.name}@${latest} (자리: ${t.prefix})`);
  const got = spawnSync(t.npm, ['i', '-g', `${t.name}@${latest}`, '--prefix', t.prefix, '--no-audit', '--no-fund'], { stdio: 'inherit', shell: win });
  if (got.status !== 0) throw new Fail(`npm이 ${got.status ?? got.error?.message}로 끝났어요. 위의 npm 메시지를 보세요`);
  if (readInstall(dir)) {
    out('새 판으로 muwi setup을 다시 해요 (전에 넣은 도구·보기를 그대로 맞춰요)');
    const set = spawnSync(t.bin, ['setup'], { stdio: 'inherit', shell: win });
    if (set.status !== 0) throw new Fail(`새 판의 muwi setup이 ${set.status ?? set.error?.message}로 끝났어요. ${t.bin} setup을 직접 실행해 보세요`);
  } else out('muwi setup을 한 적이 없어서 맞출 것이 없어요. 쓰려면 muwi setup --tool <도구>를 실행하세요');
  out(`${current} → ${latest}로 올렸어요.`);
}

/** 설정의 이름, 기본값, 설명은 보기가 정한다 (보기 규격의 config). 코어에는 설정이 없다 */
function cmdConfig(a: Args, dir: string) {
  const [key, value] = a.pos;
  const about = Object.assign({}, ...views().map(v => v.config ?? {})) as Record<string, { default: boolean; about: string }>;
  const keys = Object.keys(about);
  const config = readConfig(dir, Object.fromEntries(keys.map(k => [k, about[k].default])));
  if (key !== undefined) {
    if (!keys.includes(key) || (value !== 'on' && value !== 'off')) {
      throw new Fail(keys.length ? `사용법: muwi config [${keys.join('|')}] on|off` : '바꿀 설정이 없어요 (설정은 보기가 정해요. 붙은 보기가 없어요)');
    }
    config[key] = value === 'on';
    writeConfig(dir, config);
  }
  if (!keys.length) return out('설정이 없어요 (설정은 보기가 정해요)');
  for (const k of keys) out(`${k.padEnd(6)} ${config[k] ? 'on ' : 'off'}  ${about[k].about}`);
}

function cmdSession(dir: string) {
  const key = sessionKey();
  if (!key) return out('세션을 알 수 없어요 (세션 없이도 기록은 돼요. skill 기록은 그 AI 도구의 훅이 알려 줄 때만 붙어요)');
  const s = readSession(dir, key);
  out(`세션 ${key}${s?.work ? ` · 작업 ${s.work}` : ' · 붙어 있는 작업 없음'}${s?.terminal ? ` · 터미널 ${s.terminal}${hasTerminals() ? ` (${terminals().name})` : ''}` : ''}`);
  const loaded = Object.keys(s?.loaded ?? {});
  if (loaded.length) out(`읽은 skill: ${loaded.join(', ')}`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  // TypeScript를 바로 실행하므로 Node 24(LTS) 이상에서만 돈다
  const major = Number(process.versions.node.split('.')[0]);
  if (major < NODE_MIN) throw new Fail(`muwi는 Node ${NODE_MIN} 이상이 필요해요 (지금: ${process.version})`);
  const dir = runsDir();
  // 터미널 연결과 보기를 불러온다. 없으면 없는 채로 돈다
  await loadPlugins(dir);
  // muwi <명령> --help: 명령을 실행하지 않고 사용법을 보여 준다
  const opts = rest.indexOf('--') < 0 ? rest : rest.slice(0, rest.indexOf('--'));
  if (cmd && (opts.includes('--help') || opts.includes('-h'))) return out(help());
  // 보기가 더하는 명령 (muwi layout …): 인자는 그 명령이 읽는다. 코어의 명령과 이름이 겹치면 코어가 먼저다
  const viewed = cmd && !CORE.has(cmd) ? views().find(v => v.commands?.[cmd])?.commands?.[cmd] : undefined;
  if (viewed) return viewed(rest, dir);
  const a = parseArgs(rest, undefined, cmd && FLAGS[cmd] ? { cmd, flags: new Set(FLAGS[cmd]) } : undefined);
  // 적는 명령이 끝나면 바뀐 지침이 있는지 보고 출력 끝에 붙인다
  if (cmd && TELLS.has(cmd)) {
    if (ADOPTS.has(cmd)) adoptHere(dir);
    await run(cmd, a, dir);
    return tellGuide(dir);
  }
  return run(cmd, a, dir);
}

/**
 * muwi run으로 뜬 세션인데 아직 맡은 노드에 붙지 않았으면 여기서 붙인다.
 * 세션이 시작될 때를 알려 주는 도구는 훅이 먼저 붙인다. 알려 주지 않는 도구는 그 세션의 첫 muwi 명령에서 붙는다
 */
function adoptHere(dir: string) {
  const key = sessionKey();
  if (!key) return;
  // 이미 작업에 붙은 세션은 다시 묻지 않는다 (명령마다 다시 찾지 않게)
  if (readSession(dir, key)?.work) return;
  try {
    adoptSpawn(dir, key, process.env);
  } catch {
    // 붙이지 못해도 명령은 그대로 한다
  }
}

/** 사용법: 코어의 명령과 보기가 더하는 명령 */
const help = () => {
  const extra = views().map(v => v.help).filter(Boolean).join('\n\n');
  if (!extra) return HELP;
  const at = HELP.indexOf('\n  설치와 설정');
  return `${HELP.slice(0, at)}\n${extra}\n${HELP.slice(at)}`;
};

/** 코어의 명령. 보기가 같은 이름의 명령을 더해도 코어가 먼저다 */
const CORE = new Set([
  'plan', 'add', 'remove', 'node', 'flag', 'viewed', 'delete', 'restore', 'show', 'status', 'session', 'guide', 'board',
  'run', 'wait', 'peek', 'tell', 'tidy', 'resume', 'hook', 'setup', 'config', 'version', '--version', '-v', 'help', '--help', '-h',
]);

/** 명령마다 받는 옵션. 여기 없는 옵션은 오류다 (오타가 조용히 무시되지 않게). 옵션을 더하면 여기에도 적는다 */
const FLAGS: Record<string, string[]> = {
  plan: ['work', 'request', 'title', 'why', 'human', 'by', 'file', 'json'],
  add: ['work', 'after', 'before', 'alone', 'run', 'show', 'why', 'human', 'by'],
  remove: ['work', 'why', 'human', 'by'],
  node: ['work', 'sub', 'result', 'why'],
  flag: ['work'],
  viewed: ['work'],
  archive: ['work', 'done'],
  unarchive: ['work'],
  delete: ['work', 'archived'],
  restore: [],
  show: ['work', 'json'],
  status: ['json', 'all'],
  board: ['work', 'fit', 'down'],
  run: ['work', 'show', 'down', 'name', 'agent', 'cwd'],
  wait: ['work', 'timeout'],
  peek: ['work', 'all'],
  tell: ['work'],
  tidy: ['work'],
  resume: ['work', 'show', 'down', 'name', 'agent', 'new', 'force'],
  hook: ['event', 'from', 'tool'],
  setup: ['tool', 'tools', 'all', 'remove'],
  config: [],
  update: ['check'],
  session: [],
  guide: [],
};

/** 맡은 세션이 처음 실행할 만한 명령들: 맡은 노드의 진행을 적는 명령 */
const ADOPTS = new Set(['node', 'add', 'remove', 'tell']);

/** 지침이 바뀌었을 때 알려 줄 명령들: 세션이 계획과 진행을 적는 명령 */
const TELLS = new Set(['plan', 'add', 'remove', 'node', 'run', 'tell']);

async function run(cmd: string | undefined, a: Args, dir: string) {
  switch (cmd) {
    case 'plan': return cmdPlan(a, dir);
    case 'add': return cmdAdd(a, dir);
    case 'remove': return cmdRemove(a, dir);
    case 'node': return cmdNode(a.pos[0], a.pos[1], a.pos[2], a, dir);
    case 'flag': return cmdFlag(a, dir);
    case 'viewed': return cmdViewed(a, dir);
    case 'archive': return cmdArchive(a, dir, true);
    case 'unarchive': return cmdArchive(a, dir, false);
    case 'delete': return cmdDelete(a, dir);
    case 'restore': return cmdRestore(a, dir);
    case 'show': return cmdShow(a, dir);
    case 'status': return cmdStatus(a, dir);
    case 'board': return cmdBoard(a, dir);
    case 'run': return cmdRun(a, dir);
    case 'wait': return cmdWait(a, dir);
    case 'peek': return cmdPeek(a, dir);
    case 'tell': return cmdTell(a, dir);
    case 'tidy': return cmdTidy(a, dir);
    case 'resume': return cmdResume(a, dir);
    case 'hook': return cmdHook(a, dir);
    case 'setup': return cmdSetup(a, dir);
    case 'config': return cmdConfig(a, dir);
    case 'update': return cmdUpdate(a, dir);
    case 'version': case '--version': case '-v':
      out(version());
      return tellNewer();
    case 'session': return cmdSession(dir);
    case 'guide': return cmdGuide(dir);
    case undefined: case 'help': case '--help': case '-h': return out(help());
    default: {
      // 보기가 더하는 명령일 수 있는데 보기를 불러오지 못했다
      const failed = pluginFailures();
      if (failed.length) throw new Fail(`모르는 명령: ${cmd}. 적어 둔 모듈을 불러오지 못했어요: ${failed.map(f => `${f.from} (${f.reason})`).join(', ')}. 패키지를 옮겼으면 그 패키지의 muwi로 muwi setup을 다시 실행하세요.`);
      throw new Fail(`모르는 명령: ${cmd}\n\n${help()}`);
    }
  }
}

const argv = process.argv.slice(2);
main(argv)
  // 사람이 터미널에서 친 명령이면 npm에 새 판이 있을 때 알린다 (update.ts)
  .then(() => afterCommand({ cmd: argv[0], current: version(), root: ROOT, plugins: pluginPackages() }))
  .catch(e => {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
    process.exit(e instanceof Fail ? e.code : 1);
  });
