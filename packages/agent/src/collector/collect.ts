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
  /** Tier B candidacy: an interactive session advertising the peer protocol. */
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
      // An interactive desktop session that advertises peerProtocol is the
      // Tier B injection candidate (see daemon findings in README).
      controllableHint: pidAlive && parsed.peerProtocol != null && parsed.kind === 'interactive',
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
): SessionDoc {
  return {
    sessionId: c.parsed.sessionId,
    deviceId,
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
