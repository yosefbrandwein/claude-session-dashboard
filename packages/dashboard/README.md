# @csd/dashboard

The web dashboard for **claude-session-dashboard** — a multi-device, multi-tenant
view of live Claude Code sessions. It is a React + Vite single-page app that talks
**only to Firebase** (Firestore, Realtime Database, and Auth). It has **no direct
connection to the agent**: the agent and the dashboard communicate solely through
Firebase documents (the agent writes presence + session metadata and reads the
`commands` collection; the dashboard reads that data and writes commands back).

## Architecture at a glance

- **Realtime Database** `/presence/{uid}` — ephemeral, high-frequency live status
  and heartbeats, joined client-side with the durable Firestore records.
- **Firestore** `users/{uid}/sessions` — durable session metadata, plus the
  `messages`, `permissionRequests`, and per-user `commands` sub-collections.
- **Shared contract** — all wire shapes and Firestore path helpers come from
  `shared/src/types.ts`; the Firebase config comes from
  `shared/src/firebaseConfig.ts`. The dashboard never redefines these.

The session list is derived by `mergeSessions` (see `src/model.ts`), which joins
presence with session docs and reconciles status against the heartbeat clock.

## Development against the emulator

Run the Firebase Emulator Suite (owned by the repo root) first, then start the dev
server with the emulator flag so the SDK points at the local emulators instead of
production:

```bash
# from the repo root, in one terminal:
npm run emulators

# from packages/dashboard, in another terminal:
VITE_USE_EMULATORS=1 npm run dev
```

`VITE_USE_EMULATORS=1` is read at build time by Vite (`import.meta.env`). When set,
`src/firebase.ts` wires Auth, Firestore, and RTDB to the emulator hosts from the
shared config and logs `[firebase] Connected to LOCAL emulators` to the console.
Without the flag, the app talks to the real Firebase project.

On Windows PowerShell, set the env var inline:

```powershell
$env:VITE_USE_EMULATORS = '1'; npm run dev
```

## Build & typecheck

```bash
npm run build      # tsc -b && vite build (production bundle)
npm run typecheck  # tsc --noEmit
```

The build must stay green; `tsc -b` typechecks against the shared contract via
relative imports.

## Notes

- The dashboard is **read-mostly**: the only thing it writes is `CommandDoc`s into
  `users/{uid}/commands` (send message / interrupt / approve / deny). The agent
  picks those up, executes them, and writes back `status` + `result`, which the
  drawer surfaces as a toast before deleting the terminal command.
- Sending a message runs a **separate headless `claude --resume` turn** on the
  conversation — it does not type into the user's open desktop window. Approve/Deny
  **records** a decision; without the opt-in hooks it does not unblock a live local
  permission prompt. The UI states this explicitly.
