// 카드에 붙는 다시 한 일의 표시 (app/muwi/cards.js). 화면 없이 계산만 본다
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redoChip, redoLine } from '../app/muwi/cards.js';

test('회차 칩: 한 번만 한 노드에는 없다. 끝났으면 몇 번 했는지, 하는 중이면 다시 하는 중, 응답 대기·막힘·잠시 멈춤은 몇 회차인지', () => {
  assert.equal(redoChip({ attempts: 1, status: 'done' }), null);
  assert.equal(redoChip({ attempts: 0, status: 'todo' }), null);
  assert.equal(redoChip({ attempts: 2, status: 'done' }), '두 번 함');
  assert.equal(redoChip({ attempts: 5, status: 'done' }), '다섯 번 함');
  assert.equal(redoChip({ attempts: 6, status: 'done' }), '6번 함');
  assert.equal(redoChip({ attempts: 3, status: 'doing' }), '다시 하는 중');
  assert.equal(redoChip({ attempts: 2, status: 'blocked' }), '2회차');
  assert.equal(redoChip({ attempts: 2, status: 'waiting' }), '2회차');
});

test('셋째 줄: 지금 회차가 뒤 노드에서 돌아왔으면 어디서 왜, 아니면 앞 회차의 결과', () => {
  assert.equal(redoLine({ attempts: 1 }), null);
  const back = { redo: [{ attempt: 2, prev: '처음 결과' }, { attempt: 3, from: 'review', fromTitle: '검토', reason: '꼭 고칠 것 2' }] };
  assert.deepEqual(redoLine(back), { text: '↩ 검토에서 돌아옴 · 꼭 고칠 것 2', back: true });
  assert.deepEqual(redoLine({ redo: [{ attempt: 2, from: 'review', fromTitle: '검토' }] }), { text: '↩ 검토에서 돌아옴', back: true });
  assert.deepEqual(redoLine({ redo: [{ attempt: 2, prev: '처음 결과' }] }), { text: '1번째: 처음 결과', back: false });
  assert.deepEqual(redoLine({ redo: [{ attempt: 3 }] }), { text: '2번째: 결과 없음', back: false });
});
