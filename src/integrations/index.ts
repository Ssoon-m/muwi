// 도구별 통합의 목록. 도구를 더할 때는 tools.ts의 표에 한 줄, 여기 한 줄을 넣는다.
import { claude } from './claude.ts';
import type { Adapter } from './types.ts';

export const ADAPTERS: Record<string, Adapter> = {
  claude,
};

export const adapterOf = (id: string | undefined | null): Adapter | null => (id && ADAPTERS[id]) || null;
