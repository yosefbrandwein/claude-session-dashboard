// Firebase client bootstrap.
//
// Initializes the Firebase app from the SHARED config and, when the
// VITE_USE_EMULATORS=1 flag is set, wires the SDK to the local Emulator Suite
// using the host/port constants from the shared contract. Importing the config
// from the shared package (never redefining it here) keeps the dashboard, the
// agent, and the security rules pinned to one source of truth.
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getDatabase, connectDatabaseEmulator } from 'firebase/database';

import { firebaseConfig } from '../../../shared/src/firebaseConfig';
import { EMULATOR_HOSTS } from '../../../shared/src/firebaseConfig';

// Vite statically replaces import.meta.env.* at build time; '1' opts in.
export const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === '1';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);

if (USE_EMULATORS) {
  // The auth emulator expects a full URL; firestore/RTDB take host + port.
  connectAuthEmulator(auth, EMULATOR_HOSTS.auth, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOSTS.firestore.host, EMULATOR_HOSTS.firestore.port);
  connectDatabaseEmulator(rtdb, EMULATOR_HOSTS.database.host, EMULATOR_HOSTS.database.port);
  // Surface the mode once so it's obvious in the console which backend is live.
  // eslint-disable-next-line no-console
  console.info('[firebase] Connected to LOCAL emulators', EMULATOR_HOSTS);
}
