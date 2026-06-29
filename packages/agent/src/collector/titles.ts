// ============================================================================
// Session TITLE resolver. The Claude DESKTOP app stores a human-readable,
// auto-generated title per session (what you see in "Recents") in
//   %APPDATA%/Claude/claude-code-sessions/<a>/<b>/local_<id>.json
// Each such file has { cliSessionId, title } where cliSessionId matches the id
// in ~/.claude/sessions/*.json (the id the agent keys SessionDocs by). We join
// on that to put the title on the dashboard card.
//
// Best-effort + cross-platform-tolerant: if the dir doesn't exist (non-desktop
// entrypoint, mac/linux path differences), every lookup just returns null.
// The map is cached and refreshed on a TTL so we don't re-walk the tree per tick.
// ============================================================================
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function sessionsRoot(): string | null {
  // Windows desktop app. (override for tests / other OSes via env)
  if (process.env.CSD_CLAUDE_SESSIONS_DIR) return process.env.CSD_CLAUDE_SESSIONS_DIR;
  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Claude', 'claude-code-sessions');
}

async function walkLocalJson(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return; // the tree is <a>/<b>/local_*.json — shallow
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkLocalJson(p, out, depth + 1);
    else if (/^local_.*\.json$/.test(e.name)) out.push(p);
  }
}

/** cliSessionId -> title. Empty map if the desktop store isn't present. */
export async function loadSessionTitles(): Promise<Map<string, string>> {
  const root = sessionsRoot();
  const map = new Map<string, string>();
  if (!root) return map;
  const files: string[] = [];
  await walkLocalJson(root, files);
  for (const f of files) {
    try {
      const o = JSON.parse(await fs.readFile(f, 'utf8'));
      if (typeof o?.cliSessionId === 'string' && typeof o?.title === 'string' && o.title.trim()) {
        map.set(o.cliSessionId, o.title.trim());
      }
    } catch {
      /* skip unreadable/partial files */
    }
  }
  return map;
}

// Cached accessor: re-walk at most every TTL ms.
let cache: Map<string, string> = new Map();
let cachedAt = 0;
const TTL_MS = 20_000;

/** Returns the title for a cliSessionId, refreshing the cache on a TTL. */
export async function getSessionTitle(
  sessionId: string,
  now: number,
): Promise<string | null> {
  if (now - cachedAt > TTL_MS) {
    cache = await loadSessionTitles();
    cachedAt = now;
  }
  return cache.get(sessionId) ?? null;
}
