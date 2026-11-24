// 닫힌 세션을 이어 하는 데 쓸 사실을 모은다. muwi resume과 보기의 이어 하기 버튼이 쓴다.
// 보기는 파일을 볼 수 없을 수 있어서 muwi board가 알려 준다:
//   그 폴더가 아직 있는가 (worktree를 지웠으면 그 폴더에서는 터미널을 열 수 없다)
//   Claude 대화를 다시 열 수 있는가 (대화 파일이 없으면 claude --resume이 "No conversation found"로 끝난다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchCommand, resumeCommand, toolById } from './connectors/tools.ts';
import { TERMINAL_KEY } from './session.ts';
import type { WorkView } from './view.ts';

/** Claude Code 세션 id 모양. muwi는 Claude 세션의 id를 세션 이름으로 쓴다 */
const CLAUDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ResumeFacts = {
  /** 이 작업에 나오는 폴더(작업 폴더, 세션이 일하던 폴더, 새 세션을 띄운 폴더)가 아직 있는가 */
  exists: Record<string, boolean>;
  /** 하던 대화를 다시 열 수 있는 세션 (resume에 명령이 있는 세션) */
  resumable: string[];
  /** 세션 → 하던 대화를 다시 여는 명령. 그 도구가 이어 가기를 알고, 대화가 남아 있을 때만 */
  resume: Record<string, string[]>;
  /** 세션 → 그 세션의 도구로 새 대화를 띄우는 명령. {prompt} 자리에 첫 말을 넣는다 (없으면 첫 말을 받지 못하는 도구) */
  launch: Record<string, string[]>;
  /** 이 작업을 새 대화로 이어 갈 때 띄울 명령: 계획을 낸 세션의 도구 */
  launcher: string[];
  /** 이 작업에 나오는 도구의 이름 (도구 id → 사람이 읽는 이름) */
  toolNames: Record<string, string>;
};


/** Claude Code는 대화를 <설정 폴더>/projects/<폴더 경로의 글자 아닌 것을 -로 바꾼 이름>/<세션 id>.jsonl에 남긴다 */
export function resumeFacts(v: Pick<WorkView, 'cwd' | 'sessions' | 'nodes' | 'lead'>, env: NodeJS.ProcessEnv = process.env): ResumeFacts {
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
  const resume: Record<string, string[]> = {};
  const launch: Record<string, string[]> = {};
  for (const [key, s] of Object.entries(v.sessions)) {
    if (toolById(s.tool)) launch[key] = launchCommand(s.tool);
    // Claude Code는 대화 파일이 남아 있어야 열린다. 다른 도구는 그 도구의 대화 id가 있으면 이어 가기 명령을 쓴다.
    // 터미널을 세션으로 본 도구는 훅이 적어 둔 대화 id(native)를 쓴다
    const id = s.native ?? (key.startsWith(TERMINAL_KEY) ? null : key);
    const can = s.tool === 'claude' ? CLAUDE_ID.test(key) && saved(key, s.cwd) : Boolean(id);
    const command = can && id ? resumeCommand(s.tool, id) : null;
    if (command) resume[key] = command;
  }
  const launcher = (v.lead && launch[v.lead]) || launchCommand('claude');
  const toolNames = Object.fromEntries(Object.values(v.sessions).map(s => toolById(s.tool)).filter(t => t !== null).map(t => [t!.id, t!.name]));
  return { exists, resumable: Object.keys(resume), resume, launch, launcher, toolNames };
}
