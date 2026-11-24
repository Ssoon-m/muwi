import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { afterCommand, cacheFile, checkLatest, decide, installedPackage, notice, type UpdateCache } from '../src/update.ts';

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
  assert.match(first.said, /새 버전이 나왔어요: 0\.7\.0 → 0\.7\.1\n {2}npm i -g @muwi\/core@latest\n {2}바뀐 것: https:\/\/github\.com\/Ssoon-m\/muwi\/releases\/tag\/v0\.7\.1/);
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
