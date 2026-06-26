import type { GroupMode, SortMode } from '../util';
import { STATUS_LABEL } from '../model';
import type { SessionStatus } from '../../../../shared/src/types';

interface Props {
  group: GroupMode;
  setGroup: (g: GroupMode) => void;
  sort: SortMode;
  setSort: (s: SortMode) => void;
  statusFilter: SessionStatus | 'all';
  setStatusFilter: (s: SessionStatus | 'all') => void;
  search: string;
  setSearch: (s: string) => void;
}

const STATUSES: SessionStatus[] = [
  'working',
  'idle',
  'awaiting-input',
  'needs-attention',
  'stale',
  'ended',
];

export function Toolbar(p: Props) {
  return (
    <div className="toolbar">
      <div className="group-toggle" role="group" aria-label="Group by">
        <button
          className={p.group === 'device-project' ? 'active' : ''}
          onClick={() => p.setGroup('device-project')}
        >
          Device → Project
        </button>
        <button
          className={p.group === 'project-device' ? 'active' : ''}
          onClick={() => p.setGroup('project-device')}
        >
          Project → Device
        </button>
        <button
          className={p.group === 'flat' ? 'active' : ''}
          onClick={() => p.setGroup('flat')}
        >
          Flat
        </button>
      </div>

      <input
        className="input search"
        placeholder="Search project / branch / device…"
        value={p.search}
        onChange={(e) => p.setSearch(e.target.value)}
      />

      <label className="field">
        Status
        <select
          className="select"
          value={p.statusFilter}
          onChange={(e) =>
            p.setStatusFilter(e.target.value as SessionStatus | 'all')
          }
        >
          <option value="all">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        Sort
        <select
          className="select"
          value={p.sort}
          onChange={(e) => p.setSort(e.target.value as SortMode)}
        >
          <option value="newest">Newest</option>
          <option value="most-active">Most active</option>
          <option value="longest-running">Longest running</option>
        </select>
      </label>
    </div>
  );
}
