// 휴지통 (src/trash.ts): 지운 때로 30일을 세고, 지나면 비운다. 같은 작업을 여러 번 지우면 가장 최근 것을 되살린다
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clock } from '../src/store.ts';
import { TRASH_DAYS, daysLeft, listTrash, purgeTrash, restoreWork, trashWork } from '../src/trash.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const at = (days: number) => { clock.now = () => new Date(T0 + days * DAY); };
const make = (dir: string, work: string, text: string) => {
  fs.mkdirSync(path.join(dir, work), { recursive: true });
  fs.writeFileSync(path.join(dir, work, 'note.md'), text);
};

test('휴지통: 30일이 지난 것만 비우고, 남은 날을 센다. 같은 작업은 가장 최근에 지운 것을 되살린다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-trash-'));
  try {
    at(0);
    make(dir, 'a', '첫째');
    trashWork(dir, 'a');
    at(10);
    make(dir, 'a', '둘째');
    trashWork(dir, 'a');
    make(dir, 'b', 'b');
    trashWork(dir, 'b');
    assert.deepEqual(listTrash(dir).map(t => t.work).sort(), ['a', 'a', 'b']);
    assert.equal(listTrash(dir).at(-1)?.at, T0);
    assert.deepEqual(listTrash(dir).map(t => daysLeft(t)).sort(), [20, 30, 30]);
    // 30일이 된 것(처음 지운 a)만 비운다
    at(TRASH_DAYS);
    assert.deepEqual(purgeTrash(dir), ['a']);
    assert.equal(listTrash(dir).length, 2);
    // 같은 이름이 있으면 되살리지 않고, 없으면 가장 최근 것을 되살린다
    make(dir, 'a', '새 작업');
    assert.equal(restoreWork(dir, 'a'), 'leftover'); // 계획 없는 폴더에 파일이 있다
    fs.writeFileSync(path.join(dir, 'a', 'plan.json'), '{}');
    assert.equal(restoreWork(dir, 'a'), 'taken'); // 같은 이름의 작업이 있다
    fs.rmSync(path.join(dir, 'a'), { recursive: true });
    assert.equal((restoreWork(dir, 'a') as { work: string }).work, 'a');
    assert.equal(fs.readFileSync(path.join(dir, 'a', 'note.md'), 'utf8'), '둘째');
    assert.equal(restoreWork(dir, 'zzz'), null);
  } finally {
    clock.now = () => new Date();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
