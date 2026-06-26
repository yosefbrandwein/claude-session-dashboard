// ============================================================================
// Firebase publisher: presence (RTDB, ephemeral, onDisconnect) + durable
// metadata (Firestore: device, session docs, incremental messages, permission
// requests). Authenticates AS A USER via the shared clientNode helper, so every
// write is subject to the exact Security Rules in firestore.rules / database.rules.json.
// ============================================================================
import {
  ref,
  set as rtdbSet,
  remove as rtdbRemove,
  onDisconnect,
} from 'firebase/database';
import {
  doc,
  setDoc,
  collection,
  writeBatch,
} from 'firebase/firestore';

import { getRtdb, getDb } from '../../../shared/src/clientNode';
import { paths } from '../../../shared/src/types';
import type {
  PresenceRecord,
  SessionDoc,
  MessageDoc,
  PermissionRequestDoc,
  DeviceDoc,
} from '../../../shared/src/types';

/** Upsert the device record (Firestore). */
export async function upsertDevice(uid: string, device: DeviceDoc): Promise<void> {
  const path = paths.device(uid, device.deviceId);
  await setDoc(doc(getDb(), path), device as any, { merge: true });
}

// Presence keys (uid|deviceId|sessionId) whose onDisconnect handler is already
// armed. onDisconnect persists server-side until it fires or is cancelled, so
// re-arming it every tick is a redundant RTDB round-trip — arm it ONCE per key
// (F10). clearPresence removes the key so a re-appearing session re-arms.
const armedDisconnect = new Set<string>();

/**
 * Publish one session's presence to RTDB and (once per key) arm onDisconnect
 * removal so a hard agent crash auto-clears the live record. Call every tick;
 * only the first call per session pays the onDisconnect round-trip.
 */
export async function publishPresence(
  uid: string,
  deviceId: string,
  sessionId: string,
  rec: PresenceRecord,
): Promise<void> {
  const key = `${uid}|${deviceId}|${sessionId}`;
  const r = ref(getRtdb(), paths.presence(uid, deviceId, sessionId));
  if (!armedDisconnect.has(key)) {
    // Arm removal-on-disconnect BEFORE the first write so there's no window
    // where a crash leaves a stuck record. Persists server-side thereafter.
    await onDisconnect(r).remove();
    armedDisconnect.add(key);
  }
  await rtdbSet(r, rec as any);
}

/** Remove a presence record explicitly (session ended / no longer active). */
export async function clearPresence(
  uid: string,
  deviceId: string,
  sessionId: string,
): Promise<void> {
  const key = `${uid}|${deviceId}|${sessionId}`;
  const r = ref(getRtdb(), paths.presence(uid, deviceId, sessionId));
  // Cancel any armed onDisconnect for this key — the record is gone, so the
  // pending remove is moot, and a future re-appearance must re-arm afresh (F10).
  if (armedDisconnect.delete(key)) {
    await onDisconnect(r).cancel().catch(() => {});
  }
  await rtdbRemove(r);
}

/** Write/merge a durable session doc (Firestore). */
export async function writeSessionDoc(uid: string, session: SessionDoc): Promise<void> {
  await setDoc(doc(getDb(), paths.session(uid, session.sessionId)), session as any, {
    merge: true,
  });
}

/** A message paired with the EXPLICIT Firestore doc id it must be written under. */
export interface IdentifiedMessage {
  id: string;
  msg: MessageDoc & { _text?: string };
}

/**
 * Format an absolute transcript line index into a zero-padded, lexically-sortable
 * Firestore doc id. Transcript-derived messages MUST be keyed by their true raw
 * line index (not array position) so re-ticks overwrite the same doc and never
 * drift/collide (see F3).
 */
export function lineIndexId(lineIndex: number): string {
  return String(lineIndex).padStart(9, '0');
}

/**
 * Core writer: append messages by their EXPLICIT doc ids in one batch. Keying is
 * fully caller-controlled so two id namespaces can never collide:
 *   • transcript messages → numeric line-index ids (`lineIndexId`)
 *   • Tier A streamed chunks → non-numeric `tierA-…` ids (see F5)
 * `captureContent` gates whether `text` is included (default OFF → metadata only).
 */
export async function appendMessagesWithIds(
  uid: string,
  sessionId: string,
  items: IdentifiedMessage[],
  captureContent: boolean,
): Promise<void> {
  if (items.length === 0) return;
  const db = getDb();
  const col = collection(db, paths.messages(uid, sessionId));
  const batch = writeBatch(db);
  for (const { id, msg } of items) {
    const payload: MessageDoc = {
      ts: msg.ts,
      role: msg.role,
      kind: msg.kind,
    };
    if (msg.toolCalls) payload.toolCalls = msg.toolCalls;
    if (msg.summary) payload.summary = msg.summary;
    if (captureContent && msg._text) payload.text = msg._text;
    batch.set(doc(col, id), payload as any, { merge: true });
  }
  await batch.commit();
}

/** Record a permission request (Firestore). Keyed by ts to dedupe re-reads. */
export async function writePermissionRequest(
  uid: string,
  sessionId: string,
  req: PermissionRequestDoc,
): Promise<void> {
  const id = `${req.ts}-${req.tool}`.replace(/[^\w.-]/g, '_');
  await setDoc(doc(getDb(), paths.permissionRequests(uid, sessionId), id), req as any, {
    merge: true,
  });
}

/**
 * Stamp a dashboard decision (approve/deny) onto the EXISTING permission request
 * doc identified by `reqId` — merging the decision fields rather than creating a
 * brand-new doc. This closes the approve/deny round-trip: the original request
 * flips out of `pending` instead of leaving a duplicate behind (see F7).
 */
export async function writePermissionDecision(
  uid: string,
  sessionId: string,
  reqId: string,
  decision: 'approved' | 'denied',
  decidedBy: PermissionRequestDoc['decidedBy'],
): Promise<void> {
  const col = collection(getDb(), paths.permissionRequests(uid, sessionId));
  await setDoc(
    doc(col, reqId),
    { decision, decidedAt: Date.now(), decidedBy } as Partial<PermissionRequestDoc> as any,
    { merge: true },
  );
}
