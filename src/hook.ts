// Claude Code 훅이 넘겨주는 입력을 처리한다.
//   세션이 시작되면 세션 파일을 만들고, skill을 읽으면 사건 기록에 한 줄 남긴다.
//   읽은 skill은 AI가 스스로 적지 않는다. 여기서 관찰한 것만 기록이 된다.
// nudge 모드는 계획을 적지 않은 세션이 파일을 고치려 할 때 알려 준다. 지침만으로는 계획을 적지 않는 때가 있어서다.
//   계획을 적거나(muwi plan, muwi node … start) 계획 없이 진행하겠다고 밝히면(muwi skip) 그 뒤로는 지나간다. 순서는 막지 않는다.
// guard 모드(선택 설치)는 push·PR·댓글처럼 되돌릴 수 없는 명령 앞에서 사람에게 묻게 한다.
// 서브에이전트가 한 일은 훅 입력의 agent_id로 구분한다 (서브에이전트는 세션 id가 부모와 같다).
// muwi run으로 뜬 새 세션은 시작할 때 맡은 작업에 붙이고 노드를 시작한 것으로 적는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, nowIso, readConfig, readEvents, readPlan } from './store.ts';
import type { PlanNode } from './store.ts';
import { attach, isSettled, markSettled, readSession, recordSkill, sessionKey, touchSession, unsettle, whereNow } from './session.ts';
import { spawnedFor } from './herdr.ts';
import { markNode } from './node.ts';
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

/** 명령에 `muwi node <id> start`가 있으면 그 노드(와 --work로 준 작업)를 돌려준다 */
export function nodeStartIn(command: unknown): { node: string; work?: string } | null {
  if (typeof command !== 'string') return null;
  const m = command.match(/(?:^|[\s;&|(/])muwi\s+(?:node\s+(\S+)\s+start|start\s+(\S+))(?=$|[\s;&|)])/);
  if (!m) return null;
  const node = (m[1] ?? m[2]).replace(/^['"]|['"]$/g, '');
  const w = command.match(/--work(?:=|\s+)['"]?([^\s'";&|)]+)/);
  return { node, ...(w ? { work: w[1] } : {}) };
}

/** muwi run으로 뜬 세션에 알려 줄 말. 맡은 노드와 적는 법만 말한다 */
export function childNote(work: string, node: Pick<PlanNode, 'id' | 'title'>): string {
  return [
    '## 이 세션이 맡은 노드 (muwi)',
    '',
    `이 세션은 작업 \`${work}\`의 노드 \`${node.id}\`(${node.title})를 맡아서 떴다. 이 작업에는 이미 붙어 있고, 노드의 시작도 적혀 있다.`,
    '',
    '- 계획을 새로 만들지 않는다. 맡은 일을 쪼개야 하면 `muwi add`로 같은 계획에 노드를 넣는다.',
    `- 끝나면 \`muwi node ${node.id} done "<결과 한 줄>"\`을 적는다.`,
    `- 사람의 결정이 필요하면 \`muwi node ${node.id} wait "<물어볼 것>"\`, 스스로 풀 수 없으면 \`muwi node ${node.id} block "<이유>"\`을 적는다.`,
    '- 전체 계획과 다른 노드의 진행은 `muwi show`로 본다.',
  ].join('\n');
}

/** muwi run으로 뜬 세션이면 맡은 작업에 붙이고 노드를 시작한 것으로 적는다. 그 세션에 알려 줄 말을 돌려준다 */
function adoptSpawn(dir: string, key: string, env: NodeJS.ProcessEnv): string {
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) return '';
  const got = spawnedFor(terminal, env);
  if (!got) return '';
  const node = readPlan(dir, got.work)?.nodes.find(n => n.id === got.node);
  if (!node) return '';
  // 라벨은 터미널이 닫힐 때까지 남는다. 그 터미널에서 처음 뜬 세션만 맡은 것으로 본다.
  // 나중에 같은 칸에서 /clear 하고 시작한 다른 대화를 옛 노드에 다시 붙이지 않는다
  const joined = readEvents(dir, got.work).find(e => e.type === 'join' && e.node === got.node && e.terminal === terminal);
  if (joined && joined.session !== key) return '';
  if (!joined && node.status === 'done') return '';
  attach(dir, key, got.work, env);
  if (!joined) {
    appendEvent(dir, got.work, { type: 'join', node: got.node, terminal }, key);
    // 기다리는 노드는 그대로 둔다
    if (node.status === 'todo' || node.status === 'doing') markNode(dir, got.work, got.node, 'doing', undefined, key, env);
  }
  // 대화가 요약돼 다시 시작한 것이면 상태는 건드리지 않고, 맡은 노드만 다시 알려 준다
  return childNote(got.work, node);
}

/**
 * 계획 없이 파일을 고치려 할 때 알려 주는 말. 사람이 새로 일을 시킬 때마다 다시 따진다.
 * done: 이 세션이 하던 작업이 있고 노드가 다 끝났으면 그 작업 이름 (그 작업의 연장일 수 있다)
 */
export function nudgeText(done?: string): string {
  return [
    done
      ? `muwi: 이 세션이 하던 작업(${done})은 노드가 다 끝났어요. 지금 고치려는 일을 어디에 적을지 정하고 수정을 다시 시도하세요.`
      : 'muwi: 지금 고치려는 일의 계획이 아직 없어요. 사람은 그 계획을 그래프로 보면서 진행을 확인해요. 아래 중 하나를 하고 수정을 다시 시도하세요.',
    ...(done ? [`- 그 작업의 연장이면 노드를 넣는다: muwi add <id> "<제목>" --why "<이유>" 그리고 muwi node <id> start`] : []),
    `- 새 일이면 계획을 적는다 (작은 일이면 노드 두세 개로 충분해요): muwi plan --work <저장소>-<작업키> --request "<시킨 말>" '{"title":"…","nodes":[{"id":"…","title":"…"},{"id":"…","title":"…","after":["…"]}]}' 그리고 muwi node <id> start`,
    '- 다른 세션이 맡긴 노드를 하는 중이면: muwi node <id> start --work <작업 이름>',
    '- 오타처럼 한 곳만 고치는 일이거나 기록할 작업이 아니면: muwi skip "<이유>" (이번에 시킨 일에만 적용돼요)',
  ].join('\n');
}
export const NUDGE = nudgeText();

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

  const key: string | null = typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : sessionKey(env);
  /** 서브에이전트 안에서 일어난 일이면 그 서브에이전트의 id */
  const agent: string | undefined = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : undefined;

  if (mode === 'guard') {
    if (event !== 'PreToolUse' || tool !== 'Bash') return {};
    // 서브에이전트가 노드를 시작하면 그 노드를 그 서브에이전트가 한 것으로 적는다.
    // 명령만 봐서는 누가 실행했는지 알 수 없어서(세션 id가 부모와 같다) 훅에서 잇는다
    const started = agent && key ? nodeStartIn(payload.tool_input?.command) : null;
    if (started && agent && key) {
      // 훅은 명령이 실행되기 전에 불린다. 여기 적어 두면 곧 실행될 muwi node … start가 읽는다
      const starting = { ...(readSession(dir, key)?.starting ?? {}), [started.node]: { agent, at: nowIso() } };
      touchSession(dir, key, { starting, hooked: nowIso() }, env);
    }
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

  if (!key) return {};
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  // hooked: 훅이 이 세션을 보고 있다는 표시. 이게 있어야 "읽은 skill이 없다"를 믿을 수 있다
  const patch = { tool: 'claude' as const, ...(cwd ? { cwd } : {}), hooked: nowIso() };

  if (mode === 'nudge') {
    if (event !== 'PreToolUse') return {};
    if (!readConfig(dir).nudge) {
      markSettled(dir, key);
      return {};
    }
    if (isScratchPath(payload.tool_input?.file_path ?? payload.tool_input?.notebook_path, dir, env)) return {};
    // 이번에 시킨 일에서 이미 확인했으면 다시 따지지 않는다. 사람이 새로 말을 걸면 표시가 지워진다
    if (isSettled(dir, key)) return {};
    const session = touchSession(dir, key, patch, env);
    const plan = session.work ? readPlan(dir, session.work) : null;
    // 하던 작업에 끝나지 않은 노드가 있으면 그 작업을 계속하는 것으로 본다
    const open = Boolean(plan && plan.nodes.some(n => n.status !== 'done'));
    if (open || session.skipped) {
      markSettled(dir, key);
      return {};
    }
    if (!session.nudged) touchSession(dir, key, { nudged: nowIso() }, env);
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: nudgeText(plan ? plan.work : undefined) },
      }),
    };
  }

  if (event === 'SessionStart') {
    const session = touchSession(dir, key, patch, env);
    // 대화가 요약되면 앞에서 읽은 skill 내용이 흐려질 수 있다. 기록에 남겨 두면 나중에 원인을 볼 때 단서가 된다
    if (payload.source === 'compact' && session.work && readPlan(dir, session.work)) {
      appendEvent(dir, session.work, { type: 'session', what: 'compact' }, key);
    }
    const text = [sessionInstructions(root), adoptSpawn(dir, key, env)].filter(Boolean).join('\n\n');
    if (!text) return {};
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) };
  }

  if (event === 'UserPromptSubmit') {
    // 사람이 새로 말을 걸었다. 계획을 적었는지 다음 수정 때 다시 따지고, 앞에서 한 skip은 여기서 끝난다
    touchSession(dir, key, { ...patch, skipped: undefined }, env);
    unsettle(dir, key);
    return {};
  }

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    if (!agent) return {};
    const session = touchSession(dir, key, patch, env);
    const plan = session.work ? readPlan(dir, session.work) : null;
    if (session.work && plan) {
      const kind = typeof payload.agent_type === 'string' && payload.agent_type ? payload.agent_type : undefined;
      if (event === 'SubagentStart') {
        // 뜨는 순간에 이 세션이 하고 있던 노드를 같이 적는다. 그 노드를 도운 서브에이전트로 본다
        const where = whereNow(plan, session);
        appendEvent(dir, session.work, { type: 'agent', agent, what: 'start', ...(kind ? { kind } : {}), ...where }, key);
        if (where.node && !session.agents?.[agent]?.own) {
          touchSession(dir, key, { agents: { ...(session.agents ?? {}), [agent]: { work: session.work, ...where, own: false } } }, env);
        }
      } else appendEvent(dir, session.work, { type: 'agent', agent, what: 'stop', ...(kind ? { kind } : {}) }, key);
    }
    return {};
  }

  if (event !== 'PostToolUse') return {};
  if (tool === 'Skill') {
    const skill = payload.tool_input?.skill;
    if (typeof skill !== 'string' || !skill) return {};
    if (payload.tool_response && payload.tool_response.success === false) return {};
    recordSkill(dir, key, skill, 'tool', patch, env, agent);
  } else if (tool === 'Read') {
    const skill = skillFromPath(payload.tool_input?.file_path);
    if (skill) recordSkill(dir, key, skill, 'file', patch, env, agent);
  }
  return {};
}
