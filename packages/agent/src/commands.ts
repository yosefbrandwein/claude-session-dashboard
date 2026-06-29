// ============================================================================
// Command listener + dispatcher. Subscribes to users/{uid}/commands where
// status=='pending', acks each, executes it, then marks it done/error with a
// result string. Handles: sendMessage (Tier B → Tier A), interrupt, approve/deny.
// ============================================================================
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  type Unsubscribe,
} from 'firebase/firestore';

import { getDb } from '../../../shared/src/clientNode';
import { paths } from '../../../shared/src/types';
import type { CommandDoc, MessageDoc } from '../../../shared/src/types';
import { TierARun } from './messaging/tierA-cli';
import { probeDaemon } from './messaging/tierB-daemon';
import { appendMessagesWithIds, writePermissionDecision } from './publish';

/** What the dispatcher needs to know about each session to act on it. */
export interface SessionContext {
  sessionId: string;
  cwd: string;
  model: string | null;
  /** True only if the session is currently live + resumable (agent-side gate). */
  controllable: boolean;
}

export interface CommandRuntime {
  uid: string;
  /** This agent's device id — commands bound to another device are ignored. */
  deviceId: string;
  captureContent: boolean;
  /** Security posture for sendMessage (see AgentConfig.commandMode). */
  commandMode: 'off' | 'safe' | 'full';
  /** Look up live context for a sessionId (null if unknown/ended). */
  getSession: (sessionId: string) => SessionContext | null;
}

/** In-flight Tier A runs by sessionId, so `interrupt` can cancel them. */
const activeRuns = new Map<string, TierARun>();

/**
 * Command IDs we've already begun executing. Firestore's update rule allows a
 * command to be flipped back to status:'pending', which would otherwise let an
 * attacker REPLAY a single approved command to spawn unbounded Claude runs
 * (quota/cost/CPU amplification). We execute each cmdId at most once per process.
 */
const processedCmds = new Set<string>();

/** This agent's OWN per-device command collection path. */
function cmdCol(rt: CommandRuntime): string {
  return paths.deviceCommands(rt.uid, rt.deviceId);
}

async function ack(rt: CommandRuntime, cmdId: string): Promise<void> {
  await updateDoc(doc(getDb(), cmdCol(rt), cmdId), { status: 'acked' });
}

async function finish(
  rt: CommandRuntime,
  cmdId: string,
  status: 'done' | 'error',
  result: string,
): Promise<void> {
  await updateDoc(doc(getDb(), cmdCol(rt), cmdId), { status, result });
}

/**
 * Subscribe to THIS device's pending commands and dispatch them. Commands live
 * in a per-device collection (users/{uid}/devices/{deviceId}/commands), so an
 * agent only ever sees commands meant for it — another device's agent can't pick
 * up and falsely error on a command for this one. Each doc is acked before work
 * begins so a duplicate snapshot won't double-execute.
 */
export function listenForCommands(rt: CommandRuntime): Unsubscribe {
  const col = collection(getDb(), cmdCol(rt));
  const q = query(col, where('status', '==', 'pending'));

  return onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === 'removed') return;
      const cmd = change.doc.data() as CommandDoc;
      if (cmd.status !== 'pending') return;
      // Belt-and-suspenders: even within our own collection, ignore a command
      // explicitly stamped for a different device.
      if (cmd.deviceId && cmd.deviceId !== rt.deviceId) return;
      // Fire-and-forget; each handler owns its own error reporting.
      void dispatch(rt, change.doc.id, cmd);
    });
  });
}

async function dispatch(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  // Replay guard: never execute the same command twice, even if it's re-armed
  // to 'pending' (see processedCmds).
  if (processedCmds.has(cmdId)) return;
  processedCmds.add(cmdId);
  try {
    await ack(rt, cmdId);
    switch (cmd.type) {
      case 'sendMessage':
        return await handleSendMessage(rt, cmdId, cmd);
      case 'interrupt':
        return await handleInterrupt(rt, cmdId, cmd);
      case 'approve':
      case 'deny':
        return await handleDecision(rt, cmdId, cmd);
      default:
        await finish(rt, cmdId, 'error', `unknown command type: ${cmd.type}`);
    }
  } catch (e: any) {
    await finish(rt, cmdId, 'error', String(e?.message ?? e)).catch(() => {});
  }
}

async function handleSendMessage(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  // Security gate: remote execution is opt-in. 'off' refuses to run anything.
  if (rt.commandMode === 'off') {
    await finish(
      rt,
      cmdId,
      'error',
      'remote message execution is disabled on this device (CSD_COMMAND_MODE=off)',
    );
    return;
  }
  const text = cmd.payload?.text;
  if (!text) {
    await finish(rt, cmdId, 'error', 'sendMessage requires payload.text');
    return;
  }
  const ctx = rt.getSession(cmd.sessionId);
  if (!ctx) {
    await finish(rt, cmdId, 'error', `unknown/ended session ${cmd.sessionId}`);
    return;
  }
  // Eligibility: only drive sessions the agent currently considers controllable
  // (live + resumable). Don't trust the dashboard's client-side gate — a forged
  // command bypasses the disabled Send button.
  if (!ctx.controllable) {
    await finish(rt, cmdId, 'error', `session ${cmd.sessionId} is not controllable`);
    return;
  }

  // --- Tier B attempt (preferred): only if a real injection channel exists. ---
  const probe = await probeDaemon();
  const tierBChannel = probe.claudePipes.find((n) => /peer|dispatch/i.test(n));
  if (tierBChannel) {
    // A genuine peer/dispatch pipe was found. We DON'T have a verified framing
    // for peerProtocol:1, so we record the attempt and fall through to Tier A
    // rather than risk corrupting the live session. (See README Tier B.)
    // If/when the framing is reverse-engineered, wire the write here.
  }
  // On this machine Tier B is not feasible (probe.verdict explains why) → Tier A.

  await runTierA(rt, cmdId, ctx, text);
}

/** Execute a Tier A headless run and stream assistant output into Firestore. */
async function runTierA(
  rt: CommandRuntime,
  cmdId: string,
  ctx: SessionContext,
  text: string,
): Promise<void> {
  const run = new TierARun({
    sessionId: ctx.sessionId,
    text,
    cwd: ctx.cwd,
    model: ctx.model ?? undefined,
    // 'full' (explicit opt-in) runs with the session's normal permissions;
    // otherwise the run is sandboxed (no Bash/Write/Edit/network tools).
    sandbox: rt.commandMode === 'full' ? 'full' : 'safe',
  });
  activeRuns.set(ctx.sessionId, run);

  // Tier A chunks live in a DISJOINT id namespace (`tierA-<cmdId>-<n>`) so they
  // can NEVER collide with the line-indexed transcript docs the tick writes —
  // those use numeric `lineIndexId` ids (see F5). A non-numeric prefix guarantees
  // disjointness even if `index` happened to equal a real transcript line index.
  let index = 0;
  const collected: string[] = [];

  run.on('event', (ev) => {
    if (ev.role === 'assistant' && (ev.text || ev.toolCalls)) {
      const m: MessageDoc & { _text?: string } = {
        ts: Date.now(),
        role: 'assistant',
        kind: 'tierA-stream',
      };
      if (ev.toolCalls) m.toolCalls = ev.toolCalls;
      if (ev.text) {
        m.summary = ev.text.replace(/\s+/g, ' ').slice(0, 80);
        m._text = ev.text;
        collected.push(ev.text);
      }
      const id = `tierA-${cmdId}-${index++}`;
      // Best-effort append; id advances per emitted assistant chunk.
      void appendMessagesWithIds(rt.uid, ctx.sessionId, [{ id, msg: m }], rt.captureContent).catch(
        () => {},
      );
    }
  });

  await new Promise<void>((resolve) => {
    run.on('error', async (e: Error) => {
      activeRuns.delete(ctx.sessionId);
      await finish(rt, cmdId, 'error', `Tier A failed: ${e.message}`).catch(() => {});
      resolve();
    });
    run.on('close', async () => {
      activeRuns.delete(ctx.sessionId);
      if (run.killed) {
        await finish(rt, cmdId, 'done', 'interrupted').catch(() => {});
      } else {
        const result = run.finalResult ?? collected.join('').slice(0, 500);
        await finish(rt, cmdId, 'done', `Tier A delivered (${result.length} chars)`).catch(
          () => {},
        );
      }
      resolve();
    });
    run.start();
  });
}

async function handleInterrupt(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  const run = activeRuns.get(cmd.sessionId);
  if (run) {
    run.interrupt();
    await finish(rt, cmdId, 'done', 'interrupt signalled to Tier A run');
  } else {
    await finish(rt, cmdId, 'done', 'no controllable run to interrupt (Tier B sessions are user-driven)');
  }
}

/**
 * approve/deny: record the decision against the referenced permission request.
 * For Tier A runs that are awaiting an answer, the decision text can be fed as a
 * follow-up sendMessage; transcript-only Tier B sessions are answered by the
 * user locally, so here we just durably record the dashboard's decision.
 */
async function handleDecision(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  const decision: 'approved' | 'denied' = cmd.type === 'approve' ? 'approved' : 'denied';
  const reqId = cmd.payload?.reqId;
  if (!reqId) {
    await finish(rt, cmdId, 'error', `${cmd.type} requires payload.reqId`);
    return;
  }
  // Merge the decision onto the EXISTING request doc keyed by reqId — do NOT
  // synthesize a new ts/tool, which would orphan the original as pending (F7).
  await writePermissionDecision(rt.uid, cmd.sessionId, reqId, decision, 'dashboard');
  await finish(rt, cmdId, 'done', `recorded ${decision} for ${reqId}`);
}
