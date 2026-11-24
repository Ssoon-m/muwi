// 코어에 붙는 두 가지: 터미널 연결과 보기. 코어는 그것이 무엇인지(어느 멀티플렉서, 어느 앱인지) 모른다.
//   터미널 연결: 세션들이 도는 멀티플렉서와 이야기한다. 멀티플렉서만 할 수 있는 동작(이 터미널의 주소, 터미널 목록, 띄우기, 글 보내기,
//     화면 읽기, 닫기, 놓기)만 맡는다. 무엇을 띄울지, 무엇을 적을지, 세션이 닫혔는지는 코어가 정한다. 하나만 붙는다.
//   보기: 기록을 그려 보여 주는 곳 (그래프 칸 같은 것). 코어의 기록을 읽고 muwi 명령을 부를 뿐 기록을 바꾸지 않는다. 여럿 붙을 수 있다.
// 둘 다 없어도 코어는 돈다: 계획과 진행 기록, muwi show·status는 그대로 되고, 세션 상태는 훅이 알려 준 만큼만 안다.
// 어디서 불러오는지: $MUWI_TERMINALS(모듈 경로), $MUWI_VIEWS(모듈 경로들, 경로 구분자로 잇는다), 없으면 muwi setup이 setup.json에 적어 둔 경로.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './store.ts';

/** 터미널에서 도는 에이전트의 상태. none: 터미널은 있는데 에이전트가 돌지 않는다 (셸만 남았다) */
export type AgentState = 'working' | 'blocked' | 'done' | 'idle' | 'none';

/** 살아 있는 터미널 하나. agent를 모르면 없다 (그 터미널은 살아 있는 것으로 본다) */
export type TerminalState = { terminal: string; agent?: AgentState };

/** 새 터미널을 놓을 곳: 부른 터미널 옆, 아래, 새 탭 */
export type Spot = 'beside' | 'below' | 'tab';

export type Terminals = {
  /** 사람이 읽을 이름. 코어는 이 이름으로 동작을 가르지 않는다 */
  name: string;
  /** 이 모듈이 든 npm 패키지 이름. 업데이트 알림에 쓴다 */
  package?: string;
  /** 이 프로세스가 도는 터미널. 멀티플렉서 밖이면 null. pane: 터미널을 담은 칸 (멀티플렉서가 칸과 터미널을 따로 다룰 때) */
  place(env: NodeJS.ProcessEnv): { terminal: string; pane?: string } | null;
  /** 지금 살아 있는 터미널들. 물어보지 못했으면 null (그때는 아무 세션도 닫혔다고 하지 않는다) */
  list?(env: NodeJS.ProcessEnv): TerminalState[] | null;
  /**
   * 새 터미널에서 argv를 실행한다. env는 그 프로그램에 넘길 환경 변수다 (맡은 작업과 노드).
   * 띄운 터미널의 주소를 돌려준다 (name: 멀티플렉서에 맞게 고친 이름, delivered: argv에 담은 첫 말이 전달되지 않은 걸 알면 false).
   * 띄우지 못했으면 이유를 담아 던진다
   */
  launch?(o: { cwd: string; name: string; argv: string[]; env: Record<string, string> }, env: NodeJS.ProcessEnv): { terminal: string; name?: string; delivered?: boolean };
  /** 그 터미널에 글을 붙여 넣고 Enter를 누른다 */
  send?(terminal: string, text: string, env: NodeJS.ProcessEnv): boolean;
  /** 그 터미널의 화면과 지난 출력. 읽지 못했으면 null */
  read?(terminal: string, env: NodeJS.ProcessEnv): string | null;
  /** 그 터미널의 프로그램을 끝내고 터미널을 치운다 */
  close?(terminal: string, env: NodeJS.ProcessEnv): boolean;
  /** 그 터미널을 near(부른 터미널) 옆·아래나 새 탭에 놓는다. 키보드는 원래 있던 곳에 둔다 */
  arrange?(terminal: string, spot: Spot, near: string | null, env: NodeJS.ProcessEnv): { ok: boolean; error?: string };
};

/** 보기가 setup에서 넣은 것. setup.json에 적어 두고, 뺄 때 그대로 돌려준다 */
export type ViewInstall = Record<string, string>;

export type View = {
  /** 사람이 읽을 이름 */
  name: string;
  /** 이 모듈이 든 npm 패키지 이름. 업데이트 알림에 쓴다 */
  package?: string;
  /** 보기가 더하는 명령 (muwi layout 같은 것). argv는 명령 이름 뒤의 인자 그대로 */
  commands?: Record<string, (argv: string[], dir: string) => void | Promise<void>>;
  /** muwi --help에 덧붙일 사용법 */
  help?: string;
  /** 켜고 끄는 설정 (muwi config <이름> on|off) */
  config?: Record<string, { default: boolean; about: string }>;
  /** muwi board의 출력에 더할 것 (이 보기가 읽을 값) */
  board?(dir: string): Record<string, unknown>;
  /** muwi setup: 넣을 것을 넣고 넣은 것을 돌려준다. report: 사람이 muwi setup을 실행했다 (점검하고 알린다) */
  setup?(o: { root: string; dir: string; env: NodeJS.ProcessEnv; log: (line: string) => void; report?: boolean }): ViewInstall | null;
  /** muwi setup --remove: setup이 넣은 것을 뺀다 */
  remove?(installed: ViewInstall, o: { dir: string; log: (line: string) => void }): void;
};

/** 불러오지 못한 모듈과 그 까닭 */
export type PluginFailure = { from: string; reason: string };

/** 붙은 것이 없을 때의 터미널 연결: 아무것도 모른다 */
const NO_TERMINALS: Terminals = { name: '', place: () => null };

let terminalsNow: Terminals = NO_TERMINALS;
let terminalsFrom: string | null = null;
let viewsNow: { view: View; from: string | null }[] = [];
let failures: PluginFailure[] = [];

/** 지금 붙은 터미널 연결. 없으면 아무것도 모르는 연결 */
export const terminals = (): Terminals => terminalsNow;
/** 터미널 연결이 붙어 있는가 */
export const hasTerminals = (): boolean => terminalsNow !== NO_TERMINALS;
/** 지금 붙은 보기들 */
export const views = (): View[] => viewsNow.map(v => v.view);
/** 불러온 경로들 (muwi setup이 setup.json에 적는다). 코드로 정한 것은 빠진다 */
export const pluginPaths = (): { terminals: string | null; views: string[] } => ({
  terminals: terminalsFrom,
  views: viewsNow.map(v => v.from).filter((f): f is string => Boolean(f)),
});
/** 적어 둔 모듈 중 불러오지 못한 것 */
export const pluginFailures = (): PluginFailure[] => failures;

/** 터미널 연결을 정한다 (시험, 패키지의 입구) */
export function setTerminals(t: Terminals | null, from: string | null = null) {
  terminalsNow = t ?? NO_TERMINALS;
  terminalsFrom = t ? from : null;
}

/** 보기를 정한다 (시험) */
export function setViews(list: View[], from: (string | null)[] = []) {
  viewsNow = list.map((view, i) => ({ view, from: from[i] ?? null }));
}

/** setup.json에 적힌 것 */
type Saved = { terminals?: string; views?: { path: string }[] };

/**
 * 터미널 연결과 보기를 불러온다. 불러오지 못한 것은 건너뛰고 까닭을 pluginFailures()에 남긴다.
 * 훅과 muwi setup이 이것 때문에 실패하면 안 된다
 */
export async function loadPlugins(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  failures = [];
  let saved: Saved | null = null;
  const file = path.join(dir, 'setup.json');
  try {
    saved = readJson<Saved>(file);
  } catch (e: any) {
    // setup.json이 깨졌다 (muwi setup을 다시 하면 새로 적는다)
    failures.push({ from: file, reason: firstLine(e).replace(`: ${file}`, '') });
  }
  const termSpec = env.MUWI_TERMINALS || saved?.terminals;
  if (termSpec) {
    const got = await importModule(termSpec, m => typeof m?.place === 'function');
    if (got.ok) setTerminals(got.value as Terminals, got.file);
  }
  const viewSpecs = env.MUWI_VIEWS ? env.MUWI_VIEWS.split(path.delimiter).filter(Boolean) : (saved?.views ?? []).map(v => v.path);
  const loaded: { view: View; from: string | null }[] = [];
  for (const spec of viewSpecs) {
    const got = await importModule(spec, m => typeof m?.name === 'string');
    if (got.ok) loaded.push({ view: got.value as View, from: got.file });
  }
  if (viewSpecs.length) viewsNow = loaded;
}

async function importModule(spec: string, ok: (m: any) => boolean): Promise<{ ok: true; value: unknown; file: string } | { ok: false }> {
  const file = path.resolve(spec);
  try {
    const m = await import(pathToFileURL(file).href);
    const value = m.default;
    if (value && ok(value)) return { ok: true, value, file };
    failures.push({ from: file, reason: '규격에 맞는 모듈을 내보내지 않아요 (export default)' });
  } catch (e: any) {
    // 패키지를 지웠거나 옮겼다 (muwi setup을 다시 하면 새 경로를 적는다)
    failures.push({ from: file, reason: firstLine(e) });
  }
  return { ok: false };
}

const firstLine = (e: any) => String(e?.message ?? e).split('\n')[0];
