// Manager re-verification of the highest-value behavioral fixes, live on the emulator:
//   F11: real (live) sessions now report controllable=true
//   F7 : approve command UPDATES the original permissionRequest doc (no duplicate)
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, getDocs, doc, setDoc, getDoc,
} from 'firebase/firestore';

const app = initializeApp({
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com', projectId: 'claude-session-dashboard',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
});
const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { user } = await signInWithEmailAndPassword(auth, 'demo@demo.dev', 'demo123');
const uid = user.uid;
const AGENT_DEVICE = 'b21874ad9b2abd09'; // deterministic sha256(hostname)[:16] for this machine

// F11 — live sessions controllable
const sessions = await getDocs(collection(db, `users/${uid}/sessions`));
const real = sessions.docs.map((d) => d.data()).filter((s) => s.deviceId === AGENT_DEVICE);
console.log(`[F11] real-device sessions: ${real.length}`);
real.forEach((s) => console.log(`   - ${s.project} [${s.status}] controllable=${s.controllable}`));
const liveControllable = real.filter((s) => s.status !== 'stale' && s.status !== 'ended');
const f11ok = liveControllable.length > 0 && liveControllable.every((s) => s.controllable === true);
console.log(`[F11] ${f11ok ? 'OK ✅ live sessions are controllable' : 'FAIL ❌'}`);

// F7 — approve updates the ORIGINAL permission doc, no duplicate
const SID = real[0]?.sessionId || 'f7-test-session';
const REQID = '1700000000000-Bash'; // shape the agent uses: `${ts}-${tool}`
const permCol = `users/${uid}/sessions/${SID}/permissionRequests`;
// seed a pending request
await setDoc(doc(db, permCol, REQID), {
  tool: 'Bash', inputSummary: 'rm -rf /tmp/x', ts: 1700000000000,
  decision: 'pending', decidedAt: null, decidedBy: null, source: 'hook',
});
const before = (await getDocs(collection(db, permCol))).size;
// inject approve command referencing that reqId
await setDoc(doc(db, `users/${uid}/commands/f7-approve`), {
  type: 'approve', sessionId: SID, payload: { reqId: REQID }, status: 'pending', createdAt: Date.now(),
});
// wait for the agent to process
let cmd, original;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  cmd = (await getDoc(doc(db, `users/${uid}/commands/f7-approve`))).data();
  if (cmd?.status === 'done' || cmd?.status === 'error') break;
}
original = (await getDoc(doc(db, permCol, REQID))).data();
const after = (await getDocs(collection(db, permCol))).size;
console.log(`\n[F7] command -> status=${cmd?.status} result="${cmd?.result}"`);
console.log(`[F7] original request decision: ${original?.decision} (decidedBy=${original?.decidedBy})`);
console.log(`[F7] permissionRequest doc count: before=${before} after=${after} (expect EQUAL — updated in place, no dupe)`);
const f7ok = cmd?.status === 'done' && original?.decision === 'approved' && original?.decidedBy === 'dashboard' && after === before;
console.log(`[F7] ${f7ok ? 'OK ✅ original doc updated, no duplicate' : 'FAIL ❌'}`);

console.log(`\n${f11ok && f7ok ? 'FIXES VERIFIED ✅' : 'FIXES NOT FULLY VERIFIED ❌'}`);
process.exit(f11ok && f7ok ? 0 : 1);
