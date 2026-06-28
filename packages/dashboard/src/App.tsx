import { useEffect, useMemo, useState } from 'react';
import { useAuth, hasGoogle } from './hooks/useAuth';
import { useSessions } from './hooks/useSessions';
import { AuthScreen } from './components/AuthScreen';
import { Toolbar } from './components/Toolbar';
import { SessionGroupList } from './components/SessionGroupList';
import { SessionDetail } from './components/SessionDetail';
import {
  activeCount,
  deviceCount,
  filterSessions,
  groupSessions,
  sortSessions,
  type GroupMode,
  type SortMode,
} from './util';
import { USE_EMULATORS } from './firebase';
import type { SessionStatus } from '../../../shared/src/types';

export function App() {
  const { user, initializing, signIn, signUp, signInWithGoogle, linkGoogle, logout } = useAuth();

  if (initializing) {
    return (
      <div className="auth-wrap">
        <div className="muted">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onSignIn={signIn} onSignUp={signUp} onGoogle={signInWithGoogle} />;
  }

  return (
    <Dashboard
      uid={user.uid}
      email={user.email ?? ''}
      googleLinked={hasGoogle(user)}
      onLinkGoogle={linkGoogle}
      onLogout={logout}
    />
  );
}

function Dashboard({
  uid,
  email,
  googleLinked,
  onLinkGoogle,
  onLogout,
}: {
  uid: string;
  email: string;
  googleLinked: boolean;
  onLinkGoogle: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { sessions, presenceLoaded, sessionsLoaded } = useSessions(uid);

  const [group, setGroup] = useState<GroupMode>('device-project');
  const [sort, setSort] = useState<SortMode>('newest');
  const [statusFilter, setStatusFilter] = useState<SessionStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // One shared clock for the drawer's relative-time rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const visible = useMemo(() => {
    const filtered = filterSessions(sessions, statusFilter, search);
    return sortSessions(filtered, sort);
  }, [sessions, statusFilter, search, sort]);

  const groups = useMemo(() => groupSessions(visible, group), [visible, group]);

  const selected = useMemo(
    () => sessions.find((s) => s.key === selectedKey) ?? null,
    [sessions, selectedKey],
  );

  const totalActive = activeCount(sessions);
  const devices = deviceCount(sessions);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Claude Sessions
        </div>
        <div className="summary">
          <strong>{totalActive}</strong> active across{' '}
          <strong>{devices}</strong> device{devices === 1 ? '' : 's'}
          {sessions.length !== totalActive && (
            <> · {sessions.length} total</>
          )}
        </div>
        <div className="spacer" />
        {USE_EMULATORS && <span className="muted">emulator</span>}
        <div className="user-chip">
          {email}
          {!googleLinked && (
            <button
              className="btn ghost"
              title="Attach Google to this account so you can sign in with Google next time (same account, same sessions)."
              onClick={() =>
                void onLinkGoogle().catch((e) =>
                  setToast(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Link Google
            </button>
          )}
          <button className="btn ghost" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </header>

      <Toolbar
        group={group}
        setGroup={setGroup}
        sort={sort}
        setSort={setSort}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        search={search}
        setSearch={setSearch}
      />

      <main className="content">
        {visible.length === 0 ? (
          // Don't show the terminal "No sessions yet" copy until BOTH backend
          // snapshots have resolved; otherwise the initial round-trip flashes
          // the empty state even when sessions exist.
          !presenceLoaded || !sessionsLoaded ? (
            <div className="empty muted">Loading sessions…</div>
          ) : (
            <div className="empty">
              {sessions.length === 0
                ? 'No sessions yet. Start a Claude Code session with the agent running to see it here.'
                : 'No sessions match the current filters.'}
            </div>
          )
        ) : (
          <SessionGroupList
            groups={groups}
            groupMode={group}
            now={now}
            selectedKey={selectedKey}
            onSelect={(s) => setSelectedKey(s.key)}
          />
        )}
      </main>

      {selected && (
        <SessionDetail
          uid={uid}
          session={selected}
          now={now}
          onClose={() => setSelectedKey(null)}
          onToast={setToast}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
