// I/O + collector tests against FIXTURES only. CLAUDE_HOME is pointed at
// test/fixtures so these never read the real ~/.claude. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readSessionFiles,
  findTranscriptPath,
  readTranscriptSignal,
  readTranscriptEntriesFrom,
  liveProcesses,
} from '../src/collector/io';
import { collectOnce } from '../src/collector/collect';
import { parsePermissionDenial } from '../src/collector/parse';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

test('readSessionFiles parses valid files and skips corrupt ones', async () => {
  const sessions = await readSessionFiles(FIX);
  const ids = sessions.map((s) => s.pid).sort((a, b) => a - b);
  // 4242 + 9999 valid; bad.json skipped.
  assert.deepEqual(ids, [4242, 9999]);
  const s = sessions.find((x) => x.pid === 4242)!;
  assert.equal(s.sessionId, SESSION_ID);
  assert.equal(s.entrypoint, 'claude-desktop');
  assert.equal(s.peerProtocol, 1);
});

test('findTranscriptPath locates <sessionId>.jsonl by globbing project dirs', async () => {
  const p = await findTranscriptPath(SESSION_ID, FIX);
  assert.ok(p);
  assert.ok(p!.endsWith(`${SESSION_ID}.jsonl`));
  assert.equal(await findTranscriptPath('does-not-exist', FIX), null);
});

test('readTranscriptSignal counts non-empty lines and reads newest entry ts', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const sig = await readTranscriptSignal(p);
  assert.ok(sig);
  // 9 content lines including the trailing partial-json line (non-empty).
  assert.equal(sig!.lineCount, 9);
  // newest *parseable* last line is the partial → lastEntryTs null, mtime set.
  assert.equal(sig!.lastEntryTs, null);
  assert.ok(sig!.mtimeMs > 0);
});

test('readTranscriptEntriesFrom skips the unparseable trailing line and supports incremental reads', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const all = await readTranscriptEntriesFrom(p, 0);
  // 9 physical non-empty lines, 1 unparseable → 8 entries; totalLines counts all 9.
  assert.equal(all.totalLines, 9);
  assert.equal(all.entries.length, 8);

  // Incremental: from line 7 onward, only the tail entries are returned.
  const tail = await readTranscriptEntriesFrom(p, 7);
  assert.equal(tail.totalLines, 9);
  assert.ok(tail.entries.length < all.entries.length);
});

test('permission denial is detected within the fixture transcript', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const { entries } = await readTranscriptEntriesFrom(p, 0);
  const denials = entries.map((e) => parsePermissionDenial(e, 0)).filter(Boolean);
  assert.equal(denials.length, 1);
  assert.equal(denials[0]!.tool, 'unknown'); // tool name lived in prior assistant entry
});

test('liveProcesses returns empty for PIDs that are not running', async () => {
  // 4242/9999 are fixture PIDs, not live on this machine.
  const live = await liveProcesses([4242, 9999]);
  assert.equal(live.has(4242), false);
  assert.equal(live.has(9999), false);
});

test('liveProcesses reports the current process as alive', async () => {
  const live = await liveProcesses([process.pid]);
  assert.equal(live.has(process.pid), true);
});

test('collectOnce maps fixture sessions; dead PIDs ⇒ stale', async () => {
  const now = Date.now();
  const snap = await collectOnce({ home: FIX, now });
  assert.equal(snap.sessions.length, 2);
  for (const c of snap.sessions) {
    assert.equal(c.status, 'stale'); // fixture PIDs aren't live
    assert.equal(c.controllableHint, false); // not alive ⇒ not controllable
  }
  const withTranscript = snap.sessions.find((c) => c.transcriptPath);
  assert.ok(withTranscript, 'one fixture session has a transcript');
  assert.equal(withTranscript!.project, 'proj');
});
