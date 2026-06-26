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

test('readTranscriptSignal raw line count agrees with readTranscriptEntriesFrom totalLines', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const sig = await readTranscriptSignal(p);
  assert.ok(sig);
  // F2: lineCount is now the RAW emitted line count and MUST equal totalLines.
  const all = await readTranscriptEntriesFrom(p, 0);
  assert.equal(sig!.lineCount, all.totalLines);
  // 9 raw lines emitted by the reader (the trailing newline yields no extra line).
  assert.equal(sig!.lineCount, 9);
  // newest *parseable* last line is the partial → lastEntryTs null, mtime set.
  assert.equal(sig!.lastEntryTs, null);
  assert.ok(sig!.mtimeMs > 0);
});

test('readTranscriptEntriesFrom tags each entry with its absolute line index and supports incremental reads', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const all = await readTranscriptEntriesFrom(p, 0);
  // 9 physical lines, 1 unparseable → 8 entries; totalLines counts all 9.
  assert.equal(all.totalLines, 9);
  assert.equal(all.entries.length, 8);
  // F3: lineIndex is the ABSOLUTE 0-based raw line index, not array position.
  // Line 0 is a queue-operation (parses as JSON but is not a message), lines
  // 1..6 are messages, line 7 a summary, line 8 the unparseable partial (skipped).
  assert.deepEqual(
    all.entries.map((e) => e.lineIndex),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );

  // Incremental: from line 5 onward, only the tail entries are returned and they
  // keep their ABSOLUTE indices (not re-based to 0).
  const tail = await readTranscriptEntriesFrom(p, 5);
  assert.equal(tail.totalLines, 9);
  assert.ok(tail.entries.length < all.entries.length);
  assert.equal(tail.entries[0]!.lineIndex, 5);
  // The same entry has the SAME absolute index in a full read and an incremental
  // read — this is what makes line-index doc ids idempotent across ticks (F3).
  const fullAt5 = all.entries.find((e) => e.lineIndex === 5)!;
  assert.deepEqual(tail.entries[0]!.entry, fullAt5.entry);
});

test('permission denial is detected within the fixture transcript', async () => {
  const p = (await findTranscriptPath(SESSION_ID, FIX))!;
  const { entries } = await readTranscriptEntriesFrom(p, 0);
  const denials = entries.map((e) => parsePermissionDenial(e.entry, 0)).filter(Boolean);
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
    // F11: controllableHint is Tier-A eligibility = live + has sessionId. Stale
    // (dead-PID) fixture sessions are terminal ⇒ NOT controllable.
    assert.equal(c.controllableHint, false);
  }
  const withTranscript = snap.sessions.find((c) => c.transcriptPath);
  assert.ok(withTranscript, 'one fixture session has a transcript');
  assert.equal(withTranscript!.project, 'proj');
});
