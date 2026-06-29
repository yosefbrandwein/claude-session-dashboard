// ============================================================================
// TIER A — guaranteed-fallback message injection via the headless Claude CLI.
//
//   claude -p "<text>" --resume <sessionId> --output-format stream-json --verbose
//
// We spawn a NON-interactive `claude --print` run that RESUMES the target
// session, then stream its stream-json events back so the caller can persist the
// assistant output as MessageDocs. This does NOT touch the user's live
// interactive window — it forks a fresh headless turn on the same conversation
// history. (That's the honest semantic of --resume in print mode.)
//
// Flags verified via `claude --help`:
//   -p, --print                 print response and exit
//   -r, --resume [sessionId]    resume a conversation by session id
//   --output-format stream-json realtime JSONL events (needs --verbose)
//   --model <model>             optional model override
// ============================================================================
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve the claude executable to spawn. CRITICAL on Windows: the thing on PATH
 * is the npm shim `claude.cmd`, and Node refuses to spawn a `.cmd` without
 * `shell:true` — but shell:true would interpolate our prompt arg through cmd.exe
 * (command injection). So we resolve the REAL native `claude.exe` that the shim
 * ultimately execs and spawn it directly with shell:false. Override with
 * CSD_CLAUDE_BIN if claude is installed elsewhere.
 */
export function resolveClaudeBin(): string {
  if (process.env.CSD_CLAUDE_BIN) return process.env.CSD_CLAUDE_BIN;
  if (process.platform === 'win32') {
    const rel = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];
    const roots = [
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
    ].filter(Boolean) as string[];
    for (const root of roots) {
      const candidate = path.join(root, ...rel);
      if (existsSync(candidate)) return candidate;
    }
    return 'claude.exe'; // last resort (still shell:false, no injection)
  }
  return 'claude'; // posix shim is directly executable
}

export interface TierAOptions {
  sessionId: string;
  text: string;
  cwd?: string;
  model?: string;
  /** Override the binary (tests). Default 'claude'. */
  bin?: string;
  /**
   * Security posture for a dashboard-driven run:
   *  - 'safe' (DEFAULT): deny shell/file-write/network tools so a remote message
   *    can NEVER execute destructive actions, even if the resumed project has
   *    them auto-approved. Claude can still read/answer.
   *  - 'full': no restriction (explicit opt-in via CSD_COMMAND_MODE=full).
   */
  sandbox?: 'safe' | 'full';
  /** Extra args appended after the standard flags (e.g. ['--allowedTools','Read']). */
  extraArgs?: string[];
  /**
   * Args placed BEFORE the standard claude flags. Used by tests to run
   * `node fake-claude.mjs …` (bin=node, prependArgs=[scriptPath]). Not used in
   * production.
   */
  prependArgs?: string[];
  /** Injectable spawn (tests). Defaults to node:child_process.spawn. */
  spawnFn?: typeof nodeSpawn;
}

/**
 * Tools a sandboxed (dashboard-driven) run is DENIED. Deny rules take precedence
 * over any allow-list, so even a project that auto-approves `Bash(powershell *)`
 * cannot be made to execute these via a remote message. Covers shell execution,
 * file mutation, network/exfiltration, and sub-agent spawning.
 */
export const SANDBOX_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'SlashCommand',
];

/** Build the full argv for a Tier A run (pure — unit-testable). */
export function buildTierAArgs(opts: TierAOptions): string[] {
  const args = [...(opts.prependArgs ?? [])];
  args.push(
    '--print',
    '--resume',
    opts.sessionId,
    '--output-format',
    'stream-json',
    '--verbose', // required for stream-json to emit per-event lines
  );
  if (opts.model) args.push('--model', opts.model);
  // SECURITY (default): a dashboard-driven run is SANDBOXED. We force the
  // non-bypassing 'default' permission mode (so a resumed session can't carry a
  // bypassPermissions posture) and deny the destructive tool set. This turns the
  // sendMessage primitive from "arbitrary RCE" into "read-only assistant" unless
  // the operator explicitly opts the whole agent into CSD_COMMAND_MODE=full.
  if (opts.sandbox !== 'full') {
    args.push('--permission-mode', 'default');
    args.push('--disallowedTools', SANDBOX_DISALLOWED_TOOLS.join(','));
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  // The prompt is passed positionally LAST so it isn't mistaken for a flag value.
  args.push(opts.text);
  return args;
}

/** A normalized event we surface from the CLI's stream-json output. */
export interface TierAEvent {
  type: string; // raw stream-json event type
  role?: 'assistant' | 'user' | 'system';
  text?: string; // assistant text deltas / final text
  toolCalls?: { name: string; inputSummary: string }[];
  raw: unknown;
}

/**
 * A controllable Tier A run. Emits:
 *   'event'  (TierAEvent)  — per stream-json line
 *   'result' (string)      — final result text (from the terminal 'result' event)
 *   'error'  (Error)
 *   'close'  ({ code })    — process exit
 * Call `.interrupt()` to cancel (kills the child process).
 */
export class TierARun extends EventEmitter {
  private child: ChildProcess | null = null;
  private _killed = false;
  finalResult: string | null = null;

  constructor(private opts: TierAOptions) {
    super();
  }

  start(): this {
    const bin = this.opts.bin ?? resolveClaudeBin();
    const args = buildTierAArgs(this.opts);
    const spawn = this.opts.spawnFn ?? nodeSpawn;

    const child = spawn(bin, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
      // stdin closed: a print run reads its prompt from argv, not stdin.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));

    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d.toString()));

    child.on('error', (e) => this.emit('error', e));
    child.on('close', (code) => {
      if (code !== 0 && !this._killed && stderr.trim()) {
        this.emit('error', new Error(`claude exited ${code}: ${stderr.trim().slice(0, 400)}`));
      }
      this.emit('close', { code });
    });
    return this;
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let obj: any;
    try {
      obj = JSON.parse(t);
    } catch {
      return; // non-JSON noise
    }
    const ev = normalizeEvent(obj);
    this.emit('event', ev);
    // The CLI's terminal event has type 'result' with a 'result' string.
    if (obj.type === 'result' && typeof obj.result === 'string') {
      this.finalResult = obj.result;
      this.emit('result', obj.result);
    }
  }

  /** Cancel the run (interrupt command). Idempotent. */
  interrupt(): void {
    if (this._killed) return;
    this._killed = true;
    this.child?.kill('SIGTERM');
    // Hard-kill after a grace period if it ignores SIGTERM.
    setTimeout(() => this.child?.kill('SIGKILL'), 2000).unref?.();
  }

  get killed(): boolean {
    return this._killed;
  }
}

/** Map a raw stream-json object onto our normalized TierAEvent. */
export function normalizeEvent(obj: any): TierAEvent {
  const type = typeof obj?.type === 'string' ? obj.type : 'unknown';
  const ev: TierAEvent = { type, raw: obj };

  // stream-json wraps assistant/user messages as { type:'assistant', message:{...} }
  const message = obj?.message;
  if (message && typeof message === 'object') {
    if (message.role === 'assistant' || message.role === 'user') ev.role = message.role;
    const content = message.content;
    if (typeof content === 'string') ev.text = content;
    else if (Array.isArray(content)) {
      const texts: string[] = [];
      const calls: { name: string; inputSummary: string }[] = [];
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
        if (c?.type === 'tool_use' && typeof c.name === 'string') {
          calls.push({ name: c.name, inputSummary: summarizeInput(c.input) });
        }
      }
      if (texts.length) ev.text = texts.join('');
      if (calls.length) ev.toolCalls = calls;
    }
  }
  if (type === 'result' && typeof obj.result === 'string' && !ev.text) ev.text = obj.result;
  return ev;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = `${k}=${v}`;
      return s.length > 80 ? s.slice(0, 79) + '…' : s;
    }
  }
  return '';
}
