// Tests the desktop-app session-title resolver: it walks
// %APPDATA%/Claude/claude-code-sessions (overridable via CSD_CLAUDE_SESSIONS_DIR)
// and maps cliSessionId -> title. Uses a fixture tree, never the real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionTitles } from '../src/collector/titles';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'claude-sessions',
);

test('loadSessionTitles maps cliSessionId -> title across the nested tree', async () => {
  process.env.CSD_CLAUDE_SESSIONS_DIR = fixtureDir;
  const map = await loadSessionTitles();
  assert.equal(map.get('cli-sess-1'), 'Wire up the dashboard');
  assert.equal(map.get('cli-sess-2'), 'Fix the solver bug');
  assert.equal(map.size, 2);
  delete process.env.CSD_CLAUDE_SESSIONS_DIR;
});

test('loadSessionTitles returns an empty map when the store is absent (best-effort)', async () => {
  process.env.CSD_CLAUDE_SESSIONS_DIR = path.join(fixtureDir, 'does-not-exist');
  const map = await loadSessionTitles();
  assert.equal(map.size, 0);
  delete process.env.CSD_CLAUDE_SESSIONS_DIR;
});
