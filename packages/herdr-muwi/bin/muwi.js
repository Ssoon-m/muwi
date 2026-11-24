#!/usr/bin/env node
// herdr-muwi의 muwi 명령: Herdr 화면을 붙인 muwi. 코어(muwi)의 명령을 그대로 쓰고, 화면 규격을 Herdr로 채운다.
// muwi setup이 이 화면의 경로를 setup.json에 적어 두므로, 그 뒤로는 코어의 명령(훅, 그래프 칸이 부르는 ~/.local/bin/muwi)도 Herdr 화면을 쓴다.
import fs from 'node:fs';
import path from 'node:path';

// npm으로 받은 사본은 .js로 바꾼 src/host.js, 저장소에서는 src/host.ts
const host = ['host.js', 'host.ts'].map(name => path.resolve(import.meta.dirname, '..', 'src', name)).find(file => fs.existsSync(file));
if (host) process.env.MUWI_HOST ||= host;
await import('muwi/cli');
