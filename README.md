# Tapbot (Discord.js)

A Discord bot project using slash commands and Discord Components V2-style message content. This repository includes setup helpers, command deployment, PM2 startup scripts, and restart/update workflows.

## Requirements

- Node.js **22.12.0+**
- npm
- PM2 (for `run.bat` / `restart.bat` process management on Windows)

Check your Node.js version:

- `node -v`

## Installation

1. Open the repository in your terminal (or VS Code terminal).
2. Install dependencies:
   - `npm install`
3. Run interactive configuration:
   - `npm run setup`

The setup script writes `config.json` (ignored by Git).

## Configuration values

You will be asked for:

- **Bot Token**
- **Client ID** (Discord Application ID)
- **Guild ID** (optional, recommended for faster command registration while testing)

You can find these in the Discord Developer Portal:

- **Application ID** = Client ID
- **Bot Token** under the Bot section
- **Guild ID** by enabling Developer Mode in Discord, then right-clicking your server and choosing **Copy Server ID**

## Deploy slash commands

After setup, deploy commands:

- `npm run deploy`

Behavior:

- If `guildId` is set in `config.json`, commands are registered to that guild (faster updates).
- If `guildId` is empty, commands are registered globally (propagation can take longer).

## Run the bot

### Standard run

- `npm start`

### Windows PM2 run script

Use:

- `run.bat`

What it does:

- validates `config.json`
- starts `src/bot.js` in PM2 as `tapbot`
- starts/restarts a second PM2 process `tapbot-winrt-daemon` that runs:
  - `python bridge/windows_notifications_daemon.py --host 127.0.0.1 --port 8765`
- if Python or `winrt` is missing, logs a clear warning into `logs/winrt-daemon-check.log` and keeps bot process running
- writes logs to `logs/`
- saves PM2 process state (`pm2 save`)

### Windows restart script

Use:

- `restart.bat`

What it does:

- checks whether PM2 process `tapbot` exists
- starts a new bot process if missing
- otherwise restarts the existing bot process
- checks/restarts PM2 process `tapbot-winrt-daemon` (Python WinRT daemon)
- if Python or `winrt` is missing, writes warning to `logs/winrt-daemon-check.log` and continues with bot-only restart
- saves PM2 process state (`pm2 save`)

## Update workflow

On Windows:

1. Run `update.bat` from the repository root.
2. The script updates project files from GitHub.
3. It preserves local runtime data such as `config.json` and the `data/` folder.
4. It starts the bot again through `run.bat`.

## Windows notifications command

The `/notifications read` command reads recent toast notifications from the Windows host where the bot process is running.

### Windows runtime requirements

- The bot must run on **Windows** (`win32`).
- A Python WinRT daemon must be running and reachable over localhost TCP.
- Windows notification access must be allowed for the running user session (otherwise access is denied).

### Daemon IPC configuration

Configure daemon address via environment variables (per environment / host):

- `WINRT_NOTIFICATIONS_DAEMON_HOST` (default `127.0.0.1`)
- `WINRT_NOTIFICATIONS_DAEMON_PORT` (default `8765`)

At startup, the bot performs a runtime check and logs whether the daemon endpoint is available.
If the daemon is not reachable, `/notifications read` and forwarding return `API_UNAVAILABLE` consistently instead of crashing.

### Python daemon mode

`bridge/windows_notifications_daemon.py` runs as a long-lived process, subscribes to WinRT notification-change events, and serves JSON-over-newline frames over localhost TCP for the Node bot.
Daemon načítá pouze Toast notifikace a používá WINRT enum `UserNotificationKinds` pro jejich filtrování.

Supported request frames (client -> daemon):

- `{ "id": "...", "type": "ping" }` -> `{ "id": "...", "ok": true, "type": "pong" }`
- `{ "id": "...", "type": "read_notifications" }` -> `{ "id": "...", "ok", "errorCode", "message", "notifications": [...] }`
- `{ "id": "...", "type": "subscribe_notifications" }` -> `{ "id": "...", "ok": true, "message": "Subscribed ..." }`

Push/event frames (daemon -> subscribed clients, no `id`):

- `{ "type": "notifications", "notifications": [...] }`

`notifications` entries are objects with:

- `type` (`"notification"`)
- `timestamp` (ISO-like string or `null`)
- `title` (`string | null`)
- `body` (`string | null`)
- `app` (`string | null`)

`read_notifications` remains supported for polling fallback compatibility.

#### Dependencies

- Python 3.10+
- `winrt` / PyWinRT bindings available in the Python environment

#### Run daemon manually

On the Windows host where the bot runs:

```powershell
python bridge/windows_notifications_daemon.py --host 127.0.0.1 --port 8765
```

The provided `run.bat` and `restart.bat` now manage this daemon automatically via PM2 as `tapbot-winrt-daemon` and persist it using `pm2 save`, so both bot and daemon restore after reboot (when PM2 startup integration is installed on the host).


#### PM2 verification (both processes)

After `run.bat` or `restart.bat`:

```powershell
pm2 status
```

You should see both entries:

- `tapbot`
- `tapbot-winrt-daemon`

To verify what will be restored after reboot:

```powershell
pm2 save
pm2 resurrect
pm2 status
```

If only `tapbot` is present, review daemon preflight logs:

- `logs/winrt-daemon-check.log`
- `logs/pm2-winrt-daemon-error.log`

#### Troubleshooting daemon mode

- `API_UNAVAILABLE`: daemon is down, wrong `WINRT_NOTIFICATIONS_DAEMON_HOST/PORT`, Python is missing, or WinRT Python bindings are missing.
  - Check `pm2 status` for `tapbot-winrt-daemon` state.
  - Check `logs/winrt-daemon-check.log` for preflight failures (missing `python`/`py` or missing `winrt`).
  - Check `logs/pm2-winrt-daemon-error.log` for runtime daemon errors.
  - Confirm daemon endpoint matches `WINRT_NOTIFICATIONS_DAEMON_HOST/PORT` (default `127.0.0.1:8765`).
- `ACCESS_DENIED`: Windows notification permission was not granted for the daemon process user session.
- Frequent reconnect logs: daemon is restarting or local firewall blocks localhost TCP policy.
- Empty reads with daemon running: check if Windows Action Center has notifications and that app notifications are enabled.
- Enum symbol mismatch across PyWinRT variants: daemon now falls back to numeric toast kind bit (`1`) when enum introspection or enum-valued calls fail, so daemon mode can still operate with alternate bindings.

### Example usage

- `/notifications read`

Expected behavior:

- returns a Components V2 text response with recent notifications (`title`, `body`, `app`, `timestamp`),
- returns clear errors for unsupported platform, access denied, or unavailable notification API,
- returns a clear message when no notifications are available.

## Internal command notes

- `/config ticket_visibility_sync` resynchronizes ticket channel permissions for stored clan tickets (per guild), reapplies applicant/review-role access, and updates saved `activeReviewRoleId`/`updatedAt` values.

## Data persistence and restart behavior

Bot state needed after restart is persisted in the project data layer (JSON-backed storage used by `src/persistence.js`). This allows guild-specific configuration and panels to be restored during startup.

## Troubleshooting

- If command deployment fails, verify token/client ID/guild ID in `config.json`.
- If PM2 scripts fail, open the log files in `logs/`.
- If the bot starts but slash commands do not appear, redeploy with `npm run deploy` and wait for Discord propagation (especially for global commands).
