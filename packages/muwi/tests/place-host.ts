// 시험용 화면: $TEST_PLACE를 이 프로세스가 도는 자리(터미널)로 본다. 세션 상태와 맡긴 노드는 모른다.
// 코어의 시험이 특정 화면(Herdr)에 기대지 않고 "자리를 알려 주는 화면이 있을 때"를 시험하게 한다
import type { Host } from '../src/host.ts';

export const placeHost: Host = {
  name: 'test',
  place: env => (env.TEST_PLACE ? { key: `place-${env.TEST_PLACE}`, terminal: env.TEST_PLACE } : null),
  sessionStarted: () => {},
  assigned: () => null,
  states: () => ({ closed: new Map(), status: new Map() }),
};
