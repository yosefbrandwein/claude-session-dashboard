// One-shot: create (or verify) the dashboard account on the CLOUD project and
// write the agent's local config. Credentials come from env (never committed).
//   CSD_EMAIL=… CSD_PASSWORD=… node scripts/provision-user.mjs
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const email = process.env.CSD_EMAIL, password = process.env.CSD_PASSWORD;
if (!email || !password) { console.error('need CSD_EMAIL + CSD_PASSWORD'); process.exit(1); }

const app = initializeApp({
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
});
const auth = getAuth(app);

let uid;
try {
  const c = await createUserWithEmailAndPassword(auth, email, password);
  uid = c.user.uid;
  console.log('account CREATED:', email, 'uid', uid);
} catch (e) {
  if (String(e.code).includes('email-already-in-use')) {
    const c = await signInWithEmailAndPassword(auth, email, password); // verify pw
    uid = c.user.uid;
    console.log('account already existed; signed in OK, uid', uid);
  } else { console.error('auth error:', e.code, e.message); process.exit(1); }
}

const dir = join(homedir(), '.claude-dash');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'config.json'), JSON.stringify({ email, password }, null, 2));
console.log('wrote', join(dir, 'config.json'));
process.exit(0);
