#!/bin/sh
# Claude Code 훅이 부른다. 입력(JSON)을 읽고, 볼 필요가 있는 것만 muwi hook으로 넘긴다.
# 대부분의 호출(skill과 상관없는 파일 읽기, push가 아닌 명령, 이미 계획을 적은 세션의 파일 수정)은
# 여기서 끝나서 node를 띄우지 않는다.
#   hook.sh        세션이 시작되면 지침을 넣고, 읽은 skill과 서브에이전트의 시작·끝을 기록한다
#   hook.sh nudge  계획을 적지 않은 세션이 파일을 고치려 할 때 알려 준다 (계획을 적거나 muwi skip 하면 그친다)
#   hook.sh guard  push·PR·댓글 앞에서 사람에게 묻게 한다 (muwi config guard on 일 때)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
payload=$(cat)
case "${1:-}" in
  guard)
    # push·PR 명령이거나, 서브에이전트가 muwi 명령을 실행할 때만 넘긴다 (서브에이전트가 맡은 노드를 잇는다)
    case "$payload" in
      *push* | *"gh pr"* | *pullrequests*) ;;
      *'"agent_id"'*)
        case "$payload" in
          *muwi*) ;;
          *) exit 0 ;;
        esac
        ;;
      *) exit 0 ;;
    esac
    ;;
  nudge)
    # 작업에 붙었거나 계획 없이 진행하겠다고 밝힌 세션은 표시 파일이 있다
    sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id":"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -n 1)
    runs="${MUWI_DIR:-$HOME/.muwi}"
    if [ -n "$sid" ] && [ -f "$runs/.sessions/$sid.ok" ]; then exit 0; fi
    ;;
  *)
    case "$payload" in
      *'"SessionStart"'* | *'"SubagentStart"'* | *'"SubagentStop"'* | *'"Skill"'* | *SKILL.md*) ;;
      *) exit 0 ;;
    esac
    ;;
esac
printf '%s' "$payload" | "$ROOT/bin/muwi" hook "$@"
exit 0
