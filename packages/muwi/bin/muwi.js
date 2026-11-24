#!/usr/bin/env node
// npm이 PATH에 거는 muwi 명령. macOS·Linux는 이 파일로 가는 링크를, Windows는 npm이 만든 muwi.cmd·muwi.ps1이 node로 이 파일을 실행한다.
// Node는 링크를 풀어서 실행하므로 아래의 폴더는 패키지 안이다. npm으로 받은 사본은 .js로 바꾼 src/cli.js, 저장소에서는 src/cli.ts를 실행한다.
// sh 입구(bin/muwi)는 ~/.local/bin/muwi와 훅이 실제 경로로 부른다 (셸 설정이 없는 곳에서도 Node를 찾는다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const cli = ['cli.js', 'cli.ts'].map(name => path.join(src, name)).find(file => fs.existsSync(file));
await import(pathToFileURL(cli).href);
