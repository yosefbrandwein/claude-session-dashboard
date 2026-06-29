import type { SessionStatus } from '../../../../shared/src/types';
import { STATUS_LABEL } from '../model';

const ORDER: SessionStatus[] = [
  'working',
  'idle',
  'awaiting-input',
  'needs-attention',
  'stale',
  'ended',
];

const DOT: Record<SessionStatus, string> = {
  working: 'var(--st-working)',
  idle: 'var(--st-idle)',
  'awaiting-input': 'var(--st-awaiting)',
  'needs-attention': 'var(--st-attention)',
  stale: 'var(--st-stale)',
  ended: 'var(--st-ended)',
};

interface Props {
  counts: Record<SessionStatus, number>;
  total: number;
  value: SessionStatus | 'all';
  onChange: (v: SessionStatus | 'all') => void;
}

/**
 * Per-state filter: one clickable chip per status (with its live count). Clicking
 * a chip filters to that state; clicking the active chip again clears back to All.
 * Statuses with no sessions are hidden (unless currently selected) to stay tidy.
 */
export function StatusFilterBar({ counts, total, value, onChange }: Props) {
  const shown = ORDER.filter((s) => counts[s] > 0 || value === s);
  return (
    <div className="status-filter" role="group" aria-label="Filter by status">
      <button
        className={`sf-chip${value === 'all' ? ' active' : ''}`}
        onClick={() => onChange('all')}
      >
        All <span className="sf-count">{total}</span>
      </button>
      {shown.map((s) => (
        <button
          key={s}
          className={`sf-chip${value === s ? ' active' : ''}`}
          onClick={() => onChange(value === s ? 'all' : s)}
          title={`Show only ${STATUS_LABEL[s]} sessions`}
        >
          <span className="sf-dot" style={{ background: DOT[s] }} />
          {STATUS_LABEL[s]} <span className="sf-count">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}
