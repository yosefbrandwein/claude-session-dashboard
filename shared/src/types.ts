// ============================================================================
// SHARED DATA CONTRACT  — the single source of truth wired between all 3 parts:
//   • packages/agent      (writes presence + durable metadata, reads commands)
//   • packages/dashboard  (reads presence + metadata, writes commands)
//   • firestore.rules / database.rules.json (enforce these shapes)
// Changing a shape here is a breaking change for every package. Keep it stable.
// ============================================================================

/** Live status of a single Claude session, derived by the agent. */
export type SessionStatus =
  | 'working'        // transcript actively appending / hook says a turn is running
  | 'idle'           // PID alive, no recent activity (often awaiting your input)
  | 'awaiting-input' // Stop hook fired — Claude is waiting on the user
  | 'needs-attention'// permission prompt / Notification hook
  | 'stale'          // session file present but PID dead, or heartbeat timed out
  | 'ended';         // session closed

/** RTDB: /presence/{uid}/{deviceId}/{sessionId} — ephemeral, high-frequency. */
export interface PresenceRecord {
  status: SessionStatus;
  project: string;        // basename(cwd)
  branch: string | null;  // git branch if known
  pid: number;
  startedAt: number;      // epoch ms
  lastActivityAt: number; // epoch ms
  heartbeatAt: number;    // epoch ms — agent stamps every tick
}

/** Firestore: users/{uid}/devices/{deviceId} */
export interface DeviceDoc {
  deviceId: string;       // stable per machine (hostname hash)
  hostname: string;
  os: string;             // 'win32' | 'darwin' | 'linux'
  agentVersion: string;
  firstSeen: number;
  lastSeen: number;
}

/** Firestore: users/{uid}/sessions/{sessionId} — durable record. */
export interface SessionDoc {
  sessionId: string;
  deviceId: string;
  /** Human-readable session title (Claude's auto-generated "Recents" name); null if unknown. */
  title: string | null;
  project: string;
  cwd: string;
  gitBranch: string | null;
  startedAt: number;
  endedAt: number | null;
  model: string | null;
  version: string | null;   // Claude Code version
  entrypoint: string | null;// e.g. 'claude-desktop'
  status: SessionStatus;
  messageCount: number;
  controllable: boolean;    // true if the agent can inject messages into it
}

/** Firestore: users/{uid}/sessions/{sessionId}/messages/{messageId}
 *  METADATA ONLY by default — `text` is populated only when the user opts in. */
export interface MessageDoc {
  ts: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: string;                              // raw transcript entry type
  toolCalls?: { name: string; inputSummary: string }[];
  summary?: string;                          // short, non-sensitive
  text?: string;                             // only if content-capture opted in
}

/** Firestore: users/{uid}/sessions/{sessionId}/permissionRequests/{reqId} */
export interface PermissionRequestDoc {
  tool: string;
  inputSummary: string;
  ts: number;
  decision: 'pending' | 'approved' | 'denied' | 'auto';
  decidedAt: number | null;
  decidedBy: 'user-local' | 'dashboard' | null;
  source: 'hook' | 'sdk';   // how it was captured
}

/** Firestore: users/{uid}/commands/{cmdId} — dashboard -> agent control channel. */
export type CommandType = 'sendMessage' | 'interrupt' | 'approve' | 'deny';
export interface CommandDoc {
  type: CommandType;
  sessionId: string;
  /** Target device (deviceId of the session). Agents ONLY process commands for
   *  their own device — without this, every device's agent picks up every
   *  command and the ones that don't own the session report "unknown/ended". */
  deviceId?: string;
  payload?: { text?: string; reqId?: string };
  status: 'pending' | 'acked' | 'done' | 'error';
  createdAt: number;
  result?: string;
}

/** Firestore path helpers — use everywhere to avoid path typos. */
export const paths = {
  device: (uid: string, deviceId: string) => `users/${uid}/devices/${deviceId}`,
  session: (uid: string, sessionId: string) => `users/${uid}/sessions/${sessionId}`,
  messages: (uid: string, sessionId: string) => `users/${uid}/sessions/${sessionId}/messages`,
  permissionRequests: (uid: string, sessionId: string) =>
    `users/${uid}/sessions/${sessionId}/permissionRequests`,
  commands: (uid: string) => `users/${uid}/commands`,
  presence: (uid: string, deviceId: string, sessionId: string) =>
    `presence/${uid}/${deviceId}/${sessionId}`,
};
