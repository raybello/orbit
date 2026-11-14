#!/bin/sh
# The container stays up and idle. Screens (Xvfb, fluxbox, x11vnc) are started per bot by the
# server's screen manager, which also restarts them after a container start.
set -eu
# The home folder is a bind mount: on Docker Desktop/colima it can take a moment to appear, so the
# directories are retried rather than failing the whole container on the first try.
i=0
while [ "$i" -lt 50 ]; do
  if mkdir -p /home/bot/.local/share/hq/logs /home/bot/.fluxbox /tmp/.X11-unix /opt/hq 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.2
done
exec sleep infinity
