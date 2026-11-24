// 명령들이 같이 쓰는 것: 인자 읽기, 출력, 실패, 어느 작업에 적을지 고르기.
// 코어의 명령과 화면 패키지(herdr-muwi)가 더하는 명령이 함께 쓴다.
import { attach, readSession, sessionKey } from './session.ts';
import { checkWorkName, listWorks, readPlan, type Plan } from './store.ts';

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
export const VALUED: ReadonlySet<string> = new Set(['work', 'request', 'title', 'why', 'by', 'file', 'after', 'before', 'result', 'run', 'show', 'from', 'event', 'tool']);

/**
 * Herdr 화면(herdr-muwi)이 더하는 명령의 이름. 코어만 깐 사람이 이 명령을 치면 어느 패키지에 있는지 알려 주려고 이름만 둔다.
 * herdr-muwi의 시험이 이 목록과 화면이 더하는 명령이 같은지 본다
 */
export const SCREEN_COMMANDS: ReadonlySet<string> = new Set(['board', 'layout', 'open', 'run', 'tidy']);

/** 명령의 인자를 읽는다. valued: 값을 받는 옵션들 (화면이 더하는 명령은 자기 옵션을 더해서 준다) */
export function parseArgs(argv: string[], valued: ReadonlySet<string> = VALUED) {
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

/** 이 명령을 실행한 세션을 그 작업에 붙인다 (그 뒤의 명령과 훅이 그 작업에 적는다) */
export function join(dir: string, work: string) {
  const key = sessionKey();
  if (key) attach(dir, key, work);
}

/** 걸린 시간을 사람이 읽는 글로 (4m 1s, 1h 1m 1s) */
export function dur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
