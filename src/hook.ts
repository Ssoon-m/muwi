// Claude Code 훅이 넘겨주는 입력을 처리한다.
//   세션이 시작되면 세션 파일을 만들고, skill을 읽으면 사건 기록에 한 줄 남긴다.
//   읽은 skill은 AI가 스스로 적지 않는다. 여기서 관찰한 것만 기록이 된다.
// nudge 모드는 계획을 적지 않은 세션이 파일을 고치려 할 때 알려 준다. 지침만으로는 계획을 적지 않는 때가 있어서다.
//   계획을 적거나(muwi plan, muwi node … start) 계획 없이 진행하겠다고 밝히면(muwi skip) 그 뒤로는 지나간다. 순서는 막지 않는다.
// guard 모드(선택 설치)는 push·PR·댓글처럼 되돌릴 수 없는 명령 앞에서 사람에게 묻게 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, nowIso, readConfig, readPlan } from './store.ts';
import { markSettled, recordSkill, sessionKey, touchSession } from './session.ts';
import { instructionText } from './setup.ts';

/** muwi가 설치된 곳 (이 파일의 위 폴더) */
export const ROOT = path.resolve(import.meta.dirname, '..');

/** 세션이 시작될 때 넣어 줄 지침. 항상 읽히는 지침을 설정 파일에 적어 두는 대신 훅이 넣는다 */
export function sessionInstructions(root: string = ROOT): string {
  try {
    return instructionText(fs.readFileSync(path.join(root, 'hooks', 'instructions.md'), 'utf8'));
  } catch {
    return '';
  }
}

/** SKILL.md 경로에서 skill 이름을 꺼낸다. skills 폴더 아래의 SKILL.md만 skill로 본다 */
export function skillFromPath(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const parts = file.split(/[\\/]/);
  if (parts[parts.length - 1] !== 'SKILL.md' || parts.length < 3) return null;
  if (!parts.slice(0, -2).includes('skills')) return null;
  return parts[parts.length - 2] || null;
}

/** git 뒤에 오는 하위 명령. `git -C 폴더 push`처럼 옵션이 끼어 있어도 찾는다 */
function gitSubcommand(tokens: string[]): string | null {
  const i = tokens.findIndex(t => t === 'git' || t.endsWith('/git'));
  if (i < 0) return null;
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') j++; // 값이 따라오는 옵션
    else if (!t.startsWith('-')) return t;
  }
  return null;
}

/** 사람이 확인해야 하는 명령이면 무엇인지 돌려준다 */
export function guardReason(command: unknown): string | null {
  if (typeof command !== 'string') return null;
  // 따옴표 안의 글(커밋 메시지 등)에 push라는 말이 있어도 걸리지 않게 따옴표 안은 비운다
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const part of bare.split(/[;&|\n()]+/)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (gitSubcommand(tokens) === 'push') return 'git push';
    const gh = tokens.findIndex(t => t === 'gh' || t.endsWith('/gh'));
    if (gh >= 0 && tokens[gh + 1] === 'pr' && ['create', 'merge', 'comment', 'review', 'close', 'edit', 'ready'].includes(tokens[gh + 2])) {
      return `gh pr ${tokens[gh + 2]}`;
    }
  }
  const writes = /(-X\s*['"]?(POST|PUT|DELETE)|(^|\s)(-d|--data|--data-raw|--data-binary|--json)(\s|=))/i;
  if (/api\.bitbucket\.org/.test(command) && /pullrequests/.test(command) && writes.test(command)) return 'Bitbucket PR 생성·댓글';
  return null;
}

export type HookResult = { stdout?: string };

export const NUDGE = [
  'muwi: 이 세션은 아직 작업 계획을 적지 않았어요. 사람은 그 계획을 그래프로 보면서 진행을 확인해요. 아래 둘 중 하나를 하고 수정을 다시 시도하세요.',
  '1) 파일을 고치는 작업이면 계획을 적는다 (작은 작업이면 노드 두세 개로 충분해요):',
  `   muwi plan --work <저장소>-<작업키> --request "<시킨 말>" '{"title":"…","nodes":[{"id":"…","title":"…"},{"id":"…","title":"…","after":["…"]}]}'`,
  '   muwi node <id> start',
  '   다른 세션이 맡긴 노드를 하는 중이면: muwi node <id> start --work <작업 이름>',
  '2) 오타처럼 한 곳만 고치는 일이거나 기록할 작업이 아니면: muwi skip "<이유>"',
].join('\n');

/** 작업물이 아닌 곳(기록 폴더, 에이전트 설정, 임시 폴더)에 쓰는 파일은 알리지 않는다 */
export function isScratchPath(file: unknown, dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof file !== 'string' || !file) return true;
  const home = env.HOME || os.homedir();
  const roots = [dir, path.join(home, '.muwi'), path.join(home, '.claude'), path.join(home, '.codex'), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
  if (env.TMPDIR) roots.push(env.TMPDIR.replace(/\/+$/, ''));
  const full = path.resolve(file);
  return roots.some(r => full === r || full.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

export function handleHook(payload: any, dir: string, mode: 'record' | 'guard' | 'nudge' = 'record', env: NodeJS.ProcessEnv = process.env, root: string = ROOT): HookResult {
  if (payload == null || typeof payload !== 'object') return {};
  const event = payload.hook_event_name;
  const tool = payload.tool_name;

  if (mode === 'guard') {
    if (event !== 'PreToolUse' || tool !== 'Bash') return {};
    if (!readConfig(dir).guard) return {};
    const reason = guardReason(payload.tool_input?.command);
    if (!reason) return {};
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `muwi: ${reason}. 되돌릴 수 없는 행동이라 사람이 확인한 뒤에 실행해요`,
        },
      }),
    };
  }

  const key: string | null = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : sessionKey(env);
  if (!key) return {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const patch = { tool: 'claude' as const, ...(cwd ? { cwd } : {}) };

  if (mode === 'nudge') {
    if (event !== 'PreToolUse') return {};
    if (!readConfig(dir).nudge) {
      markSettled(dir, key);
      return {};
    }
    if (isScratchPath(payload.tool_input?.file_path ?? payload.tool_input?.notebook_path, dir, env)) return {};
    const session = touchSession(dir, key, patch, env);
    const planned = Boolean(session.work && readPlan(dir, session.work));
    if (planned || session.skipped) {
      markSettled(dir, key);
      return {};
    }
    if (!session.nudged) touchSession(dir, key, { nudged: nowIso() }, env);
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NUDGE },
      }),
    };
  }

  if (event === 'SessionStart') {
    const session = touchSession(dir, key, patch, env);
    // 대화가 요약되면 앞에서 읽은 skill 내용이 흐려질 수 있다. 기록에 남겨 두면 나중에 원인을 볼 때 단서가 된다
    if (payload.source === 'compact' && session.work && readPlan(dir, session.work)) {
      appendEvent(dir, session.work, { type: 'session', what: 'compact' }, key);
    }
    const text = sessionInstructions(root);
    if (!text) return {};
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) };
  }

  if (event !== 'PostToolUse') return {};
  if (tool === 'Skill') {
    const skill = payload.tool_input?.skill;
    if (typeof skill !== 'string' || !skill) return {};
    if (payload.tool_response && payload.tool_response.success === false) return {};
    recordSkill(dir, key, skill, 'tool', patch, env);
  } else if (tool === 'Read') {
    const skill = skillFromPath(payload.tool_input?.file_path);
    if (skill) recordSkill(dir, key, skill, 'file', patch, env);
  }
  return {};
}
