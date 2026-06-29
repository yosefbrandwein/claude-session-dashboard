// ============================================================================
// Collector orchestrator: ties the pure logic (parse.ts) to the I/O shell
// (io.ts) and maps everything onto the SHARED wire shapes. Produces the snapshot
// the presence loop + metadata writer consume each tick. READ-ONLY on ~/.claude.
// ============================================================================
import type {
  PresenceRecord,
  SessionDoc,
  SessionStatus,
} from '../../../../shared/src/types';
import {
  deriveStatus,
  projectFromCwd,
  activityTimestamp,
  type ParsedSession,
  type TranscriptSignal,
} from './parse';
import {
  readSessionFiles,
  liveProcesses,
  findTranscriptPath,
  readTranscriptSignal,
  claudeHome,
} from './io';

/** One collected session: shared shapes + the bits the writer needs internally. */
export interface CollectedSession {
  parsed: ParsedSession;
  status: SessionStatus;
  project: string;
  transcriptPath: string | null;
  signal: TranscriptSignal | null;
  lastActivityAt: number;
  /**
   * Tier-A controllability (F11): true for any LIVE (non-stale, non-ended)
   * session that has a sessionId — a headless `claude --resume` turn can act on
   * its history. This is NOT gated on the infeasible Tier B peer protocol.
   * HONESTY: Tier A runs a SEPARATE headless turn on the same conversation
   * history; it does NOT type into the user's open desktop window.
   */
  controllableHint: boolean;
}

export interface CollectorSnapshot {
  collectedAt: number;
  sessions: CollectedSession[];
}

/**
 * One full read-only pass over ~/.claude. `deviceId`/`gitBranch` are resolved by
 * the caller (they need device identity + git), so this stays focused on the
 * Claude-side facts. `now` is injected for determinism/testability.
 */
export async function collectOnce(opts: {
  home?: string;
  now: number;
}): Promise<CollectorSnapshot> {
  const home = opts.home ?? claudeHome();
  const now = opts.now;

  const parsedSessions = await readSessionFiles(home);
  const live = await liveProcesses(parsedSessions.map((s) => s.pid));

  const sessions: CollectedSession[] = [];
  for (const parsed of parsedSessions) {
    const pidAlive = live.has(parsed.pid);
    const transcriptPath = await findTranscriptPath(parsed.sessionId, home);
    const signal = transcriptPath ? await readTranscriptSignal(transcriptPath) : null;
    const status = deriveStatus(pidAlive, signal, now);
    const lastActivityAt = activityTimestamp(signal) ?? parsed.startedAt ?? now;
    sessions.push({
      parsed,
      status,
      project: projectFromCwd(parsed.cwd),
      transcriptPath,
      signal,
      lastActivityAt,
      // F11: Tier-A eligibility — a LIVE session (not stale/ended) with a
      // sessionId can be resumed by a headless `claude --resume` turn. We do NOT
      // gate on peerProtocol/kind (the Tier B path) which is infeasible and made
      // `controllable` permanently false in the UI.
      controllableHint: status !== 'stale' && status !== 'ended' && parsed.sessionId.length > 0,
    });
  }
  return { collectedAt: now, sessions };
}

/** Map a CollectedSession to the ephemeral RTDB PresenceRecord. */
export function toPresenceRecord(
  c: CollectedSession,
  gitBranch: string | null,
  heartbeatAt: number,
): PresenceRecord {
  return {
    status: c.status,
    project: c.project,
    branch: gitBranch,
    pid: c.parsed.pid,
    startedAt: c.parsed.startedAt,
    lastActivityAt: c.lastActivityAt,
    heartbeatAt,
  };
}

/** Map a CollectedSession to the durable Firestore SessionDoc. */
export function toSessionDoc(
  c: CollectedSession,
  deviceId: string,
  gitBranch: string | null,
  model: string | null,
  controllable: boolean,
  title: string | null = null,
): SessionDoc {
  return {
    sessionId: c.parsed.sessionId,
    deviceId,
    title,
    project: c.project,
    cwd: c.parsed.cwd,
    gitBranch,
    startedAt: c.parsed.startedAt,
    endedAt: c.status === 'stale' || c.status === 'ended' ? c.lastActivityAt : null,
    model,
    version: c.parsed.version,
    entrypoint: c.parsed.entrypoint,
    status: c.status,
    messageCount: c.signal?.lineCount ?? 0,
    controllable,
  };
}
