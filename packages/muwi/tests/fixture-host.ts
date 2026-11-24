// 시험용 화면 모듈: muwi setup이 적어 둔 경로나 $MUWI_HOST에서 불러오는 화면의 모양을 시험한다.
// 화면이 더하는 명령(hello), 사용법, 설정(demo)을 갖는다. 자리와 세션 상태는 모른다
import type { Host } from '../src/host.ts';

const fixture: Host = {
  name: 'fixture',
  place: () => null,
  sessionStarted: () => {},
  assigned: () => null,
  states: () => ({ closed: new Map(), status: new Map() }),
  commands: {
    hello: (argv, dir) => {
      process.stdout.write(`hello ${argv.join(' ')} (${dir ? '기록 폴더 있음' : ''})\n`);
    },
  },
  help: '  시험 화면\n  muwi hello <말>                      인사한다',
  config: { demo: { default: true, about: '시험용 설정' } },
};

export default fixture;
