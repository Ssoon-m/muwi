# bin/muwi와 hooks/hook.sh가 읽는다. muwi_find_node는 muwi를 실행할 Node(24 이상)의 경로를 출력한다.
#
# 멀티플렉서가 띄우는 세션이나 보기(그래프 칸)는 셸 설정(~/.zshrc 같은)을 읽지 않아서, nvm·mise처럼 셸 설정으로 고르는
# Node가 PATH에 없다. 그래서 VS Code처럼 사용자의 로그인 셸을 한 번 띄워 그 셸의 PATH에서 Node를 찾는다.
# 셸을 띄우는 데 1초쯤 걸리므로 찾은 경로를 캐시에 적어 두고 다음부터는 그걸 쓴다.
#
# 찾는 순서:
#   1. PATH의 node (터미널에서 실행하면 여기서 끝난다)
#   2. 캐시에 적어 둔 경로 (${XDG_CACHE_HOME:-~/.cache}/muwi/node)
#   3. 로그인 셸($SHELL -ilc)의 PATH. 찾으면 캐시에 적는다
#   4. muwi setup을 실행한 Node ($MUWI_SETUP_NODE, ~/.local/bin/muwi가 넘긴다)
#
# 캐시는 그 경로가 없어지거나 24보다 낮아지면, 그리고 muwi setup을 다시 실행하면 버린다.
# 셸에서도 못 찾으면 그 사실을 캐시에 적고 1시간 동안 다시 묻지 않는다 (훅마다 셸을 띄우지 않게).
# 24 이상을 못 찾으면 PATH의 node(없으면 "node")를 출력한다. 부른 쪽이 무엇이 필요한지 알린다.

muwi_node_major() {
  _v=$("$1" -v 2>/dev/null)
  _v=${_v#v}
  _v=${_v%%.*}
  case "$_v" in '' | *[!0-9]*) _v=0 ;; esac
  echo "$_v"
}

muwi_node_ok() {
  case "$1" in
    */*) [ -x "$1" ] || return 1 ;;
    *) command -v "$1" >/dev/null 2>&1 || return 1 ;;
  esac
  [ "$(muwi_node_major "$1")" -ge 24 ]
}

# 로그인 셸을 띄워 그 셸의 PATH를 받고, 그 PATH에서 node를 찾는다.
# 셸이 인사말이나 프롬프트를 찍을 수 있어서 표시 문자열 사이의 값만 꺼낸다.
# 셸 설정이 입력을 기다리거나 오래 걸리면 MUWI_SHELL_TIMEOUT초(기본 10) 뒤에 멈춘다.
muwi_shell_node() {
  [ -n "${SHELL:-}" ] && [ -x "$SHELL" ] || return 1
  _out=$(mktemp "${TMPDIR:-/tmp}/muwi-shell.XXXXXX") || return 1
  "$SHELL" -ilc 'printf "\n__muwi_path__%s__muwi_end__\n" "$PATH"' </dev/null >"$_out" 2>/dev/null &
  _pid=$!
  _left=$((${MUWI_SHELL_TIMEOUT:-10} * 10))
  while kill -0 "$_pid" 2>/dev/null; do
    if [ "$_left" -le 0 ]; then
      kill "$_pid" 2>/dev/null
      sleep 0.1
      kill -9 "$_pid" 2>/dev/null
      break
    fi
    sleep 0.1
    _left=$((_left - 1))
  done
  wait "$_pid" 2>/dev/null
  _path=$(sed -n 's/.*__muwi_path__\(.*\)__muwi_end__.*/\1/p' "$_out" | tail -n 1)
  rm -f "$_out"
  [ -n "$_path" ] || return 1
  _n=$(PATH=$_path command -v node 2>/dev/null) || return 1
  case "$_n" in /*) echo "$_n" ;; *) return 1 ;; esac
}

muwi_find_node() {
  if muwi_node_ok node; then
    echo node
    return 0
  fi
  _cache=${XDG_CACHE_HOME:-$HOME/.cache}/muwi/node
  _skip=
  if [ -f "$_cache" ]; then
    _n=$(sed -n '1p' "$_cache")
    if [ "$_n" = none ]; then
      # 1시간 안에 셸에서도 못 찾았다. 다시 묻지 않는다
      [ -n "$(find "$_cache" -mmin -60 2>/dev/null)" ] && _skip=1
    elif muwi_node_ok "$_n"; then
      echo "$_n"
      return 0
    fi
  fi
  if [ -z "$_skip" ]; then
    mkdir -p "${_cache%/*}" 2>/dev/null
    if _n=$(muwi_shell_node) && muwi_node_ok "$_n"; then
      printf '%s\n' "$_n" >"$_cache" 2>/dev/null
      echo "$_n"
      return 0
    fi
    echo none >"$_cache" 2>/dev/null
  fi
  if [ -n "${MUWI_SETUP_NODE:-}" ] && muwi_node_ok "$MUWI_SETUP_NODE"; then
    echo "$MUWI_SETUP_NODE"
    return 0
  fi
  echo node
  return 1
}
