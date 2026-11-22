#!/bin/sh
# Claude Code 훅이 부른다. 입력(JSON)을 읽고, 볼 필요가 있는 것만 muwi hook으로 넘긴다.
# 대부분의 호출(skill과 상관없는 파일 읽기, push가 아닌 명령, 이미 계획을 적은 세션의 파일 수정)은
# 여기서 끝나서 node를 띄우지 않는다.
#   hook.sh        세션이 시작되면 지침을 넣고, 읽은 skill과 서브에이전트의 시작·끝을 기록한다.
#                  사람이 새로 말을 걸면 계획을 적었는지 다시 따지게 한다
#   hook.sh nudge  계획 없이 파일을 고치려 할 때 알려 준다 (계획을 적거나 muwi skip 하면 그 요청 동안 그친다)
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
      *'"SessionStart"'*)
        # Node가 24보다 낮으면 muwi가 실행되지 않고 훅은 조용히 넘어간다. 세션에 한 번 알려서 사람이 알게 한다
        v=$(node -v 2>/dev/null)
        major=${v#v}
        major=${major%%.*}
        case "$major" in '' | *[!0-9]*) major=0 ;; esac
        if [ "$major" -lt 24 ]; then
          printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"muwi: 이 세션에서 잡히는 Node가 '"${v:-없음}"'라서 muwi가 동작하지 않는다. Node 24 이상이 필요하다. 계획 기록 없이 평소대로 진행하고, 이 사실을 사용자에게 한 번 알린다."}}'
          exit 0
        fi
        ;;
    esac
    case "$payload" in
      *'"SessionStart"'* | *'"UserPromptSubmit"'* | *'"SubagentStart"'* | *'"SubagentStop"'* | *'"Skill"'* | *SKILL.md*) ;;
      *) exit 0 ;;
    esac
    ;;
esac
printf '%s' "$payload" | "$ROOT/bin/muwi" hook "$@"
exit 0
