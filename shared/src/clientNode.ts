// ============================================================================
// Shared Firebase NODE client init.
//
// The agent (packages/agent) runs under Node and authenticates AS A USER via
// email/password using the *client* `firebase` SDK — NOT firebase-admin. That
// keeps it subject to the exact same Security Rules as the dashboard, so the
// rules are the single source of truth for who-can-touch-what.
//
// The modular web SDK runs fine on Node 18+ (global fetch + WebSocket). We only
// differ from clientWeb in that we additionally expose a signInAgent() helper.
// Idempotent: app init + each emulator connect happen exactly once.
// ============================================================================
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  type Auth,
  type UserCredential,
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import {
  getDatabase,
  connectDatabaseEmulator,
  type Database,
} from 'firebase/database';

import { firebaseConfig, USE_EMULATORS, EMULATOR_HOSTS } from './firebaseConfig.js';

let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;
let _db: Firestore | undefined;
let _rtdb: Database | undefined;
let _authEmulatorWired = false;
let _firestoreEmulatorWired = false;
let _databaseEmulatorWired = false;

function getAppInstance(): FirebaseApp {
  if (_app) return _app;
  _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return _app;
}

/** Firebase Auth, with the local emulator wired in when USE_EMULATORS. */
export function getAuthInstance(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(getAppInstance());
  if (USE_EMULATORS && !_authEmulatorWired) {
    connectAuthEmulator(_auth, EMULATOR_HOSTS.auth, { disableWarnings: true });
    _authEmulatorWired = true;
  }
  return _auth;
}

/** Cloud Firestore, with the local emulator wired in when USE_EMULATORS. */
export function getDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(getAppInstance());
  if (USE_EMULATORS && !_firestoreEmulatorWired) {
    connectFirestoreEmulator(_db, EMULATOR_HOSTS.firestore.host, EMULATOR_HOSTS.firestore.port);
    _firestoreEmulatorWired = true;
  }
  return _db;
}

/** Realtime Database, with the local emulator wired in when USE_EMULATORS. */
export function getRtdb(): Database {
  if (_rtdb) return _rtdb;
  _rtdb = getDatabase(getAppInstance(), firebaseConfig.databaseURL);
  if (USE_EMULATORS && !_databaseEmulatorWired) {
    connectDatabaseEmulator(_rtdb, EMULATOR_HOSTS.database.host, EMULATOR_HOSTS.database.port);
    _databaseEmulatorWired = true;
  }
  return _rtdb;
}

/**
 * Sign the agent in as a real user (email/password). After this resolves,
 * getAuthInstance().currentUser.uid is the tenant uid all writes are scoped to.
 * Ensures Auth (and its emulator wiring) is initialized first.
 */
export function signInAgent(email: string, password: string): Promise<UserCredential> {
  return signInWithEmailAndPassword(getAuthInstance(), email, password);
}
