# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20.12 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Copy `.env.example` to `.env.local` and
uncomment what you want. The bridge loads `.env.local` itself at startup (Node
20.12+; a variable already set in your shell wins) and Vite reads its `VITE_*`
values from the same file. `.env.example` documents every bridge variable with
its default; never commit real keys.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `high` | Reasoning effort |
| `JARVIS_BRIDGE_HOST` | `127.0.0.1` | Address the bridge binds to. The container deploy sets `0.0.0.0` behind a loopback-only port mapping; never expose it publicly. |
| `JARVIS_DEBUG` | off | `1` logs every agent message type |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George) | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |
| `JARVIS_OANDA_API_KEY` | — | OANDA personal access token. Unset disables the forex feed entirely. |
| `JARVIS_OANDA_ACCOUNT_ID` | — | OANDA account id. Unset disables the forex feed entirely. |
| `JARVIS_OANDA_ENV` | `practice` | `practice` or `live`. `live` also requires `JARVIS_OANDA_ALLOW_LIVE=true`. |
| `JARVIS_OANDA_ALLOW_LIVE` | unset | Must be `true` for `JARVIS_OANDA_ENV=live` to start — a safety rail against accidentally polling a real-money account. |
| `JARVIS_FOREX_PAIRS` | `EUR_USD,GBP_USD,USD_JPY` | Comma-separated OANDA instrument names to poll. |
| `JARVIS_FOREX_POLL_INTERVAL_MS` | `10000` | Poll interval, clamped to 2000-60000ms. |
| `JARVIS_TRADING_ENABLED` | unset | Must be `true` for the trading poller to start at all. |
| `JARVIS_TRADING_ARM` | unset | Must be `true` at every boot for trading to actually run — never persisted, a restart always comes up halted without it. |
| `JARVIS_TRADING_PAIRS` | — | Comma-separated pairs to trade, e.g. `EUR_USD,GBP_USD`. Required if trading is enabled. |
| `JARVIS_TRADING_MAX_POSITION_UNITS` | — | Hard cap on units per trade. Required. |
| `JARVIS_TRADING_MAX_TOTAL_UNITS` | — | Hard cap on summed units across all open positions. Required. |
| `JARVIS_TRADING_MAX_DAILY_LOSS` | — | Account-currency loss amount that halts trading for the rest of the day. Required. |
| `JARVIS_TRADING_ATR_STOP_MULTIPLIER` | — | Stop-loss distance as a multiple of the 14-period ATR. Required. |
| `JARVIS_TRADING_POLL_INTERVAL_MS` | — | How often the trading loop sweeps all pairs. Required. |
| `JARVIS_TELEGRAM_BOT_TOKEN` | unset | Telegram bot token from @BotFather. Unset disables the Telegram bot entirely. |
| `JARVIS_TELEGRAM_CHAT_ID` | unset | The one chat id the bot will respond to — messages from any other chat are silently ignored. |

### Backtesting

Test a strategy against a year of OANDA daily history, either by voice
("backtest EUR/USD") or from the command line. Three strategies are available
through the `strategy` parameter (`--strategy=` on the CLI): `ma_crossover`
(default), `rsi_mean_reversion` and `donchian_breakout`. P&L is reported in USD
(a USD account is assumed), with non-USD quote currencies converted correctly.

```bash
npm run backtest -- EUR_USD          # defaults: 10/30-day MA, 252 candles
npm run backtest -- GBP_USD 5 20 500 # fastPeriod slowPeriod count
npm run backtest -- USD_JPY --strategy=rsi_mean_reversion --rsi_period=14 --oversold=30 --exit_level=50
npm run backtest -- EUR_USD --strategy=donchian_breakout --entry_period=20 --exit_period=10 --count=500
```

Any strategy parameter can be passed as `--key=value` (lowercase name,
`--count=` sets the candle count); malformed options are rejected rather than
ignored. Backtest-only: live trading stays MA-crossover. Needs the same
`JARVIS_OANDA_API_KEY`/`JARVIS_OANDA_ACCOUNT_ID` as the forex feed. Results are
not saved anywhere — each run is independent.

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

### ⚠️ Autonomous trading

Phase 4 lets JARVIS place real OANDA orders on its own, using the same
moving-average-crossover strategy as backtesting. This is off by default
and stays off unless you explicitly set both switches, plus the OANDA
credentials and every risk limit (see `.env.example`; trading refuses to start
if one is missing). It runs on the practice account by default:

```bash
JARVIS_TRADING_ENABLED=true
JARVIS_TRADING_ARM=true          # required at EVERY boot — never persisted
```

JARVIS's trading is **account-wide**: its position close (it closes ALL long
units on a pair via the positions endpoint), its exposure cap and its
daily-loss halt operate on the entire OANDA account, not just the trades JARVIS
opened. Never arm it on an account that another bot or you also trade; use a
dedicated OANDA (sub-)account. Many OANDA accounts are netting (hedging
disabled), where one system's opposite order can reduce or close the other's
trade — separation by account is the only safe arrangement. As a guard, at boot
JARVIS refuses to arm when the account holds open trades it did not open (per its
trade journal, or if that is unreadable), or when OANDA can't be queried; setting
`JARVIS_TRADING_SHARED_ACCOUNT_ACK=true` overrides it at your own risk.

Real money needs two more, both together: `JARVIS_OANDA_ENV=live` and
`JARVIS_OANDA_ALLOW_LIVE=true`.

Say "Jarvis, stop trading" at any time — `trading_halt` is always available
and stops the loop as soon as the current pair being evaluated finishes — no
new pairs are started, and no new entries are ever placed — regardless of any
other permission setting. Existing positions keep their stop-losses either
way; halting mainly stops new entries, but it can also happen automatically
mid-entry if a filled order's stop-loss can't be confirmed, in which case the
bot closes that position immediately as part of halting.

The strategy trades on **daily candles** by design, so
`JARVIS_TRADING_POLL_INTERVAL_MS` controls how often the bot re-checks for a
new daily signal, not how often it makes trading decisions on shorter
timeframes — a short poll interval does not create more trades.

Resuming after a halt requires restarting the bridge with
`JARVIS_TRADING_ARM=true` set again — there is no in-conversation resume,
by design.

When trading is enabled, a read-only **trading panel** appears in the HUD
(open positions, stop-loss status, today's P&L against the loss limit, recent
journal). It has no controls and goes visibly stale if the bridge stops
answering. It reads `GET /trading/status`, which serves the same snapshot.

To run the bridge 24/7 on a server (Docker or systemd, plus `GET /health`),
see [`deploy/README.md`](deploy/README.md). Read its warning first: an
auto-restarting service re-arms trading if `JARVIS_TRADING_ARM=true` is in its
env file.

**Test against the OANDA practice account first, extensively, before ever
setting `JARVIS_OANDA_ALLOW_LIVE=true` here.** See
`docs/superpowers/specs/2026-09-14-forex-trading-design.md` for the full
safety design.

### Telegram remote control

Monitor and control autonomous trading from Telegram — get trade
announcements as messages, message the bot `status` or `halt`, or just chat
with it in plain text from anywhere.

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`,
   follow the prompts — you'll get a bot token.
2. Message your new bot anything, then visit
   `https://api.telegram.org/bot<your-token>/getUpdates` in a browser to find
   your numeric chat id in the response.
3. Set both env vars:

```bash
JARVIS_TELEGRAM_BOT_TOKEN=<token from BotFather>
JARVIS_TELEGRAM_CHAT_ID=<your numeric chat id>
```

Message the bot `status` or `halt` at any time. Any other text (not starting
with `/`) is answered by JARVIS in a single-turn session that is **forced
read-only**: it can look up forex prices, run backtests and report trading
status, but cannot place orders, change settings, run commands or touch files.
`halt` is the only control. Anyone else who messages the bot is silently
ignored — it only ever responds to the one configured chat. Never reuse a bot token that any other program long-polls (Telegram's
`getUpdates` allows one consumer per token): a second poller causes 409
Conflict errors and can swallow the other bot's button callbacks (approve/reject
taps). Create a separate bot via @BotFather for each program (see also
`deploy/README.md`).

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
