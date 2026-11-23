# 설치와 설정

muwi가 무엇을 어디에 설치하는지, 설정으로 무엇을 바꿀 수 있는지, 어떻게 제거하는지 정리했습니다. 처음 설치한다면 [시작하기](../getting-started.md)를 먼저 보세요.

## 요구 사항

| 항목 | 조건 |
| --- | --- |
| Claude Code | 플러그인을 지원하는 버전 |
| Node | 24 이상. 빌드나 `npm install`은 필요 없습니다 |
| [Herdr 앱](https://herdr.dev) | 그래프를 보거나 새 세션을 띄울 때 필요합니다 |

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
| 그래프 칸 | `~/.config/herdr-app/mods/muwi` | Herdr 앱이 있을 때 |

설치한 항목은 `~/.muwi/install.json`에 기록합니다. `muwi setup --remove`는 이 기록에 있는 것만 지웁니다.

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
| Herdr가 업데이트됐다 | 그래프 칸에 "맞추기" 안내가 나옵니다. 누르거나 `muwi layout`을 다시 실행하면 원래 레이아웃의 새 모양으로 다시 복제합니다. 복제본을 손으로 고쳤으면 다시 만들지 않습니다 |
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
muwi config guard on       # push 전에 묻기 켜기
muwi config layout off     # 화면 바꾸기 안내 끄기
```

| 설정 | 기본값 | 켜면 |
| --- | --- | --- |
| `nudge` | `on` | 계획이 없는 상태에서 AI가 파일을 고치거나 서브에이전트를 띄우려 하면 돌려보내고 방법을 알려 줍니다 |
| `guard` | `off` | 아래 명령 앞에서 사용자에게 실행해도 되는지 묻습니다 |
| `layout` | `on` | 화면에 muwi 칸이 없을 때 `muwi setup`과 그래프 칸이 `muwi layout`을 권합니다 |

`nudge`는 Edit, Write 도구로 고칠 때 동작합니다. 기록 폴더, `~/.claude`, `~/.codex`, 임시 폴더에 쓰는 파일은 확인하지 않습니다.

`guard`가 묻는 명령은 다음과 같습니다.

- `git push`
- `gh pr create`, `merge`, `comment`, `review`, `close`, `edit`, `ready`
- Bitbucket API로 PR을 만들거나 댓글을 쓰는 요청

설정은 `~/.muwi/config.json`에 저장됩니다.

## 플러그인 없이 설치하기

저장소를 받아서 직접 설치할 수 있습니다.

```sh
git clone https://github.com/Ssoon-m/muwi.git ~/muwi
~/muwi/bin/muwi setup --claude
```

`--claude`는 훅을 `~/.claude/settings.json`에, 사용법 skill을 `~/.claude/skills/muwi`에 넣습니다. 고치기 전의 설정은 `settings.json.muwi.bak`으로 남기고, 다른 훅은 건드리지 않습니다.

## Codex에 설치하기

```sh
muwi setup --codex
```

`~/.codex/AGENTS.md`에 지침을, `~/.codex/skills/muwi`에 사용법 skill을 넣습니다.

Codex에는 훅이 없습니다. AI가 계획과 진행을 기록할 수는 있지만, 읽은 skill이 기록되지 않고 계획 알림도 없습니다.

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
