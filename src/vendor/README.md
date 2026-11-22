# vendor

| 파일 | 출처 | 라이선스 |
| --- | --- | --- |
| `elk.bundled.cjs` | [elkjs](https://github.com/kieler/elkjs) 0.12.1 `lib/elk.bundled.js` 원본 그대로 (이름만 `.cjs`로 바꿈: 저장소가 `"type": "module"`이라 CommonJS로 읽게) | EPL-2.0 (`elkjs-LICENSE.md`) |

`src/layout.ts`가 그래프 배치에 쓴다. 설치 단계 없이 바로 실행하려고 넣었다. 버전을 올릴 때는 `npm pack elkjs@<버전>`으로 받아 `lib/elk.bundled.js`를 바꾸고 `npm test`의 배치 테스트를 돌린다.
