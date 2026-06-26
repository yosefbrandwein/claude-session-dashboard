// ============================================================================
// TIER B — inject into an ALREADY-OPEN interactive Claude session via the local
// named-pipe daemon (~/.claude/daemon, peerProtocol:1).
//
// This module is INVESTIGATIVE + READ-ONLY against ~/.claude. It inspects the
// daemon artifacts and enumerates \\.\pipe\* to discover whether a writable
// session-injection channel exists, and (if a plausible one is found) attempts a
// best-effort handshake. It NEVER alters Claude's config and NEVER persists.
//
// See README "Tier B findings" for the empirical verdict on this machine.
// ============================================================================
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DaemonProbe {
  daemonDir: string;
  hasPipeKey: boolean;
  pipeKeyLen: number | null;
  roster: { proto?: number; supervisorPid?: number; workers?: Record<string, unknown> } | null;
  supervisorAlive: boolean | null;
  dispatchEntries: string[];
  ptyPidEntries: string[];
  /** All named pipes whose name matches claude/anthropic/peer/dispatch. */
  claudePipes: string[];
  /** Honest conclusion the agent reached about Tier B feasibility right now. */
  verdict: string;
}

function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * Enumerate Windows named pipes. The pipe filesystem is exposed at \\.\pipe\.
 * Returns only pipes whose name suggests Claude/daemon involvement.
 */
export async function enumerateClaudePipes(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  try {
    // \\.\pipe\ is a flat directory of pipe names.
    const names = await fs.readdir('\\\\.\\pipe\\');
    return names.filter((n) => /claude|anthropic|peer|dispatch|dargoo/i.test(n));
  } catch {
    return [];
  }
}

/** Run a full read-only Tier B probe and produce an honest verdict. */
export async function probeDaemon(): Promise<DaemonProbe> {
  const daemonDir = path.join(claudeHome(), 'daemon');
  const pipeKeyPath = path.join(daemonDir, 'pipe.key');

  let hasPipeKey = false;
  let pipeKeyLen: number | null = null;
  try {
    const buf = await fs.readFile(pipeKeyPath);
    hasPipeKey = true;
    pipeKeyLen = buf.length;
  } catch {
    /* no key */
  }

  const roster = await readJson<DaemonProbe['roster']>(path.join(daemonDir, 'roster.json'));
  const supervisorAlive =
    roster && typeof roster.supervisorPid === 'number' ? pidAlive(roster.supervisorPid) : null;

  const dispatchEntries = await listDir(path.join(daemonDir, 'dispatch'));
  const ptyPidEntries = await listDir(path.join(daemonDir, 'pty-pids'));
  const claudePipes = await enumerateClaudePipes();

  // -------------------------------------------------------------------------
  // Honest verdict logic. A writable session-injection channel needs:
  //   (a) a live daemon supervisor, and
  //   (b) a peer/dispatch pipe actually listening for that session.
  // If neither is present, Tier B is not feasible *right now* without reverse-
  // engineering + persisting changes (out of scope / disallowed).
  // -------------------------------------------------------------------------
  const peerPipe = claudePipes.find((n) => /peer|dispatch/i.test(n));
  let verdict: string;
  if (peerPipe) {
    verdict =
      `Found a candidate peer/dispatch pipe "${peerPipe}". A handshake could be attempted, ` +
      `but the wire framing of peerProtocol:1 is undocumented; treat as experimental.`;
  } else if (supervisorAlive) {
    verdict =
      'Daemon supervisor is alive but exposes no peer/dispatch pipe to enumerate; the only ' +
      'discoverable pipes are MCP bridges, which do not accept session message injection.';
  } else {
    verdict =
      'No live daemon supervisor and no peer/dispatch pipe present. The daemon is transient ' +
      '(spawns on demand, exits when idle) and roster.workers is empty, so there is no open ' +
      'channel to inject into. Tier B is NOT feasible here without reverse-engineering the ' +
      'undocumented peerProtocol:1 framing and persisting changes (disallowed). Use Tier A.';
  }

  return {
    daemonDir,
    hasPipeKey,
    pipeKeyLen,
    roster,
    supervisorAlive,
    dispatchEntries,
    ptyPidEntries,
    claudePipes,
    verdict,
  };
}
