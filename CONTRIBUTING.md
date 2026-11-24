# 개발과 기여

muwi의 코드를 고치고 확인하는 방법, 폴더 구성, 지켜야 할 설계 원칙을 정리했습니다.

## 개발 환경 준비하기

Node 24 이상과 pnpm이 필요합니다. 패키지는 `packages/` 아래에 있고 pnpm workspace로 묶여 있습니다. TypeScript를 Node로 바로 실행하기 때문에 개발할 때는 빌드 단계가 없습니다.

```sh
git clone https://github.com/Ssoon-m/muwi.git
cd muwi
pnpm install
pnpm test                                             # 모든 패키지의 테스트
claude plugin validate .                              # 플러그인 형식 확인
herdr-app check packages/muwi/herdr-app/muwi          # 그래프 칸 확인 (Herdr 앱이 있을 때)
claude --plugin-dir .                                 # 설치하지 않고 이 폴더를 플러그인으로 불러 쓰기
```

두 가지를 조심하세요.

- `muwi setup`은 `$MUWI_DIR`과 관계없이 홈 폴더(`~/.local/bin`, Herdr 앱의 mod 폴더)에 설치합니다. 시험 삼아 실행했다면 `muwi setup --remove`로 되돌리세요.
- 테스트는 Herdr를 실제로 호출하지 않습니다. `MUWI_HC`와 `MUWI_HERDR_APP`으로 `hc`와 `herdr-app` 대신 쓸 스크립트를 지정합니다. `loadView`와 `loadBoard`를 테스트할 때는 빈 환경을 넘기세요.

## 폴더 구성

| 경로 | 내용 |
| --- | --- |
| `.claude-plugin/` | Claude Code 플러그인 정보와 마켓 정보 |
| `packages/muwi/bin/muwi` | 명령. `packages/muwi/src/cli.ts`를 Node로 실행합니다 |
| `packages/muwi/src/find-node.sh` | 셸 설정 없이 실행될 때 로그인 셸에 물어 Node 24 이상을 찾고 캐시합니다 (명령과 훅이 함께 씁니다) |
| `packages/muwi/src/cli.ts` | 명령 처리 |
| `packages/muwi/src/store.ts`, `packages/muwi/src/plan.ts` | 기록 파일 읽고 쓰기, 계획 형식 확인과 비교 |
| `packages/muwi/src/node.ts` | 노드 상태 기록 (명령과 훅이 함께 씁니다) |
| `packages/muwi/src/session.ts`, `packages/muwi/src/hook.ts` | 세션 정보, 훅 입력 처리 |
| `packages/muwi/src/herdr.ts`, `packages/muwi/src/live.ts` | Herdr 호출 (`hc`, `herdr-app`), 세션이 닫혔는지 확인 |
| `packages/muwi/src/view.ts` | 계획과 사건 기록을 합쳐 화면에 보여 줄 형태로 만들기 |
| `packages/muwi/src/layout.ts`, `packages/muwi/src/vendor/` | 그래프 배치 (elkjs) |
| `packages/muwi/src/setup.ts` | `muwi setup` |
| `packages/muwi/src/screen.ts` | `muwi layout`: Herdr 레이아웃을 복제해 muwi 칸을 넣고 빼기 |
| `packages/muwi/hooks/` | 훅 스크립트(`hook.sh`, `tool.sh`)와 세션 지침(`instructions.md`). 플러그인의 훅 목록은 저장소 뿌리의 `hooks/hooks.json` |
| `packages/muwi/skills/muwi/` | 사용법 skill: 계획 적는 방법, 맡기는 방법, 기록 진단 절차 |
| `packages/muwi/herdr-app/muwi/` | Herdr 앱의 그래프 칸 |
| `packages/muwi/tests/` | 테스트 |
| `docs/` | 문서 |

## 설계 원칙

기능을 넣거나 고칠 때 다음을 지키세요. 이유는 [동작 원리](docs/how-it-works.md)에 있습니다.

- **순서를 강제하지 않습니다.** 앞 노드가 끝났는지, 결과가 어떤 형식인지 확인하는 기능을 넣지 않습니다.
- **판단 기준과 일하는 방식의 원칙을 넣지 않습니다.** "이런 일은 새 세션으로" 같은 기준, 작업 위치나 승인 규칙 같은 원칙은 사용자의 skill에 둡니다. 세션 지침과 사용법 skill에는 기록하는 방법과 사실만 적습니다.
- **추측하지 않고 기록합니다.** 훅이 관찰한 사실에는 그 순간의 노드와 회차를 함께 적습니다. 그래프를 그릴 때 시각을 맞춰 추측하는 코드를 넣지 않습니다. 확실하지 않으면 `guess`로, 관찰하지 못했으면 `seen`으로 표시합니다.
- **말없이 다른 곳에 기록하지 않습니다.** 기록하는 명령은 작업을 추측하지 않습니다. 알 수 없으면 실패하고 이유를 알립니다.
- **Herdr가 하는 일을 다시 만들지 않습니다.** 세션을 띄우고, 기다리고, 말을 거는 일은 `hc`를 호출합니다.

## 변경할 때 확인할 것

| 바꾼 것 | 함께 고칠 것 |
| --- | --- |
| 동작 | 테스트 |
| 명령이나 옵션 | `muwi --help`, [명령어](docs/reference/commands.md), 사용법 skill |
| 기록 형식 | `SCHEMA`, [기록 파일](docs/reference/records.md) |
| 그래프 칸 | `herdr-app/muwi/main.js`의 견본 자료(`SAMPLE`), [그래프 화면](docs/reference/graph.md). `herdr-app check herdr-app/muwi`가 통과하는지와 Herdr 앱에서 직접 보는 것까지 확인하세요 |
| Herdr 화면 바꾸기 | `src/screen.ts`의 `placeMuwi` 테스트(`tests/screen.test.ts`), [설치와 설정](docs/reference/setup.md#herdr-앱-화면) |
| 훅 | `hooks/hooks.json`, `src/setup.ts`의 훅 목록, [동작 원리](docs/how-it-works.md#훅이-하는-일) |

커밋은 역할별로 나누고 `feat(범위): 설명`, `fix`, `docs`, `test`, `chore` 형식으로 쓰세요.

## 문서 쓰기

문서는 독자의 목적에 따라 네 곳에 나눠 둡니다.

| 위치 | 유형 | 독자의 목적 |
| --- | --- | --- |
| `docs/getting-started.md` | 학습 | 처음 써 보기 |
| `docs/guides/` | 문제 해결 | 특정한 일을 하거나 문제를 풀기 |
| `docs/reference/` | 참조 | 정확한 내용 확인하기 |
| `docs/how-it-works.md` | 설명 | 원리 이해하기 |

다음 원칙을 따르세요. 자세한 내용은 [technical-writing.dev](https://technical-writing.dev)에 있습니다.

- 한 페이지에서 하나의 목표만 다룹니다.
- 페이지 첫머리에 독자가 무엇을 얻는지 적습니다.
- 문장은 짧게, 한 문장에 하나의 내용만 씁니다.
- 설명은 "~합니다"로, 독자가 할 일은 독자를 주어로 "~하세요"로 씁니다. 문장이 같은 말로 끝나는 일이 줄줄이 이어지지 않게 합니다.
- 같은 개념은 같은 말로 씁니다.

| 용어 | 뜻 |
| --- | --- |
| 작업 | 한 번 맡긴 일의 기록 단위 |
| 계획, 노드 | AI가 짠 진행 계획과 그 안의 단계 |
| 회차 | 노드를 한 번 한 것. 다시 하면 다음 회차입니다 |
| 세션 | Claude Code 세션 하나 |
| 새 세션 | `muwi run`으로 띄운 세션 |
| 서브에이전트 | 세션 안에서 띄운 보조 에이전트 |
| 그래프 칸 | Herdr 앱에서 muwi가 그리는 화면 |
| 계획 알림 | 계획 없이 파일을 고치거나 서브에이전트를 띄우려 할 때 돌려보내는 기능 (`nudge`) |
| push 전에 묻기 | push와 PR 명령 앞에서 사용자에게 묻는 기능 (`guard`) |

## 버전 올리기

1. `package.json`과 `.claude-plugin/plugin.json`의 버전을 함께 올리세요.
2. [CHANGELOG.md](CHANGELOG.md)의 "아직 내지 않은 변경"을 새 버전으로 바꾸세요.
3. `claude plugin tag .`으로 `muwi--v<버전>` 태그를 만들고 push하세요.

설치한 사용자는 `claude plugin update muwi`로 받습니다.
