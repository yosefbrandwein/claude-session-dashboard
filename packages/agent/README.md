# @csd/agent — Device Agent / Messaging Broker

The device agent runs on a machine where Claude Code is used. It **reads** `~/.claude`
(strictly read-only), derives live session status, and publishes to Firebase so the
dashboard can show every session across all your devices in real time. It also listens
for control commands (send a message, interrupt, approve/deny) and acts on them.

```
~/.claude (READ-ONLY)                         Firebase
┌────────────────────┐   collector    ┌──────────────────────────────┐
│ sessions/<pid>.json│ ─────────────▶ │ RTDB /presence/{uid}/{dev}/…  │  (ephemeral, 5s, onDisconnect)
│ projects/…/*.jsonl │   parse+derive │ FS users/{uid}/devices/{dev}  │  (durable)
└────────────────────┘                │ FS …/sessions/{sid}           │  (durable metadata)
        ▲ live PID check              │ …/sessions/{sid}/messages     │  (metadata-only by default)
        │ tasklist / kill(0)          │ …/permissionRequests          │  (best-effort)
                                      │ users/{uid}/commands ◀────────┼── dashboard control channel
                                      └──────────────────────────────┘
```

Everything the agent publishes is mapped onto the **shared wire contract**
(`shared/src/types.ts`) — `PresenceRecord`, `SessionDoc`, `MessageDoc`,
`PermissionRequestDoc`, `CommandDoc`. The agent never redefines those shapes.

## Safety boundary

The agent **never writes anywhere under `~/.claude`**. It only reads. Its own config
lives in a separate dir, `~/.claude-dash/`. The opt-in hooks installer
(`scripts/install-hooks.mjs`) is the only thing that can edit `~/.claude/settings.json`,
and **you run it yourself** — the agent process never executes it.

## Configure credentials

The agent authenticates **as a real user** (email/password) via the client `firebase`
SDK, so it's subject to the same Security Rules as the dashboard. Provide creds via
either:

1. **Env vars**: `CSD_EMAIL` + `CSD_PASSWORD`.
2. **Config file** `~/.claude-dash/config.json` (this dir is the agent's own — NOT `~/.claude`):

   ```json
   { "email": "you@example.com", "password": "…", "captureContent": false }
   ```

Other env knobs:

| Var | Default | Meaning |
|---|---|---|
| `USE_FIREBASE_EMULATORS` | unset | `1` → connect to the local Emulator Suite |
| `CSD_PRESENCE_INTERVAL_MS` | `5000` | presence/metadata tick interval |
| `CSD_CAPTURE_CONTENT` | `0` | `1` → include raw message `text` (default OFF: metadata only) |
| `CSD_CONFIG_DIR` | `~/.claude-dash` | override the agent config dir |
| `CLAUDE_HOME` | `~/.claude` | override the Claude tree (used by the read-only dry-run / hook installer tests) |

## Install & run

Dependencies are installed **inside this package only** (`firebase` is shared from the
repo-root hoist; `tsx`/`typescript` are local dev deps). Do not run `npm install` at the
repo root.

```bash
# from packages/agent/
npm install --no-workspaces --no-save tsx   # local runner (firebase resolves from root)

# read-only proof — prints derived sessions/status from real ~/.claude, uploads NOTHING:
npx tsx src/dryRun.ts

# unit tests (no emulator, no real ~/.claude — fixtures only):
npm test

# run the agent against the local emulator:
USE_FIREBASE_EMULATORS=1 CSD_EMAIL=demo@demo.dev CSD_PASSWORD=demo123 npx tsx src/index.ts
```

## How status is derived (and its limits **without** hooks)

Per tick the collector:

1. Parses every `~/.claude/sessions/<pid>.json` (one file per running claude PID).
2. Checks PID liveness (Windows: `tasklist`; POSIX: `kill(pid, 0)`).
3. Locates the transcript `projects/<hash>/<sessionId>.jsonl` and reads its line count +
   newest entry timestamp.
4. Derives `SessionStatus`:
   - **stale** — file present but PID dead.
   - **working** — PID alive **and** transcript appended within the last ~10s.
   - **idle** — PID alive but transcript quiet.

**Honest limitation:** without the opt-in hooks, the agent cannot distinguish
`awaiting-input` / `needs-attention` from `idle` — those are precise hook signals. A
quiet-but-alive session is reported as `idle`. Likewise, an **accepted** permission
prompt leaves no distinct transcript marker (it looks like a normal `tool_use →
tool_result`); only a **denied/blocked** tool use is detectable, via a `tool_result`
with `is_error:true` whose text matches a known rejection phrase. So transcript-only
permission capture sees denials, not pending prompts. Install the hooks for precise
capture.

### Metadata parser scope

`MessageDoc`s are **metadata-only by default**: role, kind, tool-call names with a short
non-sensitive input summary, and a short summary line. Raw assistant text and
chain-of-thought are **never** stored unless `captureContent` is explicitly enabled. Tool
inputs are summarized to a single descriptive field (e.g. `Bash` → its `description`,
`Read` → `file_path`) and truncated to 80 chars.

## Opt-in hooks — **you run this, the agent never does**

For precise status + permission signals, install hooks into your own
`~/.claude/settings.json`. This is optional; the agent works without it.

```bash
# preview only (changes nothing):
node scripts/install-hooks.mjs

# install (backs up settings.json first, preserves your existing hooks):
node scripts/install-hooks.mjs --yes

# remove ONLY the hooks this script added:
node scripts/install-hooks.mjs --uninstall --yes

# try it safely against a copy first:
CLAUDE_HOME=/tmp/claude-copy node scripts/install-hooks.mjs --yes
```

The installer is guarded: it does nothing without `--yes`, always writes a timestamped
`settings.json.bak.<ts>` before editing, tags every block it adds (`_csd: "csd-agent"`)
so uninstall removes only its own, and **preserves any hooks you already had**. The hook
snippet it merges is in `scripts/hooks.config.example.json`; each hook appends a line to
`~/.claude-dash/hook-events.jsonl` (the agent's own dir), which the agent can tail for
exact `SessionStart`/`UserPromptSubmit`/`Stop`/`Notification`/`PreToolUse` events.

> The agent's autonomous status/permission capture works via transcript parsing with **no
> hooks installed**. Hooks only sharpen it.

## Messaging injection — Tier A and Tier B

### Tier A (implemented, the guaranteed fallback)

`sendMessage` runs a **headless** Claude turn that resumes the target session:

```
claude --print --resume <sessionId> --output-format stream-json --verbose [--model …] "<text>"
```

(Flags verified against `claude --help`.) The agent streams the `stream-json` events back
and writes the assistant output as `MessageDoc`s under the session. `interrupt` kills the
run; `approve`/`deny` records the decision. This forks a fresh headless turn on the same
conversation history — it does **not** type into your live interactive window.

### Tier B (investigated — **not feasible on this machine**; falls back to Tier A)

Goal: inject directly into an already-open interactive desktop session via the local
named-pipe daemon (`~/.claude/daemon`, `peerProtocol:1`). What the read-only probe
(`src/messaging/tierB-daemon.ts`) found here:

- `daemon/pipe.key` exists, **16 bytes** (matches the documented key size).
- `daemon/roster.json` → `{ "proto": 1, "supervisorPid": 12444, "workers": {} }` — the
  **workers map is empty** (no live session workers registered).
- `daemon/dispatch/` and `daemon/pty-pids/` are **empty**.
- `daemon.log` shows the supervisor is **transient**: it spawns on demand and logs
  `idle 5s with no clients — exiting`. (The `supervisorPid` in roster can therefore be a
  stale PID later reused by an unrelated process — `kill(pid,0)` only proves *a* process
  exists, not that it's the daemon.)
- Enumerating `\\.\pipe\*` for claude pipes returns exactly **one**:
  `claude-mcp-browser-bridge-<user>` — an **MCP browser bridge**, not a
  session-injection / peer/dispatch channel.

**Verdict: Tier B injection is not feasible here without reverse-engineering the
undocumented `peerProtocol:1` wire framing _and_ persisting changes to Claude's config
(both out of scope / disallowed by the safety boundary).** There is no open peer/dispatch
pipe to write to, and the daemon isn't even running a worker for the live sessions. The
dispatcher still *probes* for a peer/dispatch pipe on every `sendMessage`; if a genuine
one is ever found, that's where the write would be wired. Until then it cleanly falls
through to Tier A. The probe never writes to the pipe or alters config.

## File tree

```
packages/agent/
├── package.json
├── tsconfig.json
├── README.md
├── scripts/
│   ├── install-hooks.mjs          # OPT-IN, user-run; backs up + uninstall + tagged
│   └── hooks.config.example.json  # the hook snippet it merges
├── src/
│   ├── index.ts                   # entrypoint: presence loop + metadata + command listener
│   ├── config.ts                  # creds/config from env or ~/.claude-dash
│   ├── device.ts                  # stable deviceId (hostname hash) + git branch
│   ├── dryRun.ts                  # read-only proof against real ~/.claude
│   ├── publish.ts                 # Firebase writes (presence + durable metadata)
│   ├── commands.ts                # command listener + dispatcher
│   ├── collector/
│   │   ├── rawTypes.ts            # on-disk ~/.claude shapes (internal)
│   │   ├── parse.ts               # PURE logic (unit-tested)
│   │   ├── io.ts                  # filesystem + PID liveness shell
│   │   └── collect.ts            # orchestrator → shared wire shapes
│   └── messaging/
│       ├── tierA-cli.ts           # headless CLI injection (implemented)
│       └── tierB-daemon.ts        # daemon/pipe probe (read-only investigation)
└── test/
    ├── parse.test.ts              # pure-logic unit tests
    ├── io.test.ts                 # io+collector vs fixtures (CLAUDE_HOME override)
    ├── tierA.test.ts              # messaging arg-building + stream parsing
    └── fixtures/                  # sample sessions/*.json + transcript *.jsonl + fake-claude.mjs
```
