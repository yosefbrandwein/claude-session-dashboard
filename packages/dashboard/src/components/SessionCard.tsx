import { useEffect, useRef, useState } from 'react';
import type { MergedSession } from '../model';
import { StatusPill } from './StatusPill';
import { formatAgo, formatElapsed, formatStart } from '../util';

interface Props {
  session: MergedSession;
  /** Shared 1Hz clock from App — one timer drives all cards' relative time. */
  now: number;
  selected: boolean;
  onClick: () => void;
}

const STATUS_COLOR_VAR: Record<string, string> = {
  working: 'var(--st-working)',
  idle: 'var(--st-idle)',
  'awaiting-input': 'var(--st-awaiting)',
  'needs-attention': 'var(--st-attention)',
  stale: 'var(--st-stale)',
  ended: 'var(--st-ended)',
};

export function SessionCard({ session: s, now, selected, onClick }: Props) {
  // Relative-time rendering is driven by App's shared `now` clock (passed as a
  // prop) so a single timer ticks every card instead of one interval per card.

  // Flash the card briefly when the status transitions.
  const prevStatus = useRef(s.status);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prevStatus.current !== s.status) {
      prevStatus.current = s.status;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 700);
      return () => clearTimeout(id);
    }
  }, [s.status]);

  return (
    <div
      className={`card${selected ? ' selected' : ''}${flash ? ' flash' : ''}`}
      onClick={onClick}
    >
      <span
        className="accent-bar"
        style={{ background: STATUS_COLOR_VAR[s.status] ?? 'var(--st-stale)' }}
      />
      <div className="card-head">
        <div>
          <div className="project">{s.project}</div>
          {s.branch && (
            <span className="branch-chip" title={s.branch}>
              <span className="git">⎇</span>
              {s.branch}
            </span>
          )}
        </div>
        <StatusPill status={s.status} />
      </div>

      <div className="card-meta">
        <span className="k">Started</span>
        <span>
          {formatStart(s.startedAt)} · {formatElapsed(now - s.startedAt)}
        </span>
        <span className="k">Last activity</span>
        <span>{formatAgo(s.lastActivityAt, now)}</span>
        <span className="k">Messages</span>
        <span>{s.messageCount}</span>
        <span className="k">Model</span>
        <span>{s.model ?? '—'}</span>
      </div>

      <div className="card-foot">
        <span title={s.entrypoint ?? undefined}>
          {s.entrypoint ?? 'unknown entry'}
          {s.version ? ` · v${s.version}` : ''}
        </span>
        <span>{s.controllable ? 'controllable' : 'read-only'}</span>
      </div>
    </div>
  );
}
