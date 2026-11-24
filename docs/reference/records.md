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
| `spawn` | `muwi run`으로 세션을 띄울 때 | `node`, `terminal`, `name`, `show`, `task`(맡긴 말) |
| `join` | 띄운 세션이 맡은 노드에 붙을 때 | `node`, `terminal` |
| `flag` | `muwi flag`를 실행할 때 | `node`, `text` |
| `session` | 대화가 요약될 때 | `what`: `compact` |
| `viewed` | 끝난 작업을 사람이 처음 볼 때 (그래프 칸이 사람이 고른 그 작업을 보여 줄 때, 또는 `muwi viewed`) | 없음 |

`skill`과 `agent`의 `node`, `attempt`는 그 일이 일어난 순간에 하고 있던 노드와 회차입니다. 없으면 어느 노드도 하고 있지 않았다는 뜻입니다.

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
| `key` | 세션 이름. Claude Code의 세션 id입니다 |
| `tool` | 그 세션의 도구. `claude`, `codex`, `cursor`처럼 `muwi setup --tools`에 나오는 이름이고, 모르면 `unknown` |
| `model` | 그 세션이 쓰는 모델. 그 도구의 훅이 알려 줄 때만 있습니다 |
| `native` | 그 도구가 붙인 대화 id. 터미널을 세션으로 본 도구에서 하던 대화를 다시 열 때 씁니다 |
| `terminal` | Herdr 터미널 주소 |
| `work` | 붙어 있는 작업 |
| `loaded` | 이 세션이 읽은 skill과 처음 읽은 시각 |
| `hooked` | 훅이 이 세션을 마지막으로 본 시각 |
| `skipped` | `muwi skip`으로 남긴 이유. 사용자가 다음에 말을 걸면 지워집니다 |
| `seenAt` | 이 세션이 마지막으로 기록한 시각 |

`muwi` 명령은 환경 변수 `CLAUDE_CODE_SESSION_ID`에서, 훅은 Claude Code가 넘겨주는 `session_id`에서 세션 이름을 얻습니다. 두 값은 같습니다.

## 그 밖의 파일

| 파일 | 내용 |
| --- | --- |
| `config.json` | `nudge`, `layout` 설정 |
| `setup.json` | `muwi setup`이 설치한 항목과 위치. 0.5.4까지는 `install.json` |
| `.hook-errors.log` | 훅에서 난 오류. 훅은 실패해도 세션을 멈추지 않고 여기에만 남깁니다 |
