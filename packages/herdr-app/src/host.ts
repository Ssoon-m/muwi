// Herdr 화면: 화면 규격(../host.ts)을 Herdr 앱(herdr-app)과 hc로 구현한다.
//   자리: Herdr 앱의 터미널($HC_TERMINAL_ID), 없으면 herdr의 pane($HERDR_PANE_ID)
//   세션이 살아 있는지: hc가 알려 주는 터미널의 상태와, 세션이 시작될 때 터미널에 붙여 둔 이름표
//   맡긴 노드: muwi run이 터미널을 띄울 때 붙인 이름표
import type { Host } from '@muwi/core/host';
import { board, CONFIG, layout, open, run, tidy } from './commands.ts';
import { LABEL_SESSION, hc, spawnedFor } from './hc.ts';
import { removeHerdr, setupHerdr } from './install.ts';
import { sessionStates } from './live.ts';

const HELP = `  새 세션에 맡기기 (Herdr 앱 안에서)
  muwi run <id> "<맡길 일>" [--show pane|tab] [--down] [--name <이름>] [--agent "<명령>"] [--cwd <폴더>]
                                       노드를 맡을 세션을 띄운다. 그 세션은 뜨면서 이 작업의 그 노드에 붙는다
                                       기다릴 때는 hc wait --children any, 말을 걸 때는 hc send <주소> "…"
  muwi tidy [<작업>]                    끝난 노드를 맡았던 새 세션의 터미널을 닫는다 (사람이 정리하라고 할 때)

  Herdr 앱 화면
  muwi open [--right]                  Herdr 앱에서 그래프 칸을 이 터미널 아래(--right면 오른쪽)에 연다
  muwi layout                          지금 레이아웃을 복제해 사이드바 Agents 자리에 작업 목록을, 터미널 아래에
                                       그래프를 넣고 그 레이아웃으로 바꾼다. 원래 레이아웃은 그대로 남는다
  muwi layout --graph bottom|top|right 그래프 칸을 터미널 아래·위·오른쪽에 둔다 (전에 고른 자리를 기억한다)
  muwi layout --status [--json]        지금 화면에 muwi 칸이 있는지, 넣을 자리가 있는지 본다
  muwi layout --remove                 원래 레이아웃으로 돌아가고 muwi가 만든 복제본을 지운다
  muwi board [--work <작업>] [--down] [--fit WxH]   그래프 칸이 읽는 기록 (JSON)`;

const herdr: Host = {
  name: 'Herdr',
  place(env) {
    if (env.HC_TERMINAL_ID) return { key: `hc-${env.HC_TERMINAL_ID}`, terminal: env.HC_TERMINAL_ID, ...(env.HERDR_PANE_ID ? { pane: env.HERDR_PANE_ID } : {}) };
    if (env.HERDR_PANE_ID) return { key: `herdr-${env.HERDR_PANE_ID}`, pane: env.HERDR_PANE_ID };
    return null;
  },
  // place가 지은 이름에서 터미널(pane) 주소만 보여 준다
  label: key => /^(?:hc|herdr)-(.+)$/.exec(key)?.[1] ?? null,
  // 이 터미널에서 지금 도는 세션이 누구인지 붙여 둔다. 나중에 "그 세션이 아직 살아 있나"를 볼 때 쓴다.
  // 같은 터미널에서 /clear 하거나 새로 띄우면 여기서 새 이름으로 바뀌고, 앞 세션은 닫힌 것으로 보인다
  sessionStarted(key, env) {
    if (env.HC_TERMINAL_ID) hc(['label', env.HC_TERMINAL_ID, `${LABEL_SESSION}=${key}`], env, 3000);
  },
  assigned(env) {
    const terminal = env.HC_TERMINAL_ID;
    if (!terminal) return null;
    const got = spawnedFor(terminal, env);
    return got ? { ...got, terminal } : null;
  },
  states: sessionStates,
  commands: { board, layout, open, run, tidy },
  help: HELP,
  config: CONFIG,
  setup: o => setupHerdr(o),
  remove: (installed, o) => removeHerdr(installed, o),
};

export default herdr;
