// Credentials + runtime config. Resolution order (first hit wins):
//   1. env CSD_EMAIL / CSD_PASSWORD
//   2. ~/.claude-dash/config.json  { "email": "...", "password": "..." }
//
// NOTE: ~/.claude-dash is the AGENT's OWN config dir — it is NOT ~/.claude and
// the agent never reads/writes Claude's real config. We only ever READ this file.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AgentConfig {
  email: string;
  password: string;
  /** content-capture opt-in: when false (default) message `text` is never stored. */
  captureContent: boolean;
  /** ms between presence ticks. */
  presenceIntervalMs: number;
  useEmulators: boolean;
}

export function configDir(): string {
  return process.env.CSD_CONFIG_DIR ?? path.join(os.homedir(), '.claude-dash');
}

async function readConfigFile(): Promise<Partial<{ email: string; password: string; captureContent: boolean }>> {
  const file = path.join(configDir(), 'config.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  const fromFile = await readConfigFile();
  const email = process.env.CSD_EMAIL ?? fromFile.email;
  const password = process.env.CSD_PASSWORD ?? fromFile.password;
  if (!email || !password) {
    throw new Error(
      'Missing credentials. Set CSD_EMAIL + CSD_PASSWORD env vars, or create ' +
        path.join(configDir(), 'config.json') +
        ' with { "email": "...", "password": "..." }.',
    );
  }
  return {
    email,
    password,
    captureContent:
      process.env.CSD_CAPTURE_CONTENT === '1' || fromFile.captureContent === true,
    presenceIntervalMs: Number(process.env.CSD_PRESENCE_INTERVAL_MS ?? 5000),
    useEmulators: process.env.USE_FIREBASE_EMULATORS === '1',
  };
}
