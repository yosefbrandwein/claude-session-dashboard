// ============================================================================
// Security-rules unit tests (run with `node --test`).
//
// Proves the multi-tenant isolation contract in firestore.rules +
// database.rules.json against the LIVE emulator suite. Requires the auth,
// firestore, and database emulators to be running (firebase emulators:start).
//
//   node --test ./test/*.test.js
//
// Uses @firebase/rules-unit-testing v5. Each test gets a fresh authed context.
// ============================================================================
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
} from 'firebase/firestore';
import { ref, get as rtdbGet, set as rtdbSet } from 'firebase/database';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Rules files live at the repo root, two levels up from shared/test/.
const repoRoot = resolve(__dirname, '..', '..');

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'claude-session-dashboard',
    firestore: {
      rules: readFileSync(resolve(repoRoot, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    database: {
      rules: readFileSync(resolve(repoRoot, 'database.rules.json'), 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearDatabase();
});

// --- helpers ---------------------------------------------------------------
function db(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}
function rtdb(uid) {
  return testEnv.authenticatedContext(uid).database();
}

const validCommand = (sessionId = 's1') => ({
  type: 'sendMessage',
  sessionId,
  payload: { text: 'hello' },
  status: 'pending',
  createdAt: Date.now(),
});

// ===========================================================================
// Firestore: owner can read+write their own subtree
// ===========================================================================
test('owner can write+read their own device doc', async () => {
  const d = db(ALICE);
  await assertSucceeds(
    setDoc(doc(d, `users/${ALICE}/devices/dev1`), {
      deviceId: 'dev1',
      hostname: 'host-a',
      os: 'win32',
      agentVersion: '0.1.0',
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    }),
  );
  await assertSucceeds(getDoc(doc(d, `users/${ALICE}/devices/dev1`)));
});

test('owner can write+read a session and its messages + permissionRequests', async () => {
  const d = db(ALICE);
  await assertSucceeds(
    setDoc(doc(d, `users/${ALICE}/sessions/s1`), {
      sessionId: 's1',
      deviceId: 'dev1',
      project: 'demo',
      cwd: '/x',
      gitBranch: 'main',
      startedAt: Date.now(),
      endedAt: null,
      model: null,
      version: null,
      entrypoint: null,
      status: 'working',
      messageCount: 0,
      controllable: true,
    }),
  );
  await assertSucceeds(
    setDoc(doc(d, `users/${ALICE}/sessions/s1/messages/m1`), {
      ts: Date.now(),
      role: 'user',
      kind: 'message',
      summary: 'hi',
    }),
  );
  await assertSucceeds(
    setDoc(doc(d, `users/${ALICE}/sessions/s1/permissionRequests/r1`), {
      tool: 'Bash',
      inputSummary: 'ls',
      ts: Date.now(),
      decision: 'pending',
      decidedAt: null,
      decidedBy: null,
      source: 'hook',
    }),
  );
  await assertSucceeds(getDoc(doc(d, `users/${ALICE}/sessions/s1/messages/m1`)));
});

// ===========================================================================
// Firestore: cross-tenant isolation — a different uid is DENIED
// ===========================================================================
test("a different uid cannot READ another user's subtree", async () => {
  // Seed Alice's data with rules bypassed.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${ALICE}/sessions/s1`), { sessionId: 's1' });
  });
  const bobDb = db(BOB);
  await assertFails(getDoc(doc(bobDb, `users/${ALICE}/sessions/s1`)));
  await assertFails(getDoc(doc(bobDb, `users/${ALICE}/devices/dev1`)));
});

test("a different uid cannot WRITE into another user's subtree", async () => {
  const bobDb = db(BOB);
  await assertFails(
    setDoc(doc(bobDb, `users/${ALICE}/devices/dev1`), { deviceId: 'dev1' }),
  );
  await assertFails(
    setDoc(doc(bobDb, `users/${ALICE}/commands/c1`), validCommand()),
  );
});

// ===========================================================================
// Firestore: command shape validation
// ===========================================================================
test('valid pending sendMessage command is allowed', async () => {
  const d = db(ALICE);
  await assertSucceeds(
    setDoc(doc(d, `users/${ALICE}/commands/c1`), validCommand()),
  );
});

test('command with an invalid type is denied', async () => {
  const d = db(ALICE);
  await assertFails(
    setDoc(doc(d, `users/${ALICE}/commands/c-bad`), {
      ...validCommand(),
      type: 'rm-rf', // not in the allow-list
    }),
  );
});

test('command with a non-pending status on create is denied', async () => {
  const d = db(ALICE);
  await assertFails(
    setDoc(doc(d, `users/${ALICE}/commands/c-bad2`), {
      ...validCommand(),
      status: 'done', // create must be pending
    }),
  );
});

test('command with an oversized payload (>8000) is denied', async () => {
  const d = db(ALICE);
  await assertFails(
    setDoc(doc(d, `users/${ALICE}/commands/c-big`), {
      ...validCommand(),
      payload: { text: 'x'.repeat(8001) },
    }),
  );
});

// ===========================================================================
// RTDB: /presence/{uid} is owner-only
// ===========================================================================
test('owner can write+read their own presence record', async () => {
  const r = rtdb(ALICE);
  const path = `presence/${ALICE}/dev1/s1`;
  await assertSucceeds(
    rtdbSet(ref(r, path), {
      status: 'working',
      project: 'demo',
      branch: 'main',
      pid: 123,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      heartbeatAt: Date.now(),
    }),
  );
  await assertSucceeds(rtdbGet(ref(r, path)));
});

test("a different uid cannot read or write another user's presence", async () => {
  // Seed Alice's presence with rules bypassed.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await rtdbSet(ref(ctx.database(), `presence/${ALICE}/dev1/s1`), {
      status: 'working',
      heartbeatAt: Date.now(),
    });
  });
  const bobR = rtdb(BOB);
  await assertFails(rtdbGet(ref(bobR, `presence/${ALICE}/dev1/s1`)));
  await assertFails(
    rtdbSet(ref(bobR, `presence/${ALICE}/dev1/s1`), {
      status: 'working',
      heartbeatAt: Date.now(),
    }),
  );
});
