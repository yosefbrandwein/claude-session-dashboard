// Manager integration check: sign in as the demo user against the emulator and
// read exactly what the dashboard reads (Firestore sessions + RTDB presence),
// proving auth + rules + data shapes all line up end-to-end.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, collection, getDocs } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator, ref, get } from 'firebase/database';

const app = initializeApp({
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
});
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);
const rtdb = getDatabase(app);
connectDatabaseEmulator(rtdb, '127.0.0.1', 9000);

const cred = await signInWithEmailAndPassword(auth, 'demo@demo.dev', 'demo123');
const uid = cred.user.uid;
console.log('signed in as demo@demo.dev, uid =', uid);

const sessSnap = await getDocs(collection(db, `users/${uid}/sessions`));
console.log(`\nFirestore sessions: ${sessSnap.size}`);
sessSnap.forEach((d) => {
  const s = d.data();
  console.log(`  - ${s.project} [${s.status}] branch=${s.gitBranch} msgs=${s.messageCount} device=${s.deviceId}`);
});

const presSnap = await get(ref(rtdb, `presence/${uid}`));
const pres = presSnap.val() || {};
let pcount = 0;
for (const dev of Object.keys(pres)) for (const sid of Object.keys(pres[dev])) {
  pcount++;
  console.log(`  presence: ${dev}/${sid} -> ${pres[dev][sid].status} @ ${new Date(pres[dev][sid].heartbeatAt).toISOString()}`);
}
console.log(`\nRTDB presence records: ${pcount}`);
console.log(sessSnap.size > 0 && pcount > 0 ? '\nROUND-TRIP OK ✅' : '\nROUND-TRIP FAILED ❌');
process.exit(0);
