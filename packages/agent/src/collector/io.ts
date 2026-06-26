// ============================================================================
// I/O shell for the collector. Everything that touches the filesystem, the
// process table, or env vars lives here. The pure logic (parse.ts) gets plain
// data from these functions. READ-ONLY against ~/.claude — the agent NEVER
// writes anywhere under ~/.claude.
// ============================================================================
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RawSessionFile, RawTranscriptEntry } from './rawTypes';
import {
  parseSessionFile,
  type ParsedSession,
  type TranscriptSignal,
} from './parse';

const execFileAsync = promisify(execFile);

/** Root of the real Claude config tree (overridable for the read-only proof). */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
}

const sessionsDir = (home: string) => path.join(home, 'sessions');
const projectsDir = (home: string) => path.join(home, 'projects');

/** Read + parse every ~/.claude/sessions/<pid>.json into ParsedSession[]. */
export async function readSessionFiles(home = claudeHome()): Promise<ParsedSession[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir(home));
  } catch {
    return []; // no sessions dir yet
  }
  const out: ParsedSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(sessionsDir(home), name);
    try {
      const text = await fs.readFile(full, 'utf8');
      const raw = JSON.parse(text) as RawSessionFile;
      const parsed = parseSessionFile(raw);
      if (parsed) out.push(parsed);
    } catch {
      // Corrupt/partial/locked file — skip, don't crash the loop.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PID liveness. Windows: `tasklist /FI "PID eq <pid>" /NH`. We probe in ONE
// batch per tick by querying the full task list once and intersecting.
// ---------------------------------------------------------------------------

/** Return the set of PIDs (from `candidates`) that are currently live. */
export async function liveProcesses(candidates: number[]): Promise<Set<number>> {
  if (candidates.length === 0) return new Set();
  if (process.platform === 'win32') return liveProcessesWin(candidates);
  return liveProcessesPosix(candidates);
}

async function liveProcessesWin(candidates: number[]): Promise<Set<number>> {
  // `tasklist /NH /FO CSV` lists all processes; parse PIDs from column 2.
  // One spawn per tick regardless of candidate count.
  try {
    const { stdout } = await execFileAsync('tasklist', ['/NH', '/FO', 'CSV'], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const livePids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      // CSV: "image","PID","Session","Session#","MemUsage"
      const m = line.match(/^"[^"]*","(\d+)"/);
      if (m) livePids.add(Number(m[1]));
    }
    return new Set(candidates.filter((p) => livePids.has(p)));
  } catch {
    // Fall back to per-PID signal probe if tasklist is unavailable.
    return liveProcessesPosix(candidates);
  }
}

function liveProcessesPosix(candidates: number[]): Set<number> {
  const live = new Set<number>();
  for (const pid of candidates) {
    try {
      process.kill(pid, 0); // signal 0 = existence check
      live.add(pid);
    } catch (e: any) {
      if (e?.code === 'EPERM') live.add(pid); // exists but not ours
    }
  }
  return live;
}

// ---------------------------------------------------------------------------
// Transcript location + activity signal.
// ---------------------------------------------------------------------------

/**
 * Claude derives the project dir name from cwd by replacing every run of
 * path separators / colons / dots with a single '-'. We can't perfectly invert
 * that, so to be robust we GLOB projects/ for a file named <sessionId>.jsonl
 * rather than recomputing the hash. (Verified against real data: the file is
 * always <sessionId>.jsonl under exactly one project dir.)
 */
export async function findTranscriptPath(
  sessionId: string,
  home = claudeHome(),
): Promise<string | null> {
  const root = projectsDir(home);
  let dirs: string[];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return null;
  }
  const target = `${sessionId}.jsonl`;
  for (const d of dirs) {
    const candidate = path.join(root, d, target);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Stat + cheaply scan a transcript for line count and newest entry ts. */
export async function readTranscriptSignal(filePath: string): Promise<TranscriptSignal | null> {
  let mtimeMs: number;
  try {
    const st = await fs.stat(filePath);
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  // Count lines + grab the last non-empty line's timestamp by streaming.
  let lineCount = 0;
  let lastLine = '';
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
    rl.on('line', (l) => {
      if (l.trim().length) {
        lineCount++;
        lastLine = l;
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', reject);
  }).catch(() => {});

  let lastEntryTs: number | null = null;
  if (lastLine) {
    try {
      const obj = JSON.parse(lastLine) as RawTranscriptEntry;
      if (typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp);
        if (!Number.isNaN(t)) lastEntryTs = t;
      }
    } catch {
      // last line might be a partial write; ignore.
    }
  }
  return { lineCount, lastEntryTs, mtimeMs };
}

/**
 * Read transcript entries with line index >= `fromLine` (0-based). Returns the
 * parsed JSON objects plus the new total line count, so the caller can persist
 * only NEW lines incrementally. Skips unparseable (e.g. partially-written) lines.
 */
export async function readTranscriptEntriesFrom(
  filePath: string,
  fromLine: number,
): Promise<{ entries: RawTranscriptEntry[]; totalLines: number }> {
  const entries: RawTranscriptEntry[] = [];
  let idx = 0;
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
    rl.on('line', (l) => {
      const cur = idx++;
      if (!l.trim().length) return;
      if (cur < fromLine) return;
      try {
        entries.push(JSON.parse(l) as RawTranscriptEntry);
      } catch {
        // partial line; will be re-read next tick once flushed.
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', reject);
  }).catch(() => {});
  return { entries, totalLines: idx };
}
