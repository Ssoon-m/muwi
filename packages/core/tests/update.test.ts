import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { afterCommand, cacheFile, checkLatest, decide, installedPackage, notice, updateTarget, type UpdateCache } from '../src/update.ts';
import { handleHook } from '../src/hook.ts';
import { readSession } from '../src/session.ts';

const HOUR = 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-update-'));

/** npm으로 깐 것처럼 패키지 폴더를 만든다 (src/cli.js가 있으면 npm으로 받은 판이다) */
function pkg(dir: string, name: string, built = true) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.7.0' }));
  fs.writeFileSync(path.join(dir, 'src', built ? 'cli.js' : 'cli.ts'), '');
  return dir;
}

test('새 버전 알림: 캐시만 보고 알릴지와 다시 물어볼지를 정한다', () => {
  const now = 100 * 24 * HOUR;
  const c = (x: Partial<UpdateCache>): UpdateCache => ({ name: '@muwi/herdr-app', ...x });
  // 물어본 적이 없으면 알릴 것은 없고 물어본다
  assert.deepEqual(decide(null, '@muwi/herdr-app', '0.7.0', now), { tell: undefined, refresh: true });
  // 하루 안에 물어봤고 더 새 판이 있으면 알린다
  assert.deepEqual(decide(c({ latest: '0.7.1', checkedAt: now - HOUR }), '@muwi/herdr-app', '0.7.0', now), { tell: '0.7.1', refresh: false });
  // 같거나 낮으면 알리지 않는다
  assert.equal(decide(c({ latest: '0.7.0', checkedAt: now - HOUR }), '@muwi/herdr-app', '0.7.0', now).tell, undefined);
  assert.equal(decide(c({ latest: '0.6.9', checkedAt: now - HOUR }), '@muwi/herdr-app', '0.7.0', now).tell, undefined);
  // 하루 안에 이미 알렸으면 다시 알리지 않는다. 하루가 지나면 다시 알린다
  assert.equal(decide(c({ latest: '0.7.1', checkedAt: now - HOUR, toldAt: now - 2 * HOUR }), '@muwi/herdr-app', '0.7.0', now).tell, undefined);
  assert.equal(decide(c({ latest: '0.7.1', checkedAt: now - HOUR, toldAt: now - 25 * HOUR }), '@muwi/herdr-app', '0.7.0', now).tell, '0.7.1');
  // 하루가 지났으면 다시 물어본다 (알 수 있는 것은 그대로 알린다)
  assert.deepEqual(decide(c({ latest: '0.7.1', checkedAt: now - 25 * HOUR }), '@muwi/herdr-app', '0.7.0', now), { tell: '0.7.1', refresh: true });
  // 다른 패키지를 물어본 캐시는 쓰지 않는다 (코어만 깔았다가 화면으로 바꿨을 때)
  assert.deepEqual(decide({ name: '@muwi/core', latest: '0.9.0', checkedAt: now - HOUR }, '@muwi/herdr-app', '0.7.0', now), { tell: undefined, refresh: true });
});

test('새 버전 알림: 업데이트 명령에 쓸 패키지는 사람이 npm으로 깐 패키지다', () => {
  const t = tmp();
  // 저장소에서 .ts로 돌 때는 묻지 않는다
  assert.equal(installedPackage(pkg(path.join(t, 'repo', 'packages', 'core'), '@muwi/core', false)), null);
  // 코어만 깔았다
  assert.equal(installedPackage(pkg(path.join(t, 'g1', 'lib', 'node_modules', '@muwi', 'core'), '@muwi/core')), '@muwi/core');
  // 다른 muwi 패키지(@muwi/herdr-app)를 깔았다: 코어는 그 안에 따라 들어온다. 보기를 아직 적어 두지 않았어도 안다
  const herdr = pkg(path.join(t, 'g2', 'lib', 'node_modules', '@muwi', 'herdr-app'), '@muwi/herdr-app');
  const nested = pkg(path.join(herdr, 'node_modules', '@muwi', 'core'), '@muwi/core');
  assert.equal(installedPackage(nested), '@muwi/herdr-app');
  // 보기나 터미널 연결을 불러왔으면 그 패키지로 안다 (pnpm처럼 코어가 다른 자리에 있어도). 보기가 먼저다
  const elsewhere = pkg(path.join(t, 'g3', 'store', '@muwi', 'core'), '@muwi/core');
  assert.equal(installedPackage(elsewhere, ['@muwi/herdr-app', '@muwi/herdr']), '@muwi/herdr-app');
  assert.equal(installedPackage(elsewhere, [undefined, '@muwi/herdr']), '@muwi/herdr');
});

test('새 버전 알림: 사람이 터미널에서 친 명령에서만, 하루 한 번 알리고 npm에는 따로 묻는다', () => {
  const t = tmp();
  const root = pkg(path.join(t, 'lib', 'node_modules', '@muwi', 'core'), '@muwi/core');
  const env = { HOME: path.join(t, 'home') } as NodeJS.ProcessEnv;
  const file = cacheFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = 100 * 24 * HOUR;
  fs.writeFileSync(file, JSON.stringify({ name: '@muwi/core', latest: '0.7.1', checkedAt: now - HOUR }));
  const run = (o: { cmd?: string; tty?: boolean; env?: NodeJS.ProcessEnv; at?: number } = {}) => {
    const said: string[] = [];
    const asked: string[] = [];
    afterCommand({ cmd: o.cmd ?? 'status', current: '0.7.0', root, env: o.env ?? env, tty: o.tty ?? true, now: o.at ?? now, write: x => said.push(x), check: name => asked.push(name) });
    return { said: said.join(''), asked };
  };
  // AI 도구가 실행한 명령(터미널이 아님), 훅, 그래프 칸, 끈 경우에는 조용하다
  assert.deepEqual(run({ tty: false }), { said: '', asked: [] });
  assert.deepEqual(run({ cmd: 'hook' }), { said: '', asked: [] });
  assert.deepEqual(run({ cmd: 'board' }), { said: '', asked: [] });
  assert.deepEqual(run({ env: { ...env, MUWI_NO_UPDATE_CHECK: '1' } }), { said: '', asked: [] });
  assert.deepEqual(run({ env: { ...env, CI: 'true' } }), { said: '', asked: [] });
  // 사람이 친 명령: 알리고, 오늘은 이미 물어봤으니 다시 묻지 않는다
  const first = run();
  assert.equal(first.said, notice('@muwi/core', '0.7.0', '0.7.1'));
  assert.match(first.said, /새 버전이 나왔어요: 0\.7\.0 → 0\.7\.1\n {2}muwi update\n {2}바뀐 것: https:\/\/github\.com\/Ssoon-m\/muwi\/releases\/tag\/v0\.7\.1/);
  assert.deepEqual(first.asked, []);
  // 같은 날 다음 명령은 조용하다
  assert.deepEqual(run({ at: now + HOUR }), { said: '', asked: [] });
  // 하루가 지나면 다시 알리고, npm에 다시 묻는다
  const later = run({ at: now + 25 * HOUR });
  assert.match(later.said, /0\.7\.0 → 0\.7\.1/);
  assert.deepEqual(later.asked, ['@muwi/core']);
  // 캐시가 깨져 있어도 명령은 실패하지 않는다
  fs.writeFileSync(file, '{깨짐');
  assert.deepEqual(run({ at: now + 50 * HOUR }), { said: '', asked: ['@muwi/core'] });
});

test('새 버전 알림: npm의 latest를 물어 캐시에 적고, 답이 없어도 하루 동안은 다시 묻지 않는다', async () => {
  const t = tmp();
  const file = path.join(t, 'cache', 'update.json');
  let latest = '0.7.3';
  let asked = '';
  const server = http.createServer((req, res) => {
    asked = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest, rc: '0.8.0-rc.0' }));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await checkLatest('@muwi/herdr-app', file, registry, 1000);
    assert.equal(asked, '/-/package/@muwi%2fherdr-app/dist-tags');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '@muwi/herdr-app', latest: '0.7.3', checkedAt: 1000 });
    // 알린 때는 지키고 latest만 바꾼다
    fs.writeFileSync(file, JSON.stringify({ name: '@muwi/herdr-app', latest: '0.7.3', checkedAt: 1000, toldAt: 1500 }));
    latest = '0.7.4';
    await checkLatest('@muwi/herdr-app', file, registry, 2000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '@muwi/herdr-app', latest: '0.7.4', checkedAt: 2000, toldAt: 1500 });
  } finally {
    await new Promise(ok => server.close(ok));
  }
  // npm이 답하지 않으면(오프라인) 아는 latest를 두고 물어본 때만 적는다
  await checkLatest('@muwi/herdr-app', file, registry, 3000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { name: '@muwi/herdr-app', latest: '0.7.4', checkedAt: 3000, toldAt: 1500 });
});

test('muwi update가 받을 곳: 지금 도는 muwi가 깔린 npm 전역 자리와 사람이 깐 패키지, 그 자리의 Node와 같은 폴더의 npm', () => {
  const t = tmp();
  // macOS·Linux: <자리>/lib/node_modules/@muwi/herdr-app 안에 코어가 따라 들어왔다
  const prefix = path.join(t, 'node-v24');
  const app = pkg(path.join(prefix, 'lib', 'node_modules', '@muwi', 'herdr-app'), '@muwi/herdr-app');
  const core = pkg(path.join(app, 'node_modules', '@muwi', 'core'), '@muwi/core');
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'bin', 'npm'), '');
  const node = path.join(prefix, 'bin', 'node');
  assert.deepEqual(updateTarget(core, [], 'linux', node), { name: '@muwi/herdr-app', prefix, npm: path.join(prefix, 'bin', 'npm'), bin: path.join(prefix, 'bin', 'muwi') });
  // 코어만 깔았다
  const alone = pkg(path.join(t, 'p2', 'lib', 'node_modules', '@muwi', 'core'), '@muwi/core');
  assert.equal(updateTarget(alone, [], 'linux', node)?.prefix, path.join(t, 'p2'));
  // Windows: <자리>/node_modules/@muwi/herdr-app, 명령은 <자리>/muwi.cmd. 그 Node 옆에 npm이 없으면 PATH의 npm
  const wprefix = path.join(t, 'npm');
  const wapp = pkg(path.join(wprefix, 'node_modules', '@muwi', 'herdr-app'), '@muwi/herdr-app');
  const wcore = pkg(path.join(wapp, 'node_modules', '@muwi', 'core'), '@muwi/core');
  assert.deepEqual(updateTarget(wcore, [], 'win32', path.join(t, 'nodejs', 'node.exe')), { name: '@muwi/herdr-app', prefix: wprefix, npm: 'npm.cmd', bin: path.join(wprefix, 'muwi.cmd') });
  // 프로젝트 안에 깐 것과 저장소에서 돌리는 것은 다루지 않는다
  const local = pkg(path.join(t, 'project', 'node_modules', '@muwi', 'core'), '@muwi/core');
  assert.equal(updateTarget(local, [], 'linux', node), null);
  assert.equal(updateTarget(pkg(path.join(t, 'repo'), '@muwi/core', false), [], 'linux', node), null);
});

test('대화 자리의 새 판 알림: 세션이 시작될 때와 사람이 말할 때, 같은 판은 세션마다 한 번. Claude Code는 화면에 바로, 다른 도구는 AI가 전한다', () => {
  const t = tmp();
  // npm으로 깐 코어 0.9.0. 캐시에는 오늘 물어본 결과(0.10.0)가 있다 (npm에 다시 묻지 않는다)
  const root = pkg(path.join(t, 'prefix', 'lib', 'node_modules', '@muwi', 'core'), '@muwi/core');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@muwi/core', version: '0.9.0' }));
  const env = { HOME: t, XDG_CACHE_HOME: path.join(t, 'cache') } as NodeJS.ProcessEnv;
  const file = cacheFile(env);
  const cached = (latest: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: '@muwi/core', latest, checkedAt: Date.now() }));
  };
  cached('0.10.0');
  const dir = path.join(t, 'records');
  const hook = (tool: string, payload: object, e = env) => handleHook(tool, payload, dir, 'record', e, root);
  // Claude Code: 사람에게 바로 보여 주는 systemMessage (AI의 문맥에는 넣지 않는다)
  const start = JSON.parse(hook('claude', { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' }).stdout!);
  assert.match(start.systemMessage, /muwi 0\.10\.0이 나왔어요 \(지금 0\.9\.0\)\. 업데이트: muwi update/);
  assert.doesNotMatch(JSON.stringify(start.hookSpecificOutput ?? {}), /0\.10\.0/);
  assert.equal(readSession(dir, 's1')!.toldUpdate, '0.10.0');
  // 같은 판은 그 세션에 다시 알리지 않는다 (다시 연 세션, 말할 때)
  assert.equal(hook('claude', { session_id: 's1', hook_event_name: 'SessionStart', source: 'resume' }).stdout, undefined);
  assert.equal(hook('claude', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '다음' }).stdout, undefined);
  // 세션 중에 더 새 판이 나왔으면 사람이 말할 때 한 번 알린다
  cached('0.11.0');
  assert.match(JSON.parse(hook('claude', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '다음' }).stdout!).systemMessage, /muwi 0\.11\.0이 나왔어요/);
  assert.equal(hook('claude', { session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '또' }).stdout, undefined);
  // 화면에 바로 띄울 수 없는 도구는 AI가 전하게 세션 시작의 문맥에 붙인다
  const codex = hook('codex', { session_id: 'c1', hook_event_name: 'SessionStart', source: 'startup' }).stdout!;
  assert.match(codex, /사용자에게 다음 한 줄을 그대로 한 번 전한다: muwi 0\.11\.0이 나왔어요/);
  assert.doesNotMatch(codex, /systemMessage/);
  // 끄면 알리지 않는다. npm으로 깐 판이 아니면(저장소) 알리지 않는다
  assert.equal(hook('claude', { session_id: 's2', hook_event_name: 'SessionStart', source: 'startup' }, { ...env, MUWI_NO_UPDATE_CHECK: '1' }).stdout, undefined);
  const repo = pkg(path.join(t, 'repo'), '@muwi/core', false);
  assert.equal(handleHook('claude', { session_id: 's3', hook_event_name: 'SessionStart', source: 'startup' }, dir, 'record', env, repo).stdout, undefined);
});

