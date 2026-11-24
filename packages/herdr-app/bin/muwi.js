#!/usr/bin/env node
// @muwi/herdr-app의 muwi 명령: Herdr 터미널 연결(@muwi/herdr)과 Herdr 앱 보기를 붙인 muwi. 코어(@muwi/core)의 명령을 그대로 쓴다.
// muwi setup이 두 경로를 setup.json에 적어 두므로, 그 뒤로는 코어의 명령(훅, 그래프 칸이 부르는 ~/.local/bin/muwi)도 둘을 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// npm으로 받은 사본은 .js, 저장소에서는 .ts
const pick = (dir, name) => [`${name}.js`, `${name}.ts`].map(f => path.join(dir, f)).find(f => fs.existsSync(f));
const herdr = path.dirname(fileURLToPath(import.meta.resolve('@muwi/herdr/package.json')));
const terminals = pick(path.join(herdr, 'src'), 'terminals');
const view = pick(path.resolve(import.meta.dirname, '..', 'src'), 'view');
if (terminals) process.env.MUWI_TERMINALS ||= terminals;
if (view) process.env.MUWI_VIEWS ||= view;
await import('@muwi/core/cli');
