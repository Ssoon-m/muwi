import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');

/** 깨끗한 환경에서 muwi를 실행한다 (바깥 세션의 환경 변수가 섞이지 않게) */
function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-cli-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-cwd-'));
  const muwi = (args: string[], o: { session?: string | null; input?: string; cwd?: string } = {}) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir };
    if (o.session !== null) env.MUWI_SESSION = o.session ?? 'lead';
    const r = spawnSync(process.execPath, [CLI, ...args], { env, cwd: o.cwd ?? cwd, input: o.input ?? '', encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, cwd, muwi };
}

const PLAN = JSON.stringify({
  title: '연수원명 클릭 시 상세 이동',
  nodes: [
    { id: 'read', title: '티켓 읽기' },
    { id: 'impl', title: '구현', after: ['read'] },
    { id: 'check', title: '화면 확인', after: ['impl'] },
  ],
});

test('muwi plan: 새 작업을 만들고 계획 파일과 첫 사건을 남긴다', () => {
  const { dir, cwd, muwi } = bench();
  const r = muwi(['plan', '--work', 'PROJ-1', '--request', 'PROJ-1 작업해줘', PLAN]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /계획을 적었어요: PROJ-1 \(노드 3개\)/);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'PROJ-1', 'plan.json'), 'utf8'));
  assert.equal(plan.request, 'PROJ-1 작업해줘');
  assert.equal(plan.cwd, fs.realpathSync(cwd));
  assert.deepEqual(plan.nodes.map((n: any) => `${n.id}:${n.status}`), ['read:todo', 'impl:todo', 'check:todo']);
  const events = fs.readFileSync(path.join(dir, 'PROJ-1', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].first, events[0].session, events[0].added], ['plan', true, 'lead', ['read', 'impl', 'check']]);
});

test('muwi plan: 계획 JSON은 표준 입력이나 파일로도 받는다', () => {
  const { dir, muwi } = bench();
  assert.equal(muwi(['plan', '--work', 'a'], { input: PLAN }).code, 0);
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, PLAN);
  assert.equal(muwi(['plan', '--work', 'b', '--file', file]).code, 0);
  assert.ok(fs.existsSync(path.join(dir, 'a', 'plan.json')) && fs.existsSync(path.join(dir, 'b', 'plan.json')));
});

test('muwi plan: 새 작업인데 이름이 없으면 알려 주고, 틀린 계획은 받지 않는다', () => {
  const { muwi } = bench();
  const noName = muwi(['plan', PLAN]);
  assert.equal(noName.code, 1);
  assert.match(noName.err, /--work <이름>/);
  const bad = muwi(['plan', '--work', 'x', '{"nodes":[{"id":"a","title":"A","after":["zz"]}]}']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /없는 노드/);
  assert.match(muwi(['plan', '--work', 'x', '{oops']).err, /JSON이 아니에요/);
  assert.match(muwi(['plan', '--work', 'a/b', PLAN]).err, /작업 이름/);
});

test('진행: 노드 상태를 적는다. 순서는 막지 않고, 없는 노드와 빠진 설명만 알려 준다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  // 앞 노드가 끝나지 않아도 시작할 수 있다 (기록일 뿐이다)
  assert.equal(muwi(['node', 'check', 'start']).code, 0);
  assert.match(muwi(['node', 'read', 'start']).out, /● read 시작 \(w, 0\/3 끝\)/);
  assert.match(muwi(['node', 'read', 'done', '요구사항 2건']).out, /✓ read 끝 \(w, 1\/3 끝\)/);
  assert.match(muwi(['done', 'check']).out, /2\/3 끝/); // 짧은 꼴
  assert.match(muwi(['node', 'nope', 'start']).err, /없는 노드예요: nope\. 있는 노드: read, impl, check/);
  assert.match(muwi(['node', 'impl', 'wait']).err, /무엇을 기다리는지/);
  assert.match(muwi(['node', 'impl', 'block']).err, /왜 막혔는지/);
  assert.equal(muwi(['node', 'impl', 'wait', '어느 화면부터 할까요?']).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.nodes.map((n: any) => [n.id, n.status, n.note ?? null]), [
    ['read', 'done', '요구사항 2건'], ['impl', 'waiting', '어느 화면부터 할까요?'], ['check', 'done', null],
  ]);
  assert.match(muwi(['node', 'impl', 'done']).out, /모든 노드가 끝났어요/);
});

test('계획 바꾸기: 이유가 있어야 하고, 같은 id의 노드는 상태를 잇는다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  muwi(['node', 'read', 'done']);
  const next = JSON.stringify({ nodes: [{ id: 'read', title: '티켓 읽기' }, { id: 'impl', title: '구현', after: ['read'] }, { id: 'pr', title: 'PR', after: ['impl'] }] });
  const noWhy = muwi(['plan', next]);
  assert.equal(noWhy.code, 1);
  assert.match(noWhy.err, /--why/);
  assert.match(muwi(['plan', '--why', '화면이 바뀌지 않는 변경', next]).out, /계획을 바꿨어요: w \(노드 3개\)/);
  assert.match(muwi(['plan', '--why', '같은 계획', next]).out, /바뀐 것이 없어요/);
  assert.equal(muwi(['add', 'lint', 'lint', '--after', 'impl', '--before', 'pr', '--why', 'lint 먼저 돌리라고 함', '--human']).code, 0);
  assert.match(muwi(['add', 'lint', 'x', '--why', 'y']).err, /이미 있는 노드/);
  assert.equal(muwi(['remove', 'lint', '--why', '필요 없어짐']).code, 0);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.nodes.map((n: any) => `${n.id}:${n.status}`), ['read:done', 'impl:todo', 'pr:todo']);
  assert.equal(plan.title, '연수원명 클릭 시 상세 이동'); // 제목을 다시 주지 않으면 그대로
  const changes = fs.readFileSync(path.join(dir, 'w', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'plan' && !e.first);
  assert.deepEqual(changes.map(c => [c.by, c.why, c.added, c.removed]), [
    ['ai', '화면이 바뀌지 않는 변경', ['pr'], ['check']],
    ['human', 'lint 먼저 돌리라고 함', ['lint'], []],
    ['ai', '필요 없어짐', [], ['lint']],
  ]);
});

test('작업 고르기: 세션이 붙어 있는 작업을 쓰고, 다른 세션은 --work로 들어온다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'one', PLAN], { session: 'lead' });
  muwi(['plan', '--work', 'two', PLAN], { session: 'other' });
  // 세션도 --work도 없고 같은 폴더의 작업이 둘이면 고를 수 없다
  const lost = muwi(['node', 'impl', 'start'], { session: null });
  assert.equal(lost.code, 1);
  assert.match(lost.err, /어느 작업인지 알 수 없어요.*one, two|어느 작업인지 알 수 없어요.*two, one/s);
  assert.match(muwi(['node', 'impl', 'start', '--work', 'one'], { session: 'worker' }).out, /● impl 시작 \(one/);
  // 한 번 들어온 뒤로는 --work가 없어도 된다
  assert.match(muwi(['node', 'impl', 'done', '커밋 1개'], { session: 'worker' }).out, /✓ impl 끝 \(one/);
  assert.match(muwi(['node', 'read', 'start'], { session: 'other' }).out, /\(two/);
});

test('끝난 작업에 붙어 있던 세션이 새 계획을 내면 새 작업 이름을 요구한다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'old', '{"nodes":[{"id":"a","title":"A"}]}']);
  muwi(['node', 'a', 'done']);
  const r = muwi(['plan', PLAN]);
  assert.equal(r.code, 1);
  assert.match(r.err, /새 작업이면 --work <이름>/);
});

test('muwi show·status·board: 사람이 읽는 글과 화면이 읽는 JSON', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['hook'], { input: JSON.stringify({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'spec-reader' }, tool_response: { success: true } }) });
  muwi(['node', 'read', 'done', '요구사항 2건']);
  muwi(['node', 'impl', 'wait', 'A안과 B안 중 어느 쪽?']);
  muwi(['flag', 'read', '미정 항목을 놓침']);
  const show = muwi(['show']).out;
  assert.match(show, /w · 연수원명 클릭 시 상세 이동 · 나를 기다림 \(1\/3 끝\)/);
  assert.match(show, /읽은 skill: spec-reader/);
  assert.match(show, /기다리는 것: A안과 B안 중 어느 쪽\?/);
  assert.match(show, /⚑ 문제 표시 .*미정 항목을 놓침/);
  assert.match(muwi(['status']).out, /나를 기다림\s+w\s+1\/3/);

  const board = JSON.parse(muwi(['board']).out);
  assert.equal(board.works[0].work, 'w');
  assert.equal(board.selected.work, 'w');
  assert.deepEqual(board.selected.layoutProblems, []);
  assert.equal(board.selected.layout.nodes.length, 3);
  assert.equal(board.selected.layout.edges.length, 2);
  assert.deepEqual(board.selected.nodes[0].skills, [{ skill: 'spec-reader', state: 'read', count: 1, via: 'tool' }]);
  const json = JSON.parse(muwi(['show', 'w', '--json']).out);
  assert.equal(json.flags[0].node, 'read');
});

test('muwi hook: 깨진 입력에도 조용히 끝난다 (세션을 방해하지 않는다)', () => {
  const { dir, muwi } = bench();
  const r = muwi(['hook'], { input: '{not json' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /JSON/);
  // push 앞에서 묻기는 켰을 때만
  const push = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } });
  assert.equal(muwi(['hook', 'guard'], { input: push }).out, '');
  assert.match(muwi(['config', 'guard', 'on']).out, /guard\s+on/);
  assert.equal(JSON.parse(muwi(['hook', 'guard'], { input: push }).out).hookSpecificOutput.permissionDecision, 'ask');
  const editing = JSON.stringify({ session_id: 'new-session', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } });
  assert.equal(JSON.parse(muwi(['hook', 'nudge'], { input: editing }).out).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(JSON.parse(muwi(['hook', 'nudge'], { input: editing }).out).hookSpecificOutput.permissionDecision, 'deny');
  // 계획 없이 진행한다고 밝히면 그친다
  assert.match(muwi(['skip']).err, /사용법/);
  assert.match(muwi(['skip', '오타 수정'], { session: 'new-session' }).out, /계획 없이 진행해요: 오타 수정/);
  assert.equal(muwi(['hook', 'nudge'], { input: editing }).out, '');
});

test('이름 없이 낸 계획은 이 세션이 하던 작업만 바꾼다 (같은 폴더의 남의 작업을 덮어쓰지 않는다)', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'theirs', PLAN], { session: 'other' });
  const r = muwi(['plan', '--why', '새로 시작', '{"nodes":[{"id":"x","title":"X"}]}'], { session: 'me' });
  assert.equal(r.code, 1);
  assert.match(r.err, /새 작업이면 --work <이름>/);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'theirs', 'plan.json'), 'utf8'));
  assert.equal(plan.nodes.length, 3);
});

test('muwi config·version·setup', () => {
  const { dir, muwi } = bench();
  assert.match(muwi(['--version']).out, /^\d+\.\d+\.\d+\n$/);
  assert.match(muwi(['config']).out, /nudge\s+on[\s\S]*guard\s+off/);
  assert.match(muwi(['config', 'nudge', 'off']).out, /nudge\s+off/);
  assert.match(muwi(['config', 'nudge', 'maybe']).err, /사용법: muwi config/);
  // 빈 홈 폴더에 setup: 터미널용 명령만 생긴다
  const setup = muwi(['setup']);
  assert.equal(setup.code, 0, setup.err);
  assert.match(setup.out, /muwi 명령: .*\.local\/bin\/muwi/);
  const wrapper = path.join(dir, '.local', 'bin', 'muwi');
  const viaWrapper = spawnSync(wrapper, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir } });
  assert.match(viaWrapper.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match(muwi(['setup', '--remove']).out, /뺐어요/);
  assert.equal(fs.existsSync(wrapper), false);
});

test('hook.sh: 볼 것만 넘기고, 세션 시작에는 지침을 돌려준다', () => {
  const { dir } = bench();
  const script = path.resolve(import.meta.dirname, '../hooks/hook.sh');
  const hook = (payload: object, ...args: string[]) =>
    spawnSync('sh', [script, ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir } }).stdout;
  const started = hook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo' });
  assert.match(JSON.parse(started).hookSpecificOutput.additionalContext, /muwi plan --work/);
  // skill과 상관없는 파일 읽기는 기록하지 않는다
  hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/src/app.ts' } });
  hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'team-rules' }, tool_response: { success: true } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 's1.json'), 'utf8')).loaded), ['team-rules']);
  // 계획 없는 세션의 파일 수정은 돌려보내고, 건너뛴다고 밝힌 뒤에는 조용히 지나간다
  const edit = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.ts' } };
  assert.equal(JSON.parse(hook(edit, 'nudge')).hookSpecificOutput.permissionDecision, 'deny');
  fs.writeFileSync(path.join(dir, '.sessions', 's1.ok'), '');
  assert.equal(hook(edit, 'nudge'), '');
});

test('출력을 받는 쪽이 먼저 닫아도 (muwi show | head) 오류를 쏟지 않는다', () => {
  const { dir, cwd, muwi } = bench();
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: `노드 ${i}`, ...(i ? { after: [`n${i - 1}`] } : {}) }));
  assert.equal(muwi(['plan', '--work', 'long-1', '--request', '긴 작업', JSON.stringify({ title: '긴 작업', nodes })]).code, 0);
  const env = { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead' };
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" show long-1 | head -1`], { env, cwd, encoding: 'utf8' });
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/);
});
