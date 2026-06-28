// Go-live smoke test against the REAL cloud project (no emulator). Creates a
// throwaway user, exercises the deployed Security Rules + Firestore + RTDB under
// that uid, then deletes the data + the user so the project is left clean.
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, deleteUser } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { getDatabase, ref, set as rtdbSet, get as rtdbGet, remove as rtdbRemove } from 'firebase/database';

const app = initializeApp({
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  storageBucket: 'claude-session-dashboard.firebasestorage.app',
  messagingSenderId: '554148503524',
  appId: '1:554148503524:web:01228763f9d7ca882571f1',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
});
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);

const email = 'golive-smoke@csd.test';
const pass = 'smoke-' + Math.random().toString(36).slice(2, 10);

let cred;
try {
  cred = await createUserWithEmailAndPassword(auth, email, pass);
  console.log('created throwaway user:', email);
} catch (e) {
  if (String(e.code).includes('email-already-in-use')) {
    console.log('throwaway user exists — cannot sign in (unknown pw); using a fresh email');
    const alt = 'golive-smoke-' + Date.now() + '@csd.test';
    cred = await createUserWithEmailAndPassword(auth, alt, pass);
    console.log('created throwaway user:', alt);
  } else throw e;
}
const uid = cred.user.uid;

// Firestore under own uid (deployed rules must ALLOW owner)
const sref = doc(db, `users/${uid}/sessions/smoke`);
await setDoc(sref, { sessionId: 'smoke', deviceId: 'd', project: 'p', cwd: 'c', gitBranch: null, startedAt: 1, endedAt: null, model: null, version: null, entrypoint: null, status: 'idle', messageCount: 0, controllable: true });
const back = (await getDoc(sref)).data();
console.log('Firestore write+read:', back?.project === 'p' ? 'OK' : 'FAIL');

// RTDB presence under own uid (deployed shape rules must ALLOW valid record)
const pref = ref(rtdb, `presence/${uid}/d/smoke`);
await rtdbSet(pref, { status: 'working', project: 'p', branch: null, pid: 1, startedAt: 1, lastActivityAt: 1, heartbeatAt: 1 });
const pback = (await rtdbGet(pref)).val();
console.log('RTDB write+read:', pback?.status === 'working' ? 'OK' : 'FAIL');

// cleanup
await deleteDoc(sref).catch(() => {});
await rtdbRemove(pref).catch(() => {});
await deleteUser(cred.user).catch((e) => console.log('user cleanup note:', e.code));
console.log('cleaned up test data + user');

const ok = back?.project === 'p' && pback?.status === 'working';
console.log(ok ? '\nLIVE CLOUD STACK OK ✅' : '\nLIVE CLOUD FAILED ❌');
process.exit(ok ? 0 : 1);
