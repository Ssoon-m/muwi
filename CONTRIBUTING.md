# 개발과 기여

muwi의 코드를 고치고 확인하는 방법, 폴더 구성, 지켜야 할 설계 원칙을 정리했습니다.

## 개발 환경 준비하기

Node 24 이상과 pnpm이 필요합니다. 패키지는 `packages/` 아래에 있고 pnpm workspace로 묶여 있습니다. 개발할 때는 TypeScript를 Node로 바로 실행하므로 빌드 단계가 없습니다. 배포할 때만 `.js`로 바꿉니다 (Node는 `node_modules` 안의 `.ts`를 실행하지 않습니다).

```sh
git clone https://github.com/Ssoon-m/muwi.git
cd muwi
pnpm install
pnpm test                                             # 모든 패키지의 테스트
pnpm check:package                                    # 배포할 패키지를 만들어 npm으로 깔아서 돌려 보기
herdr-app check packages/herdr-app/app/muwi          # 그래프 칸 확인 (Herdr 앱이 있을 때)
node packages/herdr-app/bin/muwi.js <명령>           # 깔지 않고 이 저장소의 muwi 실행하기
```

두 가지를 조심하세요.

- `muwi setup`은 `$MUWI_DIR`과 관계없이 홈 폴더(`~/.local/bin`, Herdr 앱의 mod 폴더)에 설치합니다. 시험 삼아 실행했다면 `muwi setup --remove`로 되돌리세요.
- 테스트는 멀티플렉서를 실제로 호출하지 않습니다. 코어의 테스트는 시험용 터미널 연결(`packages/core/tests/fake-terminals.ts`)을 쓰고, `@muwi/herdr`의 테스트는 `MUWI_HC`와 `MUWI_HERDR_APP`으로 `hc`와 `herdr-app` 대신 쓸 스크립트를 지정합니다. `loadView`와 `loadBoard`를 테스트할 때는 빈 환경을 넘기세요.

## 폴더 구성

패키지는 셋입니다. 코어(`@muwi/core`)가 기록하고 판단하는 일을 모두 하고, 어느 멀티플렉서나 앱을 쓰는지 모릅니다. 터미널 연결(`@muwi/herdr`)은 멀티플렉서와 이야기만 하고, 보기(`@muwi/herdr-app`)는 기록을 그리기만 합니다. 둘 다 코어의 규격(`packages/core/src/plugins.ts`)을 채웁니다.

| 경로 | 내용 |
| --- | --- |
| `packages/core/` | 코어 (npm 이름 `@muwi/core`). 의존 패키지: `elkjs` |
| `packages/core/bin/muwi.js` | npm이 PATH에 거는 `muwi` 명령. `src/cli.ts`(배포된 사본은 `src/cli.js`)를 실행합니다 |
| `packages/core/bin/muwi` | sh 입구. `~/.local/bin/muwi`와 훅이 실제 경로로 부릅니다. 셸 설정이 없는 곳에서도 Node를 찾습니다 |
| `packages/core/src/find-node.sh` | 셸 설정 없이 실행될 때 로그인 셸에 물어 Node 24 이상을 찾고 캐시합니다 (명령과 훅이 함께 씁니다) |
| `packages/core/src/cli.ts`, `src/kit.ts` | 명령 처리, 명령들이 같이 쓰는 것 (화면이 더하는 명령도 쓴다) |
| `packages/core/src/plugins.ts` | 터미널 연결과 보기의 규격. `$MUWI_TERMINALS`·`$MUWI_VIEWS`나 `setup.json`에 적힌 경로에서 불러옵니다 |
| `packages/core/src/live.ts` | 세션이 닫혔는지와 지금 상태 (훅, 세션 파일, 터미널 연결의 목록을 합쳐 판단) |
| `packages/core/src/delegate.ts` | 새 세션에 맡기기: `run`, `wait`, `peek`, `tell`, `tidy`, `resume` |
| `packages/core/src/board.ts`, `src/layout.ts`, `src/resume.ts` | 보기가 읽는 기록(`muwi board`), 그래프 배치(elkjs), 이어 하기에 쓸 사실 |
| `packages/core/src/store.ts`, `src/plan.ts` | 기록 파일 읽고 쓰기, 계획 형식 확인과 비교 |
| `packages/core/src/node.ts` | 노드 상태 기록 (명령과 훅이 함께 씁니다) |
| `packages/core/src/session.ts`, `src/hook.ts`, `src/events.ts` | 세션 정보, 훅 입력 처리 (도구를 모르는 코어) |
| `packages/core/src/view.ts`, `src/flow.ts` | 계획과 사건 기록을 합쳐 보여 줄 형태로 만들기, 실제로 일어난 일(타임라인, 다시 한 회차) |
| `packages/core/src/setup.ts` | `muwi setup` |
| `packages/core/src/connectors/` | AI 도구 커넥터 (도구 표 `tools.ts`, 커넥터 규격 `types.ts`) |
| `packages/core/connectors/` | 도구에 넣는 플러그인 파일 (OpenCode, Kilo, Pi, oh-my-pi, Hermes) |
| `packages/core/hooks/` | 훅 스크립트(`tool.sh`. 모든 도구의 훅이 `tool.sh <도구>`로 부른다)와 세션 지침(`instructions.md`) |
| `packages/core/skills/muwi/` | 사용법 skill: 계획 적는 방법, 맡기는 방법, 기록 진단 절차 |
| `packages/herdr/` | Herdr 터미널 연결 (npm 이름 `@muwi/herdr`). 의존 패키지: `@muwi/core` |
| `packages/herdr/bin/muwi.js` | Herdr 터미널 연결을 붙인 `muwi` 명령 |
| `packages/herdr/src/terminals.ts` | 터미널 연결 규격의 Herdr 구현: 이 터미널의 주소, 터미널 목록, 띄우기·보내기·읽기·닫기·놓기 |
| `packages/herdr/src/hc.ts` | Herdr 호출 (`hc`, `herdr-app`), 키보드 포커스 되돌리기 |
| `packages/herdr-app/` | Herdr 앱 보기 (npm 이름 `@muwi/herdr-app`). 의존 패키지: `@muwi/core`, `@muwi/herdr` |
| `packages/herdr-app/bin/muwi.js` | Herdr 터미널 연결과 Herdr 앱 보기를 붙인 `muwi` 명령 |
| `packages/herdr-app/src/view.ts` | 보기 규격의 Herdr 앱 구현: 명령, 설정, board에 더할 값, 설치 |
| `packages/herdr-app/src/commands.ts` | `open`, `layout` |
| `packages/herdr-app/src/screen.ts`, `src/preview.ts`, `src/install.ts` | `muwi layout`(Herdr 레이아웃에 muwi 칸 넣기), 설정 화면의 그림, 그래프 칸 설치 |
| `packages/herdr-app/app/muwi/` | Herdr 앱의 그래프 칸 |
| `packages/*/tests/` | 테스트. 코어의 테스트는 화면 없이(또는 시험용 화면으로) 돕니다 |
| `scripts/build.mjs`, `scripts/check-package.mjs` | 배포할 패키지 만들기, 만든 패키지를 npm으로 깔아서 확인하기 |
| `scripts/release.mjs`, `.github/workflows/release.yml` | 릴리스: 버전 커밋과 태그 만들기(`pnpm release`), 태그를 받아 npm에 올리기 |
| `docs/` | 문서 |

## 설계 원칙

기능을 넣거나 고칠 때 다음을 지키세요. 이유는 [동작 원리](docs/how-it-works.md)에 있습니다.

- **순서를 강제하지 않습니다.** 앞 노드가 끝났는지, 결과가 어떤 형식인지 확인하는 기능을 넣지 않습니다.
- **판단 기준과 일하는 방식의 원칙을 넣지 않습니다.** "이런 일은 새 세션으로" 같은 기준, 작업 위치나 승인 규칙 같은 원칙은 사용자의 skill에 둡니다. 세션 지침과 사용법 skill에는 기록하는 방법과 사실만 적습니다.
- **추측하지 않고 기록합니다.** 훅이 관찰한 사실에는 그 순간의 노드와 회차를 함께 적습니다. 그래프를 그릴 때 시각을 맞춰 추측하는 코드를 넣지 않습니다. 확실하지 않으면 `guess`로, 관찰하지 못했으면 `seen`으로 표시합니다.
- **말없이 다른 곳에 기록하지 않습니다.** 기록하는 명령은 작업을 추측하지 않습니다. 알 수 없으면 실패하고 이유를 알립니다.
- **muwi가 할 수 있는 일은 코어가 합니다.** 무엇을 띄우고, 무엇을 적고, 세션이 닫혔는지는 코어가 정합니다. 터미널 연결은 멀티플렉서만 할 수 있는 동작(띄우기, 보내기, 읽기, 닫기, 놓기, 목록)만 하고, 보기는 그리기만 합니다.
- **코어는 멀티플렉서와 앱을 모릅니다.** 코어에 Herdr 같은 이름이나 호출을 넣지 않습니다. 에이전트가 읽는 글(지침, 사용법 skill)에도 넣지 않습니다. 필요한 것은 규격(`packages/core/src/plugins.ts`)에 동작으로 더하고 각 패키지가 구현합니다.
- **멀티플렉서가 하는 일을 다시 만들지 않습니다.** 터미널을 띄우고 말을 거는 일은 그 멀티플렉서의 명령(Herdr는 `hc`)을 호출합니다.
- **AI가 하려는 일을 막지 않습니다.** 훅은 관찰만 합니다. 승인이나 계획을 강제하는 기능을 넣지 않습니다.

## 변경할 때 확인할 것

| 바꾼 것 | 함께 고칠 것 |
| --- | --- |
| 동작 | 테스트 |
| 명령이나 옵션 | `muwi --help`, [명령어](docs/reference/commands.md), 사용법 skill |
| 기록 형식 | `SCHEMA`, [기록 파일](docs/reference/records.md) |
| 그래프 칸 | `packages/herdr-app/app/muwi/main.js`의 견본 자료(`SAMPLE`), [그래프 화면](docs/reference/graph.md). `herdr-app check packages/herdr-app/app/muwi`가 통과하는지와 Herdr 앱에서 직접 보는 것까지 확인하세요 |
| Herdr 화면 바꾸기 | `packages/herdr-app/src/screen.ts`의 `placeMuwi` 테스트(`tests/screen.test.ts`), [설치와 설정](docs/reference/setup.md#herdr-앱-화면) |
| 훅 | 커넥터의 훅 목록(`packages/core/src/connectors/`), [동작 원리](docs/how-it-works.md#훅이-하는-일) |
| 터미널 연결·보기 규격 | `packages/core/src/plugins.ts`, `@muwi/herdr`·`@muwi/herdr-app`의 구현, 코어의 시험용 연결과 보기(`tests/fake-terminals.ts`, `tests/fake-view.ts`), [동작 원리](docs/how-it-works.md#터미널-연결과-보기) |
| `muwi board`의 모양 | `BOARD_VERSION`(`packages/core/src/board.ts`), 그래프 칸(`main.js`) |
| 배포할 파일 | `scripts/build.mjs`가 옮기는 목록, `pnpm check:package` |

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
| 세션 | AI 도구의 세션(대화) 하나 |
| 새 세션 | `muwi run`으로 띄운 세션 |
| 서브에이전트 | 세션 안에서 띄운 보조 에이전트 |
| 그래프 칸 | Herdr 앱에서 muwi가 그리는 화면 |
| 터미널 연결 | 세션들이 도는 멀티플렉서와 이야기하는 모듈. 지금은 Herdr (`@muwi/herdr`) |
| 보기 | 기록을 그려 보여 주는 모듈. 지금은 Herdr 앱 (`@muwi/herdr-app`) |
| 커넥터 | 한 AI 도구를 muwi에 끼우는 것. 그 도구의 훅 입력을 공통 사건으로 바꾸고, 지침·사용법·훅을 그 도구에 넣는다 |

## 버전 올리기

모든 패키지는 늘 같은 버전으로 함께 올립니다. 하나만 바뀌어도 모두 올립니다. 업데이트 뒤 그래프 칸을 다시 맞추는 것과 `muwi --version`이 코어의 버전을 보기 때문입니다.

버그 수정은 끝자리(0.7.0 → 0.7.1), 기능 추가나 동작이 바뀌는 변경은 가운데 자리(0.7.0 → 0.8.0)를 올립니다.

1. CHANGELOG에 새 버전을 정리하세요. 평소에는 CHANGELOG를 고치지 않고, 릴리스할 때 지난 릴리스 이후의 커밋을 보고 한 번에 적습니다. `pnpm release <버전>`을 먼저 실행하면 그 커밋들을 패키지별로 보여 줍니다.

   ```markdown
   ## 0.7.1 (2026-11-25)

   ### @muwi/herdr-app

   #### 수정

   - 좁은 칸에서 노드 이름이 잘리던 것을 고쳤습니다.
   ```

   패키지별 소제목(`### @muwi/core`, `### @muwi/herdr`, `### @muwi/herdr-app`, 여럿에 해당하면 `### 공통`) 아래를 `#### 추가`, `#### 변경`, `#### 뺌`, `#### 수정`으로 나눕니다. 코드가 아니라 쓰는 사람이 겪는 변화로 적습니다.

2. CHANGELOG.md만 고친 채로 main에서 실행하세요.

   ```sh
   pnpm release 0.7.1 --dry-run   # 무엇을 할지만 보기
   pnpm release 0.7.1
   ```

   모든 `package.json`의 버전을 올리고, `chore: <버전>` 커밋과 `v<버전>` 태그를 만들어 push합니다. main이 원격보다 뒤처졌거나, CHANGELOG에 그 버전의 항목이 없거나, CHANGELOG.md 말고 커밋하지 않은 변경이 있으면 멈춥니다.

3. 태그를 받은 GitHub Actions([release.yml](.github/workflows/release.yml))가 나머지를 합니다.
   - 태그, 패키지 버전, CHANGELOG가 맞는지 확인합니다.
   - `pnpm test`와 `pnpm check:package`를 돌립니다.
   - 코어, `@muwi/herdr`, `@muwi/herdr-app` 순서로 npm에 올립니다. 토큰 없이 Trusted Publishing으로 올리고 provenance를 붙입니다. 이미 올라간 패키지는 건너뛰므로, 중간에 멈췄으면 그 실행을 다시 돌리면 됩니다.
   - CHANGELOG의 그 섹션으로 GitHub 릴리스를 만듭니다.

   `0.8.0-beta.1`처럼 `-`가 붙은 시험판은 `latest`가 아니라 `beta` 같은 이름의 태그로 올라갑니다.

npm에서는 모든 패키지가 Settings > Trusted Publisher에 이 저장소(`Ssoon-m/muwi`)의 `release.yml`이 등록돼 있어야 합니다.

### 새 패키지를 처음 올릴 때

Trusted Publisher는 npm에 이미 있는 패키지에만 등록할 수 있습니다. 그래서 새 패키지(예: `@muwi/herdr`)는 릴리스 전에 한 번, 사람이 npm의 [staged publishing](https://docs.npmjs.com/staged-publishing)으로 자리를 잡아 둡니다. 없는 패키지를 stage하면 npm이 `0.0.0-stage`를 공개로 올려 패키지가 생깁니다. `0.0.0-stage`는 npm이 쓰는 번호라 직접 올릴 수 없습니다. `pnpm release`는 npm에 없는 패키지가 있으면 태그를 달기 전에 멈춥니다 (로그인한 계정이 쓸 수 있는 패키지 목록으로 봅니다). 앞 패키지만 올라가고 멈춰서 패키지마다 버전이 어긋나지 않게 하려는 것입니다.

```sh
npm login
pnpm release stage --dry-run   # npm에 없는 패키지 보기
pnpm release stage             # 그 패키지마다 0.0.0-init(package.json과 README만)을 stage한다 (npm 11.15 이상)
npm stage list <패키지>         # stage한 0.0.0-init은 쓰지 않으므로
npm stage reject <stage-id>    # 거절한다 (2단계 인증)
```

그다음 `https://www.npmjs.com/package/<패키지>/access`의 Trusted Publisher에 GitHub Actions, 저장소 `Ssoon-m/muwi`, 워크플로 `release.yml`을 등록하고 평소처럼 `pnpm release <버전>`을 실행합니다.

설치한 사용자는 `npm i -g @muwi/herdr-app@latest`로 받습니다.
