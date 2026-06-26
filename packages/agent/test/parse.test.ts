// Pure-logic unit tests — no filesystem, no clock. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionFile,
  projectFromCwd,
  deriveStatus,
  activityTimestamp,
  summarizeToolInput,
  parseTranscriptEntry,
  parsePermissionDenial,
  WORKING_WINDOW_MS,
  type TranscriptSignal,
} from '../src/collector/parse';

test('parseSessionFile accepts a valid blob', () => {
  const p = parseSessionFile({
    pid: 500,
    sessionId: 's1',
    cwd: 'C:\\a\\b',
    startedAt: 123,
    version: '2.1.181',
    entrypoint: 'claude-desktop',
    kind: 'interactive',
    peerProtocol: 1,
  });
  assert.ok(p);
  assert.equal(p!.pid, 500);
  assert.equal(p!.peerProtocol, 1);
  assert.equal(p!.entrypoint, 'claude-desktop');
});

test('parseSessionFile rejects missing/invalid required fields', () => {
  assert.equal(parseSessionFile(null), null);
  assert.equal(parseSessionFile({ pid: 1, sessionId: '' }), null);
  assert.equal(parseSessionFile({ pid: NaN as any, sessionId: 's', cwd: 'c' }), null);
  assert.equal(parseSessionFile({ sessionId: 's', cwd: 'c' }), null);
  assert.equal(parseSessionFile({ pid: 'x' as any, sessionId: '' }), null);
});

test('projectFromCwd handles windows and posix separators + trailing slash', () => {
  assert.equal(projectFromCwd('C:\\Users\\me\\source\\repos\\FlexiPlan.Solver'), 'FlexiPlan.Solver');
  assert.equal(projectFromCwd('/home/dev/my-proj/'), 'my-proj');
  assert.equal(projectFromCwd('plain'), 'plain');
});

test('deriveStatus: dead PID is stale regardless of activity', () => {
  const sig: TranscriptSignal = { lineCount: 5, lastEntryTs: Date.now(), mtimeMs: Date.now() };
  assert.equal(deriveStatus(false, sig, Date.now()), 'stale');
  assert.equal(deriveStatus(false, null, Date.now()), 'stale');
});

test('deriveStatus: alive + recent transcript is working, quiet is idle', () => {
  const now = 1_000_000_000;
  const recent: TranscriptSignal = { lineCount: 5, lastEntryTs: now - 2_000, mtimeMs: now - 2_000 };
  const old: TranscriptSignal = {
    lineCount: 5,
    lastEntryTs: now - (WORKING_WINDOW_MS + 5_000),
    mtimeMs: now - (WORKING_WINDOW_MS + 5_000),
  };
  assert.equal(deriveStatus(true, recent, now), 'working');
  assert.equal(deriveStatus(true, old, now), 'idle');
  assert.equal(deriveStatus(true, null, now), 'idle'); // alive, no transcript yet
});

test('deriveStatus falls back to mtime when no entry timestamp', () => {
  const now = 2_000_000;
  const sig: TranscriptSignal = { lineCount: 3, lastEntryTs: null, mtimeMs: now - 1_000 };
  assert.equal(deriveStatus(true, sig, now), 'working');
});

test('activityTimestamp prefers entry ts over mtime', () => {
  assert.equal(activityTimestamp({ lineCount: 1, lastEntryTs: 10, mtimeMs: 20 }), 10);
  assert.equal(activityTimestamp({ lineCount: 1, lastEntryTs: null, mtimeMs: 20 }), 20);
  assert.equal(activityTimestamp(null), null);
});

test('summarizeToolInput picks the descriptive field per tool and never dumps everything', () => {
  assert.equal(
    summarizeToolInput('Bash', { command: 'rm -rf /', description: 'delete the world' }),
    'delete the world',
  );
  assert.equal(summarizeToolInput('Read', { file_path: '/a/b.txt' }), '/a/b.txt');
  assert.equal(summarizeToolInput('Grep', { pattern: 'foo.*bar' }), 'foo.*bar');
  // generic fallback to first scalar
  assert.equal(summarizeToolInput('Mystery', { count: 7, blob: { big: 1 } }), 'count=7');
  assert.equal(summarizeToolInput('Mystery', undefined), '');
});

test('summarizeToolInput truncates long values', () => {
  const long = 'x'.repeat(500);
  const out = summarizeToolInput('Read', { file_path: long });
  assert.ok(out.length <= 80);
  assert.ok(out.endsWith('…'));
});

test('parseTranscriptEntry: user text turn → role user, summary set', () => {
  const m = parseTranscriptEntry(
    { type: 'user', timestamp: '2026-06-20T10:00:01.000Z', message: { role: 'user', content: 'hello world' } },
    0,
  );
  assert.ok(m);
  assert.equal(m!.role, 'user');
  assert.equal(m!.summary, 'hello world');
  assert.equal(m!.toolCalls, undefined);
});

test('parseTranscriptEntry: assistant tool_use → toolCalls captured, NO raw text/thinking leaked', () => {
  const m = parseTranscriptEntry(
    {
      type: 'assistant',
      timestamp: '2026-06-20T10:00:03.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'SECRET reasoning' },
          { type: 'text', text: 'doing the thing' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls /secret', description: 'list' } },
        ],
      },
    },
    0,
  );
  assert.ok(m);
  assert.equal(m!.role, 'assistant');
  assert.deepEqual(m!.toolCalls, [{ name: 'Bash', inputSummary: 'list' }]);
  assert.equal(m!.summary, 'doing the thing');
  // The serialized metadata must not contain the raw command or thinking.
  const blob = JSON.stringify(m);
  assert.ok(!blob.includes('SECRET'));
  assert.ok(!blob.includes('/secret'));
});

test('parseTranscriptEntry: tool_result carrier → role tool', () => {
  const m = parseTranscriptEntry(
    {
      type: 'user',
      timestamp: '2026-06-20T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', is_error: false, content: 'ok' }] },
    },
    0,
  );
  assert.ok(m);
  assert.equal(m!.role, 'tool');
});

test('parseTranscriptEntry: non-message types (queue/summary) return null', () => {
  assert.equal(parseTranscriptEntry({ type: 'queue-operation' }, 0), null);
  assert.equal(parseTranscriptEntry({ type: 'summary' }, 0), null);
  assert.equal(parseTranscriptEntry(null, 0), null);
  assert.equal(parseTranscriptEntry(undefined, 0), null);
});

test('parseTranscriptEntry falls back to fallbackTs on missing/invalid timestamp', () => {
  const m = parseTranscriptEntry({ type: 'user', message: { role: 'user', content: 'hi' } }, 4242);
  assert.equal(m!.ts, 4242);
});

test('parsePermissionDenial detects a denied tool_result', () => {
  const d = parsePermissionDenial(
    {
      type: 'user',
      timestamp: '2026-06-20T10:00:06.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', is_error: true, content: "Claude requested permissions to use Read, but you haven't granted it yet." },
        ],
      },
    },
    0,
  );
  assert.ok(d);
  assert.equal(d!.decision, 'denied');
});

test('parsePermissionDenial ignores successful tool_results and non-permission errors', () => {
  assert.equal(
    parsePermissionDenial(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: false, content: 'fine' }] } },
      0,
    ),
    null,
  );
  assert.equal(
    parsePermissionDenial(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'compile error: missing semicolon' }] } },
      0,
    ),
    null,
  );
});
