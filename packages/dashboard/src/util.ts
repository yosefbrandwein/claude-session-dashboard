import type { MergedSession } from './model';
import { ACTIVE_STATUSES } from './model';
import type { SessionStatus } from '../../../shared/src/types';

export type GroupMode = 'device-project' | 'project-device' | 'flat';
export type SortMode = 'newest' | 'most-active' | 'longest-running';

/** Format a millisecond duration as a compact elapsed string (e.g. 1h 04m). */
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const sec = s % 60;
  const min = Math.floor(s / 60) % 60;
  const hr = Math.floor(s / 3600) % 24;
  const day = Math.floor(s / 86400);
  if (day > 0) return `${day}d ${hr.toString().padStart(2, '0')}h`;
  if (hr > 0) return `${hr}h ${min.toString().padStart(2, '0')}m`;
  if (min > 0) return `${min}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

/** "Xs ago" / "Xm ago" relative time for a past epoch-ms timestamp. */
export function formatAgo(tsMs: number, now: number): string {
  const ms = now - tsMs;
  if (ms < 1500) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Wall-clock start time, locale-formatted (HH:MM). */
export function formatStart(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 1 for active sessions, 0 otherwise — used as a primary sort key. */
const activeRank = (s: MergedSession): number =>
  ACTIVE_STATUSES.has(s.status) ? 1 : 0;

/** Stable secondary tie-break so equal-timestamp rows keep a fixed order. */
const bySessionId = (a: MergedSession, b: MergedSession): number =>
  a.sessionId.localeCompare(b.sessionId);

export function sortSessions(
  sessions: MergedSession[],
  mode: SortMode,
): MergedSession[] {
  const copy = [...sessions];
  switch (mode) {
    case 'newest':
      copy.sort(
        (a, b) => b.startedAt - a.startedAt || bySessionId(a, b),
      );
      break;
    case 'most-active':
      // Active sessions always rank ahead of ended/stale ones, so a recently
      // ended session can't outrank a live working one; then most-recent
      // activity, then a stable id tie-break.
      copy.sort(
        (a, b) =>
          activeRank(b) - activeRank(a) ||
          b.lastActivityAt - a.lastActivityAt ||
          bySessionId(a, b),
      );
      break;
    case 'longest-running':
      // Longest-running == oldest start time first, but active sessions rank
      // ahead of ended/stale ones; stable id tie-break for equal starts.
      copy.sort(
        (a, b) =>
          activeRank(b) - activeRank(a) ||
          a.startedAt - b.startedAt ||
          bySessionId(a, b),
      );
      break;
  }
  return copy;
}

export function filterSessions(
  sessions: MergedSession[],
  statusFilter: SessionStatus | 'all',
  search: string,
): MergedSession[] {
  const q = search.trim().toLowerCase();
  return sessions.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (q) {
      const hay = `${s.project} ${s.branch ?? ''} ${s.deviceId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface SessionGroup {
  key: string;
  /** Top-level label (device or project depending on mode). */
  primary: string;
  /** Sub-groups keyed by secondary label → sessions. */
  subgroups: { key: string; label: string; sessions: MergedSession[] }[];
  sessions: MergedSession[]; // flattened, for counts
  /** True when every session in the group belongs to a stale device. */
  allStale: boolean;
}

/** Build the two-level (or flat) grouping the dashboard renders. */
export function groupSessions(
  sessions: MergedSession[],
  mode: GroupMode,
): SessionGroup[] {
  if (mode === 'flat') {
    return [
      {
        key: 'all',
        primary: 'All sessions',
        subgroups: [{ key: 'all', label: '', sessions }],
        sessions,
        allStale: sessions.length > 0 && sessions.every((s) => s.deviceStale),
      },
    ];
  }

  const primaryOf = (s: MergedSession) =>
    mode === 'device-project' ? s.deviceId : s.project;
  const secondaryOf = (s: MergedSession) =>
    mode === 'device-project' ? s.project : s.deviceId;

  const byPrimary = new Map<string, MergedSession[]>();
  for (const s of sessions) {
    const p = primaryOf(s);
    if (!byPrimary.has(p)) byPrimary.set(p, []);
    byPrimary.get(p)!.push(s);
  }

  const groups: SessionGroup[] = [];
  for (const [primary, list] of [...byPrimary.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const bySecondary = new Map<string, MergedSession[]>();
    for (const s of list) {
      const sec = secondaryOf(s);
      if (!bySecondary.has(sec)) bySecondary.set(sec, []);
      bySecondary.get(sec)!.push(s);
    }
    const subgroups = [...bySecondary.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, sub]) => ({ key: `${primary}::${label}`, label, sessions: sub }));

    groups.push({
      key: primary,
      primary,
      subgroups,
      sessions: list,
      allStale: list.length > 0 && list.every((s) => s.deviceStale),
    });
  }
  return groups;
}

export function activeCount(sessions: MergedSession[]): number {
  return sessions.filter((s) => ACTIVE_STATUSES.has(s.status)).length;
}

export function deviceCount(sessions: MergedSession[]): number {
  // Count only devices with at least one ACTIVE session, so the header's
  // "across M devices" doesn't inflate M with ended/stale-only devices.
  return new Set(
    sessions
      .filter((s) => ACTIVE_STATUSES.has(s.status))
      .map((s) => s.deviceId),
  ).size;
}
