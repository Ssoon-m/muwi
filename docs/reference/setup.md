# 설치와 설정

muwi가 무엇을 어디에 설치하는지, 설정으로 무엇을 바꿀 수 있는지, 어떻게 제거하는지 정리했습니다. 처음 설치한다면 [시작하기](../getting-started.md)를 먼저 보세요.

## 요구 사항

| 항목 | 조건 |
| --- | --- |
| Claude Code | 플러그인을 지원하는 버전 |
| Node | 24 이상. 빌드나 `npm install`은 필요 없습니다 |
| [Herdr 앱](https://herdr.dev) | 그래프를 보거나 새 세션을 띄울 때 필요합니다 |

Node는 터미널, Claude Code가 훅을 실행하는 환경, Herdr가 띄우는 세션에서 모두 24 이상이어야 합니다. 확인 방법은 [문제 해결하기](../guides/troubleshooting.md#node-24-이상이-필요하다고-나올-때)에 있습니다.

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

## 설정

```sh
muwi config                # 현재 설정 보기
muwi config nudge off      # 계획 알림 끄기
muwi config guard on       # push 전에 묻기 켜기
```

| 설정 | 기본값 | 켜면 |
| --- | --- | --- |
| `nudge` | `on` | 계획이 없는 상태에서 AI가 파일을 고치려 하면 돌려보내고 방법을 알려 줍니다 |
| `guard` | `off` | 아래 명령 앞에서 사용자에게 실행해도 되는지 묻습니다 |

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

## 제거하기

`muwi setup --remove`를 먼저 실행하세요. 플러그인을 먼저 지우면 `muwi` 명령을 쓸 수 없습니다.

```sh
muwi setup --remove
claude plugin uninstall muwi
```

기록(`~/.muwi/`)은 남습니다. 필요 없으면 폴더를 지우세요.
