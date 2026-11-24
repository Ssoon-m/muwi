#!/bin/sh
# Claude Code 훅이 부른다. 입력(JSON)을 읽고, 볼 필요가 있는 것만 muwi hook으로 넘긴다.
# 대부분의 호출(skill과 상관없는 파일 읽기, 서브에이전트가 아닌 쪽의 명령, 이미 계획을 적은 세션의 파일 수정)은
# 여기서 끝나서 node를 띄우지 않는다.
#   hook.sh        세션이 시작되면 지침을 넣고, 읽은 skill과 서브에이전트의 시작·끝을 기록한다
#   hook.sh command  서브에이전트가 muwi로 노드를 시작하면 그 노드를 그 서브에이전트가 한 것으로 잇는다. 명령을 막지 않는다
#                  (0.5.x의 훅 설정은 guard라고 부른다. push 앞에서 묻기는 0.6.0에서 뺐다)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
payload=$(cat)
case "${1:-}" in
  command | guard)
    # 서브에이전트가 muwi 명령을 실행할 때만 넘긴다 (서브에이전트가 맡은 노드를 잇는다)
    case "$payload" in
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
    # 0.5.x의 훅 설정이 부르던 갈래 (계획 없이 고칠 때 알림). 0.6.0에서 뺐다. 조용히 지나간다
    exit 0
    ;;
  *)
    case "$payload" in
      *'"SessionStart"'*)
        # Node가 24보다 낮으면 muwi가 실행되지 않고 훅은 조용히 넘어간다. 세션에 한 번 알려서 사람이 알게 한다
        # PATH에 없어도 nvm 같은 도구의 기본 버전을 찾는다 (src/find-node.sh)
        . "$ROOT/src/find-node.sh"
        v=$("$(muwi_find_node)" -v 2>/dev/null)
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
      *'"SessionStart"'* | *'"SubagentStart"'* | *'"SubagentStop"'* | *'"Skill"'* | *SKILL.md*) ;;
      *) exit 0 ;;
    esac
    ;;
esac
printf '%s' "$payload" | "$ROOT/bin/muwi" hook "$@"
exit 0
