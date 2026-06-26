// ============================================================================
// Shared Firebase WEB client init (modular `firebase` SDK).
// Used by packages/dashboard (browser) and anywhere a browser-style SDK fits.
//
// Idempotent: initializeApp + each emulator connect happen exactly once, even
// if these accessors are called many times across a session / HMR reload.
// ============================================================================
import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  type Auth,
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

// Module-level singletons so repeated accessor calls reuse one instance and we
// never attempt to connect the same emulator twice (which throws on Auth).
let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;
let _db: Firestore | undefined;
let _rtdb: Database | undefined;
let _authEmulatorWired = false;
let _firestoreEmulatorWired = false;
let _databaseEmulatorWired = false;

function getAppInstance(): FirebaseApp {
  if (_app) return _app;
  // Reuse an app another module already created instead of double-initializing.
  _app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  return _app;
}

/** Firebase Auth, with the local emulator wired in when USE_EMULATORS. */
export function getAuthInstance(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(getAppInstance());
  if (USE_EMULATORS && !_authEmulatorWired) {
    // `disableWarnings` keeps the noisy banner out of test/CI logs.
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
  // Pass the explicit databaseURL so emulator + cloud both resolve the right shard.
  _rtdb = getDatabase(getAppInstance(), firebaseConfig.databaseURL);
  if (USE_EMULATORS && !_databaseEmulatorWired) {
    connectDatabaseEmulator(_rtdb, EMULATOR_HOSTS.database.host, EMULATOR_HOSTS.database.port);
    _databaseEmulatorWired = true;
  }
  return _rtdb;
}
