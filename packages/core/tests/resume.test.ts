import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resumeFacts } from '../src/resume.ts';

test('이어 하기 버튼에 쓸 사실: 폴더가 아직 있는가, Claude 대화 파일이 남아 있는가', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-resume-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-repo-'));
  const gone = path.join(repo, 'deleted-worktree');
  const saved = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const lost = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const elsewhere = '0f0e0d0c-0b0a-4909-8807-060504030201';
  const projects = path.join(home, '.claude', 'projects');
  // 그 폴더 이름으로 된 곳에 남긴 대화, 다른 프로젝트 폴더에 남은 대화
  fs.mkdirSync(path.join(projects, repo.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
  fs.writeFileSync(path.join(projects, repo.replace(/[^A-Za-z0-9]/g, '-'), `${saved}.jsonl`), '{}\n');
  fs.mkdirSync(path.join(projects, 'somewhere-else'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'somewhere-else', `${elsewhere}.jsonl`), '{}\n');
  const facts = resumeFacts({
    cwd: repo,
    sessions: {
      [saved]: { label: 't1', tool: 'claude', cwd: repo },
      [lost]: { label: 't2', tool: 'claude', cwd: repo },
      [elsewhere]: { label: 't3', tool: 'claude', cwd: path.join(repo, 'sub') },
      'terminal-t4': { label: 't4', tool: 'codex', cwd: repo },
    },
    nodes: [{ spawns: [{ at: '', terminal: 't5', cwd: gone }] }] as never,
  }, { HOME: home } as NodeJS.ProcessEnv);
  // 대화 파일이 있는 Claude 세션만 다시 열 수 있다 (Codex는 세션 id가 없다)
  assert.deepEqual(facts.resumable.sort(), [elsewhere, saved].sort());
  // 지운 worktree는 없다고 알린다
  assert.equal(facts.exists[repo], true);
  assert.equal(facts.exists[gone], false);
});
