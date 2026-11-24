// 훅이 들어오는 문. 도구의 훅 입력을 그 도구의 통합으로 공통 사건으로 바꾸고, 코어(events.ts)가 처리한 답을 다시 그 도구의 형식으로 돌려준다.
// 지금은 Claude Code 통합 하나다 (src/integrations/claude.ts). 사건을 기록하는 일은 모두 events.ts에 있다
import { ROOT, handleEvent } from './events.ts';
import { fromClaude, toClaude, type HookMode, type HookResult } from './integrations/claude.ts';

export { NUDGE, ROOT, childNote, guardReason, instructionsHash, isScratchPath, nodeStartIn, nudgeText, sessionInstructions, skillFromPath } from './events.ts';
export type { HookResult } from './integrations/claude.ts';

export function handleHook(payload: any, dir: string, mode: HookMode = 'record', env: NodeJS.ProcessEnv = process.env, root: string = ROOT): HookResult {
  const happened = fromClaude(payload, mode, env);
  if (!happened) return {};
  return toClaude(happened, handleEvent(happened, dir, env, root));
}
