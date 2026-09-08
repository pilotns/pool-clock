# Pool Clock

A local fullscreen Electron display with an analog clock and four sensors. All UI assets are bundled. Runtime internet access is not required: requests go only to the configured server. No requests are sent until a server and sensor items are configured.

## Run

Use Node.js 24 LTS (minimum 22.12.0). Install dependencies with `npm ci`, then run `npm start`. Electron is pinned to 44.2.0 in the package and lock files. Dependency installation requires internet access; the installed application runs locally.

## Debian 13 kiosk (Xorg, one display)

No desktop environment or window manager is required. The `--kiosk` launch option enables Electron kiosk mode and sets the initial window bounds to the primary display. Normal `npm start` remains available for desktop use.

Install Node.js 24 and npm separately before preparing the application. Required Debian packages are `xorg`, `x11-xserver-utils`, `xinit`, `xauth`, `dbus-user-session`, `dbus-x11`, `libpam-systemd`, `libgtk-3-0t64`, `libnss3`, `libgbm1`, `libasound2t64`, `fonts-liberation` and `python3`.

For user `pilotns` and checkout `/home/pilotns/pool-clock`, install application dependencies as `pilotns`, then configure startup:

```sh
cd /home/pilotns/pool-clock
npm ci --include=dev --engine-strict
node node_modules/electron/install.js
sudo bash scripts/install-kiosk.sh --user pilotns
sudo reboot
```

If sudo is unavailable, run the installer through the root account:

```sh
su -c 'bash /home/pilotns/pool-clock/scripts/install-kiosk.sh --user pilotns'
su -c reboot
```

The script only configures kiosk startup on Debian 13 for an existing non-root user with Bash. It checks required commands, the Electron executable and its shared libraries before configuring automatic local login on tty1. It does not install Node.js, npm, system packages or application dependencies, and does not access the internet. Run the two dependency commands above while online: Electron 44 must be downloaded explicitly before the kiosk goes offline. The script does not reboot automatically or change SSH authentication.

At boot, the user's login profile starts Xorg and the session script launches Electron directly on the local display. Screen blanking is disabled. If Electron exits, it restarts after five seconds. The application keeps its Chromium sandbox enabled.

The login profile receives a managed block; rerunning the installer replaces this block rather than appending duplicates. An original profile backup is kept with the `.pool-clock.bak` suffix. Avoid combining this installer with a separate manually configured `startx` block in the same login profile.

Application configuration is stored outside the checkout at `~/.config/pool-clock/settings.json` (or under `XDG_CONFIG_HOME`). Diagnostic logs are stored under `~/.local/state/pool-clock/` (or `XDG_STATE_HOME`):

```sh
tail -n 60 ~/.local/state/pool-clock/app.log
tail -n 60 ~/.local/state/pool-clock/app.previous.log
tail -n 60 ~/.local/state/pool-clock/xorg.log
```

After updating project files, restart the kiosk from SSH with `sudo systemctl restart getty@tty1.service`, or reboot. Do not run `npm start` in the SSH session to start the local kiosk.

To disable automatic kiosk launch, remove the block between `# BEGIN POOL CLOCK KIOSK` and `# END POOL CLOCK KIOSK` from the user's login profile, then remove `/etc/systemd/system/getty@tty1.service.d/pool-clock.conf` and run `sudo systemctl daemon-reload`. Other getty overrides, if present, remain in effect.

## Settings

- Click the logo to adjust sensor reading text size (16–96 px) and font weight (four fixed positions: Light, Regular, Medium, Bold) with live changes on the main display behind the settings dialog. Save keeps the size across restarts; Cancel or Escape restores the saved size. Changing only typography preserves sensor connections and readings.
- Toggle **Second pulse** in the logo settings to enable or disable the current second marker animation. The change is live, saved across restarts, and reverted by Cancel or Escape. It is enabled by default.
- In the same dialog, enter a local server address, such as `192.168.1.10`. The default port is **8080**. Explicit ports and HTTP/HTTPS URLs are supported.
- Click a sensor icon to enter its openHAB item name, such as `waterTemperature`, and select HTTP or SSE. New settings default to SSE for water and HTTP for the other sensors.
- SSE uses `/rest/events?topics=smarthome/items/{name}`. HTTP uses `/rest/items/{name}/state`. These paths are added automatically; previously saved paths of these forms are converted to item names. Switching modes preserves the name.
- A blank server disables all connections. A blank item disables that sensor.
- Settings are saved as `settings.json` in Electron's standard application data directory and take effect immediately.

## Updates and connection status

HTTP requests run at startup, when settings are applied, when the SSE numeric value changes, and as a fallback 60 seconds after the last request. The first SSE reading establishes a baseline; repeated values do not trigger HTTP requests. Each SSE-triggered request resets the fallback deadline. Changes received during an active HTTP request are combined into one follow-up request.

HTTP accepts a number, a JSON numeric string, or an object with a `value` or `state` field. SSE accepts the same data in `data:` messages, plus `ItemStateEvent` and `ItemStateChangedEvent` objects with a JSON `payload`. SSE displays a reading only after the first data event.

Failed connections retry after 5 seconds. HTTP inactivity timeout is 10 seconds; SSE inactivity timeout is 90 seconds. SSE heartbeat messages can keep an idle stream open. Timing constants are shared through `sensor-config.js`.

The logo starts gray and becomes colored after an SSE connection is accepted, before the first reading. It turns gray if any configured sensor loses its connection. Last readings remain visible without a connection error message. Invalid readings show `no data` while preserving the last valid value. Readings are cleared when settings change and are not restored after restarting the application.

## Checks

- `npm test`: value parsing, settings migration, local HTTP/SSE, retries, event-triggered updates and fallback scheduling.
- `npm run test:ui`: a hidden Electron window tests settings and connection indicators using a temporary profile, without changing application settings.
