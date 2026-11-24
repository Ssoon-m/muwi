// 훅 파일로 붙는 도구들의 통합. 도구마다 다른 것만 여기 적는다:
//   훅을 거는 파일과 그 모양, 사건 이름, 도구 이름, 입력에서 이름이 다른 값, 답하는 법.
// 번역과 설치는 공통 코드가 한다 (shaped.ts, settings-hooks.ts, flat.ts).
// 값의 출처는 각 도구의 공식 문서와 Herdr가 그 도구에 넣는 통합이다.
import fs from 'node:fs';
import path from 'node:path';
import type { Happened, Reply } from '../events.ts';
import { backup, writeText } from './files.ts';
import { HOOK_MARK, installEntries, uninstallEntries } from './settings-hooks.ts';
import { flatShaped, fromShaped, plugged, shaped, shapedEntries, toShaped, toolCommand, type Shape } from './shaped.ts';
import type { Adapter, HookResult } from './types.ts';

/** Claude Code와 같은 사건 이름 */
const EVENTS = { start: 'SessionStart', prompt: 'UserPromptSubmit', before: 'PreToolUse', after: 'PostToolUse' };
const WITH_SUBAGENTS = { ...EVENTS, subStart: 'SubagentStart', subStop: 'SubagentStop' };

// ── Codex: ~/.codex/hooks.json. 파일을 고치는 도구는 apply_patch 하나이고(패치 글에 경로가 있다), 파일은 셸로 읽는다.
//    훅은 /hooks에서 한 번 믿어 줘야 돈다
export const codex = shaped(
  { id: 'codex', on: WITH_SUBAGENTS, tools: { edit: ['apply_patch'], spawn: ['spawn_agent'], shell: ['Bash'], read: [] }, shellReads: true },
  { file: 'hooks.json', wrap: 'hooks', matcher: 'list', extra: { timeout: 10 } },
);

// ── Qwen Code: ~/.qwen/settings.json. matcher는 앞뒤를 묶지 않는 정규식이라 정확히 묶어 준다
export const qwen = shaped(
  {
    id: 'qwen', on: WITH_SUBAGENTS,
    tools: { edit: ['edit', 'write_file', 'notebook_edit', 'replace'], spawn: ['agent', 'task'], shell: ['run_shell_command'], read: ['read_file'], skill: ['skill'] },
  },
  { file: 'settings.json', wrap: 'hooks', matcher: 'regex', extra: { timeout: 10 } },
);

// ── Qoder CLI: ~/.qoder/settings.json. Claude Code와 도구 이름까지 같다
export const qodercli = shaped(
  {
    id: 'qodercli', on: WITH_SUBAGENTS,
    tools: { edit: ['Edit', 'Write', 'NotebookEdit'], spawn: ['Agent'], shell: ['Bash'], read: ['Read'], skill: ['Skill'] },
  },
  { file: 'settings.json', wrap: 'hooks', matcher: 'regex', extra: { timeout: 10 } },
);

// ── Devin CLI: ~/.config/devin/config.json. 입력에 폴더가 없어 환경 변수에서 읽고, 막을 때는 종료 코드 2로 답한다
export const devin = shaped(
  {
    id: 'devin', on: EVENTS, deny: 'exit2',
    tools: { edit: ['edit', 'write', 'apply_patch'], spawn: ['run_subagent'], shell: ['exec'], read: ['read'], skill: ['skill'] },
    normalize: (p, env) => ({ ...p, cwd: p.cwd ?? env.DEVIN_PROJECT_DIR }),
  },
  { file: 'config.json', wrap: 'hooks', matcher: 'regex' },
);

// ── Letta Code: ~/.letta/settings.json. 입력의 이름이 다르고(event_type, working_directory), agent_id는 서브에이전트가 아니라
//    Letta의 에이전트라서 뺀다. AI에게 줄 말은 표준 출력 그대로, 막을 때는 종료 코드 2. 시간은 밀리초다
export const letta = shaped(
  {
    id: 'letta', on: EVENTS, say: 'stdout', deny: 'exit2',
    tools: { edit: ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'], spawn: ['Task'], shell: ['Bash', 'exec_command'], read: ['Read'], skill: ['Skill'] },
    normalize: p => ({ ...p, hook_event_name: p.hook_event_name ?? p.event_type, cwd: p.cwd ?? p.working_directory, session_id: p.session_id ?? p.conversation_id, agent_id: undefined }),
  },
  { file: 'settings.json', wrap: 'hooks', matcher: 'regex', extra: { timeout: 10000 } },
);

// ── Grok CLI: ~/.grok/hooks/ 아래의 파일마다 읽으므로 우리 파일을 따로 둔다. 서브에이전트 id의 이름이 다르다
export const grok = shaped(
  {
    id: 'grok', on: WITH_SUBAGENTS,
    tools: { edit: ['search_replace', 'write'], spawn: ['spawn_subagent'], shell: ['run_terminal_command'], read: ['read_file'] },
    normalize: p => ({ ...p, session_id: p.session_id ?? p.sessionId, agent_id: p.agent_id ?? p.subagentId, agent_type: p.agent_type ?? p.subagentType }),
  },
  { file: path.join('hooks', 'muwi.json'), wrap: 'hooks', matcher: 'regex', extra: { timeout: 10 } },
);

// ── Droid: hooks.json(사건 표가 맨 위)과 settings.json(hooks 아래) 둘 다 읽는데, 같은 폴더에서는 hooks.json의 사건이
//    settings.json의 같은 사건을 가린다. 그래서 hooks.json이 이미 있으면 거기에, 없으면 settings.json에 넣는다.
//    서브에이전트가 시작하는 사건이 없고 끝나는 사건에도 id가 없어 서브에이전트는 잇지 못한다
const DROID: Shape = {
  id: 'droid', on: EVENTS,
  tools: { edit: ['Edit', 'Create', 'ApplyPatch'], spawn: ['Task'], shell: ['Execute'], read: ['Read'], skill: ['Skill'] },
};
export const droid: Adapter = {
  install(ctx) {
    const bare = path.join(ctx.home, 'hooks.json');
    const file = fs.existsSync(bare) ? bare : path.join(ctx.home, 'settings.json');
    const wiring = { file: path.basename(file), wrap: file === bare ? 'bare' as const : 'hooks' as const, matcher: 'list' as const, extra: { timeout: 10 } };
    installEntries(file, shapedEntries(DROID, wiring, toolCommand(ctx.root, 'droid', ctx.platform)), file === bare);
    return { settings: [file] };
  },
  remove(wired) {
    for (const file of wired.settings ?? []) uninstallEntries(file, path.basename(file) === 'hooks.json');
  },
  from: (payload, mode, env) => fromShaped(DROID, payload, mode, env),
  to: (h, r) => toShaped(DROID, h, r),
};

// ── Copilot CLI: ~/.copilot/hooks/ 아래의 파일마다 읽으므로 우리 파일을 따로 둔다. 답은 감싸지 않은 JSON이다.
//    사건 이름을 대문자로 시작하게 적으면 입력이 Claude Code와 같은 모양으로 온다
export const copilot = flatShaped(
  {
    id: 'copilot', on: EVENTS, flat: true,
    tools: { edit: ['Edit', 'Write'], spawn: ['Agent'], shell: ['Bash'], read: ['Read'], skill: ['skill', 'Skill'] },
  },
  { file: path.join('hooks', 'muwi.json'), matcher: 'regex', version: true, each: { type: 'command', timeoutSec: 10 } },
);

// ── Cursor CLI: ~/.cursor/hooks.json. 사건 이름과 입력·답의 이름이 다르다. 대화 id는 conversation_id로 온다
export const cursor = flatShaped(
  {
    id: 'cursor',
    on: { start: 'sessionStart', prompt: 'beforeSubmitPrompt', before: 'preToolUse', after: 'postToolUse', subStart: 'subagentStart', subStop: 'subagentStop' },
    tools: { edit: ['Write', 'Delete'], spawn: ['Task'], shell: ['Shell'], read: ['Read'] },
    normalize: p => ({ ...p, session_id: p.conversation_id ?? p.session_id, agent_id: p.agent_id ?? p.subagent_id }),
    reply(h: Happened, r: Reply): HookResult {
      if (r.stop) return { stdout: JSON.stringify({ permission: 'deny', agent_message: r.stop, user_message: r.stop }) };
      if (r.say && h.kind === 'session-start') return { stdout: JSON.stringify({ additional_context: r.say }) };
      return {};
    },
  },
  { file: 'hooks.json', matcher: 'regex', version: true, each: { timeout: 10 } },
);

// ── Mastra Code: ~/.mastracode/hooks.json. 사건 표가 맨 위에 있고 matcher가 객체다. 막는 것은 종료 코드 2로만 된다.
//    시작할 때는 대화 id 자리에 임시 값이 온다
export const mastracode = flatShaped(
  {
    id: 'mastracode', on: EVENTS, deny: 'exit2',
    tools: { edit: ['string_replace_lsp', 'ast_smart_edit', 'write_file'], spawn: ['subagent'], shell: ['execute_command'], read: ['view'] },
    normalize: p => ({ ...p, session_id: p.session_id === 'session-init' ? undefined : p.session_id }),
  },
  { file: 'hooks.json', matcher: 'regex', bare: true, each: { type: 'command', timeout: 10000 }, matcherAs: m => ({ tool_name: m }) },
);

// ── Kimi Code: ~/.kimi-code/config.toml의 [[hooks]] 표. 키는 event, matcher, command, timeout 넷만 받는다 (다른 키가 있으면 설정을 못 읽는다).
//    세션이 시작될 때의 출력은 버려지므로 지침은 AGENTS.md로 들어가고, 사람이 말할 때의 말은 표준 출력 그대로 넣는다
const KIMI: Shape = {
  id: 'kimi', on: EVENTS, say: 'stdout',
  tools: { edit: ['Edit', 'Write'], spawn: ['Agent', 'AgentSwarm'], shell: ['Bash'], read: ['Read'], skill: ['Skill'] },
};
const TOML_START = '# muwi:start (muwi setup이 넣은 구간. 고치지 말고 muwi setup을 다시 실행해요)';
const TOML_END = '# muwi:end';
/** TOML 글에서 우리 구간을 뺀다 */
export function removeTomlRegion(text: string): string {
  const a = text.indexOf('# muwi:start');
  if (a < 0) return text;
  const b = text.indexOf(TOML_END, a);
  if (b < 0) return text;
  const before = text.slice(0, a).replace(/\n+$/, '');
  const after = text.slice(b + TOML_END.length).replace(/^\n+/, '');
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
}
const tomlString = (v: string) => (v.includes("'") ? JSON.stringify(v) : `'${v}'`);
export const kimi: Adapter = {
  install(ctx) {
    const file = path.join(ctx.home, 'config.toml');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const entries = shapedEntries(KIMI, { file: 'config.toml', wrap: 'hooks', matcher: 'regex' }, toolCommand(ctx.root, 'kimi', ctx.platform));
    const tables = entries.map(e => ['[[hooks]]', `event = "${e.event}"`, ...(e.matcher !== undefined ? [`matcher = ${tomlString(e.matcher)}`] : []), `command = ${tomlString(e.command)}`, 'timeout = 10'].join('\n'));
    const rest = removeTomlRegion(old).replace(/\n+$/, '');
    backup(file);
    writeText(file, `${rest ? rest + '\n\n' : ''}${TOML_START}\n${tables.join('\n\n')}\n${TOML_END}\n`);
    return { settings: [file] };
  },
  remove(wired) {
    for (const file of wired.settings ?? []) {
      if (!fs.existsSync(file)) continue;
      const old = fs.readFileSync(file, 'utf8');
      const next = removeTomlRegion(old);
      if (next !== old) writeText(file, next);
    }
  },
  from: (payload, mode, env) => fromShaped(KIMI, payload, mode, env),
  to: (h, r) => toShaped(KIMI, h, r),
};

// ── Antigravity CLI: ~/.gemini/config/hooks.json. 훅 이름 아래에 사건 표를 둔다 ({ "muwi": { "SessionStart": [...] } }).
//    입력은 이름이 다르고(conversationId, toolCall) 사건 이름이 없어서 훅 명령이 알려 준다 (--event). 답은 늘 JSON이어야 한다.
//    사람이 말할 때의 사건이 없다
const AGY: Shape = {
  id: 'antigravity-cli', on: { start: 'SessionStart', before: 'PreToolUse', after: 'PostToolUse' },
  tools: { edit: ['write_to_file', 'replace_file_content', 'multi_replace_file_content'], spawn: ['invoke_subagent'], shell: ['run_command'], read: ['view_file'] },
  normalize: p => ({
    hook_event_name: p.hook_event_name,
    session_id: p.conversationId,
    cwd: Array.isArray(p.workspacePaths) ? p.workspacePaths[0] : undefined,
    model: p.modelName,
    tool_name: p.toolCall?.name,
    tool_input: { file_path: p.toolCall?.args?.TargetFile ?? p.toolCall?.args?.AbsolutePath, command: p.toolCall?.args?.CommandLine },
  }),
  reply(h: Happened, r: Reply): HookResult {
    if (r.stop) return { stdout: JSON.stringify({ decision: 'deny', reason: r.stop }) };
    if (r.say && h.kind === 'session-start') return { stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: r.say } }] }) };
    return { stdout: '{}' };
  },
};
export const antigravity: Adapter = {
  install(ctx) {
    const file = path.join(ctx.home, 'hooks.json');
    let data: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error(`설정 파일이 JSON이 아니라서 고치지 않았어요: ${file}`);
      }
    }
    const command = toolCommand(ctx.root, 'antigravity-cli', ctx.platform);
    const run = (mode: string, event: string) => ({ type: 'command', command: `${command}${mode} --event ${event}`, timeout: 10 });
    const only = (names: string[]) => `^(${names.join('|')})$`;
    const muwi = {
      SessionStart: [run('', 'SessionStart')],
      PreToolUse: [{ matcher: only([...AGY.tools.edit, ...AGY.tools.spawn]), hooks: [run(' nudge', 'PreToolUse')] }],
      PostToolUse: [{ matcher: only(AGY.tools.read), hooks: [run('', 'PostToolUse')] }],
    };
    backup(file);
    writeText(file, JSON.stringify({ ...data, muwi }, null, 2) + '\n');
    return { settings: [file] };
  },
  remove(wired) {
    for (const file of wired.settings ?? []) {
      if (!fs.existsSync(file)) continue;
      try {
        const { muwi: _ours, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Object.keys(rest).length) writeText(file, JSON.stringify(rest, null, 2) + '\n');
        else fs.rmSync(file, { force: true });
      } catch {
        // 읽지 못하는 파일은 건드리지 않는다
      }
    }
  },
  from: (payload, mode, env) => fromShaped(AGY, payload, mode, env),
  to: (h, r) => toShaped(AGY, h, r),
  empty: '{}',
};

// ── 플러그인(확장) 파일로 붙는 도구들. 훅 설정이 없고, 그 도구가 플러그인 폴더의 파일을 읽어 들인다.
//    플러그인 파일은 muwi 설치 위치의 integrations/<도구>/에 있다
export const opencode = plugged('opencode', { to: 'plugins', files: ['muwi.js'] });
export const kilo = plugged('kilo', { to: 'plugin', files: ['muwi.js'] });
export const pi = plugged('pi', { to: 'extensions', files: ['muwi.ts'] });
export const omp = plugged('omp', { to: 'extensions', files: ['muwi.ts'] });
// Hermes는 플러그인을 켜 줘야 읽는다 (hermes plugins enable muwi)
export const hermes = plugged('hermes', { to: path.join('plugins', 'muwi'), files: ['__init__.py', 'plugin.yaml'] });

/** 우리 훅 명령의 표시 (시험과 점검에서 쓴다) */
export const MARK = HOOK_MARK;
