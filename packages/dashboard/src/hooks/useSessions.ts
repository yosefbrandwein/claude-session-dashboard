import { useEffect, useMemo, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { collection, onSnapshot } from 'firebase/firestore';
import { db, rtdb } from '../firebase';
import { mergeSessions, type MergedSession } from '../model';
import type { PresenceRecord, SessionDoc, DeviceDoc } from '../../../../shared/src/types';

/** Shape of the RTDB subtree at /presence/{uid}: deviceId → sessionId → record. */
type PresenceTree = Record<string, Record<string, PresenceRecord>>;

/**
 * Live merged session list for the signed-in user.
 *
 * Subscribes to BOTH backends in real time:
 *   - RTDB `/presence/{uid}` — ephemeral live status / heartbeat.
 *   - Firestore `users/{uid}/sessions` — durable metadata.
 * and joins them via `mergeSessions`. A 1Hz clock tick re-derives staleness so a
 * device that stops heart-beating greys out without needing a new snapshot.
 */
export function useSessions(uid: string | null): {
  sessions: MergedSession[];
  presenceLoaded: boolean;
  sessionsLoaded: boolean;
} {
  const [presence, setPresence] = useState<PresenceTree>({});
  const [sessionDocs, setSessionDocs] = useState<SessionDoc[]>([]);
  const [deviceDocs, setDeviceDocs] = useState<DeviceDoc[]>([]);
  const [presenceLoaded, setPresenceLoaded] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  // Ticks once a second purely to re-evaluate heartbeat-based staleness.
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!uid) {
      setPresence({});
      setSessionDocs([]);
      setDeviceDocs([]);
      setPresenceLoaded(false);
      setSessionsLoaded(false);
      return;
    }

    const presenceRef = ref(rtdb, `presence/${uid}`);
    const unsubPresence = onValue(presenceRef, (snap) => {
      setPresence((snap.val() as PresenceTree | null) ?? {});
      setPresenceLoaded(true);
    });

    const sessionsCol = collection(db, 'users', uid, 'sessions');
    const unsubSessions = onSnapshot(sessionsCol, (snap) => {
      setSessionDocs(snap.docs.map((d) => d.data() as SessionDoc));
      setSessionsLoaded(true);
    });

    const devicesCol = collection(db, 'users', uid, 'devices');
    const unsubDevices = onSnapshot(devicesCol, (snap) => {
      setDeviceDocs(snap.docs.map((d) => d.data() as DeviceDoc));
    });

    return () => {
      unsubPresence();
      unsubSessions();
      unsubDevices();
    };
  }, [uid]);

  // deviceId → friendly name (configured name, else hostname).
  const deviceNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of deviceDocs) m[d.deviceId] = d.name || d.hostname || d.deviceId;
    return m;
  }, [deviceDocs]);

  const sessions = useMemo(
    () => mergeSessions(presence, sessionDocs, nowTick, deviceNames),
    [presence, sessionDocs, nowTick, deviceNames],
  );

  return { sessions, presenceLoaded, sessionsLoaded };
}
