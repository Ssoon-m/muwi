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
  /** 사용법 skill(SKILL.md)을 넣는 폴더. 설정 폴더 기준이고, ~/로 시작하면 홈 기준이다 (여러 도구가 같이 읽는 ~/.agents/skills) */
  skills?: string;
  /** 새 대화를 띄우는 명령 (그래프 칸의 목록과 muwi run이 쓴다) */
  command: string;
  /** 첫 말과 함께 새 대화를 띄우는 명령. {prompt} 자리에 첫 말이 들어간다. {prompt}가 없으면 첫 말을 받지 못하는 도구다 */
  launch: string[];
  /** 하던 대화를 다시 여는 명령. {id} 자리에 세션 id가 들어간다 */
  resume?: string[];
  /** 이 도구가 자식 프로세스에 주는 환경 변수. _로 끝나면 그렇게 시작하는 모든 변수. muwi 명령을 친 도구를 알아보는 데 쓴다 */
  env?: string[];
  /** 셸 명령에 세션 id를 넘겨주는 환경 변수. 이게 없는 도구는 muwi 명령이 대화를 알 수 없어서, 훅도 터미널을 세션으로 본다 */
  sessionEnv?: string;
  /** 통합을 넣은 뒤 사람이 한 번 해야 하는 일 */
  note?: string;
};

export const TOOLS: Tool[] = [
  { id: 'claude', name: 'Claude Code', home: { env: 'CLAUDE_CONFIG_DIR', path: ['.claude'] }, skills: 'skills', command: 'claude', launch: ['claude', '{prompt}'], resume: ['claude', '--resume', '{id}'], env: ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE'], sessionEnv: 'CLAUDE_CODE_SESSION_ID' },
  { id: 'codex', name: 'Codex', home: { env: 'CODEX_HOME', path: ['.codex'] }, instructions: 'AGENTS.md', skills: '~/.agents/skills', command: 'codex', launch: ['codex', '{prompt}'], resume: ['codex', 'resume', '{id}'], env: ['CODEX_'], sessionEnv: 'CODEX_THREAD_ID', note: 'Codex에서 /hooks를 열어 muwi 훅을 한 번 믿어 줘야 훅이 돌아요.' },
  { id: 'gemini', name: 'Gemini CLI', home: { path: ['.gemini'] }, instructions: 'GEMINI.md', skills: 'skills', command: 'gemini', launch: ['gemini', '-i', '{prompt}'], resume: ['gemini', '--resume', '{id}'], env: ['GEMINI_CLI'] },
  { id: 'copilot', name: 'GitHub Copilot CLI', home: { env: 'COPILOT_HOME', path: ['.copilot'] }, instructions: 'copilot-instructions.md', skills: 'skills', command: 'copilot', launch: ['copilot', '-i', '{prompt}'], resume: ['copilot', '--resume={id}'], note: 'Copilot CLI는 켤 때만 훅을 읽어요. 열려 있는 세션은 다시 켜요.' },
  { id: 'cursor', name: 'Cursor CLI', home: { env: 'CURSOR_CONFIG_DIR', path: ['.cursor'] }, skills: 'skills', command: 'cursor-agent', launch: ['cursor-agent', '{prompt}'], resume: ['cursor-agent', '--resume', '{id}'], env: ['CURSOR_AGENT'] },
  { id: 'qwen', name: 'Qwen Code', home: { env: 'QWEN_HOME', path: ['.qwen'] }, instructions: 'QWEN.md', skills: 'skills', command: 'qwen', launch: ['qwen', '-i', '{prompt}'], resume: ['qwen', '--resume', '{id}'], env: ['QWEN_CODE'] },
  { id: 'qodercli', name: 'Qoder CLI', home: { env: 'QODER_CONFIG_DIR', path: ['.qoder'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'qodercli', launch: ['qodercli', '-i', '{prompt}'], resume: ['qodercli', '--resume', '{id}'] },
  { id: 'kimi', name: 'Kimi Code', home: { env: 'KIMI_CODE_HOME', path: ['.kimi-code'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'kimi', launch: ['kimi'], resume: ['kimi', '--session', '{id}'], env: ['KIMI_CODE_'], sessionEnv: 'KIMI_CODE_SESSION_ID' },
  { id: 'antigravity-cli', name: 'Antigravity CLI', home: { path: ['.gemini', 'config'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'agy', launch: ['agy', '-i', '{prompt}'], resume: ['agy', '--conversation', '{id}'] },
  { id: 'droid', name: 'Droid', home: { path: ['.factory'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'droid', launch: ['droid', '{prompt}'], resume: ['droid', '--resume', '{id}'] },
  { id: 'devin', name: 'Devin CLI', home: { path: ['.config', 'devin'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'devin', launch: ['devin', '--', '{prompt}'], resume: ['devin', '-r', '{id}'] },
  { id: 'grok', name: 'Grok CLI', home: { env: 'GROK_HOME', path: ['.grok'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'grok', launch: ['grok', '{prompt}'], resume: ['grok', '--resume', '{id}'] },
  { id: 'mastracode', name: 'Mastra Code', home: { path: ['.mastracode'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'mastracode', launch: ['mastracode', '--tui-initial-prompt', '{prompt}'], resume: ['mastracode', 'resume', '{id}'] },
  { id: 'letta', name: 'Letta Code', home: { env: 'LETTA_CONFIG_DIR', path: ['.letta'] }, skills: 'skills', command: 'letta', launch: ['letta'], resume: ['letta', '--conversation', '{id}'] },
  { id: 'opencode', name: 'OpenCode', home: { path: ['.config', 'opencode'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'opencode', launch: ['opencode', '--prompt', '{prompt}'], resume: ['opencode', '--session', '{id}'] },
  { id: 'kilo', name: 'Kilo CLI', home: { path: ['.config', 'kilo'] }, instructions: 'AGENTS.md', skills: '~/.kilo/skills', command: 'kilo', launch: ['kilo', '--prompt', '{prompt}'], resume: ['kilo', '--session', '{id}'] },
  // oh-my-pi는 Pi와 같은 환경 변수(PI_SESSION_ID)를 쓴다. OMPCODE로 먼저 알아보게 Pi보다 앞에 둔다
  { id: 'omp', name: 'oh-my-pi', home: { path: ['.omp', 'agent'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'omp', launch: ['omp', '{prompt}'], resume: ['omp', '--resume', '{id}'], env: ['OMPCODE'], sessionEnv: 'PI_SESSION_ID' },
  { id: 'hermes', name: 'Hermes Agent', home: { env: 'HERMES_HOME', path: ['.hermes'] }, skills: 'skills', command: 'hermes', launch: ['hermes', 'chat', '-q', '{prompt}'], resume: ['hermes', '--resume', '{id}'], env: ['HERMES_SESSION_ID', 'HERMES_AGENT'], sessionEnv: 'HERMES_SESSION_ID', note: 'Hermes에서 플러그인을 한 번 켜 줘야 해요: hermes plugins enable muwi' },
  { id: 'pi', name: 'Pi', home: { env: 'PI_CODING_AGENT_DIR', path: ['.pi', 'agent'] }, instructions: 'AGENTS.md', skills: 'skills', command: 'pi', launch: ['pi', '{prompt}'], resume: ['pi', '--session', '{id}'], env: ['PI_CODING_AGENT', 'PI_SESSION_ID'], sessionEnv: 'PI_SESSION_ID' },
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

/** 사용법 skill을 넣는 폴더 */
export function toolSkills(t: Tool, toolHomeDir: string, home: string): string | null {
  if (!t.skills) return null;
  return t.skills.startsWith('~/') ? path.join(home, t.skills.slice(2)) : path.join(toolHomeDir, t.skills);
}

/** 셸 명령에 세션 id를 넘겨주는 도구면 그 id */
export function sessionFromEnv(env: NodeJS.ProcessEnv): string | null {
  for (const t of TOOLS) {
    const v = t.sessionEnv ? env[t.sessionEnv] : undefined;
    if (v) return v;
  }
  return null;
}

/** 첫 말과 함께 새 대화를 띄우는 명령 ({prompt} 자리는 그대로 둔다). 모르는 도구면 Claude Code */
export const launchCommand = (tool: string | undefined): string[] => (toolById(tool) ?? TOOLS[0]).launch;

/** 하던 대화를 다시 여는 명령. 그 도구가 이어 가기를 모르면 null */
export function resumeCommand(tool: string | undefined, session: string): string[] | null {
  const t = toolById(tool);
  return t?.resume ? t.resume.map(part => part.replace('{id}', session)) : null;
}
