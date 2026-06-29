// Permanently remove a finished session from the dashboard. Deletes its live
// presence (RTDB), durable session doc, and metadata subcollections (messages,
// permissionRequests). This only touches the CLOUD copy — your local ~/.claude
// transcript is untouched. Owners may delete their own data (firestore.rules),
// so no rules change is needed.
//
// Only meaningful for finished (stale/ended) sessions: a still-live session would
// be re-published by the agent on its next tick.
import { doc, deleteDoc, collection, getDocs, writeBatch } from 'firebase/firestore';
import { ref, remove } from 'firebase/database';
import { db, rtdb } from './firebase';
import { paths } from '../../../shared/src/types';
import type { MergedSession } from './model';

async function deleteCollection(path: string): Promise<void> {
  const snap = await getDocs(collection(db, path));
  let batch = writeBatch(db);
  let n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref);
    // Firestore batches cap at 500 ops; flush before we hit it.
    if (++n === 450) {
      await batch.commit();
      batch = writeBatch(db);
      n = 0;
    }
  }
  if (n > 0) await batch.commit();
}

export async function dismissSession(uid: string, s: MergedSession): Promise<void> {
  // 1. presence first so the card can't be re-seeded from RTDB mid-delete.
  await remove(ref(rtdb, paths.presence(uid, s.deviceId, s.sessionId))).catch(() => {});
  // 2. metadata subcollections (best-effort).
  const base = paths.session(uid, s.sessionId);
  await deleteCollection(`${base}/messages`).catch(() => {});
  await deleteCollection(`${base}/permissionRequests`).catch(() => {});
  // 3. the durable session doc — this is what removes it from the board.
  await deleteDoc(doc(db, base));
}

/** Dismiss many sessions (bulk "Clear finished"). Returns how many succeeded. */
export async function dismissSessions(uid: string, sessions: MergedSession[]): Promise<number> {
  let ok = 0;
  for (const s of sessions) {
    try {
      await dismissSession(uid, s);
      ok++;
    } catch {
      /* skip failures, keep going */
    }
  }
  return ok;
}
