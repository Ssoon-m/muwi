# 설치

Node 22.18 이상이 필요합니다. 빌드나 `npm install`은 없습니다.

## Claude Code 플러그인

터미널에서 실행합니다.

```sh
claude plugin install muwi --marketplace Ssoon-m/muwi
```

Claude Code 안에서는 이렇게 합니다.

```
/plugin marketplace add Ssoon-m/muwi
/plugin install muwi@muwi
```

플러그인이 넣는 것은 다음과 같습니다. 내 설정 파일(`settings.json`, `CLAUDE.md`)은 고치지 않습니다.

| 무엇 | 어떻게 |
| --- | --- |
| `muwi` 명령 | 플러그인의 `bin/`이 Claude Code의 Bash 도구에서 바로 보입니다 |
| 훅 | 세션 시작, 읽은 skill 기록, 계획 알림, push 앞에서 묻기 |
| 지침 | 세션이 시작될 때마다 훅이 넣어 줍니다 |
| 사용법 skill | `muwi` |

특정 프로젝트에서만 쓰려면 `--scope project`를 붙여 설치합니다. 업데이트는 `claude plugin update muwi`입니다.

## 터미널과 Herdr 앱

플러그인의 명령은 Claude Code 세션 안에서만 보입니다. 터미널에서 직접 쓰거나 Herdr 앱에서 그래프를 보려면 Claude Code 세션에서 한 번 실행합니다 (AI에게 "muwi setup 실행해줘"라고 해도 됩니다).

```sh
muwi setup
```

| 무엇 | 어디에 | 조건 |
| --- | --- | --- |
| 터미널용 `muwi` 명령 | `~/.local/bin/muwi` | 항상 |
| 그래프 칸 | `~/.config/herdr-app/mods/muwi` | Herdr 앱이 있을 때 |

- 무엇을 넣었는지는 `~/.muwi/install.json`에 적어 둡니다.
- 플러그인이 업데이트돼 설치 위치가 바뀌면, 다음 세션이 시작될 때 위 항목을 새 위치로 맞춥니다.

## 설정

```sh
muwi config                # 지금 설정 보기
muwi config nudge off      # 계획 없이 파일을 고치려 할 때 알리지 않는다 (기본: on)
muwi config guard on       # git push, gh pr, Bitbucket PR 쓰기 앞에서 사람에게 묻는다 (기본: off)
```

## 플러그인 없이

저장소를 받아서 직접 넣을 수도 있습니다. 이때는 `~/.claude/settings.json`에 훅을 넣습니다 (고치기 전 파일은 `settings.json.muwi.bak`, 다른 훅은 건드리지 않습니다).

```sh
git clone https://github.com/Ssoon-m/muwi.git ~/muwi
~/muwi/bin/muwi setup --claude
```

## Codex (선택)

```sh
muwi setup --codex
```

`~/.codex/AGENTS.md`에 지침 구간을, `~/.codex/skills/muwi`에 사용법 skill을 넣습니다. Codex에는 훅이 없어서 **계획 기록만 됩니다.** 읽은 skill이 기록되지 않고, 계획 없이 파일을 고쳐도 알리지 않습니다. 옵션을 주지 않으면 Codex는 건드리지 않습니다.

## 제거

```sh
muwi setup --remove            # setup으로 넣은 것만 뺀다. 먼저 실행한다
claude plugin uninstall muwi
```

기록(`~/.muwi/`)은 남습니다. 필요 없으면 폴더를 지웁니다.
