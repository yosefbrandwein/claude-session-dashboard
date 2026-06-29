import { useState } from 'react';
import type { SessionGroup } from '../util';
import { activeCount } from '../util';
import type { GroupMode } from '../util';
import type { MergedSession } from '../model';
import { SessionCard } from './SessionCard';

interface Props {
  groups: SessionGroup[];
  groupMode: GroupMode;
  /** Shared 1Hz clock from App, threaded down so one timer drives all cards. */
  now: number;
  selectedKey: string | null;
  onSelect: (s: MergedSession) => void;
  onDismiss: (s: MergedSession) => void;
}

export function SessionGroupList({
  groups,
  groupMode,
  now,
  selectedKey,
  onSelect,
  onDismiss,
}: Props) {
  // Collapsed groups tracked by key; default expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        const active = activeCount(g.sessions);
        const showHead = groupMode !== 'flat';
        return (
          <div key={g.key} className={`group${g.allStale ? ' stale' : ''}`}>
            {showHead && (
              <div
                className={`group-head${isCollapsed ? ' collapsed' : ''}`}
                onClick={() => toggle(g.key)}
              >
                <span className="chev">▼</span>
                <span className="title">{g.primary}</span>
                <span className="meta">
                  {active} active · {g.sessions.length} session
                  {g.sessions.length === 1 ? '' : 's'}
                </span>
                {g.allStale && <span className="stale-tag">device stale</span>}
              </div>
            )}
            {!isCollapsed &&
              g.subgroups.map((sub) => (
                <div key={sub.key}>
                  {showHead && sub.label && (
                    <div className="subgroup-label">{sub.label}</div>
                  )}
                  <div className="cards">
                    {sub.sessions.map((s) => (
                      <SessionCard
                        key={s.key}
                        session={s}
                        now={now}
                        selected={s.key === selectedKey}
                        onClick={() => onSelect(s)}
                        onDismiss={() => onDismiss(s)}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}
