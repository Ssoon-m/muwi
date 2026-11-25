# 기록 파일

muwi가 남기는 파일의 위치와 형식을 정리했습니다. 기록을 직접 읽어 분석하거나 도구를 만들 때 참고하세요.

기록 파일을 직접 고치지 마세요. `muwi` 명령으로만 기록합니다.

## 폴더 구조

기록 폴더는 `~/.muwi`입니다. `$MUWI_DIR`로 바꿀 수 있습니다.

```
~/.muwi/
  <작업>/
    plan.json         지금의 계획
    events.jsonl      일어난 일 (한 줄에 하나)
    …                 AI가 작업하면서 남긴 파일 (요구사항 정리, 리뷰 결과 등)
  .sessions/
    <세션>.json       세션 정보
    <세션>.ok         이번 요청에서 계획 확인을 마쳤다는 표시
  config.json         설정
  setup.json          muwi setup이 설치한 항목
  .hook-errors.log    훅에서 난 오류
```

## plan.json

지금의 계획과 각 노드의 상태입니다.

| 필드 | 설명 |
| --- | --- |
| `work` | 작업 이름 |
| `schema` | 기록 형식의 판. 지금은 `2`입니다 |
| `title` | 작업 제목 |
| `request` | 사용자가 시킨 말 |
| `cwd` | 작업을 시작한 폴더 |
| `createdAt`, `updatedAt` | 만든 시각, 마지막으로 바뀐 시각 |
| `nodes` | 노드 목록 |

| 노드의 필드 | 설명 |
| --- | --- |
| `id`, `title`, `after` | 계획에 적은 것 |
| `run`, `show` | AI가 정한 맡는 쪽과 보여 줄 곳. 정했을 때만 있습니다 |
| `status` | `todo`(아직), `doing`(작업 중), `waiting`(응답 대기), `blocked`(막힘), `done`(끝) |
| `note` | 마지막으로 남긴 한 줄: 결과, 묻는 내용, 막힌 이유 |
| `attempt` | 몇 번째 회차인지. 시작한 적이 없으면 없습니다 |
| `by` | 지금 하고 있는 쪽: `session`, 서브에이전트면 `agent`, 시작한 시각 `at`. 작업 중일 때만 있습니다 |

훅은 `by`를 읽어서, 방금 일어난 일이 어느 노드의 것인지 알아냅니다.

## events.jsonl

일어난 일을 한 줄에 하나씩 덧붙입니다. 모든 줄에 시각 `at`과 세션 `session`이 있습니다.

| `type` | 언제 | 주요 필드 |
| --- | --- | --- |
| `plan` | 계획을 적거나 바꿀 때 | `by`(`ai` 또는 `human`), `why`, `added`, `removed`, `changed`, `gone`(뺀 노드의 id, 제목, 상태) |
| `node` | 노드의 상태가 바뀔 때 | `node`, `status`, `note`, `attempt`, `agent`(서브에이전트가 시작했을 때), `seen`(시작할 때 훅이 그 세션을 지켜보고 있었는지) |
| `skill` | skill을 읽을 때 | `skill`, `via`(`tool` 또는 `file`), `agent`, `node`, `attempt`, `guess`, `carried` |
| `agent` | 서브에이전트가 시작하고 끝날 때 | `agent`, `what`(`start` 또는 `stop`), `kind`, `node`, `attempt`, `guess` |
| `spawn` | `muwi run`·`muwi resume`으로 세션을 띄울 때 | `id`(띄운 것의 이름표), `node`, `terminal`, `from`(띄운 쪽의 터미널), `name`, `show`, `task`(맡긴 말), `cwd`, `model` |
| `join` | 띄운 세션이 맡은 노드에 붙을 때 | `node`, `spawn`(붙은 `spawn`의 `id`), `terminal` |
| `tell` | `muwi tell`로 말을 보낼 때 | `node`, `text`, `to`(보낸 터미널), `sent` |
| `flag` | `muwi flag`를 실행할 때 | `node`, `text` |
| `session` | 대화가 요약될 때 | `what`: `compact` |
| `viewed` | 끝난 작업을 사람이 처음 볼 때 (그래프 칸이 사람이 고른 그 작업을 보여 줄 때, 또는 `muwi viewed`) | 없음 |
| `archive`, `unarchive` | 사람이 작업을 보관하거나 꺼낼 때 (`muwi archive`, `muwi unarchive`, 그래프 칸의 보관 버튼) | 없음 |

`skill`과 `agent`의 `node`, `attempt`는 그 일이 일어난 순간에 하고 있던 노드와 회차입니다. 없으면 어느 노드도 하고 있지 않았다는 뜻입니다.

마지막 `archive`가 마지막 `unarchive`보다 늦고, 그 뒤로 작업에 일어난 일(노드, 계획, 새 세션 …)이 없으면 보관한 작업입니다. `viewed`와 `flag`는 작업에 일어난 일로 치지 않습니다. 보관하고 꺼낸 것은 작업이 바뀐 때로 치지 않아서 끝난 때와 "지난 작업" 접기는 그대로입니다.

마지막 노드가 끝난 뒤로 `viewed`가 없는 작업이 "새 결과"입니다. 그래서 끝난 때와 사람이 본 때의 차이로, 결과가 나온 뒤 사람이 확인하기까지 걸린 시간도 알 수 있습니다. `~/.muwi/.results-since`에는 새 결과를 세기 시작한 시각이 적혀 있습니다. 그보다 앞에 끝난 작업은 본 것으로 칩니다.

| 필드 | 뜻 |
| --- | --- |
| `guess: true` | 같은 쪽이 노드 여러 개를 동시에 하고 있어서, 가장 늦게 시작한 노드에 적었습니다 |
| `carried: true` | 세션이 이 작업에 붙기 전에 읽은 skill을 옮겨 적었습니다 |
| `seen: false` | 그 세션에서 훅이 실행되지 않았습니다. 이 회차의 "읽은 skill"은 알 수 없습니다 |

## 세션 파일

`.sessions/<세션>.json`에는 세션마다 다음이 있습니다.

| 필드 | 설명 |
| --- | --- |
| `key` | 세션 이름. 세션 id를 주는 도구(Claude Code, Codex, Kimi Code, Pi, oh-my-pi, Hermes)는 그 id, 그 밖의 도구는 `terminal-<터미널 주소>`입니다 |
| `tool` | 그 세션의 도구. `claude`, `codex`, `cursor`처럼 `muwi setup --tools`에 나오는 이름이고, 모르면 `unknown` |
| `model` | 그 세션이 쓰는 모델. 그 도구의 훅이 알려 줄 때만 있습니다 |
| `native` | 그 도구가 붙인 대화 id. 터미널을 세션으로 본 도구에서 하던 대화를 다시 열 때 씁니다 |
| `terminal` | 그 세션이 도는 터미널 주소 (터미널 연결이 알려 줍니다) |
| `pane` | 그 터미널을 담은 칸 (멀티플렉서가 칸과 터미널을 따로 다룰 때) |
| `turn` | 훅이 알려 준 지금 차례: `working`(사람이 말을 걸어 일하는 중), `done`(말을 끝내고 다음 말을 기다림) |
| `endedAt` | 훅이 세션이 끝났다고 알린 시각 |
| `work` | 붙어 있는 작업 |
| `loaded` | 이 세션이 읽은 skill과 처음 읽은 시각 |
| `hooked` | 훅이 이 세션을 마지막으로 본 시각 |
| `seenAt` | 이 세션이 마지막으로 기록한 시각 |

`muwi` 명령은 그 도구가 셸 명령에 넘겨주는 환경 변수(Claude Code는 `CLAUDE_CODE_SESSION_ID`, Codex는 `CODEX_THREAD_ID` 등)에서, 훅은 그 도구가 넘겨주는 세션 id에서 세션 이름을 얻습니다. 두 값은 같습니다. 세션 id를 주지 않는 도구는 터미널 연결이 알려 주는 터미널을 세션으로 봅니다.

## 그 밖의 파일

| 파일 | 내용 |
| --- | --- |
| `config.json` | `layout` 설정 |
| `setup.json` | `muwi setup`이 설치한 항목과 위치, 터미널 연결의 경로(`terminals`), 보기의 경로와 그 보기가 넣은 것(`views`) |
| `.spawns/<터미널>.json` | `muwi run`이 띄운 터미널마다 맡긴 작업과 노드. 환경 변수를 넘기지 못하는 터미널 연결을 위한 것이고, 맡은 세션이 붙으면 지웁니다 |
| `.hook-errors.log` | 훅에서 난 오류. 훅은 실패해도 세션을 멈추지 않고 여기에만 남깁니다 |
