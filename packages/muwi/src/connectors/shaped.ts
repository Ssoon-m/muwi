// Claude Code와 같은 모양의 훅을 쓰는 도구들의 통합. 여러 도구가 그 모양을 따른다:
//   설정 파일의 사건 표에 { matcher, hooks: [{ type: "command", command }] }를 걸고,
//   훅은 표준 입력으로 JSON(hook_event_name, session_id, tool_name, tool_input …)을 받고,
//   표준 출력의 JSON(hookSpecificOutput)이나 종료 코드로 답한다.
// 도구마다 다른 것(파일 자리, 사건 이름, 도구 이름, 답하는 법)만 표(Shape)로 받아서 통합을 만든다.
// 플러그인으로 붙는 도구(OpenCode, Pi …)도 그 플러그인이 같은 모양의 JSON을 넘기므로 이 번역기를 같이 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { skillFromPath, type Happened, type Reply } from '../events.ts';
import { sessionKey, terminalKey } from '../session.ts';
import { shPath, writeText } from './files.ts';
import { installFlat, uninstallFlat } from './flat.ts';
import { HOOK_MARK, installEntries, uninstallEntries, type HookEntry } from './settings-hooks.ts';
import { toolById } from './tools.ts';
import type { Adapter, Can, HookMode, HookResult, SetupCtx } from './types.ts';

export type Shape = {
  id: string;
  /** 사건 이름. 없는 사건은 걸지 않는다 */
  on: { start?: string; prompt?: string; before?: string; after?: string; subStart?: string; subStop?: string };
  /** 그 도구에서 쓰는 도구 이름 (훅 입력의 tool_name) */
  tools: { shell: string[]; read: string[]; skill?: string[] };
  /** 파일을 셸 명령으로 읽는 도구인가 (cat …/SKILL.md). 그러면 셸 명령에서도 읽은 skill을 찾는다 */
  shellReads?: boolean;
  /** AI에게 보여 줄 말을 넣는 법: JSON(additionalContext) 또는 표준 출력 그대로 */
  say?: 'json' | 'stdout';
  /** 답 JSON을 hookSpecificOutput으로 감싸지 않는 도구 */
  flat?: boolean;
  /** 입력의 이름이 다른 도구는 먼저 같은 이름으로 맞춘다 (conversation_id → session_id 같은 것) */
  normalize?: (payload: any, env: NodeJS.ProcessEnv) => any;
  /** 답하는 모양이 아예 다른 도구 */
  reply?: (h: Happened, r: Reply) => HookResult;
};

/** 훅을 설정 파일에 거는 법 */
export type Wiring = {
  /** 훅을 거는 파일 (설정 폴더 기준) */
  file: string;
  /** 그 파일에서 사건 표가 "hooks" 아래에 있나(hooks), 맨 위에 있나(bare) */
  wrap: 'hooks' | 'bare';
  /** matcher를 적는 법: 이름을 |로 잇거나(list), 정규식으로 정확히(regex: ^(a|b)$), 쓰지 않거나(none) */
  matcher: 'list' | 'regex' | 'none';
  /** 훅 항목에 더 넣을 값 (timeout 등) */
  extra?: Record<string, unknown>;
};

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 고치려는 파일. 패치로 고치는 도구(apply_patch)는 패치 글에서 첫 파일을 찾는다 */
export function fileOf(input: any): unknown {
  if (input == null || typeof input !== 'object') return undefined;
  const direct = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path ?? input.target_file;
  if (direct) return direct;
  for (const v of Object.values(input)) {
    const m = typeof v === 'string' ? v.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m) : null;
    if (m) return m[1].trim();
  }
  return undefined;
}

/** 훅 입력 → 공통 사건 */
export function fromShaped(shape: Shape, raw: any, mode: HookMode, env: NodeJS.ProcessEnv = process.env): Happened | null {
  if (raw == null || typeof raw !== 'object') return null;
  const payload = shape.normalize ? shape.normalize(raw, env) : raw;
  if (payload == null || typeof payload !== 'object') return null;
  const event = payload.hook_event_name;
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};
  // 셸 명령에 세션 id를 넘겨주는 도구는 그 id가 세션이다 (muwi 명령도 같은 id를 안다).
  // 넘겨주지 않는 도구는 muwi 명령이 대화를 알 수 없으니, 훅도 명령도 터미널을 세션으로 본다. 그 도구의 대화 id는 따로 적어 둔다
  const native = text(payload.session_id);
  const session = toolById(shape.id)?.sessionEnv ? (native ?? sessionKey(env)) : (terminalKey(env) ?? native ?? null);
  const agent = text(payload.agent_id);
  const cwd = text(payload.cwd), model = text(payload.model);
  const who = {
    tool: shape.id, session, ...(agent ? { agent } : {}), ...(cwd ? { cwd } : {}), ...(model ? { model } : {}),
    ...(native && native !== session ? { native } : {}),
  };
  const is = (names?: string[]) => Boolean(names && typeof tool === 'string' && names.includes(tool));
  const { on, tools } = shape;

  if (mode === 'command') return event === on.before && is(tools.shell) ? { ...who, kind: 'before-command', command: input.command ?? input.cmd } : null;
  if (event && event === on.start) return { ...who, kind: 'session-start', ...(payload.source === 'compact' ? { resumed: 'compact' as const } : {}) };
  if (event && event === on.prompt) return { ...who, kind: 'prompt' };
  if (event && (event === on.subStart || event === on.subStop)) {
    const agentKind = text(payload.agent_type);
    return { ...who, kind: event === on.subStart ? 'subagent-start' : 'subagent-end', ...(agentKind ? { agentKind } : {}) };
  }
  if (!event || event !== on.after) return null;
  if (is(tools.skill)) {
    const skill = text(input.skill) ?? text(input.name);
    return skill ? { ...who, kind: 'skill-read', skill, via: 'tool' } : null;
  }
  if (is(tools.read)) {
    const skill = skillFromPath(fileOf(input));
    return skill ? { ...who, kind: 'skill-read', skill, via: 'file' } : null;
  }
  if (shape.shellReads && is(tools.shell)) {
    const m = String(input.command ?? input.cmd ?? '').match(/([^\s'"]*[\\/]skills[\\/][^\s'"]+[\\/]SKILL\.md)/);
    const skill = m ? skillFromPath(m[1]) : null;
    return skill ? { ...who, kind: 'skill-read', skill, via: 'file' } : null;
  }
  return null;
}

/** 코어의 답 → 그 도구의 출력 */
export function toShaped(shape: Shape, h: Happened, r: Reply): HookResult {
  if (shape.reply) return shape.reply(h, r);
  const out = (o: Record<string, unknown>): HookResult => {
    if (!shape.flat) return { stdout: JSON.stringify({ hookSpecificOutput: o }) };
    const { hookEventName: _event, ...rest } = o;
    return { stdout: JSON.stringify(rest) };
  };
  if (r.say && (h.kind === 'session-start' || h.kind === 'prompt')) {
    if (shape.say === 'stdout') return { stdout: r.say };
    return out({ hookEventName: h.kind === 'session-start' ? shape.on.start : shape.on.prompt, additionalContext: r.say });
  }
  return {};
}

/** 그 도구의 훅이 부를 명령: hooks/tool.sh <도구> [갈래] */
export const toolCommand = (root: string, id: string, platform: NodeJS.Platform = process.platform) =>
  `${HOOK_MARK} sh "${shPath(path.join(root, 'hooks', 'tool.sh'), platform)}" ${id}`;

/** 걸 훅들. Claude Code 통합과 같은 두 갈래다 (기록, 셸 명령 앞). 사람이 말할 때와 파일을 고치기 전에는 걸지 않는다 */
export function shapedEntries(shape: Shape, wiring: Wiring, command: string): HookEntry[] {
  const { on, tools } = shape;
  const match = (names: string[]) => (wiring.matcher === 'none' || !names.length ? undefined : wiring.matcher === 'regex' ? `^(${names.join('|')})$` : names.join('|'));
  const entry = (event: string | undefined, names: string[] | null, mode = ''): HookEntry[] => {
    if (!event || (names && !names.length)) return [];
    const matcher = names ? match(names) : undefined;
    return [{ event, ...(matcher !== undefined ? { matcher } : {}), command: `${command}${mode}`, ...(wiring.extra ? { extra: wiring.extra } : {}) }];
  };
  return [
    ...entry(on.start, null), ...entry(on.subStart, null), ...entry(on.subStop, null),
    ...entry(on.after, [...tools.read, ...(tools.skill ?? []), ...(shape.shellReads ? tools.shell : [])]),
    // 셸 명령 앞: 서브에이전트가 맡은 노드를 이을 수 있을 때만 건다 (서브에이전트를 알려 주는 도구)
    ...(on.subStart ? entry(on.before, tools.shell, ' command') : []),
  ];
}

/** 설정 파일에 훅을 거는 통합 */
export function shaped(shape: Shape, wiring: Wiring): Adapter {
  const bare = wiring.wrap === 'bare';
  return {
    install(ctx: SetupCtx) {
      const file = path.join(ctx.home, wiring.file);
      installEntries(file, shapedEntries(shape, wiring, toolCommand(ctx.root, shape.id, ctx.platform)), bare);
      return { settings: [file] };
    },
    remove(wired) {
      for (const file of wired.settings ?? []) uninstallEntries(file, bare);
    },
    can: canOf(shape),
    from: (payload, mode, env) => fromShaped(shape, payload, mode, env),
    to: (h, r) => toShaped(shape, h, r),
  };
}

/** 모양에서 읽은 선언: 서브에이전트 사건을 거는가, 세션 시작을 거는가, skill을 읽는 도구를 아는가 */
export function canOf(shape: Pick<Shape, 'on' | 'tools' | 'shellReads'>): Can {
  return {
    subagents: Boolean(shape.on.subStart),
    start: Boolean(shape.on.start),
    skills: shape.tools.read.length + (shape.tools.skill?.length ?? 0) > 0 || Boolean(shape.shellReads),
  };
}

/** 훅을 한 줄씩 납작하게 적는 파일에 거는 통합 (flat.ts) */
export function flatShaped(shape: Shape, o: { file: string; matcher: Wiring['matcher']; each?: Record<string, unknown>; bare?: boolean; version?: boolean; matcherAs?: (m: string) => unknown }): Adapter {
  return {
    install(ctx: SetupCtx) {
      const file = path.join(ctx.home, o.file);
      const entries = shapedEntries(shape, { file: o.file, wrap: 'hooks', matcher: o.matcher }, toolCommand(ctx.root, shape.id, ctx.platform));
      installFlat(file, entries.map(e => ({ event: e.event, ...(e.matcher !== undefined ? { matcher: e.matcher } : {}), command: e.command })), o.each ?? {}, o);
      return { settings: [file] };
    },
    remove(wired) {
      for (const file of wired.settings ?? []) uninstallFlat(file, o);
    },
    can: canOf(shape),
    from: (payload, mode, env) => fromShaped(shape, payload, mode, env),
    to: (h, r) => toShaped(shape, h, r),
  };
}

/** 플러그인이 넘기는 입력의 모양: Claude Code의 사건 이름과 도구 이름 그대로 (플러그인이 그 도구의 이름을 이렇게 바꿔 넘긴다) */
export const PLUGIN_SHAPE = {
  on: { start: 'SessionStart', prompt: 'UserPromptSubmit', before: 'PreToolUse', after: 'PostToolUse', subStart: 'SubagentStart', subStop: 'SubagentStop' },
  tools: { shell: ['Bash'], read: ['Read'], skill: ['Skill'] },
} satisfies Omit<Shape, 'id'>;

/** 플러그인 파일 안에서 muwi 훅 스크립트의 자리를 가리키는 표시. 넣을 때 실제 경로로 바꾼다 */
const HOOK_SLOT = '__MUWI_HOOK__';

/**
 * 플러그인(확장) 파일로 붙는 도구의 통합. 그 도구의 플러그인 폴더에 우리 파일을 넣는다 (muwi 설치 위치의 connectors/<도구>/).
 * 플러그인은 그 도구의 사건을 Claude Code와 같은 모양의 JSON으로 바꿔 hooks/tool.sh <도구> [갈래]에 넘기고, 답을 그 도구에 적용한다.
 * to: 설정 폴더 기준으로 넣을 폴더. files: 넣을 파일들 (connectors/<도구>/ 기준)
 */
export function plugged(id: string, o: { to: string; files: string[]; can?: Partial<Can> }): Adapter {
  const shape: Shape = { id, ...PLUGIN_SHAPE };
  return {
    can: { ...canOf(shape), ...o.can },
    install(ctx: SetupCtx) {
      const script = path.join(ctx.root, 'hooks', 'tool.sh');
      // 플러그인이 이 스크립트를 바로 실행한다
      try {
        fs.chmodSync(script, 0o755);
      } catch {
        // 권한을 바꾸지 못하면 그대로 둔다 (이미 실행할 수 있게 들어 있다)
      }
      const files = o.files.map(name => {
        const file = path.join(ctx.home, o.to, name);
        const source = fs.readFileSync(path.join(ctx.root, 'connectors', id, name), 'utf8');
        writeText(file, source.split(HOOK_SLOT).join(shPath(script, ctx.platform)));
        return file;
      });
      return { files };
    },
    remove(wired) {
      for (const file of wired.files ?? []) fs.rmSync(file, { force: true });
    },
    from: (payload, mode, env) => fromShaped(shape, payload, mode, env),
    to: (h, r) => toShaped(shape, h, r),
  };
}
