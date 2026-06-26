// ============================================================================
// PURE collector logic — no filesystem, no clock-of-record, no process probing.
// Everything here is a deterministic function of its inputs so it can be unit
// tested against fixtures (test/fixtures/) WITHOUT touching real ~/.claude.
//
// The I/O shell (io.ts) reads files, lists PIDs, and stamps the wall clock, then
// hands plain data to these functions. map.ts turns the results into the shared
// wire shapes (SessionDoc / PresenceRecord / MessageDoc / PermissionRequestDoc).
// ============================================================================
import type { SessionStatus } from '../../../../shared/src/types';
import type {
  RawSessionFile,
  RawTranscriptEntry,
  RawContentBlock,
} from './rawTypes';

/** A session file successfully parsed + validated into the fields we require. */
export interface ParsedSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  version: string | null;
  entrypoint: string | null;
  kind: string | null;
  /** True if this session's daemon advertises the peer protocol (Tier B hint). */
  peerProtocol: number | null;
}

/** Activity signal extracted from a transcript file (pure: caller provides mtime). */
export interface TranscriptSignal {
  /** Total RAW lines emitted by the reader (blank lines included). Shares one
   *  coordinate space with readTranscriptEntriesFrom's totalLines / lineIndex so
   *  the incremental reader and the command base index agree (see F2). */
  lineCount: number;
  /** Epoch ms of the newest parseable entry timestamp, else null. */
  lastEntryTs: number | null;
  /** File mtime (epoch ms) the caller stat-ed; used as an activity fallback. */
  mtimeMs: number;
}

/** Threshold: transcript touched within this window ⇒ 'working'. */
export const WORKING_WINDOW_MS = 10_000;

/**
 * Parse + validate one ~/.claude/sessions/<pid>.json blob. Returns null when the
 * blob is missing the fields we cannot operate without (pid / sessionId / cwd),
 * so a corrupt or partial file is skipped rather than crashing the loop.
 */
export function parseSessionFile(raw: RawSessionFile | null | undefined): ParsedSession | null {
  if (!raw) return null;
  const { pid, sessionId, cwd } = raw;
  if (typeof pid !== 'number' || !Number.isFinite(pid)) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return {
    pid,
    sessionId,
    cwd,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    version: typeof raw.version === 'string' ? raw.version : null,
    entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : null,
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    peerProtocol: typeof raw.peerProtocol === 'number' ? raw.peerProtocol : null,
  };
}

/** basename of a cwd path, handling both \ and / separators. */
export function projectFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

/**
 * Derive the live status of a session from PID liveness + transcript activity.
 *
 *   stale   — the file exists but the PID is no longer a live process.
 *   working — PID alive AND transcript was appended within WORKING_WINDOW_MS.
 *   idle    — PID alive but transcript quiet (commonly awaiting user input).
 *
 * We deliberately do NOT emit 'awaiting-input' / 'needs-attention' from pure
 * transcript parsing: those are precise hook signals. Without hooks the honest
 * mapping of a quiet-but-alive session is 'idle'. (See README "Status without
 * hooks".)
 *
 * `now` is injected so the same instant drives every decision and tests are
 * deterministic. `signal` is null when no transcript file was found yet.
 */
export function deriveStatus(
  pidAlive: boolean,
  signal: TranscriptSignal | null,
  now: number,
): SessionStatus {
  if (!pidAlive) return 'stale';
  if (!signal) return 'idle';
  const lastActivity = activityTimestamp(signal);
  if (lastActivity != null && now - lastActivity <= WORKING_WINDOW_MS) {
    return 'working';
  }
  return 'idle';
}

/** Best activity timestamp: newest entry ts if present, else file mtime. */
export function activityTimestamp(signal: TranscriptSignal | null): number | null {
  if (!signal) return null;
  return signal.lastEntryTs ?? signal.mtimeMs ?? null;
}

// ---------------------------------------------------------------------------
// Transcript line parsing → metadata-only MessageDoc-ish records.
// ---------------------------------------------------------------------------

/** A parsed transcript entry reduced to publish-ready metadata (no raw text). */
export interface ParsedMessage {
  ts: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  kind: string;
  toolCalls?: { name: string; inputSummary: string }[];
  summary?: string;
}

/**
 * Best-effort permission-request signal extracted from a transcript.
 *
 * HONEST LIMITATION: an *accepted* permission prompt leaves no distinct marker
 * in the transcript — it appears as an ordinary tool_use → tool_result pair.
 * The only reliably detectable signal is a tool_result with is_error=true whose
 * text matches a known rejection phrase. So transcript-only capture sees
 * DENIED / blocked tool uses, not the pending prompt itself. Precise pending
 * prompts require the opt-in PreToolUse/Notification hooks (scripts/install-hooks).
 */
export interface ParsedPermission {
  tool: string;
  inputSummary: string;
  ts: number;
  decision: 'denied';
}

/** Phrases Claude Code emits in a tool_result when a tool use is blocked/denied. */
const PERMISSION_DENIAL_PATTERNS: RegExp[] = [
  /requested permissions?.*(?:haven't|hasn't|not been) granted/i,
  /permission to use .* (?:was|has been) (?:denied|rejected)/i,
  /user (?:doesn't want to proceed|rejected|denied)/i,
  /tool use was (?:rejected|denied|blocked)/i,
  /operation was (?:blocked|rejected) by/i,
];

function parseTs(entry: RawTranscriptEntry, fallback: number): number {
  if (typeof entry.timestamp === 'string') {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

/** Map a transcript entry `type` + message role onto our 4 metadata roles. */
function roleFor(entry: RawTranscriptEntry): ParsedMessage['role'] | null {
  const t = entry.type;
  if (t === 'assistant') return 'assistant';
  if (t === 'system') return 'system';
  if (t === 'user') {
    // A "user" entry can be a real user turn OR a tool_result carrier.
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
      return 'tool';
    }
    return 'user';
  }
  return null; // queue-operation, summary, attachment, etc. → not a message
}

/** Truncate + single-line a value for a non-sensitive summary. */
function shorten(value: unknown, max = 80): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else if (value == null) s = '';
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Summarize a tool_use input WITHOUT leaking full content. We pick the most
 * descriptive single field per tool, falling back to the first scalar field.
 */
export function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const prefer: Record<string, string[]> = {
    Bash: ['description', 'command'],
    Read: ['file_path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    Task: ['description'],
    Agent: ['description'],
    WebFetch: ['url'],
    WebSearch: ['query'],
  };
  for (const key of prefer[name] ?? []) {
    if (key in input) return shorten(input[key]);
  }
  // Generic fallback: first scalar field.
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return shorten(`${k}=${v}`);
    }
  }
  return '';
}

function toolCallsFromContent(content: RawContentBlock[]): { name: string; inputSummary: string }[] {
  const calls: { name: string; inputSummary: string }[] = [];
  for (const c of content) {
    if (c.type === 'tool_use' && typeof c.name === 'string') {
      calls.push({ name: c.name, inputSummary: summarizeToolInput(c.name, c.input) });
    }
  }
  return calls;
}

/** Flatten a tool_result content payload into a searchable string. */
function toolResultText(content: RawContentBlock[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type !== 'tool_result') continue;
    const inner = c.content;
    if (typeof inner === 'string') parts.push(inner);
    else if (Array.isArray(inner)) {
      for (const b of inner as RawContentBlock[]) {
        if (typeof b?.text === 'string') parts.push(b.text);
        else if (typeof b === 'string') parts.push(b);
      }
    }
  }
  return parts.join(' ');
}

/**
 * Parse one transcript entry into metadata. Returns null for entry types that
 * are not messages (queue-operation, summary, attachment-only, …). `fallbackTs`
 * is used when the entry has no/invalid timestamp (e.g. line index * 0 + base).
 */
export function parseTranscriptEntry(
  entry: RawTranscriptEntry | null | undefined,
  fallbackTs: number,
): ParsedMessage | null {
  if (!entry || typeof entry !== 'object') return null;
  const role = roleFor(entry);
  if (!role) return null;
  const ts = parseTs(entry, fallbackTs);
  const content = entry.message?.content;

  const msg: ParsedMessage = { ts, role, kind: entry.type ?? 'unknown' };

  if (Array.isArray(content)) {
    const calls = toolCallsFromContent(content);
    if (calls.length) msg.toolCalls = calls;
    // Summary: prefer a leading text block; else describe the shape.
    const firstText = content.find((c) => c.type === 'text' && typeof c.text === 'string');
    if (firstText?.text) msg.summary = shorten(firstText.text);
    else if (calls.length) msg.summary = `${calls.length} tool call(s)`;
    else {
      const kinds = [...new Set(content.map((c) => c.type).filter(Boolean))];
      if (kinds.length) msg.summary = kinds.join('+');
    }
  } else if (typeof content === 'string') {
    msg.summary = shorten(content);
  }
  return msg;
}

/**
 * Best-effort: detect a DENIED/blocked tool use in a transcript entry. See
 * ParsedPermission for the honest limitation (pending prompts aren't visible).
 * We pair the failing tool_result text with the tool_use name from the SAME
 * entry when present; otherwise the tool name is 'unknown'.
 */
export function parsePermissionDenial(
  entry: RawTranscriptEntry | null | undefined,
  fallbackTs: number,
): ParsedPermission | null {
  if (!entry || entry.type !== 'user') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const errored = content.find((c) => c.type === 'tool_result' && c.is_error === true);
  if (!errored) return null;
  const text = toolResultText(content);
  if (!PERMISSION_DENIAL_PATTERNS.some((re) => re.test(text))) return null;
  // tool_result carriers don't name the tool; the name lived in the prior
  // assistant tool_use. Caller may enrich; here we surface what's local.
  const toolUse = content.find((c) => c.type === 'tool_use');
  return {
    tool: typeof toolUse?.name === 'string' ? toolUse.name : 'unknown',
    inputSummary: shorten(text, 120),
    ts: parseTs(entry, fallbackTs),
    decision: 'denied',
  };
}
