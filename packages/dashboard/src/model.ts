// Dashboard-local view models. These compose the SHARED contract shapes
// (PresenceRecord, SessionDoc, …) into the merged objects the UI renders.
// We never redefine the wire shapes — only join + derive from them.
import type {
  PresenceRecord,
  SessionDoc,
  SessionStatus,
} from '../../../shared/src/types';

/** How long without a heartbeat before we treat a presence record as stale. */
export const STALE_AFTER_MS = 30_000;

/**
 * A single session as shown in the UI: the durable Firestore record joined with
 * its live RTDB presence (if any). Either side may be missing:
 *   - presence-only  → an agent just came online, Firestore doc not flushed yet.
 *   - sessionDoc-only → a finished/archived session with no live presence.
 */
export interface MergedSession {
  key: string;            // `${deviceId}::${sessionId}`
  sessionId: string;
  deviceId: string;
  /** Human-readable session title (Claude "Recents" name); null if unknown. */
  title: string | null;
  project: string;
  branch: string | null;
  /** Effective status after reconciling presence heartbeat against the clock. */
  status: SessionStatus;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  model: string | null;
  version: string | null;
  entrypoint: string | null;
  controllable: boolean;
  /** True when the owning device's presence heartbeat has timed out. */
  deviceStale: boolean;
  presence: PresenceRecord | null;
  sessionDoc: SessionDoc | null;
}

/** Reconcile the agent-reported status with the heartbeat age. */
export function effectiveStatus(
  reported: SessionStatus,
  heartbeatAt: number | null,
  now: number,
): SessionStatus {
  if (reported === 'ended') return 'ended';
  if (heartbeatAt == null) return reported;
  if (now - heartbeatAt > STALE_AFTER_MS) return 'stale';
  return reported;
}

/**
 * Join presence (keyed deviceId→sessionId→record) with session docs into a flat
 * list of MergedSession. `now` is passed in so the same timestamp drives every
 * staleness decision in one render pass (and so it's testable).
 */
export function mergeSessions(
  presenceByDevice: Record<string, Record<string, PresenceRecord>>,
  sessionDocs: SessionDoc[],
  now: number,
): MergedSession[] {
  const docByKey = new Map<string, SessionDoc>();
  for (const d of sessionDocs) {
    docByKey.set(`${d.deviceId}::${d.sessionId}`, d);
  }

  // First, compute per-device staleness: a device is stale if the freshest
  // heartbeat across all its sessions is older than the threshold.
  const deviceFreshestHeartbeat = new Map<string, number>();
  for (const [deviceId, sessions] of Object.entries(presenceByDevice)) {
    let freshest = 0;
    for (const rec of Object.values(sessions)) {
      if (rec.heartbeatAt > freshest) freshest = rec.heartbeatAt;
    }
    deviceFreshestHeartbeat.set(deviceId, freshest);
  }
  const deviceIsStale = (deviceId: string): boolean => {
    const hb = deviceFreshestHeartbeat.get(deviceId);
    if (hb == null || hb === 0) return false; // unknown → not from presence
    return now - hb > STALE_AFTER_MS;
  };

  const out: MergedSession[] = [];
  const seen = new Set<string>();

  // 1) Every presence record becomes a session (live source of truth).
  for (const [deviceId, sessions] of Object.entries(presenceByDevice)) {
    for (const [sessionId, rec] of Object.entries(sessions)) {
      const key = `${deviceId}::${sessionId}`;
      seen.add(key);
      const doc = docByKey.get(key) ?? null;
      out.push({
        key,
        sessionId,
        deviceId,
        title: doc?.title ?? null,
        project: rec.project || doc?.project || 'unknown',
        branch: rec.branch ?? doc?.gitBranch ?? null,
        status: effectiveStatus(rec.status, rec.heartbeatAt, now),
        startedAt: rec.startedAt || doc?.startedAt || now,
        lastActivityAt: rec.lastActivityAt || doc?.startedAt || now,
        messageCount: doc?.messageCount ?? 0,
        model: doc?.model ?? null,
        version: doc?.version ?? null,
        entrypoint: doc?.entrypoint ?? null,
        controllable: doc?.controllable ?? false,
        deviceStale: deviceIsStale(deviceId),
        presence: rec,
        sessionDoc: doc,
      });
    }
  }

  // 2) Session docs with no live presence (ended / not yet re-announced).
  for (const d of sessionDocs) {
    const key = `${d.deviceId}::${d.sessionId}`;
    if (seen.has(key)) continue;
    out.push({
      key,
      sessionId: d.sessionId,
      deviceId: d.deviceId,
      title: d.title,
      project: d.project,
      branch: d.gitBranch,
      // No presence heartbeat → fall back to the doc's own status, but a
      // non-ended doc with no presence is effectively stale.
      status: d.status === 'ended' ? 'ended' : 'stale',
      startedAt: d.startedAt,
      lastActivityAt: d.endedAt ?? d.startedAt,
      messageCount: d.messageCount,
      model: d.model,
      version: d.version,
      entrypoint: d.entrypoint,
      controllable: d.controllable,
      deviceStale: deviceIsStale(d.deviceId),
      presence: null,
      sessionDoc: d,
    });
  }

  return out;
}

/** Human label for a status pill. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  'awaiting-input': 'Awaiting input',
  'needs-attention': 'Needs attention',
  stale: 'Stale',
  ended: 'Ended',
};

/** Status considered "active" for the header counts. */
export const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'working',
  'idle',
  'awaiting-input',
  'needs-attention',
]);
