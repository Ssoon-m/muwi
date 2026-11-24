# 설치와 설정

muwi가 무엇을 어디에 설치하는지, 설정으로 무엇을 바꿀 수 있는지, 어떻게 제거하는지 정리했습니다. 처음 설치한다면 [시작하기](../getting-started.md)를 먼저 보세요.

## 요구 사항

| 항목 | 조건 |
| --- | --- |
| Node | 24 이상과 npm |
| AI 도구 | Claude Code, Codex 등 커넥터가 있는 도구 ([다른 AI 도구에 넣기](#다른-ai-도구에-넣기)) |
| [Herdr 앱](https://herdr.dev) | 그래프를 보거나 새 세션을 띄울 때 필요합니다 (`herdr-muwi`) |
| Git for Windows | Windows에서만. Claude Code가 훅을 Git Bash로 실행합니다. [Windows에서 쓰기](#windows에서-쓰기)를 보세요 |

PATH에 Node가 없는 곳(Herdr가 띄우는 세션, 그래프 칸)에서는 muwi가 로그인 셸에 물어 Node를 찾고 `~/.cache/muwi/node`에 적어 둡니다. Node 버전을 바꿨다면 `muwi setup`을 다시 실행하세요. 캐시를 버리고 다시 찾습니다. 바꾼 Node에 muwi를 새로 깔았다면 [다른 자리에 새로 깔았을 때](#업데이트하기)를 보세요. 자세한 내용은 [문제 해결하기](../guides/troubleshooting.md#node-24-이상이-필요하다고-나올-때)에 있습니다.

## 설치하기

muwi는 패키지 두 개로 나뉩니다. 둘 다 `muwi` 명령을 내므로 하나만 까세요.

| 패키지 | 들어 있는 것 |
| --- | --- |
| `herdr-muwi` | `muwi`의 모든 것에 더해 Herdr 화면: 작업 목록과 그래프 칸, `muwi run`·`tidy`(새 세션에 맡기기), `muwi layout`·`open`, 그래프 배치 |
| `muwi` | 코어: 기록, 명령, AI에게 주는 지침, 사용법 skill, AI 도구 커넥터. 화면 없이 기록만 쓸 때 |

```sh
npm i -g herdr-muwi      # Herdr 앱에서 그래프로 볼 때
npm i -g muwi            # 기록만 쓸 때
```

## muwi setup이 설치하는 것

```sh
muwi setup                       # 터미널용 명령과 화면(그래프 칸)
muwi setup --tool claude         # 그 AI 도구에 커넥터도. 여러 개는 쉼표로, 깔린 도구 전부는 --all
```

| 항목 | 위치 | 조건 |
| --- | --- | --- |
| 터미널용 `muwi` 명령 | `~/.local/bin/muwi` | 항상 |
| PowerShell·cmd용 `muwi` 명령 | `~/.local/bin/muwi.cmd` | Windows에서만 |
| 그래프 칸 | `~/.config/herdr-app/mods/muwi` | `herdr-muwi`로 깔았고 Herdr 앱이 있을 때 |
| AI 도구의 커넥터 | 도구마다 다릅니다 ([다른 AI 도구에 넣기](#다른-ai-도구에-넣기)) | `--tool`이나 `--all`로 고른 도구 |

터미널용 명령은 Herdr 앱의 그래프 칸이 기록을 읽을 때도 씁니다. npm이 넣은 `muwi` 명령과 같은 것을 부릅니다.

설치한 항목은 `~/.muwi/setup.json`에 기록합니다. `muwi setup --remove`는 이 기록에 있는 것만 지웁니다. 화면(`herdr-muwi`)의 경로도 여기에 적어 두므로, 그 뒤로는 훅과 그래프 칸이 부르는 명령도 Herdr 화면을 씁니다.

muwi를 업데이트하면 다음 세션이 시작될 때 이 항목들을 새 버전에 맞춥니다. 한 번 넣은 도구는 `muwi setup`을 다시 실행할 때 고르지 않아도 맞춥니다.

Herdr 앱이 열려 있으면 `muwi setup`은 마지막에 지금 화면을 알려 줍니다. 화면에 muwi 칸이 없으면 `muwi layout`으로 넣을 수 있다고 안내합니다. 화면은 바꾸지 않습니다.

## Herdr 앱 화면

`muwi setup`은 그래프 칸을 설치만 하고 화면에는 넣지 않습니다. 화면에 넣으려면 실행하세요.

```sh
muwi layout
```

지금 레이아웃을 복제해서 복제본만 바꾸고, 그 복제본으로 화면을 바꿉니다.

| 자리 | 바뀌는 것 |
| --- | --- |
| 사이드바의 Agents 칸 | muwi 작업 목록. 계획 없이 일하는 세션도 보이므로 Agents 칸이 없어도 빠지는 세션이 없습니다 |
| 터미널 영역 아래 | 고른 작업의 그래프와 기록. 지금 보는 터미널의 작업을 따라갑니다. 위나 오른쪽으로 옮길 수 있습니다 (그래프 칸의 `위 · 아래 · 오른쪽` 버튼, 또는 `muwi layout --graph`) |

| 항목 | 위치 |
| --- | --- |
| 복제한 레이아웃 | `~/.config/herdr-app/layouts/muwi.json` (이름이 있으면 `muwi-2.json` 같은 다음 이름) |
| 바꾼 기록 | `~/.muwi/layout.json`: 원래 레이아웃, 복제할 때의 Herdr 버전, 복제본 파일의 해시 |

경우에 따라 이렇게 동작합니다.

| 경우 | 동작 |
| --- | --- |
| 원래 레이아웃을 직접 꾸며 썼다 | 그 레이아웃을 복제하므로 꾸민 것은 그대로 남고, Agents 칸 자리와 터미널 아래만 바뀝니다 |
| Agents 칸이 없다 | 터미널 아래에 작업 목록까지 있는 그래프를 넣습니다 |
| 넣을 자리가 없다 (창 전체를 mod 하나가 그리는 레이아웃) | 아무것도 바꾸지 않습니다. `muwi open`으로 터미널 옆에 여세요 |
| 이미 muwi 칸이 있다 | 그대로 둡니다 |
| Herdr가 업데이트됐다 | 그래프 칸에 "맞추기" 안내가 나옵니다. 누르거나 `muwi layout`을 다시 실행하면 복제본을 원래 레이아웃의 새 모양으로 그 자리에서 고칩니다. 그 레이아웃에서 고른 테마와 칸 크기는 그대로 남습니다. 복제본을 손으로 고쳤으면 다시 만들지 않습니다 |
| muwi가 업데이트되며 배치가 바뀌었다 | 같은 "맞추기" 안내가 나옵니다. 0.5.0으로 넣은 화면은 그래프 칸 높이를 바꿀 수 없으니 맞추세요 |

화면을 되돌리려면 실행하세요.

```sh
muwi layout --remove
```

원래 레이아웃으로 돌아가고 복제본을 지웁니다. 복제본을 손으로 고쳤으면 파일은 남깁니다. Herdr 앱에서 레이아웃을 바꿔도(`ctrl-shift-l`) 언제든 원래 화면으로 돌아갈 수 있습니다.

## 설정

```sh
muwi config                # 현재 설정 보기
muwi config layout off     # 화면 바꾸기 안내 끄기
```

| 설정 | 기본값 | 켜면 |
| --- | --- | --- |
| `layout` | `on` | 화면에 muwi 칸이 없을 때 `muwi setup`과 그래프 칸이 `muwi layout`을 권합니다 |

muwi는 AI가 하려는 일을 막거나 사람에게 묻게 하지 않습니다. 계획이 없어도 파일을 고칠 수 있고, push나 PR처럼 승인받고 할 일은 그 AI 도구의 권한 설정이나 직접 둔 훅으로 정합니다. 0.5.x의 `nudge`(계획 알림)와 `guard`(push 전에 묻기)는 0.6.0에서 뺐습니다.

설정은 `~/.muwi/config.json`에 저장됩니다.

## 다른 AI 도구에 넣기

muwi는 여러 AI 도구에서 씁니다. Claude Code도 커넥터 중 하나입니다. 도구마다 "커넥터"를 넣으면 그 도구의 세션도 같은 기록에 적히고 같은 그래프에 나옵니다. 리뷰는 Codex 세션이, 구현은 Claude Code 세션이 맡아도 작업 하나의 그래프 하나입니다.

```sh
muwi setup --tools                 # 아는 도구, 이 컴퓨터에 깔렸는지, 커넥터를 넣었는지
muwi setup --tool codex            # 그 도구에 커넥터를 넣습니다. 여러 개는 쉼표로: --tool codex,gemini
muwi setup --all                   # 깔려 있는 도구 전부에 넣습니다
```

### 어느 도구에서나 똑같이 되는 것

muwi의 동작은 도구의 훅에 기대지 않고, 모든 도구에 있는 것 두 가지로 만듭니다. 에이전트가 셸 명령을 실행할 수 있다는 것과, 세션이 지금 일하는지 Herdr가 알려 준다는 것입니다.

| 동작 | 어떻게 되나 |
| --- | --- |
| 계획과 진행 기록, 그래프 | 에이전트가 `muwi plan`, `muwi node …`를 직접 실행합니다 |
| 서브에이전트 표시 | 서브에이전트가 `muwi node <id> start --sub`로 스스로 밝힙니다 |
| 세션이 멈췄을 때 멈춘 것으로 보이기 | Herdr가 알려 주는 세션 상태를 따라갑니다 |
| 지침 받기, 업데이트된 지침 받기 | 그 도구가 늘 읽는 지침 파일에 넣고, 지침이 바뀌면 다음 `muwi` 명령의 출력 끝에 붙여 줍니다. 원본은 `muwi guide`입니다 |
| 새 세션에 맡기기 | `muwi run`이 그 도구의 명령으로 띄우고, 뜬 세션은 첫 `muwi` 명령에서 맡은 노드에 붙습니다 |

무엇을 승인받고 할지(push, PR 등)는 muwi가 정하지 않습니다. 그 도구의 권한 설정이나 직접 둔 훅으로 정합니다.

### 커넥터가 더해 주는 것

커넥터는 그 도구의 훅(또는 그 도구의 플러그인 파일)으로 위 동작을 더 정확하게 합니다.

| 커넥터가 넣는 것 | 설명 |
| --- | --- |
| 지침 | 그 도구가 늘 읽는 지침 파일(`AGENTS.md`, `GEMINI.md` 등)에 muwi 지침을 구간 표시로 넣습니다. 그런 파일이 없는 도구는 세션이 시작될 때 훅이 넣습니다 |
| 사용법 skill | 그 도구의 skill 폴더에 `muwi` skill을 넣습니다 |
| 훅 또는 그 도구의 플러그인 파일 | 세션이 시작될 때, skill을 읽은 뒤, 서브에이전트가 뜨고 끝날 때 muwi를 부르게 합니다. 관찰만 하고 아무것도 막지 않습니다 |

훅이 있으면 생기는 것은 이렇습니다: 읽은 skill 기록, 노드마다 쓴 모델, 세션이 뜨자마자 맡은 노드에 붙기, 서브에이전트를 `--sub` 없이도 알아보기. 앞의 둘은 관찰해야 아는 정보라 훅이 없으면 "볼 수 없었음"이나 빈칸으로 나옵니다.

넣은 것은 `~/.muwi/setup.json`에 적어 두고, `muwi setup --remove`가 우리 것만 뺍니다. 남의 훅과 지침은 건드리지 않고, 처음 고치는 파일은 `.muwi.bak`으로 원본을 남깁니다.

| 도구 | 이름 (`--tool`) | 훅·플러그인을 넣는 곳 | 그 도구의 훅이 알려 주지 않는 것 | 넣은 뒤 한 번 할 일 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude/settings.json` (사용법은 `~/.claude/skills/muwi`) |  | 열려 있던 세션을 새로 열기 |
| Codex | `codex` | `~/.codex/hooks.json` |  | Codex에서 `/hooks`를 열어 muwi 훅을 승인 |
| Gemini CLI | `gemini` | `~/.gemini/settings.json` | 서브에이전트 |  |
| GitHub Copilot CLI | `copilot` | `~/.copilot/hooks/muwi.json` | 서브에이전트 | 열려 있는 Copilot 세션을 다시 켜기 |
| Cursor CLI | `cursor` | `~/.cursor/hooks.json` |  |  |
| Qwen Code | `qwen` | `~/.qwen/settings.json` |  |  |
| Qoder CLI | `qodercli` | `~/.qoder/settings.json` |  |  |
| Kimi Code | `kimi` | `~/.kimi-code/config.toml` | 서브에이전트 |  |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/config/hooks.json` | 서브에이전트 |  |
| Droid | `droid` | `~/.factory/hooks.json` (없으면 `settings.json`) | 서브에이전트 |  |
| Devin CLI | `devin` | `~/.config/devin/config.json` | 서브에이전트 |  |
| Grok CLI | `grok` | `~/.grok/hooks/muwi.json` |  |  |
| Mastra Code | `mastracode` | `~/.mastracode/hooks.json` | 서브에이전트 |  |
| Letta Code | `letta` | `~/.letta/settings.json` | 서브에이전트 |  |
| OpenCode | `opencode` | `~/.config/opencode/plugins/muwi.js` |  |  |
| Kilo CLI | `kilo` | `~/.config/kilo/plugin/muwi.js` |  |  |
| oh-my-pi | `omp` | `~/.omp/agent/extensions/muwi.ts` |  |  |
| Pi | `pi` | `~/.pi/agent/extensions/muwi.ts` | 서브에이전트 (Pi에는 서브에이전트가 없습니다) |  |
| Hermes Agent | `hermes` | `~/.hermes/plugins/muwi/` |  | `hermes plugins enable muwi`로 플러그인 켜기 |

표의 말뜻은 이렇습니다.

- **그 도구의 훅이 알려 주지 않는 것**: 커넥터가 선언합니다 (`muwi setup --tools`에도 나옵니다). "서브에이전트"라고 적힌 도구에서는 서브에이전트가 `--sub`로 밝힌 노드만 서브에이전트가 한 것으로 나오고, 서브에이전트가 읽은 skill이 따로 구분되지 않습니다. 비어 있으면 `--sub`를 빼먹어도 알아봅니다.
- **넣은 뒤 한 번 할 일**: 그 도구가 새로 들어온 훅이나 플러그인을 바로 돌리지 않는 경우입니다. Codex는 보안 때문에 새 훅을 사람이 승인하기 전에는 돌리지 않습니다. Codex 화면에서 `/hooks`를 입력해 muwi 훅을 승인하면 그 뒤로 돕니다. 승인하기 전에도 계획과 진행 기록은 됩니다.

- **셸 명령에 세션 id를 넘겨주지 않는 도구**(Claude Code, Codex, Kimi Code, Pi, oh-my-pi, Hermes 말고는 모두)는 Herdr의 터미널을 세션으로 봅니다. 같은 터미널에서 새 대화를 열면 앞 대화와 같은 세션으로 적힙니다.
- 모델은 그 도구의 훅이 알려 줄 때 적힙니다. 알려 주지 않는 도구에서는 `muwi run`으로 맡길 때 명령에 준 모델(`--agent "codex --model gpt-5"`)을 적고, 그것도 없으면 비워 둡니다. 짐작해서 채우지 않습니다.
- 커넥터는 각 도구의 공식 문서와 Herdr가 그 도구에 넣는 통합을 따라 만들었습니다. 도구가 훅의 모양을 바꾸면 muwi도 따라 고쳐야 합니다.

### 커넥터가 해야 하는 일

새 도구를 붙이려면 커넥터 하나를 만듭니다 (`packages/muwi/src/connectors/types.ts`의 `Adapter`). 꼭 해야 하는 일은 넷입니다.

| 할 일 | 내용 |
| --- | --- |
| 넣기 (`install`) | 그 도구의 설정에 훅이나 플러그인을 넣습니다. 여러 번 해도 한 벌만 남습니다 |
| 빼기 (`remove`) | 넣은 것만 뺍니다 |
| 읽기 (`from`) | 그 도구의 훅 입력을 공통 사건으로 바꿉니다: 세션 시작, skill을 읽음, 서브에이전트 시작·끝, 서브에이전트가 실행하려는 셸 명령 |
| 답하기 (`to`) | 코어의 답을 그 도구의 형식으로 바꿉니다. 답은 "말해 주기" 하나입니다 (세션이 시작될 때의 지침). muwi는 돌려보내지 않습니다 |

그리고 그 도구의 훅이 알려 주는 것을 선언합니다 (`can`: 서브에이전트, 세션 시작, skill 읽기). 선언에 없는 것은 위의 "어느 도구에서나 똑같이 되는 것"으로 메웁니다. 도구 표(`packages/muwi/src/connectors/tools.ts`)에는 설정 폴더, 지침 파일, 띄우는 명령과 이어 가는 명령을 적습니다.

## Windows에서 쓰기

Windows에서도 같은 방법으로 설치합니다. 다른 점은 이렇습니다.

| 항목 | Windows에서 |
| --- | --- |
| 훅 | Claude Code가 Git Bash로 실행합니다. Git for Windows가 없으면 훅이 돌지 않아 진행이 기록되지 않습니다. 훅이 실패해도 작업은 막지 않습니다 |
| AI 도구 안의 `muwi` 명령 | npm이 PATH에 건 `muwi`를 씁니다. npm이 만든 `muwi.cmd`(PowerShell·cmd)와 `muwi`(Git Bash)가 Node로 패키지의 명령을 실행합니다 |
| 터미널용 명령 | `muwi setup`이 `%USERPROFILE%\.local\bin`에 `muwi`(Git Bash용)와 `muwi.cmd`(PowerShell·cmd용)를 넣습니다. 이 폴더가 PATH에 없으면 추가하세요 |
| 그래프 칸 | `muwi.cmd`로 기록을 읽습니다 |
| 줄바꿈 | 저장소의 `.gitattributes`가 스크립트를 LF로 받게 합니다. `core.autocrlf` 설정과 상관없이 Git Bash에서 깨지지 않습니다 |

GitHub Actions의 Windows에서 시험 전체를 돌리고, 두 패키지를 하나씩 `npm i -g`로 깔아 npm이 만든 `muwi.cmd`로 실행해 봅니다. Git Bash로 훅을, PowerShell과 cmd로 `muwi setup`이 넣은 `muwi.cmd`를 실제로 실행해 확인합니다. Windows용 Herdr 앱에서 그래프 칸이 도는지와 실제 Claude Code 세션이 훅을 부르는 것은 아직 확인하지 못했습니다. 문제가 있으면 [이슈](https://github.com/Ssoon-m/muwi/issues)로 알려 주세요.

## 업데이트하기

```sh
npm i -g herdr-muwi@latest       # muwi만 깔았으면 muwi@latest
```

같은 자리에서 바뀌므로 이미 열려 있는 세션의 훅도 다음 호출부터 새 버전으로 돕니다. 지침이 바뀌었으면 그 세션의 다음 `muwi` 명령 출력에 새 지침이 한 번 붙고, 다음 세션이 시작될 때 터미널용 명령·그래프 칸·커넥터를 새 버전에 맞춥니다. 커넥터가 거는 훅의 종류가 바뀐 업데이트는 세션을 새로 열어야 적용됩니다.

**다른 자리에 새로 깔았을 때.** npm은 Node마다 다른 자리에 깝니다. nvm 등으로 Node 버전을 바꾸고 그 Node에 새로 깔았다면, 훅과 `~/.local/bin/muwi`는 여전히 옛 자리를 가리킵니다. `~/.local/bin`이 PATH 앞에 있으면 `muwi`를 쳐도 옛 판이 돕니다. 새 자리의 명령으로 setup을 한 번 실행하세요.

```sh
"$(npm prefix -g)/bin/muwi" setup     # Windows: & "$(npm prefix -g)\muwi.cmd" setup
```

`muwi setup`과 `muwi --version`은 PATH에서 지금 도는 판보다 새 판을 찾으면 그 자리와 위 명령을 알려 줍니다.

## 제거하기

`muwi setup --remove`를 먼저 실행하세요. 패키지를 먼저 지우면 `muwi` 명령을 쓸 수 없습니다. 커넥터, 터미널용 명령, 그래프 칸을 빼고, `muwi layout`으로 화면을 바꿔 뒀으면 원래 레이아웃으로 되돌립니다.

```sh
muwi setup --remove
npm rm -g herdr-muwi
```

기록(`~/.muwi/`)과 Node 경로 캐시(`~/.cache/muwi/`)는 남습니다. 필요 없으면 폴더를 지우세요.
