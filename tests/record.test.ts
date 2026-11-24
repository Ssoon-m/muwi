import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileGuideHash, guideUpdate, handleHook, skillFromPath } from '../src/hook.ts';
import { markNode } from '../src/node.ts';
import { attach, readSession, recordSkill, touchSession } from '../src/session.ts';
import { appendEvent, clock, readConfig, readEvents, readPlan, writeConfig, writePlan, type NodeStatus, type Plan } from '../src/store.ts';
import { buildView, loadBoard, loadView, unionMs } from '../src/view.ts';

const ENV = {} as NodeJS.ProcessEnv;
const T0 = Date.parse('2026-11-22T05:00:00.000Z');
/** 시작 뒤 몇 분인지로 시각을 맞춘다 */
const at = (min: number) => { clock.now = () => new Date(T0 + min * 60_000); };

function setup(nodes: { id: string; after?: string[] }[], work = 'w1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-test-'));
  at(0);
  const plan: Plan = {
    work, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    nodes: nodes.map(n => ({ id: n.id, title: n.id, after: n.after ?? [], status: 'todo' as NodeStatus })),
  };
  writePlan(dir, plan);
  /** 노드 상태를 바꾸고 사건을 남긴다 (muwi node가 하는 일) */
  const node = (id: string, status: NodeStatus, session: string, note?: string) => {
    assert.ok(markNode(dir, work, id, status, note, session, ENV));
    attach(dir, session, work, ENV);
  };
  const skill = (session: string, name: string) => recordSkill(dir, session, name, 'tool', {}, ENV);
  // 빈 환경을 준다: Herdr에 물어보지 않는다 (테스트가 이 컴퓨터의 터미널 상태에 기대지 않게)
  const view = () => loadView(dir, work, ENV)!;
  const skillsOf = (id: string) => view().nodes.find(n => n.id === id)!.skills.map(s => `${s.skill}:${s.state}${s.count > 1 ? `x${s.count}` : ''}`).sort();
  return { dir, work, plan, node, skill, view, skillsOf };
}

test('같은 skill을 여러 노드에서 읽으면 노드마다 기록된다', () => {
  const t = setup([{ id: 'impl' }, { id: 'review', after: ['impl'] }]);
  at(1); t.node('impl', 'doing', 'worker');
  at(2); t.skill('worker', 'react-quality');
  at(3); t.skill('worker', 'team-rules');
  at(10); t.node('impl', 'done', 'worker');
  at(11); t.node('review', 'doing', 'reviewer');
  at(12); t.skill('reviewer', 'react-quality');
  at(20); t.node('review', 'done', 'reviewer');
  assert.deepEqual(t.skillsOf('impl'), ['react-quality:read', 'team-rules:read']);
  assert.deepEqual(t.skillsOf('review'), ['react-quality:read']);
});

test('같은 세션이 앞 노드에서 읽은 skill은 다음 노드에서 "이미 읽은 상태"로 보인다', () => {
  const t = setup([{ id: 'impl' }, { id: 'self-check', after: ['impl'] }, { id: 'review', after: ['self-check'] }]);
  at(1); t.node('impl', 'doing', 'worker');
  at(2); t.skill('worker', 'react-quality');
  at(5); t.node('impl', 'done', 'worker');
  at(6); t.node('self-check', 'doing', 'worker');
  at(8); t.node('self-check', 'done', 'worker');
  at(9); t.node('review', 'doing', 'reviewer');
  at(12); t.node('review', 'done', 'reviewer');
  assert.deepEqual(t.skillsOf('self-check'), ['react-quality:loaded']);
  // 새 세션은 그 skill을 읽은 적이 없다: 표시 없음
  assert.deepEqual(t.skillsOf('review'), []);
});

test('한 노드에서 여러 번 읽으면 횟수가 남고, 노드 밖에서 읽은 것은 따로 모인다', () => {
  const t = setup([{ id: 'impl' }]);
  at(1); attach(t.dir, 'lead', t.work, ENV);
  at(2); t.skill('lead', 'muwi'); // 계획을 짜는 동안
  at(3); t.node('impl', 'doing', 'lead');
  at(4); t.skill('lead', 'team-rules');
  at(5); t.skill('lead', 'team-rules');
  at(6); t.node('impl', 'done', 'lead');
  assert.deepEqual(t.skillsOf('impl'), ['muwi:loaded', 'team-rules:readx2']);
  assert.deepEqual(t.view().outside.map(o => o.skill), ['muwi']);
});

test('작업에 붙기 전에 읽어 둔 skill도 "이미 읽은 상태"로 넘어온다', () => {
  const t = setup([{ id: 'impl' }]);
  at(-30); recordSkill(t.dir, 'lead', 'branch-rule', 'tool', {}, ENV); // 다른 일을 하던 때
  assert.equal(readEvents(t.dir, t.work).length, 0);
  at(1); t.node('impl', 'doing', 'lead');
  at(2); t.node('impl', 'done', 'lead');
  assert.deepEqual(t.skillsOf('impl'), ['branch-rule:loaded']);
  assert.deepEqual(t.view().outside, []);
  // 다시 붙어도 두 번 옮겨 적지 않는다
  attach(t.dir, 'lead', t.work, ENV);
  assert.equal(readEvents(t.dir, t.work).filter(e => e.type === 'skill').length, 1);
  assert.equal(readSession(t.dir, 'lead')!.work, t.work);
});

test('회차와 걸린 시간: 끝낸 노드를 다시 하면 2회차, 사람을 기다린 시간은 세지 않는다', () => {
  const t = setup([{ id: 'impl' }, { id: 'pr', after: ['impl'] }]);
  at(0); t.node('impl', 'doing', 'worker');
  at(10); t.node('impl', 'done', 'worker');
  at(15); t.node('impl', 'doing', 'worker'); // 검증에서 걸려 다시
  at(20); t.node('impl', 'done', 'worker', '커밋 2개');
  at(21); t.node('pr', 'doing', 'lead');
  at(22); t.node('pr', 'waiting', 'lead', 'PR 올릴까요?');
  at(52); t.node('pr', 'doing', 'lead'); // 30분 뒤 승인
  at(53); t.node('pr', 'done', 'lead');
  at(60);
  const v = t.view();
  const impl = v.nodes.find(n => n.id === 'impl')!;
  const pr = v.nodes.find(n => n.id === 'pr')!;
  assert.equal(impl.attempts, 2);
  // 회차마다 따로 남는다: 걸린 시간도, 그때의 결과도
  assert.deepEqual(impl.tries.map(x => [x.n, x.spentMs / 60_000, x.status, x.note]), [[1, 10, 'done', undefined], [2, 5, 'done', '커밋 2개']]);
  assert.deepEqual(pr.tries.map(x => [x.n, x.spentMs / 60_000]), [[1, 2]]);
  assert.equal(impl.spentMs, 15 * 60_000);
  assert.equal(impl.note, '커밋 2개');
  assert.equal(pr.attempts, 1);
  assert.equal(pr.spentMs, 2 * 60_000);
  assert.equal(v.state, 'done');
});

test('작업 시간: 노드들이 작업한 시간을 더한다. 나란히 한 노드는 겹친 시간을 한 번만 세고, 기다린 시간은 세지 않는다', () => {
  const t = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', after: ['a', 'b', 'c'] }]);
  const MIN = 60_000;
  const seen = (now: number) => buildView(readPlan(t.dir, 'w1')!, readEvents(t.dir, 'w1'), {}, T0 + now * MIN);
  const spent = (now: number) => seen(now).spentMs / MIN;
  // a와 b를 나란히 10분씩 (0~10분, 5~15분): 겹친 5분은 한 번만 센다
  at(0); t.node('a', 'doing', 'lead');
  at(5); t.node('b', 'doing', 'lead');
  assert.equal(spent(7), 7); // 하는 중에는 지금까지
  at(10); t.node('a', 'done', 'lead');
  at(15); t.node('b', 'done', 'lead');
  assert.equal(spent(15), 15);
  // 아무 노드도 하지 않은 5분(15~20분)과 사람을 기다린 10분(25~35분)은 세지 않는다
  at(20); t.node('c', 'doing', 'lead');
  at(25); t.node('c', 'waiting', 'lead', '어느 쪽으로 할까요');
  assert.equal(spent(30), 20);
  at(35); t.node('c', 'doing', 'lead');
  at(40); t.node('c', 'done', 'lead');
  assert.equal(spent(60), 25);
  // 노드의 시간을 그냥 더하면 30분이다 (a 10 + b 10 + c 10). 작업 시간은 겹침을 뺀 25분
  const nodes = seen(60).nodes;
  assert.equal(nodes.reduce((sum, n) => sum + n.spentMs, 0) / MIN, 30);
  assert.deepEqual([unionMs([]), unionMs([[0, 5], [5, 8]]), unionMs([[0, 10], [2, 4]]), unionMs([[6, 9], [0, 3]])], [0, 8, 10, 6]);
});

test('작업 상태: 응답 대기 > 막힘 > 작업 중 > 끝. 목록도 그 순서로 온다', () => {
  const a = setup([{ id: 'x' }, { id: 'y' }], 'aaa');
  at(1); a.node('x', 'doing', 's1');
  assert.equal(a.view().state, 'doing');
  at(2); a.node('y', 'blocked', 's1', '권한 없음');
  assert.equal(a.view().state, 'blocked');
  at(3); a.node('y', 'waiting', 's1', '어느 쪽으로 할까요?');
  assert.equal(a.view().state, 'waiting');

  // 같은 기록 폴더에 작업 둘을 더 둔다
  const mk = (work: string, status: NodeStatus) => {
    const plan: Plan = { work, createdAt: '2026-11-22T06:00:00.000Z', updatedAt: '2026-11-22T06:00:00.000Z', nodes: [{ id: 'n', title: 'n', after: [], status }] };
    writePlan(a.dir, plan);
  };
  mk('bbb', 'done');
  mk('ccc', 'doing');
  const board = loadBoard(a.dir, ENV);
  assert.deepEqual(board.works.map(w => `${w.work}:${w.state}`), ['aaa:waiting', 'ccc:doing', 'bbb:done']);
  assert.deepEqual(board.works[0].active.map(n => `${n.id}:${n.status}`), ['x:doing', 'y:waiting']);
});

test('새 결과: 모두 끝났는데 사람이 아직 안 본 작업. 보면 끝으로 내려가고, 다시 끝나면 다시 새 결과다', () => {
  const a = setup([{ id: 'x' }], 'aaa');
  at(1); a.node('x', 'doing', 's1');
  assert.equal(a.view().unread, undefined);
  at(2); a.node('x', 'done', 's1');
  assert.equal(a.view().state, 'done');
  assert.equal(a.view().unread, true);
  // 목록에서는 막힘 다음, 작업 중보다 위
  const mk = (work: string, status: NodeStatus) => {
    const plan: Plan = { work, createdAt: '2026-11-22T06:00:00.000Z', updatedAt: '2026-11-22T06:00:00.000Z', nodes: [{ id: 'n', title: 'n', after: [], status }] };
    writePlan(a.dir, plan);
  };
  mk('bbb', 'doing');
  mk('ccc', 'blocked');
  assert.deepEqual(loadBoard(a.dir, ENV).works.map(w => `${w.work}:${w.state}${w.unread ? ':새 결과' : ''}`), ['ccc:blocked', 'aaa:done:새 결과', 'bbb:doing']);
  // 사람이 보면(그래프 칸이 viewed를 적는다) 끝으로 내려간다
  at(3); appendEvent(a.dir, 'aaa', { type: 'viewed' }, null);
  assert.equal(a.view().unread, undefined);
  assert.deepEqual(loadBoard(a.dir, ENV).works.map(w => w.work), ['ccc', 'bbb', 'aaa']);
  // 다시 해서 끝나면 다시 새 결과. 오래돼도 지난 작업으로 접지 않는다
  at(4); a.node('x', 'doing', 's1');
  at(5); a.node('x', 'done', 's1');
  assert.equal(a.view().unread, true);
  at(60 * 24 * 30);
  assert.equal(loadBoard(a.dir, ENV).works.find(w => w.work === 'aaa')!.past, false);
});

test('새 결과는 처음 센 때(.results-since) 뒤에 끝난 작업만이다. 업데이트 전에 끝나 있던 작업이 한꺼번에 뜨지 않는다', () => {
  const a = setup([{ id: 'x' }], 'old');
  at(1); a.node('x', 'doing', 's1');
  at(2); a.node('x', 'done', 's1');
  // 이 기능이 들어온 때를 끝난 뒤로 둔다 (그 전 버전에서 끝난 작업)
  fs.writeFileSync(path.join(a.dir, '.results-since'), new Date(T0 + 10 * 60_000).toISOString() + '\n');
  assert.equal(a.view().state, 'done');
  assert.equal(a.view().unread, undefined);
});

test('훅: Skill 도구와 SKILL.md 읽기를 세션의 작업에 기록한다', () => {
  const t = setup([{ id: 'impl' }]);
  at(1); t.node('impl', 'doing', 'sess-1');
  at(2);
  handleHook({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'team-rules' }, tool_response: { success: true } }, t.dir, 'record', ENV);
  handleHook({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/Users/me/.claude/skills/branch-rule/SKILL.md' } }, t.dir, 'record', ENV);
  // skill이 아닌 파일, 실패한 호출, 다른 도구는 남기지 않는다
  handleHook({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/src/app.ts' } }, t.dir, 'record', ENV);
  handleHook({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'nope' }, tool_response: { success: false } }, t.dir, 'record', ENV);
  handleHook({ session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, t.dir, 'record', ENV);
  const skills = t.view().nodes[0].skills.map(s => `${s.skill}:${s.via}`).sort();
  assert.deepEqual(skills, ['branch-rule:file', 'team-rules:tool']);
});

test('훅: 세션 시작을 기억하고, 작업이 없는 세션의 skill은 세션 파일에만 남긴다', () => {
  const t = setup([{ id: 'impl' }]);
  const started = handleHook({ session_id: 'new-1', hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo' }, t.dir, 'record', { HC_TERMINAL_ID: 't7' } as NodeJS.ProcessEnv);
  // 세션이 시작될 때 지침을 넣어 준다 (설정 파일에 적어 두지 않는다). 구간 표시 주석은 빼고 본문만
  const context = JSON.parse(started.stdout!).hookSpecificOutput.additionalContext as string;
  assert.match(context, /muwi plan --work/);
  assert.doesNotMatch(context, /muwi:start|muwi:end/);
  handleHook({ session_id: 'new-1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'team-rules' }, tool_response: { success: true } }, t.dir, 'record', ENV);
  const s = readSession(t.dir, 'new-1')!;
  assert.equal(s.cwd, '/repo');
  assert.equal(s.terminal, 't7');
  assert.equal(s.tool, 'claude');
  assert.deepEqual(Object.keys(s.loaded), ['team-rules']);
  assert.equal(readEvents(t.dir, t.work).length, 0);
});

test('SKILL.md 경로에서 skill 이름을 꺼낸다', () => {
  assert.equal(skillFromPath('/Users/me/.claude/skills/team-branch-rule/SKILL.md'), 'team-branch-rule');
  assert.equal(skillFromPath('/repo/skills/team/code-style/SKILL.md'), 'code-style');
  assert.equal(skillFromPath('/repo/docs/SKILL.md'), null);
  assert.equal(skillFromPath('/repo/skills/team/code-style/README.md'), null);
  assert.equal(skillFromPath(undefined), null);
});

test('muwi는 AI가 하려는 일을 막지 않는다: 셸 명령, 파일 수정, 서브에이전트 띄우기에 아무 답도 하지 않는다', () => {
  const t = setup([{ id: 'impl' }]);
  // push·PR 같은 명령: 승인은 muwi의 일이 아니다
  for (const command of ['git push', 'gh pr create --title x --body y', 'ls']) {
    assert.deepEqual(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, t.dir, 'command', ENV), {});
  }
  // 계획이 없는 세션의 파일 수정과 서브에이전트 띄우기: 계획을 적을지는 AI가 정한다
  const edit = { session_id: 'fresh', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.ts' } };
  const spawn = { session_id: 'fresh', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'reviewer' } };
  for (const payload of [edit, spawn]) assert.deepEqual(handleHook(payload, t.dir, 'record', ENV), {});
  // 사람이 말할 때의 입력(0.5.x의 훅 설정이 보낸다)에도 답하지 않는다
  assert.deepEqual(handleHook({ session_id: 'fresh', hook_event_name: 'UserPromptSubmit', prompt: '…' }, t.dir, 'record', ENV), {});
  // 0.5.x의 설정에 guard와 nudge가 켜져 있어도 읽지 않는다
  fs.writeFileSync(path.join(t.dir, 'config.json'), JSON.stringify({ nudge: true, guard: true, layout: false }));
  assert.deepEqual(readConfig(t.dir), { layout: false });
  assert.deepEqual(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }, t.dir, 'command', ENV), {});
});

function newerRoot(version = '9.9.9') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-newer-'));
  const here = path.resolve(import.meta.dirname, '..');
  fs.mkdirSync(path.join(root, 'hooks'));
  const block = fs.readFileSync(path.join(here, 'hooks', 'instructions.md'), 'utf8').replace('<!-- muwi:end -->', '- 새로 생긴 규칙\n<!-- muwi:end -->');
  fs.writeFileSync(path.join(root, 'hooks', 'instructions.md'), block);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  return root;
}

test('업데이트: 세션이 시작된 뒤에 지침이 바뀌면, 그 세션의 다음 muwi 명령이 새 지침을 한 번 전한다 (어느 도구에서나 된다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-guide-'));
  const here = path.resolve(import.meta.dirname, '..');
  // 세션이 시작될 때 넣은 지침을 기억한다
  handleHook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', ENV, here);
  assert.ok(readSession(dir, 's1')!.instructions);
  // 지침이 그대로면 붙일 말이 없다
  assert.equal(guideUpdate(dir, 's1', ENV, here), null);
  // muwi가 업데이트돼 지침이 바뀌었다
  const root = newerRoot();
  // 사람이 말할 때의 훅으로는 넣지 않는다 (말할 때 문맥을 넣을 수 없는 도구가 있다)
  assert.deepEqual(handleHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '다음 일' }, dir, 'record', ENV, root), {});
  const text = guideUpdate(dir, 's1', ENV, root)!;
  assert.match(text, /muwi가 업데이트됐다 \(9\.9\.9\)\. 작업 진행 방식이 바뀌었으니/);
  assert.match(text, /새로 생긴 규칙/);
  // 한 번만 전한다
  assert.equal(guideUpdate(dir, 's1', ENV, root), null);
  // 처음 보는 세션(지침을 어떻게 받았는지 모른다)은 지금 판을 본 것으로 적기만 한다
  assert.equal(guideUpdate(dir, 'old', ENV, root), null);
  assert.ok(readSession(dir, 'old')!.instructions);
});

test('업데이트: 지침 파일로 지침을 받는 도구는 그 파일에 든 판이 그 세션이 본 지침이다 (muwi setup을 다시 하지 않았으면 옛 판)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-guide-file-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-guide-home-'));
  const here = path.resolve(import.meta.dirname, '..');
  const env = { ...ENV, HOME: home, CODEX_HOME: path.join(home, '.codex') } as NodeJS.ProcessEnv;
  const block = fs.readFileSync(path.join(here, 'hooks', 'instructions.md'), 'utf8');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), `# 내 지침\n\n${block}`);
  assert.ok(fileGuideHash('codex', env));
  assert.equal(fileGuideHash('claude', env), undefined); // 지침 파일이 없는 도구
  // 파일의 지침이 지금 판과 같으면 붙일 말이 없다
  handleHook({ session_id: 'c1', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', env, here, 'codex');
  assert.equal(readSession(dir, 'c1')!.instructions, fileGuideHash('codex', env));
  assert.equal(guideUpdate(dir, 'c1', env, here), null);
  // muwi는 새 판인데 AGENTS.md에는 옛 지침이 남아 있다: 세션이 시작될 때 읽은 것은 옛 지침이므로 새 지침을 전한다
  const root = newerRoot();
  handleHook({ session_id: 'c2', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', env, root, 'codex');
  assert.match(guideUpdate(dir, 'c2', env, root)!, /새로 생긴 규칙/);
  assert.equal(guideUpdate(dir, 'c2', env, root), null);
  // 세션 시작 훅이 없는 도구도 같다: 첫 muwi 명령에서 파일의 판과 견준다
  touchSession(dir, 'c3', { tool: 'codex' }, env);
  assert.match(guideUpdate(dir, 'c3', env, root)!, /새로 생긴 규칙/);
});
