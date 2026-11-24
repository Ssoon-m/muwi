// muwi board: 보기(그래프 칸 등)가 읽는 기록 한 벌 (JSON).
//   작업 목록, 고른 작업의 노드와 기록, 그래프 좌표, 이어 하기에 쓸 사실, 최근 세션과 그 터미널, 보기가 더한 값.
// 보기는 이것만 읽고 그린다. 기록을 바꾸지 않는다.
import { str, type Args, out } from './kit.ts';
import { views } from './plugins.ts';
import { resumeFacts } from './resume.ts';
import { recentSessions } from './session.ts';
import { clock } from './store.ts';
import { PAST_DAYS, loadBoard, loadView, type WorkView } from './view.ts';
// 그래프 배치(ELK)는 무거워서 board를 그릴 때만 불러온다 (훅은 이 파일을 자주 불러온다)
import type { Fit, Flow } from './layout.ts';

/** board의 모양이 바뀌면 올린다. 보기는 모르는 판이면 다시 깔라고 알린다 */
export const BOARD_VERSION = 1;

/** prefer: 칸 모양으로 정한 흐름 방향. fit(칸 크기)을 알면 칸에 훨씬 크게 들어가는 쪽으로 바꿀 수 있다. 실제로 쓴 방향을 flow로 돌려준다 */
async function withLayout(v: WorkView, prefer: Flow = 'right', fit?: Fit) {
  const { layoutFor, layoutProblems } = await import('./layout.ts');
  const { layout, flow } = await layoutFor({ nodes: v.nodes, edges: v.edges }, prefer, fit);
  return { ...v, layout, flow, layoutProblems: layoutProblems(layout, flow) };
}

export async function cmdBoard(a: Args, dir: string) {
  // 작업 시간을 센 때. 보기는 진행 중인 노드에 이 뒤로 흐른 시간을 더해 초마다 늘린다
  const now = clock.now().getTime();
  const board = loadBoard(dir);
  // 고른 작업이 없으면 맨 위 작업을 보여 준다. 접어 둔 지난 작업보다 지금 작업이 먼저다
  const pick = str(a, 'work') ?? (board.works.find(w => !w.past) ?? board.works[0])?.work;
  let selected = null;
  if (pick) {
    const v = loadView(dir, pick);
    // --down: 칸이 세로로 길면 위→아래로 그린다. --fit WxH: 칸의 크기. 반대 방향이 칸에 훨씬 크게 들어가면 그 방향으로 그린다
    // 닫힌 세션을 이어 하는 데 쓸 것(폴더가 있는가, 대화를 다시 열 수 있는가)도 함께 넘긴다
    const m = /^(\d+)x(\d+)$/.exec(str(a, 'fit') ?? '');
    const fit = m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
    if (v) selected = { ...(await withLayout(v, a.flags.down ? 'down' : 'right', fit)), ...resumeFacts(v) };
  }
  // 보기가 터미널과 작업을 잇는 데 쓴다 (지금 보는 터미널의 작업 따라가기, 계획 없는 세션 가려내기)
  const sessions = recentSessions(dir, Date.now() - PAST_DAYS * 86_400_000);
  // 보기가 더한 값 (그 보기만 읽는다)
  const extra = Object.assign({}, ...views().map(v => v.board?.(dir) ?? {}));
  out(JSON.stringify({ version: BOARD_VERSION, dir, now, ...board, sessions, ...extra, selected }));
}
