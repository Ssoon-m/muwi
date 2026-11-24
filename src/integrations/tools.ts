// muwi가 아는 AI 도구들. Herdr가 통합을 두는 도구와 같은 이름(id)을 쓴다.
// 여기는 표만 둔다 (다른 파일을 읽지 않는다): 설정 폴더, 지침 파일, 띄우는 명령처럼 도구마다 다른 값.
// 훅 입력을 번역하고 훅을 설치하는 코드는 도구별 통합(adapters)에 있다.
import path from 'node:path';

export type Tool = {
  /** Herdr의 통합 이름과 같다 (herdr integration status) */
  id: string;
  /** 사람이 읽는 이름 */
  name: string;
  /** 그 도구의 설정 폴더: 환경 변수가 있으면 그 값, 없으면 홈 아래 이 경로. 이 폴더가 있으면 그 도구가 깔린 것으로 본다 */
  home: { env?: string; path: string[] };
  /** 늘 읽히는 지침 파일 (설정 폴더 기준). 여기에 muwi 지침을 구간 표시로 넣는다. 없으면 세션이 시작될 때 훅이 넣는다 */
  instructions?: string;
  /** 사용법 skill(SKILL.md)을 넣는 폴더 (설정 폴더 기준) */
  skills?: string;
  /** 새 대화를 띄우는 명령 */
  command: string;
  /** 하던 대화를 다시 여는 명령. {id} 자리에 세션 id가 들어간다 */
  resume?: string[];
  /** 이 도구가 자식 프로세스에 주는 환경 변수. _로 끝나면 그렇게 시작하는 모든 변수. muwi 명령을 친 도구를 알아보는 데 쓴다 */
  env?: string[];
};

export const TOOLS: Tool[] = [
  { id: 'claude', name: 'Claude Code', home: { env: 'CLAUDE_CONFIG_DIR', path: ['.claude'] }, skills: 'skills', command: 'claude', resume: ['claude', '--resume', '{id}'], env: ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE'] },
  { id: 'codex', name: 'Codex', home: { env: 'CODEX_HOME', path: ['.codex'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'codex', resume: ['codex', 'resume', '{id}'], env: ['CODEX_'] },
];

export const toolById = (id: string | undefined | null): Tool | null => TOOLS.find(t => t.id === id) ?? null;

/** 그 도구의 설정 폴더 */
export function toolHome(t: Tool, env: NodeJS.ProcessEnv, home: string): string {
  const over = t.home.env ? env[t.home.env] : undefined;
  return over || path.join(home, ...t.home.path);
}

/** 환경 변수를 보고 muwi 명령을 친 도구를 알아본다. 모르면 unknown */
export function detectTool(env: NodeJS.ProcessEnv): string {
  const keys = Object.keys(env);
  for (const t of TOOLS) {
    for (const name of t.env ?? []) {
      if (name.endsWith('_') ? keys.some(k => k.startsWith(name)) : Boolean(env[name])) return t.id;
    }
  }
  return 'unknown';
}

/** 하던 대화를 다시 여는 명령. 그 도구가 이어 가기를 모르면 null */
export function resumeCommand(tool: string | undefined, session: string): string[] | null {
  const t = toolById(tool);
  return t?.resume ? t.resume.map(part => part.replace('{id}', session)) : null;
}
