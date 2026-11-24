#!/usr/bin/env node
// 릴리스: 모든 패키지(@muwi/core, @muwi/herdr, @muwi/herdr-app)를 같은 버전으로 올리고, 버전 커밋과 태그를 push한다.
// npm에 올리는 것은 태그를 받은 GitHub Actions(.github/workflows/release.yml)가 한다.
// CHANGELOG는 릴리스할 때 사람이 정리한다. 그 버전의 섹션이 없으면 지난 릴리스 이후 커밋을 패키지별로 보여 주고 멈춘다.
//   pnpm release 0.7.1             CHANGELOG를 확인하고 버전 커밋과 v0.7.1 태그를 push한다
//   pnpm release 0.7.1 --dry-run   무엇을 할지만 보여 준다
//   node scripts/release.mjs verify 0.7.1   (release.yml) 모든 패키지 버전과 CHANGELOG 섹션이 맞는지
//   node scripts/release.mjs notes 0.7.1    (release.yml) 그 버전의 CHANGELOG 내용. GitHub 릴리스 노트로 쓴다
//   node scripts/release.mjs registered     (release.yml) 모든 패키지가 npm에 있는지. 처음 올리는 패키지가 있으면 멈춘다
//   pnpm release stage                      npm에 아직 없는 패키지의 자리를 잡는다 (npm stage publish. npm이 0.0.0-stage를 만든다). npm 로그인이 필요하다
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/** 함께 올리는 패키지 (packages/<폴더>). 기대는 패키지보다 먼저 온다: 코어 → 터미널 연결 → 보기 */
const PACKAGES = [
  { folder: 'core', name: '@muwi/core' },
  { folder: 'herdr', name: '@muwi/herdr' },
  { folder: 'herdr-app', name: '@muwi/herdr-app' },
];
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const REMOTE = 'origin';
const BRANCH = 'main';
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** 사람에게 알리고 멈출 때 (오류 위치 없이 메시지만 보여 준다) */
class Stop extends Error {}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};
const manifestFile = folder => path.join(ROOT, 'packages', folder, 'package.json');
const versionOf = folder => JSON.parse(fs.readFileSync(manifestFile(folder), 'utf8')).version;
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (이 컴퓨터의 날짜)

function checkVersion(version) {
  if (!version || !VERSION.test(version)) throw new Stop(`버전을 적어 주세요 (예: 0.7.1). 받은 값: ${version ?? '없음'}`);
}

/** a가 b보다 높은 버전인가. 시험판(0.8.0-beta.1)은 같은 번호의 정식판보다 낮다 */
export function higher(a, b) {
  const split = v => {
    const [main, pre = ''] = v.split(/-(.*)/s);
    return { nums: main.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i];
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}

/** CHANGELOG에서 그 버전의 섹션: "## <버전> (" 줄부터 다음 "## " 줄 전까지. 없으면 null */
export function section(text, version) {
  const lines = text.split('\n');
  const head = `## ${version} (`;
  const start = lines.findIndex(l => l.startsWith(head));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return { heading: lines[start], body: lines.slice(start + 1, end).join('\n').trim() };
}

/** 그 버전의 CHANGELOG 섹션을 찾고, 항목(- 로 시작하는 줄)이 있는지 본다 */
function notesOf(version) {
  const found = section(fs.readFileSync(CHANGELOG, 'utf8'), version);
  if (!found) return null;
  if (!/^\s*[-*] /m.test(found.body)) throw new Stop(`CHANGELOG.md의 "${found.heading}" 아래에 적은 항목이 없어요.`);
  return found.body;
}

/** 지난 릴리스 태그 이후 커밋을 패키지별로 모은다. 한 커밋이 여러 곳을 바꿨으면 각 묶음에 나온다 */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = (...paths) => (tryGit('log', '--no-merges', '--format=%h %s', range, '--', ...paths) || '').split('\n').filter(Boolean);
  return [
    ...PACKAGES.map(p => ({ title: p.name, commits: log(`packages/${p.folder}`) })),
    { title: '문서·저장소', commits: log('.', ...PACKAGES.map(p => `:(exclude)packages/${p.folder}`)) },
  ];
}

function missingNotes(version) {
  const tag = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*');
  const groups = commitsSince(tag)
    .map(g => `${g.title}\n${g.commits.length ? g.commits.map(c => `  ${c}`).join('\n') : '  (바뀐 것 없음)'}`)
    .join('\n');
  return [
    `CHANGELOG.md에 "## ${version} (날짜)"가 없어요. ${tag ?? '처음'} 이후 커밋을 보고 맨 위에 정리한 뒤 다시 실행하세요.`,
    '',
    groups,
    '',
    '적는 모양 (패키지별 소제목, 여럿에 해당하면 ### 공통):',
    '',
    `## ${version} (${today()})`,
    '',
    '### @muwi/herdr-app',
    '',
    '#### 수정',
    '',
    '- …',
  ].join('\n');
}

// ---- 처음 올리는 패키지
// Actions는 Trusted Publishing(토큰 없이)으로 올린다. Trusted Publisher는 npm에 이미 있는 패키지에만 등록할 수 있다.
// 새 패키지는 사람이 한 번 npm의 staged publishing으로 자리를 잡는다: 없는 패키지를 stage하면 npm이 0.0.0-stage를 공개로 올려
// 패키지가 생긴다 (0.0.0-stage는 npm이 쓰는 번호라 직접 올릴 수 없다). stage한 판은 승인하기 전에는 공개되지 않는다.
// 그 전에 태그를 달면 앞 패키지만 올라가고 새 패키지에서 멈춰 패키지마다 버전이 어긋난다. 그래서 릴리스 앞뒤에서 확인한다

/** 자리를 잡으려고 stage하는 판. 승인하지 않고 거절한다 */
const INIT = '0.0.0-init';
const npmCmd = (args, o = {}) => execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', ...o });

/** npm에 아직 없는 패키지들. npm에 물어보지 못하면(네트워크 등) 멈춘다 */
export function missingOnNpm(view = name => npmCmd(['view', name, 'name'])) {
  const missing = [];
  for (const p of PACKAGES) {
    try {
      view(p.name);
    } catch (e) {
      const said = `${e.stderr ?? ''}${e.message ?? ''}`;
      if (/E404|404 Not Found|is not in this registry/.test(said)) missing.push(p);
      else throw new Stop(`npm에 ${p.name}이 있는지 확인하지 못했어요: ${said.trim().split('\n')[0]}`);
    }
  }
  return missing;
}

function firstPublishHelp(missing) {
  return [
    `npm에 아직 없는 패키지가 있어요: ${missing.map(p => p.name).join(', ')}`,
    'Actions는 Trusted Publishing으로 올리는데, Trusted Publisher는 npm에 있는 패키지에만 등록할 수 있어요. 릴리스 전에 한 번만 하세요.',
    '  1. npm login 뒤 pnpm release stage   (npm stage publish로 자리를 잡아요. npm이 0.0.0-stage를 만들어요)',
    ...missing.map(p => `  2. https://www.npmjs.com/package/${p.name}/access 의 Trusted Publisher에 GitHub Actions, Ssoon-m/muwi, release.yml 등록`),
    '  3. 다시 실행하세요',
  ].join('\n');
}

/** 태그를 받은 Actions가 아무것도 올리기 전에 부른다 */
function registered() {
  const missing = missingOnNpm();
  if (missing.length) throw new Stop(firstPublishHelp(missing));
  console.log(`npm에 모든 패키지가 있어요: ${PACKAGES.map(p => p.name).join(', ')}`);
}

/**
 * npm에 없는 패키지의 자리를 잡는다: package.json과 README만 든 0.0.0-init을 stage한다 (npm 11.15 이상).
 * npm이 0.0.0-stage를 공개로 올려 패키지가 생기고, stage한 0.0.0-init은 승인하지 않으면 공개되지 않는다. 이미 있는 패키지는 건드리지 않는다
 */
function stage(dryRun) {
  const missing = missingOnNpm();
  if (!missing.length) {
    console.log('npm에 없는 패키지가 없어요. 할 일이 없어요.');
    return;
  }
  if (!dryRun) {
    try {
      npmCmd(['whoami']);
    } catch {
      throw new Stop('npm에 로그인하지 않았어요. npm login 뒤에 다시 실행하세요.');
    }
  }
  for (const p of missing) {
    if (dryRun) {
      console.log(`--dry-run: ${p.name}@${INIT}를 stage할 거예요 (npm이 ${p.name}@0.0.0-stage를 만들어요)`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile(p.folder), 'utf8'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-stage-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: p.name, version: INIT, description: 'muwi 릴리스 전에 패키지 자리를 잡으려고 stage한 판 (승인하지 않는다)',
      license: manifest.license, repository: manifest.repository,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${p.name}\n\nmuwi 릴리스 전에 패키지 자리를 잡으려고 stage한 판입니다. https://github.com/Ssoon-m/muwi\n`);
    // 로그인을 묻는 프롬프트가 보이도록 입출력을 이 터미널에 잇는다. 시험판이라 태그를 꼭 단다 (latest가 아닌 init)
    try {
      npmCmd(['stage', 'publish', '--access', 'public', '--tag', 'init'], { cwd: dir, stdio: 'inherit' });
    } catch {
      throw new Stop(`npm에 stage하지 못했어요: ${p.name}@${INIT} (위의 npm 메시지를 보세요. npm 11.15 이상이 필요해요)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log([
      `자리를 잡았어요: ${p.name} (npm이 0.0.0-stage를 만들어요)`,
      `  stage한 ${INIT}은 쓰지 않아요. 거절하세요: npm stage list ${p.name} → npm stage reject <stage-id> (2단계 인증)`,
      `  Trusted Publisher 등록: https://www.npmjs.com/package/${p.name}/access (GitHub Actions, Ssoon-m/muwi, release.yml)`,
    ].join('\n'));
  }
}

/** package.json의 version만 바꾼다 (다른 줄의 모양은 그대로 둔다) */
function bump(folder, version) {
  const file = manifestFile(folder);
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text) throw new Error(`${file}에서 version을 찾지 못했어요`);
  fs.writeFileSync(file, next);
}

function release(version, dryRun) {
  checkVersion(version);
  const current = PACKAGES.map(p => versionOf(p.folder));
  if (new Set(current).size !== 1) {
    throw new Stop(`패키지들의 버전이 달라요: ${PACKAGES.map((p, i) => `${p.name} ${current[i]}`).join(', ')}. 같게 맞춘 뒤 실행하세요.`);
  }
  if (!higher(version, current[0])) throw new Stop(`새 버전은 지금 버전보다 높아야 해요 (새 버전: ${version}, 지금: ${current[0]}).`);

  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== BRANCH) throw new Stop(`${BRANCH}에서 실행하세요 (지금: ${branch}).`);
  // 줄 앞의 상태 칸(" M")이 잘리지 않게 trim 없이 읽는다
  const status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = status.split('\0').filter(Boolean).filter(e => e.slice(3) !== 'CHANGELOG.md');
  if (dirty.length) throw new Stop(`커밋하지 않은 변경이 있어요. CHANGELOG.md만 고친 채로 실행할 수 있어요.\n${dirty.join('\n')}`);
  git('fetch', '--quiet', '--tags', REMOTE, BRANCH);
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `${REMOTE}/${BRANCH}...HEAD`).split(/\s+/).map(Number);
  if (behind) throw new Stop(`${REMOTE}/${BRANCH}에 받지 않은 커밋이 ${behind}개 있어요. git pull 뒤에 실행하세요.`);
  const tag = `v${version}`;
  if (tryGit('rev-parse', '--quiet', '--verify', `refs/tags/${tag}`)) throw new Stop(`${tag} 태그가 이미 있어요.`);

  const notes = notesOf(version);
  if (!notes) throw new Stop(missingNotes(version));
  // 처음 올리는 패키지가 있으면 태그를 달기 전에 멈춘다 (Actions에서 앞 패키지만 올라가고 멈추지 않게)
  const missing = missingOnNpm();
  if (missing.length) throw new Stop(firstPublishHelp(missing));

  const who = `${tryGit('config', 'user.name') ?? '?'} <${tryGit('config', 'user.email') ?? '?'}>`;
  const plan = [
    `버전: ${current[0]} → ${version} (${PACKAGES.map(p => p.name).join(', ')})`,
    `커밋: chore: ${version} (CHANGELOG.md, ${PACKAGES.map(p => `packages/${p.folder}/package.json`).join(', ')})`,
    `작성자: ${who}`,
    `태그: ${tag}`,
    `push: ${REMOTE} ${BRANCH} ${tag}${ahead ? ` (아직 올리지 않은 커밋 ${ahead}개도 같이 올라가요)` : ''}`,
  ];
  if (dryRun) {
    console.log(['--dry-run: 아무것도 바꾸지 않았어요. 실행하면 이렇게 해요.', ...plan.map(l => `  ${l}`)].join('\n'));
    return;
  }
  for (const p of PACKAGES) bump(p.folder, version);
  git('add', 'CHANGELOG.md', ...PACKAGES.map(p => `packages/${p.folder}/package.json`));
  git('commit', '--quiet', '-m', `chore: ${version}`);
  git('tag', '-a', tag, '-m', `muwi ${version}`);
  git('push', '--quiet', '--atomic', REMOTE, BRANCH, tag);
  console.log([...plan, '', 'GitHub Actions가 npm에 올리고 GitHub 릴리스를 만들어요: https://github.com/Ssoon-m/muwi/actions/workflows/release.yml'].join('\n'));
}

/** 태그를 받은 Actions가 부른다: 모든 패키지 버전이 태그와 같고, CHANGELOG에 그 섹션이 있는지 */
function verify(version) {
  checkVersion(version);
  const wrong = PACKAGES.filter(p => versionOf(p.folder) !== version);
  if (wrong.length) throw new Stop(`태그는 ${version}인데 패키지 버전이 달라요: ${wrong.map(p => `${p.name} ${versionOf(p.folder)}`).join(', ')}`);
  if (!notesOf(version)) throw new Stop(`CHANGELOG.md에 "## ${version} (날짜)"가 없어요.`);
  console.log(`${version}: 패키지 버전과 CHANGELOG가 맞아요`);
}

function notes(version) {
  checkVersion(version);
  const body = notesOf(version);
  if (!body) throw new Stop(`CHANGELOG.md에 "## ${version} (날짜)"가 없어요.`);
  process.stdout.write(`${body}\n`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'verify') verify(rest[0]);
    else if (cmd === 'notes') notes(rest[0]);
    else if (cmd === 'registered') registered();
    else if (cmd === 'stage') stage(rest.includes('--dry-run'));
    else release(cmd, rest.includes('--dry-run'));
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
