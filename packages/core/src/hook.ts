// 훅이 들어오는 문. 도구의 훅 입력을 그 도구의 커넥터로 공통 사건으로 바꾸고, 코어(events.ts)가 처리한 답을 다시 그 도구의 형식으로 돌려준다.
// 어느 도구의 훅인지는 훅 명령이 알려 준다 (hooks/tool.sh <도구> → muwi hook --from <도구>). 기본 도구는 없다. 사건을 기록하는 일은 모두 events.ts에 있다
import { ROOT, handleEvent, type Happened } from './events.ts';
import { adapterOf } from './connectors/index.ts';
import type { HookMode, HookResult } from './connectors/types.ts';

export { ROOT, adoptSpawn, childNote, fileGuideHash, guideUpdate, instructionsHash, nodeStartIn, sessionInstructions, skillFromPath } from './events.ts';
export type { HookMode, HookResult } from './connectors/types.ts';

/** 훅 하나를 처리한다. from: 어느 도구의 훅인가 (그 도구의 커넥터로 읽는다). seen: 어떤 사건이었는지 부른 쪽에 알려 준다 (설치를 새 위치로 맞출 때를 고르는 데 쓴다) */
export function handleHook(
  from: string, payload: any, dir: string, mode: HookMode = 'record', env: NodeJS.ProcessEnv = process.env, root: string = ROOT,
  seen?: (h: Happened) => void,
): HookResult {
  const adapter = adapterOf(from);
  if (!adapter) return {};
  const nothing: HookResult = adapter.empty ? { stdout: adapter.empty } : {};
  const happened = adapter.from(payload, mode, env);
  if (!happened) return nothing;
  seen?.(happened);
  const reply = handleEvent(happened, dir, env, root);
  // 사람에게 보여 줄 말(새 판 알림)을 도구 화면에 바로 띄울 수 없는 도구는 AI가 전하게 한다
  const told = reply.notice && !adapter.can.tell
    ? { say: [reply.say, `(muwi) 사용자에게 다음 한 줄을 그대로 한 번 전한다: ${reply.notice}`].filter(Boolean).join('\n\n') }
    : reply;
  const result = adapter.to(happened, told);
  return result.stdout || result.stderr || result.code ? result : nothing;
}
