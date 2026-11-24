// 도구의 설정에 무언가를 넣고 뺄 때 쓰는 파일 도우미. 남의 설정은 건드리지 않는다: 우리 것은 구간 표시와 명령 앞의 표시로 알아본다.
import fs from 'node:fs';
import path from 'node:path';

/** Git Bash가 읽을 경로: Windows에서는 C:\\… 대신 C:/… (Windows의 Claude Code는 훅을 Git Bash로 실행한다) */
export const shPath = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.replace(/\\/g, '/') : p);

export const BLOCK_START = '<!-- muwi:start';
export const BLOCK_END = '<!-- muwi:end -->';

/** 지침 파일에서 우리 구간을 뺀다 */
export function removeBlock(text: string): string {
  const a = text.indexOf(BLOCK_START);
  if (a < 0) return text;
  const b = text.indexOf(BLOCK_END, a);
  if (b < 0) return text;
  const before = text.slice(0, a).replace(/\n+$/, '');
  const after = text.slice(b + BLOCK_END.length).replace(/^\n+/, '');
  if (!before) return after;
  if (!after) return before + '\n';
  return `${before}\n\n${after}`;
}

/** 지침 파일 끝에 우리 구간을 넣는다. 이미 있으면 새 내용으로 바꾼다 */
export function upsertBlock(text: string, block: string): string {
  const rest = removeBlock(text).replace(/\n+$/, '');
  const body = block.trim();
  return rest ? `${rest}\n\n${body}\n` : `${body}\n`;
}

/** 지침 원문에서 사람이 읽을 본문만 꺼낸다 (구간 표시 주석은 뺀다) */
export function instructionText(block: string): string {
  return block
    .split('\n')
    .filter(line => !line.startsWith(BLOCK_START) && !line.startsWith(BLOCK_END))
    .join('\n')
    .trim();
}

export function backup(file: string) {
  if (!fs.existsSync(file)) return;
  const bak = `${file}.muwi.bak`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

export function writeText(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function installBlock(file: string, block: string) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  backup(file);
  writeText(file, upsertBlock(old, block));
}

export function uninstallBlock(file: string) {
  if (!fs.existsSync(file)) return;
  const old = fs.readFileSync(file, 'utf8');
  const next = removeBlock(old);
  if (next !== old) writeText(file, next);
}

export function copyDir(from: string, to: string, skip: (name: string) => boolean = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}

