import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { guardReason, handleHook, isScratchPath, skillFromPath } from '../src/hook.ts';
import { markNode } from '../src/node.ts';
import { attach, readSession, recordSkill } from '../src/session.ts';
import { appendEvent, clock, readEvents, writeConfig, writePlan, type NodeStatus, type Plan } from '../src/store.ts';
import { loadBoard, loadView } from '../src/view.ts';

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

test('guard: push·PR·댓글 명령만 사람에게 묻는다', () => {
  for (const cmd of [
    'git push', 'git push origin feat/x', 'git -C /repo push -u origin HEAD', 'cd /repo && git push --force-with-lease',
    'gh pr create --title x --body y', 'gh pr comment 12 --body ok',
    `curl -s -u "$U:$T" -X POST https://api.bitbucket.org/2.0/repositories/acme/web-app/pullrequests -d '{}'`,
  ]) assert.ok(guardReason(cmd), cmd);
  for (const cmd of [
    'git status', 'git commit -m "push 버튼 추가"', 'git log --oneline', 'git stash push', 'echo "git push"', 'gh pr view 12', 'gh pr list',
    'curl -s https://api.bitbucket.org/2.0/repositories/acme/web-app/pullrequests/12',
  ]) assert.equal(guardReason(cmd), null, cmd);
  // 기본은 꺼져 있다. muwi config guard on 일 때만 묻는다
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-guard-'));
  const push = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } };
  assert.deepEqual(handleHook(push, dir, 'guard', ENV), {});
  writeConfig(dir, { nudge: true, guard: true });
  assert.equal(JSON.parse(handleHook(push, dir, 'guard', ENV).stdout!).hookSpecificOutput.permissionDecision, 'ask');
  assert.deepEqual(handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, dir, 'guard', ENV), {});
});

const edit = (session: string, file = '/repo/src/app.ts') => ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } });
const denied = (r: { stdout?: string }) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny' : false);

test('nudge: 계획을 적지 않은 세션의 파일 수정은, 계획을 적거나 건너뛴다고 밝힐 때까지 알린다', () => {
  const t = setup([{ id: 'impl' }]);
  const first = handleHook(edit('fresh'), t.dir, 'nudge', ENV);
  assert.ok(denied(first));
  const reason = JSON.parse(first.stdout!).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /muwi plan --work/);
  assert.match(reason, /muwi skip/);
  assert.match(reason, /수정을 다시 시도하세요/);
  // 그냥 다시 시도하면 또 알린다 (조용히 넘어가지 않는다)
  assert.ok(denied(handleHook(edit('fresh'), t.dir, 'nudge', ENV)));
  assert.ok(!fs.existsSync(path.join(t.dir, '.sessions', 'fresh.ok')));
  // 계획을 적으면 지나간다. hook.sh가 다음부터 node를 띄우지 않게 표시 파일이 남는다
  attach(t.dir, 'fresh', t.work, ENV);
  assert.deepEqual(handleHook(edit('fresh'), t.dir, 'nudge', ENV), {});
  assert.ok(fs.existsSync(path.join(t.dir, '.sessions', 'fresh.ok')));
});

test('nudge: 사람이 새로 일을 시키면 다시 따진다. skip은 그 요청까지만, 끝난 작업은 계속하는 것으로 치지 않는다', () => {
  const t = setup([{ id: 'impl' }]);
  const says = (session: string) => handleHook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '…' }, t.dir, 'record', ENV);
  // skip: 이번에 시킨 일에만
  handleHook(edit('s1'), t.dir, 'nudge', ENV);
  const s = readSession(t.dir, 's1')!;
  fs.writeFileSync(path.join(t.dir, '.sessions', 's1.json'), JSON.stringify({ ...s, skipped: { at: s.seenAt, reason: '오타' } }));
  assert.deepEqual(handleHook(edit('s1'), t.dir, 'nudge', ENV), {});
  assert.ok(fs.existsSync(path.join(t.dir, '.sessions', 's1.ok')));
  says('s1');
  assert.ok(!fs.existsSync(path.join(t.dir, '.sessions', 's1.ok')));
  assert.equal(readSession(t.dir, 's1')!.skipped, undefined);
  assert.ok(denied(handleHook(edit('s1'), t.dir, 'nudge', ENV)));

  // 하던 작업에 끝나지 않은 노드가 있으면 계속하는 것으로 본다
  at(1); t.node('impl', 'doing', 's2');
  assert.deepEqual(handleHook(edit('s2'), t.dir, 'nudge', ENV), {});
  says('s2');
  assert.deepEqual(handleHook(edit('s2'), t.dir, 'nudge', ENV), {});
  // 노드가 다 끝난 뒤에 새로 시키면 다시 묻는다. 그 작업의 연장일 수 있다고 알려 준다
  at(2); t.node('impl', 'done', 's2');
  assert.deepEqual(handleHook(edit('s2'), t.dir, 'nudge', ENV), {}); // 같은 요청 안에서는 그대로
  says('s2');
  const again = handleHook(edit('s2'), t.dir, 'nudge', ENV);
  assert.ok(denied(again));
  const reason = JSON.parse(again.stdout!).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /하던 작업\(w1\)은 노드가 다 끝났어요/);
  assert.match(reason, /muwi add <id>/);
  assert.match(reason, /muwi plan --work/);
  assert.match(reason, /muwi skip/);
});

test('nudge: 파일을 고치지 않는 일도 서브에이전트를 띄우면 계획을 먼저 묻는다 (PR 리뷰의 점검들처럼)', () => {
  const t = setup([{ id: 'impl' }]);
  const spawn = (session: string, extra: object = {}) =>
    ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: '팀 기준 점검', prompt: '…' }, ...extra });
  const first = handleHook(spawn('reviewer'), t.dir, 'nudge', ENV);
  assert.ok(denied(first));
  const reason = JSON.parse(first.stdout!).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /여러 단계로 하는 일이면 파일을 고치지 않아도 계획을 적어요/);
  assert.match(reason, /서브에이전트 띄우기를 다시 시도하세요/);
  assert.match(reason, /muwi skip/);
  // 예전 이름(Task)도 같다
  assert.ok(denied(handleHook({ ...spawn('reviewer'), tool_name: 'Task' }, t.dir, 'nudge', ENV)));
  // 서브에이전트 안에서 또 띄우는 것은 따지지 않는다 (맡긴 세션이 이미 따졌다)
  assert.deepEqual(handleHook(spawn('reviewer', { agent_id: 'ag1' }), t.dir, 'nudge', ENV), {});
  // 계획을 적으면 지나간다
  attach(t.dir, 'reviewer', t.work, ENV);
  assert.deepEqual(handleHook(spawn('reviewer'), t.dir, 'nudge', ENV), {});
});

test('nudge: 계획을 적은 세션과 맡은 노드를 시작한 세션은 알리지 않는다', () => {
  const t = setup([{ id: 'impl' }]);
  at(1); t.node('impl', 'doing', 'worker'); // muwi node impl start --work w1
  assert.deepEqual(handleHook(edit('worker'), t.dir, 'nudge', ENV), {});
  assert.ok(fs.existsSync(path.join(t.dir, '.sessions', 'worker.ok')));
});

test('nudge: 작업물이 아닌 곳(기록 폴더, 에이전트 설정, 임시 폴더)에 쓰는 것은 알리지 않는다', () => {
  const t = setup([{ id: 'impl' }]);
  const env = { HOME: '/Users/me', TMPDIR: '/var/folders/xx/T/' } as NodeJS.ProcessEnv;
  for (const file of [`${t.dir}/w1/notes.md`, '/Users/me/.muwi/w/plan.md', '/Users/me/.claude/projects/x/memory/a.md', '/tmp/a.txt', '/var/folders/xx/T/b.txt']) {
    assert.ok(isScratchPath(file, t.dir, env), file);
    assert.deepEqual(handleHook(edit('scratch', file), t.dir, 'nudge', env), {}, file);
  }
  assert.equal(isScratchPath('/Users/me/work/web-app/src/a.ts', t.dir, env), false);
  // 작업물을 고치려 하면 그때 알린다
  assert.ok(denied(handleHook(edit('scratch', '/Users/me/work/web-app/src/a.ts'), t.dir, 'nudge', env)));
});

test('nudge: muwi config nudge off 이면 알리지 않는다', () => {
  const t = setup([{ id: 'impl' }]);
  writeConfig(t.dir, { nudge: false, guard: false });
  assert.deepEqual(handleHook(edit('fresh'), t.dir, 'nudge', ENV), {});
});

/** muwi가 업데이트된 것처럼: 지침을 바꾼 새 설치 위치 */
function newerRoot(version = '9.9.9') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-newer-'));
  const here = path.resolve(import.meta.dirname, '..');
  fs.mkdirSync(path.join(root, 'hooks'));
  const block = fs.readFileSync(path.join(here, 'hooks', 'instructions.md'), 'utf8').replace('<!-- muwi:end -->', '- 새로 생긴 규칙\n<!-- muwi:end -->');
  fs.writeFileSync(path.join(root, 'hooks', 'instructions.md'), block);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  return root;
}

test('업데이트: 세션이 시작된 뒤에 지침이 바뀌면, 사람이 다음에 말을 걸 때 새 지침을 한 번 넣는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-guide-'));
  const here = path.resolve(import.meta.dirname, '..');
  const says = (root: string, session = 's1') => handleHook({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: '다음 일' }, dir, 'record', ENV, root);
  // 세션이 시작될 때 넣은 지침을 기억한다
  handleHook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', ENV, here);
  assert.ok(readSession(dir, 's1')!.instructions);
  // 지침이 그대로면 아무것도 넣지 않는다
  assert.deepEqual(says(here), {});
  // muwi가 업데이트돼 지침이 바뀌었다
  const root = newerRoot();
  const next = JSON.parse(says(root).stdout!).hookSpecificOutput;
  assert.equal(next.hookEventName, 'UserPromptSubmit');
  assert.match(next.additionalContext, /muwi가 업데이트됐다 \(9\.9\.9\)\. 작업 진행 방식이 바뀌었으니/);
  assert.match(next.additionalContext, /새로 생긴 규칙/);
  // 한 번만 넣는다
  assert.deepEqual(says(root), {});
  // 지침을 기억하지 못하는 세션(예전 버전에서 시작)은 지금 것을 기억만 하고 넣지 않는다
  assert.deepEqual(says(root, 'old'), {});
  assert.ok(readSession(dir, 'old')!.instructions);
});
