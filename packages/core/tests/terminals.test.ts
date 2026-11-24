// 세션이 살아 있는지와 맡은 노드: 훅(세션 시작·끝, 말을 걸고 끝낸 때), 세션 파일(같은 터미널의 더 늦은 세션), 터미널 연결의 목록을 합쳐 본다.
// 터미널 연결은 시험용 연결을 쓴다 (fake-terminals.ts). 특정 멀티플렉서에 기대지 않는다
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleHook } from '../src/hook.ts';
import { sessionStates } from '../src/live.ts';
import { markNode } from '../src/node.ts';
import { setTerminals } from '../src/plugins.ts';
import { attach, readSession, touchSession } from '../src/session.ts';
import { appendEvent, clock, readEvents, writePlan, type NodeStatus, type Plan } from '../src/store.ts';
import { PAST_DAYS, loadBoard, loadView } from '../src/view.ts';
import { calls, fakeTerminals } from './fake-terminals.ts';

setTerminals(fakeTerminals);
const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.resolve(ROOT, 'src/cli.ts');
const FAKE = path.resolve(import.meta.dirname, 'fake-terminals.ts');
const ENV = {} as NodeJS.ProcessEnv;
const T0 = Date.parse('2026-11-22T05:00:00.000Z');
const at = (min: number) => { clock.now = () => new Date(T0 + min * 60_000); };
/** 터미널 연결이 알려 줄 살아 있는 터미널들 */
const live = (list: { terminal: string; agent?: string }[]) => ({ FAKE_TERMINALS_LIVE: JSON.stringify(list) }) as NodeJS.ProcessEnv;
const inTerminal = (t: string) => ({ TEST_PLACE: t }) as NodeJS.ProcessEnv;

function setup(nodes: { id: string; after?: string[] }[], work = 'w1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-live-'));
  at(0);
  const plan: Plan = {
    work, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    nodes: nodes.map(n => ({ id: n.id, title: n.id, after: n.after ?? [], status: 'todo' as NodeStatus })),
  };
  writePlan(dir, plan);
  appendEvent(dir, work, { type: 'plan', by: 'ai', first: true, added: plan.nodes.map(n => n.id), removed: [], changed: [] }, 'lead');
  attach(dir, 'lead', work, ENV);
  const node = (id: string, status: NodeStatus, session: string, note?: string) => {
    assert.ok(markNode(dir, work, id, status, note, session, ENV));
    attach(dir, session, work, ENV);
  };
  const hook = (payload: Record<string, unknown>, session: string, env: NodeJS.ProcessEnv = ENV) =>
    handleHook({ session_id: session, ...payload }, dir, 'record', env, ROOT);
  const view = (env: NodeJS.ProcessEnv = ENV) => loadView(dir, work, env)!;
  return { dir, work, node, hook, view };
}

test('세션이 닫혔는지: 훅이 끝났다고 했거나, 같은 터미널에 더 늦게 시작한 세션이 있거나, 터미널이 없거나 에이전트가 돌지 않으면 닫힌 것', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-live-'));
  at(0);
  touchSession(dir, 'ended', { endedAt: new Date(T0 + 5 * 60_000).toISOString() }, inTerminal('t1'));
  touchSession(dir, 'gone', {}, inTerminal('t3'));      // 터미널을 닫았다
  touchSession(dir, 'shell', {}, inTerminal('t4'));     // 에이전트를 끝내고 셸만 남았다
  touchSession(dir, 'cleared', {}, inTerminal('t5'));   // 같은 터미널에서 /clear 하고 다른 대화를 시작했다
  touchSession(dir, 'alive', {}, inTerminal('t6'));     // 그대로 돌고 있다
  touchSession(dir, 'unknown', {}, ENV);                // 터미널을 모른다. 훅이 알려 준 것만 본다
  at(1);
  touchSession(dir, 'someone-else', {}, inTerminal('t5'));
  const keys = ['ended', 'gone', 'shell', 'cleared', 'alive', 'unknown'];
  const s = sessionStates(dir, keys, live([{ terminal: 't4', agent: 'none' }, { terminal: 't5' }, { terminal: 't6', agent: 'working' }]));
  assert.deepEqual([...s.closed.keys()].sort(), ['cleared', 'ended', 'gone', 'shell']);
  assert.equal(s.closed.get('ended'), T0 + 5 * 60_000);
  assert.equal(s.status.get('alive'), 'working');
  // 터미널 목록을 물어보지 못했으면 터미널로는 닫혔다고 하지 않는다 (훅과 세션 파일로 아는 것만)
  const blind = sessionStates(dir, keys, ENV);
  assert.deepEqual([...blind.closed.keys()].sort(), ['cleared', 'ended']);
});

test('터미널 연결 없이도 훅으로 세션이 일하는지 기다리는지 안다: 사람이 말을 걸면 일하는 중, 말을 끝내면 멈춤, 세션이 끝나면 닫힘', () => {
  const s = setup([{ id: 'a' }]);
  at(1); s.hook({ hook_event_name: 'SessionStart', source: 'startup' }, 'lead'); s.node('a', 'doing', 'lead');
  s.hook({ hook_event_name: 'UserPromptSubmit' }, 'lead');
  assert.deepEqual([s.view().state, s.view().nodes[0].quiet], ['doing', undefined]);
  // 노드를 끝냈다고 적지 않은 채 말을 끝냈다
  s.hook({ hook_event_name: 'Stop' }, 'lead');
  assert.deepEqual([s.view().state, s.view().nodes[0].quiet], ['waiting', 'stopped']);
  // 서브에이전트가 끝난 것은 세션의 차례가 아니다
  s.hook({ hook_event_name: 'UserPromptSubmit' }, 'lead');
  s.hook({ hook_event_name: 'Stop', agent_id: 'sub-1' }, 'lead');
  assert.equal(s.view().nodes[0].quiet, undefined);
  // 세션을 닫았다
  at(9); s.hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, 'lead');
  assert.equal(readSession(s.dir, 'lead')!.endedAt, new Date(T0 + 9 * 60_000).toISOString());
  assert.deepEqual([s.view().state, s.view().nodes[0].closed], ['stalled', true]);
});

test('하던 세션이 닫힌 노드는 "세션이 닫힘"으로 보이고, 시간은 거기서 멈추고, 작업은 맨 위에서 내려온다', () => {
  const s = setup([{ id: 'impl' }, { id: 'pr', after: ['impl'] }]);
  at(1); touchSession(s.dir, 'worker', {}, inTerminal('t3')); s.node('impl', 'doing', 'worker');
  at(4); touchSession(s.dir, 'worker', {}, inTerminal('t3')); // 세션이 마지막으로 무언가를 한 때
  at(60);
  const alive = live([{ terminal: 't3', agent: 'working' }]);
  const dead = live([]);
  let v = s.view(alive);
  assert.deepEqual([v.state, v.nodes[0].closed, v.nodes[0].spentMs / 60_000], ['doing', undefined, 59]);
  // 터미널을 닫았다: 상태는 그대로 두고(끝났는지 모른다) 닫혔다고만 표시한다. 시간은 마지막으로 본 때까지
  v = s.view(dead);
  assert.deepEqual([v.state, v.nodes[0].status, v.nodes[0].closed, v.nodes[0].spentMs / 60_000], ['stalled', 'doing', true, 3]);
  // 닫힌 세션이 남긴 "응답 대기"는 작업을 맨 위로 올리지 않는다
  at(61); s.node('impl', 'waiting', 'worker', 'PR 올릴까요?');
  assert.equal(s.view(alive).state, 'waiting');
  assert.equal(s.view(dead).state, 'stalled');
  // 새 대화가 이어받으면 다시 살아난다 (같은 회차를 이어 한다)
  at(62); s.node('impl', 'doing', 'tomorrow');
  v = s.view(dead);
  assert.deepEqual([v.state, v.nodes[0].closed, v.nodes[0].attempts, v.nodes[0].who!.session], ['doing', undefined, 1, 'tomorrow']);
});

test('하는 노드가 없는 작업은 그 세션이 하는 일로 보인다: 일하는 중이면 작업 중, 멈췄으면 응답 대기, 맡은 세션이 없으면 멈춤', () => {
  const s = setup([{ id: 'read' }, { id: 'impl', after: ['read'] }]);
  at(1); touchSession(s.dir, 'lead', {}, inTerminal('t3')); s.node('read', 'doing', 'lead');
  at(2); s.node('read', 'done', 'lead');
  const shown = (env: NodeJS.ProcessEnv) => [s.view(env).state, s.view(env).between];
  const one = (agent: string) => live([{ terminal: 't3', agent }]);
  assert.deepEqual(shown(one('working')), ['doing', 'working']);
  assert.deepEqual(shown(one('done')), ['waiting', 'stopped']);
  assert.deepEqual(shown(one('idle')), ['waiting', 'stopped']);
  assert.deepEqual(shown(one('blocked')), ['waiting', 'asking']);
  assert.deepEqual(shown(live([])), ['stalled', 'gone']);
  // 터미널 연결도 훅도 알려 주지 않았다: 작업 중으로 본다
  assert.deepEqual(shown(ENV), ['doing', 'unknown']);
  // 세션이 다른 작업으로 갔다
  attach(s.dir, 'lead', 'other', ENV);
  assert.deepEqual(shown(one('working')), ['stalled', 'gone']);
});

test('하는 중이라고 적힌 노드도 그 세션이 일을 멈췄으면 멈춘 것으로 보인다. 목록에는 그 세션의 터미널도 준다', () => {
  const s = setup([{ id: 'a' }, { id: 'b' }]);
  at(1); touchSession(s.dir, 'lead', {}, inTerminal('t3')); s.node('a', 'doing', 'lead');
  at(2); touchSession(s.dir, 'worker', {}, inTerminal('t4')); s.node('b', 'doing', 'worker');
  const shown = (env: NodeJS.ProcessEnv) => [s.view(env).state, s.view(env).quiet, ...s.view(env).nodes.map(n => n.quiet)];
  const two = (a: string, b: string) => live([{ terminal: 't3', agent: a }, { terminal: 't4', agent: b }]);
  assert.deepEqual(shown(two('done', 'working')), ['doing', undefined, 'stopped', undefined]);
  assert.deepEqual(shown(two('done', 'blocked')), ['waiting', 'asking', 'stopped', 'asking']);
  const board = loadBoard(s.dir, two('done', 'blocked')).works.find(w => w.work === s.work)!;
  assert.deepEqual(board.active.map(n => [n.id, n.quiet, n.terminal]), [['a', 'stopped', 't3'], ['b', 'asking', 't4']]);
});

test('지난 작업: 끝났거나 멈춘 채로 오래된 작업은 접는다. 살아 있는 세션이 하는 작업은 오래돼도 접지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-past-'));
  const make = (work: string, session: string, terminal: string, done: boolean) => {
    writePlan(dir, { work, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), nodes: [{ id: 'n', title: 'n', after: [], status: 'todo' }] });
    touchSession(dir, session, {}, inTerminal(terminal));
    markNode(dir, work, 'n', 'doing', undefined, session, ENV);
    if (done) markNode(dir, work, 'n', 'done', undefined, session, ENV), appendEvent(dir, work, { type: 'viewed' }, null);
  };
  at(0);
  make('old-done', 's1', 't1', true);
  make('old-stalled', 's2', 't2', false);
  make('old-live', 's3', 't3', false);
  at(60 * 24 * (PAST_DAYS + 1));
  make('new-done', 's4', 't4', true);
  const board = loadBoard(dir, live([{ terminal: 't3', agent: 'working' }, { terminal: 't4' }]));
  assert.deepEqual(board.works.map(w => `${w.work}:${w.state}:${w.past ? '지난' : '지금'}`), [
    'old-live:doing:지금', 'old-stalled:stalled:지난', 'new-done:done:지금', 'old-done:done:지난',
  ]);
});

/** muwi 명령을 시험용 터미널 연결과 함께 실행한다 */
function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-run-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-run-cwd-'));
  const log = path.join(dir, 'terminals.log');
  const muwi = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead', MUWI_TERMINALS: FAKE, FAKE_TERMINALS_LOG: log, TEST_PLACE: 't2', MUWI_WAIT_POLL_MS: '50', ...env },
      cwd, encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const plan = JSON.stringify({ title: '링크 추가', nodes: [{ id: 'read', title: '읽기' }, { id: 'impl', title: '화면 구현', after: ['read'], run: 'session', show: 'pane' }, { id: 'review', title: '리뷰', after: ['impl'], run: 'subagent' }] });
  assert.equal(muwi(['plan', '--work', 'shop-1', '--request', '작업해줘', plan]).code, 0);
  return { dir, cwd, log, muwi, did: () => calls(log) };
}

test('muwi run: 연결에 새 터미널을 띄우게 하고, 맡은 작업과 노드는 환경 변수로 넘기고, 계획에 적은 자리에 놓는다', () => {
  const { dir, cwd, muwi, did } = bench();
  const r = muwi(['run', 'impl', '목록 화면에 링크를 추가해줘']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /새 세션을 띄웠어요: impl \(t7\) → 노드 impl · pane/);
  assert.match(r.out, /기다리려면 muwi wait impl, 화면을 보려면 muwi peek impl/);
  const [launch, arrange] = did();
  assert.equal(launch.do, 'launch');
  assert.equal(launch.name, 'impl');
  assert.ok(launch.cwd === cwd || launch.cwd === fs.realpathSync(cwd));
  assert.equal(launch.argv[0], 'claude');
  assert.match(launch.argv[1], /^목록 화면에 링크를 추가해줘\n\n\(muwi\) 작업 shop-1의 노드 impl\(화면 구현\)를 맡았어요[\s\S]*muwi tell "<결과나 막힌 점>"/);
  assert.equal(launch.env.MUWI_RUN_WORK, 'shop-1');
  assert.equal(launch.env.MUWI_RUN_NODE, 'impl');
  assert.match(launch.env.MUWI_RUN, /^impl-[0-9a-f]{8}$/);
  assert.deepEqual(arrange, { do: 'arrange', terminal: 't7', spot: 'beside', near: 't2' });
  const spawn = readEvents(dir, 'shop-1').find(e => e.type === 'spawn')!;
  assert.deepEqual({ ...spawn, at: '', cwd: '' }, { at: '', cwd: '', session: 'lead', type: 'spawn', id: launch.env.MUWI_RUN, node: 'impl', terminal: 't7', from: 't2', name: 'impl', show: 'pane', task: '목록 화면에 링크를 추가해줘' });
  // 환경 변수를 넘기지 못하는 연결을 위해 그 터미널의 표도 남긴다
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.spawns', 't7.json'), 'utf8')), { id: launch.env.MUWI_RUN, work: 'shop-1', node: 'impl' });
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /impl +화면 구현 +← read +\(새 세션 t7 뜨는 중\)\n +맡긴 말 \(t7\): 목록 화면에 링크를 추가해줘/);
  // 놓을 곳과 띄울 명령은 부르는 쪽이 고른다
  assert.equal(muwi(['run', 'review', '리뷰해줘', '--agent', 'codex --model gpt-x', '--show', 'tab']).code, 0);
  const again = did().filter(c => c.do === 'launch')[1];
  assert.deepEqual(again.argv.slice(0, 1).concat(again.argv.slice(2)), ['codex', '--model', 'gpt-x']);
  assert.equal(did().at(-1)!.spot, 'tab');
  assert.equal(muwi(['run', 'impl', '해줘', '--down']).code, 0);
  assert.equal(did().at(-1)!.spot, 'below');
});

test('muwi run: 터미널 밖이거나, 없는 노드거나, 띄우지 못하면 이유를 말한다. 첫 말이 전달되지 않았으면 그렇다고 알린다', () => {
  const { muwi, did } = bench();
  assert.match(muwi(['run', 'impl', '해줘'], { TEST_PLACE: '' }).err, /시험 연결 터미널 안에서 띄워요/);
  assert.match(muwi(['run', 'nope', '해줘']).err, /없는 노드예요: nope/);
  assert.match(muwi(['run', 'impl']).err, /사용법: muwi run/);
  assert.match(muwi(['run', 'impl', '해줘', '--show', 'window']).err, /--show는 pane 또는 tab/);
  assert.match(muwi(['run', 'impl', '해줘'], { FAKE_LAUNCH_FAIL: '이름이 겹쳐요' }).err, /새 세션을 띄우지 못했어요: 이름이 겹쳐요/);
  assert.match(muwi(['run', 'impl', '해줘'], { FAKE_UNDELIVERED: '1' }).out, /맡길 일이 아직 전달되지 않았어요/);
  assert.equal(did().filter(c => c.do === 'launch').length, 2);
});

test('muwi run으로 뜬 세션은 시작할 때 환경 변수로 맡은 노드를 알고 붙는다. 같은 터미널에서 나중에 시작한 대화는 다시 붙지 않는다', () => {
  const { dir, muwi, did } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  const env = { ...did()[0].env, TEST_PLACE: 't7' } as NodeJS.ProcessEnv;
  at(1);
  const start = handleHook({ session_id: 'child', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', env, ROOT);
  const text = JSON.parse(start.stdout!).hookSpecificOutput.additionalContext as string;
  assert.match(text, /이 세션은 작업 `shop-1`의 노드 `impl`\(화면 구현\)를 맡아서 떴다/);
  assert.match(text, /muwi tell "<결과나 막힌 점>"/);
  assert.equal(readSession(dir, 'child')!.work, 'shop-1');
  const shown = JSON.parse(muwi(['show', 'shop-1', '--json']).out).nodes.find((n: any) => n.id === 'impl');
  assert.deepEqual([shown.status, shown.who.kind, shown.who.session], ['doing', 'session', 'child']);
  // /clear 하고 다른 일을 시작한 대화: 환경 변수는 남아 있지만 이미 붙은 세션이 있다
  at(2);
  const later = handleHook({ session_id: 'unrelated', hook_event_name: 'SessionStart', source: 'clear' }, dir, 'record', env, ROOT);
  assert.doesNotMatch(JSON.parse(later.stdout!).hookSpecificOutput.additionalContext, /이 세션이 맡은 노드/);
  assert.equal(readEvents(dir, 'shop-1').filter(e => e.type === 'join').length, 1);
  // 그 대화가 시작돼서 앞 세션은 닫힌 것으로 보인다 (같은 터미널에 더 늦게 시작한 세션)
  assert.ok(sessionStates(dir, ['child'], ENV).closed.has('child'));
});

test('세션 시작을 알려 주지 않고 환경 변수도 받지 못한 세션: 그 터미널의 표로 첫 muwi 명령에서 맡은 노드에 붙는다. 띄울 때 준 모델을 물려받는다', () => {
  const { muwi } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘', '--agent', 'codex --model gpt-x']).code, 0);
  const done = muwi(['node', 'impl', 'done', '링크 추가함'], { MUWI_SESSION: 'worker', TEST_PLACE: 't7' });
  assert.equal(done.code, 0, done.err);
  const node = JSON.parse(muwi(['show', 'shop-1', '--json']).out).nodes.find((n: any) => n.id === 'impl');
  assert.deepEqual([node.status, node.who.kind, node.who.session, node.who.model], ['done', 'session', 'worker', 'gpt-x']);
});

test('muwi tell: 맡은 세션은 맡긴 세션의 터미널로 알리고, 맡긴 세션은 노드를 맡은 세션에 말을 보낸다', () => {
  const { dir, muwi, did } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  const child = { MUWI_SESSION: 'child', TEST_PLACE: 't7', ...did()[0].env };
  const up = muwi(['tell', '링크 추가했어요. PR은 아직'], child);
  assert.equal(up.code, 0, up.err);
  assert.deepEqual(did().at(-1), { do: 'send', terminal: 't2', text: '(muwi) shop-1의 노드 impl에서 알림: 링크 추가했어요. PR은 아직' });
  const down = muwi(['tell', 'impl', '테스트도 돌려 줘']);
  assert.equal(down.code, 0, down.err);
  assert.deepEqual(did().at(-1), { do: 'send', terminal: 't7', text: '테스트도 돌려 줘' });
  assert.deepEqual(readEvents(dir, 'shop-1').filter(e => e.type === 'tell').map(e => [e.session, (e as any).node, (e as any).to, (e as any).sent]), [['child', 'impl', 't2', true], ['lead', 'impl', 't7', true]]);
  // 맡은 세션이 아니면 알릴 곳이 없다
  assert.match(muwi(['tell', '끝났어요']).err, /muwi run으로 노드를 맡은 세션이 아니에요/);
  assert.match(muwi(['tell', 'impl', '…'], { FAKE_SEND_FAIL: '1' }).err, /보내지 못했어요 \(t7\)/);
});

test('muwi wait: 맡긴 노드에 일이 생길 때까지 기다리고, 무엇이 일어났는지 알린다. 기한이 지나면 아직이라고 한다', async () => {
  const { muwi } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  assert.match(muwi(['wait', '--timeout', '0.2']).out, /아직 하는 중이에요 \(0초 기다림\): impl/);
  // 기다리는 동안 맡은 세션이 노드를 끝낸다
  const { spawn } = await import('node:child_process');
  const dir = JSON.parse(muwi(['status', '--json']).out).dir as string;
  const child = spawn(process.execPath, [CLI, 'wait', 'impl', '--work', 'shop-1', '--timeout', '10'], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead', MUWI_TERMINALS: FAKE, MUWI_WAIT_POLL_MS: '50' },
  });
  let out = '';
  child.stdout.on('data', d => (out += d));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(muwi(['node', 'impl', 'done', '커밋 2개', '--work', 'shop-1'], { MUWI_SESSION: 'child', TEST_PLACE: 't7' }).code, 0);
  await new Promise(r => child.on('exit', r));
  assert.equal(out, 'impl: 끝: 커밋 2개\n');
  // 이미 일이 생긴 노드만 기다리면 바로 알린다
  assert.equal(muwi(['wait', 'impl']).out, 'impl: 끝: 커밋 2개\n');
  assert.match(muwi(['wait', 'nope']).err, /없는 노드예요: nope/);
});

test('muwi peek: 노드를 맡은 세션의 화면을 본다', () => {
  const { muwi, did } = bench();
  assert.match(muwi(['peek', 'impl']).err, /impl를 맡은 세션의 터미널을 몰라요/);
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  assert.equal(muwi(['peek', 'impl']).out, 't7의 화면\n둘째 줄\n');
  assert.deepEqual(did().at(-1), { do: 'read', terminal: 't7' });
});

test('muwi tidy: 끝난 노드를 맡았던 세션만, 그 터미널을 지금도 그 세션이 쓸 때만 닫는다', () => {
  const { dir, muwi, did } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  assert.match(muwi(['tidy', 'shop-1']).out, /닫을 세션이 없어요/);
  const env = did()[0].env;
  assert.equal(muwi(['node', 'impl', 'done', '커밋 2개', '--work', 'shop-1'], { MUWI_SESSION: 'child', TEST_PLACE: 't7', ...env }).code, 0);
  assert.match(muwi(['show', 'shop-1']).out, /같이 한 쪽: 계획을 낸 세션 \S+ · 새 세션 1/);
  // 그 터미널을 다른 대화가 이어 쓰고 있으면 닫지 않는다
  at(0); touchSession(dir, 'other', { startedAt: '2099-01-01T00:00:00.000Z' }, inTerminal('t7'));
  assert.match(muwi(['tidy', 'shop-1']).out, /impl: 다른 대화가 그 터미널을 쓰고 있어 닫지 않았어요/);
  fs.rmSync(path.join(dir, '.sessions', 'other.json'));
  // 이미 없는 터미널은 닫지 않는다
  assert.match(muwi(['tidy', 'shop-1'], { FAKE_TERMINALS_LIVE: '[]' }).out, /impl: 이미 없어요 \(t7\)/);
  assert.match(muwi(['tidy', 'shop-1']).out, /impl: t7 닫음/);
  assert.deepEqual(did().at(-1), { do: 'close', terminal: 't7' });
  assert.equal(fs.existsSync(path.join(dir, '.spawns', 't7.json')), false);
});

test('muwi resume: 닫힌 세션이 하던 노드를 새 대화로 이어 한다 (muwi run처럼 노드에 붙는다)', () => {
  const { muwi, did } = bench();
  assert.equal(muwi(['node', 'impl', 'start', '--work', 'shop-1'], { MUWI_SESSION: 'gone-1' }).code, 0);
  const r = muwi(['resume', 'impl', '--work', 'shop-1']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /새 대화로 이어 가요: impl \(t7\) → 노드 impl · pane/);
  const launch = did().find(c => c.do === 'launch')!;
  assert.match(launch.argv[1], /shop-1 작업의 impl 노드 이어서 해줘/);
  assert.equal(launch.env.MUWI_RUN_NODE, 'impl');
});
