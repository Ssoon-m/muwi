// Herdr 앱 보기: 코어의 보기 규격(@muwi/core/plugins의 View)을 Herdr 앱으로 채운다.
//   그래프 칸(app/muwi)은 muwi board만 읽고 그린다. 기록도 세션도 바꾸지 않는다.
//   여기서 더하는 것은 Herdr 앱 화면에 대한 것뿐이다: 레이아웃에 muwi 칸 넣기(layout), 그래프 칸 열기(open), 설치.
import type { View } from '@muwi/core/plugins';
import { CONFIG, config, layout, open } from './commands.ts';
import { removeHerdr, setupHerdr } from './install.ts';

const HELP = `  Herdr 앱 화면
  muwi open [--right]                  Herdr 앱에서 그래프 칸을 이 터미널 아래(--right면 오른쪽)에 연다
  muwi layout                          지금 레이아웃을 복제해 사이드바 Agents 자리에 작업 목록을, 터미널 아래에
                                       그래프를 넣고 그 레이아웃으로 바꾼다. 원래 레이아웃은 그대로 남는다
  muwi layout --graph bottom|top|right 그래프 칸을 터미널 아래·위·오른쪽에 둔다 (전에 고른 자리를 기억한다)
  muwi layout --status [--json]        지금 화면에 muwi 칸이 있는지, 넣을 자리가 있는지 본다
  muwi layout --remove                 원래 레이아웃으로 돌아가고 muwi가 만든 복제본을 지운다`;

const herdrApp: View = {
  name: 'Herdr 앱',
  package: '@muwi/herdr-app',
  commands: { layout, open },
  help: HELP,
  config: CONFIG,
  // 화면에 muwi 칸이 없을 때 그래프 칸이 바꾸자고 안내해도 되는가 (muwi config layout)
  board: dir => ({ suggest: config(dir).layout }),
  setup: o => setupHerdr(o),
  remove: (installed, o) => removeHerdr(installed, o),
};

export default herdrApp;
