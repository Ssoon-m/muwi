// 노드를 누가 했는지(계획을 낸 세션, 새 세션, 서브에이전트)를 기록에서 알아내는 부분과, 새 세션을 띄우는 muwi run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleHook, nodeStartIn } from '../src/hook.ts';
import { markNode } from '../src/node.ts';
import { terminalName } from '../src/herdr.ts';
import { parsePlan, diffPlan, carryStatus, addNode } from '../src/plan.ts';
import { closedSessions } from '../src/live.ts';
import { attach, readSession, touchSession } from '../src/session.ts';
import { appendEvent, clock, readEvents, readPlan, writePlan, type NodeStatus, type Plan, type RunBy } from '../src/store.ts';
import { PAST_DAYS, loadBoard, loadView } from '../src/view.ts';

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
  /** muwi node <id> … 가 하는 일 */
  const node = (id: string, status: NodeStatus, session: string, note?: string) => {
    assert.ok(markNode(dir, work, id, status, note, session, ENV));
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
  // 빈 환경을 준다: Herdr에 물어보지 않는다 (테스트가 이 컴퓨터의 터미널 상태에 기대지 않게)
  const view = () => loadView(dir, work, ENV)!;
  const of = (id: string) => view().nodes.find(n => n.id === id)!;
  const skillsOf = (id: string) => of(id).skills.map(s => `${s.skill}:${s.state}${s.agent ? ':sub' : ''}${s.guess ? ':guess' : ''}`).sort();
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
  assert.deepEqual(s.of('ra').who, { kind: 'subagent', session: 'lead', agents: [{ id: 'ag1', kind: 'general-purpose', own: true }] });
  assert.deepEqual(s.of('rb').who!.agents.map(a => `${a.id}:${a.own}`), ['ag2:true']);
  // 노드 시작 줄에 누가 시작했는지가 적힌다. 나중에 짐작하지 않는다
  assert.deepEqual(readEvents(s.dir, s.work).filter(e => e.type === 'node' && e.status === 'doing').map(e => [(e as any).node, (e as any).agent, (e as any).attempt]), [['main', undefined, 1], ['ra', 'ag1', 1], ['rb', 'ag2', 1]]);
  assert.deepEqual(s.skillsOf('ra'), ['skill-a:read:sub']);
  assert.deepEqual(s.skillsOf('rb'), ['skill-b:read:sub']);
  // 자기 노드를 시작한 서브에이전트는 띄운 세션의 노드를 도운 것으로 치지 않는다
  assert.deepEqual(s.of('main').who, { kind: 'me', session: 'lead', agents: [] });
  // 리드가 읽은 것은 리드가 하던 노드에 붙는다. 서브에이전트가 시작한 노드는 세션 id가 같아도 리드의 것이 아니다
  assert.deepEqual(s.skillsOf('main'), ['skill-lead:read']);
});

test('세션이 직접 하는 노드에서 서브에이전트가 잠깐 떠도 노드의 주인은 바뀌지 않는다', () => {
  const s = setup([{ id: 'branch', run: 'me' }]);
  at(1); s.reads('branch-rule');
  at(2); s.node('branch', 'doing', 'lead');
  // Claude Code가 파일을 찾으려고 조사용 서브에이전트를 띄웠다
  at(3); s.hook({ hook_event_name: 'SubagentStart', agent_id: 'ex1', agent_type: 'Explore' });
  at(4); s.hook({ hook_event_name: 'SubagentStop', agent_id: 'ex1', agent_type: 'Explore' });
  at(5); s.node('branch', 'done', 'lead', 'feature/x 만듦');
  assert.deepEqual(s.of('branch').who, { kind: 'me', session: 'lead', agents: [{ id: 'ex1', kind: 'Explore' }] });
  // 세션이 읽어 둔 skill이 그대로 보인다. "skill 없이 일했다"로 읽히지 않는다
  assert.deepEqual(s.skillsOf('branch'), ['branch-rule:loaded']);
  assert.equal(s.of('branch').offPlan, undefined);
  // 뜬 순간에 어느 노드였는지가 사건에 적혀 있다
  const start = readEvents(s.dir, s.work).find(e => e.type === 'agent' && e.what === 'start')!;
  assert.deepEqual([(start as any).node, (start as any).attempt, (start as any).guess], ['branch', 1, undefined]);
});

test('같은 쪽이 노드 여러 개를 동시에 하고 있으면 가장 늦게 시작한 노드에 적고, 확실하지 않다고 표시한다', () => {
  const s = setup([{ id: 'a' }, { id: 'b' }]);
  at(1); s.node('a', 'doing', 'lead');
  at(2); s.node('b', 'doing', 'lead');
  at(3); s.reads('team-rules');
  assert.deepEqual(s.skillsOf('b'), ['team-rules:read:guess']);
  assert.deepEqual(s.skillsOf('a'), []);
  at(4); s.node('b', 'done', 'lead');
  at(5); s.reads('team-rules');
  // 하나만 남으면 확실하다
  assert.deepEqual(s.skillsOf('a'), ['team-rules:read']);
  // 어느 노드도 하고 있지 않을 때 뜬 서브에이전트가 읽은 것은 노드 밖으로 모인다
  const t = setup([{ id: 'a' }]);
  at(1); t.sub.start('x1'); t.sub.reads('x1', 'explore');
  assert.deepEqual(t.view().outside.map(o => [o.skill, o.agent]), [['explore', true]]);
});

test('다시 한 노드는 회차별로 남는다. 처음에 skill 없이 한 사실이 다시 한 기록에 덮이지 않는다', () => {
  const s = setup([{ id: 'branch' }, { id: 'review', after: ['branch'] }]);
  at(1); s.reads('muwi');
  at(2); s.node('branch', 'doing', 'lead');
  at(5); s.node('branch', 'done', 'lead', 'feature/x');
  at(6); s.node('review', 'doing', 'lead');
  at(7); s.reads('branch-rule'); // 리뷰에서 걸려서 그제야 읽음
  at(8); s.node('review', 'done', 'lead', '브랜치 이름이 규칙과 다름');
  at(9); s.node('branch', 'doing', 'lead');
  at(12); s.node('branch', 'done', 'lead', 'feature/PROJ-123');
  const b = s.of('branch');
  assert.equal(b.attempts, 2);
  const row = (t: (typeof b.tries)[number]) => [t.n, t.note, t.skills.map(k => `${k.skill}:${k.state}`).sort().join(','), t.seen, t.instant];
  assert.deepEqual(b.tries.map(row), [
    [1, 'feature/x', 'muwi:loaded', true, false],
    [2, 'feature/PROJ-123', 'branch-rule:loaded,muwi:loaded', true, false],
  ]);
  // 카드에는 가장 최근 회차가 나온다
  assert.equal(b.note, 'feature/PROJ-123');
  assert.deepEqual(s.skillsOf('review'), ['branch-rule:read', 'muwi:loaded']);
});

test('시작과 끝을 한꺼번에 적은 노드, 훅이 보지 못한 세션은 그렇게 표시된다 ("없음"과 구분한다)', () => {
  const s = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  at(1); s.reads('team-rules');
  // 일을 다 하고 시작과 끝을 연달아 적었다
  at(2); s.node('a', 'doing', 'lead'); s.node('a', 'done', 'lead', '끝');
  assert.deepEqual([s.of('a').instant, s.of('a').seen], [true, true]);
  // 시작을 적지 않고 끝만 적었다
  at(3); s.node('b', 'done', 'lead', '끝');
  assert.equal(s.of('b').instant, true);
  assert.equal(s.of('b').who!.session, 'lead');
  // 훅이 한 번도 돌지 않은 세션 (다른 도구, 훅이 꺼진 환경)
  at(4); s.node('c', 'doing', 'no-hooks');
  at(9); s.node('c', 'done', 'no-hooks');
  assert.deepEqual([s.of('c').seen, s.of('c').instant, s.of('c').skills.length], [false, false, 0]);
});

test('muwi run으로 뜬 세션만 "새 세션"이다. 이어서 하는 다른 대화는 직접 한 것으로 본다', () => {
  const s = setup([{ id: 'a', run: 'session' }, { id: 'b', run: 'me' }, { id: 'c', run: 'session' }, { id: 'd', run: 'subagent' }]);
  // muwi run으로 뜬 세션: 붙을 때 기록이 남는다
  appendEvent(s.dir, s.work, { type: 'join', node: 'a', terminal: 't7' }, 'child');
  at(1); s.node('a', 'doing', 'child'); s.reads('react-quality', 'child');
  at(2); s.node('a', 'done', 'child');
  // 다음 날 새 대화가 이어서 한다 (/clear 뒤도 같다)
  at(3); s.node('b', 'doing', 'tomorrow');
  at(4); s.node('b', 'done', 'tomorrow');
  // 새 세션으로 하기로 한 노드를 대화가 직접 했다
  at(5); s.node('c', 'doing', 'lead');
  assert.equal(s.of('c').offPlan, undefined); // 하는 중에는 따지지 않는다
  at(6); s.node('c', 'done', 'lead');
  // 서브에이전트로 하기로 한 노드: 세션이 시작해 두고 서브에이전트를 띄웠다
  at(7); s.node('d', 'doing', 'lead'); s.sub.start('ag1');
  at(8); s.node('d', 'done', 'lead');
  assert.deepEqual([s.of('a').who!.kind, s.of('a').who!.session, s.of('a').offPlan], ['session', 'child', undefined]);
  assert.deepEqual(s.skillsOf('a'), ['react-quality:read']);
  assert.deepEqual([s.of('b').who!.kind, s.of('b').offPlan], ['me', undefined]);
  assert.deepEqual([s.of('c').who!.kind, s.of('c').offPlan], ['me', true]);
  assert.deepEqual([s.of('d').who!.kind, s.of('d').offPlan], ['subagent', undefined]);
  assert.deepEqual(s.view().helpers, { sessions: 1, subagents: 1 });
});

test('세션이 시작해 둔 노드를 새 세션이 넘겨받으면 같은 회차이고, 넘겨준 세션이 읽은 skill은 붙지 않는다', () => {
  const s = setup([{ id: 'impl', run: 'session' }]);
  at(1); s.reads('branch-rule');
  at(2); s.node('impl', 'doing', 'lead');
  appendEvent(s.dir, s.work, { type: 'join', node: 'impl', terminal: 't7' }, 'child');
  at(3); s.node('impl', 'doing', 'child');
  at(4); s.reads('react-quality', 'child');
  // 넘겨준 세션이 그 뒤에 읽은 것은 이 노드의 것이 아니다 (지금 하고 있는 쪽은 새 세션이다)
  at(5); s.reads('team-rules');
  at(9); s.node('impl', 'done', 'child', '커밋 2개');
  const n = s.of('impl');
  assert.equal(n.attempts, 1);
  assert.deepEqual([n.who!.kind, n.who!.session], ['session', 'child']);
  assert.deepEqual(s.skillsOf('impl'), ['react-quality:read']);
  assert.deepEqual(s.view().outside.map(o => o.skill), ['branch-rule', 'team-rules']);
  assert.equal(n.spentMs, 7 * 60_000);
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
  fs.writeFileSync(path.join(bin, 'hc'), `#!/bin/sh\nprintf 'hc' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"\ncase "$1" in\n  run) echo '{"address":"t7","first_message":{"sent":true}}' ;;\n  get) ${get ? `echo '${get}'` : 'exit 1'} ;;\n  ls) echo '{"terminals":[{"address":"t2","state":"live","status":"working"},{"address":"t7","state":"live","status":"working"}]}' ;;\n  *) echo '{}' ;;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr-app'), `#!/bin/sh
if [ "$1" = status ]; then printf '{"focused_pane":"%s"}' "$(cat "${at}")"; exit 0; fi
printf 'app' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"
case "$2" in
  terminal.keep | pane.split) [ -n "$(cat "${at}")" ] && printf pNEW > "${at}"; echo '{"pending":true,"pane":"pNEW"}' ;;
  pane.focus) p=$(printf '%s' "$3" | sed -n 's/.*"pane":"\\([^"]*\\)".*/\\1/p'); [ -n "$p" ] && printf '%s' "$p" > "${at}"; echo '{}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
  return { hc: path.join(bin, 'hc'), app: path.join(bin, 'herdr-app'), calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), focus: () => fs.readFileSync(at, 'utf8') };
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

  // 그 터미널에서 /clear 하고 다른 일을 시작한 대화는 옛 노드에 다시 붙지 않는다 (라벨은 터미널에 남아 있다)
  at(7); const later = s.hook({ hook_event_name: 'SessionStart', source: 'clear' }, 'record', 'unrelated', env);
  assert.doesNotMatch(JSON.parse(later.stdout!).hookSpecificOutput.additionalContext, /이 세션이 맡은 노드/);
  assert.equal(readSession(s.dir, 'unrelated')!.work, undefined);
  assert.ok(JSON.parse(s.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/a.ts' } }, 'nudge', 'unrelated', env).stdout!));
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
  assert.deepEqual({ ...spawn, at: '' }, { at: '', session: 'lead', type: 'spawn', node: 'impl', terminal: 't7', name: 'impl', show: 'pane', task: '목록 화면에 링크를 추가해줘' });
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

test('hook.sh: 서브에이전트의 시작·끝, 서브에이전트가 실행한 muwi 명령, 사람이 새로 건 말을 넘긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-hooksh-'));
  const sh = path.resolve(import.meta.dirname, '../hooks/hook.sh');
  const run = (payload: object, mode: string[] = []) =>
    spawnSync('sh', [sh, ...mode], { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: '' } });
  const plan: Plan = { work: 'w1', createdAt: '', updatedAt: '', nodes: [{ id: 'main', title: '구현', after: [], status: 'todo' }, { id: 'rev', title: '리뷰', after: [], status: 'todo' }] };
  writePlan(dir, plan);
  clock.now = () => new Date();
  attach(dir, 's1', 'w1', {} as NodeJS.ProcessEnv);
  markNode(dir, 'w1', 'main', 'doing', undefined, 's1', {} as NodeJS.ProcessEnv);
  run({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag9', agent_type: 'Explore' });
  run({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'muwi node rev start' }, agent_id: 'ag9' }, ['guard']);
  assert.equal(readSession(dir, 's1')!.starting!.rev.agent, 'ag9');
  run({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls -la' }, agent_id: 'ag9' }, ['guard']);
  // 서브에이전트가 muwi node rev start를 실행한다 (명령에는 세션 id만 있다)
  markNode(dir, 'w1', 'rev', 'doing', undefined, 's1', {} as NodeJS.ProcessEnv);
  run({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x/skills/team-rules/SKILL.md' }, agent_id: 'ag9' });
  run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'ag9', agent_type: 'Explore' });
  const events = readEvents(dir, 'w1').filter(e => e.type !== 'skill' || !e.carried).map(e =>
    e.type === 'agent' ? `agent:${e.what}:${e.agent}:${e.node ?? ''}`
    : e.type === 'skill' ? `skill:${e.skill}:${e.agent}:${e.node}`
    : e.type === 'node' ? `node:${e.node}:${e.status}:${e.agent ?? ''}`
    : e.type);
  assert.deepEqual(events, ['node:main:doing:', 'agent:start:ag9:main', 'node:rev:doing:ag9', 'skill:team-rules:ag9:rev', 'agent:stop:ag9:']);
  assert.equal(readSession(dir, 's1')!.starting!.rev, undefined);

  // 사람이 새로 말을 걸면 "이번 요청은 확인이 끝났다"는 표시가 지워진다
  const ok = path.join(dir, '.sessions', 's1.ok');
  assert.ok(fs.existsSync(ok));
  run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '다른 일 해줘' });
  assert.ok(!fs.existsSync(ok));
});

test('Node가 낮으면 무엇이 필요한지 알린다 (조용히 실패하지 않는다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-node-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-oldnode-'));
  // 22.14인 척하는 node: TypeScript 파일을 실행하지 못한다
  fs.writeFileSync(path.join(old, 'node'), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.14.0; exit 0; fi\necho "ERR_UNKNOWN_FILE_EXTENSION" >&2\nexit 1\n', { mode: 0o755 });
  // SHELL을 주지 않아 로그인 셸에 묻지 않는다. 캐시는 기록 폴더 밖에 둔다
  const env = (p: string) => ({ PATH: p, HOME: dir, MUWI_DIR: dir, XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-cache-')) });
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

test('셸 설정 없이 실행되면 로그인 셸의 PATH에서 Node를 찾고 캐시해 둔다 (Herdr가 띄운 세션, 그래프 칸)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-shell-'));
  const cache = path.join(home, 'cache');
  const cached = path.join(cache, 'muwi', 'node');
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-oldnode-'));
  fs.writeFileSync(path.join(old, 'node'), '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v22.14.0; exit 0; fi\nexit 1\n', { mode: 0o755 });
  // 셸 설정으로만 PATH에 들어가는 Node (nvm, mise 같은)
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-goodnode-'));
  const goodNode = path.join(good, 'node');
  fs.symlinkSync(process.execPath, goodNode);
  // 로그인 셸인 척하는 셸: 인사말을 찍고, 셸 설정처럼 PATH를 바꾸고, 받은 명령을 실행한다
  const shell = path.join(home, 'shell');
  const writeShell = (body: string) => fs.writeFileSync(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const loginShell = `echo "어서 오세요"\nPATH="${good}:/usr/bin:/bin"; export PATH\neval "$2"`;
  writeShell(loginShell);
  const env = (p: string, more: object = {}) => ({ PATH: p, HOME: home, MUWI_DIR: home, SHELL: shell, XDG_CACHE_HOME: cache, ...more });
  const find = (p: string, more: object = {}) =>
    spawnSync('sh', ['-c', `. "${path.resolve(import.meta.dirname, '../src/find-node.sh')}"; muwi_find_node`], { encoding: 'utf8', env: env(p, more) }).stdout.trim();

  // PATH의 node가 24 이상이면 셸을 띄우지 않는다
  assert.equal(find(`${path.dirname(process.execPath)}:/usr/bin:/bin`), 'node');
  assert.equal(fs.existsSync(cached), false);
  // PATH에 없거나 낮으면 로그인 셸의 PATH에서 찾고 캐시에 적는다
  assert.equal(find(`${old}:/usr/bin:/bin`), goodNode);
  assert.equal(fs.readFileSync(cached, 'utf8'), `${goodNode}\n`);
  // 다음부터는 셸을 띄우지 않고 캐시를 쓴다
  writeShell('exit 1');
  assert.equal(find('/usr/bin:/bin'), goodNode);

  // 캐시한 Node가 없어지면 다시 묻는다. 셸에서도 못 찾으면 setup을 실행한 Node를 쓰고, 못 찾았다는 것을 적어 둔다
  fs.rmSync(goodNode);
  assert.equal(find('/usr/bin:/bin', { MUWI_SETUP_NODE: process.execPath }), process.execPath);
  assert.equal(fs.readFileSync(cached, 'utf8'), 'none\n');
  // 못 찾았다고 적은 뒤 한 시간 동안은 셸을 다시 띄우지 않는다 (훅마다 1초씩 늘지 않게)
  fs.symlinkSync(process.execPath, goodNode);
  writeShell(loginShell);
  assert.equal(find('/usr/bin:/bin'), 'node');
  // 캐시를 버리면 (muwi setup) 다시 찾는다
  fs.rmSync(cached);
  assert.equal(find('/usr/bin:/bin'), goodNode);

  // 셸 설정이 멈춰도 시간 제한 뒤에 넘어간다
  fs.rmSync(cached);
  writeShell('exec sleep 30');
  const t = Date.now();
  assert.equal(find('/usr/bin:/bin', { MUWI_SHELL_TIMEOUT: '1' }), 'node');
  assert.ok(Date.now() - t < 5000, `${Date.now() - t}ms`);

  // 명령과 훅이 그 Node로 동작한다
  fs.rmSync(cached);
  writeShell(loginShell);
  const ran = spawnSync('/bin/sh', [path.resolve(import.meta.dirname, '../bin/muwi'), '--version'], { encoding: 'utf8', env: env(`${old}:/usr/bin:/bin`) });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^\d+\.\d+\.\d+/);
  const start = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1' });
  const hook = spawnSync('sh', [path.resolve(import.meta.dirname, '../hooks/hook.sh')], { input: start, encoding: 'utf8', env: env('/usr/bin:/bin') });
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
});

test('적는 명령은 작업을 짐작하지 않는다. 같은 폴더에 남의 끝나지 않은 작업이 있어도 거기에 적지 않는다', () => {
  const { dir, muwi } = bench();
  // 어제의 다른 대화가 남겨 둔 작업 (같은 폴더)
  assert.equal(muwi(['plan', '--work', 'old-100', '--request', 'x', '{"nodes":[{"id":"pr","title":"PR"}]}'], { MUWI_SESSION: 'yesterday' }).code, 0);
  const r = muwi(['add', 'fix', '리뷰 반영', '--after', 'pr', '--why', '리뷰'], { MUWI_SESSION: 'today' });
  assert.equal(r.code, 1);
  assert.match(r.err, /어느 작업인지 알 수 없어요\. --work <이름>을 붙여요\. 이 폴더의 작업: .*old-100\(진행 중\)/);
  assert.equal(readPlan(dir, 'old-100')!.nodes.length, 1);
  assert.match(muwi(['node', 'pr', 'start'], { MUWI_SESSION: 'today' }).err, /어느 작업인지 알 수 없어요/);
  // 보기만 하는 명령은 짐작해도 된다
  assert.equal(muwi(['show'], { MUWI_SESSION: 'today', MUWI_DIR: dir }).code, 1); // 폴더에 끝나지 않은 작업이 둘이라 고르지 못한다
  assert.match(muwi(['show', 'old-100'], { MUWI_SESSION: 'today' }).out, /old-100/);
  // 붙어 있는 작업은 다 끝난 뒤에도 그 세션의 작업이다 (연장하는 노드를 넣을 수 있다)
  assert.equal(muwi(['node', 'pr', 'start'], { MUWI_SESSION: 'yesterday' }).code, 0);
  assert.equal(muwi(['node', 'pr', 'done'], { MUWI_SESSION: 'yesterday' }).code, 0);
  assert.match(muwi(['add', 'fix', '리뷰 반영', '--after', 'pr', '--why', '리뷰가 달림'], { MUWI_SESSION: 'yesterday' }).out, /노드를 넣었어요: fix \(old-100/);
});

test('계획을 통째로 다시 낼 때 이미 시작했거나 끝난 노드가 빠져 있으면 받지 않는다', () => {
  const { dir, muwi } = bench();
  const child = { MUWI_SESSION: 'child' };
  // 새 세션이 자기 일을 쪼개서 노드를 넣고 시작했다
  assert.equal(muwi(['add', 'impl-api', 'API 연결', '--after', 'read', '--why', '쪼갬', '--work', 'shop-1'], child).code, 0);
  assert.equal(muwi(['node', 'impl-api', 'start'], child).code, 0);
  // 리드는 그걸 모른 채 갖고 있던 계획에 lint만 더해서 다시 낸다
  const stale = JSON.stringify({ nodes: [{ id: 'read', title: '읽기' }, { id: 'impl', title: '화면 구현', after: ['read'] }, { id: 'review', title: '리뷰', after: ['impl'] }, { id: 'lint', title: 'lint', after: ['impl'] }] });
  const r = muwi(['plan', '--why', 'lint 추가', stale]);
  assert.equal(r.code, 2);
  assert.match(r.err, /이미 시작했거나 끝난 노드가 새 계획에 없어요: impl-api\(● API 연결\)/);
  assert.match(r.err, /muwi remove <id> --why/);
  assert.ok(readPlan(dir, 'shop-1')!.nodes.some(n => n.id === 'impl-api' && n.status === 'doing' && n.by?.session === 'child'));
  // 아직 시작하지 않은 노드가 빠지는 것은 평범한 계획 변경이다. 하고 있는 쪽 기록은 계획을 바꿔도 이어진다
  const fresh = JSON.stringify({ nodes: [{ id: 'read', title: '읽기' }, { id: 'impl', title: '화면 구현', after: ['read'] }, { id: 'impl-api', title: 'API 연결', after: ['read'] }, { id: 'lint', title: 'lint', after: ['impl'] }] });
  assert.equal(muwi(['plan', '--why', 'lint 추가, 리뷰는 뺌', fresh]).code, 0);
  const plan = readPlan(dir, 'shop-1')!;
  assert.deepEqual(plan.nodes.map(n => n.id), ['read', 'impl', 'impl-api', 'lint']);
  assert.deepEqual([plan.nodes[2].attempt, plan.nodes[2].by?.session], [1, 'child']);
  assert.equal(plan.schema, 2);
});

test('뺀 노드의 기록은 남는다. 하던 노드를 빼면 알려 주고, 그 노드에 남긴 표시도 보인다', () => {
  const { muwi } = bench();
  assert.equal(muwi(['node', 'review', 'start']).code, 0);
  assert.equal(muwi(['flag', 'review', '리뷰가 구현 전에 시작됨']).code, 0);
  const r = muwi(['remove', 'review', '--why', '리뷰는 PR에서 받기로 함']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /review는 하는 중였어요\. 기록은 남아 있어요/);
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /빠진 노드\n +\S+ +\S+ +● review +리뷰 +이유: 리뷰는 PR에서 받기로 함/);
  assert.match(shown, /문제 표시\n +\S+ +\S+ +review\(빠진 노드\) · 리뷰가 구현 전에 시작됨/);
});

test('muwi show: 다시 한 노드는 회차별로, 훅이 보지 못한 세션과 한꺼번에 적은 노드는 그렇게 적는다', () => {
  const { dir, muwi } = bench();
  const hook = (payload: object) => spawnSync(process.execPath, [CLI, 'hook'], { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir } });
  // 훅이 한 번도 돌지 않은 세션
  assert.equal(muwi(['node', 'read', 'start'], { MUWI_SESSION: 'bare' }).code, 1); // 붙은 작업이 없다
  assert.equal(muwi(['node', 'read', 'start', '--work', 'shop-1'], { MUWI_SESSION: 'bare' }).code, 0);
  assert.equal(muwi(['node', 'read', 'done', '요구사항 2건'], { MUWI_SESSION: 'bare' }).code, 0);
  // 훅이 보고 있는 세션: 처음엔 skill 없이, 다시 할 때는 읽고
  hook({ hook_event_name: 'SessionStart', session_id: 'lead' });
  assert.equal(muwi(['node', 'impl', 'start']).code, 0);
  assert.equal(muwi(['node', 'impl', 'done', 'feature/x']).code, 0);
  hook({ hook_event_name: 'PostToolUse', session_id: 'lead', tool_name: 'Skill', tool_input: { skill: 'branch-rule' } });
  assert.equal(muwi(['node', 'impl', 'start']).code, 0);
  assert.equal(muwi(['node', 'impl', 'done', 'feature/PROJ-1']).code, 0);
  const shown = muwi(['show', 'shop-1']).out;
  assert.match(shown, /read +읽기 +\([^)]*\)\n +결과: 요구사항 2건\n +읽은 skill: 볼 수 없었음\(이 세션에서 훅이 돌지 않았어요\)/);
  assert.match(shown, /impl +화면 구현 +← read +\(2회차 · /);
  assert.match(shown, /\n +1회차 · [^\n]*읽은 skill: 기록 없음\(시작과 끝을 한꺼번에 적었어요\) · 결과: feature\/x\n +2회차 · [^\n]*이미 읽은 상태: branch-rule/);
  const json = JSON.parse(muwi(['show', 'shop-1', '--json']).out);
  assert.deepEqual(json.nodes.find((n: any) => n.id === 'impl').tries.map((x: any) => [x.n, x.note]), [[1, 'feature/x'], [2, 'feature/PROJ-1']]);
});

/** hc ls와 hc get의 답을 정해 둔 흉내 hc. terminals: 살아 있는 터미널, owners: 터미널에 붙은 muwi.session 라벨 */
function fakeHc(terminals: { address: string; status?: string | null }[], owners: Record<string, string> = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-live-'));
  const list = JSON.stringify({ terminals: terminals.map(x => ({ address: x.address, state: 'live', status: x.status === undefined ? 'working' : x.status })) });
  const cases = Object.entries(owners).map(([addr, key]) => `    ${addr}) echo '${JSON.stringify({ address: addr, labels: { 'muwi.session': key } })}' ;;`).join('\n');
  fs.writeFileSync(path.join(bin, 'hc'), `#!/bin/sh\ncase "$1" in\n  ls) echo '${list}' ;;\n  get)\n    case "$2" in\n${cases}\n    *) echo '{"labels":{}}' ;;\n    esac ;;\n  *) echo '{}' ;;\nesac\n`, { mode: 0o755 });
  return { MUWI_HC: path.join(bin, 'hc'), PATH: process.env.PATH } as NodeJS.ProcessEnv;
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
  // 닫힌 세션이 남긴 "나를 기다림"은 작업을 맨 위로 올리지 않는다
  at(61); s.node('impl', 'waiting', 'worker', 'PR 올릴까요?');
  assert.equal(loadView(s.dir, s.work, alive)!.state, 'waiting');
  assert.equal(loadView(s.dir, s.work, dead)!.state, 'stalled');
  // 새 대화가 이어받으면 다시 살아난다 (같은 회차를 이어 한다)
  at(62); s.node('impl', 'doing', 'tomorrow');
  v = loadView(s.dir, s.work, dead)!;
  assert.deepEqual([v.state, v.nodes[0].closed, v.nodes[0].attempts, v.nodes[0].who!.session], ['doing', undefined, 1, 'tomorrow']);
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
    if (done) markNode(dir, work, 'n', 'done', undefined, session, ENV);
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
