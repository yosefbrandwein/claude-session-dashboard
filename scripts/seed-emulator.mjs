// ============================================================================
// Emulator seed script — populates the running Emulator Suite with realistic
// demo data so the dashboard has something to render.
//
//   USE_FIREBASE_EMULATORS=1 node scripts/seed-emulator.mjs
//
// Requires the auth + firestore + database emulators to be running
// (firebase emulators:start). Creates a demo user, signs in as them, then
// writes 1 device, 3 sessions (working / idle / awaiting-input), a few
// metadata-only messages, 1 pending permissionRequest, and matching /presence
// records in RTDB. Prints the demo uid + creds at the end.
//
// Self-contained: imports the firebase client SDK directly (resolved from the
// repo-root node_modules) and inlines the non-secret emulator config, so it
// runs under plain `node` with no TS loader. Shapes mirror shared/src/types.ts.
// ============================================================================
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  setDoc,
} from 'firebase/firestore';
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  set as rtdbSet,
} from 'firebase/database';

// --- non-secret config (mirrors shared/src/firebaseConfig.ts) --------------
const firebaseConfig = {
  apiKey: 'AIzaSyBgjkwiD8nzxViNrJbJ9a2W_AA5mWppvCw',
  authDomain: 'claude-session-dashboard.firebaseapp.com',
  projectId: 'claude-session-dashboard',
  storageBucket: 'claude-session-dashboard.firebasestorage.app',
  messagingSenderId: '554148503524',
  appId: '1:554148503524:web:01228763f9d7ca882571f1',
  databaseURL: 'https://claude-session-dashboard-default-rtdb.firebaseio.com',
};
const EMULATOR_HOSTS = {
  auth: 'http://127.0.0.1:9099',
  firestore: { host: '127.0.0.1', port: 8080 },
  database: { host: '127.0.0.1', port: 9000 },
};

const DEMO_EMAIL = 'demo@demo.dev';
const DEMO_PASSWORD = 'demo123';

if (process.env.USE_FIREBASE_EMULATORS !== '1') {
  console.error(
    'Refusing to run: set USE_FIREBASE_EMULATORS=1 so this only ever touches the emulator.',
  );
  process.exit(1);
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
connectAuthEmulator(auth, EMULATOR_HOSTS.auth, { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, EMULATOR_HOSTS.firestore.host, EMULATOR_HOSTS.firestore.port);
const rtdb = getDatabase(app, firebaseConfig.databaseURL);
connectDatabaseEmulator(rtdb, EMULATOR_HOSTS.database.host, EMULATOR_HOSTS.database.port);

async function ensureDemoUser() {
  try {
    const cred = await createUserWithEmailAndPassword(auth, DEMO_EMAIL, DEMO_PASSWORD);
    return cred.user;
  } catch (e) {
    if (e?.code === 'auth/email-already-in-use') {
      // Re-runnable: sign in to the existing demo user instead of failing.
      const cred = await signInWithEmailAndPassword(auth, DEMO_EMAIL, DEMO_PASSWORD);
      return cred.user;
    }
    throw e;
  }
}

async function main() {
  const user = await ensureDemoUser();
  const uid = user.uid;
  const now = Date.now();
  const deviceId = 'dev-laptop-01';

  // --- 1 device -----------------------------------------------------------
  await setDoc(doc(db, `users/${uid}/devices/${deviceId}`), {
    deviceId,
    hostname: 'demo-laptop',
    os: 'win32',
    agentVersion: '0.1.0',
    firstSeen: now - 1000 * 60 * 60 * 24,
    lastSeen: now,
  });

  // --- 3 sessions with varied status -------------------------------------
  const sessions = [
    {
      sessionId: 'sess-working',
      project: 'flexiplan-solver',
      cwd: 'C:/repos/flexiplan-solver',
      gitBranch: 'advisor-hardening',
      status: 'working',
      messageCount: 12,
      controllable: true,
      model: 'claude-opus-4-8',
      version: '1.0.0',
      entrypoint: 'cli',
      endedAt: null,
    },
    {
      sessionId: 'sess-idle',
      project: 'session-dashboard',
      cwd: 'C:/repos/claude-session-dashboard',
      gitBranch: 'main',
      status: 'idle',
      messageCount: 5,
      controllable: true,
      model: 'claude-sonnet-4-5',
      version: '1.0.0',
      entrypoint: 'cli',
      endedAt: null,
    },
    {
      sessionId: 'sess-awaiting',
      project: 'docs-site',
      cwd: 'C:/repos/docs-site',
      gitBranch: 'feature/search',
      status: 'awaiting-input',
      messageCount: 8,
      controllable: false,
      model: 'claude-opus-4-8',
      version: '1.0.0',
      entrypoint: 'claude-desktop',
      endedAt: null,
    },
  ];

  for (const s of sessions) {
    await setDoc(doc(db, `users/${uid}/sessions/${s.sessionId}`), {
      sessionId: s.sessionId,
      deviceId,
      project: s.project,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      startedAt: now - 1000 * 60 * 30,
      endedAt: s.endedAt,
      model: s.model,
      version: s.version,
      entrypoint: s.entrypoint,
      status: s.status,
      messageCount: s.messageCount,
      controllable: s.controllable,
    });
  }

  // --- a few messages (metadata only) on the working session ------------
  const workingMsgs = [
    { id: 'm1', role: 'user', kind: 'message', summary: 'Add a new constraint' },
    {
      id: 'm2',
      role: 'assistant',
      kind: 'message',
      summary: 'Reading the model files',
      toolCalls: [{ name: 'Read', inputSummary: 'AutoModel_Ir.cs' }],
    },
    {
      id: 'm3',
      role: 'tool',
      kind: 'tool_result',
      summary: 'file read (480 lines)',
    },
  ];
  for (const m of workingMsgs) {
    await setDoc(doc(db, `users/${uid}/sessions/sess-working/messages/${m.id}`), {
      ts: now - 1000 * 60 * (10 - workingMsgs.indexOf(m)),
      role: m.role,
      kind: m.kind,
      summary: m.summary,
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    });
  }

  // --- 1 pending permissionRequest on the awaiting-input session --------
  await setDoc(
    doc(db, `users/${uid}/sessions/sess-awaiting/permissionRequests/req-1`),
    {
      tool: 'Bash',
      inputSummary: 'npm install firebase',
      ts: now - 1000 * 60 * 2,
      decision: 'pending',
      decidedAt: null,
      decidedBy: null,
      source: 'hook',
    },
  );

  // --- matching /presence records in RTDB --------------------------------
  const presenceByStatus = {
    'sess-working': 'working',
    'sess-idle': 'idle',
    'sess-awaiting': 'awaiting-input',
  };
  for (const s of sessions) {
    await rtdbSet(ref(rtdb, `presence/${uid}/${deviceId}/${s.sessionId}`), {
      status: presenceByStatus[s.sessionId],
      project: s.project,
      branch: s.gitBranch,
      pid: 10000 + sessions.indexOf(s),
      startedAt: now - 1000 * 60 * 30,
      lastActivityAt: now - 1000 * 60 * (s.status === 'working' ? 0 : 5),
      heartbeatAt: now,
    });
  }

  console.log('--------------------------------------------------------------');
  console.log('Seed complete. Demo data written to the emulator suite.');
  console.log(`  Demo user email   : ${DEMO_EMAIL}`);
  console.log(`  Demo user password: ${DEMO_PASSWORD}`);
  console.log(`  Demo uid          : ${uid}`);
  console.log('  Wrote: 1 device, 3 sessions (working/idle/awaiting-input),');
  console.log('         3 messages, 1 pending permissionRequest, 3 presence records.');
  console.log('--------------------------------------------------------------');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
