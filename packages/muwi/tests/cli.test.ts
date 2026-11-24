import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/** sh 스크립트(hook.sh, find-node.sh, bin/muwi)를 직접 시험하는 테스트. Windows에서는 CI가 Git Bash로 따로 확인한다 */
const SH = process.platform === 'win32' ? { skip: 'sh 스크립트를 시험한다 (Windows는 CI의 Git Bash 단계에서 본다)' } : {};


const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
/** 시험용 화면 모듈 (화면이 더하는 명령·설정) */
const FIXTURE_HOST = path.resolve(import.meta.dirname, 'fixture-host.ts');


/** 깨끗한 환경에서 muwi를 실행한다 (바깥 세션의 환경 변수가 섞이지 않게) */
function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-cli-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-cwd-'));
  const muwi = (args: string[], o: { session?: string | null; input?: string; cwd?: string; env?: Record<string, string> } = {}) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, ...o.env };
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
  // 적는 명령은 작업을 짐작하지 않는다. 이 세션이 붙은 작업이 없으면 이름을 요구하고, 이 폴더의 작업을 알려 준다
  const lost = muwi(['node', 'impl', 'start'], { session: null });
  assert.equal(lost.code, 1);
  assert.match(lost.err, /어느 작업인지 알 수 없어요.*이 폴더의 작업: (one\(진행 중\), two\(진행 중\)|two\(진행 중\), one\(진행 중\))/s);
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

test('새 결과: 끝났는데 안 본 작업은 status에 새 결과로 보이고, muwi viewed로 본 것으로 적으면 끝으로 간다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'nr', '--request', '작업해줘', '{"nodes":[{"id":"a","title":"a"}]}']);
  muwi(['node', 'a', 'start']);
  muwi(['node', 'a', 'done', '결과']);
  assert.match(muwi(['status']).out, /새 결과\s+nr\s+1\/1/);
  assert.match(muwi(['show']).out, /nr · 끝 · 아직 안 봄 \(1\/1 끝 · 작업 \d+s\)/);
  assert.match(muwi(['viewed', '--work', 'nr']).out, /nr: 본 것으로 적었어요/);
  assert.match(muwi(['status']).out, /끝\s+nr\s+1\/1/);
  // 이미 봤으면 다시 적지 않는다
  assert.match(muwi(['viewed', '--work', 'nr']).out, /새 결과가 아니에요 \(이미 봤어요\)/);
});

test('muwi show·status: 사람이 읽는 글과 JSON', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['hook'], { input: JSON.stringify({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'spec-reader' }, tool_response: { success: true } }) });
  muwi(['node', 'read', 'done', '요구사항 2건']);
  muwi(['node', 'impl', 'wait', 'A안과 B안 중 어느 쪽?']);
  muwi(['flag', 'read', '미정 항목을 놓침']);
  const show = muwi(['show']).out;
  assert.match(show, /w · 연수원명 클릭 시 상세 이동 · 응답 대기 \(1\/3 끝 · 작업 \d+s\)/);
  assert.match(show, /읽은 skill: spec-reader/);
  assert.match(show, /기다리는 것: A안과 B안 중 어느 쪽\?/);
  assert.match(show, /⚑ 문제 표시 .*미정 항목을 놓침/);
  assert.match(muwi(['status']).out, /응답 대기\s+w\s+1\/3/);
  assert.equal(JSON.parse(muwi(['status', '--json']).out).works[0].work, 'w');
  const json = JSON.parse(muwi(['show', 'w', '--json']).out);
  assert.equal(json.flags[0].node, 'read');
  assert.deepEqual(json.nodes[0].skills, [{ skill: 'spec-reader', state: 'read', count: 1, via: 'tool' }]);
});

test('훅이 돌지 않는 Claude Code 세션이 계획을 적으면 무엇이 빠지는지 알린다', () => {
  const { muwi } = bench();
  // 훅이 한 번도 보지 못한 Claude Code 세션 (muwi를 설치하기 전에 연 세션)
  const plain = muwi(['plan', '--work', 'w1', '--request', '작업해줘', PLAN], { session: null, env: { CLAUDE_CODE_SESSION_ID: 'old-1', CLAUDECODE: '1' } });
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /이 세션에서는 muwi 훅이 돌지 않아요[\s\S]*읽은 skill과 서브에이전트가 한 일은 기록되지 않아요/);
  // 훅이 보고 있는 세션은 알리지 않는다
  muwi(['hook'], { session: null, env: { CLAUDE_CODE_SESSION_ID: 'new-1', CLAUDECODE: '1' }, input: JSON.stringify({ session_id: 'new-1', hook_event_name: 'SessionStart', source: 'startup' }) });
  const hooked = muwi(['plan', '--work', 'w2', '--request', '작업해줘', PLAN], { session: null, env: { CLAUDE_CODE_SESSION_ID: 'new-1', CLAUDECODE: '1' } });
  assert.doesNotMatch(hooked.out, /훅이 돌지 않아요/);
});

test('muwi hook: 깨진 입력에도 조용히 끝난다 (세션을 방해하지 않는다)', () => {
  const { dir, muwi } = bench();
  const r = muwi(['hook'], { input: '{not json' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /JSON/);
  // 셸 명령은 막지 않는다. 무엇을 승인받고 할지는 muwi가 정하지 않는다 (push 앞에서 묻기는 0.6.0에서 뺐다).
  // 0.5.x의 훅 설정이 부르는 이름(guard)도 그대로 받아서 조용히 지나간다
  const push = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } });
  assert.equal(muwi(['hook', 'command'], { input: push }).out, '');
  assert.equal(muwi(['hook', 'guard'], { input: push }).out, '');
  const gone = muwi(['config', 'guard', 'on']);
  assert.notEqual(gone.code, 0);
  assert.match(gone.err, /0\.6\.0에서 뺐어요/);
  assert.equal(muwi(['hook', 'guard'], { input: push }).out, '');
  const editing = JSON.stringify({ session_id: 'new-session', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } });
  // 계획 없는 세션의 파일 수정도 막지 않는다 (0.5.x의 계획 알림은 0.6.0에서 뺐다). 옛 훅 설정이 부르는 nudge도 조용히 지나간다
  assert.equal(muwi(['hook', 'nudge'], { input: editing }).out, '');
  assert.equal(muwi(['hook'], { input: editing }).out, '');
  // 옛 지침을 받은 세션이 muwi skip을 불러도 실패하지 않는다
  const skip = muwi(['skip', '오타 수정'], { session: 'new-session' });
  assert.equal(skip.code, 0);
  assert.match(skip.out, /적지 않아도 돼요/);
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
  assert.match(muwi(['config', 'nudge', 'off']).err, /계획 알림\(nudge\)은 0\.6\.0에서 뺐어요/);
  // 빈 홈 폴더에 setup: 터미널용 명령만 생긴다
  const setup = muwi(['setup']);
  assert.equal(setup.code, 0, setup.err);
  assert.match(setup.out, /muwi 명령: .*\.local[\\/]bin[\\/]muwi/);
  const wrapper = path.join(dir, '.local', 'bin', 'muwi');
  // Windows는 PowerShell·cmd용 muwi.cmd로, 그 밖에는 sh 래퍼로 실행해 본다
  const viaWrapper = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', `${wrapper}.cmd`, '--version'], { encoding: 'utf8', env: { ...process.env, HOME: dir, MUWI_DIR: dir } })
    : spawnSync(wrapper, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir } });
  assert.match(viaWrapper.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.match(muwi(['setup', '--remove']).out, /뺐어요/);
  assert.equal(fs.existsSync(wrapper), false);
});

test('hook.sh: 볼 것만 넘기고, 세션 시작에는 지침을 돌려준다', SH, () => {
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
  // 계획 없는 세션의 파일 수정에도 답하지 않는다 (0.5.x의 훅 설정이 부르는 nudge 갈래는 조용히 지나간다)
  const edit = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.ts' } };
  assert.equal(hook(edit, 'nudge'), '');
  // 사람이 말할 때의 입력은 넘기지 않는다
  assert.equal(hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '다음 일' }), '');
});

test('출력을 받는 쪽이 먼저 닫아도 (muwi show | head) 오류를 쏟지 않는다', SH, () => {
  const { dir, cwd, muwi } = bench();
  const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, title: `노드 ${i}`, ...(i ? { after: [`n${i - 1}`] } : {}) }));
  assert.equal(muwi(['plan', '--work', 'long-1', '--request', '긴 작업', JSON.stringify({ title: '긴 작업', nodes })]).code, 0);
  const env = { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir, MUWI_SESSION: 'lead' };
  const r = spawnSync('sh', ['-c', `"${process.execPath}" "${CLI}" show long-1 | head -1`], { env, cwd, encoding: 'utf8' });
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/);
});

test('그래프 흐름: 하던 노드 앞에 먼저 할 노드가 끼어들면 그 노드는 잠시 멈추고, 다시 하면 같은 회차로 이어진다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['node', 'read', 'done']);
  muwi(['node', 'check', 'start']); // 마무리 노드를 미리 시작해 둠 (순서 앞당김)
  const shown = muwi(['show', 'w']).out;
  assert.match(shown, /check .*순서 앞당김 \(앞 노드가 끝나기 전에 시작\)/);
  // 사람이 새 일을 시켜서 마무리 노드 앞에 먼저 할 노드를 넣었다
  const added = muwi(['add', 'fix', '리뷰 반영', '--after', 'impl', '--before', 'check', '--why', '새 요청']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /⏸ check는 앞에 끝나지 않은 노드\(fix\)가 생겨서 잠시 멈췄어요/);
  assert.match(added.out, /⏸ check/);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8'));
  assert.equal(plan.nodes.find((n: any) => n.id === 'check').status, 'todo');
  const status = JSON.parse(muwi(['status', '--json']).out);
  // 지금 하는 노드가 없다. 세션이 무얼 하는지 모르면(화면이 없다) 작업 중으로 본다
  assert.deepEqual([status.works[0].state, status.works[0].between], ['doing', 'unknown']);
  const view = JSON.parse(muwi(['show', 'w', '--json']).out);
  const check = view.nodes.find((n: any) => n.id === 'check');
  assert.deepEqual([check.status, check.paused, check.attempts], ['todo', true, 1]);
  // 다시 하면 같은 회차로 이어진다 (2회차가 아니다)
  muwi(['node', 'check', 'start']);
  const again = JSON.parse(muwi(['show', 'w', '--json']).out).nodes.find((n: any) => n.id === 'check');
  assert.deepEqual([again.status, again.attempts, again.paused], ['doing', 1, undefined]);
  // 직접 멈출 수도 있다
  assert.match(muwi(['node', 'check', 'pause']).out, /check 잠시 멈춤/);
});

test('서브에이전트가 스스로 밝힌다 (--sub): 그 노드는 서브에이전트가 한 것으로 적히고, --work를 붙여도 부모 세션이 붙은 작업은 그대로다', () => {
  const { dir, muwi } = bench();
  // 부모 세션이 작업 둘을 적었다. 지금 붙어 있는 것은 나중에 적은 b다
  muwi(['plan', '--work', 'a', PLAN]);
  muwi(['plan', '--work', 'b', PLAN]);
  const attached = () => JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'lead.json'), 'utf8')).work;
  assert.equal(attached(), 'b');
  // 서브에이전트는 세션 id가 부모와 같다. 맡은 노드를 --sub로 시작한다 (훅이 서브에이전트를 알려 주지 않는 도구에서도 된다)
  const start = muwi(['node', 'read', 'start', '--sub', '--work', 'a']);
  assert.equal(start.code, 0, start.err);
  assert.equal(attached(), 'b');
  const who = () => JSON.parse(muwi(['show', 'a', '--json']).out).nodes.find((n: any) => n.id === 'read').who;
  assert.equal(who().kind, 'subagent');
  assert.match(who().agents[0].id, /^sub-[0-9a-f]{8}$/);
  // 끝을 적을 때 --sub를 빼먹어도 서브에이전트가 맡은 노드라 부모는 옮겨지지 않는다
  const done = muwi(['node', 'read', 'done', '결과', '--work', 'a']);
  assert.equal(done.code, 0, done.err);
  assert.equal(attached(), 'b');
  assert.equal(who().kind, 'subagent');
  assert.match(muwi(['show', 'a']).out, /서브에이전트/);
  // 부모 세션이 직접 --work를 붙여 적으면 전처럼 그 작업에 붙는다
  muwi(['node', 'impl', 'start', '--work', 'a']);
  assert.equal(attached(), 'a');
});

test('지침: muwi guide가 원본을 보여 주고, muwi가 업데이트되면 부모 세션의 다음 적는 명령 끝에 새 지침이 한 번 붙는다', () => {
  const { dir, muwi } = bench();
  assert.match(muwi(['guide']).out, /## 작업 진행 방식 \(muwi\)/);
  muwi(['plan', '--work', 'a', PLAN]);
  // 지침이 그대로면 아무것도 붙지 않는다
  assert.doesNotMatch(muwi(['node', 'read', 'start']).out, /업데이트됐다/);
  // 이 세션이 옛 지침을 받은 것으로 해 둔다 (muwi가 그 뒤에 업데이트됐다)
  const file = path.join(dir, '.sessions', 'lead.json');
  const old = () => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), instructions: 'old-guide' }));
  old();
  // 읽기만 하는 명령에는 붙이지 않는다
  assert.doesNotMatch(muwi(['status']).out, /업데이트됐다/);
  // 서브에이전트의 명령에는 붙이지 않는다 (부모가 받아야 한다)
  assert.doesNotMatch(muwi(['node', 'impl', 'start', '--sub']).out, /업데이트됐다/);
  // 부모 세션의 다음 적는 명령에 붙는다. 한 번만
  const told = muwi(['node', 'read', 'done', '읽음']).out;
  assert.match(told, /✓ read 끝[\s\S]*muwi가 업데이트됐다 \(\d+\.\d+\.\d+\)[\s\S]*## 작업 진행 방식 \(muwi\)/);
  assert.doesNotMatch(muwi(['node', 'check', 'start']).out, /업데이트됐다/);
});

test('계획은 선으로 이어진 그래프다: muwi add에 자리를 주지 않으면 맨 끝 노드 뒤에 잇고, 계획에 끊긴 노드가 있으면 알려 준다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  const after = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, 'a', 'plan.json'), 'utf8')).nodes.find((n: any) => n.id === id).after;
  // 자리를 주지 않았다: 뒤에 아무것도 없는 노드(check) 뒤에 잇는다. 따로 떨어진 노드가 되지 않는다
  const added = muwi(['add', 'pr', 'PR 올리기', '--why', '리뷰 받기']);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(after('pr'), ['check']);
  assert.match(added.out, /자리를 주지 않아 check 뒤에 이었어요/);
  assert.doesNotMatch(added.out, /이어지지 않은 노드/);
  // 자리를 주면 그대로
  muwi(['add', 'lint', 'lint', '--after', 'impl', '--why', '먼저 확인']);
  assert.deepEqual(after('lint'), ['impl']);
  // 끝이 둘이면(pr, lint) 둘 다의 뒤에 잇는다
  muwi(['add', 'wrap', '정리', '--why', '마무리']);
  assert.deepEqual(after('wrap').sort(), ['lint', 'pr']);
  // 일부러 따로 두는 노드: --alone. 그래도 끊겨 있다고 알려 준다 (막지는 않는다)
  const alone = muwi(['add', 'memo', '따로 할 일', '--alone', '--why', '순서 없음']);
  assert.equal(alone.code, 0, alone.err);
  assert.deepEqual(after('memo'), []);
  assert.match(alone.out, /다른 노드와 이어지지 않은 노드가 있어요: memo/);
  // 계획을 통째로 낼 때도 after를 빼먹은 노드를 알려 준다
  const lost = muwi(['plan', '--work', 'b', JSON.stringify({ title: 't', nodes: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y', after: ['x'] }, { id: 'z', title: 'Z' }] })]);
  assert.match(lost.out, /다른 노드와 이어지지 않은 노드가 있어요: z/);
  // 선이 하나도 없는 계획(순서 없이 늘어놓은 할 일)은 그대로 둔다
  const flat = muwi(['plan', '--work', 'c', JSON.stringify({ title: 't', nodes: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }] })]);
  assert.doesNotMatch(flat.out, /이어지지 않은 노드/);
});

test('화면 없이: 기록과 보기는 되고, 화면이 더하는 명령은 무엇이 필요한지 알린다. 화면은 setup이 적어 둔 경로에서 불러오고, 불러오지 못해도 훅은 그대로 돈다', () => {
  const { dir, muwi } = bench();
  assert.equal(muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]).code, 0);
  assert.match(muwi(['status']).out, /작업 중 +w/);
  assert.match(muwi(['show', 'w']).out, /연수원명 클릭 시 상세 이동/);
  // Herdr 화면이 더하는 명령
  const run = muwi(['run', 'impl', '구현해줘']);
  assert.equal(run.code, 1);
  assert.match(run.err, /Herdr 앱 화면과 함께 쓰는 명령이에요\. herdr-muwi로 깔면 생겨요/);
  assert.doesNotMatch(muwi(['--help']).out, /muwi run/);
  // 설정은 화면이 정한다
  assert.match(muwi(['config']).out, /설정이 없어요/);
  // $MUWI_HOST로 준 화면: 화면의 명령, 사용법, 설정이 붙는다
  const withHost = { env: { MUWI_HOST: FIXTURE_HOST } };
  assert.match(muwi(['hello', '여러분'], withHost).out, /^hello 여러분/);
  assert.match(muwi(['--help'], withHost).out, /시험 화면\n  muwi hello <말>[\s\S]*설치와 설정/);
  assert.match(muwi(['config'], withHost).out, /demo +on +시험용 설정/);
  assert.match(muwi(['config', 'demo', 'off'], withHost).out, /demo +off/);
  assert.match(muwi(['config', 'nope', 'on'], withHost).err, /사용법: muwi config \[demo\] on\|off/);
  // muwi setup은 화면의 경로를 적어 둔다. 그 뒤로는 $MUWI_HOST 없이도(훅, 그래프 칸이 부르는 명령) 그 화면을 쓴다
  assert.equal(muwi(['setup'], withHost).code, 0);
  const setupFile = path.join(dir, 'setup.json');
  assert.equal(JSON.parse(fs.readFileSync(setupFile, 'utf8')).host, FIXTURE_HOST);
  assert.match(muwi(['hello', '다시']).out, /^hello 다시/);
  // 적어 둔 화면이 없어졌으면 화면 없이 돈다. 훅도 그대로 지침을 돌려준다
  fs.writeFileSync(setupFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(setupFile, 'utf8')), host: '/no/such/host.ts' }));
  assert.doesNotMatch(muwi(['--help']).out, /muwi hello/);
  const hook = muwi(['hook'], { session: null, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(hook.code, 0);
  assert.match(JSON.parse(hook.out).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
});
