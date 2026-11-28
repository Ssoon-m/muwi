// 명령들이 같이 쓰는 것: 인자 읽기, 출력, 실패, 어느 작업에 적을지 고르기.
// 코어의 명령과 보기가 더하는 명령이 함께 쓴다.
import { attach, readSession, sessionKey } from './session.ts';
import { checkWorkName, listWorks, readPlan, type Plan } from './store.ts';
import { sessionStates } from './live.ts';
import { loadView } from './view.ts';

/** 사람에게 보여 줄 이유와 함께 명령을 끝낸다 (code: 종료 코드) */
export class Fail extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

export const out = (s: string) => process.stdout.write(s + '\n');

// `muwi show | head`처럼 받는 쪽이 먼저 닫으면 조용히 끝낸다
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

/** 값을 받는 코어 명령의 옵션 (--work <이름> 같은 것). 나머지 옵션은 켜고 끄는 것으로 읽는다 */
export const VALUED: ReadonlySet<string> = new Set(['work', 'request', 'title', 'why', 'by', 'file', 'after', 'before', 'result', 'run', 'show', 'from', 'event', 'tool', 'name', 'agent', 'cwd', 'fit', 'timeout']);

/**
 * 명령의 인자를 읽는다. valued: 값을 받는 옵션들 (보기가 더하는 명령은 자기 옵션을 더해서 준다).
 * known: 그 명령이 받는 옵션들. 주면 그 밖의 옵션은 오류다 (--wrok 같은 오타가 조용히 무시되어 다른 작업에 적히지 않게)
 */
export function parseArgs(argv: string[], valued: ReadonlySet<string> = VALUED, known?: { cmd: string; flags: ReadonlySet<string> }) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (known && !known.flags.has(name)) throw unknownOption(name, known.cmd, known.flags);
      if (valued.has(name)) {
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new Fail(`--${name}에 값이 없어요`);
        flags[name] = value;
        (multi[name] ??= []).push(value);
      } else flags[name] = true;
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

/** 모르는 옵션: 그 명령이 받는 옵션과, 비슷한 이름이 있으면 그것을 알려 준다 */
function unknownOption(name: string, cmd: string, flags: ReadonlySet<string>): Fail {
  const near = [...flags].filter(f => editDistance(f, name) <= 2).sort((x, y) => editDistance(x, name) - editDistance(y, name))[0];
  const list = flags.size ? [...flags].map(f => `--${f}`).join(', ') : '없음';
  return new Fail(`모르는 옵션이에요: --${name}${near ? ` (--${near}를 쓰려던 거면 고쳐서 다시 실행해요)` : ''}. muwi ${cmd}가 받는 옵션: ${list}`, 2);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export type Args = ReturnType<typeof parseArgs>;
export const str = (a: Args, name: string) => (typeof a.flags[name] === 'string' ? (a.flags[name] as string) : undefined);

export function isDone(plan: Plan) {
  return plan.nodes.length > 0 && plan.nodes.every(n => n.status === 'done');
}

/** 이 폴더에서 시작한 작업들 (최근 것부터) */
function worksHere(dir: string): Plan[] {
  const here = process.cwd();
  return listWorks(dir)
    .map(w => readPlan(dir, w))
    .filter((p): p is Plan => Boolean(p) && p!.cwd === here)
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
}

/**
 * 이 명령이 다룰 작업: --work나 $MUWI_WORK → 이 세션이 붙어 있는 작업.
 * 적는 명령은 여기까지만 본다. 폴더를 보고 짐작하면 다른 대화가 남겨 둔 작업에 적어 버릴 수 있다.
 *   guess: 보기만 하는 명령은 그것도 없으면 이 폴더에서 시작한 작업을 쓴다
 *   open: 끝나지 않은 작업만 (이름 없이 계획을 낼 때 끝난 작업을 덮어쓰지 않게)
 */
export function resolveWork(a: Args, dir: string, o: { guess?: boolean; open?: boolean; sessionOnly?: boolean } = {}): string {
  const named = str(a, 'work') ?? process.env.MUWI_WORK;
  if (named) {
    const bad = checkWorkName(named);
    if (bad) throw new Fail(bad);
    return named;
  }
  const key = sessionKey();
  const attached = key ? readSession(dir, key)?.work : undefined;
  if (attached) {
    const plan = readPlan(dir, attached);
    if (plan && (!o.open || !isDone(plan))) return attached;
  }
  if (o.sessionOnly) throw new Fail('이 세션이 하던 작업이 없어요');
  const here = worksHere(dir);
  if (o.guess) {
    const open = here.filter(p => !isDone(p));
    if (open.length === 1) return open[0].work;
    if (!open.length && here.length === 1) return here[0].work;
  }
  // 이름이 길게 쏟아지지 않게 몇 개만 보여 준다
  const list = (here.length ? here.map(p => `${p.work}(${isDone(p) ? '끝' : '진행 중'})`) : listWorks(dir)).slice(0, 6);
  throw new Fail(
    `어느 작업인지 알 수 없어요. --work <이름>을 붙여요.${list.length ? ` ${here.length ? '이 폴더의 작업' : '있는 작업'}: ${list.join(', ')}` : ' (아직 기록된 작업이 없어요)'} 전체 목록은 muwi status`,
  );
}

export function needPlan(dir: string, work: string): Plan {
  const plan = readPlan(dir, work);
  if (!plan) throw new Fail(`작업이 없어요: ${work} (muwi status로 목록을 봐요)`);
  return plan;
}

/**
 * 이 명령을 실행한 세션을 그 작업에 붙인다 (그 뒤의 명령과 훅이 그 작업에 적는다).
 * 그 작업에서 일을 시작하는 명령(계획 적기, 노드 시작)만 부른다. 끝내기·빼기·넣기 같은 명령은 --work로 다른 작업에 적어도
 * 붙은 작업을 바꾸지 않는다. 넘어간 뒤 하던 작업을 정리하다가 지금 작업의 훅 기록이 하던 작업으로 가지 않게
 */
export function join(dir: string, work: string) {
  const key = sessionKey();
  if (!key) return;
  const prev = readSession(dir, key)?.work;
  attach(dir, key, work);
  if (prev && prev !== work) {
    const note = leftBehind(dir, prev, key);
    // 명령의 출력(--json 등)과 섞이지 않게 표준 오류로 낸다. AI는 둘 다 본다
    if (note) process.stderr.write(`${note}\n`);
  }
}

/**
 * 세션이 다른 작업으로 옮겨 붙었다. 하던 작업에 끝나지 않은 노드가 남았고 그 작업에 붙은 다른 (살아 있는) 세션이 없으면,
 * 남은 노드를 정리하는 방법을 알린다. 남긴 노드는 적어 줄 세션이 없어 그대로 남는다 (그래프에는 "다른 작업으로 감")
 */
function leftBehind(dir: string, work: string, key: string): string | null {
  const v = loadView(dir, work);
  if (!v || v.state === 'done') return null;
  const left = v.nodes.filter(n => n.status !== 'done');
  if (!left.length) return null;
  const others = Object.entries(v.sessions).filter(([k, s]) => k !== key && s.work === work).map(([k]) => k);
  if (others.length) {
    const { closed } = sessionStates(dir, others);
    if (others.some(k => !closed.has(k))) return null;
  }
  const name = (n: (typeof left)[number]) =>
    n.status === 'todo' ? (n.paused ? '잠시 멈춤' : '시작 전') : ({ doing: '작업 중', waiting: '응답 대기', blocked: '막힘' } as Record<string, string>)[n.status];
  return [
    `※ 이 세션이 하던 작업 ${work}에 끝나지 않은 노드가 남았어요: ${left.map(n => `${n.id}(${name(n)})`).join(', ')}. 이 작업을 맡은 세션이 없어 그래프에 그대로 남아요.`,
    `  이미 끝낸 일이면 muwi node <id> done "<결과>" --work ${work}, 하지 않을 일이면 muwi remove <id> --why "<이유>" --work ${work}로 맞춰요 (이 세션은 지금 작업에 그대로 붙어 있어요). 나중에 이어 할 일이면 그대로 둬요.`,
  ].join('\n');
}

/** 걸린 시간을 사람이 읽는 글로 (4m 1s, 1h 1m 1s) */
export function dur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
