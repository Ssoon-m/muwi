// 기록 파일. 작업마다 폴더 하나에 두 파일을 둔다.
//   plan.json     지금의 계획 (노드, 순서, 상태). AI가 muwi 명령으로 쓴다
//   events.jsonl  일어난 일을 한 줄씩 (노드 시작·끝, 계획 변경과 이유, 읽은 skill, 문제 표시). muwi와 훅이 쓴다
// 이 파일들은 기록일 뿐이다. 순서를 막거나 다음 할 일을 정하지 않는다.
//
// 훅이 본 사실(읽은 skill, 서브에이전트)은 적는 순간에 "어느 노드의 몇 번째 회차인지"를 같이 적는다.
// 나중에 시각을 맞춰 보며 짐작하지 않는다. 그러려고 계획의 노드에 "지금 하고 있는 쪽"(by)을 적어 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type NodeStatus = 'todo' | 'doing' | 'waiting' | 'blocked' | 'done';
export const STATUSES: NodeStatus[] = ['todo', 'doing', 'waiting', 'blocked', 'done'];

/** 누가 하나: me 계획을 낸 세션이 직접, subagent 서브에이전트, session 새 세션. 정하는 것은 계획을 쓰는 쪽(AI)이다 */
export type RunBy = 'me' | 'subagent' | 'session';
export const RUN_BY: RunBy[] = ['me', 'subagent', 'session'];
/** 새 세션을 어디에 보여 줄지: 부른 터미널 옆의 칸, 새 탭. 터미널 연결이 그 멀티플렉서에 맞게 놓는다 */
export type ShowIn = 'pane' | 'tab';
export const SHOW_IN: ShowIn[] = ['pane', 'tab'];

export type PlanNode = {
  id: string;
  title: string;
  /** 이 노드보다 먼저 하는 노드들. 그림의 선이 된다 */
  after: string[];
  status: NodeStatus;
  /** 마지막으로 남긴 한 줄: 끝났으면 결과, 기다리면 물어볼 것, 막혔으면 이유 */
  note?: string;
  /** 누가 할지. AI가 정했을 때만 있다 (없으면 정하지 않은 것) */
  run?: RunBy;
  /** 새 세션을 어디에 보여 줄지. AI가 정했을 때만 있다 */
  show?: ShowIn;
  /** 몇 번째 하는 중인지 (회차). 시작한 적이 없으면 없다. 끝냈거나 막혔던 노드를 다시 시작하면 올라간다 */
  attempt?: number;
  /** 지금 이 노드를 하고 있는 쪽. 작업 중일 때만 있다 */
  by?: Doer & { at: string };
};

/** 일을 한 쪽: 세션, 그리고 그 세션의 서브에이전트면 그 id */
export type Doer = { session: string | null; agent?: string };

/** 사건이 속한 자리: 어느 노드의 몇 번째 회차인지. guess는 확실하지 않을 때 (같은 쪽이 노드 여러 개를 동시에 하고 있었다) */
export type Where = { node?: string; attempt?: number; guess?: boolean };

/** 기록 형식의 판. 형식이 바뀌면 올린다 */
export const SCHEMA = 2;

export type Plan = {
  work: string;
  schema?: number;
  /** 무슨 작업인지 한 줄 */
  title?: string;
  /** 사람이 시킨 말 그대로 */
  request?: string;
  /** 작업을 시작한 폴더 */
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  nodes: PlanNode[];
};

export type EventBody =
  /** gone: 빠진 노드가 어떤 노드였는지 (빠진 뒤에도 기록에서 찾아볼 수 있게) */
  | { type: 'plan'; by: 'ai' | 'human'; why?: string; first?: boolean; added: string[]; removed: string[]; changed: string[]; gone?: { id: string; title: string; status: NodeStatus }[] }
  /**
   * attempt: 몇 번째 회차의 일인지. agent: 서브에이전트가 한 것이면 그 id.
   * seen: (시작할 때) 이 세션을 훅이 보고 있었는지. false면 이 회차에서 읽은 skill은 관찰하지 못한 것이다
   */
  /** model: 그 노드를 시작할 때 그 세션이 쓰던 모델 (도구의 훅이 알려 줄 때) */
  | { type: 'node'; node: string; status: NodeStatus; note?: string; attempt?: number; agent?: string; declared?: boolean; seen?: boolean; model?: string }
  /** agent: 서브에이전트가 읽었으면 그 id. node·attempt: 읽을 때 하고 있던 노드 (없으면 어느 노드도 하고 있지 않았다) */
  | ({ type: 'skill'; skill: string; via: 'tool' | 'file'; carried?: boolean; agent?: string } & Where)
  /** 서브에이전트가 시작하고 끝난 것. 훅이 적는다. node·attempt: 뜰 때 그 세션이 하고 있던 노드 (그 노드를 도운 것으로 본다) */
  | ({ type: 'agent'; agent: string; what: 'start' | 'stop'; kind?: string } & Where)
  /**
   * 노드를 맡길 새 세션을 띄웠다 (muwi run). id: 이번에 띄운 것의 이름표 (뜬 세션이 환경 변수로 받는다).
   * terminal: 터미널 연결이 알려 준 주소, from: 띄운 쪽의 터미널 (맡은 세션이 muwi tell로 알릴 곳), task: 그 세션에 맡긴 말
   */
  | { type: 'spawn'; id: string; node: string; terminal: string; from?: string; name?: string; show?: ShowIn; task?: string; /** 새 세션을 띄운 폴더 */ cwd?: string; /** 띄우는 명령에 준 모델 */ model?: string }
  /** muwi run으로 뜬 세션이 맡은 노드에 붙었다. spawn: 붙은 spawn의 id. 같은 터미널에서 나중에 시작한 다른 대화는 다시 붙이지 않는다 */
  | { type: 'join'; node: string; spawn: string; terminal?: string }
  /** 맡은 세션이 맡긴 쪽에 알렸다 (muwi tell) */
  | { type: 'tell'; node?: string; text: string; to?: string; sent: boolean }
  | { type: 'flag'; node?: string; text: string }
  | { type: 'session'; what: 'compact' }
  /** 사람이 끝난 작업을 봤다 (그래프 칸이 사람이 고른 그 작업을 보여 줄 때 적는다). 끝난 뒤 처음 볼 때만 적는다 */
  | { type: 'viewed' }
  /** 사람이 끝났거나 멈춘 작업을 목록에서 치웠다(archive), 다시 꺼냈다(unarchive). 기록은 그대로 둔다 */
  | { type: 'archive' }
  | { type: 'unarchive' };

export type Event = EventBody & { at: string; session: string | null };

/** 테스트에서 시각을 고정할 수 있게 한 곳에서만 지금 시각을 읽는다 */
export const clock = { now: (): Date => new Date() };
export const nowIso = () => clock.now().toISOString();

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUWI_DIR || path.join(os.homedir(), '.muwi');
}

const WORK_NAME = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]*$/;

export function checkWorkName(name: string): string | null {
  if (!WORK_NAME.test(name)) return `작업 이름에는 글자, 숫자, . _ -만 써요: ${name}`;
  if (name.length > 80) return '작업 이름이 너무 길어요 (80자까지)';
  return null;
}

export const workDir = (dir: string, work: string) => path.join(dir, work);
const planFile = (dir: string, work: string) => path.join(workDir(dir, work), 'plan.json');
const eventsFile = (dir: string, work: string) => path.join(workDir(dir, work), 'events.jsonl');

/** 같은 작업을 여러 세션이 동시에 고쳐도 계획 파일이 깨지지 않게 잠근다 */
export function withLock<T>(folder: string, fn: () => T): T {
  fs.mkdirSync(folder, { recursive: true });
  const lock = path.join(folder, '.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // 10초 넘은 잠금은 죽은 프로세스가 남긴 것으로 보고 넘겨받는다
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error('다른 muwi 명령이 같은 작업을 쓰고 있어요. 잠시 뒤 다시 실행하세요.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // 이미 지워졌으면 그대로 둔다
    }
  }
}

/** 임시 파일에 쓰고 이름을 바꿔, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다 */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`JSON이 아니에요: ${file}`);
  }
}

export const readPlan = (dir: string, work: string) => readJson<Plan>(planFile(dir, work));

export function writePlan(dir: string, plan: Plan) {
  writeJson(planFile(dir, plan.work), plan);
  // 처음 계획을 적을 때 "새 결과"를 셀 시작 시각도 적어 둔다 (그 뒤에 끝난 작업이 처음부터 새 결과로 보이게)
  resultsSince(dir);
}

export function appendEvent(dir: string, work: string, body: EventBody, session: string | null, at: string = nowIso()) {
  fs.mkdirSync(workDir(dir, work), { recursive: true });
  const ev = { at, session, ...body } as Event;
  fs.appendFileSync(eventsFile(dir, work), JSON.stringify(ev) + '\n');
  return ev;
}

/** 사건 기록 전체를 일어난 순서로. 깨진 줄은 건너뛴다 (기록이 한 줄 깨졌다고 화면이 멈추면 안 된다) */
export function readEvents(dir: string, work: string): Event[] {
  let text: string;
  try {
    text = fs.readFileSync(eventsFile(dir, work), 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: { ev: Event; i: number }[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as Event;
      if (ev && typeof ev.at === 'string' && typeof ev.type === 'string') out.push({ ev, i });
    } catch {
      // 깨진 줄
    }
  });
  // 앞 세션에서 읽은 skill은 나중에 옮겨 적으므로(carried) 시각으로 다시 줄 세운다
  out.sort((a, b) => (a.ev.at < b.ev.at ? -1 : a.ev.at > b.ev.at ? 1 : a.i - b.i));
  return out.map(o => o.ev);
}

/**
 * 이 시각 뒤에 끝난 작업만 "새 결과"(끝났는데 사람이 아직 안 봄)로 센다. 처음 셀 때 그 시각을 적어 둔다.
 * 이 기능이 생기기 전에 끝난 작업이 한꺼번에 새 결과로 뜨지 않게 하려는 것이다. 기록 폴더가 없으면 적지 않는다
 */
const sinceFile = (dir: string) => path.join(dir, '.results-since');
export function resultsSince(dir: string): string {
  try {
    const at = fs.readFileSync(sinceFile(dir), 'utf8').trim();
    if (!Number.isNaN(Date.parse(at))) return at;
  } catch {
    // 아직 적지 않았다
  }
  const at = nowIso();
  if (fs.existsSync(dir)) fs.writeFileSync(sinceFile(dir), at + '\n');
  return at;
}

/** 계획이 있는 작업 이름들 */
export function listWorks(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(planFile(dir, e.name)))
    .map(e => e.name);
}

/** 켜고 끄는 것 (muwi config). 이름과 기본값은 화면이 정한다 (화면 규격의 config) */
export type Config = Record<string, boolean>;
const configFile = (dir: string) => path.join(dir, 'config.json');

/** defaults에 있는 이름만 읽는다. 0.6.0에서 뺀 nudge, guard 같은 옛 값은 읽지 않는다 */
export function readConfig(dir: string, defaults: Config = {}): Config {
  let saved: Record<string, unknown> = {};
  try {
    saved = readJson<Record<string, unknown>>(configFile(dir)) ?? {};
  } catch {
    // 깨진 파일: 기본값
  }
  return Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, typeof saved[k] === 'boolean' ? (saved[k] as boolean) : d]));
}

export function writeConfig(dir: string, config: Config) {
  writeJson(configFile(dir), config);
}
