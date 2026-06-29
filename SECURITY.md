# Security model

This system lets a dashboard **send messages to Claude running on your machine**. Because Claude
has file/shell access, the command channel is, by nature, a **remote-code-execution surface**. This
doc states the threat model honestly, what is hardened in code, what you proved, and the few
**console/practice steps that are on you**.

## Threat model (one sentence)
Anyone who can write one doc to `users/{uid}/commands` in your Firestore can make your machine run
Claude — so the security of the whole system reduces to **who can authenticate as you**, plus **how
much a single such command is allowed to do**.

A full adversarial audit (red-team + 5 surfaces + independent verification) ranked the attack paths:
1. **Steal the agent password** (`~/.claude-dash/config.json`, plaintext) → sign in anywhere → command-write → RCE.
2. **Guess/stuff/breach the password** via the public auth endpoint (no MFA) → same.
3. **Compromise a logged-in dashboard browser/token** → command-write → RCE.
4. **Compromise the Firebase owner/CI** → rewrite rules → fleet-wide RCE.

## What is hardened in code (and verified)
- **Sandboxed by default (the load-bearing fix).** A dashboard `sendMessage` spawns Claude with
  `--permission-mode default --disallowedTools Bash,Write,Edit,WebFetch,…` — **deny rules override any
  project allow-list**, so a remote message **cannot** run shell/modify files/reach the network even
  if your project auto-approves `Bash(*)`. *Verified with an A/B test against the real `claude`
  binary: with the sandbox, Bash did not execute; without it, it did.* (`tierA-cli.ts`)
- **`CSD_COMMAND_MODE` kill-switch.** `off` = ignore remote messages (observe-only); `safe` (default)
  = sandboxed; `full` = the session's normal permissions (RCE-capable, **explicit opt-in only**). A
  leaked password can only reach `full` RCE if **you** enabled it on the device. (`config.ts`)
- **Command integrity (rules).** On update, `type`/`sessionId`/`payload`/`createdAt` are **frozen**
  and status is **forward-only** (`pending→acked→done|error`) — so a stolen token can't swap the
  payload after review or **replay** a finished command to spawn unbounded runs. *Verified: 20 rules
  tests incl. replay-denied + payload-swap-denied.* (`firestore.rules`)
- **Agent replay guard + eligibility gate.** Each command executes at most once per process, and only
  against sessions the agent currently deems live/controllable (not the client's cosmetic flag). (`commands.ts`, `index.ts`)
- **No shell injection.** Claude is spawned via `child_process.spawn` array form (`shell:false`),
  resolving the native `claude.exe` (never the `.cmd` shim). Prompt is a positional arg.
- **Per-tenant isolation** in both `firestore.rules` and `database.rules.json` (verified, no cross-tenant path).
- **Metadata only** by default — transcripts/secrets are not uploaded; `config.json` written
  JSON-safely; presence values length-capped.
- **Dependencies:** the agent's only runtime dep is the official `firebase` SDK; no typosquats; the 5
  moderate `npm audit` findings are **dev-only** (inside `firebase-tools`, never in the agent runtime).

## What is ON YOU (do these — they close paths 1–4)
1. **Use a strong, unique password** for the dashboard account — it's the one secret gating
   everything. Never reuse it. (The agent stores it in plaintext locally by necessity.)
2. **Enable MFA** on the Google/Firebase account (especially the **project-owner** account → path 4).
3. **Enable Firebase Auth email-enumeration protection** (Authentication → Settings).
4. **Enable Firebase App Check** so the public apiKey alone can't drive auth from a script (mitigates path 2/3).
5. **Protect `~/.claude-dash/config.json`** — don't sync/back it up to shared storage; it's the keys to the kingdom.
6. **Leave `CSD_COMMAND_MODE=safe`** unless you fully accept that `full` means a password leak = RCE on that device.

## Residual risk / recommended future work
- **Biggest remaining item:** move the agent off a reusable plaintext password to a **scoped,
  revocable credential** (OS keychain / custom-token via a tiny trusted backend) so a leak is
  recoverable without changing your human password. Tracked as the top hardening follow-up.
- **Command signing / origin-binding** (HMAC + nonce + device-binding) so only the genuine dashboard,
  not any token-holder, can issue commands.
- **Local confirmation** (desktop prompt) before any `full`/tool-bearing run.

## Verdict
With the sandbox default + rules freeze + kill-switch shipped, the worst case for a leaked password
drops from **arbitrary RCE → a read-only assistant** (in `safe` mode). The remaining risk is
concentrated in the credential model (above) and the standard account-security steps you enable in
the console. Treat `CSD_COMMAND_MODE=full` as a loaded gun: only on devices you accept that risk for.
