#!/usr/bin/env node
// @muwi/herdr의 muwi 명령: Herdr 터미널 연결을 붙인 muwi. 코어(@muwi/core)의 명령을 그대로 쓴다.
// muwi setup이 이 연결의 경로를 setup.json에 적어 두므로, 그 뒤로는 코어의 명령(훅, ~/.local/bin/muwi)도 이 연결을 쓴다.
import fs from 'node:fs';
import path from 'node:path';

// npm으로 받은 사본은 .js로 바꾼 src/terminals.js, 저장소에서는 src/terminals.ts
const terminals = ['terminals.js', 'terminals.ts'].map(name => path.resolve(import.meta.dirname, '..', 'src', name)).find(file => fs.existsSync(file));
if (terminals) process.env.MUWI_TERMINALS ||= terminals;
await import('@muwi/core/cli');
