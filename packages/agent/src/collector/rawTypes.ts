// Raw on-disk shapes found under ~/.claude. These are the agent's *internal*
// view of Claude's private files — NOT part of the shared wire contract. They
// are intentionally permissive (every field optional) because they belong to
// Claude Code, can change between versions, and we only read a best-effort
// subset. Anything we publish is mapped onto the shared shapes in map.ts.

/** One file per running claude PID: ~/.claude/sessions/<pid>.json */
export interface RawSessionFile {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number; // epoch ms
  procStart?: string; // opaque high-res process start token
  version?: string; // Claude Code version, e.g. "2.1.181"
  peerProtocol?: number;
  kind?: string; // e.g. "interactive"
  entrypoint?: string; // e.g. "claude-desktop"
}

/**
 * One JSON object per line in a transcript .jsonl. Mixed `type`s:
 *   user | assistant | system | queue-operation | summary | ...
 * Only the fields we actually use are typed; everything else is ignored.
 */
export interface RawTranscriptEntry {
  type?: string;
  timestamp?: string; // ISO string
  sessionId?: string;
  gitBranch?: string | null;
  version?: string;
  message?: RawMessage;
  // Present on some attachment/queue entries — ignored for metadata.
  [k: string]: unknown;
}

export interface RawMessage {
  role?: 'user' | 'assistant' | 'system' | string;
  model?: string;
  // content is either a plain string (simple user turns) or an array of
  // content blocks (assistant turns, tool results).
  content?: string | RawContentBlock[];
  stop_reason?: string | null;
}

export interface RawContentBlock {
  type?: string; // 'text' | 'thinking' | 'tool_use' | 'tool_result' | ...
  name?: string; // tool_use: tool name
  input?: Record<string, unknown>; // tool_use input
  is_error?: boolean; // tool_result: error flag
  content?: unknown; // tool_result payload (string or blocks)
  text?: string; // text block
}
