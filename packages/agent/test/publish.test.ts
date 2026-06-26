// Pure-logic tests for the publish-layer id/coordinate helpers that back the
// idempotency fixes (F3 line-index ids, F5 Tier A disjoint namespace) and the
// F1 SessionDoc dirty-check. No Firebase / network — only the deterministic
// helpers are exercised. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineIndexId } from '../src/publish';
import { stableSessionDocJson } from '../src/index';
import type { SessionDoc } from '../../../shared/src/types';

test('lineIndexId is zero-padded and lexically sortable by numeric order (F3)', () => {
  assert.equal(lineIndexId(0), '000000000');
  assert.equal(lineIndexId(7), '000000007');
  assert.equal(lineIndexId(42), '000000042');
  // Lexical sort of the ids must match numeric order of the indices.
  const ids = [0, 5, 12, 3, 100, 9].map(lineIndexId);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, [0, 3, 5, 9, 12, 100].map(lineIndexId));
});

test('lineIndexId is STABLE: same absolute line index ⇒ same doc id across ticks (F3)', () => {
  // The whole point of keying by absolute transcript line index: a re-tick that
  // re-reads the same line writes the SAME doc id (overwrite, never a dupe).
  assert.equal(lineIndexId(13), lineIndexId(13));
});

test('Tier A ids occupy a DISJOINT namespace from line-index ids (F5)', () => {
  // Tier A streamed chunks use `tierA-<cmdId>-<n>`; transcript docs use the
  // numeric padded form. A non-numeric prefix guarantees they can never collide,
  // even when the chunk counter equals a real transcript line index.
  const tierAId = (cmdId: string, n: number) => `tierA-${cmdId}-${n}`;
  for (let i = 0; i < 50; i++) {
    assert.notEqual(tierAId('cmd1', i), lineIndexId(i));
    // line-index ids are all digits; Tier A ids never are.
    assert.match(lineIndexId(i), /^\d+$/);
    assert.doesNotMatch(tierAId('cmd1', i), /^\d+$/);
  }
});

function baseDoc(): SessionDoc {
  return {
    sessionId: 's1',
    deviceId: 'dev1',
    project: 'proj',
    cwd: 'C:/x/proj',
    gitBranch: 'main',
    startedAt: 1000,
    endedAt: null,
    model: 'claude-opus-4-8',
    version: '2.1.181',
    entrypoint: 'claude-desktop',
    status: 'idle',
    messageCount: 3,
    controllable: true,
  };
}

test('stableSessionDocJson: identical docs ⇒ identical string (F1 dirty-check is a no-write)', () => {
  assert.equal(stableSessionDocJson(baseDoc()), stableSessionDocJson(baseDoc()));
});

test('stableSessionDocJson is independent of key insertion order (F1)', () => {
  const a = baseDoc();
  // Build an equivalent doc with keys inserted in a different order.
  const b: SessionDoc = {
    controllable: a.controllable,
    messageCount: a.messageCount,
    status: a.status,
    entrypoint: a.entrypoint,
    version: a.version,
    model: a.model,
    endedAt: a.endedAt,
    startedAt: a.startedAt,
    gitBranch: a.gitBranch,
    cwd: a.cwd,
    project: a.project,
    deviceId: a.deviceId,
    sessionId: a.sessionId,
  };
  assert.equal(stableSessionDocJson(a), stableSessionDocJson(b));
});

test('stableSessionDocJson changes when ANY field changes ⇒ a write is billed (F1)', () => {
  const base = stableSessionDocJson(baseDoc());
  const working = stableSessionDocJson({ ...baseDoc(), status: 'working' });
  const moreMsgs = stableSessionDocJson({ ...baseDoc(), messageCount: 4 });
  const ended = stableSessionDocJson({ ...baseDoc(), status: 'ended', endedAt: 9999 });
  assert.notEqual(working, base);
  assert.notEqual(moreMsgs, base);
  assert.notEqual(ended, base);
});
