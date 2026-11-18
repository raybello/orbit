# Platform helpers for the dev scripts. Source it:  . "$(dirname "$0")/lib/platform.sh"
#
# The scripts were written on macOS (pgrep, lsof, ~/Library/Application Support). These helpers give
# them one vocabulary that also works in Git Bash on Windows, where neither pgrep nor lsof exists and
# Electron keeps its profile in %APPDATA%.

orbit_os() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo mac ;;
    MINGW*|MSYS*|CYGWIN*) echo win ;;
    *) echo linux ;;
  esac
}
ORBIT_OS="$(orbit_os)"

# Electron's userData for app.setName('Orbit'), the folder the desktop app stages its stack in.
orbit_user_data_default() {
  case "$ORBIT_OS" in
    mac) echo "$HOME/Library/Application Support/Orbit" ;;
    win) echo "$(cygpath -u "${APPDATA:-$USERPROFILE/AppData/Roaming}" 2>/dev/null || echo "$APPDATA")/Orbit" ;;
    *) echo "${XDG_CONFIG_HOME:-$HOME/.config}/Orbit" ;;
  esac
}

# A command line as Windows reports it uses backslashes and C:\ paths; match either spelling.
_orbit_win_pattern() {
  local re="$1"
  # Turn /c/Users/... into C:\\Users\\... alternatives inside the regex is fragile; instead let the
  # pattern match forward or back slashes wherever it says `/`.
  printf '%s' "$re" | sed 's#/#[\\\\/]#g'
}

# PIDs whose command line matches an extended regex (pgrep -f), space separated. Finding none is
# not a failure: pgrep exits 1 then, and under `set -o pipefail` that used to end the calling
# script silently (the rebuild loop died at "3/3 electron" whenever no Orbit window was open).
orbit_pids() {
  local re="$1"
  if [ "$ORBIT_OS" = win ]; then
    local winre
    winre=$(_orbit_win_pattern "$re")
    powershell.exe -NoProfile -NonInteractive -Command \
      "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -match '$(printf '%s' "$winre" | sed "s/'/''/g")' -and \$_.ProcessId -ne \$PID } | ForEach-Object { \$_.ProcessId }" \
      2>/dev/null | tr -d '\r' | tr '\n' ' ' || true
  else
    { pgrep -f "$re" 2>/dev/null || true; } | tr '\n' ' '
  fi
}

# Ask processes to stop (SIGTERM / taskkill without /F).
orbit_kill() {
  [ -z "${*// /}" ] && return 0
  if [ "$ORBIT_OS" = win ]; then
    local p
    for p in $*; do taskkill.exe //PID "$p" //T >/dev/null 2>&1 || true; done
  else
    # shellcheck disable=SC2086
    kill -TERM $* 2>/dev/null || true
  fi
}

orbit_alive() {
  if [ "$ORBIT_OS" = win ]; then
    tasklist.exe //FI "PID eq $1" //NH 2>/dev/null | grep -q " $1 "
  else
    kill -0 "$1" 2>/dev/null
  fi
}

# Wait up to ~5 s for pids to exit, then force them.
orbit_reap() {
  local pids="$1" p left
  [ -z "${pids// /}" ] && return 0
  for _ in $(seq 1 25); do
    left=""
    for p in $pids; do orbit_alive "$p" && left="$left $p"; done
    [ -z "$left" ] && return 0
    sleep 0.2
  done
  for p in $pids; do
    if [ "$ORBIT_OS" = win ]; then taskkill.exe //PID "$p" //T //F >/dev/null 2>&1 || true
    else kill -9 "$p" 2>/dev/null || true; fi
  done
}

# The dev Electron and the installed app, as command-line regexes for this platform.
orbit_window_pattern() {
  case "$ORBIT_OS" in
    mac) echo 'node_modules/electron/dist/Electron\.app/Contents/MacOS/Electron|/Orbit\.app/Contents/MacOS/Orbit' ;;
    win) echo 'node_modules/electron/dist/electron\.exe|/Orbit/Orbit\.exe' ;;
    *) echo 'node_modules/electron/dist/electron( |$)|/orbit( |$)' ;;
  esac
}
orbit_dev_window_pattern() {
  case "$ORBIT_OS" in
    mac) echo 'node_modules/electron/dist/Electron\.app/Contents/MacOS/Electron' ;;
    win) echo 'node_modules/electron/dist/electron\.exe' ;;
    *) echo 'node_modules/electron/dist/electron( |$)' ;;
  esac
}
