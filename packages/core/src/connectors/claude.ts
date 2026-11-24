// Claude Code 커넥터: Claude Code의 훅 입력을 코어의 공통 사건으로 바꾸고, 코어의 답을 Claude Code가 알아듣는 형식으로 바꾼다.
// 코어(events.ts)는 Claude Code의 훅 이름·도구 이름을 모른다.
//   훅은 ~/.claude/settings.json에 다른 도구와 같은 입구(hooks/tool.sh claude)로 두 갈래로 건다:
//     record: SessionStart·SessionEnd, UserPromptSubmit·Stop(세션이 일하는지 기다리는지), SubagentStart/Stop, PostToolUse(Skill|Read)
//     command: PreToolUse(Bash)
import path from 'node:path';
import { skillFromPath, type Happened, type Reply } from '../events.ts';
import { sessionKey } from '../session.ts';
import { addHooks, installEntries, toolCommand, uninstallEntries, type HookEntry, type Settings } from './settings-hooks.ts';
import type { Adapter, HookMode, HookResult } from './types.ts';

/** 거는 훅들 */
function entries(hookCommand: string): HookEntry[] {
  // 훅이 실패해도(Windows에서 Git Bash가 없어 sh를 못 찾는 등) 하려던 일을 막지 않는다
  const on = (event: string, matcher?: string, mode = ''): HookEntry => ({ event, ...(matcher ? { matcher } : {}), command: `${hookCommand}${mode}`, extra: { onFailure: 'continue' } });
  return [
    on('SessionStart'), on('SessionEnd'), on('UserPromptSubmit'), on('Stop'), on('SubagentStart'), on('SubagentStop'),
    on('PostToolUse', 'Skill|Read'),
    on('PreToolUse', 'Bash', ' command'),
  ];
}

/** 우리 훅을 넣는다. 여러 번 해도 한 벌만 남는다 */
export const mergeHooks = (settings: Settings, hookCommand: string): Settings => addHooks(settings, entries(hookCommand));
export const installHooks = (settingsFile: string, hookCommand: string) => installEntries(settingsFile, entries(hookCommand));
export const uninstallHooks = (settingsFile: string) => uninstallEntries(settingsFile);

/** Claude Code 훅 입력 → 공통 사건. 코어가 볼 일이 아니면 null */
export function fromClaude(payload: any, mode: HookMode, env: NodeJS.ProcessEnv = process.env): Happened | null {
  if (payload == null || typeof payload !== 'object') return null;
  // Cursor는 Claude Code의 설정(~/.claude/settings.json)에 건 훅도 돌린다. 그건 Cursor 커넥터가 따로 본다
  if (payload.cursor_version) return null;
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  const session: string | null = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : sessionKey(env);
  /** 서브에이전트 안에서 일어난 일이면 그 서브에이전트의 id */
  const agent: string | undefined = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const model = typeof payload.model === 'string' && payload.model ? payload.model : undefined;
  const who = { tool: 'claude' as const, session, ...(agent ? { agent } : {}), ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) };

  if (mode === 'command') {
    return event === 'PreToolUse' && tool === 'Bash' ? { ...who, kind: 'before-command', command: payload.tool_input?.command } : null;
  }

  if (event === 'SessionStart') return { ...who, kind: 'session-start', ...(payload.source === 'compact' ? { resumed: 'compact' as const } : {}) };
  if (event === 'UserPromptSubmit') return { ...who, kind: 'prompt' };
  if (event === 'Stop') return { ...who, kind: 'turn-end' };
  if (event === 'SessionEnd') return { ...who, kind: 'session-end' };
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    const agentKind = typeof payload.agent_type === 'string' && payload.agent_type ? payload.agent_type : undefined;
    return { ...who, kind: event === 'SubagentStart' ? 'subagent-start' : 'subagent-end', ...(agentKind ? { agentKind } : {}) };
  }
  if (event !== 'PostToolUse') return null;
  if (tool === 'Skill') {
    const skill = payload.tool_input?.skill;
    if (typeof skill !== 'string' || !skill) return null;
    if (payload.tool_response && payload.tool_response.success === false) return null;
    return { ...who, kind: 'skill-read', skill, via: 'tool' };
  }
  if (tool === 'Read') {
    const skill = skillFromPath(payload.tool_input?.file_path);
    return skill ? { ...who, kind: 'skill-read', skill, via: 'file' } : null;
  }
  return null;
}

/** 코어의 답 → Claude Code 훅의 출력 */
export function toClaude(h: Happened, r: Reply): HookResult {
  const out = (o: object): HookResult => ({ stdout: JSON.stringify({ hookSpecificOutput: o }) });
  if (r.say && h.kind === 'session-start') return out({ hookEventName: 'SessionStart', additionalContext: r.say });
  if (r.say && h.kind === 'prompt') return out({ hookEventName: 'UserPromptSubmit', additionalContext: r.say });
  return {};
}

export const claude: Adapter = {
  can: { subagents: true, start: true, skills: true },
  install(ctx) {
    const settings = path.join(ctx.home, 'settings.json');
    installHooks(settings, toolCommand(ctx.root, 'claude', ctx.platform));
    return { settings: [settings] };
  },
  remove(wired) {
    for (const file of wired.settings ?? []) uninstallHooks(file);
  },
  from: fromClaude,
  to: toClaude,
};
