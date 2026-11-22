# 개발과 기여

## 준비

Node 22.18 이상이 필요합니다. TypeScript를 Node로 바로 실행하므로 빌드 단계와 의존 패키지가 없습니다.

```sh
git clone https://github.com/Ssoon-m/muwi.git
cd muwi
npm test                      # 테스트
claude plugin validate .      # 플러그인 형식 확인
claude --plugin-dir .         # 설치하지 않고 이 폴더를 플러그인으로 불러 써 보기
```

`muwi setup`은 `$MUWI_DIR`과 상관없이 홈 폴더(`~/.local/bin`, Herdr 앱 모드 폴더)에 씁니다. 시험 삼아 실행했으면 `muwi setup --remove`로 되돌립니다.

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
| `docs/` | 문서: [원리](docs/how-it-works.md), [설치](docs/install.md), [쓰는 법](docs/usage.md) |

## 바꿀 때

- 순서를 강제하거나 결과 형식을 검사하는 기능은 넣지 않습니다. muwi는 적어 두고 보여 주기만 합니다 ([왜](README.md#왜)).
- 동작을 바꾸면 테스트를 같이 고치고, 명령이나 옵션이 바뀌면 `muwi --help`, [명령 목록](docs/usage.md#명령-목록), 사용법 skill을 같이 맞춥니다.
- 커밋은 역할별로 나누고 `feat(범위): 설명`, `fix`, `docs`, `test`, `chore` 형식으로 씁니다.

## 버전 올리기

1. `package.json`과 `.claude-plugin/plugin.json`의 버전을 같이 올립니다.
2. [CHANGELOG.md](CHANGELOG.md)의 "아직 내지 않은 변경"을 새 버전 절로 바꿉니다.
3. `claude plugin tag .`로 `muwi--v<버전>` 태그를 만들고 push합니다.

설치한 쪽은 `claude plugin update muwi`로 받습니다.
