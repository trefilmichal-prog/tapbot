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
- writes logs to `logs/`
- saves PM2 process state

### Windows restart script

Use:

- `restart.bat`

What it does:

- checks whether PM2 process `tapbot` exists
- starts a new process if missing
- otherwise stops and starts the existing process
- saves PM2 process state

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
- PowerShell (`powershell.exe`) must be available in `PATH`.
- Windows notification access must be allowed for the running user session (otherwise access is denied).

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
