# 개발

```sh
npm test                      # 테스트
claude plugin validate .      # 플러그인 형식 확인
claude --plugin-dir .         # 설치하지 않고 이 폴더를 플러그인으로 불러 써 보기
```

TypeScript를 Node로 바로 실행합니다 (Node 22.18 이상). 빌드 단계와 의존 패키지가 없습니다.

## 구성

| 경로 | 내용 |
| --- | --- |
| `.claude-plugin/` | Claude Code 플러그인 정보와 마켓 정보 |
| `bin/muwi` | 명령. `src/cli.ts`를 Node로 바로 실행합니다 |
| `src/cli.ts` | 명령 처리 |
| `src/store.ts`, `src/plan.ts` | 기록 파일 읽고 쓰기, 계획 형식 확인과 비교 |
| `src/session.ts`, `src/hook.ts` | 세션 이름표, 훅 입력 처리 |
| `src/view.ts` | 계획과 사건 기록을 합쳐 보여 줄 모양 만들기 |
| `src/layout.ts`, `src/vendor/` | 그래프 배치 (elkjs) |
| `src/setup.ts` | `muwi setup` |
| `hooks/hooks.json`, `hooks/hook.sh` | 플러그인 훅. 볼 필요가 있는 입력만 `muwi hook`으로 넘깁니다 |
| `hooks/instructions.md` | 세션이 시작될 때 넣는 지침 |
| `skills/muwi/` | 사용법 skill: 계획 쓰는 법, 지킬 것, 문제 진단 절차 |
| `herdr-app/muwi/` | Herdr 앱 그래프 칸 |
| `tests/` | 테스트 |
| `docs/` | 문서 |

## 버전 올리기

1. `package.json`과 `.claude-plugin/plugin.json`의 버전을 같이 올립니다.
2. 바뀐 내용을 [CHANGELOG.md](../CHANGELOG.md)에 적습니다.
3. `claude plugin tag .`로 `muwi--v<버전>` 태그를 만들고 push합니다.

설치한 쪽은 `claude plugin update muwi`로 받습니다.
