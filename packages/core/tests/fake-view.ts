// 시험용 보기: muwi setup이 적어 둔 경로나 $MUWI_VIEWS에서 불러오는 보기의 모양을 시험한다.
// 보기가 더하는 명령(hello), 사용법, 설정(demo), board에 더하는 값, setup에서 넣는 칸(기록 폴더의 fixture-mod)을 갖는다
import fs from 'node:fs';
import path from 'node:path';
import type { View } from '../src/plugins.ts';

const fixture: View = {
  name: '시험 보기',
  package: '@muwi/fake-view',
  commands: {
    hello: (argv, dir) => {
      process.stdout.write(`hello ${argv.join(' ')} (${dir ? '기록 폴더 있음' : ''})\n`);
    },
  },
  help: '  시험 보기\n  muwi hello <말>                      인사한다',
  config: { demo: { default: true, about: '시험용 설정' } },
  board: () => ({ demo: 'from-view' }),
  setup: o => {
    const mod = path.join(o.dir, 'fixture-mod');
    fs.mkdirSync(mod, { recursive: true });
    o.log(`시험 보기 칸: ${mod}`);
    return { mod };
  },
  remove: (installed, o) => {
    if (installed.mod) fs.rmSync(installed.mod, { recursive: true, force: true });
    o.log('시험 보기 칸을 뺐어요');
  },
};

export default fixture;
