// 노드를 새 세션에 맡기고, 기다리고, 화면을 보고, 말을 주고받고, 닫고, 이어 한다.
//   muwi run     새 세션을 띄워 노드를 맡긴다
//   muwi wait    맡긴 노드가 끝나거나 사람을 기다리거나 세션이 멈출 때까지 기다린다
//   muwi peek    맡긴 세션의 화면을 본다
//   muwi tell    맡은 세션 → 맡긴 세션, 또는 맡긴 세션 → 맡은 세션으로 말을 보낸다
//   muwi tidy    끝난 노드를 맡았던 새 세션의 터미널을 닫는다
//   muwi resume  닫힌 세션이 하던 노드를 이어 한다
// 무엇을 띄우고 무엇을 적을지는 여기서 정한다. 멀티플렉서에 대한 일(띄우기, 보내기, 읽기, 닫기, 놓기)만 터미널 연결에 맡긴다.
// 맡을지, 누구에게, 어디에 놓을지는 부르는 쪽(AI)이 정한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_ENV, spawnFile } from './events.ts';
import { Fail, needPlan, out, resolveWork, str, type Args } from './kit.ts';
import { ownerOfTerminal, sessionStates } from './live.ts';
import { hasTerminals, terminals, type Spot, type Terminals } from './plugins.ts';
import { resumeFacts } from './resume.ts';
import { readSession, sessionKey } from './session.ts';
import { SHOW_IN, appendEvent, readEvents, writeJson, type Event, type NodeStatus, type ShowIn } from './store.ts';
import { loadView, type NodeView, type WorkView } from './view.ts';
import { launchCommand, modelIn, toolById } from './connectors/tools.ts';

/** 터미널 연결이 그 동작을 할 수 있어야 한다. 없으면 왜 안 되는지 말한다 */
function need<K extends keyof Terminals>(what: K, doing: string): NonNullable<Terminals[K]> {
  const t = terminals();
  const f = t[what];
  if (typeof f === 'function') return (f as Function).bind(t) as NonNullable<Terminals[K]>;
  if (!hasTerminals()) {
    throw new Fail(`${doing} 터미널 연결이 필요한데, 붙은 연결이 없어요. 쓰는 멀티플렉서에 맞는 muwi 패키지로 muwi setup을 하면 생겨요. 여기서는 서브에이전트에 맡기거나 직접 해요.`);
  }
  throw new Fail(`${t.name} 연결은 ${doing.replace(/려면$/, '')} 수 없어요.`);
}

/** 이 명령이 도는 터미널. 멀티플렉서 밖이면 null */
const here = () => terminals().place(process.env)?.terminal ?? null;

/** 노드를 찾는다. 없으면 있는 노드를 알려 준다 */
function nodeOf(v: WorkView, id: string): NodeView {
  const n = v.nodes.find(x => x.id === id);
  if (!n) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${v.nodes.map(x => x.id).join(', ')}`);
  return n;
}

/** 붙은 세션이 있는 spawn의 이름표들 (join 기록) */
function joinedSpawns(dir: string, work: string): Set<string> {
  return new Set(readEvents(dir, work).filter((e): e is Event & { type: 'join' } => e.type === 'join').map(e => e.spawn));
}

/** 가장 최근에 띄운 새 세션이 아직 노드에 붙지 않았다 (뜨는 중이거나 폴더 신뢰 확인에서 멈췄다) */
const pending = (n: NodeView, joined: Set<string>) => Boolean(n.spawn?.id && !joined.has(n.spawn.id));

/**
 * 그 노드를 맡은 세션이 도는 터미널. 가장 최근에 띄운 새 세션이 아직 붙지 않았으면 그 터미널,
 * 아니면 그 노드를 마지막으로 한 세션의 터미널 (다시 연 대화나 이어받은 세션이 다른 터미널에 있을 수 있다), 그것도 모르면 띄운 터미널
 */
function terminalOfNode(v: WorkView, n: NodeView, joined: Set<string>): string | null {
  if (pending(n, joined)) return n.spawn!.terminal;
  return (n.session && v.sessions[n.session]?.terminal) || n.spawn?.terminal || null;
}

const SPOT: Record<ShowIn, (down: boolean) => Spot> = { pane: down => (down ? 'below' : 'beside'), tab: () => 'tab' };

/** 새 세션의 프로그램과 첫 말. --agent로 도구 이름을 주면 그 도구가 첫 말을 받는 모양으로, 명령을 주면 그 명령 그대로 */
function programFor(a: Args, dir: string, brief: string): { argv: string[]; inArgs: boolean; model?: string } {
  const me = sessionKey();
  const asked = str(a, 'agent')?.trim();
  const other = toolById(asked);
  const template = other ? other.launch : launchCommand(me ? readSession(dir, me)?.tool : undefined);
  const given = other ? undefined : asked;
  const agent = (given ?? template[0]).trim().split(/\s+/).filter(Boolean);
  if (!agent.length) throw new Fail('--agent에 띄울 명령이 없어요');
  // 띄우는 명령에 모델을 정해 줬으면 적어 둔다 (--agent "codex --model gpt-5"). 그 세션의 훅이 모델을 알려 주지 않아도 노드에 모델이 남는다
  const model = modelIn(agent);
  // 맡길 일은 명령 이름 바로 뒤에 둔다. 뒤에 두면 값을 여러 개 받는 옵션(--allowedTools 등)이 삼킨다
  // --agent로 준 명령은 그 모양 그대로. 주지 않았으면 그 도구가 첫 말을 받는 자리에 넣는다 (qwen -i "<첫 말>" 같은 것)
  if (given) return { argv: [agent[0], brief, ...agent.slice(1)], inArgs: true, ...(model ? { model } : {}) };
  return { argv: template.map(part => (part === '{prompt}' ? brief : part)), inArgs: template.includes('{prompt}'), ...(model ? { model } : {}) };
}

/**
 * 새 터미널을 띄우고 맡긴 노드를 알려 준다. 맡은 작업과 노드는 환경 변수로 넘기고(뜬 세션의 훅이 읽는다),
 * 환경 변수를 넘기지 못하는 연결을 위해 그 터미널의 표(.spawns)에도 남긴다
 */
function launchFor(dir: string, o: { work: string; node: string; name: string; cwd: string; argv: string[]; inArgs: boolean; brief: string; task: string; model?: string; show?: ShowIn; down?: boolean }) {
  const launch = need('launch', '새 세션을 띄우려면');
  const id = `${o.node}-${crypto.randomBytes(4).toString('hex')}`;
  const env: Record<string, string> = { [RUN_ENV.id]: id, [RUN_ENV.work]: o.work, [RUN_ENV.node]: o.node, ...(o.model ? { [RUN_ENV.model]: o.model } : {}) };
  let started: ReturnType<typeof launch>;
  try {
    started = launch({ cwd: o.cwd, name: o.name, argv: o.argv, env }, process.env);
  } catch (e: any) {
    throw new Fail(`새 세션을 띄우지 못했어요: ${String(e?.message ?? e).trim()}`);
  }
  const terminal = started.terminal;
  const name = started.name ?? o.name;
  writeJson(spawnFile(dir, terminal), { id, work: o.work, node: o.node, ...(o.model ? { model: o.model } : {}) });
  // 띄운 것을 바로 적는다 (말을 보내고 칸에 놓는 동안 뜬 세션이 먼저 일을 시작할 수 있다).
  // 맡긴 말도 남긴다. 나중에 "맡긴 쪽이 무엇을 모르고 일했나"를 볼 수 있게
  // 띄운 폴더도 남긴다. 새 세션이 기록을 남기기 전에 닫혀도 어디서 이어 하면 되는지 알려 줄 수 있게 (worktree에 띄웠을 때)
  const from = here();
  appendEvent(dir, o.work, {
    type: 'spawn', id, node: o.node, terminal, ...(from ? { from } : {}), name, ...(o.show ? { show: o.show } : {}),
    task: o.task.slice(0, 2000), cwd: o.cwd, ...(o.model ? { model: o.model } : {}),
  }, sessionKey());
  // 첫 말을 명령으로 받지 못하는 도구는 뜬 뒤에 말로 보낸다
  let sent = started.delivered !== false;
  if (!o.inArgs) sent = terminals().send?.(terminal, o.brief, process.env) ?? false;
  let placed = '';
  if (o.show) {
    const arrange = terminals().arrange;
    if (!arrange) placed = `${o.show}에 놓지 못했어요 (${terminals().name} 연결은 놓을 곳을 고르지 못해요)`;
    else {
      const r = arrange.call(terminals(), terminal, SPOT[o.show](Boolean(o.down)), here(), process.env);
      placed = r.ok ? o.show : `${o.show}에 놓지 못했어요 (${(r.error ?? '').split('\n')[0]})`;
    }
  }
  return { id, terminal, name, sent, placed };
}

/** muwi run <노드> "<맡길 일>": 노드를 새 세션에 맡긴다 */
export function cmdRun(a: Args, dir: string) {
  const [id, task] = a.pos;
  if (!id || !task?.trim()) throw new Fail('사용법: muwi run <노드 id> "<맡길 일>" [--show pane|tab] [--down] [--name <이름>] [--agent "<도구나 명령>"] [--cwd <폴더>]');
  need('launch', '새 세션을 띄우려면');
  const lead = here();
  if (!lead) throw new Fail(`새 세션은 ${terminals().name} 터미널 안에서 띄워요 (이 명령은 ${terminals().name} 밖에서 돌고 있어요). 여기서는 서브에이전트에 맡기거나 직접 해요.`);
  const work = resolveWork(a, dir);
  const plan = needPlan(dir, work);
  const node = plan.nodes.find(n => n.id === id);
  if (!node) throw new Fail(`없는 노드예요: ${id}. 있는 노드: ${plan.nodes.map(n => n.id).join(', ')}. 새 노드면 muwi add <id> "<제목>" --after <앞 노드> --why "<이유>"로 먼저 넣어요 (이 작업의 흐름에 없는 일이면 새 작업으로).`);
  const show = (str(a, 'show') ?? node.show) as ShowIn | undefined;
  if (show !== undefined && !SHOW_IN.includes(show)) throw new Fail(`--show는 ${SHOW_IN.join(' 또는 ')}이에요`);
  const cwd = path.resolve(str(a, 'cwd') ?? process.cwd());
  const brief = `${task.trim()}\n\n(muwi) 작업 ${work}의 노드 ${id}(${node.title})를 맡았어요. 시작은 자동으로 적혀요. 끝나면 muwi node ${id} done "<결과 한 줄>"을 적고, muwi tell "<결과나 막힌 점>"으로 알려요.`;
  const program = programFor(a, dir, brief);
  const r = launchFor(dir, { work, node: id, name: str(a, 'name') ?? id, cwd, argv: program.argv, inArgs: program.inArgs, brief, task: task.trim(), model: program.model, show, down: Boolean(a.flags.down) });
  out(`새 세션을 띄웠어요: ${r.name} (${r.terminal}) → 노드 ${id}${r.placed ? ` · ${r.placed}` : ''}`);
  if (!r.sent) out(`맡길 일이 아직 전달되지 않았어요. muwi peek ${id} --work ${work}로 화면을 보고(폴더 신뢰 확인이 떠 있을 수 있어요) 사람에게 풀어 달라고 한 뒤 muwi tell ${id} "<맡길 일>" --work ${work}로 다시 보내요.`);
  // muwi run은 세션을 그 작업에 붙이지 않는다: 다른 작업의 노드를 맡겼어도 그대로 따라 칠 수 있게 작업을 적어 준다
  out(`기다리려면 muwi wait ${id} --work ${work}, 화면을 보려면 muwi peek ${id} --work ${work}, 말을 걸려면 muwi tell ${id} "…" --work ${work}`);
}

/**
 * 기다리던 노드에 일어난 일. 아직 아무 일도 없으면 null.
 * soft: 세션이 닫혔거나 멈췄다는 것 (적힌 상태가 아니라 세션을 보고 안 것). 새로 띄운 세션이 아직 붙지 않았으면
 * 그 노드의 세션은 앞 세션이라 보지 않는다 (muwi resume·run 직후에 앞 세션이 닫혀 있어도 기다린다)
 */
function settled(n: NodeView, joined: Set<string>): { what: string; soft: boolean } | null {
  const what: Partial<Record<NodeStatus, string>> = { done: '끝', waiting: '사람을 기다림', blocked: '막힘' };
  if (what[n.status]) return { what: `${what[n.status]}${n.note ? `: ${n.note}` : ''}`, soft: false };
  if (pending(n, joined)) return null;
  if (n.closed) return { what: '세션이 닫힘', soft: true };
  if (n.quiet) return { what: n.quiet === 'asking' ? '세션이 입력을 기다림' : '세션이 멈춤', soft: true };
  return null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * muwi wait [<노드>…]: 맡긴 노드가 끝나거나, 사람을 기다리거나, 막히거나, 세션이 멈추거나 닫힐 때까지 기다린다.
 * 노드를 주지 않으면 이 작업에서 새 세션에 맡긴 노드 중 끝나지 않은 것. --timeout <초>가 지나면 아직이라고 알리고 끝낸다
 */
export async function cmdWait(a: Args, dir: string) {
  const work = resolveWork(a, dir);
  const first = loadView(dir, work);
  if (!first) throw new Fail(`작업이 없어요: ${work}`);
  const ids = a.pos.length ? a.pos : first.nodes.filter(n => n.spawns.length && n.status !== 'done').map(n => n.id);
  if (!ids.length) throw new Fail('기다릴 노드가 없어요. muwi wait <노드 id>로 고르거나, muwi run으로 맡긴 노드가 있어야 해요.');
  for (const id of ids) nodeOf(first, id);
  const timeout = Number(str(a, 'timeout') ?? 600) * 1000;
  const poll = Number(process.env.MUWI_WAIT_POLL_MS) || 2000;
  const sign = (n: NodeView) => `${n.status}|${n.note ?? ''}|${n.closed ? 1 : 0}|${n.quiet ?? ''}|${n.attempts}|${n.spawn?.id ?? ''}`;
  const before = new Map(first.nodes.map(n => [n.id, sign(n)]));
  const pick = (v: WorkView) => ids.map(id => v.nodes.find(n => n.id === id)).filter((n): n is NodeView => Boolean(n));
  // 기다리는 노드가 모두 이미 무언가 일어난 상태면 바로 알린다
  const already = pick(first).map(n => ({ n, got: settled(n, joinedSpawns(dir, work)) }));
  if (already.every(x => x.got)) {
    for (const { n, got } of already) out(`${n.id}: ${got!.what}`);
    return;
  }
  // 세션이 닫혔거나 멈췄다는 것은 두 번 잇달아 보였을 때만 알린다 (세션이 막 떴을 때 멀티플렉서가 잠깐 상태를 모를 수 있다)
  const soft = new Map<string, string>();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
    const v = loadView(dir, work);
    if (!v) throw new Fail(`작업이 없어졌어요: ${work}`);
    const joined = joinedSpawns(dir, work);
    const ready: { id: string; what: string }[] = [];
    for (const n of pick(v)) {
      const got = sign(n) !== before.get(n.id) ? settled(n, joined) : null;
      if (!got) soft.delete(n.id);
      else if (!got.soft || soft.get(n.id) === got.what) ready.push({ id: n.id, what: got.what });
      else soft.set(n.id, got.what);
    }
    if (ready.length) {
      for (const r of ready) out(`${r.id}: ${r.what}`);
      return;
    }
  }
  out(`아직 하는 중이에요 (${Math.round(timeout / 1000)}초 기다림): ${ids.join(', ')}. 다시 기다리려면 muwi wait --work ${work}, 화면은 muwi peek <노드> --work ${work}`);
}

/** muwi peek <노드>: 그 노드를 맡은 세션의 화면을 본다 */
export function cmdPeek(a: Args, dir: string) {
  const [id] = a.pos;
  if (!id) throw new Fail('사용법: muwi peek <노드 id> [--all]');
  const read = need('read', '화면을 보려면');
  const work = resolveWork(a, dir, { guess: true });
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work}`);
  const terminal = terminalOfNode(v, nodeOf(v, id), joinedSpawns(dir, work));
  if (!terminal) throw new Fail(`${id}를 맡은 세션의 터미널을 몰라요`);
  const text = read(terminal, process.env);
  if (text == null) throw new Fail(`${terminal}의 화면을 읽지 못했어요 (터미널이 닫혔을 수 있어요)`);
  const lines = text.replace(/\s+$/, '').split('\n');
  out((a.flags.all ? lines : lines.slice(-80)).join('\n'));
}

/**
 * muwi tell "<말>": 맡은 세션이 맡긴 세션에 알린다 (muwi run이 띄운 터미널로).
 * muwi tell <노드> "<말>": 그 노드를 맡은 세션에 말을 보낸다
 */
export function cmdTell(a: Args, dir: string) {
  const [first, second] = a.pos;
  const toNode = second !== undefined ? first : undefined;
  const text = (second ?? first)?.trim();
  if (!text) throw new Fail('사용법: muwi tell "<말>" (맡긴 세션에 알린다) 또는 muwi tell <노드 id> "<말>" (그 노드를 맡은 세션에 보낸다)');
  const send = need('send', '말을 보내려면');
  const work = resolveWork(a, dir);
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work}`);
  let to: string | null;
  let node: string | undefined;
  let message: string;
  if (toNode) {
    node = nodeOf(v, toNode).id;
    to = terminalOfNode(v, nodeOf(v, toNode), joinedSpawns(dir, work));
    if (!to) throw new Fail(`${toNode}를 맡은 세션의 터미널을 몰라요`);
    if (to === here()) throw new Fail(`${toNode}를 맡은 세션은 이 터미널이에요. 맡긴 세션에 알리려면 muwi tell "<말>"`);
    message = text;
  } else {
    // 이 세션이 맡은 노드: muwi run으로 떠서 붙은 기록 (join)
    const key = sessionKey();
    const events = readEvents(dir, work);
    const joined = key ? events.filter((e): e is Event & { type: 'join' } => e.type === 'join' && e.session === key).at(-1) : undefined;
    const spawn = joined ? events.find((e): e is Event & { type: 'spawn' } => e.type === 'spawn' && e.id === joined.spawn) : undefined;
    if (!joined || !spawn) throw new Fail('이 세션은 muwi run으로 노드를 맡은 세션이 아니에요. 맡긴 세션에 알릴 곳이 없어요 (다른 노드에 보내려면 muwi tell <노드 id> "<말>").');
    if (!spawn.from) throw new Fail('맡긴 세션의 터미널을 몰라요');
    node = joined.node;
    to = spawn.from;
    message = `(muwi) ${work}의 노드 ${joined.node}에서 알림: ${text}`;
  }
  const sent = send(to, message, process.env);
  appendEvent(dir, work, { type: 'tell', ...(node ? { node } : {}), text: text.slice(0, 2000), to, sent }, sessionKey());
  if (!sent) throw new Fail(`보내지 못했어요 (${to}). 그 터미널이 닫혔을 수 있어요.`);
  out(`보냈어요 → ${to}${toNode ? ` (노드 ${toNode})` : ''}`);
}

/** muwi tidy [<작업>]: 끝난 노드를 맡았던 새 세션의 터미널을 닫는다. 판단 과정을 볼 수 있게 평소에는 남겨 두고, 사람이 정리하라고 할 때만 쓴다 */
export function cmdTidy(a: Args, dir: string) {
  const close = need('close', '터미널을 닫으려면');
  const work = a.pos[0] ?? resolveWork(a, dir);
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  const events = readEvents(dir, work);
  const joinedBy = new Map(events.filter((e): e is Event & { type: 'join' } => e.type === 'join').map(e => [e.spawn, e.session]));
  // 같은 노드에 세션을 여러 번 띄웠으면 전부 본다
  const targets = v.nodes.filter(n => n.status === 'done').flatMap(n => n.spawns.map(sp => ({ n, sp })));
  if (!targets.length) return out('닫을 세션이 없어요 (끝난 노드를 맡았던 새 세션만 닫아요)');
  const live = terminals().list?.(process.env) ?? null;
  const alive = live ? new Set(live.map(t => t.terminal)) : null;
  for (const { n, sp } of targets) {
    if (alive && !alive.has(sp.terminal)) {
      out(`  ${n.id}: 이미 없어요 (${sp.terminal})`);
      continue;
    }
    // 주소는 다시 쓰일 수 있다. 그 터미널을 지금 쓰는 세션이 이 노드를 맡았던 세션일 때만 닫는다.
    // 에이전트가 돌지 않는 터미널은 닫지 않는다 (맡은 세션이 끝난 뒤 셸이나 다른 프로그램이 남았을 수 있다)
    const owner = ownerOfTerminal(dir, sp.terminal);
    const mine = sp.id ? joinedBy.get(sp.id) : undefined;
    if (owner && owner.key !== mine) {
      out(`  ${n.id}: 다른 대화가 그 터미널을 쓰고 있어 닫지 않았어요 (${sp.terminal})`);
      continue;
    }
    if (live?.find(t => t.terminal === sp.terminal)?.agent === 'none') {
      out(`  ${n.id}: 에이전트가 돌지 않는 터미널이라 닫지 않았어요 (${sp.terminal}). 다른 프로그램이 쓰고 있을 수 있어요`);
      continue;
    }
    const ok = close(sp.terminal, process.env);
    fs.rmSync(spawnFile(dir, sp.terminal), { force: true });
    out(`  ${n.id}: ${sp.terminal} ${ok ? '닫음' : '닫지 못함'}`);
  }
}

/**
 * muwi resume <노드>: 그 노드를 하던 세션이 닫혔을 때 이어 한다. 하던 대화를 다시 열 수 있으면 그 대화를,
 * 없으면 새 대화를 띄워 그 노드를 맡긴다 (muwi run과 같이 노드에 붙는다)
 */
export function cmdResume(a: Args, dir: string) {
  const [id] = a.pos;
  if (!id) throw new Fail('사용법: muwi resume <노드 id> [--show pane|tab] [--down] [--new] [--force]');
  need('launch', '세션을 띄우려면');
  const work = resolveWork(a, dir, { guess: true });
  const v = loadView(dir, work);
  if (!v) throw new Fail(`작업이 없어요: ${work}`);
  const n = nodeOf(v, id);
  const show = (str(a, 'show') ?? n.show) as ShowIn | undefined;
  if (show !== undefined && !SHOW_IN.includes(show)) throw new Fail(`--show는 ${SHOW_IN.join(' 또는 ')}이에요`);
  const key = n.session;
  // 그 노드를 하던 세션이 아직 살아 있으면 하나 더 띄우지 않는다
  if (key && !n.closed && n.status !== 'done' && !a.flags.force && sessionStates(dir, [key]).status.has(key)) {
    throw new Fail(`${id}를 하던 세션이 아직 살아 있어요 (${v.sessions[key]?.terminal ?? key}). muwi peek ${id} --work ${work}로 보거나 muwi tell ${id} "…" --work ${work}로 말을 걸어요. 그래도 새로 띄우려면 --force`);
  }
  const facts = resumeFacts(v);
  const folder = [key ? v.sessions[key]?.cwd : undefined, n.spawn?.cwd, v.cwd].find(f => f && facts.exists[f]) ?? process.cwd();
  const again = key && !a.flags.new ? facts.resume[key] : undefined;
  if (again) {
    // 하던 대화를 다시 연다. 같은 세션이라 이미 이 작업에 붙어 있다
    const r = need('launch', '세션을 띄우려면')({ cwd: folder, name: str(a, 'name') ?? id, argv: again, env: {} }, process.env);
    out(`하던 대화를 다시 열었어요: ${r.name ?? id} (${r.terminal}) → ${again.join(' ')}`);
    return;
  }
  const brief = `${work} 작업의 ${id} 노드 이어서 해줘. muwi show ${work}로 계획과 지금까지의 기록을 먼저 본다.`;
  const template = (key && facts.launch[key]) || facts.launcher;
  if (!template) throw new Fail(`어느 AI 도구로 새 대화를 띄울지 몰라요 (이 작업을 한 세션의 도구를 알 수 없어요). muwi run ${id} "<맡길 일>" --agent <도구>로 맡기세요.`);
  const argv = template.map(part => (part === '{prompt}' ? brief : part));
  const r = launchFor(dir, { work, node: id, name: str(a, 'name') ?? id, cwd: folder, argv, inArgs: template.includes('{prompt}'), brief, task: brief, show, down: Boolean(a.flags.down) });
  out(`새 대화로 이어 가요: ${r.name} (${r.terminal}) → 노드 ${id}${r.placed ? ` · ${r.placed}` : ''}`);
}
