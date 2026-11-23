// 닫힌 세션을 이어 하는 버튼(그래프 칸의 "이어서 하려면")에 쓸 사실을 모은다.
// 그래프 칸(Herdr 앱 mod)은 파일을 볼 수 없어서 muwi board가 알려 준다:
//   그 폴더가 아직 있는가 (worktree를 지웠으면 그 폴더에서는 터미널을 열 수 없다)
//   Claude 대화를 다시 열 수 있는가 (대화 파일이 없으면 claude --resume이 "No conversation found"로 끝난다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkView } from './view.ts';

/** Claude Code 세션 id 모양. muwi는 Claude 세션의 id를 세션 이름으로 쓴다 */
const CLAUDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResumeFacts = {
  /** 이 작업에 나오는 폴더(작업 폴더, 세션이 일하던 폴더, 새 세션을 띄운 폴더)가 아직 있는가 */
  exists: Record<string, boolean>;
  /** claude --resume으로 다시 열 수 있는 세션: 대화 파일이 남아 있다 */
  resumable: string[];
};

/** Claude Code는 대화를 <설정 폴더>/projects/<폴더 경로의 글자 아닌 것을 -로 바꾼 이름>/<세션 id>.jsonl에 남긴다 */
export function resumeFacts(v: Pick<WorkView, 'cwd' | 'sessions' | 'nodes'>, env: NodeJS.ProcessEnv = process.env): ResumeFacts {
  const folders = new Set<string>();
  if (v.cwd) folders.add(v.cwd);
  for (const s of Object.values(v.sessions)) if (s.cwd) folders.add(s.cwd);
  for (const n of v.nodes) for (const sp of n.spawns ?? []) if (sp.cwd) folders.add(sp.cwd);
  const exists = Object.fromEntries([...folders].map(f => [f, fs.existsSync(f)]));

  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude'), 'projects');
  let dirs: string[] | null = null;
  const saved = (key: string, cwd?: string) => {
    // 보통은 그 폴더 이름으로 된 곳에 있다. 못 찾으면 모든 프로젝트 폴더를 본다 (이름 짓는 법이 바뀌어도 찾게)
    if (cwd && fs.existsSync(path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${key}.jsonl`))) return true;
    dirs ??= (() => {
      try {
        return fs.readdirSync(projects);
      } catch {
        return [];
      }
    })();
    return dirs.some(d => fs.existsSync(path.join(projects, d, `${key}.jsonl`)));
  };
  const resumable = Object.entries(v.sessions)
    .filter(([key, s]) => s.tool === 'claude' && CLAUDE_ID.test(key) && saved(key, s.cwd))
    .map(([key]) => key);
  return { exists, resumable };
}
