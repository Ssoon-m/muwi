// 도구(Claude Code, Codex …)를 모르는 코어. 도구마다 다른 훅 입력은 그 도구의 커넥터(src/connectors)이
// 여기서 쓰는 공통 사건(Happened)으로 바꿔서 넘기고, 여기서는 그 사건을 기록하고 할 말(Reply)을 돌려준다.
//   세션이 시작되면 세션 파일을 만들고, skill을 읽으면 사건 기록에 한 줄 남긴다.
//   읽은 skill은 AI가 스스로 적지 않는다. 여기서 관찰한 것만 기록이 된다.
// muwi는 AI가 하려는 일을 막지 않는다. 계획을 적을지는 AI가 일의 크기를 보고 정하고, 적지 않았으면 작은 일이라고 본 것이다.
//   그래서 코어의 답은 "말해 주기(say)" 하나다. 훅은 관찰만 한다: 세션 시작과 끝, 말을 걸고 끝낸 때, 읽은 skill, 서브에이전트.
// 무엇을 승인받고 할지는 muwi가 정하지 않는다 (그 도구의 권한 설정과 사용자의 훅이 할 일이다). 셸 명령 앞(before-command)에서는 막지 않고,
//   서브에이전트가 노드를 시작하는 명령인지만 본다.
// 서브에이전트가 한 일은 사건의 agent로 구분한다 (서브에이전트는 세션 id가 부모와 같다).
// muwi run으로 뜬 새 세션은 시작할 때 맡은 작업에 붙이고 노드를 시작한 것으로 적는다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, nowIso, readEvents, readJson, readPlan } from './store.ts';
import type { Event, PlanNode } from './store.ts';
import { attach, readSession, recordSkill, touchSession, whereNow, type Session } from './session.ts';
import { terminals } from './plugins.ts';
import { markNode } from './node.ts';
import { BLOCK_END, BLOCK_START, instructionText } from './connectors/files.ts';
import { toolById, toolHome } from './connectors/tools.ts';

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

/**
 * 그 도구가 늘 읽는 지침 파일(AGENTS.md 등)에 지금 들어 있는 우리 구간의 해시. 그 도구의 세션은 이 지침을 읽고 시작한다.
 * muwi를 업데이트한 뒤 muwi setup을 다시 하지 않았으면 옛 지침일 수 있다. 지침 파일이 없는 도구이거나 구간이 없으면 undefined
 */
export function fileGuideHash(tool: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = toolById(tool);
  if (!t?.instructions) return undefined;
  try {
    const text = fs.readFileSync(path.join(toolHome(t, env, env.HOME || os.homedir()), t.instructions), 'utf8');
    const a = text.indexOf(BLOCK_START);
    const b = a < 0 ? -1 : text.indexOf(BLOCK_END, a);
    if (b < 0) return undefined;
    const body = instructionText(text.slice(a, b + BLOCK_END.length));
    return body ? instructionsHash(body) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 세션이 받은 지침이 지금 판과 다르면 새 지침을 돌려준다 (muwi가 업데이트된 뒤에도 열려 있던 세션). 같거나 알 수 없으면 null.
 * muwi 명령이 출력 끝에 붙여서 전한다. 에이전트는 일하는 동안 muwi 명령을 계속 실행하므로, 훅으로 말을 넣을 수 없는 도구에서도 닿는다.
 * 그 세션을 처음 보면(지침을 훅이나 지침 파일로 받았다) 그때 받은 판을 적어 둔다
 */
export function guideUpdate(dir: string, key: string, env: NodeJS.ProcessEnv = process.env, root: string = ROOT): string | null {
  const guide = sessionInstructions(root);
  if (!guide) return null;
  const hash = instructionsHash(guide);
  const session = readSession(dir, key);
  const seen = session?.instructions ?? (session?.tool ? fileGuideHash(session.tool, env) : undefined);
  if (seen === hash) {
    if (!session?.instructions) touchSession(dir, key, { instructions: hash }, env);
    return null;
  }
  touchSession(dir, key, { instructions: hash }, env);
  if (!seen) return null;
  return `muwi가 업데이트됐다${versionOf(root) ? ` (${versionOf(root)})` : ''}. 작업 진행 방식이 바뀌었으니 앞에서 받은 muwi 지침 대신 아래 지침을 따른다.\n\n${guide}`;
}

const versionOf = (root: string) => readJson<{ version?: string }>(path.join(root, 'package.json'))?.version ?? '';

/** SKILL.md 경로에서 skill 이름을 꺼낸다. skills 폴더 아래의 SKILL.md만 skill로 본다 */
export function skillFromPath(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const parts = file.split(/[\\/]/);
  if (parts[parts.length - 1] !== 'SKILL.md' || parts.length < 3) return null;
  if (!parts.slice(0, -2).includes('skills')) return null;
  return parts[parts.length - 2] || null;
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
    '- 끝났거나 막혔으면 `muwi tell "<결과나 막힌 점>"`으로 맡긴 세션에 알린다.',
    '- 전체 계획과 다른 노드의 진행은 `muwi show`로 본다.',
  ].join('\n');
}

/** muwi run이 띄운 프로그램에 넘기는 환경 변수: 띄운 것의 이름표, 맡긴 작업과 노드 */
export const RUN_ENV = { id: 'MUWI_RUN', work: 'MUWI_RUN_WORK', node: 'MUWI_RUN_NODE' } as const;

/** muwi run이 띄운 터미널마다 남기는 표 (환경 변수를 넘기지 못하는 연결을 위한 것). 기록 폴더의 .spawns/<터미널>.json */
export const spawnFile = (dir: string, terminal: string) => path.join(dir, '.spawns', `${terminal.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

/** 이 프로세스가 muwi run으로 뜬 것이면 그 이름표와 작업·노드. 환경 변수에서 읽고, 없으면 이 터미널에 남긴 표에서 읽는다 */
export function assignedHere(dir: string, env: NodeJS.ProcessEnv): { id: string; work: string; node: string } | null {
  if (env[RUN_ENV.id] && env[RUN_ENV.work] && env[RUN_ENV.node]) return { id: env[RUN_ENV.id]!, work: env[RUN_ENV.work]!, node: env[RUN_ENV.node]! };
  const terminal = terminals().place(env)?.terminal;
  if (!terminal) return null;
  const got = readJson<{ id?: string; work?: string; node?: string }>(spawnFile(dir, terminal));
  return got?.id && got.work && got.node ? { id: got.id, work: got.work, node: got.node } : null;
}

/** muwi run으로 뜬 세션이면 맡은 작업에 붙이고 노드를 시작한 것으로 적는다. 그 세션에 알려 줄 말을 돌려준다 */
export function adoptSpawn(dir: string, key: string, env: NodeJS.ProcessEnv): string {
  const got = assignedHere(dir, env);
  if (!got) return '';
  const node = readPlan(dir, got.work)?.nodes.find(n => n.id === got.node);
  if (!node) return '';
  const events = readEvents(dir, got.work);
  const spawn = events.find(e => e.type === 'spawn' && e.id === got.id) as (Event & { type: 'spawn' }) | undefined;
  if (!spawn) return '';
  // 환경 변수는 그 터미널에서 나중에 뜬 프로그램에도 남는다. 처음 붙은 세션만 맡은 것으로 본다.
  // 나중에 같은 터미널에서 /clear 하고 시작한 다른 대화를 옛 노드에 다시 붙이지 않는다
  const joined = events.find(e => e.type === 'join' && e.spawn === got.id);
  if (joined && joined.session !== key) return '';
  if (!joined && node.status === 'done') return '';
  attach(dir, key, got.work, env);
  // 훅이 모델을 알려 주지 않았으면 띄울 때 준 모델을 그 세션의 모델로 적는다 (훅이 알려 준 값이 있으면 그것이 더 정확하다)
  if (spawn.model && !readSession(dir, key)?.model) touchSession(dir, key, { model: spawn.model }, env);
  if (!joined) {
    const terminal = terminals().place(env)?.terminal ?? spawn.terminal;
    appendEvent(dir, got.work, { type: 'join', node: got.node, spawn: got.id, ...(terminal ? { terminal } : {}) }, key);
    // 기다리는 노드는 그대로 둔다
    if (node.status === 'todo' || node.status === 'doing') markNode(dir, got.work, got.node, 'doing', undefined, key, env);
  }
  // 대화가 요약돼 다시 시작한 것이면 상태는 건드리지 않고, 맡은 노드만 다시 알려 준다
  return childNote(got.work, node);
}

/**
 * 도구에서 일어난 일. 도구의 커넥터가 그 도구의 훅 입력을 이 모양으로 바꿔 준다.
 * tool: 알린 도구, session: 그 대화 (모르면 null), agent: 서브에이전트 안에서 일어났으면 그 id, cwd: 그 세션이 일하는 폴더,
 * model: 그 세션이 쓰는 모델 (도구가 알려 줄 때), native: 터미널을 세션으로 볼 때 그 도구가 붙인 대화 id
 */
export type Happened = { tool: Session['tool']; session: string | null; agent?: string; cwd?: string; model?: string; native?: string } & (
  /** 대화가 시작됐다. resumed: 대화가 요약돼 다시 시작했다 */
  | { kind: 'session-start'; resumed?: 'compact' }
  /** 사람이 새로 말을 걸었다 */
  | { kind: 'prompt' }
  /** 에이전트가 말을 끝내고 다음 말을 기다린다 */
  | { kind: 'turn-end' }
  /** 세션이 끝났다 (도구를 닫았거나 /clear) */
  | { kind: 'session-end' }
  /** 셸 명령을 실행하려 한다 */
  | { kind: 'before-command'; command?: unknown }
  /** skill을 읽었다. via: 도구로 불렀나(tool), SKILL.md 파일을 읽었나(file) */
  | { kind: 'skill-read'; skill: string; via: 'tool' | 'file' }
  | { kind: 'subagent-start'; agentKind?: string }
  | { kind: 'subagent-end'; agentKind?: string }
);

/** 코어가 도구에 돌려주는 말. 커넥터가 그 도구가 알아듣는 형식으로 바꾼다 */
export type Reply = {
  /** AI에게 보여 줄 말 (지침, 맡은 노드) */
  say?: string;
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
    return {};
  }

  if (!key) return {};
  // hooked: 훅이 이 세션을 보고 있다는 표시. 이게 있어야 "읽은 skill이 없다"를 믿을 수 있다
  // 서브에이전트의 모델은 세션의 모델로 적지 않는다
  const patch = { tool: h.tool, ...(h.cwd ? { cwd: h.cwd } : {}), ...(h.model && !agent ? { model: h.model } : {}), ...(h.native && !agent ? { native: h.native } : {}), hooked: nowIso() };

  if (h.kind === 'session-start') {
    const guide = sessionInstructions(root);
    // 늘 읽히는 지침 파일이 있는 도구(AGENTS.md 등)는 지침이 이미 거기 있다. 두 번 넣지 않는다.
    // 그 세션이 받은 지침은 그 파일에 들어 있는 판이다 (muwi setup을 다시 하지 않았으면 옛 판일 수 있고, 그러면 다음 muwi 명령이 새 지침을 전한다)
    const inFile = Boolean(toolById(h.tool)?.instructions);
    const got = inFile ? fileGuideHash(h.tool, env) : guide ? instructionsHash(guide) : undefined;
    const session = touchSession(dir, key, { ...patch, ...(got ? { instructions: got } : {}) }, env);
    // 세션 파일에 이 세션이 도는 터미널과 시작한 때가 적힌다. 같은 터미널에서 /clear 하거나 새로 띄우면
    // 더 늦게 시작한 세션이 생기므로 앞 세션은 닫힌 것으로 보인다 (live.ts)
    // 대화가 요약되면 앞에서 읽은 skill 내용이 흐려질 수 있다. 기록에 남겨 두면 나중에 원인을 볼 때 단서가 된다
    if (h.resumed === 'compact' && session.work && readPlan(dir, session.work)) {
      appendEvent(dir, session.work, { type: 'session', what: 'compact' }, key);
    }
    const text = [inFile ? '' : guide, adoptSpawn(dir, key, env)].filter(Boolean).join('\n\n');
    return text ? { say: text } : {};
  }

  if (h.kind === 'prompt' || h.kind === 'turn-end') {
    // 사람이 말을 걸었거나 에이전트가 말을 끝냈다. 세션이 지금 일하는지 기다리는지를 적어 둔다 (live.ts가 읽는다).
    // 지침이 바뀐 것은 여기서 넣지 않는다. 말할 때 문맥을 넣을 수 없는 도구가 있어서, 어느 도구에서나 되는 muwi 명령의 출력으로 전한다 (guideUpdate)
    // 서브에이전트가 끝난 것은 세션의 차례가 아니다
    if (agent) return {};
    touchSession(dir, key, { ...patch, turn: h.kind === 'prompt' ? 'working' : 'done' }, env);
    return {};
  }

  if (h.kind === 'session-end') {
    if (agent) return {};
    touchSession(dir, key, { ...patch, endedAt: nowIso() }, env);
    return {};
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
