// 노드를 누가 했는지(계획을 낸 세션, 새 세션, 서브에이전트)를 기록에서 알아내는 부분과, 새 세션을 띄우는 muwi run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleHook, nodeStartIn } from '../src/hook.ts';
import { terminalName } from '../src/herdr.ts';
import { parsePlan, diffPlan, carryStatus, addNode } from '../src/plan.ts';
import { attach, readSession } from '../src/session.ts';
import { appendEvent, clock, readEvents, readPlan, writePlan, type NodeStatus, type Plan, type RunBy } from '../src/store.ts';
import { loadView } from '../src/view.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
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
  const node = (id: string, status: NodeStatus, session: string) => {
    const p = readPlan(dir, work)!;
    p.nodes.find(x => x.id === id)!.status = status;
    writePlan(dir, p);
    appendEvent(dir, work, { type: 'node', node: id, status }, session);
    attach(dir, session, work, ENV);
  };
  /** Claude Code가 훅에 넘기는 입력을 흉내 낸다 */
  const hook = (payload: Record<string, unknown>, mode: 'record' | 'guard' | 'nudge' = 'record', session = 'lead', env: NodeJS.ProcessEnv = ENV) =>
    handleHook({ session_id: session, ...payload }, dir, mode, env, path.resolve(import.meta.dirname, '..'));
  const sub = {
    start: (agent: string, session = 'lead') => hook({ hook_event_name: 'SubagentStart', agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    stop: (agent: string, session = 'lead') => hook({ hook_event_name: 'SubagentStop', agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    reads: (agent: string, skill: string, session = 'lead') => hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill }, agent_id: agent, agent_type: 'general-purpose' }, 'record', session),
    runs: (agent: string, command: string, session = 'lead') => hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, agent_id: agent }, 'guard', session),
  };
  const reads = (skill: string, session = 'lead') => hook({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill } }, 'record', session);
  const view = () => loadView(dir, work)!;
  const of = (id: string) => view().nodes.find(n => n.id === id)!;
  const skillsOf = (id: string) => of(id).skills.map(s => `${s.skill}:${s.state}${s.agent ? ':sub' : ''}`).sort();
  return { dir, work, node, hook, sub, reads, view, of, skillsOf };
}

test('계획: 누가 할지(run)와 어디에 보여 줄지(show)는 적어도 되고 안 적어도 된다', () => {
  const ok = parsePlan({ nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', after: ['a'], run: 'subagent' }, { id: 'c', title: 'C', run: 'session', show: 'pane' }] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.plan!.nodes.map(n => [n.id, n.run, n.show]), [['a', undefined, undefined], ['b', 'subagent', undefined], ['c', 'session', 'pane']]);
  assert.match(parsePlan({ nodes: [{ id: 'a', title: 'A', run: 'worker' }] }).problems.join('\n'), /run은 me, subagent, session 중 하나/);
  assert.match(parsePlan({ nodes: [{ id: 'a', title: 'A', run: 'subagent', show: 'pane' }] }).problems.join('\n'), /show는 run이 session일 때만/);
  assert.match(parsePlan({ nodes: [{ id: 'a', title: 'A', run: 'session', show: 'window' }] }).problems.join('\n'), /show는 pane, tab 중 하나/);
});

test('계획: 누가 할지를 바꾸면 바뀐 노드로 잡히고, 상태를 이어도 run과 show는 새 계획을 따른다', () => {
  const old = carryStatus([], [{ id: 'a', title: 'A', after: [] }, { id: 'b', title: 'B', after: ['a'], run: 'subagent' }]);
  old[1].status = 'doing';
  const next = [{ id: 'a', title: 'A', after: [] as string[] }, { id: 'b', title: 'B', after: ['a'], run: 'session' as const, show: 'tab' as const }];
  assert.deepEqual(diffPlan(old, next), { added: [], removed: [], changed: ['b'] });
  assert.deepEqual(carryStatus(old, next)[1], { id: 'b', title: 'B', after: ['a'], run: 'session', show: 'tab', status: 'doing' });
  const plan = { work: 'w', createdAt: '', updatedAt: '', nodes: old } as Plan;
  assert.deepEqual(addNode(plan, { id: 'c', title: 'C', after: ['b'], run: 'me' }).nodes.map(n => n.run), [undefined, 'subagent', 'me']);
});

test('서브에이전트가 읽은 skill은 그 노드에 "서브에이전트가 읽음"으로 붙고, 세션이 읽어 둔 것으로 치지 않는다', () => {
  const s = setup([{ id: 'impl' }, { id: 'review', after: ['impl'], run: 'subagent' }, { id: 'pr', after: ['review'] }]);
  at(1); s.reads('team-rules');
  at(2); s.node('impl', 'doing', 'lead');
  at(5); s.node('impl', 'done', 'lead');
  at(6); s.node('review', 'doing', 'lead');
  at(7); s.sub.start('ag1');
  at(8); s.sub.reads('ag1', 'team-review');
  at(9); s.sub.stop('ag1');
  at(10); s.node('review', 'done', 'lead');
  at(11); s.node('pr', 'doing', 'lead');

  assert.deepEqual(s.of('review').who, { kind: 'subagent', session: 'lead', agents: [{ id: 'ag1', kind: 'general-purpose' }] });
  // 서브에이전트는 빈 상태에서 시작한다: 리드가 앞에서 읽은 team-rules를 "이미 읽은 상태"로 붙이지 않는다
  assert.deepEqual(s.skillsOf('review'), ['team-review:read:sub']);
  // 서브에이전트가 읽은 내용은 리드에 남지 않는다: 다음 노드에 "이미 읽은 상태"로 넘어가지 않는다
  assert.deepEqual(s.skillsOf('pr'), ['team-rules:loaded']);
  assert.equal(readSession(s.dir, 'lead')!.loaded['team-review'], undefined);
  assert.deepEqual(s.of('impl').who, { kind: 'me', session: 'lead', agents: [] });
  assert.equal(s.of('review').offPlan, undefined);
  assert.deepEqual(s.view().helpers, { sessions: 0, subagents: 1 });
  assert.equal(s.view().lead, 'lead');
  const skill = readEvents(s.dir, s.work).find(e => e.type === 'skill' && e.skill === 'team-review')!;
  assert.equal((skill as any).agent, 'ag1');
});

test('서브에이전트가 노드를 직접 시작하면 그 노드에 묶인다 (리드가 다른 노드를 하고 있어도)', () => {
  const s = setup([{ id: 'main' }, { id: 'ra' }, { id: 'rb' }]);
  at(1); s.node('main', 'doing', 'lead');
  at(2); s.sub.start('ag1'); s.sub.start('ag2');
  // 훅은 명령이 실행되기 전에 불린다: 누가 실행하는지는 여기서만 알 수 있다
  at(3); s.sub.runs('ag1', 'muwi node ra start'); s.node('ra', 'doing', 'lead');
  at(3); s.sub.runs('ag2', 'cd /repo && muwi start rb --work w1'); s.node('rb', 'doing', 'lead');
  at(4); s.sub.reads('ag1', 'skill-a'); s.sub.reads('ag2', 'skill-b');
  at(5); s.reads('skill-lead');
  assert.deepEqual(s.of('ra').who!.agents.map(a => a.id), ['ag1']);
  assert.deepEqual(s.of('rb').who!.agents.map(a => a.id), ['ag2']);
  assert.deepEqual(s.skillsOf('ra'), ['skill-a:read:sub']);
  assert.deepEqual(s.skillsOf('rb'), ['skill-b:read:sub']);
  assert.equal(s.of('main').who!.kind, 'me');
  // 리드가 읽은 것은 리드가 하던 노드에 붙는다. 서브에이전트가 시작한 노드는 세션 id가 같아도 리드의 것이 아니다
  assert.deepEqual(s.skillsOf('main'), ['skill-lead:read']);
});

test('서브에이전트가 노드를 직접 시작하지 않았으면: 서브에이전트로 하기로 한 노드 > 아직 붙지 않은 노드 > 늦게 시작한 노드', () => {
  const s = setup([{ id: 'a' }, { id: 'b', run: 'subagent' }, { id: 'c', run: 'subagent' }]);
  at(1); s.node('a', 'doing', 'lead'); s.node('b', 'doing', 'lead'); s.node('c', 'doing', 'lead');
  at(2); s.sub.start('ag1'); s.sub.start('ag2');
  const got = ['a', 'b', 'c'].map(id => s.of(id).who!.agents.length);
  assert.deepEqual(got, [0, 1, 1]);
  // 어느 노드도 하고 있지 않을 때 뜬 서브에이전트가 읽은 것은 노드 밖으로 모인다
  const t = setup([{ id: 'a' }]);
  at(1); t.sub.start('x1'); t.sub.reads('x1', 'explore');
  assert.deepEqual(t.view().outside.map(o => [o.skill, o.agent]), [['explore', true]]);
});

test('다른 세션이 한 노드는 "새 세션"으로 보이고, 계획과 다르게 끝난 노드는 표시된다', () => {
  const s = setup([{ id: 'a', run: 'session' }, { id: 'b', run: 'session' }, { id: 'c', run: 'subagent' }]);
  at(1); s.node('a', 'doing', 'child'); s.reads('react-quality', 'child');
  at(2); s.node('a', 'done', 'child');
  at(3); s.node('b', 'doing', 'lead');
  // 하는 중에는 계획과 달랐는지 따지지 않는다
  assert.equal(s.of('b').offPlan, undefined);
  at(4); s.node('b', 'done', 'lead');
  at(5); s.node('c', 'doing', 'lead'); s.sub.start('ag1');
  at(6); s.node('c', 'done', 'lead');
  assert.equal(s.of('a').who!.kind, 'session');
  assert.equal(s.of('a').who!.session, 'child');
  assert.equal(s.of('a').offPlan, undefined);
  assert.deepEqual(s.skillsOf('a'), ['react-quality:read']);
  assert.equal(s.of('b').who!.kind, 'me');
  assert.equal(s.of('b').offPlan, true);
  assert.equal(s.of('c').offPlan, undefined);
  assert.deepEqual(s.view().helpers, { sessions: 1, subagents: 1 });
});

test('명령에서 노드 시작을 읽는다', () => {
  assert.deepEqual(nodeStartIn('muwi node review start'), { node: 'review' });
  assert.deepEqual(nodeStartIn('cd x && /p/bin/muwi node "r-1" start --work shop-1 && ls'), { node: 'r-1', work: 'shop-1' });
  assert.deepEqual(nodeStartIn('muwi start impl --work=w2'), { node: 'impl', work: 'w2' });
  assert.equal(nodeStartIn('muwi node review done "ok"'), null);
  assert.equal(nodeStartIn('echo "muwi node x started"'), null);
  assert.equal(nodeStartIn('mymuwi node x start'), null);
  assert.equal(terminalName('Impl UI/화면'), 'impl-ui');
  assert.equal(terminalName('화면'), 'node');
  assert.equal(terminalName('a'.repeat(40)).length, 32);
});

/** hc와 herdr-app을 흉내 내는 스크립트. 받은 인자를 적어 두고 정해 둔 답을 한다 */
function fakeHerdr(labels: Record<string, string> | null) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-fake-'));
  const log = path.join(bin, 'calls.log');
  const get = labels ? JSON.stringify({ address: 't7', labels }) : '';
  fs.writeFileSync(path.join(bin, 'hc'), `#!/bin/sh\nprintf 'hc' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"\ncase "$1" in\n  run) echo '{"address":"t7","first_message":{"sent":true}}' ;;\n  get) ${get ? `echo '${get}'` : 'exit 1'} ;;\n  *) echo '{}' ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr-app'), `#!/bin/sh\nprintf 'app' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"\necho '{}'\n`, { mode: 0o755 });
  return { hc: path.join(bin, 'hc'), app: path.join(bin, 'herdr-app'), calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
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
  // 붙은 세션은 계획 없이 파일을 고친다는 알림을 받지 않는다
  assert.equal(s.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' } }, 'nudge', 'child', env).stdout, undefined);

  // 사람을 기다리는 중에 대화가 요약돼 다시 시작해도 상태는 그대로 둔다
  at(5); s.node('impl', 'waiting', 'child');
  at(6); const again = s.hook({ hook_event_name: 'SessionStart', source: 'compact' }, 'record', 'child', env);
  assert.match(JSON.parse(again.stdout!).hookSpecificOutput.additionalContext, /노드 `impl`/);
  assert.equal(s.of('impl').status, 'waiting');
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
  assert.equal(fake.calls().split('\n').filter(Boolean).length, 1);
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
  assert.match(calls, /app \[do\] \[terminal\.keep\] \[\{"terminal":"t7","place":"right"\}\]\napp \[do\] \[pane\.focus\] \[\{"terminal":"t2"\}\]/);
  assert.ok(calls.includes(`[--cwd] [${cwd}]`) || calls.includes(`[--cwd] [${fs.realpathSync(cwd)}]`));
  const spawn = readEvents(dir, 'shop-1').find(e => e.type === 'spawn')!;
  assert.deepEqual({ ...spawn, at: '' }, { at: '', session: 'lead', type: 'spawn', node: 'impl', terminal: 't7', name: 'impl', show: 'pane' });
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /impl +화면 구현 +← read +\(새 세션 t7 뜨는 중\)/);
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
  assert.equal(muwi(['node', 'impl', 'done', '커밋 2개'], { MUWI_SESSION: 'child' }).code, 0);
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /같이 한 쪽: 계획을 낸 세션 \S+ · 새 세션 1/);
  assert.match(shown, /impl +화면 구현 +← read +\([^)]*새 세션/);
  const r = muwi(['tidy', 'shop-1']);
  assert.match(r.out, /impl: t7 닫음/);
  assert.match(fake.calls(), /hc \[kill\] \[t7\]\nhc \[rm\] \[t7\]/);
});

test('hook.sh: 서브에이전트의 시작·끝과 서브에이전트가 실행한 muwi 명령을 넘긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-hooksh-'));
  const sh = path.resolve(import.meta.dirname, '../hooks/hook.sh');
  const run = (payload: object, mode: string[] = []) =>
    spawnSync('sh', [sh, ...mode], { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: '' } });
  const plan: Plan = { work: 'w1', createdAt: '', updatedAt: '', nodes: [{ id: 'rev', title: '리뷰', after: [], status: 'doing' }] };
  writePlan(dir, plan);
  clock.now = () => new Date();
  appendEvent(dir, 'w1', { type: 'node', node: 'rev', status: 'doing' }, 's1');
  attach(dir, 's1', 'w1', {} as NodeJS.ProcessEnv);
  run({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag9', agent_type: 'Explore' });
  run({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'muwi node rev start' }, agent_id: 'ag9' }, ['guard']);
  run({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls -la' }, agent_id: 'ag9' }, ['guard']);
  run({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x/skills/team-rules/SKILL.md' }, agent_id: 'ag9' });
  run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'ag9', agent_type: 'Explore' });
  const events = readEvents(dir, 'w1').filter(e => e.type === 'agent' || e.type === 'skill').map(e => (e.type === 'agent' ? `${e.what}:${e.agent}:${e.node ?? e.kind ?? ''}` : `skill:${(e as any).skill}:${(e as any).agent}`));
  assert.deepEqual(events, ['start:ag9:Explore', 'bind:ag9:rev', 'skill:team-rules:ag9', 'stop:ag9:Explore']);
});

test('Node가 낮으면 무엇이 필요한지 알린다 (조용히 실패하지 않는다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-node-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-oldnode-'));
  // 22.14인 척하는 node: TypeScript 파일을 실행하지 못한다
  fs.writeFileSync(path.join(old, 'node'), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.14.0; exit 0; fi\necho "ERR_UNKNOWN_FILE_EXTENSION" >&2\nexit 1\n', { mode: 0o755 });
  const env = (p: string) => ({ PATH: p, HOME: dir, MUWI_DIR: dir });
  const bin = path.resolve(import.meta.dirname, '../bin/muwi');
  const stale = spawnSync('/bin/sh', [bin, '--version'], { encoding: 'utf8', env: env(`${old}:/usr/bin:/bin`) });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /muwi: Node 24 이상이 필요해요 \(지금: v22\.14\.0\)/);
  const good = spawnSync('/bin/sh', [bin, '--version'], { encoding: 'utf8', env: env(`${path.dirname(process.execPath)}:/usr/bin:/bin`) });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(good.stderr, '');
  // 기록 폴더에 node 경로 같은 것을 남기지 않는다
  assert.deepEqual(fs.readdirSync(dir), []);

  // 훅은 실패해도 세션을 방해하지 않으므로, 세션이 시작될 때 한 번 알려 준다
  const sh = path.resolve(import.meta.dirname, '../hooks/hook.sh');
  const start = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' });
  const told = spawnSync('sh', [sh], { input: start, encoding: 'utf8', env: env(`${old}:/usr/bin:/bin`) });
  assert.equal(told.status, 0);
  const note = JSON.parse(told.stdout).hookSpecificOutput;
  assert.equal(note.hookEventName, 'SessionStart');
  assert.match(note.additionalContext, /Node가 v22\.14\.0라서 muwi가 동작하지 않는다\. Node 24 이상이 필요하다/);
  const fine = spawnSync('sh', [sh], { input: start, encoding: 'utf8', env: env(`${path.dirname(process.execPath)}:/usr/bin:/bin`) });
  assert.match(JSON.parse(fine.stdout).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
});
