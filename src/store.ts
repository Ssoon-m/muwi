// 기록 파일. 작업마다 폴더 하나에 두 파일을 둔다.
//   plan.json     지금의 계획 (노드, 순서, 상태). AI가 muwi 명령으로 쓴다
//   events.jsonl  일어난 일을 한 줄씩 (노드 시작·끝, 계획 변경과 이유, 읽은 skill, 문제 표시). muwi와 훅이 쓴다
// 이 파일들은 기록일 뿐이다. 순서를 막거나 다음 할 일을 정하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type NodeStatus = 'todo' | 'doing' | 'waiting' | 'blocked' | 'done';
export const STATUSES: NodeStatus[] = ['todo', 'doing', 'waiting', 'blocked', 'done'];

/** 누가 하나: me 계획을 낸 세션이 직접, subagent 서브에이전트, session 새 세션. 정하는 것은 계획을 쓰는 쪽(AI)이다 */
export type RunBy = 'me' | 'subagent' | 'session';
export const RUN_BY: RunBy[] = ['me', 'subagent', 'session'];
/** 새 세션을 Herdr 앱의 어디에 보여 줄지 */
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
};

export type Plan = {
  work: string;
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
  | { type: 'plan'; by: 'ai' | 'human'; why?: string; first?: boolean; added: string[]; removed: string[]; changed: string[] }
  | { type: 'node'; node: string; status: NodeStatus; note?: string }
  /** agent: 서브에이전트가 읽었으면 그 서브에이전트의 id */
  | { type: 'skill'; skill: string; via: 'tool' | 'file'; carried?: boolean; agent?: string }
  /** 서브에이전트가 시작하고 끝난 것, 그리고 서브에이전트가 노드를 시작한 것(bind). 훅이 적는다 */
  | { type: 'agent'; agent: string; what: 'start' | 'stop' | 'bind'; kind?: string; node?: string }
  /** 노드를 맡길 새 세션을 띄웠다 (muwi run). terminal은 Herdr 터미널 주소 */
  | { type: 'spawn'; node: string; terminal: string; name?: string; show?: ShowIn }
  | { type: 'flag'; node?: string; text: string }
  | { type: 'session'; what: 'compact' };

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

/** 켜고 끄는 것 (muwi config). 파일이 없으면 기본값 */
export type Config = {
  /** 계획을 적지 않은 세션이 파일을 고치려 할 때 알린다 */
  nudge: boolean;
  /** push·PR·댓글 앞에서 사람에게 묻는다 */
  guard: boolean;
};
export const DEFAULT_CONFIG: Config = { nudge: true, guard: false };
const configFile = (dir: string) => path.join(dir, 'config.json');

export function readConfig(dir: string): Config {
  try {
    return { ...DEFAULT_CONFIG, ...(readJson<Partial<Config>>(configFile(dir)) ?? {}) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(dir: string, config: Config) {
  writeJson(configFile(dir), config);
}
