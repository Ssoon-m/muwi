// Claude Code 통합: Claude Code의 훅 입력을 코어의 공통 사건으로 바꾸고, 코어의 답을 Claude Code가 알아듣는 형식으로 바꾼다.
// 코어(events.ts)는 Claude Code의 훅 이름·도구 이름을 모른다. 다른 도구는 같은 모양의 통합을 하나 더 두면 된다.
//   훅 연결은 세 갈래다 (hooks/hooks.json, setup.ts):
//     record: SessionStart, UserPromptSubmit, SubagentStart/Stop, PostToolUse(Skill|Read)
//     nudge:  PreToolUse(Edit|Write|MultiEdit|NotebookEdit|Agent|Task)
//     guard:  PreToolUse(Bash)
import { skillFromPath, type Happened, type Reply } from '../events.ts';
import { sessionKey } from '../session.ts';

export type HookMode = 'record' | 'guard' | 'nudge';
export type HookResult = { stdout?: string };

/** Claude Code 훅 입력 → 공통 사건. 코어가 볼 일이 아니면 null */
export function fromClaude(payload: any, mode: HookMode, env: NodeJS.ProcessEnv = process.env): Happened | null {
  if (payload == null || typeof payload !== 'object') return null;
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  const session: string | null = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : sessionKey(env);
  /** 서브에이전트 안에서 일어난 일이면 그 서브에이전트의 id */
  const agent: string | undefined = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const who = { tool: 'claude' as const, session, ...(agent ? { agent } : {}), ...(cwd ? { cwd } : {}) };

  if (mode === 'guard') {
    return event === 'PreToolUse' && tool === 'Bash' ? { ...who, kind: 'before-command', command: payload.tool_input?.command } : null;
  }
  if (mode === 'nudge') {
    if (event !== 'PreToolUse') return null;
    if (tool === 'Agent' || tool === 'Task') return { ...who, kind: 'before-spawn' };
    return { ...who, kind: 'before-edit', file: payload.tool_input?.file_path ?? payload.tool_input?.notebook_path };
  }

  if (event === 'SessionStart') return { ...who, kind: 'session-start', ...(payload.source === 'compact' ? { resumed: 'compact' as const } : {}) };
  if (event === 'UserPromptSubmit') return { ...who, kind: 'prompt' };
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
  if (r.ask) return out({ hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: r.ask });
  if (r.stop) return out({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.stop });
  if (r.say && h.kind === 'session-start') return out({ hookEventName: 'SessionStart', additionalContext: r.say });
  if (r.say && h.kind === 'prompt') return out({ hookEventName: 'UserPromptSubmit', additionalContext: r.say });
  return {};
}
