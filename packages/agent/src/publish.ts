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

/**
 * Publish one session's presence to RTDB and arm onDisconnect removal so a hard
 * agent crash auto-clears the live record. Returns nothing; call every tick.
 */
export async function publishPresence(
  uid: string,
  deviceId: string,
  sessionId: string,
  rec: PresenceRecord,
): Promise<void> {
  const r = ref(getRtdb(), paths.presence(uid, deviceId, sessionId));
  // Arm removal-on-disconnect BEFORE the write so there's no window where a
  // crash leaves a stuck record.
  await onDisconnect(r).remove();
  await rtdbSet(r, rec as any);
}

/** Remove a presence record explicitly (session ended / no longer active). */
export async function clearPresence(
  uid: string,
  deviceId: string,
  sessionId: string,
): Promise<void> {
  await rtdbRemove(ref(getRtdb(), paths.presence(uid, deviceId, sessionId)));
}

/** Write/merge a durable session doc (Firestore). */
export async function writeSessionDoc(uid: string, session: SessionDoc): Promise<void> {
  await setDoc(doc(getDb(), paths.session(uid, session.sessionId)), session as any, {
    merge: true,
  });
}

/**
 * Append a batch of NEW messages under a session. We key each message by its
 * line index so re-running the tick is idempotent (overwrites, never dupes).
 * `captureContent` gates whether `text` is included (default OFF → metadata only).
 */
export async function appendMessages(
  uid: string,
  sessionId: string,
  startIndex: number,
  messages: (MessageDoc & { _text?: string })[],
  captureContent: boolean,
): Promise<void> {
  if (messages.length === 0) return;
  const db = getDb();
  const col = collection(db, paths.messages(uid, sessionId));
  const batch = writeBatch(db);
  messages.forEach((m, i) => {
    const id = String(startIndex + i).padStart(9, '0'); // sortable, stable id
    const payload: MessageDoc = {
      ts: m.ts,
      role: m.role,
      kind: m.kind,
    };
    if (m.toolCalls) payload.toolCalls = m.toolCalls;
    if (m.summary) payload.summary = m.summary;
    if (captureContent && m._text) payload.text = m._text;
    batch.set(doc(col, id), payload as any, { merge: true });
  });
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
