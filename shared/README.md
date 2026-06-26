# @csd/shared

Shared Firebase contract + client init helpers for the Claude Session Dashboard.
Everything here is consumed by **both** `packages/dashboard` (browser) and
`packages/agent` (Node), so the data shapes and auth wiring live in exactly one
place.

## What's here

| File | Purpose |
|---|---|
| `src/types.ts` | The shared data contract — `PresenceRecord`, `DeviceDoc`, `SessionDoc`, `MessageDoc`, `PermissionRequestDoc`, `CommandDoc`, and the `paths` helper. **Do not change shapes** without coordinating all three packages. |
| `src/firebaseConfig.ts` | `firebaseConfig` (non-secret), `USE_EMULATORS`, `EMULATOR_HOSTS`. |
| `src/clientWeb.ts` | Browser Firebase init. `getAuthInstance()`, `getDb()` (Firestore), `getRtdb()` (RTDB). Wires emulators when `USE_EMULATORS`. Idempotent. |
| `src/clientNode.ts` | Node Firebase init (agent). Same accessors **plus** `signInAgent(email, password)`. The agent authenticates **as a user** via the client SDK — *not* firebase-admin — so it is subject to the same Security Rules as the dashboard. |
| `test/rules.test.js` | Security-rules unit tests (`@firebase/rules-unit-testing`, run with `node --test`). |

Consumers import the helpers via the package `exports` map:

```ts
import { getDb, getRtdb, getAuthInstance } from '@csd/shared/clientWeb';
import { signInAgent, getDb } from '@csd/shared/clientNode';
import type { SessionDoc } from '@csd/shared/types';
import { paths } from '@csd/shared';
```

> The `exports` map points at the `.ts` sources (the contract is consumed by
> TS-aware bundlers / `tsc`), which is why the relative imports inside use the
> `./x.js` specifier convention that TS resolves back to `./x.ts`.

## Start the emulator suite

From the **repo root** (reads `firebase.json`):

```bash
firebase emulators:start
# or, just what shared needs:
firebase emulators:start --only auth,firestore,database
```

Ports (from `firebase.json`): auth 9099, firestore 8080, database (RTDB) 9000,
hosting 5000, emulator UI http://127.0.0.1:4000.

## Seed demo data

With the emulator suite running, from the **repo root**:

```bash
USE_FIREBASE_EMULATORS=1 node scripts/seed-emulator.mjs
```

Creates demo user `demo@demo.dev` / `demo123` and writes 1 device, 3 sessions
(status `working` / `idle` / `awaiting-input`), a few metadata-only messages,
1 pending `permissionRequest`, and matching `/presence` records in RTDB. It
prints the demo uid + creds at the end. The script refuses to run unless
`USE_FIREBASE_EMULATORS=1`, so it can never hit the cloud project.

## Run the security-rules tests

The tests connect to the **running** firestore + database emulators.

1. Start the emulators (see above).
2. From `shared/`:

```bash
npm test --prefix shared/   # not defined; use the script below
# actual:
npm run test:rules            # inside shared/
# or from repo root:
npm run rules:test
```

`test:rules` runs `node --test ./test/*.test.js`. It proves:

- owner can read+write their own `users/{uid}/...` subtree (devices, sessions,
  messages, permissionRequests, commands);
- a different uid is denied reading/writing another user's subtree;
- command shape validation: invalid `type` denied, non-`pending` create denied,
  oversized `payload` (>8000) denied, a valid pending `sendMessage` allowed;
- RTDB `/presence/{uid}` is owner-only (other uid denied).

## Dependencies

Installed in this package (all permissive licenses):

| Package | Version | License |
|---|---|---|
| `firebase` | ^12 | Apache-2.0 |
| `@firebase/rules-unit-testing` (dev) | ^5 | Apache-2.0 |
| `typescript` (dev) | ^6 | Apache-2.0 |
| `@types/node` (dev) | ^24 | MIT |
