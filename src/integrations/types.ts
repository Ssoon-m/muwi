// 도구 통합이 구현하는 것. 코어(events.ts)는 공통 사건만 알고, 도구마다 다른 것은 여기서 번역한다.
import type { Happened, Reply } from '../events.ts';

/** 훅이 불린 갈래. 도구가 사건을 나눠 걸 수 있으면 갈래마다 따로 건다 (볼 필요 없는 호출을 줄인다) */
/** record: 기록, nudge: 고치기·서브에이전트 띄우기 앞, command: 셸 명령 앞 (서브에이전트가 시작한 노드를 잇는다. 옛 설치는 guard라고 부른다) */
export type HookMode = 'record' | 'command' | 'nudge';
/** 훅이 도구에 돌려주는 것: 표준 출력, 표준 오류, 종료 코드 */
export type HookResult = { stdout?: string; stderr?: string; code?: number };

export type SetupCtx = {
  /** muwi가 설치된 곳 */
  root: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** 그 도구의 설정 폴더 */
  home: string;
};
/** 통합이 그 도구에 넣은 것. 다음 실행과 제거가 이걸 본다 */
export type Wired = { files?: string[]; settings?: string[] };

export type Adapter = {
  /** 훅(또는 플러그인)을 그 도구에 넣는다. 여러 번 해도 한 벌만 남는다 */
  install(ctx: SetupCtx): Wired;
  /** 넣은 것만 뺀다. 남의 설정은 그대로 둔다 */
  remove(wired: Wired): void;
  /** 그 도구의 훅 입력 → 공통 사건. 코어가 볼 일이 아니면 null */
  from(payload: any, mode: HookMode, env: NodeJS.ProcessEnv): Happened | null;
  /** 코어의 답 → 그 도구가 알아듣는 출력 */
  to(h: Happened, r: Reply): HookResult;
  /** 할 말이 없을 때도 꼭 내야 하는 출력 (빈 JSON을 요구하는 도구) */
  empty?: string;
};
