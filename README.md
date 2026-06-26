# Claude Session Dashboard

A multi-device, **multi-tenant** dashboard that shows all your live Claude Code sessions
across every machine you use — grouped by **device → project**, with **live status**, start
time, elapsed, message metadata, and a permission log — and lets you **send a message** to a
session from the dashboard. Backed entirely by **Firebase free tier** (no servers, no Cloud
Functions).

```
   Device A ─┐  agent reads ~/.claude (READ-ONLY)        ┌─ Dashboard (React, Firebase Hosting)
   Device B ─┼──►  RTDB  presence (live, onDisconnect)  ◄┤   each user signs in → sees only
   Device C ─┘     Firestore  sessions/messages/perms    │   their own devices & sessions
        ▲          Firestore  commands  ◄────────────────┘   writes commands; reads live feed
        └────────  agent listens for commands, executes locally
```

- **Per-device agent** (`packages/agent`) is the only thing that touches `~/.claude`. It publishes
  presence + durable metadata and listens for commands. It never writes to `~/.claude`.
- **Dashboard** (`packages/dashboard`) is a static React app that talks **only** to Firebase.
- **Firebase IS the backend.** Security Rules (`firestore.rules`, `database.rules.json`) are the
  entire isolation layer. **No Cloud Functions** → stays on the free **Spark** plan.
- **Shared contract** (`shared/src/types.ts`) is the single source of truth wired into all three.

---

## How it works

### Live status (per session)
The agent fuses three signals every ~5s:
| Signal | Source | Gives |
|---|---|---|
| active sessions | `~/.claude/sessions/*.json` (one per running `claude` PID) | id, cwd, startedAt, version, entrypoint |
| liveness | OS process list (`tasklist`/`ps`) | active vs **stale** (PID gone) |
| activity | transcript `~/.claude/projects/<hash>/<sid>.jsonl` mtime + tail | last-activity, message count, working/idle |

Status = `working` (transcript appended recently) · `idle` (alive, quiet) · `stale` (PID gone) ·
`ended`. Presence lives in **RTDB** with `onDisconnect()` so a device that dies auto-clears (the
dashboard also greys a group whose `heartbeatAt` goes stale). Durable records + **message
metadata** + the **permission log** live in **Firestore** (metadata only — full chat text is
**opt-in**, off by default; transcript bodies and `.credentials.json` never leave the device).

### Sending a message (the control channel)
Dashboard writes a `commands` doc → the agent's listener picks it up → executes → writes back
`status`/`result` (the dashboard toasts it). Two tiers:
- **Tier A (works today):** the agent spawns a headless `claude --print --resume <sid>` turn,
  streams the reply back. ✅ Verified end-to-end against the real `claude` binary.
  ⚠️ This runs a **new headless turn on the same conversation history** — it does **not** type into
  your open desktop window.
- **Tier B (investigated, not feasible here):** injecting into the *already-open* interactive
  desktop session via the local `~/.claude/daemon` named pipe. The daemon is transient and exposes
  no peer/dispatch pipe, and `peerProtocol:1` is undocumented — so the agent honestly falls back to
  Tier A. See `packages/agent/README.md` → "Tier B findings".

### Permissions
The dashboard's **Approve/Deny** records a decision on the request doc. Without the opt-in hooks it
**records only** — it does not unblock a prompt waiting in your live desktop session. Installing the
opt-in hooks (`packages/agent/scripts/install-hooks.mjs`, **you** run it, never the agent) gives
precise permission capture.

---

## What's verified vs not

**Verified live on the Firebase Emulator Suite:**
- 17 security-rules tests (multi-tenant isolation; command-shape + create-then-update bypass blocked; presence shape) ✅
- 38 agent unit tests + clean typecheck; dashboard production build + typecheck ✅
- Agent reads real `~/.claude` → wrote real sessions + presence + 280 message-metadata docs ✅
- Dashboard data round-trip (sign-in → read sessions/presence) ✅
- Command round-trip; `onDisconnect` auto-clears presence; approve/deny updates the original doc ✅
- **A real Tier A turn** (`claude --resume`) recalled state from a resumed session, stream-json parsed ✅

**Not yet done (needs you — see Deploy runbook):**
- Cloud deploy: APIs not enabled, RTDB instance not created, Email/Password provider not enabled, rules/hosting not pushed.
- Dashboard pixels not screenshotted (built + data-verified only); multi-user isolation proven at the rules layer, not yet two-users-at-runtime.

---

## Quick start (local, against the emulator)

> **Machine gotcha (this PC):** `firebase-tools` v15 requires JDK 21, but the only JDK 21 here can't
> open a network selector (AF_UNIX blocked). JDK 11 works but v15 rejects it. So the emulator script
> pins **`firebase-tools@13` + JDK 11**. On a normal machine, plain `firebase emulators:start` is fine.

```bash
# 1. start emulators (Auth 9099, Firestore 8080, RTDB 9000, UI 4000)
powershell -File scripts/emulators.ps1          # or: firebase emulators:start

# 2. seed demo data (creates demo@demo.dev / demo123)
USE_FIREBASE_EMULATORS=1 node scripts/seed-emulator.mjs

# 3. run the dashboard
cd packages/dashboard && VITE_USE_EMULATORS=1 npm run dev      # http://localhost:5173

# 4. run an agent against your real ~/.claude (read-only)
cd packages/agent && USE_FIREBASE_EMULATORS=1 CSD_EMAIL=demo@demo.dev CSD_PASSWORD=demo123 npx tsx src/index.ts
```

---

## Deploy to real Firebase + add your first device  ← the go-live runbook

The Firebase project **`claude-session-dashboard`** already exists (config in
`shared/src/firebaseConfig.ts`). These steps need your Firebase **console** access once; after that
everything is `firebase deploy`.

1. **Enable services** in the [Firebase console](https://console.firebase.google.com/project/claude-session-dashboard):
   - **Build → Authentication → Get started → enable Email/Password** (and Google if you want).
   - **Build → Firestore Database → Create** (production mode, region e.g. `nam5`).
   - **Build → Realtime Database → Create** (this creates the RTDB instance the agent writes to).
     If its URL isn't `https://claude-session-dashboard-default-rtdb.firebaseio.com`, update
     `databaseURL` in `shared/src/firebaseConfig.ts`.
2. **Deploy rules + hosting** (from repo root, you're already `firebase login`'d):
   ```bash
   cd packages/dashboard && npm run build && cd ../..
   firebase deploy --only firestore:rules,database,hosting
   ```
   The dashboard is now live at `https://claude-session-dashboard.web.app`.
3. **Create users.** In the console (Authentication → Users) add each person's email/password — each
   gets an isolated `uid` and sees only their own sessions. (Or let them sign up from the dashboard.)
4. **Configure + run an agent on this device:**
   ```bash
   mkdir -p ~/.claude-dash
   echo '{ "email": "you@example.com", "password": "••••••" }' > ~/.claude-dash/config.json
   cd packages/agent && npx tsx src/index.ts        # NO USE_FIREBASE_EMULATORS → talks to the cloud
   ```
   Open the dashboard, sign in as the same user — your live sessions appear.

---

## How to add a NEW device

On any other machine you use Claude Code:
1. Clone this repo, `npm install` in `packages/agent`.
2. Create `~/.claude-dash/config.json` with the **same user's** email/password (so it shares your `uid`).
3. Run the agent: `cd packages/agent && npx tsx src/index.ts`.
4. (Optional) **Keep it always-on** so the device stays on the dashboard after you close the terminal:
   - **Windows:** register a Scheduled Task "At log on" running the agent (a `node`/`tsx` command),
     or use `pm2 start "npx tsx src/index.ts" --name csd-agent`.
   - **macOS:** a `launchd` LaunchAgent plist; **Linux:** a `systemd --user` service.

   The agent stamps a stable `deviceId = sha256(hostname)[:16]`, so each machine shows as its own
   group. That's it — the dashboard updates live.

## How to add / see a new session
Nothing to do. **Just start Claude Code normally** on any device whose agent is running — the agent
detects the new `~/.claude/sessions/*.json`, publishes presence within ~5s, and it appears on the
dashboard grouped under that device + its project. Closing the session clears it (PID gone → stale →
`onDisconnect`).

---

## Security model
- **Multi-tenant by construction:** every path is under `users/{uid}` / `presence/{uid}`; Security
  Rules allow access only when `request.auth.uid == uid`. Proven by the rules tests (Alice can't read
  Bob).
- **Command channel is shape-validated** on create **and** update (type whitelist frozen, `sessionId`
  immutable, `payload.text ≤ 8000`), so a compromised client can't smuggle an arbitrary command.
- **Agent reads `~/.claude` read-only**, keeps its own config in `~/.claude-dash`, and never spawns a
  shell (Tier A spawns the resolved `claude.exe` directly — no injection surface).
- **Metadata only** by default; opt into full content per the agent README.

## Repo layout
```
shared/         contract (types) + firebase client init + rules tests + seed
packages/agent/ device collector + presence + command broker + Tier A/B messaging
packages/dashboard/ React (Vite) ops UI
scripts/        emulators.ps1 (v13+JDK11 pin), seed, verify-* integration checks
firestore.rules · database.rules.json · firebase.json   the whole backend config
```
See each package's `README.md` for details.
