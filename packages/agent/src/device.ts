// Stable device identity + git branch resolution. The deviceId is a hash of the
// hostname so it's stable across agent restarts on the same machine but never
// leaks the raw hostname into the key path.
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DeviceDoc } from '../../../shared/src/types';

const execFileAsync = promisify(execFile);

/** Stable per-machine id: first 16 hex chars of sha256(hostname). */
export function deviceId(): string {
  return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);
}

export function deviceDoc(
  now: number,
  firstSeen: number,
  agentVersion: string,
  name?: string,
): DeviceDoc {
  return {
    deviceId: deviceId(),
    hostname: os.hostname(),
    ...(name ? { name } : {}),
    os: process.platform,
    agentVersion,
    firstSeen,
    lastSeen: now,
  };
}

/** Best-effort current git branch for a cwd; null when not a repo / git absent. */
export async function gitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      windowsHide: true,
    });
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}
