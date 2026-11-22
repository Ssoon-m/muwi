# bin/muwi와 hooks/hook.sh가 읽는다. muwi_find_node는 muwi를 실행할 Node(24 이상)의 경로를 출력한다.
# Herdr가 띄우는 세션이나 그래프 칸은 셸 설정(~/.zshrc)을 읽지 않아서, nvm처럼 셸 설정으로 고르는 Node가 PATH에 없다.
# 그래서 PATH 다음으로 버전 관리 도구의 기본 버전을 파일에서 직접 찾는다. nvm.sh는 실행하지 않는다 (느리다).
# 찾는 순서:
#   1. PATH의 node
#   2. nvm의 기본 버전 ($NVM_DIR/alias/default). nvm alias default를 바꾸면 따라간다
#   3. volta, fnm, mise, asdf, Homebrew, 시스템 Node
#   4. muwi setup을 실행한 Node ($MUWI_SETUP_NODE, ~/.local/bin/muwi가 넘긴다)
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

# nvm에 설치된 버전 중 앞부분이 $2와 맞는 것 ($2가 비면 모두). "v"를 뗀 숫자로 출력한다
muwi_nvm_versions() {
  for _d in "$1"/versions/node/v*; do
    [ -d "$_d" ] || continue
    _d=${_d##*/v}
    case "$2" in
      '') echo "$_d" ;;
      *) case "$_d" in "$2" | "$2".*) echo "$_d" ;; esac ;;
    esac
  done
}

# nvm의 별칭(default, lts/*, node, 24, v24.21.0 …)을 설치된 버전 폴더로 바꾼다
muwi_nvm_node() {
  _nvm=${NVM_DIR:-$HOME/.nvm}
  [ -d "$_nvm/versions/node" ] || return 1
  _want=default
  _hops=0
  # 별칭이 다른 별칭을 가리킬 수 있다 (default → lts/* → lts/jod → v22.…)
  while [ -f "$_nvm/alias/$_want" ] && [ "$_hops" -lt 5 ]; do
    _want=$(sed -n '1p' "$_nvm/alias/$_want" | tr -d '[:space:]')
    _hops=$((_hops + 1))
  done
  _want=${_want#v}
  case "$_want" in
    node | stable | default) _want='' ;;
    *[!0-9.]*) return 1 ;;
  esac
  # 앞부분이 맞는 버전 중 가장 높은 것 (24 → v24.21.0, 24.21.0 → v24.21.0)
  _ver=$(muwi_nvm_versions "$_nvm" "$_want" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$_ver" ] || return 1
  echo "$_nvm/versions/node/v$_ver/bin/node"
}

muwi_find_node() {
  if muwi_node_ok node; then
    echo node
    return 0
  fi
  _n=$(muwi_nvm_node) && muwi_node_ok "$_n" && { echo "$_n"; return 0; }
  for _n in \
    "${VOLTA_HOME:-$HOME/.volta}/bin/node" \
    "${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}/aliases/default/bin/node" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    "${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims/node" \
    "${ASDF_DATA_DIR:-$HOME/.asdf}/shims/node"; do
    muwi_node_ok "$_n" && { echo "$_n"; return 0; }
  done
  # Homebrew와 시스템 Node. 테스트는 MUWI_NODE_DIRS를 비워서 이 기계의 Node를 보지 않게 한다
  for _d in ${MUWI_NODE_DIRS-/opt/homebrew/bin /usr/local/bin}; do
    muwi_node_ok "$_d/node" && { echo "$_d/node"; return 0; }
  done
  if [ -n "${MUWI_SETUP_NODE:-}" ] && muwi_node_ok "$MUWI_SETUP_NODE"; then
    echo "$MUWI_SETUP_NODE"
    return 0
  fi
  echo node
  return 1
}
