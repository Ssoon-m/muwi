#!/usr/bin/env node
// 배포할 패키지를 만든다: packages/<이름>/dist에 .ts를 .js로 바꾼 사본과 배포용 package.json을 둔다.
// Node는 node_modules 안의 .ts를 실행하지 않아서(타입 지우기를 하지 않는다) 배포할 때만 .js로 바꾼다. 개발할 때는 .ts를 그대로 실행한다.
// 타입은 Node에 든 stripTypeScriptTypes로 지운다 (따로 받을 도구가 없다). 타입 자리는 빈칸으로 바뀌어 줄 위치가 그대로다.
//   node scripts/build.mjs            두 패키지 모두
//   node scripts/build.mjs muwi       하나만
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

process.removeAllListeners('warning'); // stripTypeScriptTypes가 실험 기능이라는 경고

const ROOT = path.resolve(import.meta.dirname, '..');
/** 패키지마다 그대로 옮길 것 (.ts를 바꾸지 않는다: 도구에 넣는 플러그인 파일처럼 .ts로 남아야 하는 것이 있다) */
const PACKAGES = {
  muwi: ['bin', 'hooks', 'skills', 'connectors', 'src/find-node.sh'],
  'herdr-muwi': ['bin', 'app'],
};

/** 타입을 지우고, 상대 경로로 부르는 .ts를 .js로 바꾼다 (import, export … from, import()) */
export function toJs(code, file) {
  const js = stripTypeScriptTypes(code, { mode: 'strip', sourceUrl: file });
  return js.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"\n]+)\.ts(['"])/g, '$1$2.js$3');
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

/** src의 .ts를 .js로 바꿔 옮긴다. 시험 파일은 뺀다 */
function compile(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    if (entry.isDirectory()) compile(a, path.join(to, entry.name));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, entry.name.replace(/\.ts$/, '.js')), toJs(fs.readFileSync(a, 'utf8'), a));
    }
  }
}

const version = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', name, 'package.json'), 'utf8')).version;

/** 배포용 package.json: 내보내는 경로를 .js로, 같은 저장소의 패키지(workspace:*)는 그 버전으로 */
function manifest(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete pkg.scripts;
  delete pkg.devDependencies;
  if (pkg.exports) pkg.exports = Object.fromEntries(Object.entries(pkg.exports).map(([k, v]) => [k, v.replace(/\.ts$/, '.js')]));
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec.startsWith('workspace:')) pkg.dependencies[name] = version(name);
  }
  return pkg;
}

export function build(name) {
  const dir = path.join(ROOT, 'packages', name);
  const out = path.join(dir, 'dist');
  fs.rmSync(out, { recursive: true, force: true });
  compile(path.join(dir, 'src'), path.join(out, 'src'));
  for (const item of PACKAGES[name]) copy(path.join(dir, item), path.join(out, item));
  for (const file of ['README.md', 'LICENSE']) {
    const own = path.join(dir, file);
    copy(fs.existsSync(own) ? own : path.join(ROOT, file), path.join(out, file));
  }
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(manifest(dir), null, 2) + '\n');
  return out;
}

if (import.meta.main) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PACKAGES);
  for (const name of names) {
    if (!PACKAGES[name]) throw new Error(`모르는 패키지: ${name}`);
    console.log(`${name}: ${path.relative(ROOT, build(name))}`);
  }
}
