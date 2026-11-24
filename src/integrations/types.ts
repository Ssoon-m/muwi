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

/**
 * 커넥터가 선언하는 것: 그 도구가 훅으로 알려 주는 것.
 * 없는 것은 muwi가 어느 도구에서나 되는 길로 메운다 (에이전트가 muwi 명령으로 직접 적고, 세션이 일하는지는 Herdr가 알려 준다).
 * 그래서 선언이 모두 false인 커넥터에서도 계획·진행·서브에이전트 표시는 된다. 선언은 "더 정확해지는 것"을 말한다
 */
export type Can = {
  /** 서브에이전트의 시작·끝과 그 안에서 일어난 일을 알려 준다. 없으면 --sub로 스스로 밝힌 노드만 서브에이전트가 한 것으로 나온다 */
  subagents: boolean;
  /** 세션이 시작될 때를 알려 준다. 없으면 맡긴 세션(muwi run)이 그 세션의 첫 muwi 명령에서 노드에 붙는다 */
  start: boolean;
  /** skill을 읽는 것을 알려 준다. 없으면 읽은 skill이 "볼 수 없었음"으로 나온다 */
  skills: boolean;
};

/** 선언에 없는 것을 사람이 읽는 말로 (muwi setup --tools와 문서의 도구 표) */
export function gaps(can: Can): string[] {
  return [
    can.subagents ? '' : '서브에이전트는 --sub로 밝힌 노드만 표시',
    can.skills ? '' : '읽은 skill 기록 안 됨',
    can.start ? '' : '맡긴 세션은 첫 muwi 명령에서 붙음',
  ].filter(Boolean);
}

/**
 * 커넥터: 한 AI 도구를 muwi에 끼우는 데 필요한 전부. 코어는 도구를 모르고, 도구마다 다른 것은 여기에 둔다.
 * 꼭 해야 하는 일은 넷이다: 넣기(install), 빼기(remove), 그 도구의 말을 공통 사건으로(from), 코어의 답을 그 도구의 말로(to).
 * 코어의 답은 "말해 주기(say)"와 "돌려보내기(stop)" 둘뿐이다
 */
export type Adapter = {
  /** 이 도구의 훅이 알려 주는 것 */
  can: Can;
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
