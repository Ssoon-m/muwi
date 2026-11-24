# 설치와 설정

muwi가 무엇을 어디에 설치하는지, 설정으로 무엇을 바꿀 수 있는지, 어떻게 제거하는지 정리했습니다. 처음 설치한다면 [시작하기](../getting-started.md)를 먼저 보세요.

## 요구 사항

| 항목 | 조건 |
| --- | --- |
| Claude Code | 플러그인을 지원하는 버전 |
| Node | 24 이상. 빌드나 `npm install`은 필요 없습니다 |
| [Herdr 앱](https://herdr.dev) | 그래프를 보거나 새 세션을 띄울 때 필요합니다 |
| Git for Windows | Windows에서만. Claude Code가 훅을 Git Bash로 실행합니다. [Windows에서 쓰기](#windows에서-쓰기)를 보세요 |

PATH에 Node가 없는 곳(Herdr가 띄우는 세션, 그래프 칸)에서는 muwi가 로그인 셸에 물어 Node를 찾고 `~/.cache/muwi/node`에 적어 둡니다. Node 버전을 바꿨다면 `muwi setup`을 다시 실행하세요. 캐시를 버리고 다시 찾습니다. 자세한 내용은 [문제 해결하기](../guides/troubleshooting.md#node-24-이상이-필요하다고-나올-때)에 있습니다.

## 플러그인이 설치하는 것

```sh
claude plugin install muwi --marketplace Ssoon-m/muwi
```

Claude Code 세션 안에서는 이렇게 설치합니다.

```
/plugin marketplace add Ssoon-m/muwi
/plugin install muwi@muwi
```

| 항목 | 설명 |
| --- | --- |
| `muwi` 명령 | Claude Code의 Bash 도구에서 바로 쓸 수 있습니다 |
| 훅 | 진행을 기록하고 계획을 확인합니다. 목록은 [동작 원리](../how-it-works.md#훅이-하는-일)에 있습니다 |
| 지침 | 세션이 시작될 때 AI에게 계획을 적는 방법을 알려 줍니다 |
| 사용법 skill | AI가 계획을 적거나 기록을 진단할 때 읽는 `muwi` skill입니다 |

플러그인은 사용자의 `settings.json`과 `CLAUDE.md`를 고치지 않습니다.

특정 프로젝트에서만 쓰려면 `--scope project`를 붙여 설치하세요.

## muwi setup이 설치하는 것

플러그인의 명령은 Claude Code 세션 안에서만 보입니다. 터미널과 Herdr 앱에서 쓰려면 Claude Code 세션에서 한 번 실행하세요.

```sh
muwi setup
```

| 항목 | 위치 | 조건 |
| --- | --- | --- |
| 터미널용 `muwi` 명령 | `~/.local/bin/muwi` | 항상 |
| PowerShell·cmd용 `muwi` 명령 | `~/.local/bin/muwi.cmd` | Windows에서만 |
| 그래프 칸 | `~/.config/herdr-app/mods/muwi` | Herdr 앱이 있을 때 |

설치한 항목은 `~/.muwi/setup.json`에 기록합니다. `muwi setup --remove`는 이 기록에 있는 것만 지웁니다. 0.5.4까지는 `install.json`에 적었고, 0.5.5 이후 처음 setup을 할 때 옮깁니다. 0.4.0·0.5.0으로 연 세션이 `install.json`을 보고 설치를 옛 버전으로 되돌리던 문제 때문에 이름을 바꿨습니다.

플러그인이 업데이트되면 다음 세션이 시작될 때 두 항목을 새 버전에 맞춥니다.

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
muwi config nudge off      # 계획 알림 끄기
muwi config layout off     # 화면 바꾸기 안내 끄기
```

| 설정 | 기본값 | 켜면 |
| --- | --- | --- |
| `nudge` | `on` | 계획이 없는 상태에서 AI가 파일을 고치거나 서브에이전트를 띄우려 하면 돌려보내고 방법을 알려 줍니다 |
| `layout` | `on` | 화면에 muwi 칸이 없을 때 `muwi setup`과 그래프 칸이 `muwi layout`을 권합니다 |

`nudge`는 Edit, Write 도구로 고칠 때 동작합니다. 기록 폴더, `~/.claude`, `~/.codex`, 임시 폴더에 쓰는 파일은 확인하지 않습니다.

muwi는 명령을 막거나 사람에게 묻게 하지 않습니다. push나 PR처럼 승인받고 할 일은 그 AI 도구의 권한 설정이나 직접 둔 훅으로 정합니다 (0.5.x의 `guard`는 0.6.0에서 뺐습니다).

설정은 `~/.muwi/config.json`에 저장됩니다.

## 플러그인 없이 설치하기

저장소를 받아서 직접 설치할 수 있습니다.

```sh
git clone https://github.com/Ssoon-m/muwi.git ~/muwi
~/muwi/bin/muwi setup --claude
```

`--claude`는 훅을 `~/.claude/settings.json`에, 사용법 skill을 `~/.claude/skills/muwi`에 넣습니다. 고치기 전의 설정은 `settings.json.muwi.bak`으로 남기고, 다른 훅은 건드리지 않습니다.

## 다른 AI 도구에 넣기

muwi는 Claude Code 말고도 Herdr가 지원하는 AI 도구에서 씁니다. 도구마다 "통합"을 넣으면 그 도구의 세션도 같은 기록에 적히고 같은 그래프에 나옵니다. 리뷰는 Codex 세션이, 구현은 Claude Code 세션이 맡아도 작업 하나의 그래프 하나입니다.

```sh
muwi setup --tools                 # 아는 도구, 이 컴퓨터에 깔렸는지, 통합을 넣었는지
muwi setup --tool codex            # 그 도구에 통합을 넣습니다. 여러 개는 쉼표로: --tool codex,cursor
muwi setup --all                   # 깔려 있는 도구 전부에 넣습니다 (Claude Code는 플러그인이 넣어 주므로 뺍니다)
```

통합이 넣는 것은 세 가지입니다. 넣은 것은 `~/.muwi/setup.json`에 적어 두고, `muwi setup --remove`가 우리 것만 뺍니다. 남의 훅과 지침은 건드리지 않고, 처음 고치는 파일은 `.muwi.bak`으로 원본을 남깁니다.

| 넣는 것 | 설명 |
| --- | --- |
| 지침 | 그 도구가 늘 읽는 지침 파일(`AGENTS.md` 등)에 muwi 지침을 구간 표시로 넣습니다. 그런 파일이 없는 도구는 세션이 시작될 때 훅이 넣습니다 |
| 사용법 skill | 그 도구의 skill 폴더에 `muwi` skill을 넣습니다 |
| 훅 또는 플러그인 | 세션 시작, 사람이 말할 때, 파일을 고치거나 서브에이전트를 띄우기 전, skill을 읽은 뒤에 muwi를 부르게 합니다 |

| 도구 | 이름 (`--tool`) | 훅·플러그인을 넣는 곳 | 이 도구에서 안 되는 기능 | 넣은 뒤 한 번 할 일 |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | 플러그인. 플러그인 없이 쓰면 `~/.claude/settings.json` |  |  |
| Codex | `codex` | `~/.codex/hooks.json` |  | Codex에서 `/hooks`를 열어 muwi 훅을 승인 |
| GitHub Copilot CLI | `copilot` | `~/.copilot/hooks/muwi.json` | 말할 때 지침 다시 넣기, 서브에이전트 표시 | 열려 있는 Copilot 세션을 다시 켜기 |
| Cursor CLI | `cursor` | `~/.cursor/hooks.json` | 말할 때 지침 다시 넣기 |  |
| Qwen Code | `qwen` | `~/.qwen/settings.json` |  |  |
| Qoder CLI | `qodercli` | `~/.qoder/settings.json` |  |  |
| Kimi Code | `kimi` | `~/.kimi-code/config.toml` | 서브에이전트 표시 |  |
| Antigravity CLI | `antigravity-cli` | `~/.gemini/config/hooks.json` | 말할 때 지침 다시 넣기, 서브에이전트 표시 |  |
| Droid | `droid` | `~/.factory/hooks.json` (없으면 `settings.json`) | 서브에이전트 표시 |  |
| Devin CLI | `devin` | `~/.config/devin/config.json` | 서브에이전트 표시 |  |
| Grok CLI | `grok` | `~/.grok/hooks/muwi.json` | 말할 때 지침 다시 넣기 |  |
| Mastra Code | `mastracode` | `~/.mastracode/hooks.json` | 말할 때 지침 다시 넣기, 서브에이전트 표시 |  |
| Letta Code | `letta` | `~/.letta/settings.json` | 서브에이전트 표시 |  |
| OpenCode | `opencode` | `~/.config/opencode/plugins/muwi.js` |  |  |
| Kilo CLI | `kilo` | `~/.config/kilo/plugin/muwi.js` |  |  |
| oh-my-pi | `omp` | `~/.omp/agent/extensions/muwi.ts` |  |  |
| Pi | `pi` | `~/.pi/agent/extensions/muwi.ts` | 서브에이전트 표시 (Pi에는 서브에이전트가 없습니다) |  |
| Hermes Agent | `hermes` | `~/.hermes/plugins/muwi/` |  | `hermes plugins enable muwi`로 플러그인 켜기 |

표의 말뜻은 이렇습니다.

- **말할 때 지침 다시 넣기**: muwi를 업데이트해서 지침이 바뀌면, 열려 있는 세션에 사람이 다음 말을 걸 때 새 지침을 넣어 주는 기능입니다. 안 되는 도구는 세션을 새로 열어야 새 지침을 받습니다.
- **서브에이전트 표시**: 노드를 서브에이전트가 했을 때 그래프에 "서브"로 나오고, 그 서브에이전트가 읽은 skill이 그 노드에 붙는 것입니다. 안 되는 도구에서는 그 세션이 한 것으로 적힙니다.
- **넣은 뒤 한 번 할 일**: 그 도구가 새로 들어온 훅이나 플러그인을 바로 돌리지 않는 경우입니다. Codex는 보안 때문에 새 훅을 사람이 승인하기 전에는 돌리지 않습니다. Codex 화면에서 `/hooks`를 입력해 muwi 훅을 승인하면 그 뒤로 돕니다. 승인하기 전에도 계획과 진행 기록은 되고, 읽은 skill 기록과 계획 알림만 빠집니다.

표에 없는 것은 그 도구에서도 됩니다: 계획·진행 기록, 그래프, 계획 없이 고칠 때 알림, 읽은 skill 기록, 모델 기록, 새 세션에 맡기기.

- **"말할 때 지침 다시 넣기"가 안 되는 도구**는 muwi를 업데이트한 뒤 열려 있던 세션을 새로 열어야 새 지침을 받습니다.
- **셸 명령에 세션 id를 넘겨주지 않는 도구**(Claude Code, Codex, Kimi Code, Pi, oh-my-pi, Hermes 말고는 모두)는 Herdr의 터미널을 세션으로 봅니다. 같은 터미널에서 새 대화를 열면 앞 대화와 같은 세션으로 적힙니다.
- 통합은 각 도구의 공식 문서와 Herdr가 그 도구에 넣는 통합을 따라 만들었습니다. 도구가 훅의 모양을 바꾸면 muwi도 따라 고쳐야 합니다.

## Windows에서 쓰기

Windows에서도 같은 방법으로 설치합니다. 다른 점은 이렇습니다.

| 항목 | Windows에서 |
| --- | --- |
| 훅 | Claude Code가 Git Bash로 실행합니다. Git for Windows가 없으면 훅이 돌지 않아 진행이 기록되지 않습니다. 훅이 실패해도 작업은 막지 않습니다 |
| Claude Code 안의 `muwi` 명령 | Bash 도구(Git Bash)는 플러그인의 `bin/muwi`를, PowerShell 도구는 `bin/muwi.cmd`를 씁니다 |
| 터미널용 명령 | `muwi setup`이 `%USERPROFILE%\.local\bin`에 `muwi`(Git Bash용)와 `muwi.cmd`(PowerShell·cmd용)를 넣습니다. 이 폴더가 PATH에 없으면 추가하세요 |
| 그래프 칸 | `muwi.cmd`로 기록을 읽습니다 |
| 줄바꿈 | 저장소의 `.gitattributes`가 스크립트를 LF로 받게 합니다. `core.autocrlf` 설정과 상관없이 Git Bash에서 깨지지 않습니다 |

GitHub Actions의 Windows에서 시험 전체를 돌리고, Git Bash로 훅을, PowerShell과 cmd로 `muwi.cmd`를 실제로 실행해 확인합니다. Windows용 Herdr 앱에서 그래프 칸이 도는지와 실제 Claude Code 세션이 훅을 부르는 것은 아직 확인하지 못했습니다. 문제가 있으면 [이슈](https://github.com/Ssoon-m/muwi/issues)로 알려 주세요.

## 업데이트하기

```sh
claude plugin update muwi
```

이미 열려 있는 세션도 사람이 다음에 말을 걸 때 새 버전으로 맞춥니다. 새 버전의 코드가 훅을 처리하고, 지침이 바뀌었으면 새 지침을 한 번 넣고, 터미널용 명령과 그래프 칸도 새 버전으로 바꿉니다. 훅이 걸리는 시점(`hooks.json`)이 바뀐 업데이트만은 세션을 새로 열어야 적용됩니다. 0.5.4 이후에 연 세션부터 이렇게 동작합니다.

## 제거하기

`muwi setup --remove`를 먼저 실행하세요. 플러그인을 먼저 지우면 `muwi` 명령을 쓸 수 없습니다. `muwi layout`으로 화면을 바꿔 뒀으면 원래 레이아웃으로 되돌리는 것까지 합니다.

```sh
muwi setup --remove
claude plugin uninstall muwi
```

기록(`~/.muwi/`)과 Node 경로 캐시(`~/.cache/muwi/`)는 남습니다. 필요 없으면 폴더를 지우세요.
