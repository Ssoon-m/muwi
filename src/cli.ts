// muwi: 작업 계획과 진행을 기록하는 명령.
// AI가 이번 작업의 계획을 스스로 짜서 여기에 적고, 사람은 그 기록을 그래프로 본다.
// 이 명령은 적어 두기만 한다. 순서를 막거나 다음에 할 일을 정하지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { LABEL_NODE, LABEL_WORK, hc, herdrApp, terminalName, type Ran } from './herdr.ts';
import { layoutGraph, layoutProblems } from './layout.ts';
import { ROOT, handleHook } from './hook.ts';
import { markNode } from './node.ts';
import { addNode, carryStatus, diffPlan, isEmptyDiff, parsePlan, removeNode, type NodeInput, type PlanInput } from './plan.ts';
import { attach, markSettled, readSession, recentSessions, sessionKey, sessionLabel, touchSession } from './session.ts';
import { checkMod, refreshSetup, removeSetup, runSetup } from './setup.ts';
import { ScreenError, applyLayout, removeLayout, screenState, type Screen } from './screen.ts';
import {
  SCHEMA, SHOW_IN, appendEvent, checkWorkName, listWorks, nowIso, readConfig, readJson, readPlan, runsDir, withLock, workDir, writeConfig, writePlan,
  type Config, type NodeStatus, type Plan, type RunBy, type ShowIn,
} from './store.ts';
import { PAST_DAYS, loadBoard, loadView, type Actor, type NodeView, type Try, type WorkView } from './view.ts';

const HELP = `사용법: muwi <명령>

  계획 (이번 작업을 어떻게 진행할지 스스로 정해서 적는다)
  muwi plan --work <이름> --request "<시킨 말>" '<계획 JSON>'    새 작업의 계획을 적는다
  muwi plan --why "<바꾼 이유>" '<계획 JSON>'                    계획을 바꾼다 (같은 id의 노드는 상태를 잇는다)
  muwi add <id> "<제목>" [--after a,b] [--before c] --why "…"   노드 하나를 끼워 넣는다 (--run, --show도 받는다)
  muwi remove <id> --why "…"                                   노드 하나를 뺀다
      계획 JSON: {"title": "한 줄 설명", "nodes": [{"id": "read", "title": "티켓 읽기"},
                                                  {"id": "impl", "title": "구현", "after": ["read"]}]}
      JSON은 인자, --file <경로>, 표준 입력 중 하나로 준다. 사람이 바꾸라고 했으면 --human을 붙인다.
      누가 할지 정했으면 노드에 "run": "me" | "subagent" | "session"을 적는다 (정하지 않았으면 뺀다).
      새 세션을 어디에 보여 줄지 정했으면 "show": "pane" | "tab"도 적는다.

  새 세션에 맡기기 (Herdr 앱 안에서)
  muwi run <id> "<맡길 일>" [--show pane|tab] [--down] [--name <이름>] [--agent "<명령>"] [--cwd <폴더>]
                                       노드를 맡을 세션을 띄운다. 그 세션은 뜨면서 이 작업의 그 노드에 붙는다
                                       기다릴 때는 hc wait --children any, 말을 걸 때는 hc send <주소> "…"
  muwi tidy [<작업>]                    끝난 노드를 맡았던 새 세션의 터미널을 닫는다 (사람이 정리하라고 할 때)

  진행
  muwi node <id> start                 노드를 시작한다
  muwi node <id> done ["<결과 한 줄>"]   노드를 끝낸다
  muwi node <id> wait "<물어볼 것>"     사람의 결정을 기다린다
  muwi node <id> block "<이유>"         막혔다
  muwi flag [<id>] "<메모>"             문제 지점을 표시한다
  muwi skip "<이유>"                   이 세션은 계획 없이 진행한다 (한 곳만 고치는 일, 기록할 작업이 아닐 때)

  보기
  muwi status [--all] [--json]         작업 목록 (나를 기다리는 작업이 위). 오래된 작업은 접어 두고, --all이면 다 보여 준다
  muwi show [<작업>] [--json]           작업 하나의 기록: 노드, 읽은 skill, 계획이 바뀐 이유, 문제 표시
  muwi session                         이 세션이 붙어 있는 작업과 읽은 skill
  muwi open [--right]                  Herdr 앱에서 그래프 칸을 이 터미널 아래(--right면 오른쪽)에 연다

  Herdr 앱 화면
  muwi layout                          지금 레이아웃을 복제해 사이드바 Agents 자리에 작업 목록을, 터미널 아래에
                                       그래프를 넣고 그 레이아웃으로 바꾼다. 원래 레이아웃은 그대로 남는다
  muwi layout --status [--json]        지금 화면에 muwi 칸이 있는지, 넣을 자리가 있는지 본다
  muwi layout --remove                 원래 레이아웃으로 돌아가고 muwi가 만든 복제본을 지운다

  설치와 설정
  muwi setup                         터미널용 muwi 명령과 Herdr 앱 그래프 칸을 넣는다
  muwi setup --claude                플러그인 없이 쓸 때: Claude Code 훅과 사용법 skill도 넣는다
  muwi setup --codex                 Codex에 지침과 사용법 skill을 넣는다 (훅이 없어 계획 기록만 된다)
  muwi setup --remove                setup으로 넣은 것을 뺀다 (muwi layout으로 바꾼 화면도 되돌린다)
  muwi config [nudge|guard|layout on|off]
                                     계획 알림(nudge), push·PR 앞에서 묻기(guard), 화면 바꾸기 안내(layout)를 켜고 끈다
  muwi --version

작업은 --work <이름>으로 고른다. 없으면 이 세션이 붙어 있는 작업을 쓴다.
기록 폴더: $MUWI_DIR, 없으면 ~/.muwi`;

class Fail extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** 필요한 Node의 가장 낮은 버전 */
const NODE_MIN = 24;

const out = (s: string) => process.stdout.write(s + '\n');

// `muwi show | head`처럼 받는 쪽이 먼저 닫으면 조용히 끝낸다
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const VALUED = new Set(['work', 'request', 'title', 'why', 'by', 'file', 'after', 'before', 'result', 'run', 'show', 'name', 'agent', 'cwd']);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (VALUED.has(name)) {
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new Fail(`--${name}에 값이 없어요`);
        flags[name] = value;
        (multi[name] ??= []).push(value);
      } else flags[name] = true;
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

type Args = ReturnType<typeof parseArgs>;
const str = (a: Args, name: string) => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined);

function isDone(plan: Plan) {
  return plan.nodes.length > 0 && plan.nodes.every(n => n.status === 'done');
}

/** 이 폴더에서 시작한 작업들 (최근 것부터) */
function worksHere(dir: string): Plan[] {
  const here = process.cwd();
  return listWorks(dir)
    .map(w => readPlan(dir, w))
    .filter((p): p is Plan => Boolean(p) && p!.cwd === here)
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

/**
 * 이 명령이 다룰 작업: --work나 $MUWI_WORK → 이 세션이 붙어 있는 작업.
 * 적는 명령은 여기까지만 본다. 폴더를 보고 짐작하면 다른 대화가 남겨 둔 작업에 적어 버릴 수 있다.
 *   guess: 보기만 하는 명령은 그것도 없으면 이 폴더에서 시작한 작업을 쓴다
 *   open: 끝나지 않은 작업만 (이름 없이 계획을 낼 때 끝난 작업을 덮어쓰지 않게)
 */
function resolveWork(a: Args, dir: string, o: { guess?: boolean; open?: boolean; sessionOnly?: boolean } = {}): string {
  const named = str(a, 'work') ?? process.env.MUWI_WORK;
  if (named) {
    const bad = checkWorkName(named);
    if (bad) throw new Fail(bad);
    return named;
  }
  const key = sessionKey();
  const attached = key ? readSession(dir, key)?.work : undefined;
  if (attached) {
    const plan = readPlan(dir, attached);
    if (plan && (!o.open || !isDone(plan))) return attached;
  }
  if (o.sessionOnly) throw new Fail('이 세션이 하던 작업이 없어요');
  const here = worksHere(dir);
  if (o.guess) {
    const open = here.filter(p => !isDone(p));
    if (open.length === 1) return open[0].work;
    if (!open.length && here.length === 1) return here[0].work;
  }
  // 이름이 길게 쏟아지지 않게 몇 개만 보여 준다
  const list = (here.length ? here.map(p => `${p.work}(${isDone(p) ? '끝' : '진행 중'})`) : listWorks(dir)).slice(0, 6);
  throw new Fail(
    `어느 작업인지 알 수 없어요. --work <이름>을 붙여요.${list.length ? ` ${here.length ? '이 폴더의 작업' : '있는 작업'}: ${list.join(', ')}` : ' (아직 기록된 작업이 없어요)'} 전체 목록은 muwi status`,
  );
}

function needPlan(dir: string, work: string): Plan {
  const plan = readPlan(dir, work);
  if (!plan) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  return plan;
}

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
const STATE_NAME: Record<WorkView['state'], string> = { waiting: '나를 기다림', blocked: '막힘', doing: '작업 중', stalled: '멈춤', done: '끝', idle: '노드 사이' };

const RUN_NAME: Record<RunBy, string> = { me: '직접', subagent: '서브에이전트', session: '새 세션' };
const runTag = (n: { run?: RunBy; show?: ShowIn }) => (n.run ? `${RUN_NAME[n.run]}${n.show ? `, ${n.show}` : ''}` : '');

function printPlan(plan: Plan) {
  const width = Math.max(...plan.nodes.map(n => n.id.length));
  for (const n of plan.nodes) {
    out(`  ${MARK[n.status]} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}${n.run ? `  [${runTag(n)}]` : ''}`);
  }
}

/**
 * 계획을 적는다. 처음이면 새 작업을 만들고, 있으면 바꾼 것을 사건 기록에 남긴다.
 * make는 잠금을 잡은 뒤에 지금 계획을 받아 새 계획을 만든다 (그 사이에 다른 세션이 바꾼 것을 덮어쓰지 않게).
 * whole: 계획을 통째로 다시 낸 것. 이미 시작했거나 끝난 노드가 빠져 있으면 받지 않는다
 */
function savePlan(dir: string, work: string, make: (old: Plan | null) => PlanInput, a: Args, whole = false): { plan: Plan; created: boolean; changed: boolean } {
  const key = sessionKey();
  const by = a.flags.human || str(a, 'by') === 'human' ? 'human' : 'ai';
  const why = str(a, 'why')?.trim() || undefined;
  return withLock(workDir(dir, work), () => {
    const old = readPlan(dir, work);
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
      appendEvent(dir, work, { type: 'plan', by, ...(why ? { why } : {}), first: true, added: plan.nodes.map(n => n.id), removed: [], changed: [] }, key, at);
      return { plan, created: true, changed: true };
    }
    const diff = diffPlan(old.nodes, input.nodes);
    const title = str(a, 'title') ?? input.title ?? old.title;
    const request = str(a, 'request') ?? old.request;
    const sameOrder = old.nodes.map(n => n.id).join('\n') === input.nodes.map(n => n.id).join('\n');
    if (isEmptyDiff(diff) && sameOrder && title === old.title && request === old.request) return { plan: old, created: false, changed: false };
    const gone = old.nodes.filter(n => diff.removed.includes(n.id));
    // 통째로 낸 계획은 "여기 없는 노드는 뺀다"는 뜻이 된다. 다른 세션이 넣고 하는 중인 노드를 모른 채 내면 그 노드가 사라진다
    const lost = whole ? gone.filter(n => n.status !== 'todo') : [];
    if (lost.length) {
      throw new Fail(
        `이미 시작했거나 끝난 노드가 새 계획에 없어요: ${lost.map(n => `${n.id}(${MARK[n.status]} ${n.title})`).join(', ')}. 다른 세션이 넣은 노드일 수 있어요. muwi show ${work}로 지금 계획을 보고 그 노드를 넣어서 다시 내요. 정말 빼려면 muwi remove <id> --why "<이유>"로 하나씩 빼요.`,
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
        // 빠진 노드가 무엇이었는지 남긴다. 빠진 뒤에도 기록에서 볼 수 있다
        ...(gone.length ? { gone: gone.map(n => ({ id: n.id, title: n.title, status: n.status })) } : {}),
      }, key, at);
    }
    return { plan, created: false, changed: true };
  });
}

function join(dir: string, work: string) {
  const key = sessionKey();
  if (key) attach(dir, key, work);
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
  const { plan, created, changed } = savePlan(dir, work, () => input, a, true);
  join(dir, work);
  if (a.flags.json) return out(JSON.stringify({ work, created, changed, nodes: plan.nodes }, null, 2));
  if (!changed) return out(`바뀐 것이 없어요: ${work}`);
  out(`${created ? '계획을 적었어요' : '계획을 바꿨어요'}: ${work} (노드 ${plan.nodes.length}개)`);
  printPlan(plan);
  if (created) out('노드를 시작할 때 muwi node <id> start, 끝낼 때 muwi node <id> done "<결과 한 줄>"');
  if (created) warnUnhooked(dir);
}

/**
 * 훅이 돌지 않는 Claude Code 세션이면 알린다 (muwi 플러그인을 설치하기 전에 연 세션 등).
 * 계획과 진행은 적히지만, 읽은 skill과 서브에이전트는 훅이 봐야 적히므로 빠진다
 */
function warnUnhooked(dir: string) {
  const key = sessionKey();
  const session = key ? readSession(dir, key) : null;
  if (!session || session.tool !== 'claude' || session.hooked) return;
  out('※ 이 세션에서는 muwi 훅이 돌지 않아요 (muwi를 설치하기 전에 연 세션일 수 있어요). 계획과 진행은 적히지만 읽은 skill과 서브에이전트가 한 일은 기록되지 않아요. 사용자에게 알리고, 기록이 필요하면 세션을 새로 열어 달라고 해요.');
}

function cmdAdd(a: Args, dir: string) {
  const [id, title] = a.pos;
  if (!id || !title) throw new Fail('사용법: muwi add <id> "<제목>" [--after a,b] [--before c] [--run me|subagent|session] [--show pane|tab] --why "<이유>"');
  const work = resolveWork(a, dir);
  const after = (str(a, 'after') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const before = str(a, 'before');
  const fresh = { id, title, after, ...(str(a, 'run') ? { run: str(a, 'run') } : {}), ...(str(a, 'show') ? { show: str(a, 'show') } : {}) } as NodeInput;
  const { plan } = savePlan(dir, work, old => {
    if (!old) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
    if (old.nodes.some(n => n.id === id)) throw new Fail(`이미 있는 노드예요: ${id}`);
    if (before && !old.nodes.some(n => n.id === before)) throw new Fail(`--before의 ${before}는 없는 노드예요. 있는 노드: ${old.nodes.map(n => n.id).join(', ')}`);
    const { plan: input, problems } = parsePlan(addNode(old, fresh, before));
    if (!input) throw new Fail(`노드를 넣지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);
    return input;
  }, a);
  join(dir, work);
  out(`노드를 넣었어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  printPlan(plan);
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
  join(dir, work);
  out(`노드를 뺐어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  // 하던 노드를 뺀 것이면 알려 둔다. 그 노드의 기록은 muwi show의 "빠진 노드"에 남는다
  if (was !== 'todo') out(`${id}는 ${{ doing: '하는 중', waiting: '사람을 기다리는 중', blocked: '막힌 상태', done: '끝난 상태', todo: '' }[was]}였어요. 기록은 남아 있어요 (muwi show ${work}의 빠진 노드).`);
  printPlan(plan);
}

const ACTION: Record<string, NodeStatus> = { start: 'doing', done: 'done', wait: 'waiting', block: 'blocked', todo: 'todo' };

function cmdNode(id: string | undefined, action: string | undefined, text: string | undefined, a: Args, dir: string) {
  const status = action ? ACTION[action] : undefined;
  if (!id || !status) throw new Fail('사용법: muwi node <id> start | done ["<결과>"] | wait "<물어볼 것>" | block "<이유>"');
  const note = (text ?? str(a, 'result'))?.trim() || undefined;
  if (status === 'waiting' && !note) throw new Fail('무엇을 기다리는지 적어요: muwi node <id> wait "<사람에게 물어볼 것>"');
  if (status === 'blocked' && !note) throw new Fail('왜 막혔는지 적어요: muwi node <id> block "<이유>"');
  const work = resolveWork(a, dir);
  const key = sessionKey();
  const result = markNode(dir, work, id, status, note, key);
  if (!result) {
    const plan = needPlan(dir, work);
    throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}. 새 노드면 muwi add로 먼저 넣어요.`);
  }
  join(dir, work);
  const done = result.nodes.filter(n => n.status === 'done').length;
  const label = { doing: '시작', done: '끝', waiting: '사람을 기다림', blocked: '막힘', todo: '아직으로 되돌림' }[status];
  out(`${MARK[status]} ${id} ${label} (${work}, ${done}/${result.nodes.length} 끝)`);
  if (status === 'done' && done === result.nodes.length) out('모든 노드가 끝났어요.');
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

const pad2 = (n: number) => String(n).padStart(2, '0');
function clockTime(iso: string) {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
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
  const base = who.kind === 'session' ? `새 세션 ${label(who.session)}` : `세션 ${label(who.session)}`;
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

function printShow(v: WorkView) {
  out(`${v.work}${v.title ? ` · ${v.title}` : ''} · ${STATE_NAME[v.state]} (${v.counts.done}/${v.counts.total} 끝)`);
  if (v.request) out(`요청: ${v.request}`);
  if (v.helpers.sessions || v.helpers.subagents) {
    const lead = v.lead ? v.sessions[v.lead]?.label ?? sessionLabel(null, v.lead) : '';
    out(`같이 한 쪽: ${[lead ? `계획을 낸 세션 ${lead}` : '', v.helpers.sessions ? `새 세션 ${v.helpers.sessions}` : '', v.helpers.subagents ? `서브에이전트 ${v.helpers.subagents}` : ''].filter(Boolean).join(' · ')}`);
  }
  out('');
  out('노드');
  const width = Math.max(...v.nodes.map(n => n.id.length));
  for (const n of v.nodes) {
    // 하던 세션이 닫혔으면 그렇게 적는다. 상태는 그대로 두지만 지금 하고 있는 쪽이 없다
    const who = [whoLine(v, n), n.closed ? '세션이 닫힘' : ''].filter(Boolean).join(' · ');
    const meta = [n.attempts > 1 ? `${n.attempts}회차` : '', n.spentMs > 0 ? dur(n.spentMs) : '', who].filter(Boolean).join(' · ');
    out(`  ${MARK[n.status]} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}${meta ? `  (${meta})` : ''}`);
    const indent = ' '.repeat(width + 6);
    if (n.note) out(`${indent}${{ waiting: '기다리는 것', blocked: '막힌 이유', done: '결과' }[n.status as 'waiting' | 'blocked' | 'done'] ?? '메모'}: ${n.note}`);
    if (n.tries.length > 1) {
      // 다시 한 노드는 회차별로 보여 준다. 처음에 무슨 일이 있었는지가 다시 한 기록에 덮이지 않게
      for (const t of n.tries) {
        const head = [`${t.n}회차`, t.startedAt ? clockTime(t.startedAt) : '', t.spentMs > 0 ? dur(t.spentMs) : '', t.who ? whoText(v, t.who) : ''].filter(Boolean).join(' · ');
        const result = t.note && t.n !== n.tries[n.tries.length - 1].n ? ` · ${{ waiting: '기다린 것', blocked: '막힌 이유', done: '결과' }[t.status as 'waiting' | 'blocked' | 'done'] ?? '메모'}: ${t.note}` : '';
        out(`${indent}${head} · ${skillsLine(t, true)}${result}`);
      }
    } else {
      const skills = skillsLine(n, n.attempts > 0);
      if (skills) out(`${indent}${skills}`);
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
        ...c.changed.map(id => `~${id}`),
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

async function withLayout(v: WorkView) {
  const layout = await layoutGraph({ nodes: v.nodes, edges: v.edges });
  return { ...v, layout, layoutProblems: layoutProblems(layout) };
}

async function cmdShow(a: Args, dir: string) {
  const work = a.pos[0] ?? resolveWork(a, dir, { guess: true });
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  if (a.flags.json) return out(JSON.stringify(a.flags.layout ? await withLayout(v) : v, null, 2));
  printShow(v);
}

function cmdStatus(a: Args, dir: string) {
  const board = loadBoard(dir);
  if (a.flags.json) return out(JSON.stringify({ dir, ...board }, null, 2));
  if (!board.works.length) out(`기록된 작업이 없어요 (${dir})`);
  // 끝났거나 멈춘 채로 오래된 작업은 접어 둔다. --all이면 다 보여 준다
  const past = board.works.filter(w => w.past);
  for (const w of board.works) {
    if (w.past && !a.flags.all) continue;
    out(`${STATE_NAME[w.state].padEnd(7)} ${w.work}  ${w.counts.done}/${w.counts.total}${w.title ? `  ${w.title}` : ''}`);
    for (const n of w.active) out(`          ${MARK[n.status]} ${n.id}  ${n.title}${n.closed ? ' (세션이 닫힘)' : ''}${n.note ? ` : ${n.note}` : ''}`);
  }
  if (past.length && !a.flags.all) out(`지난 작업 ${past.length}개는 접어 뒀어요 (${PAST_DAYS}일 넘게 바뀐 것이 없는 작업). muwi status --all로 봐요.`);
  for (const e of board.errors) out(`⚠ ${e.work}: ${e.message}`);
}

async function cmdBoard(a: Args, dir: string) {
  const board = loadBoard(dir);
  // 고른 작업이 없으면 맨 위 작업을 보여 준다. 접어 둔 지난 작업보다 지금 작업이 먼저다
  const pick = str(a, 'work') ?? (board.works.find(w => !w.past) ?? board.works[0])?.work;
  let selected = null;
  if (pick) {
    const v = loadView(dir, pick);
    if (v) selected = await withLayout(v);
  }
  // 그래프 칸이 Herdr 터미널과 작업을 잇는 데 쓴다 (지금 보는 탭의 작업 따라가기, 계획 없는 세션 가려내기)
  const sessions = recentSessions(dir, Date.now() - PAST_DAYS * 86_400_000);
  // 화면에 muwi 칸이 없을 때 그래프 칸이 바꾸자고 안내해도 되는가 (muwi config layout)
  const suggest = readConfig(dir).layout;
  out(JSON.stringify({ dir, ...board, sessions, suggest, selected }));
}

function cmdHook(a: Args, dir: string) {
  // 훅이 실패해도 세션은 계속돼야 한다. 문제는 파일에만 남긴다
  try {
    const text = fs.readFileSync(0, 'utf8');
    const mode = a.pos[0] === 'guard' || a.pos[0] === 'nudge' ? a.pos[0] : 'record';
    const payload = JSON.parse(text);
    // 플러그인이 업데이트돼 설치 위치가 바뀌었으면, 전에 setup으로 넣어 둔 명령과 그래프 칸을 새 위치로 맞춘다
    if (payload?.hook_event_name === 'SessionStart') refreshSetup({ root: ROOT, version: version(), dir });
    const result = handleHook(payload, dir, mode);
    if (result.stdout) out(result.stdout);
  } catch (e: any) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(`${dir}/.hook-errors.log`, `${nowIso()} ${e?.message ?? e}\n`);
    } catch {
      // 남길 곳도 없으면 그냥 넘어간다
    }
  }
}

function version(): string {
  return readJson<{ version?: string }>(`${ROOT}/package.json`)?.version ?? '0.0.0';
}

function cmdSetup(a: Args, dir: string) {
  if (a.flags.remove) {
    // 화면을 바꿔 뒀으면 먼저 되돌린다. 그래프 칸을 빼면 그 레이아웃의 칸이 비기 때문이다
    if (fs.existsSync(`${dir}/layout.json`)) layoutRemoved(guardScreen(() => removeLayout(dir)));
    return removeSetup(dir, out);
  }
  const install = runSetup({ root: ROOT, version: version(), dir, claude: Boolean(a.flags.claude), codex: Boolean(a.flags.codex), log: out });
  if (install.herdr) {
    const checked = checkMod(install.herdr);
    if (checked && checked !== 'ok') out(`Herdr 앱 칸 점검에서 문제가 나왔어요:\n${checked}`);
  }
  if (!install.claude) out('Claude Code의 훅·지침·사용법 skill은 플러그인이 넣어 줘요. 플러그인 없이 쓰려면 muwi setup --claude');
  else out('이미 열려 있는 Claude Code 세션은 다시 시작해야 훅이 적용돼요.');
  if (install.herdr) {
    const screen = screenState(dir);
    // 안내를 꺼 뒀으면 화면이 이미 muwi일 때만 알린다
    if (readConfig(dir).layout || screen.muwi) out(describeScreen(screen));
  }
}

/** 지금 Herdr 앱 화면이 어떤지, 무엇을 할 수 있는지 사람에게 말하듯 적는다 */
function describeScreen(s: Screen): string {
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

function guardScreen<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof ScreenError) throw new Fail(e.message);
    throw e;
  }
}

function layoutRemoved(r: ReturnType<typeof removeLayout>) {
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
  const r = guardScreen(() => applyLayout(dir));
  if (a.flags.json) return out(JSON.stringify(r));
  if (r.already) return out(`이미 muwi 칸이 있는 레이아웃이에요: ${r.name}`);
  out(`Herdr 앱 화면을 ${r.name} 레이아웃으로 ${r.refreshed ? '새 모양에 맞춰 다시 만들었어요' : '바꿨어요'} (${r.base} 레이아웃을 복제했어요).`);
  if (r.list) out('  사이드바: Agents 자리에 작업 목록 (계획 없는 세션도 같이 보여요)');
  if (r.graph) out(`  터미널 아래: ${r.list ? '고른 작업의 그래프 (지금 보는 탭의 작업을 따라가요)' : '작업 목록과 그래프'}`);
  out(`되돌리려면 muwi layout --remove (${r.base} 레이아웃으로 돌아가요)`);
}

const CONFIG_KEYS: (keyof Config)[] = ['nudge', 'guard', 'layout'];
const CONFIG_ABOUT: Record<keyof Config, string> = {
  nudge: '계획을 적지 않은 세션이 파일을 고치거나 서브에이전트를 띄우려 할 때 알린다',
  guard: 'push·PR·댓글 앞에서 사람에게 묻는다',
  layout: 'Herdr 앱 화면에 muwi 칸이 없을 때 넣자고 안내한다 (muwi setup, 그래프 칸)',
};

function cmdConfig(a: Args, dir: string) {
  const [key, value] = a.pos;
  const config = readConfig(dir);
  if (key !== undefined) {
    if (!CONFIG_KEYS.includes(key as keyof Config) || (value !== 'on' && value !== 'off')) {
      throw new Fail(`사용법: muwi config [${CONFIG_KEYS.join('|')}] on|off`);
    }
    config[key as keyof Config] = value === 'on';
    writeConfig(dir, config);
  }
  for (const k of CONFIG_KEYS) out(`${k.padEnd(6)} ${config[k] ? 'on ' : 'off'}  ${CONFIG_ABOUT[k]}`);
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
  const agent = (str(a, 'agent') ?? 'claude').trim().split(/\s+/).filter(Boolean);
  if (!agent.length) throw new Fail('--agent에 띄울 명령이 없어요');
  const brief = `${task.trim()}\n\n(muwi) 작업 ${work}의 노드 ${id}(${node.title})를 맡았어요. 시작은 자동으로 적혀요. 끝나면 muwi node ${id} done "<결과 한 줄>"을 적고, hc send ${lead} "<결과나 막힌 점>"으로 알려요.`;

  // 이름은 Herdr의 목록에서 어느 노드인지 보이게 노드 id로 짓는다. 이미 있는 이름이면 뒤에 몇 글자를 붙인다
  const base = terminalName(str(a, 'name') ?? id);
  let name = base;
  let started: Ran | null = null;
  for (const candidate of [base, `${base.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`]) {
    name = candidate;
    // 맡길 일은 명령 이름 바로 뒤에 둔다. 뒤에 두면 값을 여러 개 받는 옵션(--allowedTools 등)이 삼킨다
    started = hc(['run', '--bg', '--json', '--name', candidate, '--cwd', cwd, '--label', `${LABEL_WORK}=${work}`, '--label', `${LABEL_NODE}=${id}`, '--', agent[0], brief, ...agent.slice(1)]);
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

  let placed = '';
  if (show) {
    const place = show === 'tab' ? 'tab' : a.flags.down ? 'down' : 'right';
    const kept = placeTerminal(terminal, place, lead);
    placed = kept.ok ? show : `${show}에 놓지 못했어요 (${(kept.err || kept.out).trim().split('\n')[0]})`;
  }

  // 맡긴 말도 남긴다. 나중에 "맡긴 쪽이 무엇을 모르고 일했나"를 볼 수 있게
  appendEvent(dir, work, { type: 'spawn', node: id, terminal, name, ...(show ? { show } : {}), task: task.trim().slice(0, 2000) }, sessionKey());
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

/** 이 세션은 계획 없이 진행한다고 밝힌다. 계획을 적지 않은 세션의 파일 수정을 막던 안내가 그친다 */
function cmdSkip(a: Args, dir: string) {
  const reason = a.pos[0]?.trim();
  if (!reason) throw new Fail('사용법: muwi skip "<왜 계획 없이 진행하는지>"');
  const key = sessionKey();
  if (!key) throw new Fail('세션을 알 수 없어요. 이 명령은 에이전트 세션 안에서 실행해요.');
  touchSession(dir, key, { skipped: { at: nowIso(), reason } });
  markSettled(dir, key);
  out(`이 세션은 계획 없이 진행해요: ${reason}`);
}

function cmdSession(dir: string) {
  const key = sessionKey();
  if (!key) return out('세션을 알 수 없어요 (세션 없이도 기록은 돼요. skill 기록은 Claude Code 훅이 있을 때만 붙어요)');
  const s = readSession(dir, key);
  out(`세션 ${key}${s?.work ? ` · 작업 ${s.work}` : ' · 붙어 있는 작업 없음'}${s?.terminal ? ` · 터미널 ${s.terminal}` : ''}`);
  const loaded = Object.keys(s?.loaded ?? {});
  if (loaded.length) out(`읽은 skill: ${loaded.join(', ')}`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const a = parseArgs(rest);
  // TypeScript를 바로 실행하므로 Node 24(LTS) 이상에서만 돈다
  const major = Number(process.versions.node.split('.')[0]);
  if (major < NODE_MIN) throw new Fail(`muwi는 Node ${NODE_MIN} 이상이 필요해요 (지금: ${process.version})`);
  const dir = runsDir();
  switch (cmd) {
    case 'plan': return cmdPlan(a, dir);
    case 'add': return cmdAdd(a, dir);
    case 'remove': return cmdRemove(a, dir);
    case 'node': return cmdNode(a.pos[0], a.pos[1], a.pos[2], a, dir);
    // 짧게: muwi start <id>, muwi done <id> "<결과>"
    case 'start': case 'done': case 'wait': case 'block': return cmdNode(a.pos[0], cmd, a.pos[1], a, dir);
    case 'flag': return cmdFlag(a, dir);
    case 'show': return cmdShow(a, dir);
    case 'status': return cmdStatus(a, dir);
    case 'board': return cmdBoard(a, dir);
    case 'hook': return cmdHook(a, dir);
    case 'setup': return cmdSetup(a, dir);
    case 'config': return cmdConfig(a, dir);
    case 'version': case '--version': case '-v': return out(version());
    case 'open': return cmdOpen(a);
    case 'layout': return cmdLayout(a, dir);
    case 'skip': return cmdSkip(a, dir);
    case 'run': return cmdRun(a, dir);
    case 'tidy': return cmdTidy(a, dir);
    case 'session': return cmdSession(dir);
    case undefined: case 'help': case '--help': case '-h': return out(HELP);
    default: throw new Fail(`모르는 명령: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
  process.exit(e instanceof Fail ? e.code : 1);
});
