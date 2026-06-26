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
import { appendMessages, writePermissionRequest } from './publish';

/** What the dispatcher needs to know about each session to act on it. */
export interface SessionContext {
  sessionId: string;
  cwd: string;
  /** Current line count, so injected assistant output lands after history. */
  messageBaseIndex: number;
  model: string | null;
}

export interface CommandRuntime {
  uid: string;
  captureContent: boolean;
  /** Look up live context for a sessionId (null if unknown/ended). */
  getSession: (sessionId: string) => SessionContext | null;
}

/** In-flight Tier A runs by sessionId, so `interrupt` can cancel them. */
const activeRuns = new Map<string, TierARun>();

async function ack(uid: string, cmdId: string): Promise<void> {
  await updateDoc(doc(getDb(), paths.commands(uid), cmdId), { status: 'acked' });
}

async function finish(
  uid: string,
  cmdId: string,
  status: 'done' | 'error',
  result: string,
): Promise<void> {
  await updateDoc(doc(getDb(), paths.commands(uid), cmdId), { status, result });
}

/**
 * Subscribe to pending commands and dispatch them. Returns an Unsubscribe.
 * Commands are processed one snapshot at a time; each doc is acked before work
 * begins so a duplicate snapshot won't double-execute (we skip non-pending).
 */
export function listenForCommands(rt: CommandRuntime): Unsubscribe {
  const col = collection(getDb(), paths.commands(rt.uid));
  const q = query(col, where('status', '==', 'pending'));

  return onSnapshot(q, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === 'removed') return;
      const cmd = change.doc.data() as CommandDoc;
      if (cmd.status !== 'pending') return;
      // Fire-and-forget; each handler owns its own error reporting.
      void dispatch(rt, change.doc.id, cmd);
    });
  });
}

async function dispatch(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  try {
    await ack(rt.uid, cmdId);
    switch (cmd.type) {
      case 'sendMessage':
        return await handleSendMessage(rt, cmdId, cmd);
      case 'interrupt':
        return await handleInterrupt(rt, cmdId, cmd);
      case 'approve':
      case 'deny':
        return await handleDecision(rt, cmdId, cmd);
      default:
        await finish(rt.uid, cmdId, 'error', `unknown command type: ${cmd.type}`);
    }
  } catch (e: any) {
    await finish(rt.uid, cmdId, 'error', String(e?.message ?? e)).catch(() => {});
  }
}

async function handleSendMessage(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  const text = cmd.payload?.text;
  if (!text) {
    await finish(rt.uid, cmdId, 'error', 'sendMessage requires payload.text');
    return;
  }
  const ctx = rt.getSession(cmd.sessionId);
  if (!ctx) {
    await finish(rt.uid, cmdId, 'error', `unknown/ended session ${cmd.sessionId}`);
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
  });
  activeRuns.set(ctx.sessionId, run);

  let index = ctx.messageBaseIndex;
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
      // Best-effort append; index advances per emitted assistant chunk.
      void appendMessages(rt.uid, ctx.sessionId, index++, [m], rt.captureContent).catch(() => {});
    }
  });

  await new Promise<void>((resolve) => {
    run.on('error', async (e: Error) => {
      activeRuns.delete(ctx.sessionId);
      await finish(rt.uid, cmdId, 'error', `Tier A failed: ${e.message}`).catch(() => {});
      resolve();
    });
    run.on('close', async () => {
      activeRuns.delete(ctx.sessionId);
      if (run.killed) {
        await finish(rt.uid, cmdId, 'done', 'interrupted').catch(() => {});
      } else {
        const result = run.finalResult ?? collected.join('').slice(0, 500);
        await finish(rt.uid, cmdId, 'done', `Tier A delivered (${result.length} chars)`).catch(
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
    await finish(rt.uid, cmdId, 'done', 'interrupt signalled to Tier A run');
  } else {
    await finish(rt.uid, cmdId, 'done', 'no controllable run to interrupt (Tier B sessions are user-driven)');
  }
}

/**
 * approve/deny: record the decision against the referenced permission request.
 * For Tier A runs that are awaiting an answer, the decision text can be fed as a
 * follow-up sendMessage; transcript-only Tier B sessions are answered by the
 * user locally, so here we just durably record the dashboard's decision.
 */
async function handleDecision(rt: CommandRuntime, cmdId: string, cmd: CommandDoc): Promise<void> {
  const decision = cmd.type === 'approve' ? 'approved' : 'denied';
  const reqId = cmd.payload?.reqId;
  if (reqId) {
    // Re-stamp the permission request with the dashboard's decision.
    await writePermissionRequest(rt.uid, cmd.sessionId, {
      tool: 'unknown',
      inputSummary: `decision via dashboard for ${reqId}`,
      ts: Date.now(),
      decision: decision === 'approved' ? 'approved' : 'denied',
      decidedAt: Date.now(),
      decidedBy: 'dashboard',
      source: 'sdk',
    });
  }
  await finish(rt.uid, cmdId, 'done', `recorded ${decision}`);
}
