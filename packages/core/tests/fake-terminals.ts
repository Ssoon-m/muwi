// 시험용 터미널 연결: 코어의 시험이 특정 멀티플렉서(Herdr)에 기대지 않고 터미널 연결이 있을 때를 시험하게 한다.
//   $TEST_PLACE                 이 프로세스가 도는 터미널
//   $FAKE_TERMINALS_LOG         부른 동작을 한 줄씩 적을 파일 (JSON)
//   $FAKE_TERMINALS_LIVE        살아 있는 터미널들 (JSON 배열: [{"terminal":"t7","agent":"working"}]). 없으면 목록을 물어보지 못한 것으로 본다
//   $FAKE_LAUNCH                띄운 터미널의 주소 (기본 t7). $FAKE_LAUNCH_FAIL이 있으면 띄우지 못한다
//   $FAKE_UNDELIVERED           첫 말이 전달되지 않았다고 알린다
import fs from 'node:fs';
import type { Terminals } from '../src/plugins.ts';

const log = (env: NodeJS.ProcessEnv, entry: Record<string, unknown>) => {
  if (env.FAKE_TERMINALS_LOG) fs.appendFileSync(env.FAKE_TERMINALS_LOG, JSON.stringify(entry) + '\n');
};

export const fakeTerminals: Terminals = {
  name: '시험 연결',
  package: '@muwi/fake-terminals',
  place: env => (env.TEST_PLACE ? { terminal: env.TEST_PLACE } : null),
  list: env => (env.FAKE_TERMINALS_LIVE ? JSON.parse(env.FAKE_TERMINALS_LIVE) : null),
  launch(o, env) {
    log(env, { do: 'launch', ...o });
    if (env.FAKE_LAUNCH_FAIL) throw new Error(env.FAKE_LAUNCH_FAIL);
    return { terminal: env.FAKE_LAUNCH || 't7', name: o.name.toLowerCase(), ...(env.FAKE_UNDELIVERED ? { delivered: false } : {}) };
  },
  send(terminal, text, env) {
    log(env, { do: 'send', terminal, text });
    return !env.FAKE_SEND_FAIL;
  },
  read(terminal, env) {
    log(env, { do: 'read', terminal });
    return `${terminal}의 화면\n둘째 줄\n`;
  },
  close(terminal, env) {
    log(env, { do: 'close', terminal });
    return true;
  },
  arrange(terminal, spot, near, env) {
    log(env, { do: 'arrange', terminal, spot, near });
    return { ok: true };
  },
};

export default fakeTerminals;

/** 기록된 동작들 */
export const calls = (file: string): Record<string, any>[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
