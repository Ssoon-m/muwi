// 도구(Claude Code, Codex …)를 모르는 코어. 도구마다 다른 훅 입력은 그 도구의 통합(src/integrations)이
// 여기서 쓰는 공통 사건(Happened)으로 바꿔서 넘기고, 여기서는 그 사건을 기록하고 할 말(Reply)을 돌려준다.
//   세션이 시작되면 세션 파일을 만들고, skill을 읽으면 사건 기록에 한 줄 남긴다.
//   읽은 skill은 AI가 스스로 적지 않는다. 여기서 관찰한 것만 기록이 된다.
// 계획을 적지 않은 세션이 파일을 고치거나 서브에이전트를 띄우려 하면 알려 준다 (before-edit, before-spawn). 지침만으로는 계획을 적지 않는 때가 있어서다.
//   둘 다 여러 단계로 하는 일의 신호다. 계획은 파일을 고치는지가 아니라 일의 크기로 정한다 (PR 리뷰처럼 고치지 않는 일도 적는다).
//   계획을 적거나(muwi plan, muwi node … start) 계획 없이 진행하겠다고 밝히면(muwi skip) 그 뒤로는 지나간다. 순서는 막지 않는다.
// push·PR·댓글처럼 되돌릴 수 없는 명령 앞에서는 사람에게 묻게 한다 (before-command, 선택 설치).
// 서브에이전트가 한 일은 사건의 agent로 구분한다 (서브에이전트는 세션 id가 부모와 같다).
// muwi run으로 뜬 새 세션은 시작할 때 맡은 작업에 붙이고 노드를 시작한 것으로 적는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, nowIso, readConfig, readEvents, readJson, readPlan } from './store.ts';
import type { PlanNode } from './store.ts';
import { attach, isSettled, markSettled, readSession, recordSkill, touchSession, unsettle, whereNow, type Session } from './session.ts';
import { LABEL_SESSION, hc, spawnedFor } from './herdr.ts';
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

/** 지침이 바뀌었는지 알아보는 데 쓰는 해시 */
export const instructionsHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

const versionOf = (root: string) => readJson<{ version?: string }>(path.join(root, 'package.json'))?.version ?? '';

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
 * 계획 없이 파일을 고치거나 서브에이전트를 띄우려 할 때 알려 주는 말. 사람이 새로 일을 시킬 때마다 다시 따진다.
 * done: 이 세션이 하던 작업이 있고 노드가 다 끝났으면 그 작업 이름 (그 작업의 연장일 수 있다)
 * spawning: 서브에이전트를 띄우려 했다
 */
export function nudgeText(done?: string, spawning = false): string {
  // 조사까지 붙여 둔다 (수정을, 서브에이전트 띄우기를)
  const act = spawning ? '서브에이전트 띄우기를' : '수정을';
  return [
    done
      ? `muwi: 이 세션이 하던 작업(${done})은 노드가 다 끝났어요. 지금 하려는 일을 어디에 적을지 정하고 ${act} 다시 시도하세요.`
      : `muwi: 지금 하려는 일의 계획이 아직 없어요. 여러 단계로 하는 일이면 파일을 고치지 않아도 계획을 적어요. 사람은 그 계획을 그래프로 보면서 진행을 확인해요. 아래 중 하나를 하고 ${act} 다시 시도하세요.`,
    ...(done ? [`- 그 작업의 연장이면 노드를 넣는다: muwi add <id> "<제목>" --why "<이유>" 그리고 muwi node <id> start`] : []),
    `- 새 일이면 계획을 적는다 (작은 일이면 노드 두세 개로 충분해요): muwi plan --work <저장소>-<작업키> --request "<시킨 말>" '{"title":"…","nodes":[{"id":"…","title":"…"},{"id":"…","title":"…","after":["…"]}]}' 그리고 muwi node <id> start`,
    '- 다른 세션이 맡긴 노드를 하는 중이면: muwi node <id> start --work <작업 이름>',
    `- 한 번에 끝나는 일이면 (${spawning ? '질문에 답하려고 잠깐 찾아보기 같은 것' : '오타처럼 한 곳만 고치는 일'}): muwi skip "<이유>" (이번에 시킨 일에만 적용돼요)`,
  ].join('\n');
}
export const NUDGE = nudgeText();

/** 작업물이 아닌 곳(기록 폴더, 에이전트 설정, 임시 폴더)에 쓰는 파일은 알리지 않는다 */
export function isScratchPath(file: unknown, dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof file !== 'string' || !file) return true;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  // macOS·Linux의 임시 폴더와 Windows의 임시 폴더(%TEMP%, %TMP%)
  const roots = [
    dir, path.join(home, '.muwi'), path.join(home, '.claude'), path.join(home, '.codex'),
    '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP,
  ].filter((r): r is string => Boolean(r));
  // Windows는 경로의 대소문자를 가리지 않는다 (C:\Users와 c:\users는 같은 곳)
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const full = norm(path.resolve(file));
  return roots.some(root => {
    const r = norm(path.resolve(root)).replace(/[\\/]+$/, '');
    return full === r || full.startsWith(r + path.sep);
  });
}

/**
 * 도구에서 일어난 일. 도구의 통합이 그 도구의 훅 입력을 이 모양으로 바꿔 준다.
 * tool: 알린 도구, session: 그 대화 (모르면 null), agent: 서브에이전트 안에서 일어났으면 그 id, cwd: 그 세션이 일하는 폴더
 */
export type Happened = { tool: Session['tool']; session: string | null; agent?: string; cwd?: string } & (
  /** 대화가 시작됐다. resumed: 대화가 요약돼 다시 시작했다 */
  | { kind: 'session-start'; resumed?: 'compact' }
  /** 사람이 새로 말을 걸었다 */
  | { kind: 'prompt' }
  /** 파일을 고치려 한다 */
  | { kind: 'before-edit'; file?: unknown }
  /** 서브에이전트를 띄우려 한다 */
  | { kind: 'before-spawn' }
  /** 셸 명령을 실행하려 한다 */
  | { kind: 'before-command'; command?: unknown }
  /** skill을 읽었다. via: 도구로 불렀나(tool), SKILL.md 파일을 읽었나(file) */
  | { kind: 'skill-read'; skill: string; via: 'tool' | 'file' }
  | { kind: 'subagent-start'; agentKind?: string }
  | { kind: 'subagent-end'; agentKind?: string }
);

/** 코어가 도구에 돌려주는 말. 통합이 그 도구가 알아듣는 형식으로 바꾼다 */
export type Reply = {
  /** AI에게 보여 줄 말 (지침, 맡은 노드) */
  say?: string;
  /** 하려던 일을 막고 보여 줄 이유 (계획 없이 고치려 할 때) */
  stop?: string;
  /** 사람에게 확인받게 하고 보여 줄 이유 (되돌릴 수 없는 명령) */
  ask?: string;
};

export function handleEvent(h: Happened, dir: string, env: NodeJS.ProcessEnv = process.env, root: string = ROOT): Reply {
  const key = h.session;
  const agent = h.agent;

  if (h.kind === 'before-command') {
    // 서브에이전트가 노드를 시작하면 그 노드를 그 서브에이전트가 한 것으로 적는다.
    // 명령만 봐서는 누가 실행했는지 알 수 없어서(세션 id가 부모와 같다) 여기서 잇는다
    const started = agent && key ? nodeStartIn(h.command) : null;
    if (started && agent && key) {
      // 명령이 실행되기 전에 불린다. 여기 적어 두면 곧 실행될 muwi node … start가 읽는다
      const starting = { ...(readSession(dir, key)?.starting ?? {}), [started.node]: { agent, at: nowIso() } };
      touchSession(dir, key, { starting, hooked: nowIso() }, env);
    }
    if (!readConfig(dir).guard) return {};
    const reason = guardReason(h.command);
    return reason ? { ask: `muwi: ${reason}. 되돌릴 수 없는 행동이라 사람이 확인한 뒤에 실행해요` } : {};
  }

  if (!key) return {};
  // hooked: 훅이 이 세션을 보고 있다는 표시. 이게 있어야 "읽은 skill이 없다"를 믿을 수 있다
  const patch = { tool: h.tool, ...(h.cwd ? { cwd: h.cwd } : {}), hooked: nowIso() };

  if (h.kind === 'before-edit' || h.kind === 'before-spawn') {
    if (!readConfig(dir).nudge) {
      markSettled(dir, key);
      return {};
    }
    // 서브에이전트를 띄우는 것은 여러 단계로 하는 일의 신호다 (PR 리뷰의 점검들처럼). 파일 수정과 똑같이 따진다
    const spawning = h.kind === 'before-spawn';
    // 서브에이전트 안에서 일어난 일은 따지지 않는다. 맡긴 세션이 이미 따졌다
    if (spawning && agent) return {};
    if (h.kind === 'before-edit' && isScratchPath(h.file, dir, env)) return {};
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
    return { stop: nudgeText(plan ? plan.work : undefined, spawning) };
  }

  if (h.kind === 'session-start') {
    const guide = sessionInstructions(root);
    const session = touchSession(dir, key, { ...patch, ...(guide ? { instructions: instructionsHash(guide) } : {}) }, env);
    // 이 터미널에서 지금 도는 세션이 누구인지 붙여 둔다. 나중에 "그 세션이 아직 살아 있나"를 볼 때 쓴다.
    // 같은 터미널에서 /clear 하거나 새로 띄우면 여기서 새 이름으로 바뀌고, 앞 세션은 닫힌 것으로 보인다
    if (env.HC_TERMINAL_ID) hc(['label', env.HC_TERMINAL_ID, `${LABEL_SESSION}=${key}`], env, 3000);
    // 대화가 요약되면 앞에서 읽은 skill 내용이 흐려질 수 있다. 기록에 남겨 두면 나중에 원인을 볼 때 단서가 된다
    if (h.resumed === 'compact' && session.work && readPlan(dir, session.work)) {
      appendEvent(dir, session.work, { type: 'session', what: 'compact' }, key);
    }
    const text = [guide, adoptSpawn(dir, key, env)].filter(Boolean).join('\n\n');
    return text ? { say: text } : {};
  }

  if (h.kind === 'prompt') {
    // 사람이 새로 말을 걸었다. 계획을 적었는지 다음 수정 때 다시 따지고, 앞에서 한 skip은 여기서 끝난다
    const before = readSession(dir, key);
    const guide = sessionInstructions(root);
    const hash = guide ? instructionsHash(guide) : undefined;
    // 세션이 시작된 뒤에 muwi가 업데이트돼 지침이 바뀌었으면 새 지침을 다시 넣는다. 세션을 새로 열지 않아도 된다
    const changed = Boolean(hash && before?.instructions && before.instructions !== hash);
    touchSession(dir, key, { ...patch, skipped: undefined, ...(hash ? { instructions: hash } : {}) }, env);
    unsettle(dir, key);
    if (!changed) return {};
    return { say: `muwi가 업데이트됐다${versionOf(root) ? ` (${versionOf(root)})` : ''}. 작업 진행 방식이 바뀌었으니 앞에서 받은 muwi 지침 대신 아래 지침을 따른다.\n\n${guide}` };
  }

  if (h.kind === 'subagent-start' || h.kind === 'subagent-end') {
    if (!agent) return {};
    const session = touchSession(dir, key, patch, env);
    const plan = session.work ? readPlan(dir, session.work) : null;
    if (session.work && plan) {
      const kind = h.agentKind;
      if (h.kind === 'subagent-start') {
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

  recordSkill(dir, key, h.skill, h.via, patch, env, agent);
  return {};
}
