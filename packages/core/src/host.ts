// 화면 규격: 세션들이 도는 곳(터미널 앱)과, 기록을 보여 주는 화면. 코어는 그것이 무엇인지 모른다.
// @muwi/herdr-app이 Herdr로 구현한다. 화면이 없으면 코어는 "모름"으로 돈다:
//   계획과 진행 기록, muwi show·status는 그대로 되고, 세션이 살아 있는지는 알 수 없어 적힌 그대로 보여 준다.
// 화면은 $MUWI_HOST(화면 모듈의 경로)나, muwi setup이 setup.json에 적어 둔 경로에서 불러온다.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson } from './store.ts';

/**
 * 이 프로세스가 도는 자리 (터미널). key는 세션 id를 주지 않는 도구에서 세션 이름으로 쓴다.
 * terminal: 그 자리의 주소 (세션 파일에 적어 두고, 화면이 그 세션의 상태를 볼 때와 그 자리로 갈 때 쓴다). pane: 화면 안의 칸
 */
export type Place = { key: string; terminal?: string; pane?: string };

/** 세션들의 지금 상태. closed: 닫힌 세션과 그 세션을 마지막으로 본 시각(ms). status: 살아 있는 세션이 하는 일 (working, blocked, done, idle) */
export type SessionStates = { closed: Map<string, number>; status: Map<string, string> };

/** 맡긴 노드를 하라고 띄운 자리 (muwi run). terminal: 그 자리의 주소 */
export type Assigned = { work: string; node: string; terminal: string; model?: string };

/** 화면이 muwi setup에서 넣은 것. setup.json에 적어 두고, 뺄 때 그대로 돌려준다 */
export type HostInstall = Record<string, string>;

export type Host = {
  /** 화면 이름 (Herdr) */
  name: string;
  /** 이 프로세스가 도는 자리. 화면 밖이면 null */
  place(env: NodeJS.ProcessEnv): Place | null;
  /** 세션이 시작됐다. 그 자리에 세션 이름을 붙여 둔다 (그 자리에서 지금 도는 세션이 누구인지, 아직 살아 있는지 볼 때 쓴다) */
  sessionStarted(key: string, env: NodeJS.ProcessEnv): void;
  /** 이 화면이 지은 세션 이름(place의 key)을 사람이 읽을 짧은 이름으로. 이 화면이 지은 이름이 아니면 null */
  label?(key: string): string | null;
  /** 이 자리가 맡긴 노드를 하라고 띄운 자리면 그 작업과 노드 */
  assigned(env: NodeJS.ProcessEnv): Assigned | null;
  /** 세션들이 지금 어떤가. 판단할 수 없는 세션은 어느 쪽에도 넣지 않는다 */
  states(sessions: Record<string, { terminal?: string; seenAt?: string }>, keys: Iterable<string>, env: NodeJS.ProcessEnv): SessionStates;
  /** 화면이 더하는 명령 (muwi run, muwi layout 같은 것). argv는 명령 이름 뒤의 인자 그대로 */
  commands?: Record<string, (argv: string[], dir: string) => void | Promise<void>>;
  /** muwi --help에 덧붙일 화면 명령의 사용법 */
  help?: string;
  /** 켜고 끄는 설정 (muwi config <이름> on|off) */
  config?: Record<string, { default: boolean; about: string }>;
  /**
   * muwi setup: 화면에 넣을 것을 넣는다 (Herdr 앱의 칸 같은 것). 넣은 것을 돌려준다.
   * report: 사람이 muwi setup을 실행했다 (점검하고 화면이 어떤지 알린다). 업데이트 뒤에 훅이 다시 맞출 때는 false
   */
  setup?(o: { root: string; dir: string; env: NodeJS.ProcessEnv; log: (line: string) => void; report?: boolean }): HostInstall | null;
  /** muwi setup --remove: setup이 넣은 것을 뺀다 */
  remove?(installed: HostInstall, o: { dir: string; log: (line: string) => void }): void;
};

/** 화면이 없을 때: 자리도 세션 상태도 모른다 */
const NONE: Host = {
  name: '',
  place: () => null,
  sessionStarted: () => {},
  assigned: () => null,
  states: () => ({ closed: new Map(), status: new Map() }),
};

let current: Host = NONE;
let currentPath: string | null = null;
let failed: HostFailure | null = null;

/** 적어 둔 화면을 불러오지 못한 까닭. from: 화면의 경로 (setup.json을 읽지 못했으면 그 파일) */
export type HostFailure = { from: string; reason: string };

/** 지금 쓰는 화면. 없으면 아무것도 모르는 화면 */
export const host = (): Host => current;
/** 지금 쓰는 화면을 불러온 경로 (muwi setup이 setup.json에 적어 둔다). 화면이 없거나 코드로 정했으면 null */
export const hostPath = (): string | null => currentPath;
/** 적어 둔 화면을 불러오지 못했으면 그 경로와 까닭. 화면을 적어 두지 않았거나 불러왔으면 null */
export const hostFailure = (): HostFailure | null => failed;
/** 화면을 정한다 (시험, 화면 패키지의 입구) */
export function setHost(h: Host | null, from: string | null = null) {
  current = h ?? NONE;
  currentPath = h ? from : null;
  failed = null;
}

/**
 * 화면을 불러온다: $MUWI_HOST, 없으면 muwi setup이 적어 둔 경로 (setup.json의 host).
 * 불러오지 못하면 화면 없이 돌고, 까닭은 hostFailure()로 남긴다. 훅과 muwi setup이 이것 때문에 실패하면 안 된다
 */
export async function loadHost(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<Host> {
  let spec: string | undefined = env.MUWI_HOST;
  if (!spec) {
    const file = path.join(dir, 'setup.json');
    try {
      spec = readJson<{ host?: string }>(file)?.host;
    } catch (e: any) {
      // setup.json이 깨졌다 (muwi setup을 다시 하면 새로 적는다)
      failed = { from: file, reason: firstLine(e).replace(`: ${file}`, '') };
      return current;
    }
  }
  if (!spec) return current;
  const file = path.resolve(spec);
  try {
    const m = await import(pathToFileURL(file).href);
    const h = (m.default ?? m.host) as Host | undefined;
    if (h && typeof h.place === 'function') setHost(h, file);
    else failed = { from: file, reason: '화면 규격(host)을 내보내지 않아요' };
  } catch (e: any) {
    // 화면 패키지를 지웠거나 옮겼다 (muwi setup을 다시 하면 새 경로를 적는다)
    failed = { from: file, reason: firstLine(e) };
  }
  return current;
}

const firstLine = (e: any) => String(e?.message ?? e).split('\n')[0];
