// muwi: 작업 계획과 진행을 기록하는 명령.
// AI가 이번 작업의 계획을 스스로 짜서 여기에 적고, 사람은 그 기록을 그래프로 본다.
// 이 명령은 적어 두기만 한다. 순서를 막거나 다음에 할 일을 정하지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { layoutGraph, layoutProblems } from './layout.ts';
import { ROOT, handleHook } from './hook.ts';
import { addNode, carryStatus, diffPlan, isEmptyDiff, parsePlan, removeNode, type PlanInput } from './plan.ts';
import { attach, markSettled, readSession, sessionKey, sessionLabel, touchSession } from './session.ts';
import { checkMod, refreshSetup, removeSetup, runSetup } from './setup.ts';
import {
  appendEvent, checkWorkName, listWorks, nowIso, readConfig, readJson, readPlan, runsDir, withLock, workDir, writeConfig, writePlan,
  type Config, type NodeStatus, type Plan,
} from './store.ts';
import { loadBoard, loadView, type NodeView, type WorkView } from './view.ts';

const HELP = `사용법: muwi <명령>

  계획 (이번 작업을 어떻게 진행할지 스스로 정해서 적는다)
  muwi plan --work <이름> --request "<시킨 말>" '<계획 JSON>'    새 작업의 계획을 적는다
  muwi plan --why "<바꾼 이유>" '<계획 JSON>'                    계획을 바꾼다 (같은 id의 노드는 상태를 잇는다)
  muwi add <id> "<제목>" [--after a,b] [--before c] --why "…"   노드 하나를 끼워 넣는다
  muwi remove <id> --why "…"                                   노드 하나를 뺀다
      계획 JSON: {"title": "한 줄 설명", "nodes": [{"id": "read", "title": "티켓 읽기"},
                                                  {"id": "impl", "title": "구현", "after": ["read"]}]}
      JSON은 인자, --file <경로>, 표준 입력 중 하나로 준다. 사람이 바꾸라고 했으면 --human을 붙인다.

  진행
  muwi node <id> start                 노드를 시작한다
  muwi node <id> done ["<결과 한 줄>"]   노드를 끝낸다
  muwi node <id> wait "<물어볼 것>"     사람의 결정을 기다린다
  muwi node <id> block "<이유>"         막혔다
  muwi flag [<id>] "<메모>"             문제 지점을 표시한다
  muwi skip "<이유>"                   이 세션은 계획 없이 진행한다 (한 곳만 고치는 일, 기록할 작업이 아닐 때)

  보기
  muwi status [--json]                 작업 목록 (나를 기다리는 작업이 위)
  muwi show [<작업>] [--json]           작업 하나의 기록: 노드, 읽은 skill, 계획이 바뀐 이유, 문제 표시
  muwi open [--right]                  Herdr 앱에서 그래프 칸을 이 터미널 아래(--right면 오른쪽)에 연다

  설치와 설정
  muwi setup                         터미널용 muwi 명령과 Herdr 앱 그래프 칸을 넣는다
  muwi setup --claude                플러그인 없이 쓸 때: Claude Code 훅과 사용법 skill도 넣는다
  muwi setup --codex                 Codex에 지침과 사용법 skill을 넣는다 (훅이 없어 계획 기록만 된다)
  muwi setup --remove                setup으로 넣은 것을 뺀다
  muwi config [nudge|guard on|off]   계획 알림(nudge), push·PR 앞에서 묻기(guard)를 켜고 끈다
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

const out = (s: string) => process.stdout.write(s + '\n');

const VALUED = new Set(['work', 'request', 'title', 'why', 'by', 'file', 'after', 'before', 'result']);

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

/** 이 명령이 다룰 작업: --work → 이 세션이 붙어 있는 작업 → $MUWI_WORK → 이 폴더에서 시작한 끝나지 않은 작업 */
function resolveWork(a: Args, dir: string, o: { allowDone?: boolean; sessionOnly?: boolean } = {}): string {
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
    if (plan && (o.allowDone || !isDone(plan))) return attached;
  }
  if (o.sessionOnly) throw new Fail('이 세션이 하던 작업이 없어요');
  const here = process.cwd();
  const mine = listWorks(dir)
    .map(w => readPlan(dir, w))
    .filter((p): p is Plan => Boolean(p) && p!.cwd === here && (o.allowDone || !isDone(p!)))
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  if (mine.length === 1) return mine[0].work;
  const works = listWorks(dir);
  throw new Fail(
    `어느 작업인지 알 수 없어요. --work <이름>을 붙여요.${works.length ? ` 지금 있는 작업: ${works.join(', ')}` : ' (아직 기록된 작업이 없어요)'}`,
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
const STATE_NAME: Record<WorkView['state'], string> = { waiting: '나를 기다림', blocked: '막힘', doing: '작업 중', done: '끝', idle: '노드 사이' };

function printPlan(plan: Plan) {
  const width = Math.max(...plan.nodes.map(n => n.id.length));
  for (const n of plan.nodes) {
    out(`  ${MARK[n.status]} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}`);
  }
}

/** 계획을 적는다. 처음이면 새 작업을 만들고, 있으면 바꾼 것을 사건 기록에 남긴다 */
function savePlan(dir: string, work: string, input: PlanInput, a: Args): { plan: Plan; created: boolean; changed: boolean } {
  const key = sessionKey();
  const by = a.flags.human || str(a, 'by') === 'human' ? 'human' : 'ai';
  const why = str(a, 'why')?.trim() || undefined;
  return withLock(workDir(dir, work), () => {
    const old = readPlan(dir, work);
    const at = nowIso();
    if (!old) {
      const plan: Plan = {
        work,
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
    if (!isEmptyDiff(diff) && !why) {
      throw new Fail(`${work}의 계획을 바꾸려면 --why "<이유>"를 적어요. 나중에 왜 바뀌었는지 볼 수 있게요. 사람이 바꾸라고 했으면 --human도 붙여요. 다른 새 작업이면 --work <새 이름>으로 적어요.`);
    }
    const plan: Plan = { ...old, ...(title ? { title } : {}), ...(request ? { request } : {}), updatedAt: at, nodes: carryStatus(old.nodes, input.nodes) };
    writePlan(dir, plan);
    if (!isEmptyDiff(diff)) appendEvent(dir, work, { type: 'plan', by, ...(why ? { why } : {}), ...diff }, key, at);
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
      work = resolveWork(a, dir, { sessionOnly: true });
    } catch {
      const works = listWorks(dir);
      throw new Fail(
        `새 작업이면 --work <이름>을 붙여요 (티켓 키나 짧은 영문 요약). 하던 작업의 계획을 바꾸는 거면 --work <기존 이름>.${works.length ? ` 지금 있는 작업: ${works.join(', ')}` : ''}`,
      );
    }
  }
  const { plan, created, changed } = savePlan(dir, work, input, a);
  join(dir, work);
  if (a.flags.json) return out(JSON.stringify({ work, created, changed, nodes: plan.nodes }, null, 2));
  if (!changed) return out(`바뀐 것이 없어요: ${work}`);
  out(`${created ? '계획을 적었어요' : '계획을 바꿨어요'}: ${work} (노드 ${plan.nodes.length}개)`);
  printPlan(plan);
  if (created) out('노드를 시작할 때 muwi node <id> start, 끝낼 때 muwi node <id> done "<결과 한 줄>"');
}

function cmdAdd(a: Args, dir: string) {
  const [id, title] = a.pos;
  if (!id || !title) throw new Fail('사용법: muwi add <id> "<제목>" [--after a,b] [--before c] --why "<이유>"');
  const work = resolveWork(a, dir);
  const old = needPlan(dir, work);
  if (old.nodes.some(n => n.id === id)) throw new Fail(`이미 있는 노드예요: ${id}`);
  const after = (str(a, 'after') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const before = str(a, 'before');
  if (before && !old.nodes.some(n => n.id === before)) throw new Fail(`--before의 ${before}는 없는 노드예요. 있는 노드: ${old.nodes.map(n => n.id).join(', ')}`);
  const { plan: input, problems } = parsePlan(addNode(old, { id, title, after }, before));
  if (!input) throw new Fail(`노드를 넣지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);
  const { plan } = savePlan(dir, work, input, a);
  join(dir, work);
  out(`노드를 넣었어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  printPlan(plan);
}

function cmdRemove(a: Args, dir: string) {
  const [id] = a.pos;
  if (!id) throw new Fail('사용법: muwi remove <id> --why "<이유>"');
  const work = resolveWork(a, dir);
  const old = needPlan(dir, work);
  if (!old.nodes.some(n => n.id === id)) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${old.nodes.map(n => n.id).join(', ')}`);
  if (old.nodes.length === 1) throw new Fail('마지막 노드는 뺄 수 없어요');
  const { plan: input, problems } = parsePlan(removeNode(old, id));
  if (!input) throw new Fail(`노드를 빼지 못했어요:\n${problems.map(p => `  - ${p}`).join('\n')}`, 2);
  const { plan } = savePlan(dir, work, input, a);
  join(dir, work);
  out(`노드를 뺐어요: ${id} (${work}, 노드 ${plan.nodes.length}개)`);
  printPlan(plan);
}

const ACTION: Record<string, NodeStatus> = { start: 'doing', done: 'done', wait: 'waiting', block: 'blocked', todo: 'todo' };

function cmdNode(id: string | undefined, action: string | undefined, text: string | undefined, a: Args, dir: string) {
  const status = action ? ACTION[action] : undefined;
  if (!id || !status) throw new Fail('사용법: muwi node <id> start | done ["<결과>"] | wait "<물어볼 것>" | block "<이유>"');
  const note = (text ?? str(a, 'result'))?.trim() || undefined;
  if (status === 'waiting' && !note) throw new Fail('무엇을 기다리는지 적어요: muwi node <id> wait "<사람에게 물어볼 것>"');
  if (status === 'blocked' && !note) throw new Fail('왜 막혔는지 적어요: muwi node <id> block "<이유>"');
  const work = resolveWork(a, dir, { allowDone: true });
  const key = sessionKey();
  const result = withLock(workDir(dir, work), () => {
    const plan = needPlan(dir, work);
    const node = plan.nodes.find(n => n.id === id);
    if (!node) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}. 새 노드면 muwi add로 먼저 넣어요.`);
    const at = nowIso();
    const same = node.status === status && (node.note ?? undefined) === (status === 'doing' ? undefined : note);
    node.status = status;
    if (status === 'doing' || status === 'todo') delete node.note;
    else if (note) node.note = note;
    else delete node.note;
    plan.updatedAt = at;
    writePlan(dir, plan);
    // 같은 상태를 다시 적어도 사건은 남긴다. 다른 세션이 이어받은 것일 수 있다
    if (!same || status === 'doing') appendEvent(dir, work, { type: 'node', node: id, status, ...(node.note ? { note: node.note } : {}) }, key, at);
    return plan;
  });
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
  const work = resolveWork(a, dir, { allowDone: true });
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

function skillsLine(n: NodeView): string {
  const read = n.skills.filter(s => s.state === 'read').map(s => `${s.skill}${s.count > 1 ? ` ×${s.count}` : ''}${s.via === 'file' ? '(파일)' : ''}`);
  const loaded = n.skills.filter(s => s.state === 'loaded').map(s => s.skill);
  const parts: string[] = [];
  if (n.attempts > 0) parts.push(`읽은 skill: ${read.length ? read.join(', ') : '없음'}`);
  if (loaded.length) parts.push(`이미 읽은 상태: ${loaded.join(', ')}`);
  return parts.join(' · ');
}

function printShow(v: WorkView) {
  out(`${v.work}${v.title ? ` · ${v.title}` : ''} · ${STATE_NAME[v.state]} (${v.counts.done}/${v.counts.total} 끝)`);
  if (v.request) out(`요청: ${v.request}`);
  out('');
  out('노드');
  const width = Math.max(...v.nodes.map(n => n.id.length));
  for (const n of v.nodes) {
    const who = n.session ? `세션 ${v.sessions[n.session]?.label ?? sessionLabel(null, n.session)}` : '';
    const meta = [n.attempts > 1 ? `${n.attempts}회차` : '', n.spentMs > 0 ? dur(n.spentMs) : '', who].filter(Boolean).join(' · ');
    out(`  ${MARK[n.status]} ${n.id.padEnd(width)}  ${n.title}${n.after.length ? `  ← ${n.after.join(', ')}` : ''}${meta ? `  (${meta})` : ''}`);
    const indent = ' '.repeat(width + 6);
    if (n.note) out(`${indent}${{ waiting: '기다리는 것', blocked: '막힌 이유', done: '결과' }[n.status as 'waiting' | 'blocked' | 'done'] ?? '메모'}: ${n.note}`);
    const skills = skillsLine(n);
    if (skills) out(`${indent}${skills}`);
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
    for (const s of v.outside) out(`  ${clockTime(s.at)}  ${s.skill}${s.via === 'file' ? '(파일)' : ''}${s.session ? `  세션 ${v.sessions[s.session]?.label ?? ''}` : ''}`);
  }
  const loose = v.flags.filter(f => !f.node);
  if (loose.length) {
    out('');
    out('문제 표시');
    for (const f of loose) out(`  ${clockTime(f.at)}  ${f.text}`);
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
  const work = a.pos[0] ?? resolveWork(a, dir, { allowDone: true });
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  if (a.flags.json) return out(JSON.stringify(a.flags.layout ? await withLayout(v) : v, null, 2));
  printShow(v);
}

function cmdStatus(a: Args, dir: string) {
  const board = loadBoard(dir);
  if (a.flags.json) return out(JSON.stringify({ dir, ...board }, null, 2));
  if (!board.works.length) out(`기록된 작업이 없어요 (${dir})`);
  for (const w of board.works) {
    out(`${STATE_NAME[w.state].padEnd(7)} ${w.work}  ${w.counts.done}/${w.counts.total}${w.title ? `  ${w.title}` : ''}`);
    for (const n of w.active) out(`          ${MARK[n.status]} ${n.id}  ${n.title}${n.note ? ` : ${n.note}` : ''}`);
  }
  for (const e of board.errors) out(`⚠ ${e.work}: ${e.message}`);
}

/** 그래프 화면이 한 번에 읽는 것: 작업 목록과, 고른 작업의 기록과 좌표 */
async function cmdBoard(a: Args, dir: string) {
  const board = loadBoard(dir);
  const pick = str(a, 'work') ?? board.works[0]?.work;
  let selected = null;
  if (pick) {
    const v = loadView(dir, pick);
    if (v) selected = await withLayout(v);
  }
  out(JSON.stringify({ dir, ...board, selected }));
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
  if (a.flags.remove) return removeSetup(dir, out);
  const install = runSetup({ root: ROOT, version: version(), dir, claude: Boolean(a.flags.claude), codex: Boolean(a.flags.codex), log: out });
  if (install.herdr) {
    const checked = checkMod(install.herdr);
    if (checked && checked !== 'ok') out(`Herdr 앱 칸 점검에서 문제가 나왔어요:\n${checked}`);
  }
  if (!install.claude) out('Claude Code의 훅·지침·사용법 skill은 플러그인이 넣어 줘요. 플러그인 없이 쓰려면 muwi setup --claude');
  else out('이미 열려 있는 Claude Code 세션은 다시 시작해야 훅이 적용돼요.');
}

const CONFIG_KEYS: (keyof Config)[] = ['nudge', 'guard'];
const CONFIG_ABOUT: Record<keyof Config, string> = {
  nudge: '계획을 적지 않은 세션이 파일을 고치려 할 때 알린다',
  guard: 'push·PR·댓글 앞에서 사람에게 묻는다',
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
  const split = app(['do', 'pane.split', JSON.stringify({ direction: a.flags.right ? 'right' : 'down', mod: 'muwi', ...(pane ? { pane } : {}) })]);
  if (split.status !== 0) throw new Fail(`그래프 칸을 열지 못했어요: ${(split.stderr || split.stdout).trim()}`);
  if (pane) app(['do', 'pane.focus', JSON.stringify({ pane })]);
  out('그래프 칸을 열었어요. 닫으려면 그 칸의 닫기 버튼을 눌러요.');
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
    case 'skip': return cmdSkip(a, dir);
    case 'session': return cmdSession(dir);
    case undefined: case 'help': case '--help': case '-h': return out(HELP);
    default: throw new Fail(`모르는 명령: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch(e => {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
  process.exit(e instanceof Fail ? e.code : 1);
});
