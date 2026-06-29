// ============================================================================
// Device Agent entrypoint. Authenticates as a user, then runs three concurrent
// jobs against ~/.claude (READ-ONLY) + Firebase:
//   1. presence loop  — every ~5s publish active sessions to RTDB (+ onDisconnect)
//   2. metadata writer — durable SessionDoc + incremental MessageDoc/permissions
//   3. command listener — execute dashboard commands (sendMessage/interrupt/…)
//
//   USE_FIREBASE_EMULATORS=1 CSD_EMAIL=demo@demo.dev CSD_PASSWORD=demo123 \
//     npx tsx src/index.ts
// ============================================================================
import { pathToFileURL } from 'node:url';
import { signInAgent, getAuthInstance } from '../../../shared/src/clientNode';
import { loadConfig } from './config';
import { deviceId, deviceDoc, gitBranch } from './device';
import { collectOnce, toPresenceRecord, toSessionDoc, type CollectedSession } from './collector/collect';
import { findTranscriptPath, readTranscriptEntriesFrom } from './collector/io';
import { parseTranscriptEntry, parsePermissionDenial } from './collector/parse';
import { getSessionTitle } from './collector/titles';
import {
  upsertDevice,
  publishPresence,
  clearPresence,
  writeSessionDoc,
  appendMessagesWithIds,
  lineIndexId,
  writePermissionRequest,
  type IdentifiedMessage,
} from './publish';
import { listenForCommands, type SessionContext } from './commands';
import { probeDaemon } from './messaging/tierB-daemon';
import type { MessageDoc, PermissionRequestDoc, SessionDoc } from '../../../shared/src/types';

const AGENT_VERSION = '0.1.0';

// Per-session bookkeeping that must persist across ticks.
interface SessionState {
  publishedLines: number; // how many transcript lines we've already flushed
  branch: string | null;
  model: string | null;
  cwd: string;
  /** Serialized form of the last SessionDoc we wrote — skip the write when
   *  unchanged so an always-present session doesn't bill a write every tick (F1). */
  lastSessionDocJson: string | null;
  /** True once we've written a terminal (stale/ended) doc — write it exactly once. */
  terminalWritten: boolean;
}
const state = new Map<string, SessionState>();
// Sessions we published to presence last tick (to clear ones that vanished).
let lastPresenceKeys = new Set<string>();

async function tick(uid: string): Promise<void> {
  const dev = deviceId();
  const now = Date.now();
  const snap = await collectOnce({ now });
  const seen = new Set<string>();

  for (const c of snap.sessions) {
    const sid = c.parsed.sessionId;
    seen.add(sid);
    let st = state.get(sid);
    const firstSight = !st;
    if (!st) {
      st = {
        // F4: treat pre-existing transcript history as already-published. On
        // first sight, seed publishedLines to the current total line count so we
        // only stream NEW messages going forward (no full-history replay on
        // every (re)attach). Combined with F3 line-index ids this makes re-ticks
        // idempotent.
        publishedLines: c.signal?.lineCount ?? 0,
        branch: await gitBranch(c.parsed.cwd),
        model: await detectModel(c),
        cwd: c.parsed.cwd,
        lastSessionDocJson: null,
        terminalWritten: false,
      };
      state.set(sid, st);
    }

    // 1) presence (skip stale — they're not "live")
    if (c.status !== 'stale' && c.status !== 'ended') {
      await publishPresence(uid, dev, sid, toPresenceRecord(c, st.branch, now)).catch((e) =>
        console.error('[presence]', sid, e.message),
      );
    } else {
      await clearPresence(uid, dev, sid).catch(() => {});
    }

    // 2) durable session doc — only WRITE when the payload actually changed, so
    //    an always-present session doesn't bill one write per tick (F1). Terminal
    //    docs (stale/ended + endedAt) are written exactly once, then skipped.
    //    controllableHint now reflects Tier-A eligibility (F11, computed in
    //    collect.ts: live + has sessionId), not the infeasible Tier B hint.
    const isTerminal = c.status === 'stale' || c.status === 'ended';
    // Human-readable title from the desktop app's "Recents" store (best-effort).
    const title = await getSessionTitle(sid, now);
    const session = toSessionDoc(c, dev, st.branch, st.model, c.controllableHint, title);
    const sessionJson = stableSessionDocJson(session);
    if (isTerminal && st.terminalWritten) {
      // already flushed the terminal doc once — nothing more to write.
    } else if (sessionJson !== st.lastSessionDocJson) {
      await writeSessionDoc(uid, session).catch((e) =>
        console.error('[sessionDoc]', sid, e.message),
      );
      st.lastSessionDocJson = sessionJson;
      if (isTerminal) st.terminalWritten = true;
    }

    // 3) incremental metadata (new transcript lines → messages + permissions).
    //    Skipped on first sight: F4 already seeded publishedLines to the current
    //    line count, so there are no NEW lines to flush yet.
    if (c.transcriptPath && !firstSight) {
      await flushNewMessages(uid, sid, c, st).catch((e) =>
        console.error('[messages]', sid, e.message),
      );
    }
  }

  // Clear presence for sessions that disappeared since last tick.
  for (const key of lastPresenceKeys) {
    if (!seen.has(key)) await clearPresence(uid, dev, key).catch(() => {});
  }
  lastPresenceKeys = seen;

  // F6: prune state for sessions that vanished this tick. Without this the Map
  // grows unbounded, and a RECYCLED sessionId would resume a previous session's
  // stale publishedLines offset. (Terminal sessions are kept while still present
  // so terminalWritten stays honored; they're dropped once they disappear.)
  for (const sid of [...state.keys()]) {
    if (!seen.has(sid)) state.delete(sid);
  }
}

/**
 * Deterministic JSON for a SessionDoc so the F1 dirty-check compares structurally
 * regardless of key insertion order. Keys are sorted; the value is used only as a
 * change sentinel, never sent over the wire. Exported for unit testing.
 */
export function stableSessionDocJson(doc: SessionDoc): string {
  return JSON.stringify(doc, Object.keys(doc).sort());
}

/** Detect the model from the newest assistant transcript entry, best-effort. */
async function detectModel(c: CollectedSession): Promise<string | null> {
  if (!c.transcriptPath) return null;
  const { entries } = await readTranscriptEntriesFrom(c.transcriptPath, 0);
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = (entries[i].entry as any)?.message?.model;
    if (typeof m === 'string') return m;
  }
  return null;
}

/** Read transcript lines past what we've flushed and publish them. */
async function flushNewMessages(
  uid: string,
  sid: string,
  c: CollectedSession,
  st: SessionState,
): Promise<void> {
  const p = c.transcriptPath ?? (await findTranscriptPath(sid));
  if (!p) return;
  const { entries, totalLines } = await readTranscriptEntriesFrom(p, st.publishedLines);
  if (entries.length === 0) {
    st.publishedLines = totalLines;
    return;
  }
  const items: IdentifiedMessage[] = [];
  const now = Date.now();
  for (const { entry, lineIndex } of entries) {
    const parsed = parseTranscriptEntry(entry, now);
    if (parsed) {
      const m: MessageDoc & { _text?: string } = {
        ts: parsed.ts,
        role: parsed.role,
        kind: parsed.kind,
      };
      if (parsed.toolCalls) m.toolCalls = parsed.toolCalls;
      if (parsed.summary) m.summary = parsed.summary;
      // F3: key each doc by its ABSOLUTE transcript line index, not array
      // position, so re-ticks overwrite the same doc and ids never drift/collide.
      items.push({ id: lineIndexId(lineIndex), msg: m });
    }
    // best-effort permission denial detection
    const denial = parsePermissionDenial(entry, now);
    if (denial) {
      const req: PermissionRequestDoc = {
        tool: denial.tool,
        inputSummary: denial.inputSummary,
        ts: denial.ts,
        decision: 'denied',
        decidedAt: denial.ts,
        decidedBy: 'user-local',
        source: 'sdk',
      };
      await writePermissionRequest(uid, sid, req).catch(() => {});
    }
  }
  await appendMessagesWithIds(uid, sid, items, false);
  st.publishedLines = totalLines;
}

async function main(): Promise<void> {
  const cfg = await loadConfig();
  console.log(
    `[agent] starting v${AGENT_VERSION} device=${deviceId()} emulators=${cfg.useEmulators}`,
  );

  const cred = await signInAgent(cfg.email, cfg.password);
  const uid = cred.user.uid;
  console.log(`[agent] signed in as ${cfg.email} (uid ${uid})`);

  // One-time Tier B feasibility probe (logged, not fatal).
  const probe = await probeDaemon();
  console.log(`[agent] Tier B: ${probe.verdict}`);

  const firstSeen = Date.now();
  await upsertDevice(uid, deviceDoc(Date.now(), firstSeen, AGENT_VERSION));

  // Command listener (Firestore onSnapshot).
  const unsub = listenForCommands({
    uid,
    captureContent: cfg.captureContent,
    getSession: (sessionId): SessionContext | null => {
      const st = state.get(sessionId);
      if (!st) return null;
      return {
        sessionId,
        cwd: st.cwd,
        model: st.model,
      };
    },
  });

  // Presence + metadata loop.
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const started = Date.now();
      await tick(uid).catch((e) => console.error('[tick]', e.message));
      const elapsed = Date.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(0, cfg.presenceIntervalMs - elapsed)));
    }
  };
  void loop();
  console.log(`[agent] presence loop running every ${cfg.presenceIntervalMs}ms`);

  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log('\n[agent] shutting down — clearing presence…');
    unsub();
    const dev = deviceId();
    for (const sid of lastPresenceKeys) await clearPresence(uid, dev, sid).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only auto-start when run as the entrypoint (not when imported by a unit test,
// which would otherwise trigger config load + Firebase sign-in on import).
const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((e) => {
    console.error('[agent] fatal:', e);
    process.exit(1);
  });
}
