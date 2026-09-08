#!/bin/sh
set -eu

# xinit starts this script inside the local X11 session.
if [ "${1-}" != '--session' ]; then
  exec dbus-run-session -- "$0" --session
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/pool-clock"
mkdir -p "$state_dir"
cd "$project_dir"

xset s off || true
xset s noblank || true
xset -dpms || true

child=''
cleanup() {
  trap - TERM INT HUP
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup TERM INT HUP

while true; do
  if [ -f "$state_dir/app.log" ]; then
    mv -f "$state_dir/app.log" "$state_dir/app.previous.log"
  fi
  ./node_modules/electron/dist/electron --ozone-platform=x11 . --kiosk \
    > "$state_dir/app.log" 2>&1 &
  child=$!
  wait "$child" || true
  child=''
  sleep 5 &
  child=$!
  wait "$child" || true
  child=''
done
