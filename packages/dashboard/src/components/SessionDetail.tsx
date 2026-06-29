import { useState } from 'react';
import type { MergedSession } from '../model';
import { useSessionDetail, type PermissionRow } from '../hooks/useSessionDetail';
import { StatusPill } from './StatusPill';
import { formatAgo, formatElapsed, formatStart } from '../util';

interface Props {
  uid: string;
  session: MergedSession;
  now: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

export function SessionDetail({ uid, session: s, now, onClose, onToast }: Props) {
  const {
    messages,
    permissions,
    loaded,
    permsLoaded,
    commandInFlight,
    sendMessage,
    interrupt,
    decide,
  } = useSessionDetail(uid, s.sessionId, s.deviceId, (status, result) =>
    onToast(
      status === 'done'
        ? `Agent: ${result || 'done'}`
        : `Agent error: ${result || 'unknown error'}`,
    ),
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Messages only reach a session whose device has a LIVE agent. If the device is
  // stale/offline, the command would sit unprocessed — so block + explain instead.
  const offline = s.deviceStale || s.status === 'stale' || s.status === 'ended';

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await sendMessage(t);
      setText('');
      onToast('Message queued for the agent');
    } catch (e) {
      onToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const doInterrupt = async () => {
    try {
      await interrupt();
      onToast('Interrupt sent');
    } catch (e) {
      onToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doDecide = async (p: PermissionRow, approve: boolean) => {
    try {
      await decide(p.id, approve);
      onToast(approve ? 'Approval sent' : 'Denial sent');
    } catch (e) {
      onToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Session detail">
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <div className="ttl">{s.project}</div>
            <div className="sub">
              {s.deviceId} · {s.branch ?? 'no branch'}
            </div>
          </div>
          <StatusPill status={s.status} />
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-section">
            <h3>Session</h3>
            <div className="kv-grid">
              <span className="k">Session ID</span>
              <span className="v">{s.sessionId}</span>
              <span className="k">Started</span>
              <span className="v">
                {formatStart(s.startedAt)} · {formatElapsed(now - s.startedAt)} ago
              </span>
              <span className="k">Last activity</span>
              <span className="v">{formatAgo(s.lastActivityAt, now)}</span>
              <span className="k">Model</span>
              <span className="v">{s.model ?? '—'}</span>
              <span className="k">Version</span>
              <span className="v">{s.version ?? '—'}</span>
              <span className="k">Entrypoint</span>
              <span className="v">{s.entrypoint ?? '—'}</span>
              <span className="k">Messages</span>
              <span className="v">{s.messageCount}</span>
              <span className="k">Control</span>
              <span className="v">
                {s.controllable ? 'controllable' : 'read-only'}
              </span>
            </div>
          </div>

          <div className="drawer-section">
            <h3>
              Permission requests
              {permissions.length > 0 ? ` (${permissions.length})` : ''}
            </h3>
            {!permsLoaded && <p className="muted">Loading…</p>}
            {permsLoaded && permissions.length === 0 && (
              <p className="muted">No permission requests recorded.</p>
            )}
            {permissions.map((p) => {
              const pending = p.decision === 'pending';
              return (
                <div key={p.id} className={`perm${pending ? ' pending' : ''}`}>
                  <div className="perm-head">
                    <span className="tool">{p.tool}</span>
                    <span className={`decision-tag decision-${p.decision}`}>
                      {p.decision}
                    </span>
                  </div>
                  <div className="inp">{p.inputSummary}</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {formatAgo(p.ts, now)} · via {p.source}
                  </div>
                  {pending && (
                    <>
                      <div className="perm-actions">
                        <button
                          className="btn primary"
                          onClick={() => doDecide(p, true)}
                        >
                          Approve
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => doDecide(p, false)}
                        >
                          Deny
                        </button>
                      </div>
                      <p className="note">
                        Records the decision; it does not unblock a prompt in the
                        live desktop session (that needs the opt-in hooks).
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="drawer-section">
            <h3>
              Messages
              {messages.length > 0 ? ` (${messages.length})` : ''}
            </h3>
            {!loaded && <p className="muted">Loading…</p>}
            {loaded && messages.length === 0 && (
              <p className="muted">No message metadata captured.</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="msg">
                <div className="msg-head">
                  <span className={`role-tag role-${m.role}`}>{m.role}</span>
                  <span>{formatAgo(m.ts, now)}</span>
                  <span className="muted">· {m.kind}</span>
                </div>
                {m.summary && <div className="summary">{m.summary}</div>}
                {m.text && <div className="summary">{m.text}</div>}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="tool-pills">
                    {m.toolCalls.map((tc, i) => (
                      <span
                        key={i}
                        className="tool-pill"
                        title={tc.inputSummary}
                      >
                        {tc.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="compose">
          <textarea
            placeholder={
              s.controllable
                ? 'Send a message to this session…'
                : 'Session is read-only (agent reported not controllable)'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {offline ? (
            <p className="note warn">
              This device is offline — start its agent (run <code>scripts\install-startup.cmd</code>
              or <code>setup-device.cmd</code>) before sending. Messages only reach a device whose
              agent is running.
            </p>
          ) : (
            <p className="note">
              Sends a new headless turn via <code>claude --resume</code> on this
              conversation — it does not type into the open desktop window.
            </p>
          )}
          <div className="compose-row">
            <button
              className="btn danger"
              onClick={doInterrupt}
              disabled={!commandInFlight}
              title="Interrupt the in-flight headless turn"
            >
              Interrupt
            </button>
            {commandInFlight && (
              <span className="cmd-status">
                <span className="spinner" aria-hidden="true" /> working…
              </span>
            )}
            <span className="spacer" />
            <span className="muted">⌘/Ctrl + Enter</span>
            <button
              className="btn primary"
              onClick={send}
              disabled={sending || commandInFlight || !text.trim() || offline}
              title={offline ? 'The owning device is offline' : undefined}
            >
              {sending || commandInFlight ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
