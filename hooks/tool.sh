#!/bin/sh
# Claude Code가 아닌 도구의 훅이 부른다: tool.sh <도구> [nudge|guard]
# 입력(JSON)을 그대로 muwi hook에 넘기고, muwi가 낸 출력과 종료 코드를 그대로 돌려준다.
# 그 도구의 형식으로 읽고 답하는 것은 그 도구의 통합(src/integrations)이 한다.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
tool="${1:-}"
[ -n "$tool" ] || exit 0
shift
exec "$ROOT/bin/muwi" hook "$@" --from "$tool"
