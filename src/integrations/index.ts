// 도구별 통합의 목록. 도구를 더할 때는 tools.ts의 표에 한 줄, 여기 한 줄을 넣는다.
import { claude } from './claude.ts';
import { antigravity, codex, copilot, cursor, devin, droid, grok, hermes, kilo, kimi, letta, mastracode, omp, opencode, pi, qodercli, qwen } from './hooked.ts';
import type { Adapter } from './types.ts';

export const ADAPTERS: Record<string, Adapter> = {
  claude,
  codex,
  copilot,
  cursor,
  qwen,
  qodercli,
  kimi,
  'antigravity-cli': antigravity,
  droid,
  devin,
  grok,
  mastracode,
  letta,
  opencode,
  kilo,
  omp,
  pi,
  hermes,
};

export const adapterOf = (id: string | undefined | null): Adapter | null => (id && ADAPTERS[id]) || null;
