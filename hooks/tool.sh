#!/bin/sh
# Claude Code가 아닌 도구의 훅(또는 플러그인)이 부른다: tool.sh <도구> [nudge|command]
# 입력(JSON)을 읽고, 볼 필요가 있는 것만 muwi hook에 넘긴다. muwi가 낸 출력과 종료 코드를 그대로 돌려준다.
# 그 도구의 형식으로 읽고 답하는 것은 그 도구의 통합(src/integrations)이 한다.
# 대부분의 호출(skill과 상관없는 파일 읽기, 서브에이전트가 아닌 쪽의 명령, 이미 계획을 적은 세션의 파일 수정)은 여기서 끝나서 node를 띄우지 않는다.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tool="${1:-}"
[ -n "$tool" ] || exit 0
shift
payload=$(cat)
# 볼 일이 없으면 조용히 끝낸다. 답이 늘 JSON이어야 하는 도구에는 빈 JSON을 낸다
skip() {
  case "$tool" in antigravity-cli) printf '{}' ;; esac
  exit 0
}
case "${1:-}" in
  command | guard)
    # 서브에이전트가 muwi 명령을 실행할 때만 넘긴다 (서브에이전트가 맡은 노드를 잇는다). 명령을 막지 않는다
    case "$payload" in
      *'"agent_id"'*)
        case "$payload" in
          *muwi*) ;;
          *) skip ;;
        esac
        ;;
      *) skip ;;
    esac
    ;;
  nudge)
    # 작업에 붙었거나 계획 없이 진행하겠다고 밝힌 세션은 표시 파일이 있다
    sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id" *: *"\([A-Za-z0-9_.-]*\)".*/\1/p' | head -n 1)
    runs="${MUWI_DIR:-$HOME/.muwi}"
    if [ -n "$sid" ] && [ -f "$runs/.sessions/$sid.ok" ]; then skip; fi
    # 셸 명령에 세션 id를 넘겨주지 않는 도구는 터미널을 세션으로 본다 (Codex, Kimi Code는 세션 id를 넘겨준다)
    case "$tool" in
      codex | kimi) ;;
      *) if [ -n "${HC_TERMINAL_ID:-}" ] && [ -f "$runs/.sessions/hc-$HC_TERMINAL_ID.ok" ]; then skip; fi ;;
    esac
    ;;
  *)
    # 도구를 쓴 뒤의 훅은 skill을 읽었을 때만 본다
    case "$payload" in
      *'"tool_name"'*)
        case "$payload" in
          *SKILL.md* | *'"skill"'* | *'"Skill"'*) ;;
          *) skip ;;
        esac
        ;;
    esac
    ;;
esac
printf '%s' "$payload" | "$ROOT/bin/muwi" hook "$@" --from "$tool"
