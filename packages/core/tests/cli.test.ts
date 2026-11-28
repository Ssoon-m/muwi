import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readEvents, readPlan } from '../src/store.ts';
import { replayNodes } from '../src/view.ts';

/** sh 스크립트(tool.sh, find-node.sh, bin/muwi)를 직접 시험하는 테스트. Windows에서는 CI가 Git Bash로 따로 확인한다 */
const SH = process.platform === 'win32' ? { skip: 'sh 스크립트를 시험한다 (Windows는 CI의 Git Bash 단계에서 본다)' } : {};


const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
/** 시험용 보기 모듈 (보기가 더하는 명령·설정) */
const FAKE_VIEW = path.resolve(import.meta.dirname, 'fake-view.ts');
/** 시험용 터미널 연결 */
const FAKE_TERMINALS = path.resolve(import.meta.dirname, 'fake-terminals.ts');


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

test('명령이 받지 않는 옵션은 실행하지 않고 알린다: 오타가 조용히 무시되어 붙어 있는 작업에 적히지 않게', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  const typo = muwi(['node', 'read', 'start', '--wrok', 'b']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /모르는 옵션이에요: --wrok \(--work를 쓰려던 거면/);
  assert.match(typo.err, /muwi node가 받는 옵션: --work, --sub, --result/);
  // 실행하지 않았다: read는 그대로 시작 전이다
  assert.match(muwi(['show', 'a']).out, /○ read/);
  // 값을 받지 않는 옵션도 같다
  assert.match(muwi(['status', '--jsn']).err, /모르는 옵션이에요: --jsn \(--json/);
  // --help는 어느 명령이든 사용법을 보여 준다
  assert.equal(muwi(['setup', '--help']).code, 0);
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
  // 앞 노드가 끝나지 않아도 시작할 수 있다 (기록일 뿐이다). 앞 노드를 아직 하고 있지 않으면 그래프는 그 노드를 건너뛰어 그리므로 계획을 고치라고 하지 않는다
  const early = muwi(['node', 'check', 'start']);
  assert.equal(early.code, 0);
  assert.match(early.out, /앞 노드 impl를 아직 하고 있지 않아요/);
  assert.doesNotMatch(early.out, /나란히 두세요/);
  assert.match(early.out, /muwi node check pause로 멈추고 impl를 먼저 끝내요/);
  // 맡은 서브에이전트는 계획을 고치지 않으므로 알리지 않는다
  assert.doesNotMatch(muwi(['node', 'check', 'start', '--sub']).out, /앞 노드/);
  // 앞 노드가 없거나 다 끝났으면 알리지 않는다
  const first = muwi(['node', 'read', 'start']).out;
  assert.match(first, /● read 시작 \(w, 0\/3 끝\)/);
  assert.doesNotMatch(first, /앞 노드/);
  assert.match(muwi(['node', 'read', 'done', '요구사항 2건']).out, /✓ read 끝 \(w, 1\/3 끝\)/);
  assert.match(muwi(['node', 'check', 'done']).out, /2\/3 끝/);
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

test('뺀 노드의 id는 같은 작업에서 다시 쓰지 않는다: 앞 노드의 회차와 결과가 새 노드에 섞이지 않게', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  muwi(['node', 'impl', 'start']);
  muwi(['node', 'impl', 'done', '첫 구현']);
  assert.equal(muwi(['remove', 'impl', '--why', '접근을 바꿈']).code, 0);
  // 다른 일을 같은 id로 넣으면 받지 않는다. 뺀 노드(id와 제목)를 알려 주고 다른 id를 고르라고 한다
  const other = muwi(['add', 'impl', '다른 방식으로 구현', '--after', 'read', '--why', '새 접근']);
  assert.equal(other.code, 2);
  assert.match(other.err, /전에 뺀 노드의 id예요: impl\(구현\)/);
  assert.match(other.err, /다른 id를 골라/);
  // 같은 노드를 다시 넣는 것도 새로 하는 일이라 받지 않는다
  assert.match(muwi(['add', 'impl', '구현', '--after', 'read', '--why', '다시 넣음']).err, /같은 일을 다시 넣는 것이어도 새로 하는 일이니 새 id로/);
  // 계획을 통째로 다시 낼 때도 같다
  const whole = muwi(['plan', '--why', '다시 짬', PLAN]);
  assert.equal(whole.code, 2);
  assert.match(whole.err, /impl\(구현\)/);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.nodes.map((n: any) => n.id), ['read', 'check']);
  // 새 id는 받고, 앞 노드의 기록과 섞이지 않는다
  assert.equal(muwi(['add', 'impl2', '다른 방식으로 구현', '--after', 'read', '--before', 'check', '--why', '새 접근']).code, 0);
  const node = JSON.parse(muwi(['show', 'w', '--json']).out).nodes.find((n: any) => n.id === 'impl2');
  assert.deepEqual([node.status, node.attempts, node.tries.length], ['todo', 0, 0]);
});

test('계획이 바뀐 기록에 노드의 모양이 남는다: 생긴 노드의 모양, 바뀐 노드의 전과 뒤, 빠진 노드의 앞 노드', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  const next = JSON.stringify({ nodes: [
    { id: 'read', title: '티켓 읽기' },
    { id: 'impl', title: '구현과 시험', after: ['read'], run: 'subagent' },
    { id: 'lint', title: 'lint', after: ['impl'] },
    { id: 'check', title: '화면 확인', after: ['lint'] },
  ] });
  assert.equal(muwi(['plan', '--why', 'lint를 먼저', next]).code, 0);
  assert.equal(muwi(['remove', 'lint', '--why', '필요 없어짐']).code, 0);
  const plans = fs.readFileSync(path.join(dir, 'w', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'plan');
  // 첫 계획은 모든 노드의 모양
  assert.deepEqual(plans[0].shapes, [
    { id: 'read', title: '티켓 읽기', after: [] }, { id: 'impl', title: '구현', after: ['read'] }, { id: 'check', title: '화면 확인', after: ['impl'] },
  ]);
  // 바꾼 계획: 생긴 노드의 모양과, 바뀐 노드는 바뀐 필드만 전과 뒤로 (없던 값은 null)
  assert.deepEqual(plans[1].shapes, [{ id: 'lint', title: 'lint', after: ['impl'] }]);
  assert.deepEqual(plans[1].edits, [
    { id: 'impl', before: { title: '구현', run: null }, after: { title: '구현과 시험', run: 'subagent' } },
    { id: 'check', before: { after: ['impl'] }, after: { after: ['lint'] } },
  ]);
  // 뺀 노드는 앞 노드까지 남고, 이어 붙인 노드는 바뀐 노드로 남는다
  assert.deepEqual(plans[2].gone, [{ id: 'lint', title: 'lint', after: ['impl'], status: 'todo' }]);
  assert.deepEqual(plans[2].edits, [{ id: 'check', before: { after: ['lint'] }, after: { after: ['impl'] } }]);
  const show = muwi(['show', 'w']).out;
  assert.match(show, /\+lint ~impl\(제목 "구현" → "구현과 시험" · 맡는 쪽 정하지 않음 → 서브에이전트\) ~check\(앞 impl → lint\)  이유: lint를 먼저/);
  assert.match(show, /-lint ~check\(앞 lint → impl\)  이유: 필요 없어짐/);
});

test('앞 노드가 끝나기 전에 시작하면 앞당김 안내 하나에 근거를 남기는 법만 붙인다 (같은 말을 두 번 하지 않는다)', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'w', JSON.stringify({ nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', after: ['a'] }] })]);
  muwi(['node', 'a', 'start']);
  const b = muwi(['node', 'b', 'start']);
  assert.match(b.out, /앞 노드 a를 아직 하고 있어요/);
  assert.doesNotMatch(b.out, /계획과 다르게 시작했어요/);
  assert.match(b.out, /근거를 남기려면 muwi node b start --why "<근거>"로 다시 적어요/);
  assert.doesNotMatch(muwi(['node', 'b', 'start', '--why', '다른 파일이라']).out, /근거를 남기려면/);
});

test('계획과 다르게 시작한 판단의 근거(--why): 회차에 적히고 muwi show에 나온다. 근거 없이 다르게 시작하면 막지 않고 한 줄 알린다', () => {
  const { dir, muwi } = bench();
  const plan = JSON.stringify({ nodes: [
    { id: 'read', title: '티켓 읽기' },
    { id: 'impl', title: '구현', after: ['read'], run: 'me' },
    { id: 'review', title: '리뷰', after: ['impl'], run: 'subagent' },
  ] });
  muwi(['plan', '--work', 'w', plan]);
  const hint = /계획과 다르게 시작했어요/;
  // 계획대로면 알리지 않는다
  const first = muwi(['node', 'read', 'start']);
  assert.equal(first.code, 0);
  assert.doesNotMatch(first.out, hint);
  muwi(['node', 'read', 'done', '요구사항 2건']);
  // 끝낸 노드를 다시 하기: 알리고(종료 코드 0), 같은 회차에 근거를 붙이는 법을 알려 준다
  const redo = muwi(['node', 'read', 'start']);
  assert.equal(redo.code, 0);
  assert.match(redo.out, /계획과 다르게 시작했어요 \(끝낸 노드를 2회차로 다시 함\)\. 판단의 근거를 남기려면 muwi node read start --why "<근거>"로 다시 적어요/);
  // 하는 중에 --why를 붙여 다시 start하면 같은 회차에 붙고, 마지막 근거를 쓴다
  assert.doesNotMatch(muwi(['node', 'read', 'start', '--why', '첫 근거']).out, hint);
  muwi(['node', 'read', 'start', '--why', '리뷰 댓글에 빠진 요구사항이 있어서']);
  muwi(['node', 'read', 'done', '요구사항 3건']);
  // 앞 노드가 끝나기 전에 시작, 계획은 서브에이전트인데 이 세션이 시작
  const early = muwi(['node', 'review', 'start']);
  // 앞 노드가 안 끝난 것은 앞당김 안내가 이미 말하므로 근거 안내에는 다시 적지 않는다
  assert.match(early.out, /계획과 다르게 시작했어요 \(계획은 서브에이전트인데 이 세션이 시작함\)/);
  assert.doesNotMatch(early.out, /아직 안 끝남/);
  assert.equal(early.out.match(/--why/g)?.length, 1);
  assert.doesNotMatch(muwi(['node', 'review', 'start', '--why', '바뀐 파일이 하나뿐이라']).out, hint);
  // 계획은 직접인데 서브에이전트가 시작: 서브에이전트가 다시 적을 명령으로 알려 준다
  const sub = muwi(['node', 'impl', 'start', '--sub', '--work', 'w']);
  assert.match(sub.out, /계획은 직접인데 서브에이전트가 시작함\)\. 판단의 근거를 남기려면 muwi node impl start --sub --work w --why "<근거>"/);
  assert.doesNotMatch(muwi(['node', 'impl', 'start', '--sub', '--work', 'w', '--why', '맡긴 세션이 다른 일을 하고 있어서']).out, hint);

  const events = fs.readFileSync(path.join(dir, 'w', 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'node' && e.why);
  assert.deepEqual(events.map(e => [e.node, e.attempt, e.why]), [
    ['read', 2, '첫 근거'], ['read', 2, '리뷰 댓글에 빠진 요구사항이 있어서'], ['review', 1, '바뀐 파일이 하나뿐이라'], ['impl', 1, '맡긴 세션이 다른 일을 하고 있어서'],
  ]);
  const json = JSON.parse(muwi(['show', 'w', '--json']).out);
  const read = json.nodes.find((n: any) => n.id === 'read');
  assert.deepEqual(read.tries.map((t: any) => t.why ?? null), [null, '리뷰 댓글에 빠진 요구사항이 있어서']);
  const show = muwi(['show', 'w']).out;
  assert.match(show, /2회차 · .* · 근거: 리뷰 댓글에 빠진 요구사항이 있어서/);
  assert.match(show, /읽은 skill: .* · 근거: 바뀐 파일이 하나뿐이라/);
});

test('지금 노드 상태는 plan.json에, 이력은 사건 기록에: 사건만 다시 따라가도 plan.json의 상태·회차와 같다', () => {
  const { dir, muwi } = bench();
  /** 명령 하나를 실행하고 매번 사건으로 다시 만든 상태가 plan.json과 같은지 본다 */
  const step = (args: string[]) => {
    const r = muwi([...args, '--work', 'w']);
    assert.ok(r.code === 0, `${args.join(' ')}: ${r.err}`);
    const plan = readPlan(dir, 'w')!;
    const replay = replayNodes(readEvents(dir, 'w'));
    assert.deepEqual(
      Object.fromEntries(replay),
      Object.fromEntries(plan.nodes.map(n => [n.id, { status: n.status, ...(n.attempt ? { attempt: n.attempt } : {}) }])),
      `${args.join(' ')} 뒤`,
    );
  };
  step(['plan', PLAN]);
  step(['node', 'read', 'start']);
  step(['node', 'read', 'done', '요구사항 2건']);
  step(['node', 'impl', 'wait', 'A안과 B안 중 어느 쪽?']);
  step(['node', 'impl', 'start']);
  step(['node', 'impl', 'done']);
  step(['node', 'impl', 'start', '--why', '확인에서 빠진 경우를 찾아서']); // 2회차
  step(['node', 'impl', 'pause']);
  step(['node', 'impl', 'start']); // 같은 회차로 이어 하기
  step(['node', 'check', 'block', '화면을 띄울 수 없음']);
  step(['node', 'check', 'start']); // 막혔던 노드를 다시: 2회차
  step(['node', 'check', 'pause']);
  step(['node', 'check', 'pause']); // 같은 상태를 다시 적기
  step(['add', 'lint', 'lint', '--after', 'impl', '--before', 'check', '--why', 'lint 먼저']);
  step(['node', 'lint', 'done']); // 시작을 적지 않고 끝내기
  step(['node', 'lint', 'start']); // 그 노드를 다시: 2회차
  step(['node', 'lint', 'done']);
  step(['remove', 'lint', '--why', '필요 없어짐']);
  // 계획을 통째로 다시 낸다: 하던 노드(impl) 앞에 끝나지 않은 노드가 생겨 impl이 잠시 멈춘다
  step(['plan', '--why', '설계를 먼저', JSON.stringify({ nodes: [
    { id: 'read', title: '티켓 읽기' }, { id: 'design', title: '설계', after: ['read'] },
    { id: 'impl', title: '구현', after: ['design'] }, { id: 'check', title: '화면 확인', after: ['impl'] },
  ] })]);
  step(['node', 'design', 'start', '--sub']);
  step(['node', 'design', 'done']);
  step(['node', 'impl', 'start']);
  step(['node', 'impl', 'done']);
  step(['node', 'check', 'start']);
  step(['node', 'check', 'done']);
  assert.deepEqual(Object.fromEntries(replayNodes(readEvents(dir, 'w'))), {
    read: { status: 'done', attempt: 1 }, design: { status: 'done', attempt: 1 }, impl: { status: 'done', attempt: 2 }, check: { status: 'done', attempt: 2 },
  });
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

test('세션은 일을 시작하는 명령(plan, node start)으로만 작업에 붙는다. 다른 적는 명령은 --work로 다른 작업에 적어도 붙은 작업을 바꾸지 않는다', () => {
  const { dir, muwi } = bench();
  const attached = () => JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 'lead.json'), 'utf8')).work;
  muwi(['plan', '--work', 'a', PLAN]);
  muwi(['node', 'read', 'start']);
  // 다른 작업으로 넘어가면 하던 작업의 남은 노드와 정리하는 방법을 알린다. 명령의 출력과 섞이지 않게 표준 오류로
  const moved = muwi(['plan', '--work', 'b', PLAN]);
  assert.equal(moved.code, 0, moved.err);
  assert.match(moved.err, /※ 이 세션이 하던 작업 a에 끝나지 않은 노드가 남았어요: read\(작업 중\), impl\(시작 전\), check\(시작 전\)/);
  assert.match(moved.err, /muwi node <id> done "<결과>" --work a/);
  assert.match(moved.err, /muwi remove <id> --why "<이유>" --work a/);
  assert.doesNotMatch(moved.out, /※/);
  assert.equal(attached(), 'b');
  // 정리하는 명령은 붙은 작업을 바꾸지 않으므로 알림도 다시 나오지 않는다
  for (const args of [
    ['add', 'lint', 'lint', '--after', 'impl', '--why', '빠뜨림', '--work', 'a'],
    ['node', 'read', 'done', '읽음', '--work', 'a'],
    ['node', 'impl', 'wait', '물어볼 것', '--work', 'a'],
    ['node', 'impl', 'block', '막힌 이유', '--work', 'a'],
    ['node', 'impl', 'pause', '--work', 'a'],
    ['remove', 'lint', '--why', '안 함', '--work', 'a'],
    ['flag', 'read', '표시', '--work', 'a'],
  ]) {
    const r = muwi(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.equal(attached(), 'b', args.join(' '));
    assert.doesNotMatch(r.err, /※/, args.join(' '));
  }
  // --work 없이 적으면 그대로 b에 적힌다
  assert.match(muwi(['node', 'read', 'start']).out, /● read 시작 \(b, /);
  // 노드를 시작하면 그 작업에 붙는다. 이번에는 b에 하던 노드가 남는다
  const back = muwi(['node', 'impl', 'start', '--work', 'a']);
  assert.equal(attached(), 'a');
  assert.match(back.err, /작업 b에 끝나지 않은 노드가 남았어요: read\(작업 중\)/);
  // 다른 살아 있는 세션이 붙어 있는 작업이면 알리지 않는다
  assert.equal(muwi(['node', 'check', 'start', '--work', 'a'], { session: 'other' }).code, 0);
  assert.doesNotMatch(muwi(['plan', '--work', 'c', PLAN]).err, /※/);
});

test('다른 작업으로 간 세션이 남긴 작업: 멈춤이고 어디로 갔는지(movedTo) 보여 준다. 하던 노드는 작업 중으로 세지 않고, 세션이 쉬어도 응답 대기로 올라오지 않는다', () => {
  const { muwi } = bench();
  const turn = (event: string) => muwi(['hook', '--from', 'claude'], { input: JSON.stringify({ session_id: 'lead', hook_event_name: event }) });
  const two = (title: string) => JSON.stringify({ title, nodes: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y', after: ['x'] }] });
  const work = (name: string) => JSON.parse(muwi(['board']).out).works.find((w: any) => w.work === name);
  // 하던 노드를 남기고 넘어갔다. 세션은 b에서 말을 끝내고 쉬고 있다
  muwi(['plan', '--work', 'a', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['plan', '--work', 'b', two('새 일')]);
  turn('Stop');
  const a = work('a');
  assert.equal(a.state, 'stalled');
  assert.equal(a.between, 'gone');
  assert.equal(a.movedTo, 'b');
  assert.equal(a.quiet, undefined);
  assert.deepEqual(a.active.map((n: any) => [n.id, n.status, n.moved, n.quiet, n.terminal]), [['read', 'doing', 'b', undefined, undefined]]);
  const shownA = muwi(['show', 'a']).out;
  assert.match(shownA, /^a · .* · 멈춤 · 하던 세션이 다른 작업으로 감 \(b\)/);
  assert.match(shownA, /● read .*다른 작업으로 감 \(b\)/);
  const status = muwi(['status']).out;
  assert.match(status, /read  티켓 읽기 \(다른 작업으로 감: b\)/);
  assert.match(status, /· 하던 세션이 다른 작업으로 감 \(b\)/);
  // b는 세션이 붙어 있는 작업이다: 세션이 쉬면 응답 대기
  assert.equal(work('b').state, 'waiting');
  // --work로 a를 정리해도 세션은 b에 그대로 붙어 있다. 시작 전 노드만 남아도 어디로 갔는지 보여 준다
  assert.equal(muwi(['node', 'read', 'done', '읽음', '--work', 'a']).code, 0);
  assert.match(muwi(['node', 'x', 'start']).out, /● x 시작 \(b, /);
  const left = work('a');
  assert.deepEqual([left.state, left.between, left.movedTo, left.active.length], ['stalled', 'gone', 'b', 0]);
  // 사람에게 묻던 노드를 남기고 넘어가면 그대로 응답 대기다 (사람이 답할 일이다)
  muwi(['plan', '--work', 'c', two('묻는 일')]);
  muwi(['node', 'x', 'start']);
  muwi(['node', 'x', 'wait', 'A와 B 중 어느 쪽?']);
  muwi(['plan', '--work', 'd', two('또 새 일')]);
  const c = work('c');
  assert.equal(c.state, 'waiting');
  assert.deepEqual(c.active.map((n: any) => [n.id, n.status, n.moved]), [['x', 'waiting', undefined]]);
  // 하던 세션이 이 작업으로 돌아와 노드를 시작하면 다시 작업 중이다
  muwi(['node', 'impl', 'start', '--work', 'a']);
  turn('UserPromptSubmit');
  const back = work('a');
  assert.deepEqual([back.state, back.movedTo], ['doing', undefined]);
});

test('다른 작업의 세션이 서브에이전트로 노드 하나를 도왔을 뿐이면, 하던 세션이 닫힌 작업을 그 세션의 작업으로 간 것으로 보지 않는다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN], { session: 's1' });
  muwi(['node', 'read', 'start'], { session: 's1' });
  muwi(['node', 'read', 'done', '읽음'], { session: 's1' });
  muwi(['hook', '--from', 'claude'], { session: null, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionEnd', reason: 'exit' }) });
  // 작업 b를 하는 세션의 서브에이전트가 a의 노드를 시작하고 끝낸다 (끝 줄에는 서브에이전트 표시가 없다)
  muwi(['plan', '--work', 'b', PLAN]);
  muwi(['node', 'impl', 'start', '--sub', '--work', 'a']);
  muwi(['node', 'impl', 'done', '고침', '--work', 'a']);
  const a = JSON.parse(muwi(['board']).out).works.find((w: any) => w.work === 'a');
  assert.equal(a.state, 'stalled');
  assert.equal(a.movedTo, undefined);
});

test('서브에이전트가 맡은 노드는 맡긴 세션이 다른 작업에 붙어 있어도 다른 작업으로 간 것으로 보지 않는다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  muwi(['plan', '--work', 'b', PLAN]);
  assert.equal(muwi(['node', 'read', 'start', '--sub', '--work', 'a']).code, 0);
  const a = JSON.parse(muwi(['board']).out).works.find((w: any) => w.work === 'a');
  assert.equal(a.state, 'doing');
  assert.equal(a.movedTo, undefined);
  assert.equal(a.active[0].moved, undefined);
});

test('다른 쪽이 끝낸 회차: 시작한 쪽과 다르면 끝낸 쪽을 남기고 muwi show에 "끝냄"으로 보여 준다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  // read: lead가 시작하고 다른 세션이 끝을 적었다
  muwi(['node', 'read', 'start']);
  assert.equal(muwi(['node', 'read', 'done', '읽음', '--work', 'a'], { session: 'other' }).code, 0);
  // impl: 1회차는 lead가 시작하고 끝냈고, 2회차는 lead가 시작하고 다른 세션이 끝냈다
  muwi(['node', 'impl', 'start']);
  muwi(['node', 'impl', 'done', '1차']);
  muwi(['node', 'impl', 'start', '--why', '리뷰 반영']);
  muwi(['node', 'impl', 'done', '2차', '--work', 'a'], { session: 'other' });
  // check: 서브에이전트가 시작하고 끝을 적었다 (--sub를 빼먹어도 같은 쪽이다)
  muwi(['node', 'check', 'start', '--sub']);
  muwi(['node', 'check', 'done', '봄']);
  const v = JSON.parse(muwi(['show', 'a', '--json']).out);
  const tries = (id: string) => v.nodes.find((n: any) => n.id === id).tries.map((t: any) => t.closer ?? null);
  assert.deepEqual(tries('read'), ['other']);
  assert.deepEqual(tries('impl'), [null, 'other']);
  assert.deepEqual(tries('check'), [null]);
  const shown = muwi(['show', 'a']).out;
  assert.match(shown, /✓ read .*\(.*세션 lead · 끝냄: 세션 othe\)/);
  assert.match(shown, /1회차 [^\n]*세션 lead · 읽은/);
  assert.match(shown, /2회차 [^\n]*세션 lead · 끝냄: 세션 othe · /);
  assert.doesNotMatch(shown.split('\n').find((l: string) => l.includes('✓ check'))!, /끝냄/);
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
  muwi(['hook', '--from', 'claude'], { input: JSON.stringify({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'spec-reader' }, tool_response: { success: true } }) });
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
  muwi(['hook', '--from', 'claude'], { session: null, env: { CLAUDE_CODE_SESSION_ID: 'new-1', CLAUDECODE: '1' }, input: JSON.stringify({ session_id: 'new-1', hook_event_name: 'SessionStart', source: 'startup' }) });
  const hooked = muwi(['plan', '--work', 'w2', '--request', '작업해줘', PLAN], { session: null, env: { CLAUDE_CODE_SESSION_ID: 'new-1', CLAUDECODE: '1' } });
  assert.doesNotMatch(hooked.out, /훅이 돌지 않아요/);
});

test('muwi hook: 깨진 입력에도 조용히 끝난다 (세션을 방해하지 않는다)', () => {
  const { dir, muwi } = bench();
  const r = muwi(['hook', '--from', 'claude'], { input: '{not json' });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /JSON/);
  // 셸 명령은 막지 않는다. 무엇을 승인받고 할지는 muwi가 정하지 않는다
  const push = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } });
  assert.equal(muwi(['hook', 'command', '--from', 'claude'], { input: push }).out, '');
  // 계획 없는 세션의 파일 수정도 막지 않는다
  const editing = JSON.stringify({ session_id: 'new-session', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/src/a.ts' } });
  assert.equal(muwi(['hook', '--from', 'claude'], { input: editing }).out, '');
  // 어느 도구의 훅인지 모르면 읽지 않는다 (기본 도구는 없다). 세션은 막지 않고 까닭만 남긴다
  const start = JSON.stringify({ session_id: 's9', hook_event_name: 'SessionStart', source: 'startup' });
  const unnamed = muwi(['hook'], { input: start });
  assert.equal(unnamed.code, 0);
  assert.equal(unnamed.out, '');
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /--from <도구>가 없어요/);
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
  assert.match(muwi(['config', 'nudge', 'off']).err, /바꿀 설정이 없어요/);
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

test('tool.sh claude: 볼 것만 넘기고, 세션 시작에는 지침을 돌려준다. 세션이 일하는지·말을 끝냈는지·끝났는지도 넘긴다', SH, () => {
  const { dir } = bench();
  const script = path.resolve(import.meta.dirname, '../hooks/tool.sh');
  const hook = (payload: object, ...args: string[]) =>
    spawnSync('sh', [script, 'claude', ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, MUWI_DIR: dir } }).stdout;
  const started = hook({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo' });
  assert.match(JSON.parse(started).hookSpecificOutput.additionalContext, /muwi plan --work/);
  // skill과 상관없는 파일 읽기는 기록하지 않는다
  hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/src/app.ts' } });
  hook({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'team-rules' }, tool_response: { success: true } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 's1.json'), 'utf8')).loaded), ['team-rules']);
  // 계획 없는 세션의 파일 수정에도 답하지 않는다 (0.5.x의 훅 설정이 부르는 nudge 갈래는 조용히 지나간다)
  const edit = { session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/app.ts' } };
  assert.equal(hook(edit, 'nudge'), '');
  // 사람이 말하면 일하는 중, 말을 끝내면 멈춤, 세션이 끝나면 닫힘으로 적는다 (문맥은 넣지 않는다)
  const session = () => JSON.parse(fs.readFileSync(path.join(dir, '.sessions', 's1.json'), 'utf8'));
  assert.equal(hook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '다음 일' }), '');
  assert.equal(session().turn, 'working');
  assert.equal(hook({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false }), '');
  assert.equal(session().turn, 'done');
  assert.equal(hook({ session_id: 's1', hook_event_name: 'SessionEnd', reason: 'exit' }), '');
  assert.ok(session().endedAt);
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

test('계획은 선으로 이어진 그래프다: muwi add는 자리를 꼭 받고(없으면 새 작업으로 적으라고 알린다), 계획에 끊긴 노드가 있으면 알려 준다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  const ids = () => JSON.parse(fs.readFileSync(path.join(dir, 'a', 'plan.json'), 'utf8')).nodes.map((n: any) => n.id);
  const after = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, 'a', 'plan.json'), 'utf8')).nodes.find((n: any) => n.id === id).after;
  // 자리를 주지 않았다: 짐작해서 잇지 않는다. 어느 노드 다음인지 적거나, 이 작업의 흐름에 없는 일이면 새 작업으로 적으라고 한다
  const events = () => fs.readFileSync(path.join(dir, 'a', 'events.jsonl'), 'utf8');
  const before = events();
  const guess = muwi(['add', 'pr', 'PR 올리기', '--why', '리뷰 받기']);
  assert.equal(guess.code, 2);
  assert.match(guess.err, /같은 작업: 이 작업에서 시킨 일을 이루는 일[\s\S]*새 작업: 새로 시킨 일/);
  assert.match(guess.err, /새 작업이면 이 작업에 넣지 말고 새로 적어요: muwi plan --work <새 이름>/);
  assert.match(guess.err, /같은 작업이면 어느 노드 다음인지 적어요: muwi add pr "PR 올리기" --after <노드>/);
  assert.match(guess.err, /○ check/);
  // 계획도 기록도 그대로다
  assert.deepEqual(ids(), ['read', 'impl', 'check']);
  assert.equal(events(), before);
  // 하던 노드 앞에 끼우는 것(--before만)은 자리를 준 것이다
  const ahead = muwi(['add', 'ask', '먼저 물어보기', '--before', 'impl', '--why', '먼저 확인']);
  assert.equal(ahead.code, 0, ahead.err);
  assert.ok(after('impl').includes('ask'));
  muwi(['remove', 'ask', '--why', '시험']);
  // 자리를 주면 그대로
  const added = muwi(['add', 'pr', 'PR 올리기', '--after', 'check', '--why', '리뷰 받기']);
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(after('pr'), ['check']);
  assert.doesNotMatch(added.out, /이어지지 않은 노드/);
  muwi(['add', 'lint', 'lint', '--after', 'impl', '--why', '먼저 확인']);
  assert.deepEqual(after('lint'), ['impl']);
  // 일부러 따로 두는 노드: --alone. 그래도 끊겨 있다고 알려 준다 (막지는 않는다)
  const alone = muwi(['add', 'memo', '따로 할 일', '--alone', '--why', '순서 없음']);
  assert.equal(alone.code, 0, alone.err);
  assert.deepEqual(after('memo'), []);
  assert.match(alone.out, /다른 노드와 이어지지 않은 노드가 있어요: memo/);
  // 계획을 통째로 낼 때도 after를 빼먹은 노드를 알려 준다
  const lost = muwi(['plan', '--work', 'b', JSON.stringify({ title: 't', nodes: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y', after: ['x'] }, { id: 'z', title: 'Z' }] })]);
  assert.match(lost.out, /다른 노드와 이어지지 않은 노드가 있어요: z/);
  // 선이 하나도 없는 계획도 알려 준다 (처음 계획에서 after를 빼먹은 것. 나란히 할 일일 수도 있어서 막지는 않는다)
  const flat = muwi(['plan', '--work', 'c', JSON.stringify({ title: 't', nodes: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }] })]);
  assert.equal(flat.code, 0, flat.err);
  assert.match(flat.out, /노드 사이에 선이 없어요: x, y/);
  assert.doesNotMatch(flat.out, /이어지지 않은 노드/);
  // 노드가 하나인 계획은 선이 없어도 알리지 않는다
  assert.doesNotMatch(muwi(['plan', '--work', 'd', JSON.stringify({ title: 't', nodes: [{ id: 'x', title: 'X' }] })]).out, /선이 없어요/);
});

test('앞 노드를 하는 중에 다음 노드를 시작하면, 같이 하는 거면 계획에서 나란히 두라고 알린다', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  muwi(['node', 'read', 'start']);
  muwi(['node', 'read', 'done', '읽음']);
  muwi(['node', 'impl', 'start']);
  const early = muwi(['node', 'check', 'start']).out;
  assert.match(early, /앞 노드 impl를 아직 하고 있어요. 그래프에는 계획대로 impl 다음에 그려지고/);
  assert.match(early, /check의 after를 \["read"\]으로 바꿔 muwi plan --why/);
});

test('시작을 적지 않고 끝낸 노드를 다시 시작하면 2회차다', () => {
  const { dir, muwi } = bench();
  muwi(['plan', '--work', 'w', PLAN]);
  muwi(['node', 'read', 'done', '읽음']);
  muwi(['node', 'read', 'start']);
  const read = JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8')).nodes.find((n: any) => n.id === 'read');
  assert.equal(read.attempt, 2);
  assert.match(muwi(['show', 'w']).out, /read[\s\S]*2회차/);
  // 시작을 적지 않고 막혔던 노드도 한 번 한 것이다
  muwi(['node', 'impl', 'block', '권한이 없음']);
  muwi(['node', 'impl', 'start']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'w', 'plan.json'), 'utf8')).nodes.find((n: any) => n.id === 'impl').attempt, 2);
});

test('터미널 연결과 보기 없이: 기록과 보기는 되고, 새 세션 명령은 무엇이 필요한지 알린다. 연결과 보기는 setup이 적어 둔 경로에서 불러오고, 불러오지 못해도 훅은 그대로 돈다', () => {
  const { dir, muwi } = bench();
  assert.equal(muwi(['plan', '--work', 'w', '--request', '작업해줘', PLAN]).code, 0);
  assert.match(muwi(['status']).out, /작업 중 +w/);
  assert.match(muwi(['show', 'w']).out, /연수원명 클릭 시 상세 이동/);
  // 새 세션에 맡기는 명령은 코어에 있다. 터미널 연결이 없으면 무엇이 필요한지 알린다
  const run = muwi(['run', 'impl', '구현해줘']);
  assert.equal(run.code, 1);
  assert.match(run.err, /새 세션을 띄우려면 터미널 연결이 필요한데, 붙은 연결이 없어요/);
  assert.match(muwi(['--help']).out, /muwi run <id>/);
  // 설정은 보기가 정한다
  assert.match(muwi(['config']).out, /설정이 없어요/);
  // $MUWI_VIEWS로 준 보기: 보기의 명령, 사용법, 설정, board에 더한 값이 붙는다
  const withView = { env: { MUWI_VIEWS: FAKE_VIEW, MUWI_TERMINALS: FAKE_TERMINALS } };
  assert.match(muwi(['hello', '여러분'], withView).out, /^hello 여러분/);
  assert.match(muwi(['--help'], withView).out, /시험 보기\n  muwi hello <말>[\s\S]*설치와 설정/);
  // 어느 명령이든 --help는 실행하지 않고 사용법을 보여 준다 (보기의 명령도)
  assert.match(muwi(['hello', '--help'], withView).out, /^사용법: muwi <명령>/);
  assert.match(muwi(['config'], withView).out, /demo +on +시험용 설정/);
  assert.match(muwi(['config', 'demo', 'off'], withView).out, /demo +off/);
  assert.match(muwi(['config', 'nope', 'on'], withView).err, /사용법: muwi config \[demo\] on\|off/);
  assert.equal(JSON.parse(muwi(['board'], withView).out).demo, 'from-view');
  // muwi setup은 연결과 보기의 경로를 적어 둔다. 그 뒤로는 환경 변수 없이도(훅, 보기가 부르는 명령) 같은 것을 쓴다
  assert.equal(muwi(['setup'], withView).code, 0);
  const setupFile = path.join(dir, 'setup.json');
  const saved = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
  assert.equal(saved.terminals, FAKE_TERMINALS);
  assert.deepEqual(saved.views, [{ path: FAKE_VIEW, installed: { mod: path.join(dir, 'fixture-mod') } }]);
  assert.match(muwi(['hello', '다시']).out, /^hello 다시/);
  // 적어 둔 보기가 없어졌으면 보기 없이 돈다. 훅도 그대로 지침을 돌려준다
  fs.writeFileSync(setupFile, JSON.stringify({ ...saved, views: [{ path: '/no/such/view.ts' }] }));
  assert.doesNotMatch(muwi(['--help']).out, /muwi hello/);
  assert.match(muwi(['hello']).err, /모르는 명령: hello\. 적어 둔 모듈을 불러오지 못했어요: .*no.such.view\.ts/);
  const hook = muwi(['hook', '--from', 'claude'], { session: null, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(hook.code, 0);
  assert.match(JSON.parse(hook.out).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
});

test('적어 둔 보기를 불러오지 못할 때: 업데이트 뒤에 다시 맞춰도 기록을 잃지 않고, 까닭을 남기고, 뺄 때 알린다', () => {
  const { dir, muwi } = bench();
  assert.equal(muwi(['setup'], { env: { MUWI_VIEWS: FAKE_VIEW } }).code, 0);
  const setupFile = path.join(dir, 'setup.json');
  const mod = path.join(dir, 'fixture-mod');
  assert.ok(fs.existsSync(mod));
  // muwi를 업데이트했는데(기록된 버전이 다르다) 보기 패키지는 옮겨져서 불러오지 못한다
  const lost = { path: '/no/such/view.ts', installed: { mod } };
  fs.writeFileSync(setupFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(setupFile, 'utf8')), version: '0.0.1', views: [lost] }));
  const hook = muwi(['hook', '--from', 'claude'], { session: null, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(hook.code, 0);
  const after = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
  assert.notEqual(after.version, '0.0.1');
  assert.deepEqual(after.views, [lost]);
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /불러오지 못했어요: .*no.such.view\.ts/);
  // 보기 없이 빼면 그 보기가 넣은 것은 모르므로 알린다
  const removed = muwi(['setup', '--remove']);
  assert.equal(removed.code, 0, removed.err);
  assert.match(removed.out, /보기를 불러오지 못해서 그 보기가 넣은 것은 빼지 못했어요: .*no.such.view\.ts/);
});

test('setup.json이 깨져도 명령과 훅은 돈다 (훅은 지침을 준다). muwi setup은 새로 적는다', () => {
  const { dir, muwi } = bench();
  const setupFile = path.join(dir, 'setup.json');
  fs.writeFileSync(setupFile, '{"root": "/x", "version"');
  assert.equal(muwi(['status']).code, 0);
  const hook = muwi(['hook', '--from', 'claude'], { session: null, input: JSON.stringify({ session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }) });
  assert.equal(hook.code, 0);
  assert.match(JSON.parse(hook.out).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
  assert.match(fs.readFileSync(path.join(dir, '.hook-errors.log'), 'utf8'), /setup\.json \(JSON이 아니에요\)/);
  const setup = muwi(['setup']);
  assert.equal(setup.code, 0, setup.err);
  assert.match(setup.out, /새로 적어요/);
  assert.equal(JSON.parse(fs.readFileSync(setupFile, 'utf8')).root, path.resolve(import.meta.dirname, '..'));
});

test('삭제: 보관한 작업만 지운다 (끝 → 보관 → 삭제). 작업 폴더를 통째로 휴지통에 옮기고, 되살리면 보관함으로 돌아온다', () => {
  const { dir, muwi } = bench();
  const one = JSON.stringify({ title: '끝낼 작업', nodes: [{ id: 'a', title: 'A' }] });
  // fin은 세션 s2가 맡았다 (지운 뒤에 그 세션이 적으려 하는지 본다)
  for (const w of ['fin', 'fin2', 'kept']) {
    const session = w === 'fin' ? 's2' : 'lead';
    muwi(['plan', '--work', w, '--request', '끝내 줘', one], { session });
    muwi(['node', 'a', 'start', '--work', w], { session });
    muwi(['node', 'a', 'done', '--work', w], { session });
  }
  fs.writeFileSync(path.join(dir, 'fin', 'review.md'), '리뷰');
  const summary = (work: string) => JSON.parse(muwi(['status', '--json', '--all']).out).works.find((w: any) => w.work === work);
  // 보관하지 않은 작업은 지우지 않는다. 하나라도 안 되면 아무것도 지우지 않는다
  muwi(['archive', 'fin', 'fin2']);
  const refused = muwi(['delete', 'fin', 'kept']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /보관한 작업만 지워요 \(끝 → 보관 → 삭제\): kept/);
  assert.ok(fs.existsSync(path.join(dir, 'fin')));
  assert.equal(muwi(['delete', 'nope']).code, 1);
  // 지우면 목록과 폴더에서 빠지고, 폴더는 통째로 휴지통에 있다 (그 폴더에 둔 파일까지)
  assert.match(muwi(['delete', 'fin']).out, /^fin: 지웠어요\. 30일 동안 휴지통에 있어요/);
  assert.equal(summary('fin'), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'fin')));
  const trashed = fs.readdirSync(path.join(dir, '.trash'));
  assert.equal(trashed.length, 1);
  assert.match(trashed[0], /^\d+-fin$/);
  assert.equal(fs.readFileSync(path.join(dir, '.trash', trashed[0], 'review.md'), 'utf8'), '리뷰');
  assert.match(muwi(['restore']).out, /^fin  .+에 지움 · 30일 남음/);
  // 지운 작업에 붙어 있던 세션은 그 작업에 더 적지 않는다 (계획이 없다)
  const late = muwi(['node', 'a', 'start'], { session: 's2' });
  assert.equal(late.code, 1);
  assert.match(late.err, /어느 작업인지 알 수 없어요/);
  assert.ok(!fs.existsSync(path.join(dir, 'fin')));
  // 되살리면 보관한 채로 돌아온다
  assert.match(muwi(['restore', 'fin']).out, /fin: 되살렸어요\. 보관함에 있어요/);
  assert.equal(summary('fin').archived, true);
  assert.equal(fs.readFileSync(path.join(dir, 'fin', 'review.md'), 'utf8'), '리뷰');
  assert.match(muwi(['restore', 'fin']).err, /휴지통에 없는 작업이에요: fin/);
  // 보관한 작업을 모두 지운다. 같은 이름의 작업이 새로 생겼으면 되살리지 않는다
  const all = muwi(['delete', '--archived']).out;
  assert.match(all, /^fin: 지웠어요/m);
  assert.match(all, /^fin2: 지웠어요/m);
  assert.equal(summary('kept').archived, undefined);
  assert.match(muwi(['delete', '--archived']).out, /지울 보관한 작업이 없어요/);
  muwi(['plan', '--work', 'fin', '--request', '같은 이름', one]);
  assert.match(muwi(['restore', 'fin']).err, /같은 이름의 작업이 있어서 되살리지 않았어요: fin/);
  assert.match(muwi(['restore', 'fin2']).out, /fin2: 되살렸어요/);
});

test('삭제 뒤: 그 작업에 적으려는 명령은 빈 폴더를 남기지 않고, 그 작업을 하던 세션은 같은 이름으로 다시 만들지 않으며, 되살리기는 막히지 않는다', () => {
  const { dir, muwi } = bench();
  const one = JSON.stringify({ title: '끝낼 작업', nodes: [{ id: 'a', title: 'A' }] });
  const finish = (w: string, session: string) => {
    muwi(['plan', '--work', w, '--request', '끝내 줘', one], { session });
    muwi(['node', 'a', 'start', '--work', w], { session });
    muwi(['node', 'a', 'done', '--work', w], { session });
    muwi(['archive', w]);
  };
  finish('fin', 's2');
  finish('other', 'lead');
  // 이름만 받는다 (경로를 주면 다른 폴더를 옮길 수 있다). --archived와 이름은 같이 주지 않는다
  assert.match(muwi(['delete', '../fin']).err, /작업 이름에는 글자, 숫자/);
  assert.match(muwi(['delete', '--archived', 'fin']).err, /--archived와 작업 이름을 같이 주지 않아요/);
  assert.ok(fs.existsSync(path.join(dir, 'fin')));
  assert.equal(muwi(['delete', 'fin']).code, 0);
  // --work를 붙여 적어도 계획이 없어 실패하고, 빈 폴더를 남기지 않는다
  for (const args of [['node', 'a', 'start', '--work', 'fin'], ['add', 'b', 'B', '--work', 'fin'], ['remove', 'a', '--why', 'x', '--work', 'fin']]) {
    assert.equal(muwi(args, { session: 's2' }).code, 1, args.join(' '));
    assert.ok(!fs.existsSync(path.join(dir, 'fin')), args.join(' '));
  }
  // 그 작업을 하던 세션이나 계획을 고치려는(--why) 쪽은 같은 이름으로 다시 만들지 않는다
  const again = muwi(['plan', '--work', 'fin', '--request', '이어서', one], { session: 's2' });
  assert.equal(again.code, 1);
  assert.match(again.err, /fin: 지운 작업이에요 \(휴지통에 있어요\)\. 이어서 하려면 사람이 muwi restore fin/);
  assert.equal(muwi(['plan', '--work', 'fin', '--why', '고침', one], { session: 'lead' }).code, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'fin')));
  // 빈 폴더만 남아 있으면 치우고 되살린다. 여럿 중 하나가 안 돼도 나머지는 되살린다
  fs.mkdirSync(path.join(dir, 'fin'));
  assert.equal(muwi(['delete', 'other']).code, 0);
  const both = muwi(['restore', 'nope', 'fin', 'other']);
  assert.equal(both.code, 1);
  assert.match(both.err, /휴지통에 없는 작업이에요: nope/);
  assert.match(both.out, /^fin: 되살렸어요/m);
  assert.match(both.out, /^other: 되살렸어요/m);
  assert.ok(fs.existsSync(path.join(dir, 'fin', 'plan.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'fin', '.lock')));
  // 계획 없는 폴더에 파일이 남아 있으면 덮어쓰지 않는다
  assert.equal(muwi(['delete', 'fin']).code, 0);
  fs.mkdirSync(path.join(dir, 'fin'));
  fs.writeFileSync(path.join(dir, 'fin', 'note.md'), '남은 것');
  assert.match(muwi(['restore', 'fin']).err, /폴더가 남아 있어서 되살리지 않았어요/);
  // 다른 세션이 지운 이름으로 새로 시작하는 것은 막지 않는다
  fs.rmSync(path.join(dir, 'fin'), { recursive: true });
  assert.equal(muwi(['plan', '--work', 'fin', '--request', '새 일', one], { session: 's3' }).code, 0);
});

test('보관: 끝났거나 멈춘 작업을 목록에서 치우고, 기록은 그대로 두고, 다시 시작하면 목록으로 돌아온다', () => {
  const { muwi } = bench();
  const one = JSON.stringify({ title: '끝낼 작업', nodes: [{ id: 'a', title: 'A' }] });
  muwi(['plan', '--work', 'fin', '--request', '끝내 줘', one]);
  muwi(['node', 'a', 'start', '--work', 'fin']);
  muwi(['node', 'a', 'done', '--work', 'fin']);
  muwi(['plan', '--work', 'busy', '--request', '하는 중', one]);
  muwi(['node', 'a', 'start', '--work', 'busy']);
  const summary = (work: string) => JSON.parse(muwi(['status', '--json']).out).works.find((w: any) => w.work === work);
  // 하는 중인 작업은 보관하지 않는다. 하나라도 안 되면 아무것도 적지 않는다
  const refused = muwi(['archive', 'fin', 'busy']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /아직 하는 중이라 보관하지 않아요: busy\(작업 중\)/);
  assert.equal(summary('fin').archived, undefined);
  // 보관하면 목록에서 빠진다. 끝난 때는 그대로다 (보관은 작업이 바뀐 것이 아니다)
  const finishedAt = summary('fin').updatedAt;
  assert.match(muwi(['archive', 'fin']).out, /fin: 보관했어요/);
  assert.equal(summary('fin').archived, true);
  assert.equal(summary('fin').updatedAt, finishedAt);
  const listed = muwi(['status']).out;
  assert.doesNotMatch(listed, / fin /);
  assert.match(listed, /보관한 작업 1개는 뺐어요/);
  assert.match(muwi(['status', '--all']).out, /보관 +fin /);
  assert.match(muwi(['show', 'fin']).out, /끝낼 작업/);
  assert.match(muwi(['archive', 'fin']).out, /fin: 이미 보관했어요/);
  // 다시 시작하면 목록으로 돌아온다
  muwi(['node', 'a', 'start', '--work', 'fin']);
  assert.equal(summary('fin').archived, undefined);
  muwi(['node', 'a', 'done', '--work', 'fin']);
  // 끝난 작업을 모두 보관하고, 꺼낸다
  assert.match(muwi(['archive', '--done']).out, /^fin: 보관했어요/);
  assert.equal(summary('busy').archived, undefined);
  assert.match(muwi(['unarchive', 'fin']).out, /fin: 목록으로 꺼냈어요/);
  assert.equal(summary('fin').archived, undefined);
  assert.match(muwi(['unarchive', 'fin']).out, /fin: 보관한 작업이 아니에요/);
});

test('muwi board: 그래프는 실제 흐름대로 그린 카드와 선(drawn)으로 배치한다. 다시 한 회차는 그 사이에 끝난 노드 뒤에 새 카드로', () => {
  const { muwi } = bench();
  muwi(['plan', '--work', 'a', PLAN]);
  for (const [id, what] of [['read', 'start'], ['read', 'done'], ['impl', 'start'], ['impl', 'done'], ['check', 'start'], ['check', 'done'], ['impl', 'start']]) muwi(['node', id, what]);
  const g = JSON.parse(muwi(['board', '--work', 'a']).out).selected;
  // 계획의 선은 그대로다
  assert.deepEqual(g.edges.map((e: any) => `${e.from}>${e.to}`).sort(), ['impl>check', 'read>impl']);
  assert.deepEqual(g.drawn.cards.map((c: any) => c.id), ['read', 'impl', 'impl#2', 'check']);
  assert.deepEqual(g.drawn.edges.map((e: any) => `${e.from}>${e.to}`).sort(), ['check>impl#2', 'impl>check', 'read>impl']);
  // 배치는 그 카드들로 한다. 그리는 방향(flow)과 이름이 겹치지 않는다
  assert.deepEqual(g.layout.nodes.map((n: any) => n.id).sort(), ['check', 'impl', 'impl#2', 'read']);
  assert.equal(g.flow, 'right');
  assert.deepEqual(g.layoutProblems, []);
});

test('muwi board: 작업을 고르지 않으면 보관한 작업은 맨 위여도 고르지 않는다 (모두 보관했으면 고른 작업이 없다)', () => {
  const { muwi } = bench();
  const one = JSON.stringify({ title: '끝낼 작업', nodes: [{ id: 'a', title: 'A' }] });
  for (const work of ['old', 'new']) {
    muwi(['plan', '--work', work, '--request', '끝내 줘', one]);
    muwi(['node', 'a', 'start', '--work', work]);
    muwi(['node', 'a', 'done', '--work', work]);
  }
  const top = () => JSON.parse(muwi(['board']).out);
  // 나중에 끝난 작업이 맨 위다
  assert.equal(top().works[0].work, 'new');
  assert.equal(top().selected.work, 'new');
  // 보관하면 목록에는 남아도(보관함) 고르지 않는다. 일부러 고르면 그대로 준다
  assert.match(muwi(['archive', 'new']).out, /new: 보관했어요/);
  assert.equal(top().works.find((w: any) => w.work === 'new').archived, true);
  assert.equal(top().selected.work, 'old');
  assert.equal(JSON.parse(muwi(['board', '--work', 'new']).out).selected.work, 'new');
  // 모두 보관했으면 아무것도 고르지 않는다. 작업 목록에는 그대로 있다 (보관함)
  muwi(['archive', 'old']);
  assert.equal(top().selected, null);
  assert.deepEqual(top().works.map((w: any) => w.work).sort(), ['new', 'old']);
});

test('muwi update: npm으로 전역에 깐 muwi가 아니면(저장소에서 돌리면) 올리지 않고 까닭을 알린다', () => {
  const { muwi } = bench();
  const r = muwi(['update']);
  assert.equal(r.code, 1);
  assert.match(r.err, /npm으로 전역에 깐 muwi가 아니라서 여기서 올릴 수 없어요/);
});
