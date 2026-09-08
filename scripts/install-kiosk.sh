#!/bin/bash
set -euo pipefail

usage() {
  echo 'Usage: sudo bash scripts/install-kiosk.sh --user USER'
}
if [[ ${1-} != --user || $# != 2 ]]; then
  usage
  exit 1
fi
if [[ $(uname -s) != Linux || $EUID != 0 ]]; then
  echo 'Run this installer as root on Debian 13.' >&2
  exit 1
fi
# Read the distribution's own release metadata.
source /etc/os-release
if [[ $ID != debian || ${VERSION_ID%%.*} != 13 ]]; then
  echo 'This installer supports Debian 13.' >&2
  exit 1
fi

kiosk_user=$2
if [[ ! $kiosk_user =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || ! id "$kiosk_user" >/dev/null 2>&1; then
  echo 'Specify an existing local user.' >&2
  exit 1
fi
if [[ $(id -u "$kiosk_user") == 0 ]]; then
  echo 'The kiosk must run as a non-root user.' >&2
  exit 1
fi
IFS=: read -r _ _ _ _ _ kiosk_home kiosk_shell < <(getent passwd "$kiosk_user")
if [[ ${kiosk_shell##*/} != bash ]]; then
  echo 'The kiosk user must use Bash as their login shell.' >&2
  exit 1
fi
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ! -f $project_dir/package-lock.json ]]; then
  echo 'package-lock.json is missing from the project.' >&2
  exit 1
fi
if ! runuser -u "$kiosk_user" -- test -w "$project_dir"; then
  echo "The project directory must be writable by $kiosk_user: $project_dir" >&2
  exit 1
fi

# Configuration only: dependencies must already be installed.
for required_command in startx xauth xset dbus-run-session python3 ldd agetty systemctl; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing command: $required_command. Install the prerequisites listed in README.md." >&2
    exit 1
  fi
done

# Do not enable boot startup until Electron and its shared libraries are available.
electron="$project_dir/node_modules/electron/dist/electron"
if [[ ! -x $electron ]]; then
  echo 'Electron is missing. Run npm ci --include=dev --engine-strict and node node_modules/electron/install.js as the kiosk user first.' >&2
  exit 1
fi
missing_libraries=$(ldd "$electron" | awk '/not found/ { print $1 }')
if [[ -n $missing_libraries ]]; then
  echo "Missing shared libraries: $missing_libraries" >&2
  exit 1
fi

chmod +x "$project_dir/scripts/kiosk-session.sh"

install -d -o "$kiosk_user" -g "$(id -gn "$kiosk_user")" \
  "$kiosk_home/.local/bin" "$kiosk_home/.local/state/pool-clock"
launcher="$kiosk_home/.local/bin/pool-clock-start"
{
  echo '#!/bin/bash'
  echo 'set -eu'
  printf 'session=%q\n' "$project_dir/scripts/kiosk-session.sh"
  echo 'state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/pool-clock"'
  echo 'mkdir -p "$state_dir"'
  echo 'exec startx "$session" -- :0 vt1 -nolisten tcp > "$state_dir/xorg.log" 2>&1'
} > "$launcher"
chown "$kiosk_user:$(id -gn "$kiosk_user")" "$launcher"
chmod 755 "$launcher"

# Maintain one managed block and preserve the user's existing login setup.
runuser -u "$kiosk_user" -- env HOME="$kiosk_home" python3 - <<'PY'
import os
from pathlib import Path

home = Path.home()
profile = next((home / name for name in ('.bash_profile', '.bash_login', '.profile')
                if (home / name).is_file()), home / '.profile')
start = '# BEGIN POOL CLOCK KIOSK'
end = '# END POOL CLOCK KIOSK'
text = profile.read_text() if profile.exists() else ''
backup = profile.with_name(profile.name + '.pool-clock.bak')
if profile.exists() and not backup.exists():
    backup.write_text(text)
if start in text:
    before, rest = text.split(start, 1)
    if end not in rest:
        raise SystemExit('Incomplete existing kiosk block in login profile.')
    text = before + rest.split(end, 1)[1]
block = '''# BEGIN POOL CLOCK KIOSK
if [ -z "${DISPLAY:-}" ] && [ -z "${SSH_CONNECTION:-}" ] && [ "$(tty)" = /dev/tty1 ]; then
  exec "$HOME/.local/bin/pool-clock-start"
fi
# END POOL CLOCK KIOSK
'''
profile.write_text(text.rstrip() + '\n\n' + block)
print(f'Updated {profile}')
PY

dropin=/etc/systemd/system/getty@tty1.service.d
mkdir -p "$dropin"
if [[ -f $dropin/pool-clock.conf && ! -f $dropin/pool-clock.conf.bak ]]; then
  cp -p "$dropin/pool-clock.conf" "$dropin/pool-clock.conf.bak"
fi
agetty_path=$(command -v agetty)
cat > "$dropin/pool-clock.conf" <<UNIT
[Service]
ExecStart=
ExecStart=-$agetty_path --autologin $kiosk_user --noclear %I \$TERM
UNIT
systemctl daemon-reload
systemctl enable getty@tty1.service

echo "Kiosk installed for $kiosk_user. Reboot to start it on the local screen."
echo 'The local tty1 console will log in automatically; SSH authentication is unchanged.'
echo "Logs: $kiosk_home/.local/state/pool-clock/"
