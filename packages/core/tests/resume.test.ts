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

test('새 대화로 이어 갈 때 띄울 도구: 계획을 낸 세션의 도구, 모르면 가장 최근에 일한 세션의 도구. 아무도 모르면 띄우지 않는다 (기본 도구는 없다)', () => {
  const env = { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'muwi-launch-')) } as NodeJS.ProcessEnv;
  const facts = (lead: string | null, sessions: Record<string, { label: string; tool: string; seenAt?: string }>) =>
    resumeFacts({ cwd: undefined, lead, sessions, nodes: [] } as never, env);
  const sessions = {
    lead: { label: 't1', tool: 'codex', seenAt: '2026-11-25T01:00:00Z' },
    later: { label: 't2', tool: 'gemini', seenAt: '2026-11-25T03:00:00Z' },
    older: { label: 't3', tool: 'claude', seenAt: '2026-11-25T02:00:00Z' },
  };
  assert.equal(facts('lead', sessions).launcher?.[0], 'codex');
  // 계획을 낸 세션의 도구를 모른다: 그 작업에서 가장 최근에 일한 세션의 도구
  assert.equal(facts('lead', { ...sessions, lead: { label: 't1', tool: 'unknown' } }).launcher?.[0], 'gemini');
  // 아무 세션의 도구도 모른다
  assert.equal(facts('lead', { lead: { label: 't1', tool: 'unknown' } }).launcher, null);
});
