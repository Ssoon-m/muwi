// 카드에 붙는 다시 한 일의 표시 (muwi board가 주는 노드의 attempts, redo. core의 flow.ts).
// 그래프는 계획 그대로이고, 카드의 표시가 실제로 일어난 일(타임라인)과 잇는다.

const TIMES = { 2: "두", 3: "세", 4: "네", 5: "다섯" };

/** 회차 칩: 다시 한 노드만. 끝났으면 몇 번 했는지, 아니면 다시 하는 중 */
export function redoChip(n) {
  if (!(n.attempts > 1)) return null;
  if (n.status !== "done") return "다시 하는 중";
  return TIMES[n.attempts] ? `${TIMES[n.attempts]} 번 함` : `${n.attempts}번 함`;
}

/**
 * 카드 셋째 줄: 지금 회차가 어디서 왜 돌아왔는지, 또는 앞 회차의 결과. 다시 한 노드만 (layout이 그만큼 높게 놓는다).
 * back: 계획상 뒤 노드에서 돌아왔다 (응답 대기 색으로 그린다)
 */
export function redoLine(n) {
  const r = n.redo?.[n.redo.length - 1];
  if (!r) return null;
  if (r.from) return { text: `↩ ${r.fromTitle}에서 돌아옴${r.reason ? ` · ${r.reason}` : ""}`, back: true };
  return { text: `${r.attempt - 1}번째: ${r.prev ?? "결과 없음"}`, back: false };
}
