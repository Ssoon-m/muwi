#!/bin/sh
# Claude Code가 아닌 도구의 훅(또는 플러그인)이 부른다: tool.sh <도구> [nudge|guard]
# 입력(JSON)을 읽고, 볼 필요가 있는 것만 muwi hook에 넘긴다. muwi가 낸 출력과 종료 코드를 그대로 돌려준다.
# 그 도구의 형식으로 읽고 답하는 것은 그 도구의 통합(src/integrations)이 한다.
# 대부분의 호출(skill과 상관없는 파일 읽기, push가 아닌 명령, 이미 계획을 적은 세션의 파일 수정)은 여기서 끝나서 node를 띄우지 않는다.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tool="${1:-}"
[ -n "$tool" ] || exit 0
shift
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
    sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -n 1)
    runs="${MUWI_DIR:-$HOME/.muwi}"
    if [ -n "$sid" ] && [ -f "$runs/.sessions/$sid.ok" ]; then exit 0; fi
    ;;
  *)
    # 도구를 쓴 뒤의 훅은 skill을 읽었을 때만 본다
    case "$payload" in
      *'"tool_name"'*)
        case "$payload" in
          *SKILL.md* | *'"skill"'* | *'"Skill"'*) ;;
          *) exit 0 ;;
        esac
        ;;
    esac
    ;;
esac
printf '%s' "$payload" | "$ROOT/bin/muwi" hook "$@" --from "$tool"
