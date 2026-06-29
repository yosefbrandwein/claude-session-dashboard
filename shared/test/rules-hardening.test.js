// ============================================================================
// Hardening rules tests — prove the review fixes F8 (commands update-rule freeze)
// and F9 (presence shape validation) actually block the attacks they target.
//   node --test ./test/rules-hardening.test.js   (emulator must be running)
// ============================================================================
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { ref, set as rtdbSet } from 'firebase/database';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const ALICE = 'alice-uid';
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'claude-session-dashboard',
    firestore: { rules: readFileSync(resolve(repoRoot, 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    database: { rules: readFileSync(resolve(repoRoot, 'database.rules.json'), 'utf8'), host: '127.0.0.1', port: 9000 },
  });
});
after(async () => { if (testEnv) await testEnv.cleanup(); });
beforeEach(async () => { await testEnv.clearFirestore(); await testEnv.clearDatabase(); });

const db = (uid) => testEnv.authenticatedContext(uid).firestore();
const rtdb = (uid) => testEnv.authenticatedContext(uid).database();

// --- F8: create-then-update can no longer smuggle an arbitrary type/payload ---
test('F8: legit ack update (status only, identity unchanged) is ALLOWED', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/c1`), { type: 'interrupt', sessionId: 's1', status: 'pending' }));
  await assertSucceeds(updateDoc(doc(d, `users/${ALICE}/commands/c1`), { status: 'acked' }));
});

test('F8: updating a benign command to a different TYPE is DENIED', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/c2`), { type: 'interrupt', sessionId: 's1', status: 'pending' }));
  await assertFails(updateDoc(doc(d, `users/${ALICE}/commands/c2`), { type: 'sendMessage' }));
});

test('F8: updating to an OVERSIZED payload.text is DENIED', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/c3`), { type: 'sendMessage', sessionId: 's1', status: 'pending', payload: { text: 'ok' } }));
  await assertFails(updateDoc(doc(d, `users/${ALICE}/commands/c3`), { payload: { text: 'x'.repeat(8001) } }));
});

test('F8: changing the sessionId on update is DENIED', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/c4`), { type: 'interrupt', sessionId: 's1', status: 'pending' }));
  await assertFails(updateDoc(doc(d, `users/${ALICE}/commands/c4`), { sessionId: 's2' }));
});

// --- Security hardening: payload/status freeze (replay + payload-swap) ------
test('HARDEN: re-arming a finished command back to pending is DENIED (replay block)', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/r1`), { type: 'sendMessage', sessionId: 's1', status: 'pending', payload: { text: 'hi' }, createdAt: 1 }));
  await assertSucceeds(updateDoc(doc(d, `users/${ALICE}/commands/r1`), { status: 'done', result: 'ok' }));
  // status may not transition back to 'pending' → no re-execution
  await assertFails(updateDoc(doc(d, `users/${ALICE}/commands/r1`), { status: 'pending' }));
});

test('HARDEN: swapping payload.text after create is DENIED (payload frozen)', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/r2`), { type: 'sendMessage', sessionId: 's1', status: 'pending', payload: { text: 'benign' }, createdAt: 1 }));
  // valid length, but different content — must still be rejected (frozen)
  await assertFails(updateDoc(doc(d, `users/${ALICE}/commands/r2`), { payload: { text: 'MALICIOUS instruction' } }));
});

test('HARDEN: a normal ack/done lifecycle is still ALLOWED', async () => {
  const d = db(ALICE);
  await assertSucceeds(setDoc(doc(d, `users/${ALICE}/commands/r3`), { type: 'sendMessage', sessionId: 's1', status: 'pending', payload: { text: 'hi' }, createdAt: 1 }));
  await assertSucceeds(updateDoc(doc(d, `users/${ALICE}/commands/r3`), { status: 'acked' }));
  await assertSucceeds(updateDoc(doc(d, `users/${ALICE}/commands/r3`), { status: 'done', result: 'delivered' }));
});

// --- F9: presence shape is validated ---------------------------------------
const validPresence = () => ({ status: 'working', project: 'p', branch: null, pid: 1, startedAt: 1, lastActivityAt: 1, heartbeatAt: 1 });

test('F9: a well-formed presence record is ALLOWED', async () => {
  await assertSucceeds(rtdbSet(ref(rtdb(ALICE), `presence/${ALICE}/dev1/s1`), validPresence()));
});

test('F9: an UNKNOWN extra key is DENIED ($other validate:false)', async () => {
  await assertFails(rtdbSet(ref(rtdb(ALICE), `presence/${ALICE}/dev1/s2`), { ...validPresence(), evil: 'x' }));
});

test('F9: a WRONG-TYPE field (status as number) is DENIED', async () => {
  await assertFails(rtdbSet(ref(rtdb(ALICE), `presence/${ALICE}/dev1/s3`), { ...validPresence(), status: 123 }));
});
