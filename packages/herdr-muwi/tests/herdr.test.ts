// Herdr 화면: 세션이 살아 있는지(hc), 맡긴 노드(터미널 이름표), 새 세션에 맡기기(muwi run·tidy), 세션 상태로 보이는 작업과 노드.
// hc와 herdr-app은 흉내 낸 스크립트를 쓴다 ($MUWI_HC, $MUWI_HERDR_APP). 기록은 코어(muwi)의 모듈로 만들고 읽는다
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleHook } from 'muwi/hook';
import { setHost } from 'muwi/host';
import { SCREEN_COMMANDS } from 'muwi/kit';
import { markNode } from 'muwi/node';
import { attach, readSession, touchSession } from 'muwi/session';
import { modelIn } from 'muwi/connectors/tools';
import { appendEvent, clock, readEvents, readPlan, writePlan, type NodeStatus, type Plan, type RunBy } from 'muwi/store';
import { PAST_DAYS, loadBoard, loadView } from 'muwi/view';
import herdr from '../src/host.ts';
import { terminalName } from '../src/hc.ts';
import { closedSessions } from '../src/live.ts';

// 이 파일의 시험은 Herdr 화면을 쓴다
setHost(herdr);
/** herdr-muwi의 muwi 명령: Herdr 화면을 붙인 muwi */
const CLI = path.resolve(import.meta.dirname, '../bin/muwi.js');
/** 코어(muwi)가 깔린 곳: 세션 지침(hooks/instructions.md)이 있다 */
const CORE = path.dirname(fileURLToPath(import.meta.resolve('muwi/package.json')));
const ENV = {} as NodeJS.ProcessEnv;
const T0 = Date.parse('2026-11-22T05:00:00.000Z');
const at = (min: number) => { clock.now = () => new Date(T0 + min * 60_000); };

function setup(nodes: { id: string; after?: string[]; run?: RunBy }[], work = 'w1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-actors-'));
  at(0);
  const plan: Plan = {
    work, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    nodes: nodes.map(n => ({ id: n.id, title: n.id, after: n.after ?? [], status: 'todo' as NodeStatus, ...(n.run ? { run: n.run } : {}) })),
  };
  writePlan(dir, plan);
  appendEvent(dir, work, { type: 'plan', by: 'ai', first: true, added: plan.nodes.map(n => n.id), removed: [], changed: [] }, 'lead');
  attach(dir, 'lead', work, ENV);
  /** muwi node <id> … 가 하는 일 */
  const node = (id: string, status: NodeStatus, session: string, note?: string) => {
    assert.ok(markNode(dir, work, id, status, note, session, ENV));
    attach(dir, session, work, ENV);
  };
  /** Claude Code가 훅에 넘기는 입력을 흉내 낸다 */
  const hook = (payload: Record<string, unknown>, mode: 'record' | 'command' = 'record', session = 'lead', env: NodeJS.ProcessEnv = ENV) =>
    handleHook({ session_id: session, ...payload }, dir, mode, env, CORE);
  const sub = {
    start: (agent: string, session = 'lead') => hook({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    stop: (agent: string, session = 'lead') => hook({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    reads: (agent: string, skill: string, session = 'lead') => hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill }, agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    runs: (agent: string, command: string, session = 'lead') => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, agent_id: agent }, 'command', session),
  };
  const reads = (skill: string, session = 'lead') => hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill } }, 'record', session);
  // 빈 환경을 준다: Herdr에 물어보지 않는다 (테스트가 이 컴퓨터의 터미널 상태에 기대지 않게)
  const view = () => loadView(dir, work, ENV)!;
  const of = (id: string) => view().nodes.find(n => n.id === id)!;
  const skillsOf = (id: string) => of(id).skills.map(s => `${s.skill}:${s.state}${s.agent ? ':sub' : ''}${s.guess ? ':guess' : ''}`).sort();
  return { dir, work, node, hook, sub, reads, view, of, skillsOf };
}

test('새 세션의 터미널 이름은 노드 id에서 짓는다', () => {
  assert.equal(terminalName('Impl UI/화면'), 'impl-ui');
  assert.equal(terminalName('화면'), 'node');
  assert.equal(terminalName('a'.repeat(40)).length, 32);
});

/**
 * hc와 herdr-app을 흉내 내는 스크립트. 받은 인자를 적어 두고 정해 둔 답을 한다.
 * herdr-app은 키보드가 어느 칸에 있는지 기억한다: 칸을 새로 놓으면 그 칸으로 옮겨 가고, pane.focus로 옮긴다.
 */
function fakeHerdr(labels: Record<string, string> | null, focus = 'pUSER') {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-fake-'));
  const log = path.join(bin, 'calls.log');
  const at = path.join(bin, 'focus');
  fs.writeFileSync(at, focus);
  const get = labels ? JSON.stringify({ address: 't7', labels }) : '';
  // Node 스크립트로 쓴다. muwi는 .cjs 도구를 Node로 실행하므로 Windows에서도 돈다
  const record = `const fs = require('fs');\nconst args = process.argv.slice(2);\nconst note = (who) => fs.appendFileSync(${JSON.stringify(log)}, who + args.map(a => ' [' + a + ']').join('') + '\\n');\n`;
  fs.writeFileSync(path.join(bin, 'hc.cjs'), `${record}note('hc');
switch (args[0]) {
  case 'run': console.log('{"address":"t7","first_message":{"sent":true}}'); break;
  case 'get': ${get ? `console.log(${JSON.stringify(get)})` : 'process.exit(1)'}; break;
  case 'ls': console.log('{"terminals":[{"address":"t2","state":"live","status":"working"},{"address":"t7","state":"live","status":"working"}]}'); break;
  default: console.log('{}');
}
`);
  fs.writeFileSync(path.join(bin, 'herdr-app.cjs'), `${record}const at = ${JSON.stringify(at)};
if (args[0] === 'status') { process.stdout.write(JSON.stringify({ focused_pane: fs.readFileSync(at, 'utf8') })); process.exit(0); }
note('app');
if (args[1] === 'terminal.keep' || args[1] === 'pane.split') {
  if (fs.readFileSync(at, 'utf8')) fs.writeFileSync(at, 'pNEW');
  console.log('{"pending":true,"pane":"pNEW"}');
} else if (args[1] === 'pane.focus') {
  const pane = JSON.parse(args[2] || '{}').pane;
  if (pane) fs.writeFileSync(at, pane);
  console.log('{}');
} else console.log('{}');
`);
  return { hc: path.join(bin, 'hc.cjs'), app: path.join(bin, 'herdr-app.cjs'), calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), focus: () => fs.readFileSync(at, 'utf8') };
}

test('muwi run으로 뜬 세션은 시작할 때 맡은 작업에 붙고 노드를 시작한 것으로 적힌다', () => {
  const s = setup([{ id: 'read' }, { id: 'impl', after: ['read'], run: 'session' }]);
  const fake = fakeHerdr({ 'muwi.work': 'w1', 'muwi.node': 'impl' });
  const env = { HC_TERMINAL_ID: 't7', MUWI_HC: fake.hc, PATH: process.env.PATH } as NodeJS.ProcessEnv;
  at(3);
  const r = s.hook({ hook_event_name: 'SessionStart', source: 'startup' }, 'record', 'child', env);
  const text = JSON.parse(r.stdout!).hookSpecificOutput.additionalContext as string;
  assert.match(text, /작업 진행 방식 \(muwi\)/);
  assert.match(text, /이 세션은 작업 `w1`의 노드 `impl`\(impl\)를 맡아서 떴다/);
  assert.match(text, /muwi node impl done/);
  assert.equal(readSession(s.dir, 'child')!.work, 'w1');
  assert.equal(readSession(s.dir, 'child')!.terminal, 't7');
  assert.equal(s.of('impl').status, 'doing');
  assert.deepEqual(s.of('impl').who, { kind: 'session', session: 'child', agents: [] });
  assert.equal(s.view().sessions.child.terminal, 't7');

  // 사람을 기다리는 중에 대화가 요약돼 다시 시작해도 상태는 그대로 둔다
  at(5); s.node('impl', 'waiting', 'child');
  at(6); const again = s.hook({ hook_event_name: 'SessionStart', source: 'compact' }, 'record', 'child', env);
  assert.match(JSON.parse(again.stdout!).hookSpecificOutput.additionalContext, /노드 `impl`/);
  assert.equal(s.of('impl').status, 'waiting');

  // 그 터미널에서 /clear 하고 다른 일을 시작한 대화는 옛 노드에 다시 붙지 않는다 (라벨은 터미널에 남아 있다)
  at(7); const later = s.hook({ hook_event_name: 'SessionStart', source: 'clear' }, 'record', 'unrelated', env);
  assert.doesNotMatch(JSON.parse(later.stdout!).hookSpecificOutput.additionalContext, /이 세션이 맡은 노드/);
  assert.equal(readSession(s.dir, 'unrelated')!.work, undefined);
  assert.equal(readEvents(s.dir, s.work).filter(e => e.type === 'join').length, 1);
});

test('라벨이 없는 터미널이나 Herdr 밖의 세션은 평소처럼 시작한다', () => {
  const s = setup([{ id: 'impl' }]);
  const fake = fakeHerdr(null);
  const r = s.hook({ hook_event_name: 'SessionStart' }, 'record', 'other', { HC_TERMINAL_ID: 't9', MUWI_HC: fake.hc, PATH: process.env.PATH } as NodeJS.ProcessEnv);
  assert.doesNotMatch(JSON.parse(r.stdout!).hookSpecificOutput.additionalContext, /이 세션이 맡은 노드/);
  assert.equal(readSession(s.dir, 'other')!.work, undefined);
  assert.equal(s.of('impl').status, 'todo');
  const out = s.hook({ hook_event_name: 'SessionStart' }, 'record', 'plain', ENV);
  assert.match(JSON.parse(out.stdout!).hookSpecificOutput.additionalContext, /작업 진행 방식/);
  // 터미널에 지금 도는 세션을 붙이고(label), 맡은 노드가 있는지 본다(get). Herdr 밖의 세션은 hc를 부르지 않는다
  assert.deepEqual(fake.calls().split('\n').filter(Boolean), ['hc [label] [t9] [muwi.session=other]', 'hc [get] [t9] [--json]']);
});

function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-run-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-run-cwd-'));
  const fake = fakeHerdr({ 'muwi.work': 'shop-1', 'muwi.node': 'impl' });
  const muwi = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead', MUWI_HC: fake.hc, MUWI_HERDR_APP: fake.app, HC_TERMINAL_ID: 't2', ...env },
      cwd, encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const plan = JSON.stringify({ title: '링크 추가', nodes: [{ id: 'read', title: '읽기' }, { id: 'impl', title: '화면 구현', after: ['read'], run: 'session', show: 'pane' }, { id: 'review', title: '리뷰', after: ['impl'], run: 'subagent' }] });
  assert.equal(muwi(['plan', '--work', 'shop-1', '--request', '작업해줘', plan]).code, 0);
  return { dir, cwd, fake, muwi };
}

test('muwi run: 세션을 띄우고 노드와 터미널을 이어 적는다. 계획에 적은 자리에 놓고 포커스는 돌려놓는다', () => {
  const { dir, cwd, fake, muwi } = bench();
  const r = muwi(['run', 'impl', '목록 화면에 링크를 추가해줘']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /새 세션을 띄웠어요: impl \(t7\) → 노드 impl · pane/);
  assert.match(r.out, /hc wait --children any/);
  const calls = fake.calls();
  assert.match(calls, /hc \[run\] \[--bg\] \[--json\] \[--name\] \[impl\] \[--cwd\] \[[^\]]+\] \[--label\] \[muwi\.work=shop-1\] \[--label\] \[muwi\.node=impl\] \[--\] \[claude\] \[목록 화면에 링크를 추가해줘/);
  assert.match(calls, /노드 impl\(화면 구현\)를 맡았어요[^\]]*hc send t2/);
  assert.match(calls, /app \[do\] \[terminal\.keep\] \[\{"terminal":"t7","place":"right"\}\]/);
  // 키보드는 사람이 있던 칸으로 돌아간다. muwi를 부른 터미널(t2)로 끌어오지 않는다
  assert.equal(fake.focus(), 'pUSER');
  assert.deepEqual(calls.split('\n').filter(l => l.includes('pane.focus')), ['app [do] [pane.focus] [{"pane":"pUSER"}]']);
  assert.ok(calls.includes(`[--cwd] [${cwd}]`) || calls.includes(`[--cwd] [${fs.realpathSync(cwd)}]`));
  const spawn = readEvents(dir, 'shop-1').find(e => e.type === 'spawn')!;
  // 띄운 폴더도 남긴다 (새 세션이 기록 전에 닫혀도 어디서 이어 할지 알려 주려고)
  const { cwd: where, ...rest } = spawn as typeof spawn & { cwd?: string };
  assert.ok(where === cwd || where === fs.realpathSync(cwd), where);
  assert.deepEqual({ ...rest, at: '' }, { at: '', session: 'lead', type: 'spawn', node: 'impl', terminal: 't7', name: 'impl', show: 'pane', task: '목록 화면에 링크를 추가해줘' });
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /impl +화면 구현 +← read +\(새 세션 t7 뜨는 중\)\n +맡긴 말 \(t7\): 목록 화면에 링크를 추가해줘/);
  assert.match(shown, /review +리뷰 +← impl +\(예정: 서브에이전트\)/);
});

test('muwi run: 놓을 곳과 띄울 명령은 부르는 쪽이 고른다. 정하지 않으면 놓지 않는다', () => {
  const { fake, muwi } = bench();
  assert.equal(muwi(['run', 'review', '리뷰해줘', '--agent', 'claude --model sonnet', '--name', 'Shop Review']).code, 0);
  let calls = fake.calls();
  assert.match(calls, /\[--name\] \[shop-review\]/);
  assert.match(calls, /\[--\] \[claude\] \[리뷰해줘[^\]]*\] \[--model\] \[sonnet\]/);
  assert.doesNotMatch(calls, /terminal\.keep/);
  assert.equal(muwi(['run', 'impl', '구현해줘', '--show', 'tab']).code, 0);
  calls = fake.calls();
  assert.match(calls, /\[terminal\.keep\] \[\{"terminal":"t7","place":"tab"\}\]/);
  assert.equal(muwi(['run', 'impl', '구현해줘', '--down']).code, 0);
  assert.match(fake.calls(), /\[terminal\.keep\] \[\{"terminal":"t7","place":"down"\}\]/);
});

test('맡긴 세션은 세션 시작을 알려 주지 않는 도구에서도 붙는다: 그 세션의 첫 muwi 명령에서 맡은 노드에 붙는다', () => {
  const { muwi } = bench();
  assert.equal(muwi(['run', 'impl', '목록 화면에 링크를 추가해줘']).code, 0);
  // 맡은 세션(터미널 t7)이 훅 없이 바로 끝을 적는다. --work를 붙이지 않아도 터미널의 이름표로 맡은 작업을 안다
  const done = muwi(['node', 'impl', 'done', '링크 추가함'], { MUWI_SESSION: 'worker', HC_TERMINAL_ID: 't7' });
  assert.equal(done.code, 0, done.err);
  const node = JSON.parse(muwi(['show', 'shop-1', '--json']).out).nodes.find((n: any) => n.id === 'impl');
  assert.deepEqual([node.status, node.who.kind, node.who.session], ['done', 'session', 'worker']);
});

test('모델의 fallback: muwi run으로 띄울 때 명령에 준 모델을 그 세션의 모델로 적는다 (훅이 모델을 알려 주지 않는 도구)', () => {
  const { fake, muwi } = bench();
  // 띄우는 명령에 모델을 정해 줬다. 터미널의 이름표와 기록에 남긴다
  const r = muwi(['run', 'impl', '목록 화면에 링크를 추가해줘', '--agent', 'codex --model gpt-x']);
  assert.equal(r.code, 0, r.err);
  assert.match(fake.calls(), /\[--label\] \[muwi\.model=gpt-x\]/);
  const spawn = JSON.parse(muwi(['show', 'shop-1', '--json']).out).nodes.find((n: any) => n.id === 'impl').spawn;
  assert.equal(spawn.terminal, 't7');
  // 그 터미널에서 뜬 세션: 훅이 모델을 알려 주지 않아도 첫 muwi 명령에서 이름표의 모델을 물려받는다
  const labeled = fakeHerdr({ 'muwi.work': 'shop-1', 'muwi.node': 'impl', 'muwi.model': 'gpt-x' });
  const worker = { MUWI_SESSION: 'worker', HC_TERMINAL_ID: 't7', MUWI_HC: labeled.hc, MUWI_HERDR_APP: labeled.app };
  assert.equal(muwi(['node', 'impl', 'done', '링크 추가함'], worker).code, 0);
  const who = JSON.parse(muwi(['show', 'shop-1', '--json']).out).nodes.find((n: any) => n.id === 'impl').who;
  assert.deepEqual([who.kind, who.session, who.model], ['session', 'worker', 'gpt-x']);
  // 모델을 주는 여러 모양을 읽는다. 없으면 적지 않는다 (짐작하지 않는다)
  assert.deepEqual([modelIn(['codex', '--model', 'a']), modelIn(['gemini', '-m', 'b']), modelIn(['qwen', '--model=c']), modelIn(['claude']), modelIn(['x', '--model', '--other'])], ['a', 'b', 'c', undefined, undefined]);
});

test('muwi run: Herdr 밖이거나 없는 노드면 띄우지 않고 이유를 말한다', () => {
  const { fake, muwi } = bench();
  const outside = muwi(['run', 'impl', '구현해줘'], { HC_TERMINAL_ID: '' });
  assert.equal(outside.code, 1);
  assert.match(outside.err, /Herdr 앱의 터미널 안에서만/);
  assert.match(muwi(['run', 'nope', '해줘']).err, /없는 노드예요: nope/);
  assert.match(muwi(['run', 'impl']).err, /사용법: muwi run/);
  assert.match(muwi(['run', 'impl', '해줘', '--show', 'window']).err, /--show는 pane 또는 tab/);
  assert.equal(fake.calls(), '');
});

test('muwi tidy: 끝난 노드를 맡았던 세션만, 라벨이 맞을 때만 닫는다', () => {
  const { fake, muwi } = bench();
  assert.equal(muwi(['run', 'impl', '구현해줘']).code, 0);
  assert.match(muwi(['tidy', 'shop-1']).out, /닫을 세션이 없어요/);
  // 띄운 터미널(t7)에서 도는 세션이 끝냈다
  assert.equal(muwi(['node', 'impl', 'done', '커밋 2개', '--work', 'shop-1'], { MUWI_SESSION: 'child', HC_TERMINAL_ID: 't7' }).code, 0);
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /같이 한 쪽: 계획을 낸 세션 \S+ · 새 세션 1/);
  assert.match(shown, /impl +화면 구현 +← read +\([^)]*새 세션/);
  const r = muwi(['tidy', 'shop-1']);
  assert.match(r.out, /impl: t7 닫음/);
  assert.match(fake.calls(), /hc \[kill\] \[t7\]\nhc \[rm\] \[t7\]/);
});

/** hc ls와 hc get의 답을 정해 둔 흉내 hc. terminals: 살아 있는 터미널, owners: 터미널에 붙은 muwi.session 라벨 */
function fakeHc(terminals: { address: string; status?: string | null }[], owners: Record<string, string> = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-live-'));
  const list = JSON.stringify({ terminals: terminals.map(x => ({ address: x.address, state: 'live', status: x.status === undefined ? 'working' : x.status })) });
  const got = Object.fromEntries(Object.entries(owners).map(([addr, key]) => [addr, { address: addr, labels: { 'muwi.session': key } }]));
  fs.writeFileSync(path.join(bin, 'hc.cjs'), `const [cmd, addr] = process.argv.slice(2);
const got = ${JSON.stringify(got)};
if (cmd === 'ls') console.log(${JSON.stringify(list)});
else if (cmd === 'get') console.log(JSON.stringify(got[addr] ?? { labels: {} }));
else console.log('{}');
`);
  return { MUWI_HC: path.join(bin, 'hc.cjs'), PATH: process.env.PATH } as NodeJS.ProcessEnv;
}

test('세션이 닫혔는지는 Herdr에 물어본다: 터미널이 없거나, 에이전트가 돌지 않거나, 다른 대화가 그 터미널을 쓰고 있으면 닫힌 것', () => {
  const seenAt = '2026-11-22T05:10:00.000Z';
  const sessions = {
    gone: { terminal: 't3', seenAt },      // 터미널을 닫았다
    shell: { terminal: 't4', seenAt },     // Claude를 끝내고 셸만 남았다
    cleared: { terminal: 't5', seenAt },   // 같은 칸에서 /clear 하고 다른 대화를 시작했다
    alive: { terminal: 't6', seenAt },     // 그대로 돌고 있다
    nolabel: { terminal: 't7', seenAt },   // 라벨이 없다 (옛 판에서 시작했다). 터미널이 살아 있으면 살아 있는 것으로 본다
    unknown: { seenAt },                   // 터미널을 모른다 (Herdr 밖). 판단하지 않는다
  };
  const env = fakeHc(
    [{ address: 't4', status: null }, { address: 't5' }, { address: 't6' }, { address: 't7' }],
    { t5: 'someone-else', t6: 'alive' },
  );
  const closed = closedSessions(sessions, Object.keys(sessions), env);
  assert.deepEqual([...closed.keys()].sort(), ['cleared', 'gone', 'shell']);
  assert.equal(closed.get('gone'), Date.parse(seenAt));
  // Herdr 밖이면(hc가 없으면) 아무것도 닫혔다고 하지 않는다
  assert.equal(closedSessions(sessions, Object.keys(sessions), { MUWI_HC: '/no/such/hc' } as NodeJS.ProcessEnv).size, 0);
});

test('하던 세션이 닫힌 노드는 "세션이 닫힘"으로 보이고, 시간은 거기서 멈추고, 작업은 맨 위에서 내려온다', () => {
  const s = setup([{ id: 'impl' }, { id: 'pr', after: ['impl'] }]);
  const herdr = { HC_TERMINAL_ID: 't3' } as NodeJS.ProcessEnv;
  at(1); touchSession(s.dir, 'worker', {}, herdr); s.node('impl', 'doing', 'worker');
  at(4); touchSession(s.dir, 'worker', {}, herdr); // 세션이 마지막으로 무언가를 한 때
  at(60);
  const alive = fakeHc([{ address: 't3' }], { t3: 'worker' });
  const dead = fakeHc([]);
  // 살아 있을 때: 평소처럼 작업 중이고 시간이 계속 간다
  let v = loadView(s.dir, s.work, alive)!;
  assert.deepEqual([v.state, v.nodes[0].closed, v.nodes[0].spentMs / 60_000], ['doing', undefined, 59]);
  // 터미널을 닫았다: 상태는 그대로 두고(끝났는지 모른다) 닫혔다고만 표시한다. 시간은 마지막으로 본 때까지
  v = loadView(s.dir, s.work, dead)!;
  assert.deepEqual([v.state, v.nodes[0].status, v.nodes[0].closed, v.nodes[0].spentMs / 60_000], ['stalled', 'doing', true, 3]);
  // 닫힌 세션이 남긴 "응답 대기"는 작업을 맨 위로 올리지 않는다
  at(61); s.node('impl', 'waiting', 'worker', 'PR 올릴까요?');
  assert.equal(loadView(s.dir, s.work, alive)!.state, 'waiting');
  assert.equal(loadView(s.dir, s.work, dead)!.state, 'stalled');
  // 새 대화가 이어받으면 다시 살아난다 (같은 회차를 이어 한다)
  at(62); s.node('impl', 'doing', 'tomorrow');
  v = loadView(s.dir, s.work, dead)!;
  assert.deepEqual([v.state, v.nodes[0].closed, v.nodes[0].attempts, v.nodes[0].who!.session], ['doing', undefined, 1, 'tomorrow']);
});

test('하는 노드가 없는 작업은 그 세션이 하는 일로 보인다: 일하는 중이면 작업 중, 멈췄으면 응답 대기, 맡은 세션이 없으면 멈춤', () => {
  const s = setup([{ id: 'read' }, { id: 'impl', after: ['read'] }]);
  at(1); touchSession(s.dir, 'lead', {}, { HC_TERMINAL_ID: 't3' } as NodeJS.ProcessEnv); s.node('read', 'doing', 'lead');
  at(2); s.node('read', 'done', 'lead'); // 앞 노드를 끝냈고, 다음 노드는 아직 시작하지 않았다
  const shown = (env: NodeJS.ProcessEnv) => {
    const v = loadView(s.dir, s.work, env)!;
    return [v.state, v.between];
  };
  const herdr = (status: string) => fakeHc([{ address: 't3', status }], { t3: 'lead' });
  // 다음 노드를 준비하고 있다
  assert.deepEqual(shown(herdr('working')), ['doing', 'working']);
  // 노드를 남긴 채 멈췄다: 사람이 말해야 움직인다
  assert.deepEqual(shown(herdr('done')), ['waiting', 'stopped']);
  assert.deepEqual(shown(herdr('idle')), ['waiting', 'stopped']);
  // 입력을 기다린다 (권한 확인 같은 것)
  assert.deepEqual(shown(herdr('blocked')), ['waiting', 'asking']);
  // 세션을 닫았다
  assert.deepEqual(shown(fakeHc([])), ['stalled', 'gone']);
  // Herdr 밖이라 세션이 무얼 하는지 모른다: 작업 중으로 본다
  assert.deepEqual(shown({ MUWI_HC: '/no/such/hc' } as NodeJS.ProcessEnv), ['doing', 'unknown']);
  // 세션이 다른 작업으로 갔다: 이 작업을 맡은 세션이 없다
  attach(s.dir, 'lead', 'other', ENV);
  assert.deepEqual(shown(herdr('working')), ['stalled', 'gone']);
  // 노드를 하는 중이면 between은 없다 (세션이 멈췄을 때는 아래 시험의 quiet로 정한다)
  at(3); s.node('impl', 'doing', 'lead');
  const v = loadView(s.dir, s.work, herdr('working'))!;
  assert.deepEqual([v.state, v.between], ['doing', undefined]);
});

test('하는 중이라고 적힌 노드도 그 세션이 일을 멈췄으면 멈춘 것으로 보인다: 입력을 기다리거나 멈췄으면 응답 대기', () => {
  const s = setup([{ id: 'a' }, { id: 'b' }]);
  at(1); touchSession(s.dir, 'lead', {}, { HC_TERMINAL_ID: 't3' } as NodeJS.ProcessEnv); s.node('a', 'doing', 'lead');
  const shown = (env: NodeJS.ProcessEnv) => {
    const v = loadView(s.dir, s.work, env)!;
    return [v.state, v.quiet, ...v.nodes.map(n => n.quiet)];
  };
  const one = (status: string) => fakeHc([{ address: 't3', status }], { t3: 'lead' });
  assert.deepEqual(shown(one('working')), ['doing', undefined, undefined, undefined]);
  // 사용 한도에 걸렸거나 권한 확인에서 멈췄다
  assert.deepEqual(shown(one('blocked')), ['waiting', 'asking', 'asking', undefined]);
  // 노드를 끝냈다고 적지 않은 채 말을 끝냈다
  assert.deepEqual(shown(one('done')), ['waiting', 'stopped', 'stopped', undefined]);
  assert.deepEqual(shown(one('idle')), ['waiting', 'stopped', 'stopped', undefined]);
  // Herdr 밖이라 세션이 무얼 하는지 모르면 적힌 대로 작업 중이다
  assert.deepEqual(shown({ MUWI_HC: '/no/such/hc' } as NodeJS.ProcessEnv), ['doing', undefined, undefined, undefined]);
  // 세션이 닫혔으면 멈춘 것이 아니라 닫힌 것이다
  const gone = loadView(s.dir, s.work, fakeHc([]))!;
  assert.deepEqual([gone.state, gone.quiet, gone.nodes[0].closed, gone.nodes[0].quiet], ['stalled', undefined, true, undefined]);

  // 다른 세션이 하는 노드가 하나라도 일하고 있으면 작업은 작업 중이다. 멈춘 노드만 멈춘 것으로 보인다
  at(2); touchSession(s.dir, 'worker', {}, { HC_TERMINAL_ID: 't4' } as NodeJS.ProcessEnv); s.node('b', 'doing', 'worker');
  const two = (a: string, b: string) => fakeHc([{ address: 't3', status: a }, { address: 't4', status: b }], { t3: 'lead', t4: 'worker' });
  assert.deepEqual(shown(two('done', 'working')), ['doing', undefined, 'stopped', undefined]);
  // 둘 다 멈췄고 하나가 입력을 기다린다
  assert.deepEqual(shown(two('done', 'blocked')), ['waiting', 'asking', 'stopped', 'asking']);

  // 목록에도 같은 것이 나간다. 그래프 칸이 지금 상태를 다시 볼 수 있게 그 세션의 터미널도 준다
  const board = loadBoard(s.dir, two('done', 'blocked')).works.find(w => w.work === s.work)!;
  assert.deepEqual([board.state, board.quiet], ['waiting', 'asking']);
  assert.deepEqual(board.active.map(n => [n.id, n.quiet, n.terminal]), [['a', 'stopped', 't3'], ['b', 'asking', 't4']]);

  // AI가 기다린다고 적은 노드가 있으면 그것으로 응답 대기다 (quiet가 아니다)
  at(3); s.node('b', 'waiting', 'worker', '어느 쪽으로 할까요');
  assert.deepEqual(shown(two('working', 'done')), ['waiting', undefined, undefined, undefined]);
});

test('세션이 시작될 때 터미널에 그 세션의 이름을 붙인다', () => {
  const s = setup([{ id: 'impl' }]);
  const fake = fakeHerdr(null);
  s.hook({ hook_event_name: 'SessionStart', source: 'startup' }, 'record', 'conv-1', { HC_TERMINAL_ID: 't4', MUWI_HC: fake.hc, PATH: process.env.PATH } as NodeJS.ProcessEnv);
  assert.match(fake.calls(), /^hc \[label\] \[t4\] \[muwi\.session=conv-1\]$/m);
});

test('지난 작업: 끝났거나 멈춘 채로 오래된 작업은 접는다. 살아 있는 세션이 하는 작업은 오래돼도 접지 않는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-past-'));
  const herdr = (t: string) => ({ HC_TERMINAL_ID: t }) as NodeJS.ProcessEnv;
  const make = (work: string, session: string, terminal: string, done: boolean) => {
    const plan: Plan = { work, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), nodes: [{ id: 'n', title: 'n', after: [], status: 'todo' }] };
    writePlan(dir, plan);
    touchSession(dir, session, {}, herdr(terminal));
    markNode(dir, work, 'n', 'doing', undefined, session, ENV);
    // 끝난 작업은 사람이 본 것으로 둔다 (안 본 결과는 "새 결과"라 접지 않는다. 그건 record.test.ts에서 본다)
    if (done) markNode(dir, work, 'n', 'done', undefined, session, ENV), appendEvent(dir, work, { type: 'viewed' }, null);
  };
  at(0);
  make('old-done', 's1', 't1', true);
  make('old-stalled', 's2', 't2', false);   // 하던 세션을 닫아 버렸다
  make('old-live', 's3', 't3', false);      // 오래됐지만 아직 돌고 있다
  const env = fakeHc([{ address: 't3' }, { address: 't4' }], { t3: 's3', t4: 's4' });
  at(60 * 24 * (PAST_DAYS + 1));
  make('new-done', 's4', 't4', true);
  const board = loadBoard(dir, env);
  assert.deepEqual(board.works.map(w => `${w.work}:${w.state}:${w.past ? '지난' : '지금'}`), [
    'old-live:doing:지금', 'old-stalled:stalled:지난', 'new-done:done:지금', 'old-done:done:지난',
  ]);
  assert.deepEqual(board.works.find(w => w.work === 'old-stalled')!.active, [{ id: 'n', title: 'n', status: 'doing', closed: true }]);
  // muwi status는 지난 작업을 접어 두고, --all이면 다 보여 준다
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_HC: env.MUWI_HC! } });
  // (명령은 지금 시각으로 본다: 방금 만든 작업들은 모두 "지금"이다)
  assert.match(run(['status']).stdout, /멈춤 +old-stalled[^\n]*\n +● n +n \(세션이 닫힘\)/);
  assert.doesNotMatch(run(['status']).stdout, /지난 작업/);
});

test('코어가 아는 화면 명령의 이름(코어만 깐 사람에게 herdr-muwi에 있다고 알려 준다)과 Herdr 화면이 더하는 명령이 같다', () => {
  assert.deepEqual(Object.keys(herdr.commands ?? {}).sort(), [...SCREEN_COMMANDS].sort());
});
