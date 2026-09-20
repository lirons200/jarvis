# Running the JARVIS bridge on a Linux server

> **WARNING: automatic re-arming.** Both `restart: unless-stopped` (Docker) and `Restart=always` (systemd) restart the bridge after a crash, a reboot or a Docker daemon restart. If `/etc/jarvis/bridge.env` contains `JARVIS_TRADING_ENABLED=true` and `JARVIS_TRADING_ARM=true`, **trading re-arms itself every time, with nobody watching**. The "arm at every boot" safeguard only helps if the env file does not say `ARM=true`. Keep `JARVIS_TRADING_ARM` out of the env file whenever you are not actively watching the bridge, and add it only for a supervised session (then recreate the container / restart the unit). The env template below is safe by default: trading disabled, ARM unset.

What runs where:

- **Server (24/7):** the bridge (`bridge/server.mjs`): OANDA forex polling, trading automation (only if deliberately enabled) and Telegram remote control.
- **Your PC:** the Vite frontend, the voice/hologram UI, microphone and speakers. It is not deployed. It connects to the server's bridge through an SSH tunnel (below) when you want it.

Nothing here is deployed by the repo. These are files for you to copy over yourself.

## Prerequisites

- Docker + compose plugin (recommended), or Node 20+ (24 recommended) for the systemd route.
- An unprivileged user to run it. Do not run as root.
- Nothing else on host port 8787 (change `JARVIS_BRIDGE_PORT` and the compose port mapping together if needed).

## 1. Copy the code

From your PC (excluding secrets and junk):

```
rsync -av --exclude node_modules --exclude .git --exclude 'bridge/data' --exclude '.env*' --exclude '*.local' ./ user@server:/opt/jarvis/
```

Or `git clone` on the server. Never copy `.env.local` from your PC.

## 2. Create the server-side env file

Create `/etc/jarvis/bridge.env` by hand on the server, `chmod 600`, owned by root (Docker reads it as root; for systemd make it readable by the service user or let root-owned systemd read it, since `EnvironmentFile` is read by systemd itself). It is outside the repo on purpose.

Start with **practice mode, trading disabled**:

```
JARVIS_OANDA_ENV=practice
JARVIS_OANDA_API_KEY=<your practice key>
JARVIS_OANDA_ACCOUNT_ID=<your practice account id>
JARVIS_FOREX_PAIRS=EUR_USD,GBP_USD
JARVIS_FOREX_POLL_INTERVAL_MS=5000

JARVIS_TELEGRAM_BOT_TOKEN=<token>
JARVIS_TELEGRAM_CHAT_ID=<your chat id>

# Trading stays OFF until you deliberately turn it on (step 5).
JARVIS_TRADING_ENABLED=false
```

Variables the bridge reads (from the sources; `.env.example` lists only the general ones):

| Group | Variables |
|---|---|
| Bridge | `JARVIS_BRIDGE_PORT` (8787), `JARVIS_BRIDGE_HOST` (127.0.0.1; the container sets 0.0.0.0), `JARVIS_MODEL`, `JARVIS_EFFORT`, `JARVIS_ALLOW_WRITES`, `JARVIS_ALLOWED_ORIGINS`, `JARVIS_ALLOW_NO_ORIGIN`, `JARVIS_FILE_ROOTS`, `JARVIS_VOICE_ID`, `ELEVENLABS_API_KEY`, `JARVIS_DEBUG` |
| Forex feed | `JARVIS_OANDA_ENV` (practice/live), `JARVIS_OANDA_ALLOW_LIVE`, `JARVIS_OANDA_API_KEY`, `JARVIS_OANDA_ACCOUNT_ID`, `JARVIS_FOREX_PAIRS`, `JARVIS_FOREX_POLL_INTERVAL_MS` |
| Trading | `JARVIS_TRADING_ENABLED`, `JARVIS_TRADING_ARM`, `JARVIS_TRADING_PAIRS`, `JARVIS_TRADING_MAX_POSITION_UNITS`, `JARVIS_TRADING_MAX_TOTAL_UNITS`, `JARVIS_TRADING_MAX_DAILY_LOSS`, `JARVIS_TRADING_ATR_STOP_MULTIPLIER`, `JARVIS_TRADING_POLL_INTERVAL_MS` |
| Telegram | `JARVIS_TELEGRAM_BOT_TOKEN`, `JARVIS_TELEGRAM_CHAT_ID` |

Docker env files take `KEY=value` lines with no quotes and no `export`. Do not add `JARVIS_TRADING_ARM` here except for a supervised session (see the warning at the top).

Note: for systemd, values in `EnvironmentFile` override the unit's `Environment=` lines, so a `JARVIS_BRIDGE_HOST` in the env file wins over the unit's `127.0.0.1`. Do not set it there to anything public.

### Claude authentication (be honest about this)

The bridge uses the Claude Agent SDK, which "authenticates off your Claude Code login" on your PC (credentials from `claude login` in your home directory). **A headless server has no such login**, and no browser to do one. Options:

- Set `ANTHROPIC_API_KEY` in the env file (pay-per-use API billing), or
- Generate a long-lived token on your PC with `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` (uses your subscription).

Verify against the current Claude Code docs before relying on either; this repo does not test it. Importantly, **forex polling, trading and the Telegram `status`/`halt` commands do not call Claude**. They work with no Claude credential at all. Only chat/voice turns coming from the UI need it, and those would run the agent (and its tools) on the server, not on your PC. Leave `JARVIS_ALLOW_WRITES` unset on the server. The SDK writes state under `$HOME/.claude` and `$HOME/.claude.json`: in Docker that is `/home/node` (container filesystem, lost on recreate), under systemd the unit sets `HOME=/var/lib/jarvis` (writable via `StateDirectory`/`ReadWritePaths`). The server also has no `~/.claude.json` with your MCP servers, so server-side agent turns lack the MCP tools you have on your PC (and the bridge's ElevenLabs-key-from-MCP-config fallback finds nothing; set `ELEVENLABS_API_KEY` explicitly if wanted).

## 3. Start it

Docker (from the repo root):

```
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f bridge
curl -s http://127.0.0.1:8787/health
```

`/health` returns `ok`, `ready` (false while the bridge is still booting; subsystems then read as inactive), `uptime`, `version` and booleans only (`forexFeed`, `trading.{enabled,armed,halted}` (`enabled` = env flag set, `armed` = actually armed after boot reconciliation), `telegram`, plus `tts`/`stt`). No secrets, account ids or positions.

The named volume `jarvis-data` holds `bridge/data` (trade journal `trading-journal.jsonl`, `trading-daily-state.json`). It survives `restart`, `up --build` and `down`. **`docker compose down -v` deletes it.** Back it up before you trade for real.

systemd alternative: `npm ci --omit=dev` in `/opt/jarvis`, `chown -R jarvis /opt/jarvis/bridge/data`, copy `deploy/jarvis-bridge.service` to `/etc/systemd/system/`, then `systemctl daemon-reload && systemctl enable --now jarvis-bridge`.

## 4. Do NOT expose the WebSocket publicly

The bridge's origin check only stops other *web pages* in your browser from talking to it. It is **not authentication**: any non-browser client can forge or omit an Origin header (and `JARVIS_ALLOW_NO_ORIGIN=1` allows none at all). Whoever reaches the port can drive the agent, read `/file`, and use the trading tools. Hence:

- Compose binds `127.0.0.1:8787` on the host; the bridge inside the container listens on 0.0.0.0 only so that mapping works. Do not change the mapping to `8787:8787`, and check your firewall / Docker's iptables handling.
- To use the UI from your PC, tunnel: `ssh -N -L 8787:127.0.0.1:8787 user@server`, then run the frontend locally as usual (`ws://localhost:8787`). Origin `http://localhost:5173` is already allowed.
- If you insist on a reverse proxy, it must terminate TLS **and** require authentication (basic auth, mTLS, or an SSO proxy) in front of both HTTP and the WebSocket upgrade.

## 5. Practice first, then trading

1. Run for a few days with `JARVIS_TRADING_ENABLED=false`; confirm `/health` shows `forexFeed: true`, `telegram: true`.
2. To try automation, keep `JARVIS_OANDA_ENV=practice`, set `JARVIS_TRADING_ENABLED=true`, `JARVIS_TRADING_ARM=true` and all the risk limits (trading refuses to start if any is missing). `ARM` is required at every boot by design; a restart without it comes up disarmed. Note `restart: unless-stopped` will re-arm automatically if the env file says so.
3. Going live needs `JARVIS_OANDA_ENV=live` **and** `JARVIS_OANDA_ALLOW_LIVE=true`. Do that only after practice results you trust.

Restart after editing the env file: `docker compose -f deploy/docker-compose.yml up -d --force-recreate`.

## 6. Stop / halt

- **Halt trading only:** send `halt` to the Telegram bot (existing positions keep their stop-losses), or ask JARVIS in the UI. `/health` then shows `trading.halted: true`.
- **Disarm permanently:** remove `JARVIS_TRADING_ARM` (or set `JARVIS_TRADING_ENABLED=false`) and recreate the container.
- **Stop everything:** `docker compose -f deploy/docker-compose.yml stop` (or `systemctl stop jarvis-bridge`). Open OANDA positions stay open with their stops at the broker.

## Telegram: only one poller per bot token

Telegram allows one `getUpdates` long-poll consumer per bot token. If your PC bridge and the server bridge both have the token, they fight (409 Conflict) and each misses commands. **When the server runs, remove `JARVIS_TELEGRAM_BOT_TOKEN`/`CHAT_ID` from your PC's `.env.local`** (or use a second bot for the PC). Same idea for trading: never arm trading on both machines against the same OANDA account.

## Known limits

- Docker image is larger than necessary: the lockfile is shared with the frontend, so `npm ci --omit=dev` installs its runtime deps too.
- Not validated by building here (no Docker on the dev machine); build it once on the server and watch the logs.
