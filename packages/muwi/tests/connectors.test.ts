import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { handleHook } from '../src/hook.ts';
import { ADAPTERS, adapterOf } from '../src/connectors/index.ts';
import { gaps } from '../src/connectors/types.ts';
import { removeTomlRegion } from '../src/connectors/hooked.ts';
import { TOOLS, detectTool, launchCommand, resumeCommand, toolById, toolHome } from '../src/connectors/tools.ts';
import { readInstall, removeSetup, runSetup } from '../src/setup.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `muwi-${name}-`));
/** Herdr 밖의 빈 환경 */
const ENV = (home: string) => ({ HOME: home, PATH: process.env.PATH }) as NodeJS.ProcessEnv;

/** 도구마다 "파일을 고치려 한다"가 어떤 입력으로 오는지. muwi는 이 입력에 답하지 않는다 (0.5.x는 계획이 없으면 여기서 돌려보냈다) */
const FILE = '/repo/src/a.ts';
const EDITS: Record<string, any> = {
  claude: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: FILE } },
  codex: { hook_event_name: 'PreToolUse', session_id: 's1', model: 'gpt-x', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${FILE}\n@@\n-a\n+b\n*** End Patch` } },
  copilot: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { path: FILE } },
  cursor: { hook_event_name: 'preToolUse', conversation_id: 's1', tool_name: 'Write', tool_input: { file_path: FILE } },
  qwen: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'write_file', tool_input: { file_path: FILE } },
  qodercli: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Write', tool_input: { file_path: FILE } },
  kimi: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit', tool_input: { path: FILE } },
  'antigravity-cli': { hook_event_name: 'PreToolUse', conversationId: 's1', workspacePaths: ['/repo'], modelName: 'gemini-x', toolCall: { name: 'replace_file_content', args: { TargetFile: FILE } } },
  droid: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Create', tool_input: { file_path: FILE } },
  devin: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'edit', tool_input: { file_path: FILE } },
  grok: { hook_event_name: 'PreToolUse', sessionId: 's1', tool_name: 'search_replace', tool_input: { file_path: FILE } },
  mastracode: { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'write_file', tool_input: { path: FILE } },
  letta: { event_type: 'PreToolUse', conversation_id: 's1', agent_id: 'agent-letta', tool_name: 'Edit', tool_input: { file_path: FILE } },
};

test('도구 표: 환경 변수로 도구를 알아보고, 도구마다 띄우는 명령과 이어 가는 명령을 낸다', () => {
  assert.equal(detectTool({ CLAUDECODE: '1' } as NodeJS.ProcessEnv), 'claude');
  assert.equal(detectTool({ CODEX_THREAD_ID: 'x' } as NodeJS.ProcessEnv), 'codex');
  assert.equal(detectTool({} as NodeJS.ProcessEnv), 'unknown');
  assert.deepEqual(launchCommand('qwen'), ['qwen', '-i', '{prompt}']);
  assert.deepEqual(launchCommand('nope'), ['claude', '{prompt}']);
  assert.deepEqual(resumeCommand('codex', 'abc'), ['codex', 'resume', 'abc']);
  assert.deepEqual(resumeCommand('copilot', 'abc'), ['copilot', '--resume=abc']);
  assert.equal(resumeCommand('nope', 'abc'), null);
});

/** 도구마다 세션을 가리키는 이름이 다르다 */
const SESSION_ID: Record<string, any> = { cursor: { conversation_id: 's1' }, 'antigravity-cli': { conversationId: 's1' }, grok: { sessionId: 's1' }, letta: { conversation_id: 's1' } };

for (const id of Object.keys(ADAPTERS)) {
  test(`${id} 커넥터: 세션이 시작됐다는 입력을 같은 사건으로 바꾼다`, () => {
    const start = { ...(SESSION_ID[id] ?? { session_id: 's1' }), hook_event_name: id === 'cursor' ? 'sessionStart' : 'SessionStart' };
    const happened = ADAPTERS[id].from(start, 'record', ENV(tmp('home')));
    assert.ok(happened && happened.kind === 'session-start', `${id}: session-start가 아니다`);
    assert.deepEqual([happened.tool, happened.session], [id, 's1']);
  });
}

test('어느 도구에서도 파일을 고치려는 입력에는 아무 답도 하지 않는다 (muwi는 AI가 하려는 일을 막지 않는다)', () => {
  const dir = tmp('rec');
  for (const [id, payload] of Object.entries(EDITS)) {
    // 고치기 전의 입력은 코어가 볼 일이 아니다
    assert.equal(ADAPTERS[id].from(payload, 'record', ENV(tmp('home'))), null, id);
    const r = handleHook(payload, dir, 'record', ENV(tmp('home')), ROOT, id);
    assert.ok(!r.code, `${id}: 종료 코드로 막았다 (${r.code})`);
    assert.ok(!r.stderr, `${id}: 표준 오류로 답했다`);
    // 답이 늘 JSON이어야 하는 도구는 빈 JSON을, 나머지는 아무것도 내지 않는다
    assert.ok(!r.stdout || r.stdout === '{}', `${id}: ${r.stdout}`);
  }
});

test('세션: 셸 명령에 세션 id를 넘겨주지 않는 도구는 훅도 터미널을 세션으로 보고, 그 도구의 대화 id는 따로 적는다', () => {
  const herdr = { HOME: tmp('home'), HC_TERMINAL_ID: 't9' } as NodeJS.ProcessEnv;
  const qwen = ADAPTERS.qwen.from({ hook_event_name: 'SessionStart', session_id: 's1' }, 'record', herdr)!;
  assert.deepEqual([qwen.session, qwen.native], ['hc-t9', 's1']);
  // Codex는 셸 명령에도 같은 id를 준다 (CODEX_THREAD_ID): 그 id가 세션이다
  const codex = ADAPTERS.codex.from({ hook_event_name: 'SessionStart', session_id: 's1', model: 'gpt-x' }, 'record', herdr)!;
  assert.deepEqual([codex.session, codex.native, codex.model], ['s1', undefined, 'gpt-x']);
});

test('세션이 시작될 때: 지침 파일이 없는 도구에는 훅이 지침을 넣고, 있는 도구에는 두 번 넣지 않는다', () => {
  const start = (id: string, payload: any) => handleHook(payload, tmp('rec'), 'record', ENV(tmp('home')), ROOT, id);
  // Claude Code, Cursor, Letta Code: 지침 파일이 없다
  assert.match(JSON.parse(start('claude', { hook_event_name: 'SessionStart', session_id: 's1' }).stdout!).hookSpecificOutput.additionalContext, /작업 진행 방식 \(muwi\)/);
  assert.match(JSON.parse(start('cursor', { hook_event_name: 'sessionStart', conversation_id: 's1' }).stdout!).additional_context, /작업 진행 방식 \(muwi\)/);
  assert.match(start('letta', { event_type: 'SessionStart', conversation_id: 's1' }).stdout!, /^## 작업 진행 방식 \(muwi\)/);
  // AGENTS.md 같은 지침 파일이 있는 도구: 훅은 조용하다
  assert.deepEqual(start('codex', { hook_event_name: 'SessionStart', session_id: 's1' }), {});
  assert.deepEqual(start('qwen', { hook_event_name: 'SessionStart', session_id: 's1' }), {});
  // Antigravity CLI는 할 말이 없어도 빈 JSON을 낸다
  assert.deepEqual(start('antigravity-cli', { hook_event_name: 'SessionStart', conversationId: 's1' }), { stdout: '{}' });
});

test('읽은 skill: 도구마다 다른 입력에서 같은 사건으로 바꾼다 (skill 도구, SKILL.md 읽기, 셸로 읽기)', () => {
  const env = ENV(tmp('home'));
  const read = (id: string, payload: any) => ADAPTERS[id].from(payload, 'record', env) as any;
  assert.deepEqual([read('qwen', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'skill', tool_input: { skill: 'team-rules' } }).skill], ['team-rules']);
  assert.equal(read('droid', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/x/.factory/skills/team-rules/SKILL.md' } }).skill, 'team-rules');
  // Codex는 파일을 셸로 읽는다
  const codex = read('codex', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat /Users/me/.agents/skills/team-rules/SKILL.md' } });
  assert.deepEqual([codex.kind, codex.skill, codex.via], ['skill-read', 'team-rules', 'file']);
  assert.equal(read('codex', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  // Grok의 읽기 도구는 경로를 target_file로 준다
  assert.equal(read('grok', { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'read_file', tool_input: { target_file: '/x/skills/team-rules/SKILL.md' } }).skill, 'team-rules');
});

for (const tool of TOOLS.filter(t => ADAPTERS[t.id])) {
  test(`${tool.id} 통합: muwi setup --tool이 지침·사용법 skill·훅을 넣고, --remove가 우리 것만 뺀다`, () => {
    const home = tmp('home'), records = path.join(home, '.muwi');
    const env = ENV(home);
    const at = toolHome(tool, env, home);
    fs.mkdirSync(at, { recursive: true });
    // 사람이 이미 적어 둔 지침은 그대로 남아야 한다
    const mine = tool.instructions ? path.join(at, tool.instructions) : null;
    if (mine) fs.writeFileSync(mine, '# 내 규칙\n');

    runSetup({ root: ROOT, version: '0.0.0', dir: records, env, tools: [tool.id] });
    const done = readInstall(records)!.tools![tool.id];
    const wired = [...(done.settings ?? []), ...(done.files ?? [])];
    assert.ok(wired.length > 0, '훅을 넣은 파일이 없다');
    // 설정 파일에는 우리 표시가 붙은 훅 명령이, 플러그인 파일에는 훅 스크립트의 실제 경로가 들어간다
    for (const file of done.settings ?? []) assert.match(fs.readFileSync(file, 'utf8'), /MUWI_HOOK=1 sh \\?".*hooks\/(hook|tool)\.sh/);
    const plugin = (done.files ?? []).map(file => fs.readFileSync(file, 'utf8')).join('\n');
    if (done.files?.length) {
      assert.match(plugin, /hooks\/tool\.sh/);
      assert.doesNotMatch(plugin, /__MUWI_HOOK__/);
    }
    if (mine) assert.match(fs.readFileSync(mine, 'utf8'), /^# 내 규칙\n\n<!-- muwi:start/);
    if (done.skill) assert.ok(fs.existsSync(path.join(done.skill, 'SKILL.md')));
    // 다시 해도 한 벌만
    runSetup({ root: ROOT, version: '0.0.0', dir: records, env });
    const count = (text: string) => text.split('MUWI_HOOK=1').length + text.split('tool.sh').length;
    const before = wired.map(file => count(fs.readFileSync(file, 'utf8')));
    runSetup({ root: ROOT, version: '0.0.0', dir: records, env });
    assert.deepEqual(wired.map(file => count(fs.readFileSync(file, 'utf8'))), before);

    removeSetup(records);
    for (const file of wired) if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /MUWI_HOOK=1/);
    for (const file of done.files ?? []) assert.equal(fs.existsSync(file), false);
    if (mine) assert.equal(fs.readFileSync(mine, 'utf8'), '# 내 규칙\n');
    if (done.skill) assert.equal(fs.existsSync(done.skill), false);
  });
}

test('남의 훅은 그대로: Cursor의 hooks.json과 Kimi Code의 config.toml에 우리 것만 넣고 뺀다', () => {
  const home = tmp('home'), records = path.join(home, '.muwi'), env = ENV(home);
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  const cursorFile = path.join(home, '.cursor', 'hooks.json');
  const kimiFile = path.join(home, '.kimi-code', 'config.toml');
  fs.writeFileSync(cursorFile, JSON.stringify({ version: 1, hooks: { stop: [{ command: './mine.sh' }] } }));
  fs.writeFileSync(kimiFile, 'model = "kimi-x"\n\n[[hooks]]\nevent = "Stop"\ncommand = "mine.sh"\n');
  runSetup({ root: ROOT, version: '0.0.0', dir: records, env, tools: ['cursor', 'kimi'] });
  const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  assert.deepEqual(cursor.hooks.stop, [{ command: './mine.sh' }]);
  // 파일을 고치기 전에는 걸지 않는다. 셸 명령 앞의 훅은 서브에이전트가 시작한 노드를 잇는 데만 쓴다
  assert.deepEqual(cursor.hooks.preToolUse.map((h: any) => [h.matcher, /tool\.sh" cursor command$/.test(h.command)]), [['^(Shell)$', true]]);
  assert.equal(cursor.hooks.beforeSubmitPrompt, undefined);
  const kimi = fs.readFileSync(kimiFile, 'utf8');
  assert.match(kimi, /^model = "kimi-x"\n\n\[\[hooks\]\]\nevent = "Stop"\ncommand = "mine\.sh"\n\n# muwi:start/);
  // Kimi Code는 [[hooks]]에 네 키만 받는다
  const ours = kimi.slice(kimi.indexOf('# muwi:start'));
  for (const line of ours.split('\n').filter(l => l.includes(' = '))) assert.match(line, /^(event|matcher|command|timeout) = /);
  assert.equal(removeTomlRegion(kimi), 'model = "kimi-x"\n\n[[hooks]]\nevent = "Stop"\ncommand = "mine.sh"\n');
  removeSetup(records);
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorFile, 'utf8')), { version: 1, hooks: { stop: [{ command: './mine.sh' }] } });
  assert.equal(fs.readFileSync(kimiFile, 'utf8'), 'model = "kimi-x"\n\n[[hooks]]\nevent = "Stop"\ncommand = "mine.sh"\n');
});

test('muwi hook --from <도구>: 그 도구의 형식으로 읽고 답한다 (말을 표준 출력으로 받는 도구, 사건 이름을 명령이 알려 주는 도구)', () => {
  const CLI = path.join(ROOT, 'src', 'cli.ts');
  const run = (args: string[], payload: object) => {
    const home = tmp('home');
    return spawnSync(process.execPath, [CLI, 'hook', ...args], { input: JSON.stringify(payload), encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH, MUWI_DIR: path.join(home, '.muwi') } });
  };
  // Letta Code: AI에게 줄 말을 표준 출력 그대로 낸다
  assert.match(run(['--from', 'letta'], { event_type: 'SessionStart', conversation_id: 'c1' }).stdout, /^## 작업 진행 방식 \(muwi\)/);
  // Antigravity CLI: 입력에 사건 이름이 없어 명령이 알려 준다. 볼 일이 없어도 빈 JSON을 낸다
  assert.equal(run(['--from', 'antigravity-cli', '--event', 'SessionStart'], { conversationId: 'c' }).stdout.trim(), '{}');
  assert.equal(run(['--from', 'antigravity-cli', '--event', 'PostToolUse'], { conversationId: 'c', toolCall: { name: 'view_file', args: { AbsolutePath: '/x/a.md' } } }).stdout.trim(), '{}');
  // 0.5.x의 훅 설정이 부르던 갈래(계획 없이 고칠 때 알림)는 조용히 지나간다: 막지 않는다
  const old = run(['nudge', '--from', 'mastracode'], EDITS.mastracode);
  assert.deepEqual([old.status, old.stdout, old.stderr], [0, '', '']);
  // 모르는 도구면 아무것도 하지 않는다
  assert.deepEqual([run(['--from', 'nope'], EDITS.claude).status, run(['--from', 'nope'], EDITS.claude).stdout], [0, '']);
});

test('커넥터 규격: 도구 표와 커넥터가 하나씩 짝이고, 커넥터는 그 도구의 훅이 알려 주는 것을 선언한다', () => {
  assert.equal(new Set(TOOLS.map(t => t.id)).size, TOOLS.length);
  for (const id of Object.keys(ADAPTERS)) assert.ok(toolById(id), `${id}가 도구 표에 없다`);
  for (const t of TOOLS) {
    const a = adapterOf(t.id);
    assert.ok(a, `${t.id}에 커넥터가 없어요`);
    // 꼭 해야 하는 일 넷과 선언
    for (const k of ['install', 'remove', 'from', 'to'] as const) assert.equal(typeof a[k], 'function', `${t.id}.${k}`);
    assert.deepEqual(Object.keys(a.can).sort(), ['skills', 'start', 'subagents'], t.id);
    // 선언에 없는 것은 사람이 읽는 말로 나온다 (muwi setup --tools와 문서의 표)
    assert.equal(gaps(a.can).length, Object.values(a.can).filter(v => !v).length, t.id);
  }
  // 서브에이전트를 알려 주지 않는 도구에서도 --sub로 밝힌 노드는 표시된다 (tests/cli.test.ts). 선언은 "자동으로 알아보는가"다
  assert.equal(adapterOf('claude')!.can.subagents, true);
  assert.equal(adapterOf('pi')!.can.subagents, false);
  assert.deepEqual(gaps({ subagents: true, start: true, skills: true }), []);
});

test('Gemini CLI: 사건 이름이 달라도 같은 사건으로 바꾸고, 설정에 우리 훅만 넣고 뺀다', () => {
  const home = tmp('gemini-home');
  const dir = tmp('gemini-runs');
  const env = { ...ENV(home), HC_TERMINAL_ID: 't5' } as NodeJS.ProcessEnv;
  const g = ADAPTERS.gemini;
  // 서브에이전트를 알려 주는 사건이 없다: --sub로 밝힌 노드만 서브에이전트로 나온다
  assert.deepEqual(g.can, { subagents: false, start: true, skills: true });
  // 셸 명령에 세션 id를 넘겨주지 않아서 터미널을 세션으로 본다
  // 셸 명령에 세션 id를 넘겨주지 않아서 터미널을 세션으로 본다
  const start = g.from({ hook_event_name: 'SessionStart', session_id: 'g1', source: 'startup' }, 'record', env)!;
  assert.deepEqual([start.kind, start.session, start.native], ['session-start', 'hc-t5', 'g1']);
  // 파일을 고치려는 입력은 보지 않는다 (막지 않는다)
  assert.equal(g.from({ hook_event_name: 'BeforeTool', session_id: 'g1', tool_name: 'write_file', tool_input: { file_path: FILE } }, 'record', env), null);
  const skill = g.from({ hook_event_name: 'AfterTool', session_id: 'g1', tool_name: 'activate_skill', tool_input: { name: 'team-rules' } }, 'record', env) as any;
  assert.deepEqual([skill.kind, skill.skill], ['skill-read', 'team-rules']);
  // 설정에 넣고 뺀다: 남의 훅과 다른 설정은 그대로
  const settings = path.join(home, '.gemini', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const theirs = { theme: 'dark', hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: '/opt/lint.sh' }] }] } };
  fs.writeFileSync(settings, JSON.stringify(theirs));
  runSetup({ root: ROOT, version: '0.0.0', dir, env, tools: ['gemini'] });
  const now = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(now.theme, 'dark');
  assert.deepEqual(now.hooks.BeforeTool[0], theirs.hooks.BeforeTool[0]);
  // 세션 시작과 skill 읽기에만 건다. 도구를 쓰기 전(BeforeTool)에는 우리 훅이 없다
  assert.deepEqual(Object.keys(now.hooks).sort(), ['AfterTool', 'BeforeTool', 'SessionStart']);
  assert.equal(now.hooks.BeforeTool.length, 1);
  assert.match(JSON.stringify(now.hooks.AfterTool), /hooks\/tool\.sh\\?" gemini/);
  assert.equal(now.hooks.AfterTool.at(-1).hooks[0].timeout, 10000);
  // 지침은 Gemini가 늘 읽는 GEMINI.md에, 사용법 skill은 skills 폴더에
  assert.match(fs.readFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'utf8'), /muwi:start/);
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'skills', 'muwi', 'SKILL.md')));
  removeSetup(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), theirs);
});
