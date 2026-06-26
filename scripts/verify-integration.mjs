// Manager END-TO-END integration check (run while the agent is live):
//   1. read what the agent wrote (device + real sessions + presence + messages)
//   2. inject a command round-trip and confirm the agent acks + completes it:
//      - sendMessage for a FABRICATED session id -> safe "unknown session" path
//        (NEVER spawns a real `claude --resume` turn against your real sessions)
//      - approve -> records a permission decision
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, collection, getDocs, doc, setDoc, getDoc,
} from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, ref, get } from 'firebase/database';

const app = initializeApp({
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
});
const auth = getAuth(app); connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app); connectFirestoreEmulator(db, '127.0.0.1', 8080);
const rtdb = getDatabase(app); connectDatabaseEmulator(rtdb, '127.0.0.1', 9000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { user } = await signInWithEmailAndPassword(auth, 'demo@demo.dev', 'demo123');
const uid = user.uid;
console.log('signed in, uid =', uid);

// 1) READBACK — what did the live agent write?
const devs = await getDocs(collection(db, `users/${uid}/devices`));
console.log(`\n[devices] ${devs.size}`);
devs.forEach((d) => console.log(`  - ${d.id}: ${d.data().hostname} (${d.data().os}) agent v${d.data().agentVersion}`));

const sessions = await getDocs(collection(db, `users/${uid}/sessions`));
console.log(`\n[sessions] ${sessions.size}`);
let realMsgTotal = 0;
for (const s of sessions.docs) {
  const d = s.data();
  const msgs = await getDocs(collection(db, `users/${uid}/sessions/${s.id}/messages`));
  realMsgTotal += msgs.size;
  console.log(`  - ${d.project} [${d.status}] dev=${d.deviceId} msgs=${msgs.size} controllable=${d.controllable}`);
}
console.log(`[messages] ${realMsgTotal} metadata docs across all sessions`);

const pres = (await get(ref(rtdb, `presence/${uid}`))).val() || {};
let pc = 0;
for (const dv of Object.keys(pres)) for (const sid of Object.keys(pres[dv])) { pc++; }
console.log(`[presence] ${pc} live records`);

// 2) COMMAND ROUND-TRIP
const FAKE = 'integration-fake-session-zzz';
async function inject(id, body) {
  await setDoc(doc(db, `users/${uid}/commands/${id}`), { ...body, status: 'pending', createdAt: Date.now() });
}
async function waitTerminal(id, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const snap = await getDoc(doc(db, `users/${uid}/commands/${id}`));
    const st = snap.data()?.status;
    if (st === 'done' || st === 'error') return snap.data();
    await sleep(500);
  }
  return (await getDoc(doc(db, `users/${uid}/commands/${id}`))).data();
}

console.log('\n[command round-trip] injecting sendMessage (fake session) + approve …');
await inject('itest-send', { type: 'sendMessage', sessionId: FAKE, payload: { text: 'integration ping' } });
await inject('itest-approve', { type: 'approve', sessionId: FAKE, payload: { reqId: 'req-xyz' } });

const sendRes = await waitTerminal('itest-send');
const apprRes = await waitTerminal('itest-approve');
console.log(`  sendMessage -> status=${sendRes?.status} result="${sendRes?.result}"`);
console.log(`  approve     -> status=${apprRes?.status} result="${apprRes?.result}"`);

const ok =
  devs.size >= 1 && sessions.size >= 1 && pc >= 1 &&
  sendRes?.status === 'error' && /unknown\/ended/.test(sendRes?.result || '') &&
  apprRes?.status === 'done' && /recorded approved/.test(apprRes?.result || '');
console.log(ok ? '\nINTEGRATION OK ✅' : '\nINTEGRATION INCOMPLETE ❌ (see above)');
process.exit(ok ? 0 : 1);
